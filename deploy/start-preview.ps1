[CmdletBinding()]
param([int]$Port = 8876)
$ErrorActionPreference = 'Stop'
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$StateDirectory = Join-Path $ProjectRoot 'data/preview-service'
$RecordPath = Join-Path $StateDirectory 'service.json'
$PythonPath = Join-Path $ProjectRoot '.venv/Scripts/python.exe'
if (-not (Test-Path -LiteralPath $PythonPath)) { throw '项目 Python 环境不存在。' }
if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot 'apps/web/dist/index.html'))) { throw '请先构建工作台。' }
New-Item -ItemType Directory -Force -Path $StateDirectory | Out-Null
if (Test-Path -LiteralPath $RecordPath) {
    $Record = Get-Content -LiteralPath $RecordPath -Raw | ConvertFrom-Json
    $ExistingProcess = Get-Process -Id $Record.pid -ErrorAction SilentlyContinue
    if ($ExistingProcess -and $ExistingProcess.StartTime.ToUniversalTime().Ticks -eq $Record.started_ticks) {
        $Response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$($Record.port)/health" -TimeoutSec 5
        if ($Response.StatusCode -eq 200) { Write-Output "预览已在运行：http://127.0.0.1:$($Record.port)"; return }
        throw '已记录的预览进程仍在，但健康检查失败，请先停止预览。'
    }
    Remove-Item -LiteralPath $RecordPath
}
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { throw "端口 $Port 已被其他进程使用，未停止该进程。" }
$ArgsText = '"' + (Join-Path $PSScriptRoot 'preview.py') + '" --port ' + $Port + ' --state "' + (Join-Path $StateDirectory 'database') + '"'
$PreviewProcess = Start-Process -FilePath $PythonPath -ArgumentList $ArgsText -WorkingDirectory $ProjectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $StateDirectory 'stdout.log') -RedirectStandardError (Join-Path $StateDirectory 'stderr.log') -PassThru
@{ pid = $PreviewProcess.Id; started_ticks = $PreviewProcess.StartTime.ToUniversalTime().Ticks; port = $Port; kind = 'isolated-preview' } | ConvertTo-Json | Set-Content -LiteralPath $RecordPath -Encoding utf8
for ($Attempt = 0; $Attempt -lt 40; $Attempt++) {
    $PreviewProcess.Refresh()
    if ($PreviewProcess.HasExited) { throw '预览启动失败，请查看 data/preview-service/stderr.log。' }
    try {
        $Response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/api/v1/architecture" -TimeoutSec 2
        if ($Response.StatusCode -eq 200) { Write-Output "独立后台预览已启动：http://127.0.0.1:$Port"; return }
    } catch { Start-Sleep -Milliseconds 500 }
}
throw '预览启动超时，请查看预览日志。'
