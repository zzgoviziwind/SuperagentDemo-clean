[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidatePattern('^[a-fA-F0-9]{7,40}$')][string]$Commit,
    [Parameter(Mandatory)][string]$WorkDirectory,
    [Parameter(Mandatory)][string]$ArchivePython,
    [Parameter(Mandatory)][string]$OfficialNodeZip,
    [Parameter(Mandatory)][string]$OfficialNodeChecksums,
    [Parameter(Mandatory)][string]$DevNodeModules,
    [Parameter(Mandatory)][string]$ProductionNodeModules,
    [Parameter(Mandatory)][string]$WebNodeModules,
    [Parameter(Mandatory)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$WindowsJobSha256,
    [string]$Version,
    [switch]$IncludeFailureProbe
)
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSEdition -ne 'Desktop' -or $PSVersionTable.PSVersion -lt [version]'5.1') {
    throw 'Run the frozen build with Windows PowerShell 5.1 (powershell.exe).'
}
. (Join-Path $PSScriptRoot 'Package.ps1')
$repository = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$sha = git -C $repository rev-parse --verify "${Commit}^{commit}"
if ($LASTEXITCODE -ne 0 -or $sha -cnotmatch '^[a-f0-9]{40}$') { throw 'Cannot resolve the requested frozen commit.' }
if (-not $Version) { $Version = '0_2_0-rc2-' + $sha.Substring(0, 7) }
Assert-ReleaseName $Version
$work = [IO.Path]::GetFullPath($WorkDirectory)
Assert-PlainPath $work
if (Test-Path -LiteralPath $work) { throw "Choose a new short work directory: $work" }
$python = (Resolve-Path -LiteralPath $ArchivePython).Path
$dev = (Resolve-Path -LiteralPath $DevNodeModules).Path
$production = (Resolve-Path -LiteralPath $ProductionNodeModules).Path
$web = (Resolve-Path -LiteralPath $WebNodeModules).Path
$archive = Join-Path $work 'source.tar'
$source = Join-Path $work 'src'
$scripts = Join-Path $source 'deploy/windows-ts'
$products = Join-Path $work 'packages'
[IO.Directory]::CreateDirectory($work) | Out-Null

git -C $repository archive --format=tar --output=$archive $sha
if ($LASTEXITCODE -ne 0) { throw 'Git archive failed.' }
# Python preserves UTF-8 names when extracting on Windows.
& $python -IB -X utf8 -c 'import sys,tarfile; a=tarfile.open(sys.argv[1],encoding=''utf-8''); a.extractall(sys.argv[2],filter=''data''); a.close()' $archive $source
if ($LASTEXITCODE -ne 0) { throw 'Could not extract the frozen source.' }

$verify = Join-Path $scripts 'Verify-WebDependencies.cjs'
$lock = Join-Path $source 'package-lock.json'
$runtime = & (Join-Path $scripts 'Prepare-OfficialNode.ps1') -Archive $OfficialNodeZip -Checksums $OfficialNodeChecksums -OutputDirectory (Join-Path $work 'node')
$node = Join-Path $runtime.NodeDirectory 'node.exe'
foreach ($dir in $dev, $production) {
    & $node $verify $lock $dir
    if ($LASTEXITCODE -ne 0) { throw 'Preinstalled server dependencies differ from the frozen lock.' }
}
& (Join-Path ([Environment]::SystemDirectory) 'robocopy.exe') $dev (Join-Path $source 'node_modules') /E /XJ /R:0 /W:0 /NFL /NDL /NJH /NJS /NP
if ($LASTEXITCODE -ge 8) { throw 'Could not stage the verified development dependencies.' }
Push-Location -LiteralPath $source
try {
    & $node 'node_modules/typescript/bin/tsc' -p 'apps/server/tsconfig.json'
    if ($LASTEXITCODE -ne 0) { throw 'Server typecheck failed.' }
    & $node 'deploy/rewrite/build.mjs'
    if ($LASTEXITCODE -ne 0) { throw 'Server bundle failed.' }
} finally { Pop-Location }

$dist = Join-Path $source 'apps/server/dist'
$applicationPackage = Join-Path $source 'package.json'
$build = @{
    Version = $Version
    WebSource = Join-Path $source 'apps/web'
    WebNodeModules = $web
    ServerDist = $dist
    ServerPackageJson = $applicationPackage
    ServerNodeModules = $production
    NodeDirectory = $runtime.NodeDirectory
    NodeSha256 = $runtime.NodeSha256
    OfficialNodeArchive = $runtime.Archive
    WindowsJobSha256 = $WindowsJobSha256
    EnablePythonRollback = $true
    OutputDirectory = $products
}
& (Join-Path $scripts 'Build-Package.ps1') @build
if ($IncludeFailureProbe) {
    # Keep the real frozen TS payload and force an ESM boot failure in a separate kit.
    $failure = Get-Content -LiteralPath $applicationPackage -Raw -Encoding UTF8 | ConvertFrom-Json
    $failure.type = 'commonjs'
    $failureJson = Join-Path $work 'failure-package.json'
    [IO.File]::WriteAllText($failureJson, ($failure | ConvertTo-Json -Depth 10))
    $build.Version = 'rc2-failure-probe-' + $sha.Substring(0, 7)
    $build.ServerPackageJson = $failureJson
    $build.OutputDirectory = Join-Path $work 'failure-probe'
    & (Join-Path $scripts 'Build-Package.ps1') @build
}

$trees = @(git -C $repository ls-tree $sha -- apps/server apps/web deploy/windows-ts)
if ($LASTEXITCODE -ne 0 -or $trees.Count -ne 3) { throw 'Could not record source tree fingerprints.' }
$index = [ordered]@{
    commit = $sha
    version = $Version
    sourceArchiveSha256 = (Get-FileHash -LiteralPath $archive).Hash
    sourceTrees = $trees
    entrySha256 = (Get-FileHash -LiteralPath (Join-Path $dist 'main.js')).Hash
    serverLockSha256 = (Get-FileHash -LiteralPath $lock).Hash
    webLockSha256 = (Get-FileHash -LiteralPath (Join-Path $source 'apps/web/package-lock.json')).Hash
    node = $runtime.Version
    nodeSource = $runtime.Source
    nodeArchiveSha256 = $runtime.ArchiveSha256
    nodeSha256 = $runtime.NodeSha256
    windowsJobSha256 = $WindowsJobSha256.ToUpperInvariant()
}
$exe = Join-Path $products "SuperAgent-$Version-win-x64.exe"
$zip = Join-Path $products "SuperAgent-$Version-win-x64.zip"
$resource = [Reflection.Assembly]::LoadFile($exe).GetManifestResourceStream('SuperAgent.Package')
if (-not $resource) { throw 'Missing embedded installer ZIP.' }
try { $embedded = (Get-FileHash -InputStream $resource).Hash } finally { $resource.Dispose() }
if ($embedded -ne (Get-FileHash -LiteralPath $zip).Hash) { throw 'Embedded ZIP differs from the released ZIP.' }
$index.embeddedZipSha256 = $embedded
$index | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $work 'source-fingerprints.json') -Encoding UTF8
Get-FileHash -LiteralPath $exe,$zip | ForEach-Object { "$($_.Hash)  $(Split-Path -Leaf $_.Path)" } |
    Set-Content -LiteralPath (Join-Path $products 'SHA256SUMS.txt') -Encoding ASCII
Copy-Item -LiteralPath $OfficialNodeChecksums -Destination (Join-Path $work 'node-official-SHASUMS256.txt')
Write-Output "Frozen candidate $Version built from $sha"
