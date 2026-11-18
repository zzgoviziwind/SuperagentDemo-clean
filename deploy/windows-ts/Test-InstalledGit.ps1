[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Installer,
    [Parameter(Mandatory)][string]$GitExecutable,
    [string]$EvidenceDirectory = ([IO.Path]::GetTempPath()),
    [switch]$CheckDwsConfigDirectory
)
$ErrorActionPreference = 'Stop'
$exe = (Resolve-Path -LiteralPath $Installer).Path
$git = (Resolve-Path -LiteralPath $GitExecutable).Path
$run = Join-Path ([IO.Path]::GetFullPath($EvidenceDirectory)) ('git-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$instance = Join-Path $run 'install'
$workspace = Join-Path $run 'double repositories'
$template = Join-Path $run 'empty-template'
$ambient = Join-Path $run 'ambient-path'
$manager = Join-Path $instance 'SuperAgent.cmd'
[IO.Directory]::CreateDirectory($template) | Out-Null
[IO.Directory]::CreateDirectory($ambient) | Out-Null
$port = $null
for ($attempt = 0; $attempt -lt 20 -and -not $port; $attempt++) {
    $candidate = Get-Random -Minimum 49152 -Maximum 65536
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $candidate)
    try { $listener.Start(); $port = $candidate } catch [Net.Sockets.SocketException] {} finally { $listener.Stop() }
}
if (-not $port) { throw 'Could not reserve a high loopback port.' }

function Run-Command([string]$File, [string[]]$Arguments, [string]$ExpectedFailure) {
    $ErrorActionPreference = 'Continue'
    $output = & $File @Arguments 2>&1 | Out-String
    $code = $LASTEXITCODE
    if ($ExpectedFailure) {
        if ($code -eq 0 -or $output -notmatch $ExpectedFailure) { throw "Expected ${ExpectedFailure}. Exit ${code}. $output" }
    } elseif ($code -ne 0) { throw "Exit ${code}. $output" }
    $output.Trim()
}

function Request-Json([string]$Path, $Payload) {
    $request = [Net.HttpWebRequest]::Create("http://127.0.0.1:$port/api/v1$Path")
    $request.Proxy = $null
    $request.Timeout = 6000
    if ($null -ne $Payload) {
        $body = [Text.Encoding]::UTF8.GetBytes(($Payload | ConvertTo-Json -Depth 6 -Compress))
        $request.Method = 'POST'
        $request.ContentType = 'application/json'
        $request.ContentLength = $body.Length
        $stream = $request.GetRequestStream()
        try { $stream.Write($body, 0, $body.Length) } finally { $stream.Dispose() }
    }
    try { $response = $request.GetResponse() }
    catch [Net.WebException] {
        if (-not $_.Exception.Response) { throw }
        $response = $_.Exception.Response
    }
    try {
        $reader = [IO.StreamReader]::new($response.GetResponseStream())
        try { @{ status = [int]$response.StatusCode; json = $reader.ReadToEnd() | ConvertFrom-Json } }
        finally { $reader.Dispose() }
    } finally { $response.Dispose() }
}

function Read-Directory([string]$Path) {
    $result = Request-Json ('/project-workspace?path=' + [Uri]::EscapeDataString($Path))
    if ($result.status -ne 200) { throw "Browse failed for the temporary path." }
    $result.json
}

# ConvertTo-Json without a pipeline preserves the one-element node array.
$nodes = ConvertTo-Json -InputObject @(@{id='offline-install-node'; project_ids=@(1); roots=@($workspace); token_env='OFFLINE_UNUSED'}) -Compress
$marker = 'synthetic-field-install-only'
$selection = [ordered]@{
    SUPERAGENT_CONTEXT_MODE = 'decisions'
    SUPERAGENT_WORKER_MAX_RUN_MS = '17000'
    SUPERAGENT_EXECUTION_NODES = $nodes
    SUPERAGENT_PROJECT_EXECUTION_NODES = '{"1":"offline-install-node"}'
    SUPERAGENT_FEISHU_ENABLED = '0'
    SUPERAGENT_FEISHU_MODE = 'card'
    SUPERAGENT_FEISHU_APP_ID = $marker
    SUPERAGENT_FEISHU_APP_SECRET = $marker
    SUPERAGENT_FEISHU_ENCRYPT_KEY = $marker
    SUPERAGENT_FEISHU_OPEN_ID = $marker
    SUPERAGENT_FEISHU_OWNER_ID = $marker
    SUPERAGENT_FEISHU_VERIFICATION_TOKEN = $marker
}
if ($CheckDwsConfigDirectory) {
    $dwsDirectory = Join-Path $run 'synthetic-dws-profile'
    [IO.Directory]::CreateDirectory($dwsDirectory) | Out-Null
    $selection['DWS_CONFIG_DIR'] = $dwsDirectory
}
$before = @{}
Write-Output "Evidence directory: $run"
Write-Output "Temporary port: $port"
try {
    $testEnvironment = @{
        GIT_CONFIG_NOSYSTEM = '1'
        GIT_CONFIG_GLOBAL = (Join-Path $run 'empty-gitconfig')
        PATH = "$ambient;$env:PATH"
    }
    foreach ($name in $selection.Keys) { $testEnvironment.Add($name, $selection[$name]) }
    foreach ($name in $testEnvironment.Keys) {
        $before[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
        [Environment]::SetEnvironmentVariable($name, $testEnvironment[$name], 'Process')
    }
    [IO.File]::WriteAllText((Join-Path $ambient 'git.exe'), 'PATH decoy, never run')
    foreach ($repo in 'one', 'nested/two') {
        $path = Join-Path $workspace $repo
        [IO.Directory]::CreateDirectory($path) | Out-Null
        $null = Run-Command $git @('-C', $path, 'init', '-b', 'main', "--template=$template")
        $null = Run-Command $git @('-C', $path, '-c', 'user.name=Offline Test', '-c', 'user.email=test@example.invalid',
            'commit', '--allow-empty', '-m', 'synthetic test')
        $branch = if ($repo -eq 'one') { 'integration-one' } else { 'integration-two' }
        $null = Run-Command $git @('-C', $path, 'branch', $branch)
    }
    Run-Command $exe @('-InstallRoot', $instance, '-Port', "$port")
    $baseline = Run-Command $manager @('-Action', 'Diagnose') | ConvertFrom-Json
    if ($baseline.status -ne 'running' -or $baseline.launchConfiguration.configuredCodexMode -ne 'Disabled' -or
        $baseline.launchConfiguration.git.executable -like "$ambient\*" -or
        'DWS_CONFIG_DIR' -in $baseline.launchConfiguration.availableInjectionNames -or
        (Request-Json '/operations/nodes').json.items.Count -ne 0) {
        throw 'Fresh install inherited an unselected setting or Git path.'
    }
    if ($baseline.launchConfiguration.git.source -eq 'automatic') {
        $automatic = Read-Directory (Join-Path $workspace 'one')
        if ($automatic.warning -or 'integration-one' -notin $automatic.branches) {
            throw 'The automatically selected Git did not enumerate the branch.'
        }
        Write-Output "PASS default installation automatically used $($baseline.launchConfiguration.git.executable)"
    }
    $null = Run-Command $manager @('-Action', 'Configure', '-InjectEnvironment', 'SUPERAGENT_DRIVER') 'not supported'
    $null = Run-Command $manager @('-Action', 'Configure', '-InjectEnvironment', 'SUPERAGENT_FIXTURE_HOLD_REPLY') 'not supported'
    $null = Run-Command $manager @('-Action', 'Configure', '-InjectEnvironment', 'SUPERAGENT_DEBUG') 'not supported'
    $null = Run-Command $manager @('-Action', 'Configure', '-InjectEnvironment', 'DWS_DEBUG_AUTH') 'not supported'
    $null = Run-Command $manager @('-Action', 'Configure', '-GitExecutable', 'git.exe') 'absolute'
    $null = Run-Command $manager @('-Action', 'Configure', '-GitExecutable', $git, '-InjectEnvironment', ($selection.Keys -join ','))
    $configuration = Get-Content -LiteralPath (Join-Path $instance 'configuration.json') -Raw
    $diagnostic = Run-Command $manager @('-Action', 'Diagnose')
    if ($configuration.Contains($marker) -or $diagnostic.Contains($marker) -or $configuration.Contains('17000') -or $diagnostic.Contains('17000')) {
        throw 'Injected values appeared in configuration or diagnostics.'
    }
    if ($CheckDwsConfigDirectory -and ($configuration.Contains('synthetic-dws-profile') -or $diagnostic.Contains('synthetic-dws-profile'))) {
        throw 'The selected DWS directory value appeared in configuration or diagnostics.'
    }
    $diagnose = $diagnostic | ConvertFrom-Json
    if ($diagnose.launchConfiguration.git.source -ne 'configured' -or $diagnose.launchConfiguration.git.executable -ne $git -or
        (Compare-Object ($selection.Keys | Sort-Object) ($diagnose.launchConfiguration.availableInjectionNames | Sort-Object))) {
        throw 'Git selection or environment names were not saved.'
    }
    $env:SUPERAGENT_FEISHU_APP_SECRET = $null
    $missing = Run-Command $manager @('-Action', 'Diagnose') | ConvertFrom-Json
    if ('SUPERAGENT_FEISHU_APP_SECRET' -notin $missing.launchConfiguration.missingInjectionNames) { throw 'Missing variable name was not reported.' }
    $null = Run-Command $manager @('-Action', 'Restart') 'Required environment variable is missing'
    if ((Run-Command $manager @('-Action', 'Status') | ConvertFrom-Json).pid -ne $baseline.pid) { throw 'A missing variable stopped the service.' }
    $env:SUPERAGENT_FEISHU_APP_SECRET = $marker
    $null = Run-Command $manager @('-Action', 'Restart')
    $root = Read-Directory $workspace
    $one = Read-Directory (Join-Path $workspace 'one')
    $two = Read-Directory (Join-Path $workspace 'nested/two')
    if (($root.repositories.name | Sort-Object) -join ',' -ne 'nested/two,one' -or
        $one.warning -or $one.current_branch -ne 'main' -or 'integration-one' -notin $one.branches -or
        $two.warning -or $two.current_branch -ne 'main' -or 'integration-two' -notin $two.branches) {
        throw 'The installed service could not enumerate both Git repositories and branches.'
    }
    $body = @{name='Offline installed project'; repo_path=$workspace; repositories=@(
        @{path='one'; base_branch='integration-one'}, @{path='nested/two'; base_branch='integration-two'}
    )}
    $created = Request-Json '/projects' $body
    if ($created.status -ne 200 -or $created.json.repositories.Count -ne 2) { throw 'Multi-repository POST failed.' }
    $body.repositories[1].base_branch = 'missing-branch'
    if ((Request-Json '/projects' $body).status -ne 422) { throw 'The installed service accepted a missing Git branch.' }
    $stored = (Request-Json '/projects').json | Where-Object id -eq $created.json.id
    $activeNodes = (Request-Json '/operations/nodes').json.items
    if ($stored.repositories.Count -ne 2 -or $activeNodes.id -ne 'offline-install-node') {
        throw 'Saved repository paths or injected execution node did not reach the installed service.'
    }
    $dingtalk = (Request-Json '/connectors').json | Where-Object id -eq 'dingtalk'
    if ($dingtalk.enabled -ne $false) { throw 'The installation test must leave DingTalk disabled.' }
    Write-Output "PASS real Git $git; found both branches, saved project $($created.json.id), rejected a missing branch"
    Write-Output "PASS ambient PATH decoy ignored, Git opt-in saved, $($selection.Count) names accepted, fixture/debug names rejected, values redacted"
    if ($CheckDwsConfigDirectory) { Write-Output 'PASS DWS directory accepted only by explicit name; no DWS connector was enabled' }
    Write-Output 'PASS execution node present only after explicit injection, missing value preserves the running service, Codex disabled'
} finally {
    try {
        if (Test-Path -LiteralPath $manager -PathType Leaf) { $null = Run-Command $manager @('-Action', 'Stop') }
    } finally {
        foreach ($name in $before.Keys) { [Environment]::SetEnvironmentVariable($name, $before[$name], 'Process') }
    }
}
