[CmdletBinding()]
param()
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
& (Join-Path $PSScriptRoot 'stop.ps1') -StateDirectory (Join-Path $ProjectRoot 'data/preview-service')
