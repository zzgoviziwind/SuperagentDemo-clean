# Worker 执行协调交接

`index.ts` 导出 `registerWorker(app, store, lease, root, env): WorkerControls`。总控在 `app.ready()` 前注册，须提供已启动的控制器租约和独占绝对状态目录。`stop(taskId)` 只在确认 Job 内执行进程退出时返回 `true`。`steer(taskId, content)` 只向当前绑定轮次发送已持久化的下一条补充消息，收到相同 turn ID 的确认后推进消息游标。控制入口负责更新任务围栏。轮次完成时存在未确认补充消息会保留未知。续跑使用同一来源、用途、项目配置和隔离目录的已核实 thread，可从不同子进程读取既有会话。缺少可信工作区绑定的历史 thread 需要人工核对。

| 路由 | 入参 | 决定依据 |
| --- | --- | --- |
| `POST /api/v1/approvals/:id/decision` | `decision`, `action_hash` | Owner 或管理员，当前 repair 尝试、请求和 thread/turn 绑定，审批前核对版本、路径、配额。只在收到同轮确认后结束审批。 |
| `POST /api/v1/tasks/:id/acceptance` | `accepted`, `revision`, `comment?` | 当前版本的同轮证据和已完成尝试。repair/analysis 在验收前重新读取工作区状态，变化返回 409。 |
| `POST /api/v1/tasks/:id/reconcile` | `outcome`, `evidence`, `expected_state_version` | Owner 或管理员，当前版本、未知任务、无该任务的活动执行，必须填写已停止或放弃的人工证据。 |
| `GET /api/v1/agents/local` | 无 | 管理员。未选择时只枚举候选程序，已有选择的诊断仅使用已固定的程序和登录目录。 |
| `POST /api/v1/agents/local/connect` | `agent_id: codex`, `use_existing_login: true` | 管理员显式执行。程序与登录目录由 Host 发现并写入 `local_agent_selection`。启用调度前检查已有订阅或按量预算。 |
| `GET /api/v1/projects/:id/reference-projects` | 无 | 管理员查看当前项目明确选定的参考项目 ID 和已启用候选。 |
| `PUT /api/v1/projects/:id/reference-projects` | `{ "project_ids": [2, 8] }` | 管理员配置 `projects` 模式。空数组关闭额外项目，`null` 恢复冻结版的已启用项目范围。 |

`settings.scheduler_enabled` 控制领任务。`SUPERAGENT_DRIVER=fixture` 选择离线驱动并禁用真实登录。本机驱动须已有授权选择。`SUPERAGENT_CONTEXT_MODE=decisions` 调用 `assembleContext`，先持久清单再派发。默认 legacy 不创建清单。`SUPERAGENT_WORKER_MAX_RUN_MS` 为绝对期限，单位毫秒，默认 240000，自领取尝试计时，涵盖工作区准备、协议、等待审批和证据核对。等待审批让出执行槽，派发决定前重新校验槽位、期限和当前围栏。

`verification` 产物通过 `attempt_id` 与 `summary`、必要时的 `changes` 关联，并绑定 thread、turn、来源和项目配置指纹。`offline-codex-fixture` 产物仅在夹具模式可验收。多仓按配置的本地分支逐仓锁定提交，保留项目相对位置，克隆副本不使用硬链接。修复拒绝脏源仓，分析只读取指定提交的副本。配置项目的 repair 需通过路径白名单、Git 差异及管理员验证命令。`test_command` 使用带绝对本机可执行文件的 JSON 参数数组。Host 核对验证前后的工作区，手工验收再取一次。analysis 的 Host 读取范围限于独立工作区内受限文本，内容摘要与结构化报告路径、无变更证据绑定。reply 禁用工具。真实订阅仅记录 `model.plan_run`，按量任务有估算及预留才派发，费用待核对。夹具调用无真实费用预留。

远端绑定由 `assignedNode()` 统一判定。历史表和 `SUPERAGENT_PROJECT_EXECUTION_NODES` 的有效绑定都可以阻止本地领取。远端 daemon 和共享执行卷由 Python 承载。受阻任务进入 `waiting_resource` 并留痕，现场切换须单控制器。真实本机 repair 采用拒绝提权策略，阶段 1 审批批准仅供离线夹具。

管理员通过项目设置选择 `workspace`、`projects` 或 `directories`。额外资料只对管理员负责的 analysis 开启，`directories` 从保存的绝对目录生成 `@refs/dir-N/`，`projects` 使用 `@refs/project-ID/`。从旧库迁移的缺省模式为 `workspace`。已经保存 `projects` 的旧记录沿用冻结版的已启用、未归档项目范围，管理员可通过上表接口收窄。配置 `SUPERAGENT_ALLOWED_REPO_ROOTS` 后，候选根和每次打开的资料根都须在其范围内。拒绝整盘、账号及系统目录、敏感文件、链接、重解析路径、硬链接和越界路径。项目配置或授权发生变化时停止沿用旧的读取范围。

`list_files` 只用于发现候选。`read_file` 和 `search_text` 的实际内容形成证据。每份证据保存别名路径、可展示行号、资料根摘要、内容 SHA-256 和可用的来源项目 ID，沿用 attempt/thread/turn 绑定。参考目录没有挂载为可写工作区。具有 `analysis_reference_scope` 事件的结果只在工作台查看，HTTP 草稿和发布入口均拒绝。普通 reply 在本轮 `prepareTurn` 之前调用 `prepareReplyDecision`，按来源与上下文范围记录 `reply_decision_input`。

`prompts.ts` 和 Worker 入口同时导出 `WORKER_PROMPTS`、`buildWorkerPrompt(kind, {goal, context?, workspace?, allowedPaths?})`。`/codex-prompts` 用占位文本填充参数可得到同一执行模板，不需要读取实际任务或目录。Router / Watchdog 统一从 `packages/runtime/index.ts` 导入 `openRestrictedCodex` 与 `RestrictedCodexDriver`。Router 选择 `reply`，Watchdog 按业务选择 `reply` 或 `analysis`。调用方负责账户选择、预算、实际读权限和同轮状态持久。

```powershell
node node_modules/vitest/vitest.mjs run --config vitest.config.ts apps/server/src/worker/worker.test.ts
npm --prefix packages/runtime test
```

Windows 上使用隔离临时目录，以允许本机 Job 程序启动的条件运行。受限环境可在 Job 监督程序启动时返回 `spawn UNKNOWN`，发生在协议握手之前。Node `v24.22.3` 服务测试 56 项通过，其中 Worker 24 项；Node `v22.20.0` 运行时协议测试 11 项通过。整库服务端 TypeScript 检查通过。新增测试覆盖 `directories`、项目清单、非管理员、越界及目录替换拒绝、旧 SQLite 默认值和 reply 判断绑定。测试使用假协议进程与合成文件。真实 Codex 的 sandbox、resume/steer 与计费仍需现场验收。原工作树、真实渠道、真实账号和业务库未参与测试。
