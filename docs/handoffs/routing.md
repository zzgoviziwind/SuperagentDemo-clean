# 事件路由、收件箱与交付集成

> 总控最新结论：本文件按时间保留模块开发记录，后续真实 Codex、渠道、浏览器及最终回归结果见 [总控验收报告](../验收报告.md)。历史未验收说明不覆盖该报告。

更新于 2026-11-13。本轮已冻结新增功能，仅处理验收缺陷。代码修改位于分配范围，提交由总控处理。

## 当前接入状态

- main 已注册 api.connections.router，overview 使用 manager.statuses()，lifespan 已调用 manager.start()/stop()。新增表继承现有 Base，模块在 init_db 前导入。
- 事件以 source/external_id 唯一键持久去重。治理 resolve_actor 必须返回 admin/member 角色、明确 project_ids 和 request 权限。群或 Redmine 项目绑定必须唯一且启用。
- 新任务同时设置 Task.owner_id 与 TaskOwner，关联已有任务统一读取治理 task_owner。工单号跨来源关联同任务，completed/cancelled 新需求另建关联任务。
- 每条钉钉消息均登记任务别名，包括带工单号的原消息和后续回复。别名绑定 profile、会话与 message_id，明确引用可连续关联同任务。引用与工单号冲突、目标不存在或跨群/跨账号目标均保留待确认。旧数据从已路由原事件恢复别名，终态引用跟随最新关联任务。
- 明确仅分析、只读、不修改代码的外部请求设置 kind=analysis。明确修复/修改等设置 repair，二者同时出现进入 pending_confirmation，原因 conflicting_analysis_and_write_request。没有明确类型的新请求沿用 repair 默认，普通续接保留原 kind，后续明确改变类型递增版本并使旧审批失效。分类仅使用确定性文字规则。
- 后续消息递增 revision/control_version，使旧审批失效，活动或待验收任务进入 waiting_input。提交后异步调用 scheduler.stop_run(task_id,'change_goal')，回执先返回。
- 回复经过草稿、明确批准、持久发送账本。发送要求连接器 enabled=true 与 external_delivery_enabled=true。未知结果保留对账，既有动作不会自动重发。
- Redmine 已接入发送回声识别，发送 claim 保存 sender_actor_id，具体 ReplyDraft/Approval/DeliveryRecord 严格匹配端点、工单、当前账号、正文与动作哈希。常规窗口为 claim 后120秒内，另支持 claim 前30秒的有界服务端时钟差，且须无业务字段变更或新附件。负时间差始终只记候选，超过前30秒或后120秒正常路由。DeliveryEchoBinding 唯一约束保证一个发送动作仅绑定一个 journal，一个 journal 仅绑定一个发送动作。
- 非负时间窗内成功送达对应 self_echo，unknown 或负时间差对应 self_echo_candidate。事件、发送账本 echo_evidence 与 Audit 留痕，不创建任务、不递增任务版本，也不可基于回声创建回复草稿。unknown 保持未知，不自动重发或改成功。整秒同秒候选 reason 为 source_second_precision_overlap，其余负时间差候选 reason 为 source_clock_skew_overlap；unknown 的主要 reason 为 write_outcome_unknown，elapsed_seconds 保留精确时间差供核验。
- 整秒精度按解析后的 occurred.microsecond == 0 判断，覆盖 Poller/common.timestamp 将整秒统一为 .000000Z 的格式。claim 为同秒 .500000、journal 为 .000000Z 时保留候选语义。
- Redmine/DWS 附件、history replay、管理员收件箱及重路由已接入。scheduler 已读取 source_attachment Artifact 并向 start_turn 传图片路径和附件根目录。

## API 与权限

连接器读取和草稿读取沿用治理读取权限。收件箱、事件注入、重路由、附件重试和连接器启停限定 admin。草稿创建、审批、发布和对账要求 owner/admin。

| 方法 | 路径 | 请求或响应 |
| --- | --- | --- |
| GET | /api/v1/connectors | 状态数组 |
| POST | /api/v1/connectors/{name}/{start或stop} | 无正文，start 仍需明确启用 |
| POST | /api/v1/events | 统一事件，重复返回原记录及 duplicate=true |
| GET | /api/v1/events | routing_status 默认 pending_confirmation，也支持 routed，after 默认0，limit 默认50、范围1–100 |
| POST | /api/v1/events/{id}/retry-routing | 无正文，重新核验原事件并记录 Audit，已路由返回 duplicate=true |
| POST | /api/v1/events/{id}/retry-attachments | 无正文，明确重试 failed 附件任务并记录 Audit |
| POST | /api/v1/tasks/{id}/deliveries | {event_id,content}，返回草稿及 approval |
| GET | /api/v1/tasks/{id}/deliveries | 草稿及发送账本 |
| POST | /api/v1/deliveries/{id}/decision | {decision,action_hash} |
| POST | /api/v1/deliveries/{id}/publish | 无正文 |
| POST | /api/v1/deliveries/{id}/reconcile | {outcome,evidence} |

收件箱返回 {items,next_after,has_more}，items 为 Event 对象，按 id 升序。data.routing_reason 给出待确认原因。补齐身份或项目绑定后，对原事件 retry-routing，保持原外部标识。模糊或未授权事件继续待确认。

收件箱 routing_status 另支持 self_echo / self_echo_candidate。回声事件保留原 journal 内容并关联原任务，data.delivery_action_id、echo_journal_id、echo_reason 给出判定依据。绑定之后另一 journal 的同文评论、同账号不同内容、120秒外的同文评论、不同端点/工单/账号、附带业务字段变更或附件，均继续正常路由。旧账本缺少发送账号快照时不自动认定自身回声。

发送前需重启或调用现有 init_db 创建新增 delivery_echo_bindings 表，真实服务应使用更新后的代码和表结构。本轮所有验证使用离线假服务。

## 配置

治理 settings 已支持 connectors.dingtalk 与 connectors.redmine，复用 connections.validate_configuration。数据库优先，环境入口为 SUPERAGENT_DINGTALK_CONFIG / SUPERAGENT_REDMINE_CONFIG，值为 JSON 对象，默认禁用。凭据只通过环境变量引用。

- 钉钉字段包括 enabled、executable、profile、self_ids、kind、chat_id、history。group 对应明确单个 chat_id。
- Redmine 字段包括 enabled、base_url、project_ids、user_id、api_key_env、poll_seconds、initial_since、account_map。api_key_env 默认 HLZJ_REDMINE_API_KEY。
- history 包含 chat_ids、initial_since、history_timezone、sender_map、page_limit、timeout。最多100群，各群具有唯一启用项目绑定，group 的历史范围等于监听群。initial_since 必须有时区。history_timezone 支持 UTC、+08:00 等偏移或系统可用 IANA 名。page_limit 为1–40，默认40，timeout 为1–300秒，默认120。
- manager 已构造 DingTalkHistoryReplay 传 listener.replay。首次用明确初始边界，后续用持久游标。分页不完整或范围不匹配时失败关闭。省略 history 时，断线或带游标重启进入 waiting_recovery。
- Redmine manager 已将 PersistentStateStore.load_snapshot 传给 Poller。回调以只读 SELECT 读取最近来源快照，严格匹配 endpoint、issue、project_ids 和 external_user_id，按 Event.id 倒序取1条。兼容顶部 event_type 已改为 message 而 data.original_event_type/data.event_type 保留 issue.updated 的旧记录，返回 event.data。连接器负责重建语义指纹，正文未变时跳过升级重复快照，真实变化继续发出。

## 附件与状态保护

EventAttachmentJob 持久记录 pending/processing/completed/failed。根目录取 SUPERAGENT_ATTACHMENTS_ROOT，默认 ./data/attachments。执行上下文只引用下载 helper 验证产生的本地路径。

- Redmine 再取已绑定工单详情，按事件附件 ID 选择可信清单，再核验同源、附件路由、大小、格式和文件名。一般文件上限20 MiB，声明图片上限10 MiB。
- DWS 使用明确账号、会话和消息下载，复核完整性与返回作用域，仅接受受管目录内文件。每文件10 MiB，整批最多10文件与40 MiB。临时下载和网络字节采用监测预算，尚无硬网络字节限额。
- Artifact.kind 为 source_attachment，revision 为来源版本，content 为 JSON {local_path,filename,size,content_type,sha256}。当前版本增加 canonical message 上下文。scheduler 读取图片后传 image_paths 与 attachment_root。
- 恢复 queued 使用数据库条件 UPDATE，同时匹配 revision、control_version、waiting_resource 及附件等待原因。pause/cancel/改目标后，旧 job 无法覆盖新状态。
- 重启遗留 processing 直接 failed，事件显示结果未知，匹配附件等待的任务转 waiting_input，需管理员明确 retry-attachments。pending 可恢复处理。
- data.attachments_status 与 attachments_error 供界面展示。失败附件可重试，暂停状态保持暂停，终态、运行中和待审批拒绝附件重试。

## 后台资源退出

每个 ConnectionManager 独立持有 _attachment_tasks、_interrupts、轮询和关闭任务。停止另一实例不会取消本实例任务。

- 完整 stop 拒绝新后台调度，取消本实例附件及中断任务一次，保留清理等待。重复 stop 不再次打断清理。
- Redmine 通过停止事件自然退出，在途 HTTP 保留所属轮询协程引用，完成后关闭客户端。
- 总等待预算默认35秒。超时返回 RuntimeError，保留尚未完成任务及线程所属协程引用，状态显示 stop_failed，拒绝旧资源退出前重新启动。资源完成后可再次 stop。
- 生命周期应通过 finally 确保 scheduler.close() 在 manager.stop() 报错时仍执行。超时代表资源尚未确认退出，需要核验。

## 验证

最新真实只读调查使用 SQLite mode=ro。reply-1 的 claim 为 2026-11-13T09:30:21.414879+00:00，journal51886 为 2026-11-13T09:30:19.000000Z，elapsed=-2.414879秒。SQL候选1条，配置账号、发送账号、端点、工单、草稿正文、payload正文及动作哈希全部匹配，未命中原因是旧容差仅1秒。此次未修改真实数据库或调用外部写接口。

最新必要回归命令为 `.venv/Scripts/python.exe -m pytest tests/integration/test_routing_delivery.py -k 'redmine_write_echo or redmine_echo_requires or redmine_poll_after_write or seconds_precision_overlap or bounded_clock_skew or restores_legacy_redmine_snapshot' -q --basetemp .test-tmp/routing-upgrade-clock-final`，28 passed、44 deselected（7.58秒）。覆盖真实时差的假服务 Poller 链路、前30秒/后120秒的精确边界、unknown保持未知，以及正式 manager 接线的历史快照恢复、跨端点/项目/工单/账号隔离、只读最新事件选择和真实正文变化继续路由。真实事件86/87保留原状态，归类修复由总控备份后处理。

随后只读核验正式库，load_snapshot 找到 #24701 的历史 issue.updated，restore_issue_checkpoint 成功，重建 fingerprint 与历史 metadata 一致。最终 LIMIT 1 查询复核为1 passed。总控独立副本重放进一步确认两轮 Poller 后任务数2、task2 revision1/control2 稳定，唯一新回执为 journal51886 的 self_echo_candidate，elapsed=-2.414879；重放使用数据库副本及已读取 issue，无外部写入。总控将对正式事件追加更正归类与审计，保留历史 revision3。当前代码冻结。

最后 P1 修订仅运行必要回声回归，命令为 `.venv/Scripts/python.exe -m pytest tests/integration/test_routing_delivery.py -k 'redmine_write_echo or redmine_echo_requires or redmine_poll_after_write or seconds_precision_overlap' -q --basetemp .test-tmp/routing-echo-normalized-final`，16 passed、44 deselected（6.27秒）。新增真实 RedmineClient 假 HTTP 写入→RedminePoller→ingest→delivery 链路，输入 journal.created_on 为整秒 Z，确认规范化为 .000000Z 后仍记录 self_echo_candidate，任务数、revision/control_version 保持原值，已成功账本维持 succeeded 并保留候选证据。此次代码修改仅 delivery.py 的整秒判定，连接器文件保持现有实现。代码已冻结。

消息别名修订后，`.venv/Scripts/python.exe -m pytest tests/integration -q --basetemp .test-tmp/routing-alias-regression` 为36 passed（16.27秒）。中断派发测试显式使用独立 manager 与测试 settings，应用 manager.stopping 不会污染其他实例测试，产品停机拒绝派发规则保持现有行为。

历史分类修订命令 `.venv/Scripts/python.exe -m pytest tests/core/test_structured_e2e.py tests/integration/test_routing_delivery.py tests/review/test_artifact_exports.py -q --basetemp .test-tmp/routing-kind-main-final -o faulthandler_timeout=45` 为49 passed（47.96秒），对应回声修订前版本。

回声修订的主流程、业务集成、导出和连接器联合回归为 `.venv/Scripts/python.exe -m pytest tests/core/test_structured_e2e.py tests/integration/test_routing_delivery.py tests/review/test_artifact_exports.py tests/connectors -q --basetemp .test-tmp/routing-echo-main-final -o faulthandler_timeout=60`，119 passed、47 subtests passed（100.43秒）。随后新增附带附件、账号变更两个边界用例并补充审计字段，最终业务集成命令为 `.venv/Scripts/python.exe -m pytest tests/integration/test_routing_delivery.py -q --basetemp .test-tmp/routing-echo-audit-final`，59 passed（18.34秒），1项现有 Starlette/httpx 弃用提醒。

回声测试覆盖实际 RedmineClient 假 HTTP 写入→RedminePoller 回读→ingestion 的完整闭环，回读时任务 revision/control_version 不变，updated_on 独立变化不会生成新快照；成功、unknown 和终态任务均不新建/修改任务。另覆盖同账号不同评论、第二个同文 journal、端点/工单/账号/时间/发送结果/业务变更/附件不匹配、发送账号变化，以及回声候选先于最终网络结果返回时的证据保留。整个过程未向真实外部渠道写入。

另一次广义 `pytest tests` 在连接器阶段停滞，已停止，未取得全量结论。当前仅以已完成命令结果作为验收依据。

前次完整冻结回归为 `.venv/Scripts/python.exe -m pytest tests/integration tests/connectors -q --basetemp .test-tmp/routing-freeze-full`，76 passed、36 subtests passed，耗时82.99秒。该结果属于消息别名修订前版本。

业务集成覆盖真实治理授权、任务归属、收件箱分页与审计、并发去重、终态关联、审批发送及未知结果、假 HTTP 附件、DWS 历史与图片子进程、暂停/取消/改目标后的迟到附件、重启 processing 失败、本实例有界退出，以及在途 Redmine HTTP worker 停止超时保留引用并在完成后正常收敛。

历史阶段57项联合和25项业务测试仅作为此前版本记录，当前以最新冻结回归为准。现有 Starlette/httpx 会产生一项弃用提醒。

## 待验收

- SQLite 已验证，PostgreSQL 并发与迁移待验收。
- 真实钉钉、Redmine、实际业务附件及真实账号缺口恢复待联调。测试均为假 HTTP/DWS，开发未发送真实群消息或评论。
- 图片已接调度器，真实模型读取业务图片待验收。
- 部署采用单 worker，多进程连接器租约尚未实现。
- 本地身份核对中，当前源码 authenticate_request 的无凭据本地用户返回 admin，_known_user 也认可 admin。local-admin 保留为历史 Task.owner_id 默认值，task_owner 已兼容历史 TaskOwner。若运行服务 /auth/me 仍返回 local-admin，应先核验运行版本并重启，当前源码无需扩充外部映射身份别名。
