[CmdletBinding()]
param(
    [ValidateSet('Install', 'Uninstall', 'Start', 'Stop', 'Restart', 'Status', 'Diagnose', 'Rollback', 'Configure', 'ConfigureChannel', 'PreparePythonRollback', 'ReleasePythonRollback')]
    [string]$Action = 'Status',
    [string]$InstallRoot,
    [ValidateRange(1024, 65535)][int]$Port = 18765,
    [ValidateRange(2, 180)][int]$StartupSeconds = 30,
    [ValidateSet('Disabled', 'Existing', 'Environment')][string]$CodexMode,
    [string]$CodexExecutable,
    [string]$CodexHome,
    [string]$InjectEnvironment,
    [switch]$ClearInjectedEnvironment,
    [ValidateSet('dingtalk', 'redmine')][string]$Channel,
    [string]$ChannelSettingsPath,
    [switch]$ConfirmPythonStopped,
    [ValidateRange(30, 14400)][int]$RollbackTimeoutSeconds = 300
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Package.ps1')
. (Join-Path $PSScriptRoot 'Configuration.ps1')
. (Join-Path $PSScriptRoot 'PythonRollback.ps1')

if (-not $InstallRoot) {
    $InstallRoot = if ($Action -eq 'Install') { Join-Path $env:LOCALAPPDATA 'SuperAgent' } else { $PSScriptRoot }
}
$root = [IO.Path]::GetFullPath($InstallRoot)
Assert-PlainPath $root
if ((Split-Path -Qualifier $root) -notmatch '^[a-zA-Z]:$' -or $root.TrimEnd('\') -eq (Split-Path -Qualifier $root)) {
    throw 'Use a dedicated installation directory on a local drive.'
}
$statePath = Join-Path $root 'current.json'
$runPath = Join-Path $root 'process.json'
$releaseRoot = Join-Path $root 'releases'
$dataRoot = Join-Path $root 'data'
$logRoot = Join-Path $root 'logs'
$lockPath = Join-Path $root 'operation.lock'
$configurationPath = Join-Path $root 'configuration.json'
$retainedPath = Join-Path $root 'retained.json'
$handoffPath = Join-Path $root 'python-rollback.json'
$systemDirectory = [Environment]::SystemDirectory

function Read-State([string]$Path) {
    if (Test-Path -LiteralPath $Path) {
        Assert-PlainItem (Get-Item -LiteralPath $Path -Force)
        Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
    }
}

function Write-State([string]$Path, $Value) {
    $temporary = "$Path.$([guid]::NewGuid().ToString('N')).tmp"
    [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 5))
    try {
        if ([IO.File]::Exists($Path)) {
            [IO.File]::Replace($temporary, $Path, [NullString]::Value)
        } else {
            [IO.File]::Move($temporary, $Path)
        }
    } finally {
        if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
    }
}

function Get-ReleaseDirectory([string]$Version) {
    Assert-ReleaseName $Version
    Join-Path $releaseRoot $Version
}

function Read-RetainedState {
    $record = Read-State $retainedPath
    if ($record) {
        if ($record.format -ne 1 -or $record.pending -isnot [bool] -or
            $record.dataEpoch -cnotmatch '^[1-9][0-9]{0,8}$' -or
            $record.port -notmatch '^\d{4,5}$' -or $record.port -lt 1024 -or $record.port -gt 65535) {
            throw 'Invalid retained.json. Check the preserved data before proceeding.'
        }
        foreach ($name in $record.removals) { Assert-ReleaseName $name }
    }
    return $record
}

function Remove-InstalledReleases($Current, $Retained) {
    if (-not $Current -and -not $Retained) { throw 'No installed release was found.' }
    if ($Retained -and $Retained.pending) {
        $removals = @($Retained.removals | Where-Object { $_ })
    } else {
        $removals = @(if (Test-Path -LiteralPath $releaseRoot -PathType Container) {
            foreach ($item in Get-ChildItem -LiteralPath $releaseRoot -Directory -Force) {
                if ($item.Name -cnotmatch '^[a-z0-9][a-z0-9_-]{0,63}$') { continue }
                Assert-PlainItem $item
                $marker = Read-State (Join-Path $item.FullName 'release.json')
                if (-not $marker) { $marker = Read-State (Join-Path $item.FullName 'installing.json') }
                if ($marker -and $marker.format -eq 1 -and $marker.version -ceq $item.Name) { $item.Name }
            }
        })
    }

    # Preflight the exact managed subtrees before stopping the service. Other
    # entries in the install directory are never recursively removed.
    $paths = @(foreach ($name in $removals) {
        $path = Get-ReleaseDirectory $name
        if (-not (Test-Path -LiteralPath $path)) { continue }
        $resolved = (Resolve-Path -LiteralPath $path).ProviderPath
        if ($resolved -ne $path -or (Split-Path -Parent $resolved) -ne $releaseRoot) { throw "Unexpected release path: $path" }
        Assert-PlainPath $resolved
        Get-TreeFiles $resolved | Out-Null
        $resolved
    })
    Stop-RecordedService
    $old = if ($Current) { $Current } else { $Retained }
    $state = @{ format = 1; port = $old.port; dataEpoch = $old.dataEpoch; pending = $true; removals = $removals }
    Write-State $retainedPath $state
    if (Test-Path -LiteralPath $statePath) { Remove-Item -LiteralPath $statePath }
    foreach ($path in $paths) { Remove-Item -LiteralPath $path -Recurse -Force }
    if (Test-Path -LiteralPath $releaseRoot -PathType Container) {
        if (@(Get-ChildItem -LiteralPath $releaseRoot -Force).Count -eq 0) {
            [IO.Directory]::Delete($releaseRoot, $false)
        } else {
            Write-Warning "Unrecognized entries were preserved in $releaseRoot"
        }
    }
    $state.pending = $false
    $state.removals = @()
    Write-State $retainedPath $state
    Write-Output "Uninstalled the application. Data, launch configuration and logs were retained in $root"
}

function Get-RecordedProcess($Record) {
    if (-not $Record) { return }
    if ($Record.pid -notmatch '^[1-9][0-9]{0,9}$' -or $Record.startedTicks -notmatch '^[0-9]{18,19}$') {
        throw 'Invalid process record. Inspect process.json.'
    }
    $expected = Join-Path (Get-ReleaseDirectory $Record.version) 'payload/runtime/node.exe'
    $process = Get-Process -Id $Record.pid -ErrorAction SilentlyContinue
    if (-not $process) { return }
    # Keep an open process handle until the caller has finished with this PID.
    $null = $process.Handle
    if ($process.HasExited) { $process.Dispose(); return }
    if ($process.StartTime.ToUniversalTime().Ticks.ToString() -ne $Record.startedTicks -or
        $process.Path -ne $expected) {
        $process.Dispose()
        throw 'The process record does not identify our Node process. Inspect process.json before retrying.'
    }
    return $process
}

function Stop-ProcessTree($Process) {
    if ($Process.HasExited) { return }
    $result = & (Join-Path $systemDirectory 'taskkill.exe') /PID $Process.Id /T /F 2>&1
    if ($LASTEXITCODE -ne 0 -and -not $Process.HasExited) { throw "Stop failed: $result" }
    if (-not $Process.WaitForExit(10000)) { throw "Process did not exit: $($Process.Id)" }
}

function Stop-RecordedService {
    $record = Read-State $runPath
    $process = Get-RecordedProcess $record
    if ($process) {
        try {
            $logName = Split-Path -Leaf $record.logs
            $logs = Join-Path $logRoot $logName
            if ($logName -notmatch '^[0-9]{8}-[0-9]{6}-[0-9]{3}-[a-z0-9_-]+-[a-f0-9]{8}$' -or $logs -ne $record.logs) {
                throw 'Invalid log directory in process.json.'
            }
            Assert-PlainPath $logs
            $stopFile = Join-Path $logs 'stop.request'
            if (-not (Test-Path -LiteralPath $stopFile)) {
                [IO.File]::Open($stopFile, 'CreateNew').Dispose()
            }
            if (-not $process.WaitForExit(7000)) {
                Write-Warning 'Graceful shutdown timed out. Terminating the recorded process tree.' -WarningAction Continue
                Stop-ProcessTree $process
            }
        } finally { $process.Dispose() }
    }
    if ($record) { Remove-Item -LiteralPath $runPath }
}

function Get-LocalResponse([int]$ListenPort, [string]$Resource) {
    $request = [Net.HttpWebRequest]::Create("http://127.0.0.1:$ListenPort$Resource")
    $request.Proxy = $null
    $request.Timeout = 1000
    $request.ReadWriteTimeout = 1000
    $request.AllowAutoRedirect = $false
    try { $response = $request.GetResponse() } catch [Net.WebException] {
        if ($_.Exception.Response) { $_.Exception.Response.Dispose() }
        return
    }
    try {
        if ([int]$response.StatusCode -ne 200) { return }
        $reader = [IO.StreamReader]::new($response.GetResponseStream())
        try { $reader.ReadToEnd() } finally { $reader.Dispose() }
    } finally { $response.Dispose() }
}

function Test-ListeningPort([int]$ListenPort) {
    $ports = [Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
    return [bool]($ports | Where-Object Port -eq $ListenPort)
}

function Test-ServiceReady($Process, [int]$ListenPort) {
    $body = Get-LocalResponse $ListenPort '/health'
    if (-not $body -or $Process.HasExited) { return $false }
    try { $health = $body | ConvertFrom-Json } catch { return $false }
    if ($health.status -cne 'ok') { return $false }
    $entries = & (Join-Path $systemDirectory 'netstat.exe') -ano
    if ($LASTEXITCODE -ne 0) { throw 'Could not verify the listener owner.' }
    $listeners = @($entries | Select-String "^\s*TCP\s+(\S+):$ListenPort\s+\S+:0\s+\S+\s+(\d+)\s*$")
    if (-not $listeners) { return $false }
    foreach ($entry in $listeners) {
        $address = $entry.Matches[0].Groups[1].Value
        if ($entry.Matches[0].Groups[2].Value -ne $Process.Id -or $address -ne '127.0.0.1') {
            throw "Unexpected listener on port $ListenPort. The server must bind only to 127.0.0.1."
        }
    }
    return (Get-LocalResponse $ListenPort '/') -match '<(?:!doctype\s+html|html)\b'
}

function Start-IsolatedProcess([string]$Payload, [int]$ListenPort, [string]$LogDirectory, [hashtable]$Settings) {
    $profileRoot = Join-Path $dataRoot 'profile'
    $local = Join-Path $profileRoot 'Local'
    $roaming = Join-Path $profileRoot 'Roaming'
    $temp = Join-Path $profileRoot 'Temp'
    foreach ($directory in $profileRoot, $local, $roaming, $temp) {
        Assert-PlainPath $directory
        [IO.Directory]::CreateDirectory($directory) | Out-Null
    }
    $node = Join-Path $Payload 'runtime/node.exe'
    $launcher = Join-Path $Payload 'runtime/launch.cjs'
    $entry = Join-Path $Payload 'apps/server/dist/main.js'
    $environment = @{
        SystemRoot = $env:SystemRoot
        SystemDrive = $env:SystemDrive
        ComSpec = (Join-Path $systemDirectory 'cmd.exe')
        PATH = "$(Split-Path -Parent $node);$systemDirectory"
        USERPROFILE = $profileRoot
        HOME = $profileRoot
        APPDATA = $roaming
        LOCALAPPDATA = $local
        TEMP = $temp
        TMP = $temp
        SUPERAGENT_PORT = [string]$ListenPort
        SUPERAGENT_DATA_DIR = $dataRoot
        SUPERAGENT_WEB_DIST = (Join-Path $Payload 'apps/web/dist')
        SUPERAGENT_STOP_FILE = (Join-Path $LogDirectory 'stop.request')
        SUPERAGENT_LOG_DIRECTORY = $LogDirectory
    }
    foreach ($name in $Settings.Keys) { $environment.Add($name, $Settings[$name]) }
    $original = [Environment]::GetEnvironmentVariables('Process')
    try {
        foreach ($name in $original.Keys) {
            if (-not $environment.ContainsKey($name)) { [Environment]::SetEnvironmentVariable($name, $null, 'Process') }
        }
        foreach ($name in $environment.Keys) { [Environment]::SetEnvironmentVariable($name, $environment[$name], 'Process') }
        Start-Process -FilePath $node -ArgumentList ('--require "' + $launcher + '" "' + $entry + '"') -WorkingDirectory $dataRoot -WindowStyle Hidden -PassThru
    } finally {
        foreach ($name in $environment.Keys) {
            if (-not $original.Contains($name)) { [Environment]::SetEnvironmentVariable($name, $null, 'Process') }
        }
        foreach ($name in $original.Keys) { [Environment]::SetEnvironmentVariable($name, $original[$name], 'Process') }
    }
}

function Start-Release([string]$Version, [int]$ListenPort) {
    $directory = Get-ReleaseDirectory $Version
    $manifest = Read-Release $directory
    if ($manifest.version -cne $Version) { throw 'Installed release name differs from its manifest.' }
    $record = Read-State $runPath
    $existing = Get-RecordedProcess $record
    if ($existing) {
        try {
            if ($record.version -eq $Version -and $record.port -eq $ListenPort) {
                if (-not (Test-ServiceReady $existing $ListenPort)) {
                    throw "The recorded process is not healthy. Use Diagnose or Restart. Logs: $($record.logs)"
                }
                return $record
            }
        } finally { $existing.Dispose() }
    }
    $settings = Get-LaunchEnvironment
    Stop-RecordedService
    if (Test-ListeningPort $ListenPort) { throw "Port $ListenPort is already in use. The other process was left running." }
    $logs = Join-Path $logRoot "$([DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss-fff'))-$Version-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
    [IO.Directory]::CreateDirectory($logs) | Out-Null
    $process = Start-IsolatedProcess (Join-Path $directory 'payload') $ListenPort $logs $settings
    try {
        $null = $process.Handle
        if ($process.HasExited) { throw "Process exited with code $($process.ExitCode)." }
        $record = @{ pid = $process.Id; startedTicks = $process.StartTime.ToUniversalTime().Ticks.ToString()
            version = $Version; port = $ListenPort; logs = $logs }
        Write-State $runPath $record
        $clock = [Diagnostics.Stopwatch]::StartNew()
        while ($clock.Elapsed.TotalSeconds -lt $StartupSeconds) {
            if ($process.HasExited) { throw "Process exited with code $($process.ExitCode)." }
            if (Test-ServiceReady $process $ListenPort) { return $record }
            Start-Sleep -Milliseconds 200
        }
        throw 'Timed out waiting for /health and the workbench.'
    } catch {
        $failure = $_
        try {
            Stop-ProcessTree $process
            if (Test-Path -LiteralPath $runPath) { Remove-Item -LiteralPath $runPath }
        } catch {
            throw "Startup failed: $failure Cleanup failed: $_ Logs: $logs"
        }
        throw "Startup failed: $failure Logs: $logs"
    } finally { $process.Dispose() }
}

function Switch-Release($Current, $Next) {
    $null = Get-LaunchEnvironment
    $running = Get-RecordedProcess (Read-State $runPath)
    $wasRunning = [bool]$running
    if ($running) { $running.Dispose() }
    Stop-RecordedService
    try {
        $record = Start-Release $Next.active $Next.port
        Write-State $statePath $Next
        return $record
    } catch {
        $failure = $_
        try {
            Stop-RecordedService
            if ($Current -and $wasRunning) { $null = Start-Release $Current.active $Current.port }
        } catch {
            throw "Version change failed: $failure Previous release could not be restarted: $_"
        }
        throw $failure
    }
}

function Install-Release($Current, $Retained) {
    if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'release.json') -PathType Leaf)) {
        throw 'Run Install.cmd from an extracted offline package.'
    }
    $incoming = Confirm-Release $PSScriptRoot
    $existingData = if ($Current) { $Current } else { $Retained }
    if ($existingData -and $existingData.dataEpoch -ne $incoming.dataEpoch) { throw 'Incompatible data generation. Use a separate installation directory and an explicit migration.' }
    $target = Get-ReleaseDirectory $incoming.version
    Assert-PlainPath $target
    $installedManifest = Join-Path $target 'release.json'
    $incomingManifest = Join-Path $PSScriptRoot 'release.json'
    if (Test-Path -LiteralPath $installedManifest) {
        $null = Confirm-Release $target
        if ((Get-FileHash -LiteralPath $installedManifest).Hash -ne (Get-FileHash -LiteralPath $incomingManifest).Hash) {
            throw 'This release name already identifies a different package.'
        }
    } else {
        if ($Current -and $incoming.version -in $Current.active, $Current.previous) {
            throw 'The selected release is missing its installed manifest.'
        }
        [IO.Directory]::CreateDirectory($target) | Out-Null
        Get-TreeFiles $target | Out-Null
        $staging = Join-Path $target 'installing.json'
        $marker = Read-State $staging
        if ($marker -and ($marker.format -ne 1 -or $marker.version -cne $incoming.version)) {
            throw 'Unrecognized partial installation marker.'
        }
        if (-not $marker) {
            if (@(Get-ChildItem -LiteralPath $target -Force).Count -ne 0) {
                throw 'This directory contains unrecognized files. Choose another release name or installation directory.'
            }
            Write-State $staging @{ format = 1; version = $incoming.version }
        }
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'payload') -Destination $target -Recurse -Force
        Confirm-Payload (Join-Path $target 'payload') $incoming.files
        # The manifest commits the verified payload. A partial copy has no
        # manifest and can be resumed without changing the active release.
        $pending = Join-Path $target ('release-' + [guid]::NewGuid().ToString('N') + '.tmp')
        try {
            [IO.File]::WriteAllBytes($pending, [IO.File]::ReadAllBytes($incomingManifest))
            [IO.File]::Move($pending, $installedManifest)
            Remove-Item -LiteralPath $staging
        } finally {
            if ([IO.File]::Exists($pending)) { [IO.File]::Delete($pending) }
        }
    }
    foreach ($file in 'Package.ps1', 'Configuration.ps1', 'PythonRollback.ps1', 'SuperAgent.ps1', 'SuperAgent.cmd', 'README.md', 'PYTHON-ROLLBACK.md', 'field/README.md') {
        $destination = Join-Path $root $file
        $source = Join-Path $PSScriptRoot $file
        if ($file -eq 'field/README.md' -and -not (Test-Path -LiteralPath $source -PathType Leaf)) { continue }
        $parent = Split-Path -Parent $destination
        Assert-PlainPath $parent
        [IO.Directory]::CreateDirectory($parent) | Out-Null
        $replace = Test-Path -LiteralPath $destination
        if ($replace) {
            Assert-PlainItem (Get-Item -LiteralPath $destination -Force)
            if ((Get-FileHash -LiteralPath $source).Hash -eq (Get-FileHash -LiteralPath $destination).Hash) { continue }
        }
        $incomingCommand = "$destination.$([guid]::NewGuid().ToString('N')).tmp"
        try {
            [IO.File]::WriteAllBytes($incomingCommand, [IO.File]::ReadAllBytes($source))
            if ($replace) { [IO.File]::Replace($incomingCommand, $destination, [NullString]::Value) }
            else { [IO.File]::Move($incomingCommand, $destination) }
        } finally {
            if ([IO.File]::Exists($incomingCommand)) { [IO.File]::Delete($incomingCommand) }
        }
    }
    if ($Current -and $Current.active -eq $incoming.version) {
        return Start-Release $Current.active $Current.port
    }
    $previous = if ($Current) { $Current.active } else { $null }
    $listenPort = if ($existingData) { $existingData.port } else { $Port }
    Switch-Release $Current @{ active = $incoming.version; previous = $previous; port = $listenPort; dataEpoch = $incoming.dataEpoch }
}

function Get-ServiceStatus($Current, $Retained, $Handoff, [bool]$Details) {
    $record = Read-State $runPath
    $process = Get-RecordedProcess $record
    try {
        $status = if (-not $Current) {
            if ($Retained) { 'uninstalled-data-retained' } else { 'not-installed' }
        } elseif ($record -and -not $process) { 'stale-record' } else { 'stopped' }
        $listenPort = if ($Current) { $Current.port } elseif ($Retained) { $Retained.port } else { $Port }
        if ($Retained -and $Retained.pending) {
            $status = 'uninstall-incomplete'
        } elseif ($Handoff) {
            $status = "python-rollback-$($Handoff.state)"
        } elseif ($process) {
            $status = if (-not $Current -or $Current.active -ne $record.version) { 'activation-interrupted' }
                elseif (Test-ServiceReady $process $record.port) { 'running' } else { 'unhealthy' }
        } elseif ($Current -and (Test-ListeningPort $listenPort)) { $status = 'port-in-use' }
        $result = [ordered]@{ status = $status; active = $Current.active; previous = $Current.previous
            pid = if ($process) { $process.Id } else { $null }; url = "http://127.0.0.1:$listenPort" }
        if ($Details) {
            $result.installRoot = $root
            $result.data = $dataRoot
            $result.logRoot = $logRoot
            $latest = Get-ChildItem -LiteralPath $logRoot -Directory -ErrorAction SilentlyContinue |
                Sort-Object Name -Descending | Select-Object -First 1
            $result.latestLogs = $latest.FullName
            $result.runningRelease = $record.version
            $result.runningLogs = $record.logs
            $result.dataEpoch = if ($Current) { $Current.dataEpoch } else { $Retained.dataEpoch }
            $result.guide = Join-Path $root 'README.md'
            $result.pythonRollback = if ($Handoff) { @{ state = $Handoff.state; logs = $Handoff.logs; backup = $Handoff.backup } } else { $null }
            $result.launchConfiguration = Get-LaunchConfigurationStatus
        }
        $result | ConvertTo-Json
    } finally { if ($process) { $process.Dispose() } }
}

if ($Action -eq 'Install') {
    [IO.Directory]::CreateDirectory($root) | Out-Null
} elseif (-not (Test-Path -LiteralPath $root -PathType Container)) {
    throw "Install directory not found: $root"
}
if (Test-Path -LiteralPath $lockPath) { Assert-PlainItem (Get-Item -LiteralPath $lockPath -Force) }
try { $lock = [IO.File]::Open($lockPath, 'OpenOrCreate', 'ReadWrite', 'None') } catch {
    throw "Cannot lock this installation. Another operation is running, or the directory is not writable. $root"
}
try {
    $current = Read-State $statePath
    $retained = Read-RetainedState
    $handoff = Read-PythonHandoff
    if ($handoff -and $Action -in 'Install', 'Uninstall', 'Start', 'Restart', 'Rollback') {
        throw 'The database is reserved for Python rollback. Stop Python and use ReleasePythonRollback before activating TypeScript.'
    }
    if ($retained -and $retained.pending -and $Action -notin 'Uninstall', 'Status', 'Diagnose', 'Stop') {
        throw 'Uninstall was interrupted. Run Uninstall again to complete it.'
    }
    if ($current) {
        Assert-ReleaseName $current.active
        if ($current.previous) { Assert-ReleaseName $current.previous }
        if ($current.dataEpoch -cnotmatch '^[1-9][0-9]{0,8}$') { throw 'Invalid data generation in current.json.' }
        if ($current.port -notmatch '^\d{4,5}$' -or $current.port -lt 1024 -or $current.port -gt 65535) { throw 'Invalid port in current.json.' }
        if ($PSBoundParameters.ContainsKey('Port') -and $Port -ne $current.port) { throw "This installation already uses port $($current.port)." }
    } elseif ($retained -and $PSBoundParameters.ContainsKey('Port') -and $Port -ne $retained.port) {
        throw "The retained installation uses port $($retained.port)."
    }
    foreach ($directory in $releaseRoot, $dataRoot, $logRoot) {
        Assert-PlainPath $directory
        if ($Action -eq 'Install') { [IO.Directory]::CreateDirectory($directory) | Out-Null }
    }
    if (-not $current -and $Action -in 'Start', 'Restart', 'Rollback', 'Configure', 'ConfigureChannel', 'PreparePythonRollback', 'ReleasePythonRollback') { throw 'There is no active release. Run the installer first.' }
    switch ($Action) {
        'Install' { $result = Install-Release $current $retained; Write-Output "Installed $($result.version) at http://127.0.0.1:$($result.port)" }
        'Uninstall' { Remove-InstalledReleases $current $retained }
        'Start' { $result = Start-Release $current.active $current.port; Write-Output "Running at http://127.0.0.1:$($result.port) (PID $($result.pid))" }
        'Stop' { Stop-RecordedService; Write-Output 'Stopped.' }
        'Restart' {
            $null = Get-LaunchEnvironment
            Stop-RecordedService
            $result = Start-Release $current.active $current.port
            Write-Output "Restarted at http://127.0.0.1:$($result.port) (PID $($result.pid))"
        }
        'Rollback' {
            if (-not $current.previous) { throw 'There is no previous release to roll back to.' }
            $previous = Confirm-Release (Get-ReleaseDirectory $current.previous)
            if ($previous.dataEpoch -ne $current.dataEpoch -or $previous.version -cne $current.previous) { throw 'The previous release is incompatible.' }
            $result = Switch-Release $current @{ active = $current.previous; previous = $current.active; port = $current.port; dataEpoch = $current.dataEpoch }
            Write-Output "Rolled back to $($result.version) at http://127.0.0.1:$($result.port)"
        }
        'Status' { Get-ServiceStatus $current $retained $handoff $false }
        'Diagnose' { Get-ServiceStatus $current $retained $handoff $true }
        'Configure' { Set-LaunchConfiguration }
        'ConfigureChannel' { Set-ChannelConfiguration $current }
        'PreparePythonRollback' { Prepare-PythonHandoff $current $handoff }
        'ReleasePythonRollback' { Release-PythonHandoff $current $handoff }
    }
} finally { $lock.Dispose() }
