[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$FirstInstaller,
    [Parameter(Mandatory)][string]$UpgradeInstaller,
    [Parameter(Mandatory)][string]$FailingInstaller,
    [string]$EvidenceDirectory = ([IO.Path]::GetTempPath())
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Node24.ps1')
$node = Get-OfficialNode24
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this acceptance test without administrator elevation.'
}

$first = (Resolve-Path -LiteralPath $FirstInstaller).Path
$upgrade = (Resolve-Path -LiteralPath $UpgradeInstaller).Path
$bad = (Resolve-Path -LiteralPath $FailingInstaller).Path
$run = Join-Path ([IO.Path]::GetFullPath($EvidenceDirectory)) ('ts-life-' + [guid]::NewGuid().ToString('N').Substring(0,12))
$instance = Join-Path $run ('Test ' + [char]0x7528 + [char]0x6237)
$manager = Join-Path $instance 'SuperAgent.cmd'
$fakeProject = Join-Path $run 'synthetic-project'
[IO.Directory]::CreateDirectory($fakeProject) | Out-Null

$port = $null
for ($attempt = 0; $attempt -lt 20 -and -not $port; $attempt++) {
    $candidate = Get-Random -Minimum 49152 -Maximum 65536
    $probe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $candidate)
    try { $probe.Start(); $port = $candidate } catch [Net.Sockets.SocketException] {
        # Pick a different temporary port if this one is already bound.
    } finally { $probe.Stop() }
}
if (-not $port) { throw 'Cannot reserve a temporary high port.' }

function Invoke-Checked([string]$Command, [string[]]$Arguments, [string]$ExpectedError = '') {
    $ErrorActionPreference = 'Continue'
    $result = & $Command @Arguments 2>&1 | Out-String
    $code = $LASTEXITCODE
    if ($ExpectedError) {
        if ($code -eq 0 -or $result -notmatch $ExpectedError) { throw "Expected $ExpectedError, got exit $code. $result" }
    } elseif ($code -ne 0) { throw "Command failed, exit $code. $result" }
    return $result
}

function Assert-Same($Actual, $Expected, [string]$Label) {
    if ($Actual -cne $Expected) { throw "$Label expected '$Expected', got '$Actual'." }
}

function Get-Diagnose {
    Invoke-Checked $manager @('-Action', 'Diagnose') | ConvertFrom-Json
}

function Request-Local([string]$Resource, [string]$Method = 'GET', $Payload = $null) {
    $request = [Net.HttpWebRequest]::Create("http://127.0.0.1:$port$Resource")
    $request.Proxy = $null
    $request.AllowAutoRedirect = $false
    $request.Timeout = 5000
    $request.ReadWriteTimeout = 5000
    $request.Method = $Method
    if ($null -ne $Payload) {
        $body = [Text.Encoding]::UTF8.GetBytes(($Payload | ConvertTo-Json -Depth 8 -Compress))
        $request.ContentLength = $body.Length
        $request.ContentType = 'application/json'
        $stream = $request.GetRequestStream()
        try { $stream.Write($body, 0, $body.Length) } finally { $stream.Dispose() }
    }
    $response = $request.GetResponse()
    try {
        $reader = [IO.StreamReader]::new($response.GetResponseStream())
        try { $reader.ReadToEnd() } finally { $reader.Dispose() }
    } finally { $response.Dispose() }
}

function Confirm-TS {
    $diag = Get-Diagnose
    Assert-Same $diag.status 'running' 'Installed status'
    Assert-Same $diag.url "http://127.0.0.1:$port" 'Instance URL'
    $health = Request-Local '/health' | ConvertFrom-Json
    Assert-Same $health.implementation 'typescript' 'Actual TS health response'
    Assert-Same $health.status 'ok' 'Health status'
    $index = Request-Local '/'
    $asset = [regex]::Match($index, 'src="(/assets/[^"]+)"').Groups[1].Value
    if (-not $asset -or -not (Request-Local $asset)) { throw 'Missing packaged React asset.' }
    $nodePath = (Get-Process -Id $diag.pid -ErrorAction Stop).Path
    Assert-Same (Get-FileHash -LiteralPath $nodePath -Algorithm SHA256).Hash $node.nodeSha256 'Running official Node executable'
    $release = Join-Path $instance "releases/$($diag.active)"
    $manifest = Get-Content -LiteralPath (Join-Path $release 'release.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert-Same $manifest.nodeRuntime.archiveSha256 $node.archiveSha256 'Official archive recorded in manifest'
    Assert-Same $manifest.nodeRuntime.source $node.url 'Official source recorded in manifest'
    $diag | Add-Member NoteProperty mainSha256 (Get-FileHash -LiteralPath (Join-Path $release 'payload/apps/server/dist/main.js')).Hash
    return $diag
}

function Confirm-Task([int]$Id, [string]$Title) {
    $task = Request-Local "/api/v1/tasks/$Id" | ConvertFrom-Json
    Assert-Same $task.task.id $Id 'Preserved task ID'
    Assert-Same $task.task.title $Title 'Preserved task title'
    Assert-Same $task.task.kind 'analysis' 'Preserved task type'
}

function Add-SyntheticTask([int]$Project, [string]$Title) {
    $task = Request-Local '/api/v1/tasks' 'POST' @{
        project_id = $Project; title = $Title; kind = 'analysis'; goal = 'Read-only synthetic installation acceptance'
    } | ConvertFrom-Json
    return $task.id
}

Write-Output "Evidence directory: $run"
Write-Output "Temporary port: $port"
try {
    $null = Invoke-Checked $first @('-InstallRoot', $instance, '-Port', $port)
    $a = Confirm-TS
    $project = Request-Local '/api/v1/projects' 'POST' @{ name = 'Synthetic lifecycle project'; repo_path = $fakeProject } | ConvertFrom-Json
    $firstTask = Add-SyntheticTask $project.id 'Synthetic vA task'
    Confirm-Task $firstTask 'Synthetic vA task'
    Assert-Same ([bool](Test-Path -LiteralPath $a.guide -PathType Leaf)) $true 'Installed user guide'
    Write-Output "PASS actual install $($a.active): main=$($a.mainSha256), PID $($a.pid), SQLite task $firstTask"

    $null = Invoke-Checked $upgrade @('-InstallRoot', $instance)
    $b = Confirm-TS
    Assert-Same $b.previous $a.active 'Rollback target'
    Assert-Same $b.data $a.data 'Persistent data path after upgrade'
    if ($a.mainSha256 -eq $b.mainSha256 -or $a.pid -eq $b.pid) { throw 'Upgrade did not activate a different TS build.' }
    Confirm-Task $firstTask 'Synthetic vA task'
    $secondTask = Add-SyntheticTask $project.id 'Synthetic vB task'
    Confirm-Task $secondTask 'Synthetic vB task'
    Write-Output "PASS real TS upgrade $($b.active): main=$($b.mainSha256), PID $($b.pid), SQLite task $secondTask"

    $failure = Invoke-Checked $bad @('-InstallRoot', $instance) 'Startup failed'
    $failure | Set-Content -LiteralPath (Join-Path $run 'failed-upgrade.txt') -Encoding UTF8
    $restored = Confirm-TS
    Assert-Same $restored.active $b.active 'Restored release'
    Assert-Same $restored.previous $a.active 'Unchanged previous release'
    if ($restored.pid -eq $b.pid) { throw 'The failed candidate did not exercise the restart path.' }
    $failedLog = Get-ChildItem -LiteralPath $restored.logRoot -Directory | Where-Object Name -Match '-stage4-ts-failed-start-'
    $stderr = Join-Path $failedLog.FullName 'stderr.log'
    if (-not (Select-String -LiteralPath $stderr -Pattern 'SyntaxError|Cannot use import')) {
        throw 'The actual TS startup failure was not recorded.'
    }
    Confirm-Task $firstTask 'Synthetic vA task'
    Confirm-Task $secondTask 'Synthetic vB task'
    Write-Output "PASS failed real TS startup, automatic restoration, retained stderr and both tasks"

    $null = Invoke-Checked $manager @('-Action','Rollback')
    $rollback = Confirm-TS
    Assert-Same $rollback.mainSha256 $a.mainSha256 'Actual old code after rollback'
    Confirm-Task $secondTask 'Synthetic vB task'
    $null = Invoke-Checked $manager @('-Action','Rollback')
    Assert-Same (Confirm-TS).mainSha256 $b.mainSha256 'Actual new code after roll forward'
    Write-Output 'PASS explicit rollback and roll forward on one database'

    $null = Invoke-Checked $manager @('-Action','Configure','-CodexMode','Disabled')
    $config = Join-Path $instance 'configuration.json'
    $configHash = (Get-FileHash -LiteralPath $config).Hash
    $unrelated = Join-Path $instance 'releases/keep-personal.txt'
    [IO.File]::WriteAllText($unrelated, 'Unmanaged synthetic file')
    $held = [IO.File]::Open((Join-Path $instance "releases/$($b.active)/release.json"), 'Open', 'Read', 'Read')
    try {
        $null = Invoke-Checked $manager @('-Action','Uninstall') 'Remove-Item'
        Assert-Same (Get-Diagnose).status 'uninstall-incomplete' 'Interrupted uninstall'
        $null = Invoke-Checked $upgrade @('-InstallRoot', $instance) 'Uninstall was interrupted'
    } finally { $held.Dispose() }
    $null = Invoke-Checked $manager @('-Action','Uninstall')
    Assert-Same (Get-Diagnose).status 'uninstalled-data-retained' 'Uninstalled status'
    Assert-Same @(Get-ChildItem -LiteralPath (Join-Path $instance 'releases') -Directory).Count 0 'Managed application directories left'
    Assert-Same ([IO.File]::Exists($unrelated)) $true 'Unmanaged file preserved'
    Assert-Same ([IO.File]::Exists((Join-Path $b.data 'superagent.db'))) $true 'SQLite database preserved'
    Assert-Same (Get-FileHash -LiteralPath $config).Hash $configHash 'Launch configuration preserved'
    Assert-Same ([IO.File]::Exists($stderr)) $true 'Diagnostic log preserved'
    $listeners = [Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
    if ($listeners | Where-Object Port -eq $port) { throw 'The uninstalled instance is still listening.' }
    $null = Invoke-Checked $manager @('-Action','Start') 'There is no active release'
    $null = Invoke-Checked $manager @('-Action','Uninstall')
    Write-Output 'PASS uninstall interruption and retry, managed release removal, retained data and closed port'

    $null = Invoke-Checked $upgrade @('-InstallRoot', $instance)
    $reinstalled = Confirm-TS
    Assert-Same $reinstalled.active $b.active 'Reinstalled release'
    Assert-Same $reinstalled.data $b.data 'Reused data directory after reinstall'
    if ($reinstalled.previous) { throw 'Reinstall must not retain a removed rollback target.' }
    Confirm-Task $firstTask 'Synthetic vA task'
    Confirm-Task $secondTask 'Synthetic vB task'
    Assert-Same (Get-FileHash -LiteralPath $config).Hash $configHash 'Launch configuration after reinstall'
    Write-Output 'PASS reinstall with original port, configuration and both actual TS tasks'
} finally {
    if (Test-Path -LiteralPath $manager -PathType Leaf) {
        $null = Invoke-Checked $manager @('-Action','Stop')
    }
}
