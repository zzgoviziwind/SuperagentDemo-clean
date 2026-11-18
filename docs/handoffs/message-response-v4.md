# 消息响应 v4 接口契约

## 总控/前端接入点

- 新增持久设置 `dingtalk_response_policy`，值 `{direct_messages:"reply"|"off",group_messages:"mentions"|"requests"|"off",delivery:"draft"|"approved_send",default_project_id:正整数|null}`。默认私聊 reply、群聊 requests、交付 draft、默认项目 null。旧 dingtalk_route_all_mentions=true 在未保存新策略时迁移为群聊 mentions。总控在 governance 调用 `message_policy.validate_policy(value)` 验证，snapshot 未有新key时由本模块兼容读取。
- 交付 draft 只生成草稿并在后端拒绝发布。approved_send 指生成草稿后由用户明确审批并通过原 publish 入口发送。两种模式均不自动外发。
- DWS 本机 schema 已核验 `user_im_message_receive_o2o_all` 明确表示全部单聊，元数据输出 `conversation_type:"direct"`、`dws_event_type`。不根据显示名或 CID 外形判断私聊。Listener 允许 kind=all-direct。请总控修改 connections 配置校验/启动支持 all-direct，并明确历史恢复边界（现 history.py 仅原有 at-me/group，不能把历史未知类型伪装成已识别私聊）。此会话不修改 connections/history。
- 私聊存在明确项目绑定时优先该绑定，无绑定且策略配置 default_project_id 时用此项目；仍检查项目启用、actor映射、project_ids与request权限。多项目绑定冲突继续阻止。
- 提供 `await superagent.core.reply_worker.run_reply(scheduler, task_id)`。总控 Scheduler.run 最前读取kind，reply派发到此入口，跳过Git工作区准备和项目测试；Task schema/创建验证需接受reply。总控提供本机引擎helper供 reply_worker 调用，具体接口待核对。
- reply Worker 使用独立受管空目录、持久Codex thread/turn、read_only模式与工具请求拒绝。引擎需支持 tool-less参数，从运行时禁用原生命令/文件能力。总控请将 runtime/codex.py 的 `start_thread`/`resume_thread` 增加 `tool_less=False` 并确定性禁工具；reply强制 `read_only=True,tool_less=True`，若尚未支持则waiting_resource。不会仅凭提示词声称已禁工具。
- 回复结果持久化 summary/assistant_message 与原来源 ReplyDraft/Approval。状态 review_ready 表示回复草稿可审核；原渠道发送仍走现有审批/账本/publish。后续私聊同一actor/会话/项目可跟随未结束reply任务，保护未知结果与版本失效。

## 交接说明

实现与验证记录见下文。开发不监听真实账号、不向真实钉钉发送。

## 已确认总控配合

reply_worker 已使用 `core.model_usage.reserve_model_run` 与 `core.local_agents.client_options()`，支持已明确连接的本机订阅账号与专用账号目录。暂停/改目标通过共用 scheduler.clients 与版本栅栏，续聊优先恢复已绑定禁工具模式的线程；旧非reply线程会新建并保留旧证据。

普通已识别私聊走确定性 reply，避免被旧语义闲聊忽略规则吞掉；显式分析/修复仍交给原任务路径。策略先于订阅检查，off不会通过旧引用绕过。群聊保留旧语义分派与明确请求兼容行为。

## DWS 同时监听私聊与群聊的核验结果

本机实际执行 `dws schema --cli-path "event +listen-im" --compact --format json`，返回 parameters.kind.type="string"，enum=["at-me","sender","group","all-direct","all-group"]。没有 all / all-messages / 多kind 参数，events 数组只选 message/reaction/read/recall。此证据确认应由总控 connections 聚合两个 listener（原 at-me/group 与新增 all-direct）；不要配置伪造 all-messages 参数。全部单聊事件 schema `dws event schema user_im_message_receive_o2o_all --flatten --format json` 明确 description="当前用户收到的所有单聊消息"，type 固定该 event_key。

## 当前已实现与总控验收接口

- `run_reply(scheduler,task_id,client_factory=None)` 已落地，调度器已由总控接入。强制 `read_only=True,tool_less=True`，模型看到当前消息上下文；无需仓库存在、Git工作区或项目测试命令。回复超时环境键 `SUPERAGENT_REPLY_TIMEOUT` 默认240秒，受管目录 `SUPERAGENT_REPLY_ROOT` 默认 data/replies。
- 复用 tasks、events、artifacts、reply_drafts、approvals，无新增数据库表。持久 `reply_tool_less_bound` 将恢复线程限定为本模块已绑定模式的线程；thread/turn/assistant_message/summary均保存。
- verification JSON 使用 `{kind:"reply",tool_less:true,thread_id,turn_id,turn_status:"completed",draft_created:boolean}`。由总控 main 的reply验收分支检查当前revision的summary及verification。工具请求拒绝与原生工具活动保存 reply_tool_denied，未知结果保护不自动重放。
- 私聊同一profile/CID/actor/项目复用reply任务。新消息使旧revision/control与草稿审批失效；review_ready或正在答复的旧轮次会排队新轮次，Scheduler.active避免并发创建第二个本机Worker。paused仍等待显式恢复。未知结果阻止路由。
- 原渠道草稿目标保留profile/CID/message ID，并对私聊额外保存recipient_id（真实sender_open_dingtalk_id）。DWS发送传 --open-dingtalk-id，CLI核验消息与会话归属；逐条批准、启用外部交付、确认账号匹配后才可发。开发使用fake runner，未发真实渠道。
- 引用已确认发送答复的续聊通过DeliveryRecord中实际message_id反查，且核对原会话、profile、私聊recipient和项目；未知发送不推断成功。
- 草稿生成与当前revision答复在同一事务，缺少来源账号/目标时保留答复和失败说明，任务waiting_input；可修配置后手动生成草稿。unknown任务不能批准或发布旧草稿。

## 验证进展

第一批私聊+现有连接器/交付回归112 passed（另有4 subtests）。补充正常HTTP入口及服务重启续聊后12项消息响应测试通过。离线协议进程显式UTF-8；首轮此测试的中文stdin编码失败已修正测试进程设置，未把失败计为通过。引用已发答复与最终回归继续检查。

## 运行时与监听器集成边界

reply_worker 已强制请求 tool_less/read_only 并在可见事件中阻止动态工具、审批和原生工具活动，遇到此类事件进入unknown。当前所读 runtime 的 tool_less 实现取消动态工具绑定并选择只读沙箱；原生工具禁用强度的进一步验证归本机Agent运行时会话，不能把本模块协议标记当成操作系统层无工具证明。只读文件写入边界应保留其负向回归。

群聊 mentions 必须消费 DWS at-me 类型证据，不能用群消息正文中的“@”文字推断。若连接器配置为普通 group，它的原始类型只证明群消息，不能自行将某条认作提及本人。总控聚合监听器应按策略选择 at-me/group 与all-direct，避免同一条消息先按群流ignored再被at-me流去重而遗漏。

## 验收补充修正

已核对订阅派生消息确为 `routing_status=delivered`。reply_source_allowed 同时接受 routed 来源与具有 EventTarget 精确绑定的 delivered 派生消息，reply_worker 按最新目标消息选择草稿来源；不接受任意伪造delivered。多目标回归断言每个草稿 event_id 为对应派生 message_event_id，Approval.target.message_id 为最新原消息ID。

交付策略现在有后端强制区别。draft只生成草稿，即便旧草稿已被批准，publish仍拒绝；approved_send允许在逐条批准、渠道启用、外部交付开关和动作版本全部通过后发送。publish入口与PersistentActionLedger.claim再次检查当前策略，阻止检查后切回draft的发送。返回已有发送账本仅查询原结果，不重新发送。

DingTalkListener已按本机schema最小放开all-group（无chat_id），历史恢复类型维持原范围。组合监听归总控本机Agent会话。老交付测试fixture已显式选approved_send以验证发送路径；新增draft策略拒绝发布回归。

## 稳定重启验收点

本模块实现已稳定，可重启预览服务以同时加载 delivery.reply_source_allowed 与 reply_worker。长驻旧进程的模块缓存可能与新函数导入不一致，重启后复验 task2 的reply执行。接下来仅补验收记录，不再变更实现，除非发现实际失败。

最终扩大回归 `.venv/Scripts/python.exe -m pytest tests/integration/test_message_response.py tests/integration/test_routing_delivery.py tests/connectors/test_connectors.py tests/connectors/test_quotes.py tests/integration/test_subscriptions.py -q --basetemp=.pytest-message-response-v4-verified --tb=short` → 138 passed，11 subtests passed。新增明确设置approved_send的旧发送fixture，以及组合私聊/群聊监听的两次start/stop预期均通过。唯一警告为现有Starlette/httpx弃用提示。

旧版本因新消息而失效、但其引擎停止又未确认时，保留新目标与revision，同时标记整个reply任务outcome_unknown，阻止新版本自动继续。相关负向回归随最后单模块检查收尾。

最后单模块检查 `.venv/Scripts/python.exe -m pytest tests/integration/test_message_response.py -q --basetemp=.pytest-message-response-v4-close --tb=short` → 18 passed，含旧轮次停止失败保护、订阅双目标最新消息草稿、draft与approved_send实际发布边界、服务重启后同线程续聊。代码稳定，可以统一重启和全套回归。

真实钉钉监听/发送未在本会话执行；真实Codex模型复验由总控完成并另行记录。模型只读权限与工具活动拒绝的能力边界已单列说明。没有自动发送模式，approved_send也必须逐条明确批准。

## v4 真实路由检查证据挂接

总控真实trace指出 semantic_pending 阶段 actor 尚未写入event.data时，旧trace只能显示持久配置快照。现已在 `_route_impl` 每个实际执行的检查点挂接 `_routing_evidence`，由现有生命周期hook合并到本次fast_filter.detail。无新增表、无历史记录改写。

- resolved_actor 仅保存本次resolver实际返回的 user_id/role/enabled/project_ids/permissions，validated_actor_user_id 在映射与启用验证通过后设置。
- effective_response_policy、policy_allowed、conversation_type记录实际调用策略值与决定，settings_provider区分callback/database；persisted_response_policy继续表示持久快照。callback覆盖默认项目时，default_project_match明确保存本次实际查到项目。
- external_project_candidates/project_matches保存实际外部绑定候选，project_candidates保存fallback后候选，project_selection_source区分external_binding/configured_direct_default/none；default_project_fallback标记是否真正执行默认项目查询。
- authorization保存实际角色、项目grant、request权限三个规则的结果；checks含每个已执行检查的规则标识和结果。未执行的项目/策略字段为null，authorization.status=not_evaluated，不添加对应检查条目。
- blocked_reason在实际拒绝点保存。即使事件停在semantic_pending，也保留完整已执行的身份、策略、项目与授权证据。

专项 `.venv/Scripts/python.exe -m pytest tests/integration/test_message_response.py -k trace -q --basetemp=.pytest-message-routing-evidence --tb=short` → 5 passed，18 deselected。覆盖语义排队callback策略与持久策略差异、禁用身份、策略拒绝、grant拒绝、callback默认项目与未授权范围。扩大回归进行中。

### 路由证据扩大回归与独立trace问题

扩大回归 `test_message_response.py test_semantic_routing.py test_lifecycle.py test_routing_delivery.py` → 134 passed，1 failed。唯一失败为 `tests/integration/test_semantic_routing.py::test_management_api_and_trace_are_usable`，`superagent/api/lifecycle.py:142 _watchdog_runs` 在独立测试数据库未创建 watchdog_runs 表时执行查询，抛 sqlite OperationalError。此错误发生在trace读取Watchdog记录，新增5个路由证据专项均通过。请总控/生命周期所有者修复 WatchdogRun 的模型注册/建表依赖或明确的历史缺表读取兼容，勿把无表当成真实零次巡检。按此次所有权限制，本会话未修改api/lifecycle.py、watchdog.py或语义测试。

本次实现仅变更ingestion的证据挂接及其同文件已执行授权谓词的记录，相关test和本交接更新。源代码已可稳定重启验收。
