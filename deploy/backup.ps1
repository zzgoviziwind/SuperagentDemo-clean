[CmdletBinding()]
param([Parameter(Mandatory)][string]$Destination, [Parameter(Mandatory)][string]$DataRoot)
$ErrorActionPreference = 'Stop'
if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'state/service.json')) { throw '请先停止本机服务并确认所有执行器停止。' }
if (-not $env:SUPERAGENT_DATABASE_URL) { throw '需要通过环境提供 SUPERAGENT_DATABASE_URL。' }
& (Join-Path $PSScriptRoot '../.venv/Scripts/python.exe') (Join-Path $PSScriptRoot 'snapshot.py') backup --destination $Destination --data-root $DataRoot --services-stopped
if ($LASTEXITCODE -ne 0) { throw '备份失败，保留不完整目录供检查。' }
