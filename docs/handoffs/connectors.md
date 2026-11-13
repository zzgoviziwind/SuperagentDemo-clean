# 消息接入交付

> 总控最新结论：本文件按时间保留模块开发记录，后续真实渠道及最终134项/58子测试联合回归结果见 [总控验收报告](../验收报告.md)。历史未验收说明不覆盖该报告。

日期为 2026-11-13。所有修改位于 `superagent/connectors/`、`tests/connectors/` 和本文件。代码仅使用 Python 3.12 标准库，Windows 本机假服务测试通过。

## 实现与入口

- `RedmineClient(base_url, api_key)` 提供异步 `list_updated_issues(updated_since, project_id=None)`、`get_issue(issue_id)`、`add_comment(issue_id, content)`、`assign_issue(issue_id, assignee_id)`、`close()`。未传可信动作授权时，评论和指派只返回本地预览。HTTP 请求使用超时、API Key 请求头、禁止重定向和完整分页，覆盖关闭工单。详情包含 API 可见 journals 和 attachments 元数据。
- `RedminePoller(client, emit, state_store, project_ids, user_id)` 扫描明确配置项目全部变化，随后判断当前指派、指派变更、描述和评论中的 @账号。通过 `account_map={"login": [external_user_id]}` 映射账号。零命中或包含本人且多命中的别名置 `needs_confirmation`。已明确映射其他人的提及不作为本人候选。`project_map={"3": "local-project-id"}` 只提供路由线索，控制层仍需校验身份与项目绑定。
- `DingTalkListener(executable, emit, profile=..., self_ids={...}, kind="at-me")` 支持个人 @我。指定群使用 `kind="group", chat_id="真实会话ID"`，每个群独立实例。`start()` 等待 stderr ready 并完成必要历史重放，`stop()` 关闭 stdin 并等待 DWS 清理订阅。自发消息按真实 openDingTalkId 过滤。返回 `status/last_error/last_seen` 供控制层构造 HTTP 状态。停机超时保留 `stop_failed`，需要宿主检查原进程后再启动。
- `DingTalkClient(executable="dws", profile=...)` 提供 `reply(conversation_id, message_id, content)`、`close()`。引用回复同时携带真实会话、源消息和动作幂等键，默认返回本地预览。CLI 返回未知投递状态时记录 unknown。

## 持久消费与恢复

`emit` 必须为异步函数，返回前完成持久化、业务身份校验、项目路由和 `(source, external_id)` 唯一键去重。正文中的指令作为数据处理。接入器不访问业务数据库。

`state_store.get(key)` 返回已提交值或 None，`state_store.set(key, value)` 返回前必须持久提交，支持同步或异步实现。每个监听或轮询配置由宿主管理一个活动实例。多进程部署由控制层获取租约后启动接入器。连接器内部锁只串行化同一个 poller 的 poll_once。

Redmine 游标键包含实例地址、项目 ID 集合和账号 ID。首轮通过可选 `initial_since` 设置回溯起点，省略则扫描全部可见历史。每轮起始时间作为下一游标，默认从上轮游标前 120 秒开始包含边界地查询。按不可变 ID 升序分页，避免更新时间变化导致已扫描记录在分页间移动。全部项目及其事件消费成功后才提交游标。任一获取、消费或游标写入失败将由下轮重放，评论使用 journal ID 加正文与详情摘要去重，重新检查旧评论以发现服务端未提供编辑时间的内容变化，工单快照使用更新时间去重。外部 ID 包含服务实例地址。服务时钟偏移及可见权限变更需要运营方配置回溯起点重新扫描。

DWS 使用 `state_store` 保存每次持久消费成功后的最大事件时间。`replay` 为可选异步回调 `await replay(checkpoint) -> list[原始扁平事件]`，必须提供 checkpoint 包含边界以来的完整历史，并对 CLI 历史查询的完整性、分页和授权范围负责。首次启动已有游标以及断线重连时，在消费新进程 stdout 前重放历史。缺少 replay 时，首次无游标监听可运行，断线或带旧游标启动会停在 `dws_disconnected_replay_required`。DWS 事件流缺少已核验的服务器持久 offset，控制层需接入授权历史查询后才具备离线缺口恢复能力。内存中未消费成功的事件保留供同实例重启再投递，进程崩溃依赖持久游标和历史重放恢复。

DWS 重连遵守 retryable=false 零次、true 两次、未知一次额外尝试，遵守 retry_after_seconds、next_retry_at 及保护状态，预算针对本次 start。宿主不能用新实例循环绕开预算。事件去重使用 profile、conversation_id、message_id，使 @我与群订阅的交叉投递保持同一业务键。原始 event_id 保留在 metadata。

## 外部动作授权与账本

先调用评论、指派或回复获取预览，其中 `action_hash` 绑定来源、目标、内容及账号或实例。控制层完成审批、身份、权限、版本及过期校验后创建 `AuthorizedAction(action_id, action_hash)`，再次调用同一接口并传 `authorization=...` 和 `ledger=...`。该类型仅作为可信服务内接口，不能由外部 HTTP 请求直接反序列化为已授权动作。

账本必须提供异步方法 `claim(action_id, action_hash) -> bool`、`get(action_id) -> dict`、`finish(action_id, result)`。claim 在跨进程共享存储中原子插入并提交 pending 行，已有 ID 返回 false。get 返回至少含 action_hash、write_status 的记录，pending 或崩溃遗留行使用 unknown。finish 持久保存结果。claim 成功以后才执行一次外部调用。既有动作直接返回账本记录，动作 ID 和内容冲突会阻断。超时、5xx、取消或写后解析失败均保留未知结果，禁止自动再发。失败动作也不使用同一 ID 自动重发。

Redmine 204 成功记录 `write_status=succeeded, verification=not_performed`。控制层可通过 get_issue 获取最新上下文核查。相同评论文本仅提供线索，结果未知仍须人工核查。DWS 超时后持续读取原进程结果直至退出，close 等待原调用结束。停止原调用不授权重新发送。

## 本机命令核对

已阅读已安装 dingtalk-event/chat/shared 和 hlzj-cli 指引，仅运行 Schema 和 Help，没有启动真实监听或执行业务读取与写入。

- `dws schema --cli-path "event +listen-im" --compact -f json` 及该 leaf Help 确认 `--kind at-me|group`、`--chat-id`、`--events message`、全局 `--profile` 和 `--format ndjson`。facade 未公开 `--flatten`，实现使用 facade 结构化输出，不传该参数。
- `dws event schema user_im_message_receive_at --flatten` 确认扁平 type、event_id、conversation_id、message_id、sender_open_dingtalk_id、event_time 等字段。首次核对使用了错误的 at_me key，按安装参考中的精确 key 更正。
- `dws schema --cli-path "event consume" --compact -f json` 确认 ready、关闭 stdin、订阅清理语义。
- `dws schema --cli-path "chat +messages-reply" --compact -f json` 确认 group、message-id、content、idempotency-key 和用户确认要求。授权后才带全局 --yes。
- 已安装 HLZJ EXE 的 `schema "redmine issue comment"` 与 `schema "redmine issue assign"` 确认评论与指派独立、未知写结果不重发。HTTP 客户端按 Redmine 官方 REST 规范实现，保留状态和权限失败语义。[Redmine Issues](https://www.redmine.org/projects/redmine/wiki/Rest_Issues) [Redmine REST](https://www.redmine.org/projects/redmine/wiki/Rest_api)

## 验证与待集成

运行 `.venv/Scripts/python.exe -m unittest discover -s tests/connectors -q`，初版 21 项测试通过。覆盖本机假 HTTP 服务、真实 Python 假子进程 NDJSON/ready/关闭 stdin、分页及权限、评论附件、指派离开本人、明确与歧义提及、持久消费失败游标保持、稳定业务键、重启历史重放、重连预算、审批内容绑定、并发写入 claim 和未知结果不重发。材料下载与历史 helper 的补充结果见下节。

初次受限环境运行在 Windows asyncio 内部 loopback socketpair 初始化等待，经诊断后终止该两次测试会话。允许本地端口后通过测试，所有网络测试目标均为 127.0.0.1。

控制层待接入持久 state_store、去重 emit、跨进程动作账本、显式启用配置、账号及项目映射、历史 replay 和后台生命周期管理。真实钉钉个人 OAuth、源消息校验和回复返回结构、真实 Redmine 版本与权限、实际业务附件均待单独联调验收。

## 材料下载与历史重放补充

`await RedmineClient.download_attachment(attachment, output_dir, max_bytes=20 * 1024 * 1024, mime_types=DEFAULT_MIME_TYPES)` 返回 `{source, attachment_id, local_path, filename, size, content_type, sha256}`。attachment 接收已授权工单详情中的 `{id, filename, content_url, filesize?, content_type?}`。output_dir 由可信控制层提供任务产物目录，不能直接采用外部消息给出的路径。

下载严格验证与配置实例同 scheme/host/port，并绑定 `/attachments/download/<attachment_id>` 路由，兼容 Redmine 子路径安装。所有 HTTP 重定向均拒绝，不向重定向目标转发 API Key。文件名拒绝路径分隔符、Windows 设备名、ADS、控制字符及尾随点空格。目录拒绝 `..` 和已有 symlink/junction。文件大小同时检查元数据、Content-Length 和实际读取量，失败清理临时文件。默认白名单为 PNG、JPEG、GIF、WebP、PDF、UTF-8 纯文本，调用者可缩小 MIME 范围，内容签名和文件扩展名需匹配。发布使用硬链接的原子不覆盖操作，重复文件和并发同名下载均保持已有文件。返回 SHA-256 供审计与复用，下载完成后由材料分析层读取文件。附件内容保持外部不可信数据属性。

`DingTalkHistoryReplay` 可从 `superagent.connectors.dingtalk` 或 `.history` 导入，是现成的 listener replay 回调。构造参数包括 `executable="dws"`、显式 `profile`、`chat_ids`、`initial_since`、`history_timezone`，可选 `kind="group"|"at-me"`、`sender_map`、`page_limit`、`timeout`、`runner`、`clock`。`await helper(checkpoint)` 查询从 checkpoint 或初始时间到本次固定结束时间的范围，`await helper.read_range(start, end)` 用于显式区间恢复。

每个配置会话独立查询，group 使用 `chat +chat-messages`，at-me 使用 `chat +search-msg --at-me`。所有命令指定同一 profile、真实会话 ID、固定起止、升序和有界 page-all。结果必须 complete=true、hasMore=false，无逐页失败、截断或已知未完成 stopReason，部分结果抛 `dws_read_incomplete`，整轮不返回成功。重新检查每条消息的会话及 `[start,end)` 时间范围，按会话和消息 ID 去重，输出监听器所需扁平事件。旧版 createTime 展示值不含时区时使用必填 history_timezone，历史 senderId 的已核实 userId→openDingTalkId 映射通过 sender_map 提供，未映射 ID 保留原值，self_ids 应包含该账号实际可见的两类 ID。映射和多进程启用由 routing/manager 配置。

历史 createTime 可能只有整秒精度，查询起点向下取整秒，完整重放 checkpoint 所在秒，由持久消息键去重处理重叠，避免毫秒游标和秒级展示值造成漏消息或错误范围判定。

`await DingTalkClient.read_message(conversation_id, message_id, reader=None)` 通过 `chat +messages-mget` 读取明确单条消息，禁用额外 reaction/thread 富化并核查完整性、消息 ID 和会话 ID。会话身份缺失时返回 `dws_message_scope_unverified`。

`await DingTalkClient.download_message_resources(conversation_id, message_id, output_dir, **budgets)` 已提供可运行实现。budgets 支持 `max_bytes=20MiB`、`max_total_bytes=40MiB`、`max_files=10`、`timeout=60` 秒、`mime_types=DEFAULT_MIME_TYPES` 和 `poll_interval=0.05` 秒。返回 `{source, profile, conversation_id, message_id, complete, attachments: [...], network_bytes_hard_limited: false}`，每个附件包含 `local_path, filename, size, content_type, sha256, resource_id, resource_type` 及来源账号、会话和消息。

实现使用同一 profile 的 `chat +messages-mget --msg-ids <单条ID> --no-reactions --no-threads --download-resources --output-dir downloads --format json`，工作目录为任务输出目录中新建的独立 `.dws-media-*` 临时目录。已核对本机 Help 的相对输出目录契约，以及官方源码中 `resourceDownloads` 的 `ok,partial,requestedCount,downloadedCount,failedCount,downloads,failures` 和下载项 `resourceType,resourceId,messageId,localPath,sizeBytes`。同一条消息的会话身份、完整性、资源计数和每项消息 ID 均须通过校验。

运行中监控隔离目录的文件数、单文件大小、总大小、目录数量，以及 stdout/stderr 输出量和超时。超限或取消时结束本次拥有的进程树并清理自己的临时目录。Windows 使用 CREATE_SUSPENDED 创建进程，先绑定带 kill-on-close 的 Job Object 后恢复主线程，覆盖 Python 启动器及已退出父进程留下的后代。POSIX 使用独立 session/process group。输出超限时在终止进程树后排空管道，避免退出等待阻塞。CLI 正常退出后也结束其后代，随后才验证产物。

产物检查拒绝路径穿越、隔离目录外路径、symlink/junction/hardlink、未在回执列出的文件、缺失或大小不符、非法文件名和 MIME/内容签名不匹配。验证文件复制到受控暂存区，计算 SHA-256，再以硬链接逐文件原子发布到本次独占新建的 `dingtalk-*` 目录。整批成功后返回可登记的附件清单，失败撤销本次发布并清理暂存。用户已有文件保持原内容。

CLI 缺少网络层 max-bytes 参数，因此网络传输量和两次采样间的临时磁盘峰值可超过预算。监控负责发现超限后终止，最终持久接受的文件必须满足全部预算。回执明确包含 `network_bytes_hard_limited=false`，控制层应按该语义展示验收状态。

已核对本机 `chat +at-me`、`chat +chat-messages`、`chat +search-msg`、`chat +messages-mget`、`chat +messages-resource-download` schema。历史投影消息字段同时参考官方源码中的 messageId/senderId/createTime/text，真实账号输出仍待验收。[DWS 官方消息投影源码](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/blob/main/internal/shortcut/chat/chat_message.go)

新增验证覆盖真实本机 HTTP 假服务的 PNG 下载、内容哈希、路径和 Windows 文件名、origin/附件 ID、拒绝重定向、声明和实际大小、MIME/扩展名/签名、临时文件清理、并发不覆盖，以及假 CLI 的历史时间范围、会话和账号映射、部分结果拒绝及明确消息读取。

补充后最终回归为 39 项全部通过，命令为 `.venv/Scripts/python.exe -m unittest discover -s tests/connectors -q`，耗时 41.745 秒。额外覆盖毫秒 checkpoint 的整秒重放，以及历史查询预算与进程 ready 等待预算独立。所有测试使用本机假 HTTP 服务和假 CLI，真实外部接入状态保持待验收。

媒体实现新增 6 项假 CLI 测试，独立测试已全部通过，覆盖成功下载与内容哈希、原文件保留、路径/回执/签名/硬链接拒绝、文件数和字节预算、超时、stdout 超限、取消启动，以及 Windows 成功父进程退出后的后代清理。测试发现并修复了绑定作业前启动器创建子进程，以及超限 reader 导致退出管道阻塞的问题。

## manager 配置核对

已只读核对 `superagent/core/connections.py`。manager 的媒体调用传入 `max_bytes=10MiB,max_total_bytes=40MiB,max_files=10`，并核查返回 profile/conversation_id/message_id、complete 和路径位于管理目录，和本模块签名及回执兼容。

manager 的 `connectors.dingtalk.history` 字段为 `chat_ids,initial_since,history_timezone,sender_map,page_limit,timeout`，会将 history_timezone 的 UTC、固定偏移或 IANA 名称转换为 tzinfo 后传给本模块。group 配置要求 history.chat_ids 与监听 chat_id 相同，启动前验证会话具有唯一启用项目绑定，并以 initial_since 初始化空游标。以上与 `DingTalkHistoryReplay` 构造及调用契约兼容。routing 原交付记录中的历史 API 未接入与媒体 stub 说明需要由所属会话同步为当前实现及实际验收状态。

媒体落实后的完整集成命令为 `.venv/Scripts/python.exe -m pytest tests/connectors tests/integration -q -p no:cacheprovider --basetemp tests/connectors/.pytest-temp-media`。结果为 75 passed、36 subtests passed，耗时 56.88 秒，1 项来自现有 Starlette/httpx 的弃用提醒。包含 manager 将 DWS 假 CLI 截图下载为 source_attachment、恢复 queued 并写入运行上下文的闭环，以及 manager 实际绑定历史 helper 的配置测试。真实业务媒体与账号均未调用，真实现场验收仍待执行。

## 引用回复关联与冻结范围

依据已核验的 DWS 扁平事件 schema 中 `quoted_message.message_id` 和 `quoted_message.conversation_id`，normalize_event 仅在引用 ID 为明确非空字符串、与当前消息不同且引用会话与当前会话一致时，设置 `metadata.reply_to_message_id`。缺字段、跨会话、自引用或非结构化引用保留原始 quoted_message 并设置 `metadata.needs_confirmation=true`，不猜测字段或消息身份。

新增假事件及真实 SQLite ingest_event 关联测试，验证无工单号的原始请求收到同会话引用后复用既有任务，模糊引用进入 pending_confirmation 且不新增任务。

已只读确认控制层仍有跨模块关联缺口，原消息按 `issue:<工单号>` 路由时，TaskRoute 尚未记录该原消息 ID 的别名，后续已关联消息也没有自身消息 ID 别名。因此引用带工单号的原消息，或引用某条后续回复时，单靠 reply_to_message_id 仍可能新建任务。需 routing 所属会话在自身目录按原始 Event 反查既有任务，或持久维护每条已关联消息的路由别名，并继续校验来源账号、会话、项目和任务身份。连接器已提供明确引用 ID，当前含 #工单号的正文可按既有工单路由续接。该问题已作为集成发现告知总控，当前连接器冻结新增特性。

冻结前完整回归命令为 `.venv/Scripts/python.exe -m pytest tests/connectors tests/integration -q -p no:cacheprovider --basetemp tests/connectors/.pytest-temp-final`，结果为 79 passed、42 subtests passed，耗时 101.51 秒，1 项现有 Starlette/httpx 弃用提醒。随后引用 ID 空白边界专项执行 `tests/connectors/test_quotes.py`，3 passed、7 subtests passed，耗时 1.98 秒。全部验证使用离线假事件、假 CLI 和本机测试数据库。

## 项目 344 时间筛选兼容修复

2026-11-13 按总控明确授权，仅 GET `https://redmine.helianhealth.com/issues.json` 的项目 344，每次 limit=1。凭据从本机 User 环境变量读取，未输出或保存密钥，未修改问题。首次按客户端实际生成的 `updated_on=>=2026-11-13T08:30:59.946834Z` 复现 HTTP 422，实际响应为 `{"errors":["更新于 是无效的"]}`。

保留 status_id=*、sort=id:asc、project_id=344 和 subproject_id=!* 对比后，微秒 Z 格式以及整秒 +00:00 格式均为 422，整秒 UTC Z 格式为 200。省略时间筛选同样为 200，确认项目和 subproject_id 筛选可用。

修复限于 `list_updated_issues` 的 HTTP 时间筛选序列化，将输入归一化为 UTC 并向下取整到秒，发送 `>=YYYY-MM-DDTHH:MM:SSZ`。内部持久游标及统一 timestamp 方法继续保留微秒精度，通过包含边界的整秒重放避免漏掉分数秒更新。

修复后通过原始调用入口 `await RedmineClient(...).list_updated_issues(datetime.now(timezone.utc).isoformat(), 344)` 真实只读复验，2026-11-13T08:32:32Z 请求返回 HTTP 200，issue_count=0，subproject_id=!* 保留。该结果确认筛选兼容性，不代表历史工单全量验收。运行中进程需要由总控加载更新代码。

新增严格假服务回归，覆盖微秒、非 UTC 偏移、datetime 对象和整秒输入，并校验持久游标精度。命令为 `.venv/Scripts/python.exe -m pytest tests/connectors/test_connectors.py tests/integration/test_routing_delivery.py -q -p no:cacheprovider --basetemp tests/connectors/.pytest-temp-redmine-compat`，59 passed、4 subtests passed，耗时 26.54 秒，1 项现有 Starlette/httpx 弃用提醒。其它模块保持本轮冻结范围。

## 旧游标升级时恢复已有语义基线

`RedminePoller(..., load_snapshot=None)` 新增可选同步或异步回调。接入器调用 `load_snapshot(base_url=..., issue_id=..., project_ids=..., user_id=...)`，接收该来源最近已持久化工单快照的 `event.data` 或 None。回调由持久层查询既有事件，不能使用当前远端快照冒充旧基线。

`restore_issue_checkpoint(event, *, base_url, issue_id, project_ids, user_id)` 仅从可验证的旧事件恢复指纹、快照序号及分配 ID。检查 source、原始 issue.updated 类型、端点、项目、工单、当前账号及事件 ID。旧记录缺 assigned_to_id 时，仅在 assigned_to_me=true 且 external_user_id 匹配时恢复本人 ID。分配信息缺失、格式异常、上下文不匹配或既有指纹不一致时，继续按首次可见处理，保留真实变更的投递。

缺少语义 checkpoint 时，先加载旧入库基线，再比较当前标题、正文、指派与项目。仅更新时间变化不会发出 issue.updated，真实内容或分配变化仍产生新快照事件。所有相关 journal 消费确认后，才将恢复后的基线或新语义写入 checkpoint。回调失败及 journal 消费失败均保留重试条件。首次缺少任何可恢复旧记录时，继续保留旧时间戳事件 ID 和首轮原始快照重放机制。

已只读核对 routing 实现，PersistentStateStore.load_snapshot 按 endpoint/project/issue/account 和原始快照类型过滤最新事件，manager 已传 `load_snapshot=self.store.load_snapshot`。集成覆盖数据库 event_type 已变为 message 的旧记录，确认评论导致新 updated_on 时既有任务 revision 保持 1，真实正文变化时升为 2。

本次仅以 SQLite URI `mode=ro` 和 `PRAGMA query_only=ON` 读取 `data/workbench.db`。事件 5 与 86 正文 SHA-256 相同，旧事件 assigned_to_me=true、external_user_id=158 的信息足以恢复分配身份。两条事件均可重建同一语义指纹 `605e479b913cd8bc0c60c617ec12301d70e8f0c1f6f4c5a0a4859bf8d827c532`。真实数据库及已有任务状态由总控管理，本模块未写入真实记录。

## 钉钉现场 unknown 与读回对账

现场 `data/delivery-2-receipt.json` 仅保存 unknown 和 `external_write_outcome_unknown`，没有原始成功发送回执。既有 `data/dingtalk-reply-readback.json` 的 messageId 与用户指定已发送消息一致，证明该消息已可读回，无法据此推导发送调用原本返回的字段结构。本机已核验的 schema 未公开 result，现有指引仅说明 messageId/conversationId/deliveryStatus 等语义。本轮保持客户端保守 unknown，现场已验收路径为只读读回后由总控调用对账 API。总控已确认完成该次对账。

本次没有执行发送命令或复用幂等键重发，也未更改客户端成功字段识别规则。后续取得完整且可验证的本机发送回执后，再按证据补充适配。凭据没有输出或写入材料。

本次最终回归命令为 `.venv/Scripts/python.exe -m pytest tests/connectors/test_redmine_snapshots.py tests/connectors/test_connectors.py tests/integration/test_routing_delivery.py -q -p no:cacheprovider --basetemp tests/connectors/.pytest-temp-bootstrap-final`，107 passed、15 subtests passed，耗时 48.08 秒，1 项现有 Starlette/httpx 弃用提醒。覆盖 cursor 已越过旧工单后的恢复、旧分配身份缺失或异常、跨端点/项目/账号拒绝、真实标题/正文/指派/项目变更、恢复后的序号延续及相关 journal 失败时延迟提交指纹。

## 最终冻结交接

按总控通知，功能代码已冻结，本轮仅补齐交接文档。本模块最后一次已完成测试为上述 107 passed、15 subtests passed，耗时 48.08 秒。总控正在运行 `tests/connectors tests/integration` 最终联合回归，最终总数及结果由总控记录。

总控回报已在真实数据副本完成两轮重放，正式库更正两条误关联事件并保留审计及任务 revision=3，服务已加载新代码。上述现场操作由总控执行。本模块对正式 workbench.db 的核对使用只读连接。

钉钉本次 unknown 已由总控依据实际消息读回完成成功对账。客户端完整发送回执结构的限制继续保留，后续未知结果沿用只读读回及明确对账流程。本模块本轮没有重复测试或执行外部发送。
