[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Installer,
    [Parameter(Mandatory)][string]$Archive,
    [string]$PreviousInstaller,
    [string]$EvidenceDirectory = ([IO.Path]::GetTempPath())
)
$ErrorActionPreference = 'Stop'
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run the long TEMP acceptance test without administrator elevation.'
}
$exe = (Resolve-Path -LiteralPath $Installer).Path
$run = Join-Path ([IO.Path]::GetFullPath($EvidenceDirectory)) ('long-temp-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$base = Join-Path $run 'temp-root'
$deep = Join-Path $base ('t' * ([Math]::Max(20, 183 - $base.Length)))
[IO.Directory]::CreateDirectory($deep) | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $Archive).Path)
try { $longest = ($zip.Entries | ForEach-Object { $_.FullName.Length } | Measure-Object -Maximum).Maximum }
finally { $zip.Dispose() }
$extractLength = $deep.Length + 1 + 35 + 1 + $longest
if ($extractLength -le 260) { throw 'The test ZIP does not exercise an extraction entry above MAX_PATH.' }
Write-Output "Evidence directory: $run"
Write-Output "TEMP length $($deep.Length), longest extraction path $extractLength, elevated administrator False"

$envBefore = @{ TEMP = $env:TEMP; TMP = $env:TMP }
try {
    if ($PreviousInstaller) {
        $previous = (Resolve-Path -LiteralPath $PreviousInstaller).Path
        $oldTemp = Join-Path $deep 'before'
        [IO.Directory]::CreateDirectory($oldTemp) | Out-Null
        $env:TEMP = $oldTemp
        $env:TMP = $oldTemp
        $ErrorActionPreference = 'Continue'
        $failure = & $previous -InstallRoot (Join-Path $run 'old-install') -Port 0 2>&1 | Out-String
        $code = $LASTEXITCODE
        $ErrorActionPreference = 'Stop'
        $failure | Set-Content -LiteralPath (Join-Path $run 'before.txt') -Encoding UTF8
        if ($code -eq 0 -or $failure -notmatch '260|248|too long') { throw 'Previous installer did not reproduce the path-length failure.' }
        Write-Output 'PASS previous installer reproduced MAX_PATH before starting the service'
    }
    $env:TEMP = $deep
    $env:TMP = $deep
    & (Join-Path $PSScriptRoot 'Test-InstalledServer.ps1') -Installer $exe -EvidenceDirectory $run
    if (@(Get-ChildItem -LiteralPath $deep -Directory -Filter 'sa-*').Count -ne 0) {
        throw 'The repaired installer left its extraction directory.'
    }
    Write-Output 'PASS long TEMP installation, real TS restart/stop and extraction cleanup'
} finally {
    $env:TEMP = $envBefore.TEMP
    $env:TMP = $envBefore.TMP
}
