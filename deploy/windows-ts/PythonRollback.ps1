function Read-PythonHandoff {
    $handoff = Read-State $handoffPath
    if ($handoff -and ($handoff.format -ne 1 -or $handoff.state -notin 'preparing', 'prepared')) {
        throw 'Invalid Python rollback state. Inspect python-rollback.json.'
    }
    return $handoff
}

function Assert-HandoffStopped($Current, $Handoff) {
    foreach ($record in @((Read-State $runPath), $Handoff.worker)) {
        $process = Get-RecordedProcess $record
        if ($process) {
            $process.Dispose()
            throw 'Stop the installed TypeScript service and wait for any preparation process to exit first.'
        }
    }
    if (Test-ListeningPort $Current.port) {
        throw "The configured port $($Current.port) is still listening. Check the owning process first."
    }
}

function Prepare-PythonHandoff($Current, $Handoff) {
    if ($Handoff) { throw 'A Python rollback is already recorded. Inspect Diagnose before continuing.' }
    Assert-HandoffStopped $Current $null
    $release = Get-ReleaseDirectory $Current.active
    $manifest = Read-Release $release
    if ('python-rollback' -notin $manifest.features) {
        throw 'This release does not include the Python rollback CLI.'
    }
    $null = Confirm-Release $release
    $database = Join-Path $dataRoot 'superagent.db'
    Assert-PlainItem (Get-Item -LiteralPath $database -Force)
    $backupRoot = Join-Path $dataRoot 'rollback-backups'
    Assert-PlainPath $backupRoot

    $logs = Join-Path $logRoot "$([DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss-fff'))-python-rollback-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
    [IO.Directory]::CreateDirectory($logs) | Out-Null
    $record = @{ format = 1; state = 'preparing'; logs = $logs; worker = $null }
    Write-State $handoffPath $record

    $node = Join-Path $release 'payload/runtime/node.exe'
    $entry = Join-Path $release 'payload/apps/server/dist/main.js'
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $node
    $info.Arguments = '"' + $entry + '" --prepare-python-rollback'
    $info.WorkingDirectory = $dataRoot
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = [Text.Encoding]::UTF8
    $info.StandardErrorEncoding = [Text.Encoding]::UTF8
    $info.EnvironmentVariables.Clear()
    foreach ($name in 'SystemRoot', 'SystemDrive', 'WINDIR', 'ComSpec') {
        $value = [Environment]::GetEnvironmentVariable($name, 'Process')
        if ($value) { $info.EnvironmentVariables[$name] = $value }
    }
    $info.EnvironmentVariables['SUPERAGENT_DATA_DIR'] = $dataRoot
    $info.EnvironmentVariables['SUPERAGENT_PORT'] = '0'
    $process = [Diagnostics.Process]::Start($info)
    try {
        $output = $process.StandardOutput.ReadToEndAsync()
        $errors = $process.StandardError.ReadToEndAsync()
        if (-not $process.HasExited) {
            $record.worker = @{ pid = $process.Id; startedTicks = $process.StartTime.ToUniversalTime().Ticks.ToString(); version = $Current.active }
            Write-State $handoffPath $record
        }
        if (-not $process.WaitForExit($RollbackTimeoutSeconds * 1000)) {
            $process.Kill()
            $process.WaitForExit()
            throw "Python rollback preparation timed out. Check $logs and the database backup before proceeding."
        }
        [IO.File]::WriteAllText((Join-Path $logs 'stderr.log'), $errors.GetAwaiter().GetResult())
        $json = $output.GetAwaiter().GetResult()
        [IO.File]::WriteAllText((Join-Path $logs 'stdout.json'), $json)
        if ($process.ExitCode -ne 0) { throw "Python rollback preparation failed (exit $($process.ExitCode)). Check $logs." }
        $result = $json | ConvertFrom-Json
        $backup = [IO.Path]::GetFullPath($result.backup)
        if ($result.prepared -ne $true -or $result.database -ne $database -or
            (Split-Path -Parent $backup) -ne $backupRoot -or -not (Test-Path -LiteralPath $backup -PathType Leaf)) {
            throw "Unexpected Python rollback result. Check $logs."
        }
        Assert-PlainItem (Get-Item -LiteralPath $backup -Force)
        $record.state = 'prepared'
        $record.backup = $backup
        $json
    } finally {
        if (-not $process.HasExited) {
            $process.Kill()
            $process.WaitForExit()
        }
        $process.Dispose()
        $record.worker = $null
        Write-State $handoffPath $record
    }
}

function Release-PythonHandoff($Current, $Handoff) {
    if (-not $Handoff) { throw 'There is no pending Python rollback.' }
    if (-not $ConfirmPythonStopped) { throw 'Verify Python is stopped, including on other ports, and pass -ConfirmPythonStopped.' }
    Assert-HandoffStopped $Current $Handoff
    Remove-Item -LiteralPath $handoffPath
    Write-Output 'Python rollback reservation released. Start TypeScript separately when ready.'
}
