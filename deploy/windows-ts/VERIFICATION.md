# Windows 安装及现场记录验收

验收日期 2026-11-18。起始基线为 `7b7587d14399659d7951d3e195af863514fbf118`，分支为 `codex/typescript-windows-rewrite`。工作台以冻结快照 `abf0a6922e8da03d65cd53458df256a509d824c3fbf276f58943cc800201b091` 为依据。现场记录新增的能力提示和媒体禁用说明沿用原组件与样式。安装、启动、诊断映射见 [SCENARIOS.md](./SCENARIOS.md)。

## 样本

| 文件 | SHA-256 |
| --- | --- |
| `SuperAgent-0_2_0-field-integration-sample2-win-x64.exe` | `2000186C7DEDE6D4F5916183D94C4319247642D1C9D594FD3936F631C7BB277E` |
| `SuperAgent-0_2_0-field-integration-sample2-win-x64.zip` | `E3099E1B8577F1C81B069181A3BF65674C9BA25ADE2D596F318AE7195FB7330E` |
| 包内 `apps/server/dist/bin/windows-job-x64.exe` | `425CD705D1FB3B5E2D47ABA00C50145A890A9F664861A0274F2682AC60EFE1BC` |
| 包内 `apps/server/dist/main.js` | `539219645BBBA36A469940AB847AF22539418D2779047208E242DDD0ECE3467C` |

以上是离线工程样本，位于 `.artifacts/actual/packages`。使用总控准备的 `.deps/server-production/package.json` 与该目录下的 `node_modules`。Field Intake 试包在临时目录构建 TS 服务时添加 `registerField(app, store, root, env)` 注册，临时入口构建脚本为 `.artifacts/build-field-isolated.cjs`。包内 Job helper 摘要与 `packages/windows-job` 专项交付件一致，专门的子进程树故障验收由该专项提供。

`sample2` 把现场记录说明加入包内，已核对 3,725 个应用载荷文件与两轮 Edge 使用的 `sample` 逐项同摘要。最终 EXE 在端口 `61494` 再次通过安装、实际 TS 首页与资源、原 SQLite 目录重启和停止。证据目录为 `.artifacts/superagent-ts-7438423fb6ed4def96f5bb44ca955dfb`。

Windows x64 Node 为 `v24.22.1`，取自本机 Codex 附带的运行时，同目录提供许可证。

```text
C:\Users\examp\AppData\Local\OpenAI\Codex\runtimes\cua_node\bfa21d187eb00b05\bin\node.exe
SHA-256 67B13BFCF43036EADCB38749F369CD8E41BF0FE9B1D751DD1AEAAC5F8BDD14B8
```

该文件摘要与 [Node.js 官网同版本发行清单](https://nodejs.org/download/release/v24.22.1/SHASUMS256.txt) 所列的 `win-x64/node.exe` 不同。正式分发应从已核验的发行来源准备运行时并重做包校验。

## 复验命令

```powershell
$windows = '.\deploy\windows-ts'
$evidence = (Resolve-Path "$windows\.artifacts").Path
$node = 'C:\Users\examp\AppData\Local\OpenAI\Codex\runtimes\cua_node\bfa21d187eb00b05\bin\node.exe'
$nodeHash = (Get-FileHash -LiteralPath $node).Hash
$webModules = 'E:\Workspace\Workspace\Project\SuperAgentDemo\apps\web\node_modules'
$env:TEMP = $evidence
$env:TMP = $evidence

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$windows\Test-Lifecycle.ps1" `
  -NodeDirectory (Split-Path -Parent $node) -NodeSha256 $nodeHash `
  -WebNodeModules $webModules -EvidenceDirectory $evidence

$setup = Join-Path $evidence 'actual/packages/SuperAgent-0_2_0-field-integration-sample2-win-x64.exe'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$windows\Test-InstalledServer.ps1" `
  -Installer $setup -EvidenceDirectory $evidence -BrowserNode $node `
  -WebNodeModules $webModules -CheckField -CheckConfiguration

& $node .\node_modules\typescript\bin\tsc -p .\apps\server\tsconfig.json
& $node .\node_modules\vitest\vitest.mjs run --no-cache --config .\vitest.config.ts apps/server/src/field
```

## 结果

- 自解压 EXE 和备用 ZIP 在带空格与中文的临时安装路径运行。离线替身复验通过首次及重复安装、健康检查、应用静态资源、重启和持久化、停止、占用端口保护、操作锁、损坏包拒绝、同数据代升级与回滚、跨数据代拒绝，以及失败升级后恢复旧版并保留日志。证据目录 `.artifacts/superagent-test-54bf98fa2e63468fbee34e06da8afa3c`，端口 `55375`。
- 未接入 Field 路由的 `dev.1-install-sample` 使用端口 `55380`、`49924` 完成两轮实际 React 浏览。事件中心、项目抽屉、Worker 导航正常，现场记录和旧项目选择暴露接口 404。该版本的管理命令在被调用方捕获标准输出时会阻塞，已改用隐藏的独立进程和包内日志输出。配置样本复验实际 TS 重启、SQLite 目录复用、认证变量注入、脱敏诊断、保存禁用的合成 Redmine 配置和停止均通过，端口 `49965`。
- 含 Field 注册的安装样本使用 Edge `157.0.4341.60`。独立两轮端口为 `61280` 和 `58603`，桌面 `1440×1000`、平板 `1024×900`、窄屏 `390×844` 每轮均通过。实际 TS 提供时间轴导入、原始转写、候选审核和只读任务。视口无横向溢出，转写与项目抽屉 Esc 后焦点回到触发键。每轮查看桌面现场记录、平板转写和窄屏转写截图。证据目录为 `.artifacts/superagent-ts-dc60ad96279743c9bb0971bfb2b12f06` 和 `.artifacts/superagent-ts-d0d1357a93bc46369db49b2f06712bf4`，含 15 张截图及 `browser-results.json`。
- Field API 4 项通过。覆盖迁移旧记录和受管截图、截图校验、旧媒体分段读取、权限、时间轴、并发幂等审核、关联版本检查、实施审批闸门和合成后台媒体队列。媒体入队、抽帧接口、输出入库使用合成处理器。两个固定 Python 脚本通过语法检查。
- 隔离预览的早期端口探测曾由系统分配到 `8838` 和 `8839`。后续正式验收显式使用 `49152–65535`，未复用现有服务。

## 尚待验收

- 本机为 Windows x64 `10.0.26200`，通过普通用户临时目录复验。系统已有 Edge、开发依赖和 Node 来源。尚缺全新虚拟机或独立 Windows 用户的安装复验、签名及终端策略验收。
- 总控合入 `registerField` 后需从正式构建入口重打候选。批准实施使用同轮核验摘要和只读证据，已用旧格式合成证据验收。TS Worker 通过实际只读分析产出该证明的端到端链路仍需验收。
- 尚缺真实 Codex 登录、真实渠道收发和真实 OCR/语音模型验证。示例包使用合成数据，验收端口发布后已停止。频道配置只是持久配置和状态读取。没有操作真实数据库或发布安装包。
