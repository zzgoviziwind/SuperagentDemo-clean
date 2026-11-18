# Windows 运行时离线安全验收

本专项先冻结下列判据，再检查候选包。源码参照为 `.rewrite-oracle`，清单在 `docs/rewrite/oracle.json`，指纹为 `abf0a6922e8da03d65cd53458df256a509d824c3fbf276f58943cc800201b091`。行号均从 1 起算。此处的阶段 1 指运行时假 Agent 和假渠道切片。

|编号|固定 Python 位置与实际边界|离线输入与通过判据|
|---|---|---|
|T1 正常退出| `superagent/runtime/codex.py:90,119,358–393` 创建进程组，正常关闭 stdin 后等待根进程。仅在超时时按根 PID 调用 taskkill /T。|假服务启动一个有限寿命的等待进程。先取得两者存活证据，正常关闭运行时，分别检查两个进程对象的退出信号。即使根先行退出，后代仍须在关闭期限内退出。失败后夹具主动收尾。|
|T2 超时与中止| `superagent/connectors/media.py:48–64,172–224` 挂起启动、加入 kill-on-close Job、恢复主线程，根退出或异常均清理；该路径的强度不能直接推广到 Codex、历史查询或 Git。|让合成采集器在成功、超时、调用方取消三条路径各创建后代；先确认后代已启动，再触发终止。分别核对状态、退出信号及期限。Job 无法建立时应在运行任何工作前停止；所有者异常退出场景另测。|
|U1 请求回执| `superagent/runtime/codex.py:129–150,173–189` 在等待超时或读取端 EOF 时标记 unknown，记录迟到回执。写入与 drain 在超时转换之外。|假服务接收一次有副作用的请求，只在独立文件中追加一次合成收件。分别正常确认、收件后断开、收件后延迟回执。只有匹配的成功回执可确认；其余两项须能被调用方识别为 unknown，迟到结果不能完成新请求，实际收件保持一条。启动前失败单列。|
|U2 恢复与发送| `superagent/core/execution.py:54–65,122–155`、`scheduler.py:606,825–831`；`superagent/connectors/common.py:76–105`、`core/delivery.py:417–450,486–503`。持久占用、进入发送与最终确认各有边界。|无授权或过期授权应收件零次；确认丢失须保留可识别的未知状态和独立收件证据。集成账本后，重启再提交同一 action ID/hash、迟到确认及人工对账均须统计实际收件数；在对账前执行和投递不得自动重复。单个 fake 的记录只覆盖传输层。|
|C1 子进程环境| `superagent/runtime/codex.py:68–119`、`superagent/core/local_agents.py:135–151,188–190`。隔离模式有单独状态目录，显式复用登录时移除两种模型 API key，并限制工具配置。隔离模式允许特定模型 key。|用合成用户目录和服务目录、虚构的渠道／数据库／模型标记启动。假服务只返回字段是否存在及是否匹配测试目录。默认假 Agent 只得到运行必需环境；真实账号能力若纳入候选范围，须单测显式选择和模型 key 模式。禁止透传父环境、误用用户配置。|
|C2 诊断与产物| `superagent/runtime/codex.py:176–183,191–193` 传递原始错误和 stderr；`.handoffs/2026-11-18-typescript-rewrite/PLAN.md:210` 约束凭据流向。|合成标记经错误／诊断出口输入，检查公开错误、事件、回执、argv 和持久文件。只报告命中位置或布尔值。任何标记原值进入可见诊断或普通收件记录即失败。|

在仓库根目录使用 Windows PowerShell、Python 3.12 执行 `python -I -B tests/rewrite-runtime-review/oracle_checks.py`。该命令先复算快照，再直接导入冻结的运行时。所有假进程只处理本目录创建的合成文件和本地标准流。后代以退出信号或有限寿命自行收尾。Windows 进程树项在其他平台不可签收。

候选运行命令为 `python -I -B tests/rewrite-runtime-review/candidate_checks.py`。默认选用 PATH 上的 Node，可通过 `REVIEW_NODE` 指定已安装的 Node 可执行文件。逐条检查和本轮结果见 [REVIEW.md](REVIEW.md)。

补充判据：已发出的 `thread/start` 收到没有可绑定 ID 的确认时，独立记录须保留一次创建，客户端应返回可识别的未知结果。Windows 进程树同时使用纯 Node 夹具和带普通 Python 工具的混合夹具；正常与强制关闭时让控制进程继续运行，由独立观察者检查退出信号。控制进程异常退出单独验证。
