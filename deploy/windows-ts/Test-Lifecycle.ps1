[CmdletBinding()]
param(
    [Parameter(Mandatory, ParameterSetName='Build')][string]$NodeDirectory,
    [Parameter(Mandatory, ParameterSetName='Build')][string]$NodeSha256,
    [Parameter(Mandatory, ParameterSetName='Build')][string]$WebNodeModules,
    [Parameter(Mandatory, ParameterSetName='Reuse')][string]$PackageDirectory,
    [string]$WebSource,
    [string]$EvidenceDirectory = ([IO.Path]::GetTempPath())
)
$ErrorActionPreference = 'Stop'
if (-not $WebSource) { $WebSource = Join-Path $PSScriptRoot '../../.rewrite-oracle/apps/web' }
$scratch = Join-Path ([IO.Path]::GetFullPath($EvidenceDirectory)) ('superagent-test-' + [guid]::NewGuid().ToString('N'))
$base = Join-Path $scratch ('User ' + [char]0x6D4B + [char]0x8BD5)
$instance = Join-Path $base 'Local AppData/SuperAgent'
$manager = Join-Path $instance 'SuperAgent.cmd'
$pkgDir = Join-Path $scratch 'packages'
[IO.Directory]::CreateDirectory($base) | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Invoke-CommandCheck([string]$Cmd, [string[]]$Arguments, [string]$ExpectError = '') {
    $ErrorActionPreference = 'Continue'
    $lines = & $Cmd @Arguments 2>&1
    $code = $LASTEXITCODE
    $result = $lines | Out-String
    if ($ExpectError) {
        if ($code -eq 0 -or $result -notmatch $ExpectError) { throw "Expected '$ExpectError', exit $code. $result" }
    } elseif ($code -ne 0) { throw "Command failed, exit $code. $result" }
    return $result
}

function Assert-Equal($Actual, $Expected, [string]$Label) {
    if ($Actual -cne $Expected) { throw "$Label expected '$Expected', got '$Actual'." }
}

function New-TestKit([string]$Version, [int]$DataEpoch = 1, [bool]$Fail = $false) {
    $kit = Join-Path $scratch "$Version-kit"
    if ($PackageDirectory) {
        $products = Get-FileHash -LiteralPath (Join-Path $PackageDirectory "SuperAgent-$Version-win-x64.exe"), (Join-Path $PackageDirectory "SuperAgent-$Version-win-x64.zip")
    } else {
        $server = Join-Path $scratch "$Version-server"
        $dist = Join-Path $server 'dist'
        [IO.Directory]::CreateDirectory($dist) | Out-Null
        [IO.File]::WriteAllText((Join-Path $server 'package.json'), '{"type":"commonjs"}')
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'tests/fixture.cjs') -Destination (Join-Path $dist 'main.js')
        [IO.File]::WriteAllText((Join-Path $dist 'fixture.json'), (@{ version = $Version; fail = $Fail } | ConvertTo-Json))
        $products = & (Join-Path $PSScriptRoot 'Build-Package.ps1') -Version $Version -NodeDirectory $NodeDirectory `
            -NodeSha256 $NodeSha256 -WebNodeModules $WebNodeModules -WebSource $WebSource -ServerDist $dist `
            -DataEpoch $DataEpoch -OutputDirectory $pkgDir | ForEach-Object {
            if ($_ -is [string]) { Write-Host $_ } else { $_ }
        }
    }
    foreach ($product in $products) { Write-Host "$($product.Hash)  $($product.Path)" }
    $zip = $products | Where-Object { $_.Path -like '*.zip' }
    $exe = $products | Where-Object { $_.Path -like '*.exe' }
    [IO.Compression.ZipFile]::ExtractToDirectory($zip.Path, $kit)
    @{ exe = $exe.Path; cmd = (Join-Path $kit 'Install.cmd'); kit = $kit }
}

function Get-Http([string]$Path = '/health', [string]$Method = 'GET') {
    $request = [Net.WebRequest]::Create("http://127.0.0.1:$port$Path")
    $request.Proxy = $null
    $request.Timeout = 2000
    $request.Method = $Method
    if ($Method -eq 'POST') { $request.ContentLength = 0 }
    $response = $request.GetResponse()
    try {
        $reader = [IO.StreamReader]::new($response.GetResponseStream())
        try { $reader.ReadToEnd() } finally { $reader.Dispose() }
    } finally { $response.Dispose() }
}

$port = $null
for ($attempt = 0; $attempt -lt 20 -and -not $port; $attempt++) {
    $candidate = Get-Random -Minimum 49152 -Maximum 65536
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $candidate)
    try { $listener.Start(); $port = $candidate } catch [Net.Sockets.SocketException] {
        # Retry if the OS has already reserved this candidate.
    } finally { $listener.Stop() }
}
if (-not $port) { throw 'Could not allocate a temporary high port.' }
$env:SUPERAGENT_TEST_INHERITED = 'marker'
Write-Output "Evidence directory: $scratch"
Write-Output "Temporary port: $port"
try {
    $first = New-TestKit 'fixture-v1'
    $second = New-TestKit 'fixture-v2'
    $broken = New-TestKit 'fixture-broken' 1 $true
    $incompatible = New-TestKit 'fixture-next-epoch' 2

    $null = Invoke-CommandCheck $first.exe @('-InstallRoot', $instance, '-Port', $port)
    $initial = Invoke-CommandCheck $manager @('-Action', 'Diagnose') | ConvertFrom-Json
    Assert-Equal $initial.status 'running' 'First install'
    Assert-Equal $initial.data (Join-Path $instance 'data') 'Isolated data directory'
    $health = Get-Http | ConvertFrom-Json
    Assert-Equal $health.version 'fixture-v1' 'Packaged entry'
    Assert-Equal $health.pid $initial.pid 'Readiness process'
    if ($health.node -notmatch '^v24\.') { throw 'Bundled Node 24 was not used.' }
    $index = Get-Http '/'
    $scriptPath = [regex]::Match($index, 'src="(/assets/[^"]+)"').Groups[1].Value
    if (-not $scriptPath -or -not (Get-Http $scriptPath).Contains(([char]0x73B0).ToString() + [char]0x573A + [char]0x8BB0 + [char]0x5F55)) {
        throw 'Field Intake strings are missing from the served build.'
    }
    $null = Get-Http '/field-timeline.example.json' | ConvertFrom-Json
    Assert-Equal ((Get-Http '/fixture-counter' 'POST' | ConvertFrom-Json).value) 1 'First write'
    Write-Output "PASS install, diagnostics, bundled $($health.node), React and Field Intake asset"

    $null = Invoke-CommandCheck $first.cmd @('-InstallRoot', $instance, '-Port', $port)
    Assert-Equal ((Get-Http | ConvertFrom-Json).pid) $initial.pid 'Repeated install'
    $null = Invoke-CommandCheck $manager @('-Action', 'Restart')
    if ((Get-Http | ConvertFrom-Json).pid -eq $initial.pid) { throw 'Restart reused original PID.' }
    Assert-Equal ((Get-Http '/fixture-counter' 'POST' | ConvertFrom-Json).value) 2 'Restart persistence'
    $null = Invoke-CommandCheck $manager @('-Action', 'Stop')
    Assert-Equal ((Invoke-CommandCheck $manager @('-Action', 'Status') | ConvertFrom-Json).status) 'stopped' 'Stop'

    $blocker = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $port)
    $blocker.Start()
    try {
        $null = Invoke-CommandCheck $manager @('-Action', 'Start') 'already in use'
        Assert-Equal ((Invoke-CommandCheck $manager @('-Action', 'Status') | ConvertFrom-Json).status) 'port-in-use' 'Port conflict'
        $client = [Net.Sockets.TcpClient]::new()
        try { $client.Connect([Net.IPAddress]::Loopback, $port) } finally { $client.Dispose() }
    } finally { $blocker.Stop() }
    $lock = [IO.File]::Open((Join-Path $instance 'operation.lock'), 'Open', 'ReadWrite', 'None')
    try { $null = Invoke-CommandCheck $manager @('-Action', 'Start') 'Cannot lock' } finally { $lock.Dispose() }
    $null = Invoke-CommandCheck $manager @('-Action', 'Start')
    Write-Output 'PASS repeat install, restart, persistence, stop, foreign listener and concurrent lock'

    $originalPid = (Get-Http | ConvertFrom-Json).pid
    $corruptFile = Join-Path $second.kit 'payload/apps/server/dist/fixture.json'
    $originalFile = [IO.File]::ReadAllBytes($corruptFile)
    try {
        [IO.File]::AppendAllText($corruptFile, 'damaged')
        $null = Invoke-CommandCheck $second.cmd @('-InstallRoot', $instance) 'payload verification failed'
        Assert-Equal ((Get-Http | ConvertFrom-Json).pid) $originalPid 'Corrupt upgrade left service running'
    } finally { [IO.File]::WriteAllBytes($corruptFile, $originalFile) }
    $null = Invoke-CommandCheck $incompatible.exe @('-InstallRoot', $instance) 'Incompatible data generation'
    Assert-Equal ((Get-Http | ConvertFrom-Json).pid) $originalPid 'Incompatible upgrade left service running'
    $null = Invoke-CommandCheck $second.exe @('-InstallRoot', $instance)
    Assert-Equal ((Get-Http | ConvertFrom-Json).version) 'fixture-v2' 'Upgrade'
    Assert-Equal ((Get-Http '/fixture-counter' 'POST' | ConvertFrom-Json).value) 3 'Upgrade persistence'
    $null = Invoke-CommandCheck $manager @('-Action', 'Rollback')
    Assert-Equal ((Get-Http | ConvertFrom-Json).version) 'fixture-v1' 'Rollback'
    Assert-Equal ((Get-Http '/fixture-counter' 'POST' | ConvertFrom-Json).value) 4 'Rollback persistence'
    $null = Invoke-CommandCheck $manager @('-Action', 'Rollback')
    Assert-Equal ((Get-Http | ConvertFrom-Json).version) 'fixture-v2' 'Roll forward'
    Write-Output 'PASS upgrade, downgrade, roll forward, corrupt package and incompatible data generation'

    $null = Invoke-CommandCheck $broken.exe @('-InstallRoot', $instance, '-StartupSeconds', '3') 'Startup failed'
    Assert-Equal ((Get-Http | ConvertFrom-Json).version) 'fixture-v2' 'Automatic restoration'
    $details = Invoke-CommandCheck $manager @('-Action', 'Diagnose') | ConvertFrom-Json
    Assert-Equal $details.active 'fixture-v2' 'Persistent active version'
    $brokenLog = Get-ChildItem -LiteralPath $details.logRoot -Directory -Filter '*-fixture-broken-*' | Select-Object -First 1
    if (-not (Select-String -LiteralPath (Join-Path $brokenLog.FullName 'stderr.log') -SimpleMatch 'fixture startup failure')) {
        throw 'Failed candidate did not retain stderr.'
    }
    Assert-Equal ((Get-Http '/fixture-counter' 'POST' | ConvertFrom-Json).value) 5 'Failure recovery persistence'
    Write-Output 'PASS failed activation, restored previous health, retained diagnostic log and data'
} finally {
    if (Test-Path -LiteralPath $manager) { $null = Invoke-CommandCheck $manager @('-Action', 'Stop') }
    Remove-Item Env:SUPERAGENT_TEST_INHERITED -ErrorAction SilentlyContinue
}
