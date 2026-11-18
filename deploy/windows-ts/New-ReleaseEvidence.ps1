[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$EvidenceRoot,
    [Parameter(Mandatory)][string[]]$Files,
    [Parameter(Mandatory)][string]$OutputZip
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Package.ps1')
$root = (Resolve-Path -LiteralPath $EvidenceRoot).Path.TrimEnd('\')
Assert-PlainPath $root
$target = [IO.Path]::GetFullPath($OutputZip)
Assert-PlainPath (Split-Path -Parent $target)
if ([IO.Path]::GetExtension($target) -ne '.zip' -or (Test-Path -LiteralPath $target)) {
    throw 'Choose a new ZIP path for the evidence.'
}

$inputFiles = [ordered]@{}
foreach ($entry in $Files) {
    $relative = $entry.Replace('\', '/')
    if ($relative -notmatch '^(?:[a-zA-Z0-9][a-zA-Z0-9._-]*/)*[a-zA-Z0-9][a-zA-Z0-9._-]*$') {
        throw "Invalid relative evidence path: $relative"
    }
    $name = [IO.Path]::GetFileName($relative)
    if ($name -cnotin 'REPRODUCE.md', 'SHA256SUMS.txt', 'node-official-SHASUMS256.txt',
        'browser-results.json', 'lifecycle-fingerprints.json', 'source-fingerprints.json', 'installed-fingerprints.json',
        'failed-upgrade.txt' -and $name -notmatch '^(?:desktop|tablet|narrow)-[a-z0-9-]+\.png$' -and
        $name -notmatch '^[a-z0-9][a-z0-9.-]*\.log$') {
        throw "Only selected logs, screenshots, fingerprints, and reproduction instructions are accepted: $relative"
    }
    $path = [IO.Path]::GetFullPath((Join-Path $root $relative))
    if (-not $path.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Evidence path escapes the run directory.' }
    Assert-PlainPath (Split-Path -Parent $path)
    $file = Get-Item -LiteralPath $path
    Assert-PlainItem $file
    if ($file -isnot [IO.FileInfo] -or $inputFiles.Contains($relative)) {
        throw "Duplicate entry or non-file evidence: $relative"
    }
    $inputFiles.Add($relative, $file.FullName)
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$temporary = "$target.$([guid]::NewGuid().ToString('N')).tmp"
try {
    $archive = [IO.Compression.ZipFile]::Open($temporary, [IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($key in $inputFiles.Keys) {
            [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $inputFiles[$key], $key) | Out-Null
        }
    } finally { $archive.Dispose() }
    [IO.File]::Move($temporary, $target)
} finally {
    if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
}
Get-FileHash -LiteralPath $target
