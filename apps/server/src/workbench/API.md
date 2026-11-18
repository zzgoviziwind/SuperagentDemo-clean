# 工作台 API 清单

行为基线为 `.rewrite-oracle`，指纹 `abf0a6922e8da03d65cd53458df256a509d824c3fbf276f58943cc800201b091`。总控通过 `registerWorkbench(app, db, scheduler)` 注册接口和调度。路径均相对于 `/api/v1`。

|场景|方法与路径|React 入口|数据与权限|
|---|---|---|---|
|1.1、2.1、2.5|`GET /projects`、`GET /tasks`、`GET /overview`|`main.tsx` 初始加载及 HTTP 契约|项目列表排除归档。任务按可见性、状态和项目筛选，保留有权限的归档项目历史。总览根据同一可见性计算计数、当前任务与待审批项。|
|2.2|`GET /event-groups/index`、`GET /event-groups`、`GET /event-groups/:id`|`GroupedEvents.tsx`、`EventGroups.tsx`|`tasks`、`events`、`event_targets`、`worker_subscriptions`；管理员或任务所属成员；管理员可看未分派收件。先搜索/筛选，再分页，状态计数不受当前状态筛选影响。|
|2.2|`POST /event-groups/:id/events/:event_id/resolution`、`POST /event-groups/:id/following/:subscription_id`|`GroupedEvents.tsx`、`EventGroups.tsx`|沿用事件组可见性和版本保护；未知执行结果返回 409；逐组追加核验事件；跟进保留原订阅行及历史。|
|2.2|`POST /event-groups/:id/rename`、`POST /event-groups/:id/delegations`、`GET /event-groups/triage-options`|`GroupedEvents.tsx`、`EventGroups.tsx`、`EventTriage.tsx`|重命名校验所有权和版本。委派以请求键去重，创建同项目子任务并继承有效 owner。分派选项仅管理员读取。|
|2.2|`POST /event-groups/triage`、`POST /event-groups/:id/sync-own-dingtalk`|`GroupedEvents.tsx`|仅管理员。triage 支持关闭、创建及关联，事务内保留来源、目标、附件任务与审计。同步仅导入可核对私聊中明确归属本组的本账号发言。|
|2.3、2.5|`GET /tasks/:id`、`GET /tasks/:id/export`、`GET /artifacts/:id`、`GET /artifacts/:id/download`|`main.tsx`、`GroupedEvents.tsx`、`MessageTracePanel.tsx`，导出与下载见 HTTP 契约|从 `tasks`、`events`、`artifacts`、`approvals` 读取。不可见与缺失资源均返回 404。导出和下载以 JSON 附件返回持久记录。|
|2.5|`GET /approvals`、`GET /codex-prompts`|HTTP 契约及模型设置页|审批和总览待审批使用任务所有权条件。提示词仅管理员可见，直接调用 Worker 的真实模板及工作台发起轮次使用的模板。总览经连接器管理器读取与 `/connectors` 相同的当前状态。|
|2.2、3.2|`GET /events`、`GET /events/:id/trace`、`GET /subscriptions`、`GET /architecture`|`MessageRecords.tsx`、`MessageTracePanel.tsx`、`GroupedEvents.tsx`、`ArchitecturePanel.tsx`|仅管理员。原始收件先筛选再按 ID 翻页。跟踪保留来源、目标、账本、执行和巡检关联。全局订阅只读。|
|2.5|`GET /events/stream`|冻结 HTTP 契约|管理员可读全量通知，成员只收到所属任务的通知，viewer 仅收到心跳。支持 `after` 和 `Last-Event-ID`。连接最多保留 30 秒，重连时重新认证。|
|3.2|`GET /sessions`、`GET /sessions/:id`、`GET /sessions/:id/transcript`、`GET /sessions/:id/coordination`|`SessionWorkbench.tsx`、`ThreadTranscript.tsx`、`CoordinationPanel.tsx`|管理员可见 Worker、项目 Router 与语义分流会话。成员只看所属 Worker。查看者无会话可见性。历史取已有消息及产物，完整 Codex 记录需要运行时。|
|3.2|`POST /sessions/:id/messages`、`POST /sessions/:id/reconcile`|`SessionWorkbench.tsx`|Worker 发言复用任务消息入口。项目 Router 关闭时保存便笺。语义复核保存原上下文与排队消息。未知结果解除前须确认进程退出。|
|3.2|`GET /routing/jobs`、`POST /routing/schedule`、`POST /routing/jobs/:event_id/correction`|`RoutingPanel.tsx`|仅管理员。纠正候选按来源身份、所属项目及任务权限过滤。已路由事件的纠正只追加历史。新分派将持久化结果与运行时回执对照。|
|3.2|`GET /operations/watchdog`、`POST /operations/watchdog/tasks/:task_id/run`、`POST /operations/watchdog/:run_id/messages`|`OperationsPanel.tsx`|仅管理员。读取真实巡检记录。运行由开关、正在执行和未知记录共同约束。纠正保留审计事件。|
|2.6|`GET /conversation-providers`、`GET /conversation-providers/bridge/{status,sessions,sessions/:id,operations/:key}`、`POST /conversation-providers/bridge/operations`、`POST /conversation-providers/mcp`|`ConversationProvidersPanel.tsx` 及 HTTP 桥接契约|桥接使用平台 Bearer，复用会话权限，历史分页绑定快照。创建、发言和控制复用主入口。相同请求键重放回执，未知或进行中的操作禁止自动重放。MCP 使用无状态 HTTP JSON-RPC。|

按 [SCOPE.md](../../../../docs/rewrite/SCOPE.md) 的安全裁决，任务、事件组、Worker 会话、产物、导出和统计使用同一所有权条件。管理员可读，成员只读自己的任务。历史 `governance_task_owners` 在 `tasks.owner_id` 为 `local-admin` 时提供兼容归属。工作台所有权无需外部来源的身份授权。收件、跟踪、订阅和路由队列继续沿用管理员权限。

## 运行时接入

主服务持有 SQLite 控制器租约后注册同一实例。状态目录为服务已经解析的绝对目录。关闭服务时先停止轮询并等待当前调用进入可恢复状态。

```ts
const scheduler = createWorkbenchScheduler(store.db, {
  lease,
  stateRoot: root,
  env,
  ports: workbenchRuntime(app),
  stopWorker: taskId => worker.stop(taskId),
});
registerWorkbench(app, store.db, scheduler);
```

在 intake 保存来源事件并调用 `route(db, event, id, env)` 后，在读取返回行前执行 `enqueueSemanticReceipt(db, id, env)`。该调用可复用当前事务，覆盖 `route` 提前返回的未绑定项目。后台分页扫描也会补接尚无判定记录的待确认消息。已关联、有投递目标或已有判定记录的来信不会再次入队。

回滚 CLI 取得租约后可调用 `createWorkbenchScheduler(...).recoverOnly()`。该方法只执行与正常启动相同的 SQLite 恢复，包括冻结未完成轮次、桥接回执和预算预留。它不会启动轮询、唤醒队列或连接 Codex。

|能力|接口约束|
|---|---|
|Codex 线程历史|默认从受信本机 Codex 进程发出原始 `thread/read`，只带绑定的 thread ID 与 `includeTurns: true`。读取进程只接受握手和读取协议。工作台复核所有权、返回线程和进程退出。失败时 `complete: false` 并返回持久历史。远端或自定义驱动可通过 `ports.readThread` 提供读取。|
|钉钉私聊|适配器从已配置账号读取限定的时间窗口，返回完整页和会话标识。工作台复核私聊锚点、本账号身份、时间边界和唯一归组，重复拉取按来源键去重。|
|项目 Router 与语义分派|原生调度复用受信本机 Codex 驱动。领取后建立 thread/turn、持久化调用意图、校验同轮响应并保存结果。分派前与应用决策前复核来源、项目和版本。未分配私聊以 `project_id=0` 保存建议，项目必须在授权快照内并引用同一会话证据，由事件中心人工确认。|
|Watchdog|开关打开且到达巡检间隔后领取活动任务。只依据当前任务版本应用结论。排队任务可直接暂停，运行中的任务经 `stopWorker` 确认进程退出后才完成暂停。未接停止端口时保留人工处理结论。|
|预算、轮次与恢复|按量调用必须先预留，未调用时可结算为零。已发起轮次缺少真实价格或用量时继续保留未知预算。新增的 `workbench_model_runs` 保存租约代、阶段、证据来源和 thread/turn。重启把在途记录标为未知，等待人工核验。|
|HTTP 桥接|创建、发言和控制复用同一 Fastify 的主路由及权限。保留 Python 原请求键哈希、分页快照和 HTTP JSON-RPC。原 Python STDIO 客户端可以继续使用同一组 Bearer HTTP 路径。当前 TypeScript 服务提供 HTTP 入口。|

## 验证

- Node 24 下工作台、调度、认证与总控入口共 28 项测试通过。调度测试通过 `WORKBENCH_FROZEN_DB` 指定阶段 0 的 `migrated.db`，每项创建独立临时副本。真实启动 Windows Job 内的离线假协议进程，验证新轮次、线程续用、绑定的响应 ID、自动领取、预算拒绝、巡检停止确认、项目建议、原始 `thread/read` 和重启。测试适配器将假进程的固定本轮响应转换为结构化样本。
- 按阶段 0 验收记录复制 Python 临时样本，在总控入口关闭并重启后检查 62 个进程内 HTTP 响应。对照历史事件与产物、核验结果、权限错误、导出和已持久化的交付记录。

## 交接与缺口

- 投递组负责 `GET /tasks/:id/deliveries`。事件跟踪读取已保存投递记录。入站、事件重试、普通任务与上下文由总控负责，triage 由工作台负责。
- 委派入口提交子任务和事件。子 Worker 结果回流、协调写入与交接、项目研判的主动取图及批量比较仍需单独集成。
- 本轮使用离线假协议和冻结库副本。受信本机 Codex 账号、真实 DWS、浏览器和安装器需要各自的联调证据。
