[CmdletBinding()]
param([string]$StateDirectory = (Join-Path $PSScriptRoot 'state'))
$ErrorActionPreference = 'Stop'
$PidFile = Join-Path ([IO.Path]::GetFullPath($StateDirectory)) 'service.json'
if (-not (Test-Path -LiteralPath $PidFile)) { Write-Output '没有本脚本启动的服务记录。'; return }
$Record = Get-Content -LiteralPath $PidFile -Raw | ConvertFrom-Json
$Process = Get-Process -Id $Record.pid -ErrorAction SilentlyContinue
if ($Process) {
    $ExpectedTicks = $Record.started_ticks
    if (-not $ExpectedTicks -and $Record.started) { $ExpectedTicks = ([datetime]$Record.started).ToUniversalTime().Ticks }
    if ($Process.StartTime.ToUniversalTime().Ticks -ne $ExpectedTicks) { throw '进程标识已复用，拒绝终止，请人工核对。' }
    # Stop the owned process tree, including app-server children.
    try {
        $Process.Kill($true)
    } catch {
        $Process.Refresh()
        if (-not $Process.HasExited) {
            & taskkill.exe /PID $Record.pid /T /F | Out-Null
            if ($LASTEXITCODE -ne 0) { throw '终止进程树失败，请核对执行状态。' }
        }
    }
    if (-not $Process.WaitForExit(10000)) { throw '终止进程树失败，请核对执行状态。' }
}
Remove-Item -LiteralPath $PidFile
Write-Output '服务已停止，重启后须检查未知执行结果。'
