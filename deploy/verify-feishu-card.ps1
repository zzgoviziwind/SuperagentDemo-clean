[CmdletBinding()]
param([string]$AppId, [string]$OpenId)
$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$Sdk = Join-Path $Root '.test-tmp/feishu-card-sdk'
$Python = Join-Path $Root '.venv/Scripts/python.exe'
if (-not (Test-Path -LiteralPath (Join-Path $Sdk 'lark_oapi'))) {
    throw '缺少飞书验证依赖。'
}
Write-Host '请先在旧的飞书长连接检查窗口按 Ctrl+C，只保留这个验收窗口。'
$App = if ($AppId) { $AppId.Trim() } else { (Read-Host 'App ID (cli_...)').Trim() }
if ($App -cnotmatch '^cli_[A-Za-z0-9]+$') {
    throw 'App ID 格式不正确，应以 cli_ 开头。'
}
$Recipient = if ($OpenId) { $OpenId.Trim() } else { '' }
if ($Recipient -cmatch '^ou_[A-Za-z0-9_-]+$') {
    Write-Host '应用 ID 和收件人 Open ID 已预填。'
} else {
    Write-Host '应用 ID 已就绪。下一栏要填你本人在这个应用下的 Open ID（ou_ 开头）。'
    do {
        $Recipient = (Read-Host '你的 Open ID (ou_...)，输入 q 退出').Trim()
        if ($Recipient -eq 'q') { return }
        if ($Recipient -cnotmatch '^ou_[A-Za-z0-9_-]+$') {
            Write-Warning '这一栏只接受 ou_ 开头的成员 Open ID。cli_ 开头的是应用 ID。'
        }
    } until ($Recipient -cmatch '^ou_[A-Za-z0-9_-]+$')
}
$Secret = Read-Host 'App Secret（输入不会显示）' -AsSecureString
if ($Secret.Length -eq 0) { throw 'App Secret 未填写。' }
$Credential = [pscredential]::new($App, $Secret)
$SavedPythonPath = $env:PYTHONPATH
try {
    $env:PYTHONPATH = $Sdk
    $env:SUPERAGENT_FEISHU_APP_ID = $App
    $env:SUPERAGENT_FEISHU_OPEN_ID = $Recipient
    $env:SUPERAGENT_FEISHU_APP_SECRET = $Credential.GetNetworkCredential().Password
    & $Python (Join-Path $PSScriptRoot 'verify_feishu_card.py')
    if ($LASTEXITCODE -ne 0) { throw '隔离验收没有通过；主服务未更改。' }
    $CredentialFile = Join-Path $Root 'data/feishu-card-credentials.xml'
    @{ Credential = $Credential; OpenId = $Recipient } |
        Export-Clixml -LiteralPath $CredentialFile
    Write-Host '验收通过。凭证已加密保存，只能由这台电脑上的当前 Windows 用户读取。'
} finally {
    Remove-Item Env:SUPERAGENT_FEISHU_APP_ID,Env:SUPERAGENT_FEISHU_OPEN_ID,Env:SUPERAGENT_FEISHU_APP_SECRET -ErrorAction SilentlyContinue
    $env:PYTHONPATH = $SavedPythonPath
    $Secret.Dispose()
}
