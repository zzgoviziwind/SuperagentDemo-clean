[CmdletBinding()]
param([Parameter(Mandatory)][string]$Snapshot, [Parameter(Mandatory)][string]$Destination)
$ErrorActionPreference = 'Stop'
if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'state/service.json')) { throw '请先停止本机服务。' }
& (Join-Path $PSScriptRoot '../.venv/Scripts/python.exe') (Join-Path $PSScriptRoot 'snapshot.py') restore --snapshot $Snapshot --destination $Destination --services-stopped
if ($LASTEXITCODE -ne 0) { throw '恢复失败，检查校验结果并保留原始备份。' }
Write-Output '已恢复至新目录。启动前请完成 RECONCILIATION_REQUIRED.txt 中的核对。'
