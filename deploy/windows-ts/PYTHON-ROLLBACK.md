# 从已停止的 TypeScript 回切 Python

确认使用冻结的 Python 版本和已准备的独立 Python 运行环境。先在工作台停用调度、自动投递、模型自动路由及渠道连接，再停止 TS。处理结果未知的任务与投递需要对账。

在普通 PowerShell 中运行。默认安装路径如下，自定义目录使用实际 `InstallRoot`。

```powershell
$manager = "$env:LOCALAPPDATA\SuperAgent\SuperAgent.cmd"
& $manager -Action Stop
if ($LASTEXITCODE -ne 0) { throw '停止 TypeScript 失败' }
$report = & $manager -Action PreparePythonRollback
if ($LASTEXITCODE -ne 0) { throw '数据预检或恢复失败，请运行 Diagnose 查看日志' }
$handoff = $report | ConvertFrom-Json
$handoff
```

此动作要求 TS 已停止并且本实例端口已释放。它在本实例操作锁内，用随包 Node 调用 `main.js --prepare-python-rollback`，检查 SQLite、创建并校验备份，并由后端处理重启恢复。命令输出工作数据库位置、备份位置及需要人工对账的任务和投递编号。成功后 `Diagnose` 的状态为 `python-rollback-prepared`，安装器阻止从同目录启动、升级、回滚或卸载 TS。旧包缺少预检入口时会提示依赖，保留现有数据。

命令失败或中断时先查看诊断目录中的 `stderr.log` 和 `stdout.json`，核对备份和预检进程。只有成功返回 `prepared: true` 才继续启动 Python。

## 用原 SQLite 启动冻结 Python

在冻结 Python 代码根目录启动。以下命令用回切报告中的原 SQLite 文件和原端口。先确认该环境没有注入实际渠道或 Codex 凭据，工作台里的自动处理与外部渠道配置均已停用。附件和工作区使用本实例原有目录，若单独配置过附件根目录，使用当时的路径。

```powershell
$diagnose = & $manager -Action Diagnose | ConvertFrom-Json
$data = Split-Path -Parent $handoff.database
$port = ([uri]$diagnose.url).Port
$env:SUPERAGENT_DATABASE_URL = 'sqlite:///' + $handoff.database.Replace('\', '/')
$env:SUPERAGENT_ATTACHMENTS_ROOT = Join-Path $data 'attachments'
$env:SUPERAGENT_WORKSPACES_ROOT = Join-Path $data 'workspaces'
$env:SUPERAGENT_CODEX_HOME = Join-Path $data 'codex-state'
$env:SUPERAGENT_FEISHU_ENABLED = '0'
& $pythonExe -B -m uvicorn superagent.main:app --host 127.0.0.1 --port $port
```

`$pythonExe` 是已准备环境的 Python 可执行文件。查看 `/health` 和已有任务，核对报告列出的未知结果后再决定是否恢复实际处理。

## 取消回切或返回 TS

确认所有使用该 SQLite 的 Python 进程和预检进程均已退出。安装器可核验其记录的进程和本实例端口，其他端口上访问同一数据库的进程由操作者确认。

```powershell
& $manager -Action ReleasePythonRollback -ConfirmPythonStopped
if ($LASTEXITCODE -ne 0) { throw '释放 Python 回切预留失败' }
& $manager -Action Start
```
