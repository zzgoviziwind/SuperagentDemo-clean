[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Version,
    [Parameter(Mandatory)][string]$NodeDirectory,
    [Parameter(Mandatory)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$NodeSha256,
    [Parameter(Mandatory)][string]$WebNodeModules,
    [Parameter(Mandatory)][string]$OutputDirectory,
    [string]$WebSource,
    [string]$ServerDist,
    [string]$ServerNodeModules,
    [string]$ServerPackageJson,
    [string]$OfficialNodeArchive,
    [switch]$EnablePythonRollback,
    [ValidatePattern('^[a-fA-F0-9]{64}$')][string]$WindowsJobSha256,
    [ValidateRange(1, 999999999)][int]$DataEpoch = 1
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Package.ps1')
. (Join-Path $PSScriptRoot 'Node24.ps1')
Assert-ReleaseName $Version

$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
if (-not $WebSource) { $WebSource = Join-Path $repo 'apps/web' }
if (-not $ServerDist) { $ServerDist = Join-Path $repo 'apps/server/dist' }
$WebSource = [IO.Path]::GetFullPath($WebSource)
$ServerDist = [IO.Path]::GetFullPath($ServerDist)
if (-not $ServerPackageJson) {
    $adjacent = Join-Path (Split-Path -Parent $ServerDist) 'package.json'
    if (Test-Path -LiteralPath $adjacent -PathType Leaf) { $ServerPackageJson = $adjacent }
    if (-not $ServerPackageJson -and $ServerDist -eq (Join-Path $repo 'apps/server/dist')) {
        $ServerPackageJson = Join-Path $repo 'package.json'
    }
}
$node = Join-Path ([IO.Path]::GetFullPath($NodeDirectory)) 'node.exe'
$license = Join-Path (Split-Path -Parent $node) 'LICENSE'
$null = Get-Item -LiteralPath $license
if ((Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash -ne $NodeSha256) { throw 'Node executable SHA-256 mismatch.' }
$runtime = & $node -p 'process.version + String.fromCharCode(32) + process.platform + String.fromCharCode(45) + process.arch'
if ($LASTEXITCODE -ne 0 -or $runtime -cnotmatch '^(v24\.[0-9]+\.[0-9]+) win32-x64$') {
    throw 'Provide Node 24 for Windows x64.'
}
$nodeVersion = $Matches[1]
$nodeRuntime = [ordered]@{ source = 'operator-supplied'; nodeSha256 = $NodeSha256.ToUpperInvariant() }
if ($OfficialNodeArchive) {
    $expected = Get-OfficialNode24
    Assert-OfficialNodeArchive $OfficialNodeArchive $expected
    if ($nodeVersion -ne $expected.version -or $NodeSha256 -ne $expected.nodeSha256) {
        throw 'The packaged executable differs from the verified official Node release.'
    }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $OfficialNodeArchive).Path)
    try {
        $entry = $archive.GetEntry($expected.archive.Replace('.zip', '') + '/LICENSE')
        if (-not $entry) { throw 'Node archive is missing LICENSE.' }
        $stream = $entry.Open()
        try {
            if ((Get-FileHash -InputStream $stream -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $license -Algorithm SHA256).Hash) {
                throw 'Packaged LICENSE differs from the official archive.'
            }
        } finally { $stream.Dispose() }
    } finally { $archive.Dispose() }
    $nodeRuntime = [ordered]@{ source = $expected.url; archiveSha256 = $expected.archiveSha256; nodeSha256 = $expected.nodeSha256 }
}
if (-not (Test-Path -LiteralPath (Join-Path $ServerDist 'main.js') -PathType Leaf)) { throw "Missing compiled server entry point: $ServerDist/main.js" }
if ($EnablePythonRollback -and -not (Select-String -LiteralPath (Join-Path $ServerDist 'main.js') -Pattern '--prepare-python-rollback' -SimpleMatch -Quiet)) {
    throw 'The compiled server does not contain the Python rollback CLI.'
}
if ($WindowsJobSha256) {
    $job = Join-Path $ServerDist 'bin/windows-job-x64.exe'
    if (-not (Test-Path -LiteralPath $job -PathType Leaf) -or
        (Get-FileHash -LiteralPath $job -Algorithm SHA256).Hash -ne $WindowsJobSha256) {
        throw 'Compiled Windows Job helper is missing or differs from the expected SHA-256.'
    }
}
foreach ($file in 'src/FieldIntake.tsx', 'src/FieldTranscript.tsx', 'public/field-timeline.example.json', 'package-lock.json') {
    if (-not (Test-Path -LiteralPath (Join-Path $WebSource $file) -PathType Leaf)) { throw "Use the frozen Field Intake workbench. Missing: $file" }
}
$dependencies = [IO.Path]::GetFullPath($WebNodeModules)
$lockHash = (Get-FileHash -LiteralPath (Join-Path $WebSource 'package-lock.json')).Hash
& $node (Join-Path $PSScriptRoot 'Verify-WebDependencies.cjs') (Join-Path $WebSource 'package-lock.json') $dependencies
if ($LASTEXITCODE -ne 0) { throw 'Installed web dependencies do not match the build lockfile.' }

function Copy-Tree([string]$Source, [string]$Destination) {
    # Robocopy retains dotfiles and long paths. Reject links instead of silently losing files.
    Assert-PlainPath $Source
    Get-TreeFiles $Source | Out-Null
    & (Join-Path ([Environment]::SystemDirectory) 'robocopy.exe') $Source $Destination /E /XJ /R:0 /W:0 /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "Could not copy $Source to $Destination (robocopy $LASTEXITCODE)." }
}

$output = [IO.Path]::GetFullPath($OutputDirectory)
Assert-PlainPath $output
[IO.Directory]::CreateDirectory($output) | Out-Null
$zip = Join-Path $output "SuperAgent-$Version-win-x64.zip"
$exe = Join-Path $output "SuperAgent-$Version-win-x64.exe"
foreach ($file in $zip, $exe) {
    if (Test-Path -LiteralPath $file) { throw "Output already exists: $file" }
}
$scratch = Join-Path ([IO.Path]::GetTempPath()) ('superagent-package-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($scratch) | Out-Null
try {
    $web = Join-Path $scratch 'web'
    [IO.Directory]::CreateDirectory($web) | Out-Null
    foreach ($item in Get-ChildItem -LiteralPath $WebSource -Force) {
        if ($item.Name -in 'dist', 'node_modules', '.git', 'playwright-report', 'test-results') { continue }
        Assert-PlainItem $item
        $destination = Join-Path $web $item.Name
        if ($item.PSIsContainer) {
            Copy-Tree $item.FullName $destination
        } elseif ($item.Name -notlike '.env*') {
            Copy-Item -LiteralPath $item.FullName -Destination $destination
        }
    }
    Copy-Tree $dependencies (Join-Path $web 'node_modules')
    Push-Location -LiteralPath $web
    try {
        & $node 'node_modules/typescript/bin/tsc' --noEmit
        if ($LASTEXITCODE -ne 0) { throw 'Workbench typecheck failed.' }
        & $node 'node_modules/vite/bin/vite.js' build
        if ($LASTEXITCODE -ne 0) { throw 'Workbench build failed.' }
    } finally { Pop-Location }

    $kit = Join-Path $scratch 'kit'
    $payload = Join-Path $kit 'payload'
    $versionRuntime = Join-Path $payload 'runtime'
    $versionServer = Join-Path $payload 'apps/server'
    [IO.Directory]::CreateDirectory($versionRuntime) | Out-Null
    Copy-Item -LiteralPath $node, $license -Destination $versionRuntime
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'launch.cjs') -Destination $versionRuntime
    Copy-Tree $ServerDist (Join-Path $versionServer 'dist')
    $fieldHelpers = Join-Path $versionServer 'dist/field-helpers'
    [IO.Directory]::CreateDirectory($fieldHelpers) | Out-Null
    foreach ($file in 'field_ocr.py', 'field_media_worker.py') {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot "field/$file") -Destination $fieldHelpers
    }
    if ($ServerNodeModules) { Copy-Tree ([IO.Path]::GetFullPath($ServerNodeModules)) (Join-Path $versionServer 'node_modules') }
    if ($ServerPackageJson) { Copy-Item -LiteralPath $ServerPackageJson -Destination (Join-Path $versionServer 'package.json') }
    Copy-Tree (Join-Path $web 'dist') (Join-Path $payload 'apps/web/dist')
    foreach ($file in 'Install.cmd', 'SuperAgent.cmd', 'SuperAgent.ps1', 'Package.ps1', 'Configuration.ps1', 'PythonRollback.ps1', 'README.md', 'PYTHON-ROLLBACK.md') {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination $kit
    }
    $fieldGuide = Join-Path $kit 'field'
    [IO.Directory]::CreateDirectory($fieldGuide) | Out-Null
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'field/README.md') -Destination $fieldGuide
    $manifest = [ordered]@{
        format = 1
        version = $Version
        dataEpoch = $DataEpoch
        node = $nodeVersion
        nodeRuntime = $nodeRuntime
        features = @(if ($EnablePythonRollback) { 'python-rollback' })
        platform = 'win32-x64'
        webLockSha256 = $lockHash
        files = @(Get-PayloadHashes $payload)
    }
    [IO.File]::WriteAllText((Join-Path $kit 'release.json'), ($manifest | ConvertTo-Json -Depth 5))
    $null = Read-Release $kit
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $packageZip = Join-Path $scratch 'payload.zip'
    $packageExe = Join-Path $scratch 'setup.exe'
    [IO.Compression.ZipFile]::CreateFromDirectory($kit, $packageZip)
    $framework = Join-Path $env:SystemRoot 'Microsoft.NET/Framework64/v4.0.30319'
    & (Join-Path $framework 'csc.exe') /nologo /target:exe /optimize+ /platform:x64 "/out:$packageExe" `
        "/win32manifest:$(Join-Path $PSScriptRoot 'Installer.manifest')" "/resource:$packageZip,SuperAgent.Package" `
        "/reference:$(Join-Path $framework 'System.IO.Compression.dll')" `
        "/reference:$(Join-Path $framework 'System.IO.Compression.FileSystem.dll')" `
        (Join-Path $PSScriptRoot 'Installer.cs')
    if ($LASTEXITCODE -ne 0) { throw 'Windows self-extracting installer build failed.' }
    [IO.File]::Copy($packageZip, $zip)
    [IO.File]::Copy($packageExe, $exe)
    Get-FileHash -LiteralPath $exe, $zip -Algorithm SHA256
} finally {
    Remove-Item -LiteralPath $scratch -Recurse -Force
}
