# Windows TypeScript 重写验收矩阵（阶段 0–4）

判定依据为同一份输入在固定 Python 源上产生的可观察结果，以及《接口契约》约定的行为。阶段编号沿用总控 docs/rewrite/PROGRESS.md。阶段 0 建立对照，阶段 1–4 的通过均需候选实现自己的证据。Python 与文字契约发生分歧时，分别保留原响应、契约条款和待裁决项。

|编号|输入与操作|应采集的结果及失败条件|Python 依据（相对源码根）|
|---|---|---|---|
|0.1 来源与隔离|固定提交、另记未提交快照内容指纹。每轮使用全新临时项目、SQLite、附件根、测试身份。|记录源码路径清单和散列、契约、运行库、输入、命令。测试进程接触网络、启动外部程序或使用宿主账号即失败。|docs/实施基线.md、superagent/core/db.py、superagent/main.py|
|0.2 非空样本|建项目与任务，生成来源事件、审批、回复草稿、托管附件；读取组详情和设置。|两轮断言每一类都有实例；核对 task_id、event_id、approval_id、版本、来源目标、文件内容或摘要和实际布尔值。空列表不能通过。|docs/接口契约.md 中 HTTP 契约、事件组与自动交付；tests/core/test_attachments.py|
|0.3 可复现|同一输入在两个独立进程中初始化和重放。|保存可机读的逐步响应与摘要。仅规范化临时目录和有明确语义的动态字段；字段缺失、类型变化、零行或第二轮不一致均失败。|tests/core/test_api.py、tests/integration/test_event_groups.py、tests/integration/test_routing_delivery.py|
|1.1 服务与数据|Windows 临时目录（含中文和空格），新建库及复制的旧版合成库各启动两次；请求 health、settings、projects、overview；用无效身份访问受限接口。|核对状态码、JSON 形状、鉴权和开关默认值；重开连接后历史主键、中文、空值、版本、计数保持。记录迁移前后 schema 与行数。|main.py 的 lifespan、health、overview；core/db.py 的 init_db；api/governance.py（均在 superagent 下）|
|1.2 接口面与配置|逐 method/path 对照 Python 路由、请求模型和响应样本；分别发送合法 PATCH、非法字段、非法类型，重新读取。|报告丢失/新增/有意改变的操作；区分 401/403、404、409、422 和 detail 形状；敏感值不得出现在响应；连接器关闭时监听和发送次数均为零。|docs/接口契约.md；superagent/api/{governance,connections}.py|
|1.3 安装与最小业务闭环|在隔离 Windows 目录用候选安装入口启动，用实际 HTTP 注入一条合成消息，启动独立假 Worker 和能独立计数的假收件方。完成一次工具审批、一次渠道交付后再次启动程序。|留存包指纹、退出码、实际端口、假进程协议记录、原始收件计数、SQLite 行和二次启动结果；重复事件只建一个任务，批准后收到一次，二次启动可继续读取。|实施基线交付门槛；tests/e2e/test_blackbox.py、tests/runtime/test_approval.py|
|2.1 任务与项目|创建 analysis/repair/reply，依次 pause、用旧版本 resume、使用新版本恢复；归档项目后查历史；取消后再显式恢复。|逐步核对 revision/state_version/control_version、事件顺序和状态；旧请求 409，无新增副作用；归档后保留任务和来源。|superagent/main.py；tests/core/test_api.py|
|2.2 收件与聚组|同一外部 ID 投递两次；同组两条消息、跨组分发同一原件。核验一组，按 project/source/status 筛选并翻页。|重复返回同 ID 与 duplicate=true，无额外任务；组内投递副本去重；两组核验独立；未核验来源遇到 completed 显示 needs_review；统计在翻页前计算。|superagent/core/{ingestion,event_groups,subscriptions}.py；superagent/api/event_groups.py|
|2.3 工作区与附件|在允许根内放入含中文名的合成附件，补上 size、MIME 和 SHA-256；更换内容、根或申报摘要后再读；导出任务证据。|合法件被读取并与任务关联；变更件拒绝。导出与详情引用相同事件、审批、产物；下载符合契约；多仓库工作区保留基线与相对路径。|superagent/core/scheduler.py 的 load_attachments；superagent/runtime/workspace.py；superagent/main.py 的 export_task|
|2.4 增量行为|默认 legacy/legacy/inline/v1 与显式 attempt/decisions/worker/v2 各做读写。两次领取同一任务、创建及撤销决定、读取 manifest；现场笔记录入→审核→关联，媒体不可用时提交任务。|逐项对照 attempt 数、owner/phase、当前决定 ID、manifest 的 task/thread/turn；被撤销或跨项目决定不得出现在输入；现场审核重放保留 ID，媒体未就绪返回 409。|冻结源 core/{execution,context,delivery}.py、api/{context,field_intake,field_media}.py；冻结契约「现场记录与识别」|
|2.5 身份、额度和工作台|用两个合成 owner 和一个 admin 访问任务列表/详情、附件、统计和 SSE；断开 SSE 后带游标恢复。发起预算预留、未知费用核验，并核对审计。|比较角色、可见行集合、游标顺序、预留最终值及核验人。按总控 SCOPE.md 处理旧版跨 owner 过度可见的入口。额外媒体组件缺失时界面应能说明原因。|冻结源 api/governance.py、core/governance.py、main.py 的 stream；docs/rewrite/SCOPE.md|
|2.6 渠道与扩展入口|用假 DWS 和 Redmine 轮询器重放一页记录，模拟自回声；用假飞书卡片回调同一审批两次；使用合成节点签名重复投递同一 nonce，重复桥接 request_key。|重启后游标保留、已确认回声不建任务；卡片绑定 owner、当前 hash 和版本且至多决定一次；节点拒绝重放；桥接保留受权会话和首次操作结果。|冻结源 connectors/{dingtalk,redmine,feishu_callback}.py、core/{execution_nodes,conversation_providers}.py|
|3.1 执行、审批与恢复|假 app-server 请求审批；分别用错 hash、旧版本、正确决定；模拟审批回执中断和进程重启；同一请求再投一次。|核对审批、任务、审计及假调用次数；工具审批和渠道审批互斥；未知结果阻止重跑，人工核验后才允许恢复；旧回执不推进新版本。|superagent/main.py 的 _decide_worker_approval、lifespan；tests/runtime/test_approval.py；tests/review/test_review_races.py|
|3.2 路由、会话与证据|固定事件分别走 reply、analysis、repair；输入重复路由请求、旧会话版本、错 thread/turn 的结果；配置语义路由和 watchdog 开关两态。|同一事件/目标仅一份投递；状态、线程、版本及用量可追溯；假只读工具调用和结构化结果支持分析验收，修复要求本轮测试证据；开关关闭时相应后台工作为零。|docs/接口契约.md 中运行时、会话、设备与巡检；superagent/core/{sessions,scheduler,watchdog}.py|
|3.3 渠道草稿与动作账本|假消息绑定原目标；分别在无授权、开关关闭、错 hash、旧版本、正确授权下发布；假传输回报成功或超时，重放并对账。|断言 target、action_hash、审批状态、实际假调用次数和持久账本；关闭或过期时零发送；成功及 unknown 重放均不再次发送；人工证据与最终状态可查。|superagent/core/delivery.py；tests/integration/test_routing_delivery.py|
|3.4 双端故障差分|在两份等价的旧库副本上分别中断 claim、turn、dispatching，重启两种实现，重放旧审批及相同投递键。|逐行比较 API 响应、已落库版本、attempt/ledger 和独立收件计数；区分可恢复的未开始领取与已可能执行的 unknown。记录每个规范化字段和未裁决差异。|冻结源 tests/integration/test_{execution_ownership,context_ownership,delivery_isolation}.py|
|4.1 安装包与回滚|干净 Windows 用户环境中校验包 SHA-256，安装、启停、备份有内容的旧库和附件；候选写入后退出，固定 Python 重开同一临时库，另演练恢复备份。|记录依赖、包内容、日志、残留进程、端口、升级前后 ID/账本/附件摘要及 Python 重开结果；恢复后对账通过且收件次数未增加，留总控签收。|docs/运维与验收.md、deploy/snapshot.py、tests/e2e/test_snapshot.py|
|4.2 Windows 离线全链路|从临时副本运行候选入口，合成钉钉/Redmine 来源，串起收件→任务→本地假 Worker→审批→附件→假交付，关闭并重启。快照增量另按实际路由增加现场记录、媒体和上下文场景。|双端逐步比状态码、字段、关联、证据、开关和重放结果；记录 Windows 启停、重启恢复与历史可读性。真实渠道、真实模型及生产库验收需要独立证据。|docs/实施基线.md、docs/接口契约.md；tests/e2e/；增量以固定快照的 superagent/api/ 为准|

2.5 采用用户批准的新可见性基准。admin 可查看全部执行，member 仅查看归属执行，viewer 不得浏览他人的执行。任务列为 local-admin 的历史行按 governance_task_owners 回填。分别校验任务列表及筛选、任务详情、附件、下载、任务导出、overview 的计数和待审批集合。Python 历史全量 GET 记为已知缺陷。

2.5 另以一条已存在的 bob 回复草稿交叉核验关联执行内容。admin 和 bob 须能读取同一条，alice 和 viewer 均不可见。使用者不能从关联列表读到其无权查看的任务正文。阶段 1 强杀、角色情形与同库回切的观测已登记在[独立复测记录](PHASE1.md)。

源码定位以阶段 0 结果中的指纹为准。下一轮先运行 0.1–0.3，确认版本与样本，再做 1.1–1.3。每个差异需标出用例、请求、Python 值、候选值和影响。阶段 2–4 的矩阵项在实际执行后逐项登记。
