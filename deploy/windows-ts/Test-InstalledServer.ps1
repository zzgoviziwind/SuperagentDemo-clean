[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Installer,
    [string]$EvidenceDirectory = ([IO.Path]::GetTempPath()),
    [string]$BrowserNode,
    [string]$WebNodeModules,
    [switch]$CheckConfiguration,
    [switch]$CheckField,
    [switch]$CheckFieldDependencyHint,
    [switch]$CheckReleaseVersion
)
$ErrorActionPreference = 'Stop'
$exe = (Resolve-Path -LiteralPath $Installer).Path
$temporary = Join-Path ([IO.Path]::GetFullPath($EvidenceDirectory)) ('superagent-ts-' + [guid]::NewGuid().ToString('N'))
$instance = Join-Path $temporary ('User ' + [char]0x6D4B + [char]0x8BD5 + '/Local AppData/SuperAgent')
$manager = Join-Path $instance 'SuperAgent.cmd'
$port = $null
for ($attempt = 0; $attempt -lt 20 -and -not $port; $attempt++) {
    $candidate = Get-Random -Minimum 49152 -Maximum 65536
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $candidate)
    try { $listener.Start(); $port = $candidate } catch [Net.Sockets.SocketException] {
        # Retry when another service already occupies the temporary port.
    } finally { $listener.Stop() }
}
if (-not $port) { throw 'Could not allocate a temporary high port.' }

function Request-Text([string]$Resource, [string]$Bearer) {
    $request = [Net.HttpWebRequest]::Create("http://127.0.0.1:$port$Resource")
    $request.Proxy = $null
    $request.Timeout = 3000
    $request.AllowAutoRedirect = $false
    if ($Bearer) { $request.Headers['Authorization'] = "Bearer $Bearer" }
    $response = $request.GetResponse()
    try {
        if ([int]$response.StatusCode -ne 200) { throw "Unexpected HTTP response: $Resource" }
        $reader = [IO.StreamReader]::new($response.GetResponseStream())
        try { $reader.ReadToEnd() } finally { $reader.Dispose() }
    } finally { $response.Dispose() }
}

function Invoke-Manager([string]$Action) {
    $result = & $manager -Action $Action
    if ($LASTEXITCODE -ne 0) { throw "Manager failed: $Action" }
    $result
}

Write-Output "Evidence directory: $temporary"
Write-Output "Temporary port: $port"
try {
    & $exe -InstallRoot $instance -Port $port
    if ($LASTEXITCODE -ne 0) { throw 'Self-extracting installer failed.' }
    $first = Invoke-Manager Diagnose | ConvertFrom-Json
    if ($first.status -ne 'running') { throw 'Installed server did not become ready.' }
    $health = Request-Text '/health' | ConvertFrom-Json
    if ($health.status -ne 'ok' -or $health.implementation -ne 'typescript') { throw 'Expected the actual TypeScript server.' }
    if ($CheckReleaseVersion -and $health.version -cne $first.active) { throw 'Health does not identify the active installed release.' }
    $health | ConvertTo-Json -Compress
    $index = Request-Text '/'
    $script = [regex]::Match($index, 'src="(/assets/[^"]+)"').Groups[1].Value
    $stylesheet = [regex]::Match($index, 'href="(/assets/[^"]+\.css)"').Groups[1].Value
    $label = ([char]0x73B0).ToString() + [char]0x573A + [char]0x8BB0 + [char]0x5F55
    if (-not $script -or -not (Request-Text $script).Contains($label)) { throw 'Field Intake is missing from the packaged JS.' }
    if (-not $stylesheet -or -not (Request-Text $stylesheet)) { throw 'The stylesheet is missing.' }
    $null = Request-Text '/field-timeline.example.json' | ConvertFrom-Json
    $database = Get-Item -LiteralPath (Join-Path $first.data 'superagent.db')
    if ($database.Length -le 0) { throw 'Missing isolated SQLite database.' }
    Write-Output "PASS actual TypeScript health, index, $script, $stylesheet, timeline example and isolated SQLite"
    if ($CheckFieldDependencyHint) {
        $media = Request-Text '/api/v1/field-intake/media-jobs' | ConvertFrom-Json
        if ($media.ready -ne $false -or [string]::IsNullOrWhiteSpace($media.reason)) {
            throw 'The basic package did not explain its unavailable optional media processing.'
        }
        Write-Output "PASS default optional media dependency hint: $($media.reason)"
    }
    if ($BrowserNode -and $WebNodeModules) {
        $browserArgs = @((Join-Path $PSScriptRoot 'tests/installed-workbench.cjs'), $first.url, $temporary, $WebNodeModules)
        if ($CheckField) { $browserArgs += '--field' }
        & $BrowserNode @browserArgs
        if ($LASTEXITCODE -ne 0) { throw 'Installed workbench browser check failed.' }
    }

    $null = Invoke-Manager Restart
    $second = Invoke-Manager Diagnose | ConvertFrom-Json
    if ($second.status -ne 'running' -or $second.pid -eq $first.pid -or $second.data -ne $first.data) {
        throw 'Restart did not replace the process and keep the data directory.'
    }
    $restartedHealth = Request-Text '/health' | ConvertFrom-Json
    if ($restartedHealth.implementation -ne 'typescript') { throw 'Restart health failed.' }
    if ($CheckReleaseVersion -and $restartedHealth.version -cne $second.active) { throw 'Restart did not report the active release.' }
    Write-Output "PASS restart from PID $($first.pid) to $($second.pid) using the same SQLite directory"
    if ($CheckConfiguration) {
        $fakeExe = Join-Path $temporary 'fake-codex.exe'
        $fakeAccount = Join-Path $temporary 'fake-account'
        [IO.File]::WriteAllText($fakeExe, 'offline fixture; never executed')
        [IO.Directory]::CreateDirectory($fakeAccount) | Out-Null
        $syntheticToken = [guid]::NewGuid().ToString('N')
        $testEnvironment = @{
            SUPERAGENT_CODEX_EXECUTABLE = $fakeExe
            SUPERAGENT_CODEX_HOME = $fakeAccount
            SUPERAGENT_CODEX_USE_EXISTING_LOGIN = '1'
            SUPERAGENT_DRIVER = 'codex'
            SUPERAGENT_API_TOKEN = $syntheticToken
            SUPERAGENT_CONFIG_TOKEN = $syntheticToken
        }
        $beforeTest = @{}
        try {
            foreach ($name in $testEnvironment.Keys) {
                $beforeTest[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
                [Environment]::SetEnvironmentVariable($name, $testEnvironment[$name], 'Process')
            }
            & $manager -Action Configure -CodexMode Existing -CodexExecutable $fakeExe -CodexHome $fakeAccount
            if ($LASTEXITCODE -ne 0) { throw 'Existing account path selection failed.' }
            & $manager -Action Configure -CodexMode Environment -InjectEnvironment SUPERAGENT_API_TOKEN
            if ($LASTEXITCODE -ne 0) { throw 'Process environment selection failed.' }
            $null = Invoke-Manager Restart
            $auth = Request-Text '/api/v1/auth/me' $testEnvironment.SUPERAGENT_API_TOKEN | ConvertFrom-Json
            if ($auth.authentication -ne 'bearer') { throw 'The selected authentication variable did not reach the server.' }
            try {
                $null = Request-Text '/api/v1/auth/me'
                throw 'Authentication was bypassed.'
            } catch [Net.WebException] {
                if (-not $_.Exception.Response -or [int]$_.Exception.Response.StatusCode -ne 401) { throw }
                $_.Exception.Response.Dispose()
            }
            $channelSettings = Join-Path $temporary 'redmine-synthetic.json'
            [IO.File]::WriteAllText($channelSettings, '{"enabled":false,"base_url":"https://fixture.invalid","user_id":123,"api_key_env":"TEST_REDMINE_API_KEY"}')
            & $manager -Action ConfigureChannel -Channel redmine -ChannelSettingsPath $channelSettings
            if ($LASTEXITCODE -ne 0) { throw 'Local channel settings failed.' }
            $config = Request-Text '/api/v1/settings' $testEnvironment.SUPERAGENT_API_TOKEN | ConvertFrom-Json
            if ($config.'connectors.redmine'.base_url -ne 'https://fixture.invalid' -or $config.'connectors.redmine'.enabled) {
                throw 'The installed service did not store the disabled synthetic channel settings.'
            }
            $diagnostics = Invoke-Manager Diagnose
            $launch = ($diagnostics | ConvertFrom-Json).launchConfiguration
            if ($launch.configuredCodexMode -ne 'Environment' -or @($launch.codexIssues | Where-Object { $_ }).Count -ne 0 -or
                ($diagnostics | Out-String).Contains($testEnvironment.SUPERAGENT_API_TOKEN)) {
                throw 'Configuration diagnostic was incorrect or exposed a value.'
            }
            [Environment]::SetEnvironmentVariable('SUPERAGENT_API_TOKEN', $null, 'Process')
            [Environment]::SetEnvironmentVariable('SUPERAGENT_CODEX_USE_EXISTING_LOGIN', $null, 'Process')
            $missing = (Invoke-Manager Diagnose | ConvertFrom-Json).launchConfiguration
            if ('SUPERAGENT_API_TOKEN' -notin $missing.missingInjectionNames -or
                -not ($missing.codexIssues | Where-Object { $_ -match 'SUPERAGENT_CODEX_USE_EXISTING_LOGIN' })) {
                throw 'Diagnostic did not identify missing authentication or Codex configuration.'
            }
            Write-Output 'PASS opt-in Codex paths, process-only authentication, redacted diagnostics and disabled synthetic channel configuration'
        } finally {
            foreach ($name in $beforeTest.Keys) { [Environment]::SetEnvironmentVariable($name, $beforeTest[$name], 'Process') }
        }
    }
    $null = Invoke-Manager Stop
    if ((Invoke-Manager Status | ConvertFrom-Json).status -ne 'stopped') { throw 'The installed service did not stop.' }
    Write-Output 'PASS stop and released listener'
} finally {
    if (Test-Path -LiteralPath $manager) { $null = Invoke-Manager Stop }
}
