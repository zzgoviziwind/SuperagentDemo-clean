function Confirm-EnvironmentName([string]$Name) {
    if ($Name -cnotmatch '^(SUPERAGENT_(API_TOKEN|USERS_JSON|SESSION_SECRET|ALLOWED_REPO_ROOTS|ATTACHMENTS_ROOT|FIELD_(PYTHON|OCR_MODELS|WHISPER_MODEL))|([A-Z][A-Z0-9]*_)*REDMINE_API_KEY)$') {
        throw 'The selected environment variable is not supported for injection.'
    }
}

function Get-LaunchConfiguration {
    $config = Read-State $configurationPath
    if (-not $config) { return @{ codexMode = 'Disabled'; injectedEnvironment = @() } }
    if ($config.codexMode -notin 'Disabled', 'Existing', 'Environment') { throw 'Invalid Codex mode in configuration.json.' }
    foreach ($name in $config.injectedEnvironment) { Confirm-EnvironmentName $name }
    return $config
}

function Confirm-CodexSelection([string]$Executable, [string]$Account) {
    if ($Executable -notmatch '^[A-Za-z]:[\\/].*\.exe$' -or -not (Test-Path -LiteralPath $Executable -PathType Leaf)) {
        throw 'Select an existing local Codex .exe using its absolute path.'
    }
    if ($Account -notmatch '^[A-Za-z]:[\\/]' -or -not (Test-Path -LiteralPath $Account -PathType Container)) {
        throw 'Select the existing Codex account directory using its absolute path.'
    }
}

function Set-LaunchConfiguration {
    if ($ClearInjectedEnvironment -and $InjectEnvironment) { throw 'Set or clear environment injection in one operation.' }
    $previous = Get-LaunchConfiguration
    $selected = if ($CodexMode) { $CodexMode } else { $previous.codexMode }
    $config = @{ codexMode = $selected; injectedEnvironment = @($previous.injectedEnvironment | Where-Object { $_ }) }
    if ($selected -eq 'Existing') {
        $config.codexExecutable = if ($CodexExecutable) { $CodexExecutable } else { $previous.codexExecutable }
        $config.codexHome = if ($CodexHome) { $CodexHome } else { $previous.codexHome }
        Confirm-CodexSelection $config.codexExecutable $config.codexHome
    } elseif ($CodexExecutable -or $CodexHome) { throw 'Select -CodexMode Existing to save paths.' }
    if ($ClearInjectedEnvironment) {
        $config.injectedEnvironment = @()
    } elseif ($InjectEnvironment) {
        $config.injectedEnvironment = @($InjectEnvironment.Split(',') | ForEach-Object { $_.Trim() } | Sort-Object -Unique)
        foreach ($name in $config.injectedEnvironment) { Confirm-EnvironmentName $name }
    }
    Write-State $configurationPath $config
    Write-Output 'Configuration saved. Use Diagnose to inspect it and Restart to apply it.'
}

function Get-LaunchEnvironment {
    $config = Get-LaunchConfiguration
    $settings = @{}
    foreach ($name in $config.injectedEnvironment) {
        $value = [Environment]::GetEnvironmentVariable($name, 'Process')
        if ([string]::IsNullOrWhiteSpace($value)) { throw "Required environment variable is missing: $name" }
        $settings[$name] = $value
    }
    $executable = $config.codexExecutable
    $account = $config.codexHome
    if ($config.codexMode -eq 'Environment') {
        if ($env:SUPERAGENT_CODEX_USE_EXISTING_LOGIN -ne '1' -or ($env:SUPERAGENT_DRIVER -and $env:SUPERAGENT_DRIVER -ne 'codex')) {
            throw 'Set SUPERAGENT_CODEX_USE_EXISTING_LOGIN=1 and select the Codex account in the current process.'
        }
        foreach ($variable in Get-ChildItem Env: | Where-Object Name -clike 'SUPERAGENT_CODEX_*') {
            $settings[$variable.Name] = $variable.Value
        }
        $executable = $env:SUPERAGENT_CODEX_EXECUTABLE
        $account = $env:SUPERAGENT_CODEX_HOME
    }
    if ($config.codexMode -ne 'Disabled') {
        Confirm-CodexSelection $executable $account
        $settings.SUPERAGENT_DRIVER = 'codex'
        $settings.SUPERAGENT_CODEX_EXECUTABLE = $executable
        $settings.SUPERAGENT_CODEX_HOME = $account
        $settings.SUPERAGENT_CODEX_USE_EXISTING_LOGIN = '1'
    }
    return $settings
}

function Get-LaunchConfigurationStatus {
    $config = Get-LaunchConfiguration
    $available = @($config.injectedEnvironment | Where-Object {
        -not [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($_, 'Process'))
    })
    $missing = @($config.injectedEnvironment | Where-Object { $_ -and $_ -notin $available })
    $issues = @(if ($config.codexMode -ne 'Disabled') {
        $executable = $config.codexExecutable
        $account = $config.codexHome
        if ($config.codexMode -eq 'Environment') {
            $executable = $env:SUPERAGENT_CODEX_EXECUTABLE
            $account = $env:SUPERAGENT_CODEX_HOME
            if ($env:SUPERAGENT_CODEX_USE_EXISTING_LOGIN -ne '1') { 'Set SUPERAGENT_CODEX_USE_EXISTING_LOGIN=1.' }
            if ($env:SUPERAGENT_DRIVER -and $env:SUPERAGENT_DRIVER -ne 'codex') { 'Use SUPERAGENT_DRIVER=codex or leave it unset.' }
        }
        try { Confirm-CodexSelection $executable $account } catch { $_.Exception.Message }
    })
    return [ordered]@{
        configuredCodexMode = $config.codexMode
        codexIssues = $issues
        availableInjectionNames = $available
        missingInjectionNames = $missing
        configure = 'SuperAgent.cmd -Action Configure'
        configureChannel = 'SuperAgent.cmd -Action ConfigureChannel'
    }
}

function Set-ChannelConfiguration($Current) {
    if (-not $Channel -or -not $ChannelSettingsPath) { throw 'Supply -Channel and -ChannelSettingsPath.' }
    $settings = Get-Content -LiteralPath $ChannelSettingsPath -Encoding UTF8 -Raw | ConvertFrom-Json
    if ($settings -isnot [pscustomobject]) { throw 'The channel settings must be a JSON object.' }
    $record = Read-State $runPath
    $process = Get-RecordedProcess $record
    if (-not $process) { throw 'Start the installed server before configuring a channel.' }
    try {
        if ($record.version -ne $Current.active -or -not (Test-ServiceReady $process $Current.port)) {
            throw 'The installed server is not ready.'
        }
        $changes = @{}
        $changes["connectors.$Channel"] = $settings
        $body = [Text.Encoding]::UTF8.GetBytes(($changes | ConvertTo-Json -Depth 10 -Compress))
        $request = [Net.HttpWebRequest]::Create("http://127.0.0.1:$($Current.port)/api/v1/settings")
        $request.Proxy = $null
        $request.AllowAutoRedirect = $false
        $request.Timeout = 3000
        $request.ReadWriteTimeout = 3000
        $request.Method = 'PATCH'
        $request.ContentType = 'application/json'
        $request.ContentLength = $body.Length
        $token = if ($env:SUPERAGENT_CONFIG_TOKEN) { $env:SUPERAGENT_CONFIG_TOKEN } else { $env:SUPERAGENT_API_TOKEN }
        if ($token) { $request.Headers['Authorization'] = "Bearer $token" }
        $stream = $request.GetRequestStream()
        try { $stream.Write($body, 0, $body.Length) } finally { $stream.Dispose() }
        try {
            $response = $request.GetResponse()
            try {
                if ([int]$response.StatusCode -ne 200) { throw 'The local server did not confirm the settings update.' }
            } finally { $response.Dispose() }
        } catch [Net.WebException] {
            if (-not $_.Exception.Response) { throw 'The local settings request failed.' }
            $status = [int]$_.Exception.Response.StatusCode
            $_.Exception.Response.Dispose()
            throw "The local server rejected the settings update (HTTP $status)."
        }
        Write-Output "Saved $Channel settings on the local server. Check the connector status in the workbench."
    } finally { $process.Dispose() }
}
