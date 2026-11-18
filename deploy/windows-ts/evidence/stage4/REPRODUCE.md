# 阶段 4 命令与证据

本目录保留 [生命周期输出](./lifecycle-run.txt)、[配置与缺依赖验证输出](./configuration-run.txt)、[候选失败记录](./failed-upgrade.txt)、[候选 stderr](./failed-start.stderr.txt)、[官方 SHA-256 清单](./SHASUMS256.txt) 与 [本次 18 项摘要索引](./SHA256SUMS.stage4)。安装包、运行时和能复验的临时输入仍位于 `deploy/windows-ts/.artifacts`。摘要索引的相对路径均以 `deploy/windows-ts` 为根。

以下命令从仓库根运行。它们重建工程验收包，使用新输出目录，构建输入取留存的两份 TS 产物及对应模块配置。已经验收的二进制以摘要索引为准，后续前端源码、依赖和打包时间会影响重建结果。正式版本等待最终集成 SHA。

```powershell
$windows = (Resolve-Path '.\deploy\windows-ts').Path
$artifacts = Join-Path $windows '.artifacts'
$stage = Join-Path $artifacts 'stage4'
$official = Join-Path $artifacts 'node-official'
$officialUrl = 'https://nodejs.org/download/release/v24.22.3'
$zip = Join-Path $official 'node-v24.22.3-win-x64.zip'
$checksums = Join-Path $official 'SHASUMS256.txt'
[IO.Directory]::CreateDirectory($official) | Out-Null

# 已留存 ZIP 和清单时直接复用。
if (-not (Test-Path -LiteralPath $zip -PathType Leaf)) {
    curl.exe --proto '=https' --fail --location --output $zip "$officialUrl/node-v24.22.3-win-x64.zip"
    if ($LASTEXITCODE -ne 0) { throw 'Node 下载失败' }
}
if (-not (Test-Path -LiteralPath $checksums -PathType Leaf)) {
    curl.exe --proto '=https' --fail --location --output $checksums "$officialUrl/SHASUMS256.txt"
    if ($LASTEXITCODE -ne 0) { throw '官方校验清单下载失败' }
}
$newRun = [guid]::NewGuid().ToString('N')
$nodeDir = Join-Path $official "runtime-$newRun"
$runtime = & (Join-Path $windows 'Prepare-OfficialNode.ps1') `
    -Archive $zip -Checksums $checksums -OutputDirectory $nodeDir

$sets = @(
    @{ Version='stage4-ts-a'; StageDist='prior/payload/apps/server/dist'; StageManifest='server.json' },
    @{ Version='stage4-ts-b'; StageDist='current-dist'; StageManifest='server.json' },
    @{ Version='stage4-ts-failed-start'; StageDist='current-dist'; StageManifest='broken-server.json' }
)
$output = Join-Path $stage "packages-rebuild-$newRun"
$webModules = 'E:\Workspace\Workspace\Project\SuperAgentDemo\apps\web\node_modules'
$serverModules = (Resolve-Path '.\.deps\server-production\node_modules').Path
foreach ($set in $sets) {
    & (Join-Path $windows 'Build-Package.ps1') -Version $set.Version `
        -NodeDirectory $runtime.NodeDirectory -NodeSha256 $runtime.NodeSha256 -OfficialNodeArchive $runtime.Archive `
        -WebSource (Resolve-Path '.\apps\web').Path -WebNodeModules $webModules `
        -ServerDist (Join-Path $stage $set.StageDist) -ServerPackageJson (Join-Path $stage $set.StageManifest) `
        -ServerNodeModules $serverModules -WindowsJobSha256 '425CD705D1FB3B5E2D47ABA00C50145A890A9F664861A0274F2682AC60EFE1BC' `
        -OutputDirectory $output
}
```

实际验收命令见 [阶段 4 报告](../../STAGE4.md)。单独复验配置与缺依赖提示可执行下列命令。这两项测试自动分配独立高位端口。

```powershell
$stage = (Resolve-Path '.\deploy\windows-ts\.artifacts\stage4').Path
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\deploy\windows-ts\Test-InstalledServer.ps1 `
    -Installer (Join-Path $stage 'packages/SuperAgent-stage4-ts-b-win-x64.exe') `
    -EvidenceDirectory $stage -CheckConfiguration -CheckFieldDependencyHint
```
