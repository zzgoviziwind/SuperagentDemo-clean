[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Archive,
    [Parameter(Mandatory)][string]$Checksums,
    [Parameter(Mandatory)][string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Package.ps1')
. (Join-Path $PSScriptRoot 'Node24.ps1')
$expected = Get-OfficialNode24
$resolved = (Resolve-Path -LiteralPath $Archive).Path
$checksumLines = Get-Content -LiteralPath $Checksums -Encoding UTF8
foreach ($entry in @(
    @{ name = $expected.archive; hash = $expected.archiveSha256 },
    @{ name = 'win-x64/node.exe'; hash = $expected.nodeSha256 }
)) {
    $pattern = '^([a-fA-F0-9]{64})\s+\*?' + [regex]::Escape($entry.name) + '\s*$'
    $lines = @($checksumLines | Select-String -Pattern $pattern)
    if ($lines.Count -ne 1 -or $lines[0].Matches[0].Groups[1].Value -ne $entry.hash) {
        throw "Official checksum entry missing or different: $($entry.name)"
    }
}
Assert-OfficialNodeArchive $resolved $expected

$target = [IO.Path]::GetFullPath($OutputDirectory)
Assert-PlainPath $target
if (Test-Path -LiteralPath $target) { throw "Choose a new output directory: $target" }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($resolved)
try {
    [IO.Directory]::CreateDirectory($target) | Out-Null
    $prefix = $expected.archive.Replace('.zip', '') + '/'
    foreach ($file in 'node.exe', 'LICENSE') {
        $entry = $zip.GetEntry($prefix + $file)
        if (-not $entry) { throw "Node archive is missing $file" }
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $target $file), $false)
    }
    $node = Join-Path $target 'node.exe'
    if ((Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash -ne $expected.nodeSha256) {
        throw 'Extracted Node executable SHA-256 mismatch.'
    }
    $identity = & $node -p 'process.version + String.fromCharCode(32) + process.platform + String.fromCharCode(45) + process.arch'
    if ($LASTEXITCODE -ne 0 -or $identity -cne "$($expected.version) win32-x64") { throw 'Unexpected Node executable identity.' }
    [pscustomobject]@{
        NodeDirectory = $target
        NodeSha256 = $expected.nodeSha256
        Archive = $resolved
        ArchiveSha256 = $expected.archiveSha256
        Version = $identity
        Source = $expected.url
    }
} finally { $zip.Dispose() }
