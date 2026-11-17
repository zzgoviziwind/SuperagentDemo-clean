[CmdletBinding()]
param([int]$Port = 8765, [string]$CodexExecutable = $env:SUPERAGENT_CODEX_EXECUTABLE)
$ErrorActionPreference = 'Stop'
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$env:SUPERAGENT_DATABASE_URL = 'sqlite:///' + (Join-Path $ProjectRoot 'data/workbench.db').Replace('\', '/')
$env:SUPERAGENT_WORKSPACES_ROOT = Join-Path $ProjectRoot 'data/workspaces'
$env:SUPERAGENT_ATTACHMENTS_ROOT = Join-Path $ProjectRoot 'data/attachments'
$env:SUPERAGENT_CODEX_HOME = Join-Path $ProjectRoot 'data/codex-state'
if ($CodexExecutable) { $env:SUPERAGENT_CODEX_EXECUTABLE = $CodexExecutable }
if (-not $env:HLZJ_REDMINE_API_KEY) {
    $env:HLZJ_REDMINE_API_KEY = [Environment]::GetEnvironmentVariable('HLZJ_REDMINE_API_KEY', 'User')
}
$PreviousHome = $env:CODEX_HOME
try {
    # The service adapter supplies its dedicated CODEX_HOME to the owned child.
    $env:CODEX_HOME = $null
    & (Join-Path $PSScriptRoot 'start.ps1') -Port $Port
} finally {
    $env:CODEX_HOME = $PreviousHome
}
