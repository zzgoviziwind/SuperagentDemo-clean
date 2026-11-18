# 119 项双端 HTTP 回放

固定源码和运行时见 [run.json](run.json)。每项在 Python 与 TS 两端都有实际 HTTP。每个写入口独占一份从同一底库复制的临时数据库，先送负例再送合法格式样本。两端共 60 个写方法、59 个读方法，每端各 238 次请求。读入口分别以匿名和合成管理员请求。

状态优先记录入口缺失、服务错误和行为差异。业务抽查通过要求合法响应有业务内容、预期持久表发生变化、两端的规范化结果与所观察的副作用一致。负例的错误文案及结构另列。协议规定的 405、依赖关闭、空结果单独标记。

保留原始输入、响应、负例、内容头、两侧数据库行变化及托管文件变化。对比时仅折叠临时根、明确时间字段、动态 UUID 的对应关系及健康接口的实现版本。控制器心跳表不计入业务变更。数据库 JSON 文本做结构化比较。首次 SSE 帧单独采样。固有默认值、权限改进和有意的审计增量由主控裁决。

|结果|方法与路径数|
|---|---:|
|业务抽查通过|4|
|业务抽查通过，响应头有差异|67|
|字段或持久记录差异|32|
|行为差异|6|
|协议拒绝通过|2|
|服务错误|1|
|前置条件拒绝|4|
|副作用不符|1|
|按约定由 Python 承载|2|

## 各方法与路径

状态栏按 Python / TS 排列。差异列显示一个位置，[分类数据](classification.json)每类最多列 12 个位置，[逐请求记录](observations.json)保留采样响应和变更行原值。附件重试的停机后状态见[SQLite 回读](attachment-after-stop.json)。

|方法与路径|合法输入|负例或匿名|独立分类|差异位置或前置条件|
|---|---|---|---|---|
| `DELETE /api/v1/conversation-providers/mcp` | 405 / 405 | 401 / 401 | 协议拒绝通过 | headers/cache-control (仅 TS) |
| `DELETE /api/v1/identities/{identity_id}` | 200 / 200 | 404 / 404 | 业务抽查通过，响应头有差异 | headers/cache-control (仅 TS) |
| `DELETE /api/v1/projects/{ident}` | 200 / 200 | 404 / 404 | 业务抽查通过，响应头有差异 | headers/cache-control (仅 TS) |
| `DELETE /api/v1/subscriptions/{subscription_id}` | 200 / 200 | 404 / 404 | 业务抽查通过，响应头有差异 | headers/cache-control (仅 TS) |
| `GET /api/v1/agents/local` | 200 / 200 | 401 / 401 | 业务抽查通过，响应头有差异 | headers/cache-control (仅 TS) |
| `GET /api/v1/approvals` | 200 / 200 | 401 / 401 | 字段或持久记录差异 | body/0/status |
| `GET /api/v1/architecture` | 200 / 200 | 401 / 401 | 业务抽查通过，响应头有差异 | headers/cache-control (仅 TS) |
| `GET /api/v1/artifacts/{ident}` | 200 / 200 | 401 / 401 | 业务抽查通过，响应头有差异 | headers/cache-control (仅 TS) |
| `GET /api/v1/artifacts/{ident}/download` | 200 / 200 | 401 / 401 | 业务抽查通过 | — |
| `GET /api/v1/attempts/{attempt_id}/context` | 200 / 200 | 401 / 401 | 业务抽查通过，响应头有差异 | headers/cache-control (仅 TS) |
| `GET /api/v1/audit` | 200 / 200 | 401 / 401 | 业务抽查通过，响应头有差异 | headers/cache-control (仅 TS) |
| `GET /api/v1/auth/me` | 200 / 200 | 401 / 401 | 业务抽查通过，响应头有差异 | headers/cache-control (仅 TS) |
| `GET /api/v1/budget-reservations` | 200 / 200 | 401 / 401 | 业务抽查通过，响应头有差异 | headers/cache-control (仅 TS) |
| `GET /api/v1/budgets` | 200 / 200 | 401 / 401 | 业务抽查通过，响应头有差异 | headers/cache-control (仅 TS) |
| `GET /api/v1/codex-prompts` | 200 / 200 | 401 / 401 | 字段或持久记录差异 | body/analysis/0/text |
| `GET /api/v1/connectors` | 200 / 200 | 401 / 401 | 业务抽查通过，响应头有差异 | headers/cache-control (仅 TS) |
| `GET /api/v1/connectors/dingtalk/group` | 200 / 409 | 401 / 401 | 行为差异 | body/detail (仅 TS) |
| `GET /api/v1/connectors/dingtalk/groups` | 200 / 409 | 401 / 401 | 行为差异 | body/complete (仅 Python) |
| `GET /api/v1/conversation-providers` | 200 / 200 | 401 / 401 | 字段或持久记录差异 | body/items/1/reason |
| `GET /api/v1/conversation-providers/bridge/operations/{request_key}` | 200 / 200 | 401 / 401 | 业务抽查通过，响应头有差异 | headers/cache-control (仅 TS) |
| `GET /api/v1/conversation-providers/bridge/sessions` | 200 / 200 | 401 / 401 | 业务抽查通过，响应头有差异 | headers/cache-control (仅 TS) |
| `GET /api/v1/conversation-providers/bridge/sessions/{ident}` | 200 / 200 | 401 / 401 | 业务抽查通过，响应头有差异 | headers/cache-control (仅 TS) |
| `GET /api/v1/conversation-providers/bridge/status` | 200 / 200 | 401 / 401 | 字段或持久记录差异 | body/items/1/reason |
| `GET /api/v1/conversation-providers/mcp` | 405 / 405 | 401 / 401 | 协议拒绝通过 | headers/cache-control (仅 TS) |
| `GET /api/v1/decisions` | 200 / 200 | 401 / 401 | 业务抽查通过，响应头有差异 | headers/cache-control (仅 TS) |
| `GET /api/v1/event-groups` | 200 / 200 | 401 / 401 | 业务抽查通过，响应头有差异 | headers/cache-control (仅 TS) |
| `GET /api/v1/event-groups/index` | 200 / 200 | 401 / 401 | 业务抽查通过，响应头有差异 | headers/cache-control (仅 TS) |
| `GET /api/v1/event-groups/triage-options` | 200 / 200 | 401 / 401 | 业务抽查通过，响应头有差异 | headers/cache-control (仅 TS) |
| `GET /api/v1/event-groups/{ident}` | 200 / 200 | 401 / 401 | 业务抽查通过，响应头有差异 | headers/cache-control (仅 TS) |
| `GET /api/v1/event-rules` | 200 / 200 | 401 / 401 | 业务抽查通过，响应头有差异 | headers/cache-control (仅 TS) |
| `GET /api/v1/events` | 200 / 200 | 401 / 401 | 业务抽查通过，响应头有差异 | headers/cache-control (仅 TS) |
| `GET /api/v1/events/stream` | 200 / 200 | 401 / 401 | 业务抽查通过，响应头有差异 | headers/cache-control (仅 TS) |
| `GET /api/v1/events/{event_id}/trace` | 200 / 200 | 401 / 401 | 业务抽查通过，响应头有差异 | headers/cache-control (仅 TS) |
| `GET /api/v1/field-intake/media-jobs` | 200 / 200 | 401 / 401 | 字段或持久记录差异 | body/reason (仅 TS) |
| `GET /api/v1/field-intake/organizer` | 200 / 200 | 401 / 401 | 字段或持久记录差异 | body/ocr (仅 TS) |
| `GET /api/v1/field-intake/records` | 200 / 200 | 401 / 401 | 业务抽查通过，响应头有差异 | headers/cache-control (仅 TS) |
| `GET /api/v1/field-intake/records/{ident}` | 200 / 200 | 401 / 401 | 业务抽查通过，响应头有差异 | headers/cache-control (仅 TS) |
| `GET /api/v1/field-intake/records/{ident}/media` | 200 / 200 | 401 / 401 | 业务抽查通过，响应头有差异 | headers/content-disposition |
| `GET /api/v1/field-intake/records/{ident}/screenshots/{number}` | 200 / 200 | 401 / 401 | 业务抽查通过 | — |
| `GET /api/v1/field-intake/records/{ident}/targets` | 200 / 200 | 401 / 401 | 业务抽查通过，响应头有差异 | headers/cache-control (仅 TS) |
| `GET /api/v1/field-intake/records/{ident}/transcript/{segment_id}` | 200 / 200 | 401 / 401 | 业务抽查通过，响应头有差异 | headers/cache-control (仅 TS) |
| `GET /health` | 200 / 200 | 200 / 200 | 业务抽查通过 | — |
| `GET /api/v1/identities` | 200 / 200 | 401 / 401 | 业务抽查通过，响应头有差异 | headers/cache-control (仅 TS) |
| `GET /api/v1/operations/nodes` | 200 / 200 | 401 / 401 | 字段或持久记录差异 | body/items/0/execution_host (仅 TS) |
| `GET /api/v1/operations/tasks/{task_id}/attempts` | 200 / 200 | 401 / 401 | 业务抽查通过，响应头有差异 | headers/cache-control (仅 TS) |
| `GET /api/v1/operations/watchdog` | 200 / 200 | 401 / 401 | 业务抽查通过，响应头有差异 | headers/cache-control (仅 TS) |
| `GET /api/v1/overview` | 200 / 200 | 401 / 401 | 字段或持久记录差异 | body/pending_approvals (条数) |
| `GET /api/v1/project-workspace` | 200 / 200 | 401 / 401 | 业务抽查通过，响应头有差异 | headers/cache-control (仅 TS) |
| `GET /api/v1/project-workspace/codex-projects` | 200 / 200 | 401 / 401 | 业务抽查通过，响应头有差异 | headers/cache-control (仅 TS) |
| `GET /api/v1/projects` | 200 / 200 | 401 / 401 | 业务抽查通过，响应头有差异 | headers/cache-control (仅 TS) |
| `GET /api/v1/routing/jobs` | 200 / 200 | 401 / 401 | 业务抽查通过，响应头有差异 | headers/cache-control (仅 TS) |
| `GET /api/v1/sessions` | 200 / 200 | 401 / 401 | 业务抽查通过，响应头有差异 | headers/cache-control (仅 TS) |
| `GET /api/v1/sessions/{ident}` | 200 / 200 | 401 / 401 | 业务抽查通过，响应头有差异 | headers/cache-control (仅 TS) |
| `GET /api/v1/sessions/{ident}/coordination` | 200 / 200 | 401 / 401 | 业务抽查通过，响应头有差异 | headers/cache-control (仅 TS) |
| `GET /api/v1/sessions/{ident}/transcript` | 200 / 200 | 401 / 401 | 业务抽查通过，响应头有差异 | headers/cache-control (仅 TS) |
| `GET /api/v1/settings` | 200 / 200 | 401 / 401 | 业务抽查通过，响应头有差异 | headers/cache-control (仅 TS) |
| `GET /api/v1/subscriptions` | 200 / 200 | 401 / 401 | 业务抽查通过，响应头有差异 | headers/cache-control (仅 TS) |
| `GET /api/v1/tasks` | 200 / 200 | 401 / 401 | 业务抽查通过，响应头有差异 | headers/cache-control (仅 TS) |
| `GET /api/v1/tasks/{ident}` | 200 / 200 | 401 / 401 | 业务抽查通过，响应头有差异 | headers/cache-control (仅 TS) |
| `GET /api/v1/tasks/{ident}/export` | 200 / 200 | 401 / 401 | 业务抽查通过 | — |
| `GET /api/v1/tasks/{task_id}/context` | 200 / 200 | 401 / 401 | 业务抽查通过，响应头有差异 | headers/cache-control (仅 TS) |
| `GET /api/v1/tasks/{task_id}/decisions` | 200 / 200 | 401 / 401 | 业务抽查通过，响应头有差异 | headers/cache-control (仅 TS) |
| `GET /api/v1/tasks/{task_id}/deliveries` | 200 / 200 | 401 / 401 | 业务抽查通过，响应头有差异 | headers/cache-control (仅 TS) |
| `PATCH /api/v1/budgets/{account_id}` | 200 / 200 | 422 / 422 | 业务抽查通过，响应头有差异 | headers/cache-control (仅 TS) |
| `PATCH /api/v1/identities` | 200 / 200 | 422 / 422 | 业务抽查通过，响应头有差异 | headers/cache-control (仅 TS) |
| `PATCH /api/v1/operations/projects/{project_id}/execution-node` | 200 / 200 | 422 / 422 | 业务抽查通过，响应头有差异 | headers/cache-control (仅 TS) |
| `PATCH /api/v1/projects/{ident}` | 200 / 200 | 500 / 422 | 服务错误 | headers/cache-control (仅 TS) |
| `PATCH /api/v1/settings` | 200 / 200 | 422 / 422 | 业务抽查通过，响应头有差异 | headers/cache-control (仅 TS) |
| `POST /api/v1/agents/local/connect` | 409 / 409 | 422 / 422 | 前置条件拒绝 | body/detail |
| `POST /api/v1/approvals/{ident}/decision` | 409 / 409 | 409 / 409 | 前置条件拒绝 | body/detail |
| `POST /api/v1/auth/login` | 200 / 200 | 401 / 401 | 业务抽查通过，响应头有差异 | headers/set-cookie |
| `POST /api/v1/auth/logout` | 200 / 200 | 403 / 403 | 业务抽查通过，响应头有差异 | headers/set-cookie |
| `POST /api/v1/budget-reservations/{reservation_id}/reconcile` | 200 / 200 | 422 / 422 | 业务抽查通过，响应头有差异 | headers/cache-control (仅 TS) |
| `POST /api/v1/connectors/{name}/{action}` | 200 / 200 | 422 / 422 | 业务抽查通过，响应头有差异 | headers/cache-control (仅 TS) |
| `POST /api/v1/conversation-providers/bridge/operations` | 200 / 200 | 422 / 422 | 字段或持久记录差异 | db/events/0/after/id |
| `POST /api/v1/conversation-providers/mcp` | 200 / 200 | 200 / 200 | 字段或持久记录差异 | body/result/tools/0/description |
| `POST /api/v1/decisions` | 201 / 201 | 422 / 422 | 业务抽查通过，响应头有差异 | headers/cache-control (仅 TS) |
| `POST /api/v1/decisions/{decision_id}/revoke` | 200 / 200 | 422 / 422 | 业务抽查通过，响应头有差异 | headers/cache-control (仅 TS) |
| `POST /api/v1/deliveries/{draft_id}/decision` | 200 / 200 | 409 / 409 | 字段或持久记录差异 | db/events/0/after/id |
| `POST /api/v1/deliveries/{draft_id}/publish` | 200 / 200 | 404 / 404 | 业务抽查通过，响应头有差异 | headers/cache-control (仅 TS) |
| `POST /api/v1/deliveries/{draft_id}/reconcile` | 200 / 200 | 422 / 422 | 字段或持久记录差异 | db/events/0/after/id |
| `POST /api/v1/event-groups/triage` | 200 / 200 | 422 / 422 | 业务抽查通过，响应头有差异 | headers/cache-control (仅 TS) |
| `POST /api/v1/event-groups/{ident}/delegations` | 200 / 200 | 422 / 422 | 字段或持久记录差异 | body/id |
| `POST /api/v1/event-groups/{ident}/events/{event_id}/resolution` | 200 / 200 | 422 / 422 | 字段或持久记录差异 | db/events/0/after/id |
| `POST /api/v1/event-groups/{ident}/following/{subscription_id}` | 200 / 200 | 409 / 409 | 字段或持久记录差异 | db/events/0/after/id |
| `POST /api/v1/event-groups/{ident}/rename` | 200 / 200 | 409 / 409 | 字段或持久记录差异 | db/events/0/after/id |
| `POST /api/v1/event-groups/{ident}/sync-own-dingtalk` | 200 / 409 | 401 / 401 | 行为差异 | body/added (仅 Python) |
| `POST /api/v1/events` | 200 / 200 | 422 / 422 | 字段或持久记录差异 | body/data/_lifecycle/0/steps/1/detail/conversation_type (仅 Python) |
| `POST /api/v1/events/{event_id}/retry-attachments` | 200 / 200 | 409 / 409 | 副作用不符 | body/data/attachments_error (类型) |
| `POST /api/v1/events/{event_id}/retry-routing` | 200 / 200 | 409 / 409 | 业务抽查通过，响应头有差异 | headers/cache-control (仅 TS) |
| `POST /api/v1/field-intake/analysis/{ident}/implement` | 200 / 200 | 422 / 422 | 字段或持久记录差异 | db/events/0/after/id |
| `POST /api/v1/field-intake/candidates/{ident}/decision` | 200 / 200 | 422 / 422 | 业务抽查通过，响应头有差异 | headers/cache-control (仅 TS) |
| `POST /api/v1/field-intake/media-jobs` | 409 / 409 | 409 / 409 | 前置条件拒绝 | body/detail |
| `POST /api/v1/field-intake/media-jobs/{ident}/retry` | 409 / 409 | 409 / 409 | 前置条件拒绝 | body/detail |
| `POST /api/v1/field-intake/records` | 200 / 200 | 422 / 422 | 业务抽查通过，响应头有差异 | headers/cache-control (仅 TS) |
| `POST /api/v1/identities` | 200 / 200 | 422 / 422 | 业务抽查通过，响应头有差异 | headers/cache-control (仅 TS) |
| `POST /api/v1/operations/daemon/exchange` | 200 / 503 | 422 / 503 | 按约定由 Python 承载 | body/accepted (仅 Python) |
| `POST /api/v1/operations/daemon/poll` | 200 / 503 | 422 / 503 | 按约定由 Python 承载 | body/active_sessions (仅 Python) |
| `POST /api/v1/operations/watchdog/tasks/{task_id}/run` | 409 / 409 | 409 / 404 | 行为差异 | body/detail |
| `POST /api/v1/operations/watchdog/{run_id}/messages` | 200 / 409 | 422 / 422 | 行为差异 | body/conclusion (仅 Python) |
| `POST /api/v1/project-workspace/select-directory` | 200 / 200 | 422 / 422 | 业务抽查通过，响应头有差异 | headers/cache-control (仅 TS) |
| `POST /api/v1/projects` | 200 / 200 | 422 / 422 | 业务抽查通过，响应头有差异 | headers/cache-control (仅 TS) |
| `POST /api/v1/routing/assessments` | 200 / 200 | 422 / 422 | 字段或持久记录差异 | body/assessment_id |
| `POST /api/v1/routing/jobs/{event_id}/correction` | 200 / 200 | 422 / 422 | 字段或持久记录差异 | db/semantic_routing_jobs (仅 Python) |
| `POST /api/v1/routing/schedule` | 200 / 200 | 422 / 422 | 字段或持久记录差异 | db/events/0/after/data/$serialized_json/_lifecycle/0/steps/1/detail/conversation_type (仅 Python) |
| `POST /api/v1/sessions/{ident}/coordination` | 200 / 200 | 422 / 422 | 字段或持久记录差异 | body/id |
| `POST /api/v1/sessions/{ident}/coordination/{request_id}/apply` | 200 / 200 | 404 / 404 | 字段或持久记录差异 | db/event_targets/0/after/message_event_id |
| `POST /api/v1/sessions/{ident}/handoff` | 200 / 200 | 404 / 404 | 字段或持久记录差异 | db/events/0/after/data/$serialized_json/actor (仅 TS) |
| `POST /api/v1/sessions/{ident}/messages` | 200 / 200 | 409 / 409 | 字段或持久记录差异 | body/id |
| `POST /api/v1/sessions/{ident}/reconcile` | 200 / 409 | 422 / 422 | 行为差异 | body/codex_thread_id (仅 Python) |
| `POST /api/v1/subscriptions` | 200 / 200 | 422 / 422 | 业务抽查通过，响应头有差异 | headers/cache-control (仅 TS) |
| `POST /api/v1/tasks` | 200 / 200 | 422 / 422 | 字段或持久记录差异 | db/events/0/after/id |
| `POST /api/v1/tasks/{ident}/acceptance` | 200 / 200 | 409 / 409 | 字段或持久记录差异 | db/events/0/after/id |
| `POST /api/v1/tasks/{ident}/controls` | 200 / 200 | 409 / 409 | 字段或持久记录差异 | db/events/0/after/id |
| `POST /api/v1/tasks/{ident}/messages` | 200 / 200 | 409 / 409 | 字段或持久记录差异 | body/id |
| `POST /api/v1/tasks/{ident}/project` | 200 / 200 | 409 / 409 | 字段或持久记录差异 | db/events/0/after/id |
| `POST /api/v1/tasks/{ident}/reconcile` | 200 / 200 | 422 / 422 | 字段或持久记录差异 | db/events/0/after/id |
| `POST /api/v1/tasks/{task_id}/deliveries` | 200 / 200 | 422 / 422 | 业务抽查通过，响应头有差异 | headers/cache-control (仅 TS) |
| `PUT /api/v1/event-rules` | 200 / 200 | 422 / 422 | 字段或持久记录差异 | db/governance_audit (仅 TS) |
