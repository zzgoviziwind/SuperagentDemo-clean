[CmdletBinding()]
param([string]$CodexExecutable = $env:SUPERAGENT_CODEX_EXECUTABLE)
$ErrorActionPreference = 'Stop'
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $CodexExecutable) { $CodexExecutable = (Get-Command codex -ErrorAction Stop).Source }
$PreviousHome = $env:CODEX_HOME
try {
    $env:CODEX_HOME = Join-Path $ProjectRoot 'data/codex-state'
    New-Item -ItemType Directory -Force -Path $env:CODEX_HOME | Out-Null
    & $CodexExecutable login --device-auth
    if ($LASTEXITCODE -ne 0) { throw 'Codex login did not complete. Please check the terminal output.' }
    & $CodexExecutable login status
} finally {
    $env:CODEX_HOME = $PreviousHome
}
