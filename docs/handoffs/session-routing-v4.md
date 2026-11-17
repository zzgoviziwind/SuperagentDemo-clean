# 路由会话 v4 接口合同

## 前端与总控集成合同（先行）

- 统一会话新增 `semantic:{event_id}`，`kind=routing`，对应真实来源事件的 AI 判定，保留独立项目讨论 `router:{project_id}`。GET /sessions 列出管理员可读的事件路由会话，GET /sessions/{id} 返回 `{session,messages,transcript}`。
- session 含 `event_id,project_id,status,codex_thread_id,codex_turn_id,state_version,outcome_unknown,mode,worker_session_ids`。无 AI 记录的规则直通事件通过 trace 的 routing_session_id=null 和 routing_mode=rules 标明。
- messages 含 `id,role,content,created_at,data`，首次真实输入 JSON 文本、每条实际可见模型输出、人工复核与纠正系统记录按顺序持久。已有 v3 记录从已保存 context/output 作为历史快照读取，并标明完整性。
- `POST /sessions/semantic:{id}/messages {content,expected_state_version}` 保存人工发言并在原真实 Codex thread 上追加复核轮次。新判定仍通过确定性权限/版本检查。已应用事件只讨论及提出建议，同事件不会再次产生任务。未知轮次需要先核验。
- `POST /sessions/semantic:{id}/reconcile {evidence,expected_state_version}` 管理员确认未知轮次已退出，保留未知消息，不自动重放。
- `GET /sessions/{id}/transcript` 只读取平台拥有的 thread，输出 `{session_id,thread_id,source,complete,items,reason}`，items 为真实可见 user/assistant/tool items。读取失败回退持久化消息并明确 complete=false，历史摘要不能算完整 transcript。
- runtime 合同为 `await client.read_thread(thread_id, include_turns=True)` 返回 `{thread:...}`（含 turns/items）；本模块只读取数据库所属 thread ID，不接受外来任意 thread_id。由本地代理会话提供 runtime 方法。
- 事件 trace 新增 `routing_session_id,routing_mode,worker_session_ids`。规则步骤 detail 增补本次真实检查依据和生效配置，历史缺失明确标注。
- 判定 kind 支持 `reply|analysis|repair`。reply 用于直接答复且无需代码，analysis 用于调查，只有明确代码修改意图可以 repair。下游 Task/API/Scheduler 支持由对应所有者集成。
- 新增表使用 metadata.create_all，无旧表改列。semantic session/message 模型会放在 core/sessions.py 并由 semantic_routing 导入，main 现有 import 顺序可注册。

## 实施与验证

本模块实现完成，验证记录见文末。

## 实时集成补充

- Codex 读取现按已发布合同调用 `read_thread(thread_id, include_turns=True)` 并解包 `{thread:...}`。模型、复核和 transcript 新连接统一使用 `core.local_agents.client_options()`；预算使用 `core.model_usage.reserve_model_run()`，订阅账户返回 id=null 时跳过金额结算。
- `core.lifecycle.record_attempt` 自动保存输入、当前绑定项目、数据库内非秘密设置快照。策略会话可在执行检查时附 `event._routing_evidence={...}`，此字典会合并入 fast_filter.detail，用于保留回调配置/确切策略命中/已解析权限等实际依据。数据库设置字段名为 persisted_settings，避免误称连接器临时 override 为数据库值。
- context 新增 shared_state，含授权任务的近期 summary 结果及显式订阅引用。自然语言复核会刷新当前授权任务、版本与共享状态，同时保留首次模型输入。

## 当前行为与测试说明

- 复核消息为持久队列，后台现有 start()/close() 自动消费。未应用判定可以在同线程复核后实际应用；已应用事件只保存 suggestion，不重复创建或再次投递。原始 context 保持原值，复核各轮实际输入保存在 user 消息的 data.model_input。
- 结果未知先通过 semantic 会话 reconcile 核验，未知旧轮次与此前排队消息不会自动重放，新提交复核才继续。session.state_version 用于人工发言并发检查。
- 真实 transcript 只从平台数据库所属 thread 读取，过滤内部 reasoning，显示可见 user/assistant/tool items；缺线程或读取不可用返回完整性 false 及平台保存记录。没有真实 AI 调用的 trace routing_session_id 为 null，routing_mode 为 rules。

### 字段确认

Worker session 新增 `task_kind=reply|analysis|repair`，`kind` 继续为 worker。routing/jobs 各记录新增 routing_session_id，可直接跳转统一会话。路由会话 kind 为 routing，平台 id 前缀为 semantic；项目讨论仍为 router 前缀与 router kind，名称应保持含义清楚。

### 交给钉钉策略会话的精确检查证据挂接

`record_attempt` 已支持 `event._routing_evidence`，请 ingestion 在 resolve_actor / response_policy / 项目授权各检查实际执行后写入该字典（只放非秘密输入、当前已解析 user_id/role/project_ids/permissions、选中项目与 fallback 来源、实际生效策略及允许结果）。生命周期函数会把它合并入本次 fast_filter.detail；当前自动保留的是持久配置与项目绑定快照，配置回调 override 的实际值需要检查执行点提供，不能由展示端反推。

- 模型输入增加 source/conversation_type/source_policy，私聊回复策略明确允许问候和普通问答进入 reply。人工复核的实时范围校验也兼容私聊默认项目 fallback，并重新检查当前消息响应策略。
- 会话与 trace 提供 ai_invoked（已有真实 turn_id）及 mode/routing_mode=agent|pending|unknown|rules。预检后规则直通且没有真实模型轮次的记录明确为 rules。

## 完成项与验证记录

- 来源事件的实际判定接入统一会话 semantic:{event_id}，平台持久输入、全部可见助手输出、真实 thread/turn、各轮输入、判定及人工纠正记录。
- 持久复核队列恢复原真实 Codex thread。未应用事件的新结构化决定会经过原 ingestion 权限/版本/状态围栏后执行；已应用事件的后续轮次仅记录建议，同事件不再创建或重复投递。
- 首次输入保存开发者指令，恢复旧线程标记 inherited_thread，历史只存在 context/output 时标注 historical_snapshot，不声称已还原缺失会话。
- 会话 transcript 从平台已绑定线程调用 Codex thread/read(includeTurns=true)，展示可见用户/助手/工具项目；无真实线程/读取失败返回 complete=false 与原因。工作台可通过该接口读取真实对话。
- 模型上下文包含授权任务、版本、最近结果、订阅引用和消息响应策略；人工复核刷新共享状态。reply/analysis/repair schema 已支持，Worker 会话提供 task_kind。
- 连接使用 local_agents.client_options，订阅/按量计费使用 model_usage.reserve_model_run，保持按量预算保护并允许已验证本机订阅账户运行。
- 全路由/会话/原投递回归 `.venv/Scripts/python.exe -m pytest tests/integration/test_lifecycle.py tests/integration/test_semantic_routing.py tests/integration/test_subscriptions.py tests/integration/test_sessions.py tests/integration/test_session_routing_v4.py tests/integration/test_routing_delivery.py -q --basetemp=.test-tmp/session-routing-v4-4`，140 passed。其后 task_kind、私聊上下文和真实 AI 标记追加模块复验。
- 最终模块复验 `.venv/Scripts/python.exe -m pytest tests/integration/test_session_routing_v4.py tests/integration/test_lifecycle.py tests/integration/test_semantic_routing.py tests/integration/test_sessions.py -q --basetemp=.test-tmp/session-routing-v4-7`，46 passed，1 条既有 TestClient/httpx 弃用提示。
- 新增 10 个 v4 用例覆盖同线程恢复、每轮消息去重/持久化、自然语义复核后实际应用、已应用事件只建议、未知核验及不重放、更新后版本、共享结果、权限、过期会话版本、reply schema、私聊默认项目、所属真实线程读取及内部项目过滤、历史不完整说明、Worker kind 字段。Codex 适配器测试使用离线替身；本会话尚未独立执行 v4 的真实账号两轮联调。
- 原文章本机全文已核对，采用第3节的程序准入→语义判断、订阅直通分支，输入纳入项目共享状态，未将注释 %% 部分当原文章要求。事件语义线程和项目讨论线程如实分开，未伪造共享 thread。
- 最后异常事实保留调整后，单独复验 test_session_routing_v4.py，10 passed。复核后若任务已应用而事后投递报错，job 保持 applied，conversation 标记未知待核验，防止误称尚未应用。

## 任务完成瞬间 transcript 读取竞争修复

- 活动执行客户端的 read_thread 失败后，同一 HTTP 请求通过独立只读 reader 重连一次，读取相同已绑定 thread_id 的可见记录。成功返回 complete=true。
- reader 沿用本机已选择账号的 client_options，只调用 start/read_thread/close。原执行客户端由调度器继续管理，任务、轮次和版本均不写入。
- 远端绑定的 Worker 活动连接读失败后保持现有远端读取边界，返回远端暂不可用说明。独立 reader 失败时不继续重试，关闭 reader 后返回平台历史与 complete=false。
- 新增竞争测试覆盖 running/review_ready 两种状态、四条跨两轮消息完整返回、仅一次重连、任务状态/版本不变、远端阻止本地 reader、reader 失败后清理且无进一步重试。
- 验证 `.venv/Scripts/python.exe -m pytest tests/integration/test_session_routing_v4.py tests/integration/test_sessions.py -q --basetemp=.test-tmp/session-routing-v4-close-race-1`，18 passed。
- 本次竞争复现使用离线连接替身，真实账号完成瞬间的重读由总控继续验收。
- 独立抽取所有 transcript 用例复验（`-k transcript`），6 passed，覆盖测试模型独立注册场景。
