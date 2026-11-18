function Get-OfficialNode24 {
    @{
        version = 'v24.22.3'
        archive = 'node-v24.22.3-win-x64.zip'
        url = 'https://nodejs.org/download/release/v24.22.3/node-v24.22.3-win-x64.zip'
        checksums = 'https://nodejs.org/download/release/v24.22.3/SHASUMS256.txt'
        archiveSha256 = 'E612AF99F626AB415EA225AF6BCE5C971FEB448CB5CAE250BB1C3FA50C5F7D9F'
        nodeSha256 = '86FC4785327DB5F5C7558DC6156C543B433C313E813A222E088086222AB4AFA6'
    }
}

function Assert-OfficialNodeArchive([string]$Archive, $Expected) {
    if ((Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash -ne $Expected.archiveSha256) {
        throw "Official Node archive SHA-256 mismatch: $($Expected.archive)"
    }
}
