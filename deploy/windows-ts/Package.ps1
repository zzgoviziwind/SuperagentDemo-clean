function Assert-ReleaseName([string]$Name) {
    if ($Name -cnotmatch '^[a-z0-9][a-z0-9_-]{0,63}$') { throw "Invalid release name: $Name" }
}

function Assert-PlainItem($Item) {
    if ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "Links are not supported here: $($Item.FullName)"
    }
}

function Assert-PlainPath([string]$Path) {
    $directory = [IO.DirectoryInfo]::new([IO.Path]::GetFullPath($Path))
    while ($directory) {
        if ($directory.Exists) { Assert-PlainItem $directory }
        $directory = $directory.Parent
    }
}

function Get-TreeFiles([string]$Directory) {
    foreach ($item in Get-ChildItem -LiteralPath $Directory -Force) {
        Assert-PlainItem $item
        if ($item.PSIsContainer) {
            Get-TreeFiles $item.FullName
        } else {
            $item
        }
    }
}

function Get-PayloadHashes([string]$Directory) {
    Assert-PlainPath $Directory
    $prefix = [IO.Path]::GetFullPath($Directory).TrimEnd('\') + '\'
    Get-TreeFiles $Directory | ForEach-Object {
        [ordered]@{
            path = $_.FullName.Substring($prefix.Length).Replace('\', '/')
            sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
        }
    } | Sort-Object { $_.path }
}

function Read-Release([string]$Directory) {
    Assert-PlainPath $Directory
    $manifestPath = Join-Path $Directory 'release.json'
    Assert-PlainItem (Get-Item -LiteralPath $manifestPath -Force)
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert-ReleaseName $manifest.version
    if ($manifest.format -ne 1 -or $manifest.dataEpoch -cnotmatch '^[1-9][0-9]{0,8}$' -or
        $manifest.node -cnotmatch '^v24\.[0-9]+\.[0-9]+$' -or $manifest.platform -cne 'win32-x64') {
        throw "Unsupported package: $Directory"
    }
    foreach ($relative in 'runtime/node.exe', 'runtime/LICENSE', 'runtime/launch.cjs', 'apps/server/dist/main.js', 'apps/web/dist/index.html', 'apps/web/dist/field-timeline.example.json') {
        $file = Get-Item -LiteralPath (Join-Path $Directory "payload/$relative") -Force
        if ($file.PSIsContainer) { throw "Missing package file: $relative" }
        Assert-PlainItem $file
    }
    return $manifest
}

function Confirm-Payload([string]$Payload, $Files) {
    $actual = @(Get-PayloadHashes $Payload)
    $expected = @($Files | Sort-Object { $_.path })
    if ($actual.Count -ne $expected.Count) { throw 'Package payload file count differs from the manifest.' }
    for ($index = 0; $index -lt $actual.Count; $index++) {
        if ($actual[$index].path -cne $expected[$index].path -or $actual[$index].sha256 -ne $expected[$index].sha256) {
            throw "Package payload verification failed: $($actual[$index].path)"
        }
    }
}

function Confirm-Release([string]$Directory) {
    $manifest = Read-Release $Directory
    Confirm-Payload (Join-Path $Directory 'payload') $manifest.files
    return $manifest
}
