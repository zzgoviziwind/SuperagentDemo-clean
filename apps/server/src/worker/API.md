# Worker 执行协调交接

`index.ts` 导出 `registerWorker(app, store, lease, root, env): WorkerControls`。总控在 `app.ready()` 前注册，须提供已启动的控制器租约和独占绝对状态目录。`stop(taskId)` 只在确认 Job 内执行进程退出时返回 `true`。`steer(taskId, content)` 只向当前绑定轮次发送已持久化的下一条补充消息，收到相同 turn ID 的确认后推进消息游标。控制入口负责更新任务围栏。轮次完成时存在未确认补充消息会保留未知。续跑使用同一来源、用途、项目配置和隔离目录的已核实 thread，可从不同子进程读取既有会话。缺少可信工作区绑定的历史 thread 需要人工核对。

| 路由 | 入参 | 决定依据 |
| --- | --- | --- |
| `POST /api/v1/approvals/:id/decision` | `decision`, `action_hash` | Owner 或管理员，当前 repair 尝试、请求和 thread/turn 绑定，审批前核对版本、路径、配额。只在收到同轮确认后结束审批。 |
| `POST /api/v1/tasks/:id/acceptance` | `accepted`, `revision`, `comment?` | 当前版本的同轮证据和已完成尝试。repair/analysis 在验收前重新读取工作区状态，变化返回 409。 |
| `POST /api/v1/tasks/:id/reconcile` | `outcome`, `evidence`, `expected_state_version` | Owner 或管理员，当前版本、未知任务、无该任务的活动执行，必须填写已停止或放弃的人工证据。 |
| `GET /api/v1/agents/local` | 无 | 管理员。未选择时只枚举候选程序，已有选择的诊断仅使用已固定的程序和登录目录。 |
| `POST /api/v1/agents/local/connect` | `agent_id: codex`, `use_existing_login: true` | 管理员显式执行。程序与登录目录由 Host 发现并写入 `local_agent_selection`。启用调度前检查已有订阅或按量预算。 |

`settings.scheduler_enabled` 控制领任务。`SUPERAGENT_DRIVER=fixture` 选择离线驱动并禁用真实登录。本机驱动须已有授权选择。`SUPERAGENT_CONTEXT_MODE=decisions` 调用 `assembleContext`，先持久清单再派发。默认 legacy 不创建清单。`SUPERAGENT_WORKER_MAX_RUN_MS` 为绝对期限，单位毫秒，默认 240000，自领取尝试计时，涵盖工作区准备、协议、等待审批和证据核对。等待审批让出执行槽，派发决定前重新校验槽位、期限和当前围栏。

`verification` 产物通过 `attempt_id` 与 `summary`、必要时的 `changes` 关联，并绑定 thread、turn、来源和项目配置指纹。`offline-codex-fixture` 产物仅在夹具模式可验收。多仓按配置的本地分支逐仓锁定提交，保留项目相对位置，克隆副本不使用硬链接。修复拒绝脏源仓，分析只读取指定提交的副本。配置项目的 repair 需通过路径白名单、Git 差异及管理员验证命令。`test_command` 使用带绝对本机可执行文件的 JSON 参数数组。Host 核对验证前后的工作区，手工验收再取一次。analysis 的 Host 读取范围限于独立工作区内受限文本，内容摘要与结构化报告路径、无变更证据绑定。reply 禁用工具。真实订阅仅记录 `model.plan_run`，按量任务有估算及预留才派发，费用待核对。夹具调用无真实费用预留。

远端绑定由 `assignedNode()` 统一判定。历史表和 `SUPERAGENT_PROJECT_EXECUTION_NODES` 任一有效绑定都可以阻止本地领取。旧 Python 的远端 daemon、共享卷和跨项目/外部只读资料由 Python 承载。受阻任务进入 `waiting_resource` 并留痕，现场切换须单控制器。真实本机 repair 采用拒绝提权策略，阶段 1 审批批准仅供离线夹具。

`prompts.ts` 和 Worker 入口同时导出 `WORKER_PROMPTS`、`buildWorkerPrompt(kind, {goal, context?, workspace?, allowedPaths?})`。`/codex-prompts` 用占位文本填充参数可得到同一执行模板，不需要读取实际任务或目录。Router / Watchdog 统一从 `packages/runtime/index.ts` 导入 `openRestrictedCodex` 与 `RestrictedCodexDriver`。Router 选择 `reply`，Watchdog 按业务选择 `reply` 或 `analysis`。调用方负责账户选择、预算、实际读权限和同轮状态持久。

```powershell
node node_modules/vitest/vitest.mjs run --config vitest.config.ts apps/server/src/worker/worker.test.ts
npm --prefix packages/runtime test
```

Windows 上使用隔离临时目录，以允许本机 Job 程序启动的条件运行。受限环境可在 Job 监督程序启动时返回 `spawn UNKNOWN`，发生在协议握手之前。Node `v24.22.3` 服务测试 47 项通过，其中 Worker 19 项；Node `v22.20.0` 运行时协议测试 11 项通过。整库服务端 TypeScript 检查通过。测试使用假协议进程与合成 Git 源仓。真实 Codex 的 sandbox、resume/steer 与计费仍需现场验收。原工作树、真实渠道、真实账号和业务库未参与测试。
