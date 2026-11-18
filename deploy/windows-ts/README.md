# SuperAgent Windows 离线安装

适用 Windows 10/11 x64。运行 `SuperAgent-<版本>-win-x64.exe`，自解压、安装并启动工作台。也可解压同版本 ZIP 后运行 `Install.cmd`。默认安装目录为 `%LOCALAPPDATA%\SuperAgent`，默认地址为 `http://127.0.0.1:18765`。安装使用系统的 .NET Framework 4.x、Windows PowerShell 5.1，以及包内的 Node 24 和已构建工作台。安装过程无需管理员权限、联网或预装 Python、Node、npm。

在普通 PowerShell 中运行安装程序即可保留命令输出。安装默认只使用本机回环地址，采用用户目录文件部署。安装目录的 `README.md` 提供使用说明。

遇到较深的临时目录时，使用自解压 EXE。EXE 用进程内的扩展路径抽取包，无需修改系统长路径设置。Windows 上其他解压工具的路径限制由对应工具决定。

首次安装时可以指定位置和端口。升级从新包运行同一命令，使用原安装位置和端口。

```powershell
.\SuperAgent-0_1_0-win-x64.exe -InstallRoot "$env:LOCALAPPDATA\SuperAgent" -Port 18765
$instance = "$env:LOCALAPPDATA\SuperAgent"
& "$instance\SuperAgent.cmd" -Action Status
& "$instance\SuperAgent.cmd" -Action Diagnose
& "$instance\SuperAgent.cmd" -Action Stop
& "$instance\SuperAgent.cmd" -Action Start
& "$instance\SuperAgent.cmd" -Action Restart
& "$instance\SuperAgent.cmd" -Action Rollback
& "$instance\SuperAgent.cmd" -Action Uninstall
```

命令在当前用户下启动后台进程。工作台地址以命令输出为准。用户登录后可以用 `Start` 启动。发生端口冲突时，先检查占用进程。操作串行执行，`Diagnose` 提供安装位置、当前版本、回滚目标、进程状态和日志目录。程序输出在 `logs\<启动轮次>\stdout.log` 与 `stderr.log`，其中可能包含应用信息。

版本文件在 `releases\<版本>`，业务数据在 `data`。每个版本名对应一份固定的包。升级先验证并暂存文件，再切换，健康检查失败时尝试恢复原先运行的版本。回滚交换当前版和上一版，继续使用当前数据。包的 `DataEpoch` 必须相同，打包方需要验证同代版本之间的双向读写兼容。跨代迁移、Python 数据导入和数据备份恢复由独立流程处理。停止时先请求后端关闭，等待七秒后按需终止进程树。发生强制停止或异常退出后，后端负责恢复状态并保留未知执行结果。

## 升级、回滚与卸载

1. 升级前备份数据时先执行 `Stop`，把 `data` 整目录复制到独立位置。按 [现场记录说明](./field/README.md) 配置了外部附件目录的实例，备份时同时复制该目录。备份保留后先 `Start`，再从新包安装。
2. 升级时运行新 EXE 并指向原 `InstallRoot`。成功后用 `Diagnose` 检查版本和日志。候选未能启动时先查看候选的 `stderr.log`，再查看当前实际运行版本。升级命令仍以失败退出。
3. 手动回滚使用 `Rollback`。成功后两版位置交换，再次执行可切回。程序回滚继续读取当前数据。跨数据代需要明确迁移或从兼容备份恢复。
4. `Uninstall` 停止本实例并移除受管程序版本，保留 `data`、配置、日志、管理命令和说明。若中断，`Diagnose` 显示 `uninstall-incomplete`，再次运行卸载可继续。重新运行相同数据代安装包并使用原目录，即恢复沿用原端口和数据。保留的 Codex 路径和注入变量名继续生效，凭据仍由调用进程提供。

回切旧 Python 服务使用 `PreparePythonRollback` 准备并保留原库，不属于 TS 应用版本回滚。详见随包的 [Python 回切说明](./PYTHON-ROLLBACK.md)。

## 构建

1. 从 Node.js 官网下载 [v24.22.3 Windows x64 ZIP](https://nodejs.org/download/release/v24.22.3/node-v24.22.3-win-x64.zip) 和 [同版本校验清单](https://nodejs.org/download/release/v24.22.3/SHASUMS256.txt)。`Prepare-OfficialNode.ps1` 核对 ZIP 和解出的 `node.exe`，同时提取同包的 `LICENSE`。构建时传入 `-OfficialNodeArchive`，清单记录 ZIP 摘要和来源。仅传运行时目录的包会记录来源为 `operator-supplied`。 [官方发行记录](https://nodejs.org/en/blog/release/v24.22.3)
2. 准备同一前端锁文件安装的 Windows x64 开发依赖，例如提前在依赖已缓存的临时开发目录执行 `npm.cmd ci --offline`。构建脚本在临时副本运行 TypeScript 检查和 Vite 构建。
3. 总控构建 `apps/server/dist/main.js`。从根目录复制 `package*.json` 到独立 `.deps/server-production`，使用已缓存的 Windows x64 npm 依赖执行 `npm.cmd ci --omit=dev --offline`。把根 `package.json` 和该临时目录的 `node_modules` 分别传入。构建输入须是普通文件和目录。依赖工作区包的链接需先展开到构建产物或打进 bundle。

```powershell
$runtime = & .\deploy\windows-ts\Prepare-OfficialNode.ps1 `
  -Archive $nodeZip -Checksums $nodeChecksums -OutputDirectory $newNodeDirectory
& .\deploy\windows-ts\Build-Package.ps1 -Version '0_1_0' `
  -NodeDirectory $runtime.NodeDirectory -NodeSha256 $runtime.NodeSha256 `
  -OfficialNodeArchive $runtime.Archive `
  -WebSource .\apps\web -WebNodeModules $webNodeModules `
  -ServerDist .\apps\server\dist -ServerPackageJson .\.deps\server-production\package.json `
  -ServerNodeModules .\.deps\server-production\node_modules `
  -WindowsJobSha256 $reviewedWindowsJobSha256 `
  -EnablePythonRollback `
  -OutputDirectory $temporaryOutput
```

构建输出自解压 EXE、备用 ZIP 及各自 SHA-256。先通过可信交付记录核对摘要再运行。EXE 使用 `asInvoker` 在当前用户权限下解包到临时目录。包内清单用于检查载荷完整性。命令入口使用单次 PowerShell 执行策略参数，安装不需要修改系统执行策略。EXE 当前未进行代码签名。

开发期 `dev.1` 是安装工程样本。后续候选将已验证的 `windows-job-x64.exe` 摘要传给 `-WindowsJobSha256`，构建验证服务器输出的 `bin/windows-job-x64.exe`，并把该文件纳入包内校验。

在含 `--prepare-python-rollback` 的 TS 构建中传入 `-EnablePythonRollback`，才开放安装器同库回切动作。

## 后端接入契约

工作目录是实例的 `data`。启动使用包内 `payload\apps\server\dist\main.js`，显式注入 `SUPERAGENT_PORT`、`SUPERAGENT_DATA_DIR`、`SUPERAGENT_WEB_DIST` 和已核验的活动版本 `SUPERAGENT_RELEASE_VERSION`。后端绑定 `127.0.0.1`，在可用时由 `GET /health` 返回状态及版本，并同源提供首页、静态文件和 `/api/v1`。后端通过 `SIGTERM` 处理器关闭 HTTP、数据库和本轮子进程。初始配置应关闭外部渠道、模型及执行器。

## Codex 账号和渠道配置

安装后的 `SuperAgent.cmd` 提供配置入口，`Diagnose` 显示已保存的启动模式和本次命令环境中缺失的变量名。用 `Existing` 显式选择已登录账号的目录及其 Codex 可执行文件。配置只保存路径，应用时需要重启。默认 `Disabled`。

```powershell
$manager = "$env:LOCALAPPDATA\SuperAgent\SuperAgent.cmd"
& $manager -Action Configure -CodexMode Existing -CodexExecutable $codexExe -CodexHome $codexAccountDirectory
& $manager -Action Restart
```

已有启动环境可选择 `-CodexMode Environment`。每次启动、重启、升级或回滚都从调用进程取 `SUPERAGENT_CODEX_EXECUTABLE`、`SUPERAGENT_CODEX_HOME` 和 `SUPERAGENT_CODEX_USE_EXISTING_LOGIN=1`。本地执行仍由工作台的调度和审批策略决定，配置命令不测试账号、不启动 Codex。

按量 Codex 使用已验证的本机登录。连接前在管理设置中配置正数的单轮预算预留估算，并确认全局预算可预留。安装器沿用显式选定的已有登录目录，账户是否按量由运行时判定。验收同一工作台的正常安装和 Git 项目绑定可保持 Codex 为 `Disabled`。

先由本机凭据管理工具或调用端把值放入当前 PowerShell 进程，再从同一环境调用管理命令。选中的变量名替换上次选择，需要保留的变量一并列出。缺值时，管理命令会在停服前退出。使用 `-ClearInjectedEnvironment` 清空选择。默认选择为空，安装配置和诊断只保存或显示变量名。

| 用途 | 可选变量 |
| --- | --- |
| 认证、目录和 Redmine | `SUPERAGENT_API_TOKEN`、`SUPERAGENT_USERS_JSON`、`SUPERAGENT_SESSION_SECRET`、`SUPERAGENT_ALLOWED_REPO_ROOTS`、`SUPERAGENT_ATTACHMENTS_ROOT`、`REDMINE_API_KEY` 或其他以 `_REDMINE_API_KEY` 结尾且受支持的大写变量名 |
| Worker 和执行节点 | `SUPERAGENT_CONTEXT_MODE`、`SUPERAGENT_WORKER_MAX_RUN_MS`、`SUPERAGENT_EXECUTION_NODES`、`SUPERAGENT_PROJECT_EXECUTION_NODES`。节点及映射使用 JSON。TS 可展示配置及绑定，远端执行设备仍由冻结 Python 控制器承载 |
| 飞书卡片 | `SUPERAGENT_FEISHU_ENABLED`、`SUPERAGENT_FEISHU_MODE`、`SUPERAGENT_FEISHU_APP_ID`、`SUPERAGENT_FEISHU_APP_SECRET`、`SUPERAGENT_FEISHU_ENCRYPT_KEY`、`SUPERAGENT_FEISHU_OPEN_ID`、`SUPERAGENT_FEISHU_OWNER_ID`、`SUPERAGENT_FEISHU_VERIFICATION_TOKEN`。默认关闭。启用卡片需显式提供 `ENABLED=1` 和 `MODE=card`，并配置应用、收件人及回调凭据 |
| 钉钉 DWS | `DWS_CONFIG_DIR`，可选，指向操作员显式选择的本机 DWS 配置目录 |
| 现场记录 | 见 [可选本机处理](./field/README.md#可选本机处理) |

```powershell
& $manager -Action Configure -InjectEnvironment 'SUPERAGENT_API_TOKEN,SUPERAGENT_SESSION_SECRET'
& $manager -Action Diagnose
& $manager -Action Restart
```

渠道配置可在工作台管理设置操作，或用以下命令把非敏感 JSON 写到已启动的本机服务。Redmine 示例字段为 `enabled`、`base_url`、`user_id`、`api_key_env`。钉钉示例字段为 `enabled`、`profile`、`kind`、`chat_id`。密钥存放在环境变量，JSON 使用 `api_key_env` 保存名字。配置命令可使用当前进程的 `SUPERAGENT_API_TOKEN`，多用户模式可单独由凭据管理器注入管理员的 `SUPERAGENT_CONFIG_TOKEN` 供这一次配置请求使用。

钉钉的 `executable` 使用本机 `dws.exe` 的绝对路径，同时选定 `profile` 和 `self_ids`。服务与子进程默认使用实例私有用户目录，安装器不查找桌面账号。要复用已有 DWS 登录，由操作员显式选择配置目录。以下路径为示例。请把现有选中的其他变量名一并写入 `-InjectEnvironment`。

```powershell
$env:DWS_CONFIG_DIR = 'D:\SuperAgentTools\dws-profile'
& $manager -Action Configure -InjectEnvironment 'DWS_CONFIG_DIR'
& $manager -Action Restart
```

安装器只保存变量名并传入启动进程，只有启用的 DWS 子进程使用该目录。此项依赖渠道子进程接入 `DWS_CONFIG_DIR` 的版本。取消时重新选择所需变量并排除 `DWS_CONFIG_DIR`，或清空选项后重启。避免将目录里的登录文件复制进安装包或验收材料。

```powershell
& $manager -Action ConfigureChannel -Channel redmine -ChannelSettingsPath $redmineSettingsJson
```

工程样本的 TS 可以保存渠道设置，`运行状态` 以 TS 后端返回为准。启用的钉钉或 Redmine 若显示 `unavailable`，表示该版本还没有真实渠道驱动。配置可用与实收实发分别验收。

现场记录的启动选项和历史数据布局见 [现场记录说明](./field/README.md)。

## Git 项目

安装器在 Git for Windows 的登记位置、标准程序目录和用户 Git 安装目录查找 `cmd\git.exe`。发现后仅把该目录加入服务 PATH，保留内置 Node 和系统目录。使用自定义位置时，安装后配置受信任的本机 Git 绝对路径，再重启。

```powershell
& $manager -Action Configure -GitExecutable 'D:\Tools\Git\cmd\git.exe'
& $manager -Action Restart
& $manager -Action Diagnose
```

`launchConfiguration.git` 显示选中的程序与来源。用 `Configure -ClearGitExecutable` 恢复自动查找。Git 缺失时工作台仍可启动，项目分支和多仓配置需在 Git 就绪后使用。Git 配置与 Codex 登录分开。

| 提示 | 检查位置 |
| --- | --- |
| 端口被占用 | `Diagnose` 状态为 `port-in-use`。核对占用者，首次安装到独立位置时可指定 `-Port` |
| Codex 程序或账号目录无效 | `Diagnose` 的 `codexIssues` 列出应补齐的本机程序和目录。执行仍需有效已有登录及工作台授权 |
| 凭据变量缺失 | `missingInjectionNames` 只列变量名。通过凭据管理器向当前进程注入后再启动或升级 |
| TS 或生产依赖启动失败 | `Diagnose` 提供活动版本和日志目录，查看失败轮次的 `stderr.log` |
| OCR／媒体辅助处理不可用 | 现场记录或 API 返回可用状态。基础录入可继续，准备可选 Python 依赖和本机模型后可启用 |

独立用例见 [SCENARIOS.md](./SCENARIOS.md)。本地验收生成临时包和临时数据，使用离线替身，不接触实际服务。
