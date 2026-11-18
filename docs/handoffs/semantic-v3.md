# 语义路由与多订阅交接 v3

## 集成接口

- 导入 `superagent.core.semantic_routing`、`superagent.core.subscriptions` 后调用 `db.init_db()`，新增表通过 metadata.create_all 创建，无旧表破坏性变更。
- 新表 `worker_subscriptions`（项目/来源/线程/Worker 多对多）、`event_targets`（来源事件/目标任务唯一）、`semantic_routing_jobs`（持久队列）。旧 TaskRoute 保持兼容。
- `SemanticRoutingService.start()/close()` 管理后台循环，`schedule_pending(event_id=None)` 将合法待确认事件重新检查并调度；单例 `semantic_routing_service`。
- 设置键 `semantic_routing_enabled` 默认 false，治理 settings 白名单及 UI 由总控接入。沿用 Codex 路径、模型、强度和预算配置。
- main.py 挂载 `superagent.api.routing.router`，生命周期启动/关闭上述单例。管理入口 `GET /routing/jobs`、`POST /routing/schedule`、`POST /subscriptions`、`DELETE /subscriptions/{id}`。GET /subscriptions 保留旧引用并增加显式订阅。
- 后续来源事件每合法订阅生成独立 canonical message 与 event_targets 关联，Scheduler 可沿用现有 task_id 消息读取和附件准备，无须假定来源事件只有一个目标。

## 验证与局限

功能实现与离线验证已完成，最终验证记录见文末。

## 当前已落地接口（供总控/前端即时集成）

`SemanticRoutingService.start()` 为 async 启动，`close()` 为 async 关闭。单例 `semantic_routing_service` 在 core/semantic_routing.py。main 必须先导入 api/routing（含模型）再 init_db。

- `GET /api/v1/routing/jobs?after=0&limit=50` 返回 `{items,has_more,next_after}`。job 含 `event_id,project_id,status,context,decision,output,thread_id,turn_id,error,created_at,updated_at`。context 是实际模型输入快照，output 是可见助手输出；二者仅管理员可读。status 为 queued/running/applied/ignored/rejected/unknown。
- `POST /api/v1/routing/schedule {event_id?:int}` 重新检查待确认收件，授权合法且尚无模型 job 的事件可入队，返回 `{checked,routed_event_ids}`。失败/未知 job 不重放。
- `POST /api/v1/routing/jobs/{event_id}/correction {decision,evidence}` 人工核验与纠正，不再调用模型。decision 必须完整 `{action:"create|dispatch|ignore|confirm",kind:"analysis|repair",task_id:int|null,state_version:int|null,reason:string}`。dispatch 必须匹配 context.tasks 中目标和版本且当前仍合法。repair 仍要求原消息明确写意图。已应用事件返回原 job（newly_applied=false），不会第二次创建/投递。
- `POST /api/v1/subscriptions {project_id,task_id,source,thread_id,profile?:""}` 启用订阅。管理员入口，后续每条事件仍以事件发送者的实时授权判断目标合法性。钉钉 thread_id 需要绑定项目群。profile 用于区分账号，必须与接入器事件一致。
- `DELETE /api/v1/subscriptions/{id}` 停用显式订阅，旧 TaskRoute 无此删除入口。
- `GET /api/v1/subscriptions` items 保留旧引用，显式项新增 `subscription_type:"explicit",enabled,thread_id,profile,route_key,reference_kind:"thread"`，数值 id 与旧引用可能重合，前端应按 subscription_type 区分操作。
- `GET /api/v1/events/{id}/trace` 新增 `semantic_routing`（完整 job 或 null）、`targets`（每目标关联）、`target_tasks`（当前目标任务）；旧 task/execution 字段兼容。fanout 父事件 task_id 可为空，不能再只用该字段判断已路由。
- clone canonical message 已保留原来源，external_id=null；来源收件列表/架构计数排除 clone。每个 clone 的 data 含 source_event_id/subscription_id/requires_interrupt，附件另建 job。

`await service.apply_and_dispatch(event_id, decision, evidence=...)` 是人工/模型提交的统一入口，落库后 await 现有 connections.schedule_interruption / schedule_attachments。后台 run_once 已调用，correction 和 schedule API 均为 async 并已调用。同步 `apply()` 仅用于事务测试，业务入口应使用 async 包装。

总控在运行时如需 hook 已收件 pending 事件，使用 `result=service.schedule_pending(event_id)`，再逐个 `await service.dispatch(id)` 处理 result.routed_event_ids（仅新直接路由）。新 queued 由后台 run_once 消费。settings_snapshot 的 semantic_routing_enabled 默认值及白名单由治理会话/总控注册。

### 前端人工纠正补充

`GET /routing/jobs` 每项额外含 `correction_tasks:[{id,title,state_version}]`，为当前权限和状态下可用的实时目标。纠正 dispatch 下拉选项请优先用此数组，保留 context.tasks 作为模型原始输入展示。人工纠正允许填写当前版本，原始 context 不会改写。已忽略事件可以纠正为 create/dispatch；已应用事件重复纠正返回 newly_applied=false，避免同事件再次创建。

### 架构与多目标追踪补充

architecture 能力说明已与 operations 对齐，包含本机/共享卷 daemon 执行、独立模型 Watchdog 的持久巡检与人工纠正。
trace 新增 `target_observations:[{task_id,message_event_id,execution:{state,thread_id,turn_id,workspace,events},watchdog:{outcome_unknown,last_error,runs},scope}]`，多目标母事件 worker.state 为 fanout，当前每目标状态据此展示。execution.events 为当前任务最近 100 条 runtime 观察；WatchdogRun 最近 50 条，范围提示已明确包含其他来源事件相关记录。原单任务 live_stages.watchdog 同样返回 runs，并纳入 watchdog_review/watchdog_correction。

## 最终实现与验证记录

- 确定性身份/项目/权限/回声/事件格式先行；已有引用和显式线程订阅走 FastPath；开启 semantic_routing_enabled 后新事件进入持久 SlowPath，真实 CodexAppServer 只读轮次输出严格 JSON，判定在重新授权和版本围栏后实际创建/复用任务。
- 原始模型 context/output、thread_id/turn_id、decision、目标关联均持久化。人工纠正沿用当前权限及任务版本，保留原始模型输入。分派追踪准确区分 deterministic_rules/semantic_model/human_correction。
- claim 原子更新，模型运行中的任务重启后转 unknown；异常、非法结果及失败不会自动重放。后台循环隔离每轮异常并记录脱敏错误类型，取消继续向上传播。
- 每个 source-event/task 唯一 EventTarget，显式订阅支持多线程→同 Worker 和同线程→多个 Worker。每目标独立 canonical Event/message、版本失效、审批过期、附件 job 与中断标记，事后投递 hook 实际执行。
- 受管路由字段采用输入白名单；canonical 消息 external_id=null 且 routing_status=delivered，来源列表、计数和 pending 扫描排除 canonical 消息，避免放大事件计数和二次广播。
- 回归命令 `.venv/Scripts/python.exe -m pytest tests/integration/test_lifecycle.py tests/integration/test_semantic_routing.py tests/integration/test_subscriptions.py tests/integration/test_routing_delivery.py -q --basetemp=.local/semantic-v3-tests-10`，128 passed，1 条既有 TestClient/httpx 弃用提示。此轮在最后的新建/复用文案调整前完成，随后另跑模块验证见下。
- 验证包含管理 HTTP API、实时纠正任务清单、忽略后纠正、失效版本后人工核验、模型调用前授权撤销、运行中授权撤销、终态/跨项目/未知目标、输入注入/非法输出、队列重启、异常循环恢复、重复接收、订阅取消恢复、多线程、多目标附件与中断、每目标 Watchdog 追踪、正常 Codex stderr 和会话编号落库。
- 隔离测试使用本项目 .venv；受限环境首次临时目录失败，后续改为项目 .local 临时目录并在本机隔离执行异步测试。
- 总控已报告真实 Codex 语义判定成功 applied 并创建 analysis 任务，证据 `.test-tmp/v3-real-model/result.json` 归总控验收。本会话自身的模型协议测试使用离线替身。真实钉钉/Redmine接收与发送、本轮 PostgreSQL 并发仍待对应验收。
- 跨模块集成由总控处理 main/治理设置、connections fanout hooks 和 sessions 中 delivered canonical 消息展示。本会话的 async apply_and_dispatch 及 API 已接入总控的 connections hooks。
- 最后调整后模块复验 `.venv/Scripts/python.exe -m pytest tests/integration/test_lifecycle.py tests/integration/test_semantic_routing.py tests/integration/test_subscriptions.py -q --basetemp=.local/semantic-v3-tests-11`，48 passed，1 条相同弃用提示。
