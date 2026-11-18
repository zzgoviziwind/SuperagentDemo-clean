# Operations v3 接入契约

## 总控需集成

- main.py 导入 `superagent.api.operations.router` 并 include_router。`OperationsService` 在 lifespan 启动/关闭，启动时建本模块表。daemon 入口 `python -m superagent.runtime.daemon`。
- 节点白名单通过环境变量配置，项目选择与 Watchdog 设置通过持久 API 管理。`SUPERAGENT_EXECUTION_NODES` 是本机配置 JSON 数组，每项含 id、token_env、project_ids、roots。token_env 指向环境变量名，秘密不写配置响应。节点必须能访问与控制端同绝对路径的受管工作区及项目文件（共享卷）。模型在 daemon 节点运行，工作区隔离、证据收集与最终测试继续由控制服务执行。
- `SUPERAGENT_PROJECT_EXECUTION_NODES` 是项目 ID 到节点 ID 的 JSON 字典。未绑定项目继续本地 Codex；显式绑定但离线会 waiting_resource，不回退本机。
- daemon 使用 `SUPERAGENT_CONTROL_URL`、`SUPERAGENT_NODE_ID`、`SUPERAGENT_NODE_TOKEN`、`SUPERAGENT_DAEMON_ROOTS`（JSON 数组）、`SUPERAGENT_CODEX_EXECUTABLE`。远端地址要求 HTTPS，本机回环允许 HTTP。固定 app-server，禁止远端提供任意可执行文件或 shell。
- `GET /api/v1/operations/nodes` 管理员读取节点状态。`POST /api/v1/operations/daemon/poll` 和 `/exchange` 使用独立节点凭据与时钟/nonce 防重放，不使用 Web 用户身份。main 中间件若统一鉴权需对这两个入口放行，由入口自身认证。
- Watchdog 默认关闭。设置 `watchdog_enabled` 启用独立周期服务，`watchdog_interval_seconds` 默认 60 秒，`SUPERAGENT_WATCHDOG_TIMEOUT` 默认 240 秒，可通过该环境变量覆盖。模型使用独立只读 Codex 会话，沿用模型、effort、预算预留。结论持久化。只允许 observe/needs_human/pause 动作，暂停复用 scheduler 的任务锁和 stop_run，禁止未知执行自动恢复。
- `GET /api/v1/operations/watchdog` 管理员读取持久结论。

## 验收范围

双进程 loopback 与真实任务入口已通过离线协议验收。真实跨机器设备暂无可用环境。总控已完成一次真实 Codex 模型 Watchdog 验收，结果见文末记录；自动暂停与失败保护通过可注入 Reviewer 验证。

## 已落地 API 与持久配置（供总控/前端立即接入）

- 导出 `superagent.api.operations.operations` 单例，lifespan `await operations.start()` / `await operations.close()`；`router` 同模块。start 建新表并将上次 queued/leased 标记 unknown，同时将 running Watchdog 标记 unknown，不重放。
- `GET /api/v1/operations/nodes` → `{items:[{id,project_ids,roots,online,last_seen,shared_workspace_required:true}],bindings:[{project_id,node_id}]}`。节点由环境白名单配置注册，daemon 首次主动 poll 建持久心跳。
- `PATCH /api/v1/operations/projects/{project_id}/execution-node {node_id:string|null}`，持久选择，null 为本机。运行中或尚有旧 Codex 线程的未结束任务禁止切换，避免在线迁移执行上下文。
- `GET /api/v1/operations/watchdog?task_id=` → `{items:[{id,task_id,state_version,status,thread_id,turn_id,evidence,conclusion,correction,created_at}]}`，包含独立模型会话标识及完整输入证据。conclusion 含 action/reason/applied。
- `POST /api/v1/operations/watchdog/tasks/{task_id}/run` 立即执行一次，返回 `{run_id}`。超时默认240秒，记录 unknown。TimeoutError 或 UnknownOutcome 返回 HTTP 409，detail 含原因、巡检记录 ID 和 `/api/v1/operations/watchdog?task_id=` 查询路径。
- `POST /api/v1/operations/watchdog/{run_id}/messages {content,reconcile_unknown:false}` 保存纠正说明，下一次巡检输入引用。reconcile_unknown=true 可附核验证据解除巡检未知保护，保留旧输入/结论。并不恢复 Worker 未知写入。
- 采用总控新增的 `watchdog_enabled`、`watchdog_interval_seconds` 持久 Setting。请总控加入 governance 设置校验，默认 false/60。运行中设置每轮读取。
- 新表由本模块创建，无旧表破坏性迁移。execution_nodes、execution_nonces、execution_operations、execution_events、execution_runtime_sessions、project_execution_nodes、watchdog_runs。
- daemon POST 使用 X-Node-Id/Time/Nonce/Signature，HMAC-SHA256 覆盖时间、nonce、URL path、原始body。60秒时钟窗口、唯一nonce持久防重放。仅 daemon 两入口绕过Web统一认证，入口本身独立认证。

## 集成顺序与补充

总控请把 `await operations.start()` 放在 `await scheduler.start()` 之前，避免恢复阶段把刚派发的节点租约标记为上次未知。main 原有 init_db() 先执行。

总控已完成该启动顺序调整，本会话读取当前 main.py 核实。

设备心跳 last_seen 已使用 UTC ISO8601。Watchdog GET 同时返回 enabled 与 interval_seconds，可直接绑定设置界面。

新增 execution_runtime_sessions 表，每会话30秒执行租约，控制端读取运行事件时每5秒续租。daemon 每次主动poll核对授权会话，租约失效或控制服务重启后终止旧客户端，不恢复旧轮次。旧操作保留 unknown。

巡检拒绝模型原生工具活动、动态工具和审批请求。自动暂停经过任务版本栅栏，停止未确认/失败会标记巡检 unknown 与任务 outcome_unknown，并保存真实结论。人工纠正会持续进入后续巡检输入。

## 真实模型 smoke 修正，已可由总控新任务复验

已核对独立 Codex 会话 `01a1d80d-36c8-7452-a781-db0391381306` 的本机保存记录，只发现用户输入后的 item_completed 与 turn_aborted，尚无助手答复或工具执行。确认原先白名单遗漏 userMessage，导致巡检错误中止。现已允许 userMessage、agentMessage、reasoning、plan、contextCompaction；工具活动仍拒绝。新增 WatchdogReviewError 仅保存本模块生成的脱敏协议诊断（method/item_type/status），通用外部异常继续只记录类型，避免输出凭据。旧 unknown 记录保留，未重放。总控可对新任务执行 review 验证。

## 本会话完成验证

- `.venv/Scripts/python.exe -m pytest tests/integration/test_execution_nodes.py tests/integration/test_watchdog.py tests/runtime/test_daemon.py -q --basetemp=.pytest-operations-v3-final --tb=short` → 15 passed（新增真实 userMessage 回归前）。
- 真实模型兼容修正后 `.venv/Scripts/python.exe -m pytest tests/integration/test_watchdog.py -q --basetemp=.pytest-watchdog-final --tb=short` → 8 passed，包括 userMessage 接受、commandExecution 拒绝。
- 较早含现有 API / 只读分析的回归 → 18 passed，唯一警告来自现有 Starlette/httpx 弃用提示。
- 双进程验证启动真实 loopback HTTP 控制服务、主动拉取 daemon 进程与离线 Codex 子进程，经过创建会话、启动轮次、审批回传、完成事件、关闭。另一个用真实 SuperAgent main 及正常任务创建入口，持久绑定 selected-daemon，完成 analysis 到 review_ready 并断言实际读取证据与 execution_node_selected。未使用真实渠道与业务数据。
- 普通受限运行首次遇到系统临时目录不可写，未计为通过；后续指定项目内隔离临时目录，并以允许本机回环的执行环境完成测试。

## 局限与交付边界

- 远端执行当前依赖同绝对路径共享目录；异构文件系统路径映射、仓库复制、产物传输尚未实现。项目路径白名单和节点本机根目录均核验。
- daemon 发生连接/确认错误后退出并关闭客户端，已领取的操作保留未知；由操作者检查原因并重新启动 daemon，旧写入不会自动重放。
- 节点白名单/根目录/秘密环境变量引用通过服务环境管理，界面可选择已有授权节点并启停 Watchdog；未提供任意公网命令执行入口。
- SQLite 单进程控制器为本轮验证范围，未验收 PostgreSQL 多控制器并发。
- 未提交 Git、未部署、未向真实外部渠道发送内容。源码只修改本会话分配文件。

## 总控真实模型复验已通过

2026-11-14 已读取 `.test-tmp/v3-real-model/watchdog-result.json` 核对。新任务 task_id=2，独立 Watchdog run `2f7e6db9985d4c05a391f5045ce386ef`，thread `01a1d814-91dc-7eb3-8f5a-b83e491f9e04`，turn `01a1d814-983b-7d51-b7cf-df0a28ec0b23`，status=completed，action/applied=observe。模型基于已路由、仍排队且尚无执行产物的实际证据给出继续观察结论。该验证覆盖真实模型输入、独立会话、结构化结论与持久化；跨机器执行与真实模型自动暂停仍分别按前述验收范围记录。

本次收尾仅更新交接记录。全量后端回归由总控继续检查。

## 真实模型等待时长与手动接口异常修正

真实模型复验耗时超过原默认等待值，默认 `SUPERAGENT_WATCHDOG_TIMEOUT` 已调整为240秒，继续支持环境变量覆盖。超时或 Codex UnknownOutcome 先持久化 unknown，再返回携带 run_id 的 WatchdogOutcomeUnknown；手动执行 API 捕获后返回 HTTP 409，detail 包含明确原因、记录 ID 和任务巡检查询路径，便于核验与纠正。

最终单模块回归 `.venv/Scripts/python.exe -m pytest tests/integration/test_watchdog.py -q --basetemp=.pytest-watchdog-timeout-final --tb=short` → 13 passed，覆盖默认240秒、环境覆盖、实际等待超时取消、unknown持久化、HTTP409定位记录、原生工具拒绝与停止失败保护。唯一警告仍为现有 Starlette/httpx 弃用提示。
