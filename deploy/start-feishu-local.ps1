[CmdletBinding()]
param(
    [int]$Port = 8765,
    [string]$OwnerId = 'admin',
    [string]$CodexExecutable = $env:SUPERAGENT_CODEX_EXECUTABLE
)
$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$CredentialFile = Join-Path $Root 'data/feishu-card-credentials.xml'
$Sdk = Join-Path $PSScriptRoot 'state/feishu-sdk'
$Saved = Import-Clixml -LiteralPath $CredentialFile
if ($Saved.Credential -isnot [pscredential] -or $Saved.Credential.Password.Length -eq 0 -or
    $Saved.Credential.UserName -cnotmatch '^cli_[A-Za-z0-9]+$' -or
    $Saved.OpenId -cnotmatch '^ou_[A-Za-z0-9_-]+$') {
    throw '飞书凭证格式无效。'
}
if (-not (Test-Path -LiteralPath (Join-Path $Sdk 'lark_oapi-1.8.0.dist-info'))) {
    throw '正式服务目录缺少已核验的飞书 SDK。'
}
$Values = @{
    SUPERAGENT_FEISHU_ENABLED = '1'
    SUPERAGENT_FEISHU_MODE = 'card'
    SUPERAGENT_FEISHU_APP_ID = $Saved.Credential.UserName
    SUPERAGENT_FEISHU_APP_SECRET = $Saved.Credential.GetNetworkCredential().Password
    SUPERAGENT_FEISHU_OPEN_ID = $Saved.OpenId
    SUPERAGENT_FEISHU_OWNER_ID = $OwnerId
    PYTHONPATH = (@($Sdk, $env:PYTHONPATH) | Where-Object { $_ }) -join [IO.Path]::PathSeparator
}
$Previous = @{}
try {
    foreach ($Key in $Values.Keys) {
        $Previous[$Key] = [Environment]::GetEnvironmentVariable($Key, 'Process')
        [Environment]::SetEnvironmentVariable($Key, $Values[$Key], 'Process')
    }
    & (Join-Path $PSScriptRoot 'start-local.ps1') -Port $Port -CodexExecutable $CodexExecutable
} finally {
    foreach ($Key in $Previous.Keys) {
        [Environment]::SetEnvironmentVariable($Key, $Previous[$Key], 'Process')
    }
}
