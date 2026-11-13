[CmdletBinding()]
param([int]$Port = 8765, [string]$ListenAddress = '127.0.0.1', [string]$StateDirectory = (Join-Path $PSScriptRoot 'state'))
$ErrorActionPreference = 'Stop'
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$Python = Join-Path $ProjectRoot '.venv/Scripts/python.exe'
if (-not (Test-Path -LiteralPath $Python)) { throw '请先在项目 .venv 安装 Python 3.12 和 requirements.txt 依赖。' }
if ($ListenAddress -ne '127.0.0.1' -and $ListenAddress -ne '::1' -and -not $env:SUPERAGENT_API_TOKEN) {
    throw '外部监听需要先设置 SUPERAGENT_API_TOKEN。'
}
$State = [IO.Path]::GetFullPath($StateDirectory)
New-Item -ItemType Directory -Force -Path $State | Out-Null
$PidFile = Join-Path $State 'service.json'
if (Test-Path -LiteralPath $PidFile) { throw '存在进程记录，请先运行 stop.ps1 并核对服务已停止。' }
if (-not $env:SUPERAGENT_DATABASE_URL) {
    $DatabasePath = (Join-Path $State 'control.db').Replace('\', '/')
    $env:SUPERAGENT_DATABASE_URL = "sqlite:///$DatabasePath"
}
if (-not $env:SUPERAGENT_WORKSPACES_ROOT) { $env:SUPERAGENT_WORKSPACES_ROOT = Join-Path $State 'workspaces' }
New-Item -ItemType Directory -Force -Path $env:SUPERAGENT_WORKSPACES_ROOT | Out-Null
$Process = Start-Process -FilePath $Python -ArgumentList @('-m', 'uvicorn', 'superagent.main:app', '--host', $ListenAddress, '--port', $Port) -WorkingDirectory $ProjectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $State 'stdout.log') -RedirectStandardError (Join-Path $State 'stderr.log') -PassThru
@{ pid = $Process.Id; started_ticks = $Process.StartTime.ToUniversalTime().Ticks; port = $Port } | ConvertTo-Json | Set-Content -LiteralPath $PidFile -Encoding utf8
$Headers = @{}
if ($env:SUPERAGENT_API_TOKEN) { $Headers.Authorization = "Bearer $env:SUPERAGENT_API_TOKEN" }
$HealthAddress = if ($ListenAddress -eq '::1') { '[::1]' } else { '127.0.0.1' }
try {
    for ($Attempt = 0; $Attempt -lt 60; $Attempt++) {
        $Process.Refresh()
        if ($Process.HasExited) { throw '服务已退出，请检查 deploy/state/stderr.log。' }
        try {
            $Health = Invoke-RestMethod -Uri "http://${HealthAddress}:$Port/health" -Headers $Headers -TimeoutSec 2
            if ($Health.status -eq 'ok') { Write-Output "服务已启动 http://127.0.0.1:$Port"; return }
        } catch { Start-Sleep -Milliseconds 500 }
    }
    throw '健康检查超时。'
} catch {
    & (Join-Path $PSScriptRoot 'stop.ps1') -StateDirectory $State
    throw
}
