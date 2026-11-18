# Windows RC2 构建与验收

使用总控确认的完整 SHA。冻结树中的 `apps/server/src/server.ts` 应读取 `SUPERAGENT_RELEASE_VERSION`，DWS 子进程应只转发显式选中的 `DWS_CONFIG_DIR`。所有验收实例使用临时目录和随机本机高位端口，渠道保持关闭。

## 构建 Windows x64 安装件

在仓库根目录启动 `powershell.exe -NoProfile -ExecutionPolicy Bypass` 后运行以下命令。设置 `$frozenSha`，依赖目录可换成本机按冻结锁文件安装的目录。包默认命名为 `0_2_0-rc2-<SHA前7位>`。验收专用故障包使用同一冻结树的真实 TS 载荷和安装管理脚本，将服务端模块类型改为 CommonJS 以触发启动失败。故障包保留在独立目录。

```powershell
$windows = (Resolve-Path '.\deploy\windows-ts').Path
$artifacts = Join-Path $windows '.artifacts'
$work = Join-Path $artifacts 'rc2'
$original = 'E:\Workspace\Workspace\Project\SuperAgentDemo'
$webModules = Join-Path $original 'apps/web/node_modules'
$approvedJobSha256 = '425CD705D1FB3B5E2D47ABA00C50145A890A9F664861A0274F2682AC60EFE1BC'
$options = @{
    Commit = $frozenSha
    WorkDirectory = $work
    ArchivePython = Join-Path $original '.venv/Scripts/python.exe'
    OfficialNodeZip = Join-Path $artifacts 'node-official/node-v24.22.3-win-x64.zip'
    OfficialNodeChecksums = Join-Path $artifacts 'node-official/SHASUMS256.txt'
    DevNodeModules = (Resolve-Path 'node_modules').Path
    ProductionNodeModules = (Resolve-Path '.deps/server-production/node_modules').Path
    WebNodeModules = $webModules
    WindowsJobSha256 = $approvedJobSha256
    IncludeFailureProbe = $true
}
$buildLog = Join-Path $artifacts 'rc2-build.log'
& (Join-Path $windows 'Build-FrozenCandidate.ps1') @options 2>&1 | Tee-Object $buildLog
```

构建工具在新路径解包 Git archive 并运行冻结树的构建脚本。它核对官方摘要、Git 源码树、锁文件、Windows Job、打包入口，并检查 EXE 内嵌 ZIP 与单发 ZIP 的摘要。分发文件和 `SHA256SUMS.txt` 位于 `packages`。

## 验收实际安装程序

```powershell
$source = Get-Content (Join-Path $work 'source-fingerprints.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$rc1Archive = Join-Path $artifacts 'rc1-30bceac'
$rc1 = Join-Path $rc1Archive 'packages/SuperAgent-0_2_0-rc1-30bceac-win-x64.exe'
$rc2 = Join-Path $work "packages/SuperAgent-$($source.version)-win-x64.exe"
$rc2Zip = Join-Path $work "packages/SuperAgent-$($source.version)-win-x64.zip"
$badVersion = 'rc2-failure-probe-' + $source.commit.Substring(0, 7)
$bad = Join-Path $work "failure-probe/SuperAgent-$badVersion-win-x64.exe"
$node = Join-Path $work 'node/node.exe'
$git = (Get-Command git.exe).Source
$run = Join-Path $work 'acceptance'
[IO.Directory]::CreateDirectory($run) | Out-Null
$rc1Hash = 'F501896C0A38D2F93E5B534C313F1D39E81768757DAAE3933AA929DA301F2FF3'
if ((Get-FileHash -LiteralPath $rc1).Hash -ne $rc1Hash) { throw 'Unexpected RC1 installer' }
Copy-Item -LiteralPath $buildLog -Destination (Join-Path $run 'build.log')

$browser = @{
    Installer = $rc2
    BrowserNode = $node
    WebNodeModules = $webModules
    EvidenceDirectory = $run
    CheckField = $true
    CheckFieldDependencyHint = $true
    CheckReleaseVersion = $true
}
& (Join-Path $windows 'Test-InstalledServer.ps1') @browser 2>&1 | Tee-Object (Join-Path $run 'browser.log')
& (Join-Path $windows 'Test-InstalledGit.ps1') -Installer $rc2 -GitExecutable $git -EvidenceDirectory $run -CheckDwsConfigDirectory 2>&1 |
    Tee-Object (Join-Path $run 'git-dws.log')
& (Join-Path $windows 'Test-LongTemp.ps1') -Installer $rc2 -Archive $rc2Zip -EvidenceDirectory $run 2>&1 |
    Tee-Object (Join-Path $run 'long-temp.log')

$lifecycle = @{
    FirstInstaller = $rc1
    UpgradeInstaller = $rc2
    FailingInstaller = $bad
    FailingRelease = $badVersion
    FirstMainSha256 = 'C0D328C0C21916DF046CBB42319AF9B1C6273A04DFDD4AEA8009C295AF5EBA27'
    UpgradeMainSha256 = $source.entrySha256
    CheckUpgradeHealthVersion = $true
    EvidenceDirectory = $run
}
& (Join-Path $windows 'Test-TSLifecycle.ps1') @lifecycle 2>&1 | Tee-Object (Join-Path $run 'lifecycle.log')
```

生命周期比对 RC1、RC2 实装入口和实际 Node 进程，覆盖升级、启动失败恢复、手动回滚与切回、保留数据卸载和重装。RC1 的健康响应仍可报告开发版本，RC2 必须报告自身安装版本。

## 生成可复制的证据 ZIP

证据 ZIP 与安装件分开交接。以下清单只挑选日志、截图、指纹和复现说明。临时安装目录、SQLite、运行时、故障探针、账户目录和原始源码归档都留在本机验收目录。

```powershell
foreach ($path in 'source-fingerprints.json', 'node-official-SHASUMS256.txt', 'packages/SHA256SUMS.txt') {
    Copy-Item -LiteralPath (Join-Path $work $path) -Destination $run
}
Copy-Item -LiteralPath (Join-Path $windows 'RC2-REPRODUCE.md') -Destination (Join-Path $run 'REPRODUCE.md')
$browserResult = @(Get-ChildItem -LiteralPath $run -Directory -Filter 'superagent-ts-*')
$lifeResult = @(Get-ChildItem -LiteralPath $run -Directory -Filter 'ts-life-*')
if ($browserResult.Count -ne 1 -or $lifeResult.Count -ne 1) { throw 'Use a new acceptance directory for each full run.' }
$evidence = @(
    'REPRODUCE.md', 'SHA256SUMS.txt', 'source-fingerprints.json', 'node-official-SHASUMS256.txt',
    'build.log', 'browser.log', 'git-dws.log', 'long-temp.log', 'lifecycle.log',
    "$($browserResult[0].Name)/browser-results.json",
    "$($lifeResult[0].Name)/lifecycle-fingerprints.json",
    "$($lifeResult[0].Name)/failed-upgrade.txt",
    "$($lifeResult[0].Name)/failed-start.stderr.log"
)
$evidence += Get-ChildItem -LiteralPath $browserResult[0].FullName -File -Filter '*.png' |
    ForEach-Object { "$($browserResult[0].Name)/$($_.Name)" }
$evidenceZip = Join-Path $work "SuperAgent-$($source.version)-evidence.zip"
& (Join-Path $windows 'New-ReleaseEvidence.ps1') -EvidenceRoot $run -Files $evidence -OutputZip $evidenceZip
```
