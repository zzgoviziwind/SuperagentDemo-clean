# 阶段 0 独立验收记录

2026-11-18，Windows。**阶段 0 通过**。在两个全新目录中各用指定提交生成一份有内容的旧库，再用冻结快照迁移其副本并重放固定输入。两轮均逐值保留旧库历史，每轮完成 44 次进程内 HTTP 请求。阶段 1–4 的验收条件见 [验收矩阵](MATRIX.md)。

## 固定输入与版本

|项目|验收取值|
|---|---|
|分支与旧版 Python|codex/typescript-windows-rewrite；通过 git archive 精确取 7b7587d14399659d7951d3e195af863514fbf118 的 superagent 包。当前 HEAD 的移动不会改变输入。|
|Python 对照实现|.rewrite-oracle；总控集合指纹 `abf0a6922e8da03d65cd53458df256a509d824c3fbf276f58943cc800201b091`。运行前后校验 346 份文件、逐文件 SHA-256 及文件集合。独立计算的排序文件映射 SHA-256 为 `3dfa19b2a899fb13df3d751a549f977305b6029b3bf89732d00da0963282ecb9`。|
|契约与样本配置|快照 docs/接口契约.md SHA-256 为 `f5718d78f6e5b64a8c23c1b37b8100084511420bc588a5ba9aa0b7f28d84811c`。[input.json](input.json) SHA-256 为 `7ddc38cd2088781c96d99ad63d5c264f13111636d7eaf17a8ea0b49dcc8fc03b`。|
|运行环境|Python 3.12.10、SQLite 3.49.1、SQLAlchemy 2.1.8、FastAPI 0.162.5、Starlette 1.10.0、Pydantic 2.14.3、httpx 0.28.1、AnyIO 4.16.0。读取原仓现成虚拟环境；两版应用都从指定源码目录导入。|
|业务输入|预览模式、合成管理员、外部人员 9、项目绑定 7、工单 41/42、11 月 17 日 08:00 UTC 的固定来信。项目目录含中文和空格，账号目录、数据库、托管附件和工作区均指向本轮临时目录。|
|开关与传输|初始八个布尔设置均为 false，具体键见 input.json。四个 WP 环境变量初始未设，默认 legacy / legacy / inline / v1。逐个切换后再组合开启。仅测试发送分支临时启用合成 Redmine 配置，地址为 fixture.invalid；在 HTTP 客户端构造处注入内存传输并独立计数。|
|二轮结果|两轮规范化样本 SHA-256 均为 `42606d62c1f5765039842c83ba5bfb4a273395046012a10333b01e9f80195574`。再次运行下一轮入口时已比对保存的整份结果。|

## 实测结果

|抽查项|可复核的观测|
|---|---|
|旧库与迁移|旧版 ORM 建项目、任务、来源事件、待处理工具审批、受管附件和 owner，旧版交付函数产生草稿、发送批准和超时账本。35 张旧表共 10 行，迁移后在任何业务重放前逐表比较全部旧列、全部行。冻结版实际有 43 张表、28 个显式索引；SQLite integrity_check 返回 ok。|
|任务与事件组|旧任务 1、原件 1、worker:1 均可读。新来信两次返回同一事件 4、任务 2；任务总数为 2。worker:2 核验后 pending_event_count 从 1 变为 0，state_version 从 1 变为 2；旧版本再次核验返回 409。|
|工具审批|旧审批 1 的错误 hash 返回 409。attempt 模式下无绑定执行尝试时也返回 409。legacy 模式下，用正确 hash 拒绝，假 Worker 恰好收到一次请求 17 的 reject，审批落为 rejected；重放返回 409。|
|渠道交付|旧库用假超时生成 reply-2=unknown，两次请求只触发一次假写；冻结版读取并重放此旧键，保持 unknown。新草稿 2 对应事件 4、审批 3；未批、错 hash、工具入口处理渠道审批、外部交付关闭或连接器关闭均返回 409。正确批准后假端只收到一次 PUT /issues/42.json，正文与输入相等；重复发布返回原 reply-3=succeeded。|
|附件|旧产物的新增 attempt_id 为 null。任务导出与详情逐项相等，附件下载返回持久产物。实际读取“核验 证据.txt”的 25 字节 UTF-8 正文，SHA-256 为 `e6d37aff3529d97f76d150b36b9d0a4f9f9ead18b035d83dd9e606696da448bb`。等长篡改被摘要校验拒绝，托管目录外路径也被拒绝。|
|开关|四组 WP 开关逐个开启，其他三项仍为默认。相同的调度轮次下，inline 调内部自动交付一次，worker 调零次。decisions 模式下，上下文组装能读取决定 1；撤销后消失。v2 账本带 claimed_at、dispatching_at。外部交付开关持久回读 false→true→false，非法类型返回 422。现场整理预览返回 offline_sample，媒体 ready=false。|
|独立复核|用新的只读 SQLite 连接核对任务 1/2、两条原件、三项审批和两个交付键的外键、action_hash 与终态。两版本的探针均记录到零次网络、外部程序启动拦截。|

完整的运行时路由、建表/索引 SQL、旧表行数、样本字段、逐请求方法/路径/输入/状态码/选定响应头/响应体指纹均在 [stage0-evidence.json](stage0-evidence.json)。两轮分别从空目录生成。比较时只替换本轮根目录以及列入清单并通过 UTC 解析校验的服务生成时间；保留业务 occurred_at、整数 ID、版本、布尔类型、正文、哈希和列表顺序。原始请求和响应随临时样本保存。

## 下一轮入口

阶段 1 最终构建已连续两轮通过自动 Worker、工具审批、验收、Host 强杀、浏览器对账、草稿隔离与同库 Python 回切。命令、版本与逐件产物见[阶段 1 独立复测记录](PHASE1.md)。后续阶段的覆盖边界见[119 项路由矩阵](ROUTES-119.md)。

### 冻结快照的 Uvicorn 启动与重启

独立复测运行了四个真实 Uvicorn 服务进程。每个模式从单独生成的旧库启动，第一次通过 HTTP 创建任务 2，完整关闭之后在已停止的合成库中设置一条运行中断记录，第二次以原路径重新打开。四次均经 127.0.0.1 的随机高位端口读取真实 /health 和受鉴权任务接口，并在日志中确认应用 startup 和 shutdown 完成。进程环境只传本机运行所需值，预览模式显式禁用飞书，钉钉与 Redmine 均通过 HTTP 核实为 disabled，调度与外部交付均关闭。

|模式|首次与重启端口|重启后的持久证据|
|---|---|---|
|默认 WP 开关未设置|62486 → 61707|旧工具审批为 pending。运行中任务 2 进入 waiting_resource，outcome_unknown=true。旧交付仍为 unknown。库中没有 controller lease 或 attempt。|
|attempt / decisions / worker / v2|59916 → 49721|旧工具审批变为 expired_on_restart。任务 2 的 turn 阶段 attempt 变为 unknown，任务进入 waiting_resource。controller epoch=2，原有交付账本仍为一行。|

复跑命令为 `& $py -IB -X utf8 tests/rewrite-acceptance/uvicorn_restart.py`。逐次服务 PID、健康响应、渠道状态和生命周期日志见 [Uvicorn 结果](uvicorn-results.json)。这两组重启是正常停机后的受控状态回放，阶段 1 单独验证收件后进程强制退出。

在独立工作树根目录运行以下 PowerShell 命令。第一条命令复跑两轮，与已保存结果比对。第二条完成同样的比对后，再生成并验证一套可移交的临时样本，输出所在路径。

```powershell
$py = 'E:\Workspace\Workspace\Project\SuperAgentDemo\.venv\Scripts\python.exe'
& $py -IB -X utf8 tests/rewrite-acceptance/stage0.py
& $py -IB -X utf8 tests/rewrite-acceptance/stage0.py --keep-sample
```

本机已生成 [阶段 1 临时样本](phase1-input-imgybhtl/sample/)。其中 legacy.db 是开始迁移前的旧库（331,776 字节），migrated.db 是冻结实现回放后的结果库（434,176 字节），attachments 中有原始合成附件，http-raw.json 含 44 次请求的原始响应。临时样本已在本目录的 .gitignore 排除；新检出可用上述命令重建。数据库存有绝对附件路径，跨机器或移动目录时重新生成。

阶段 1 应复制 legacy.db 给候选安装器，保留样本原路径下的附件和项目目录。以矩阵 1.1–1.3 为出口，记录实际 HTTP、假 Worker 协议、独立假收件进程的收到次数、重新打开的 SQLite 行和安装器二次启动结果。旧任务在输入库中为 waiting_approval，真实服务启动会进入恢复逻辑；进程内样本保留的旧状态只供比对迁移和请求处理。

## 证据边界与发现

- 冻结 FastAPI 的 OpenAPI 给出 119 项 method/path。与本轮总控静态清单（117 项）核对，多出的两项是同一装饰器注册的 GET、DELETE /api/v1/conversation-providers/mcp；已用合成 Bearer 身份实测二者返回 405、Allow 为 POST、响应体为空。生成 OpenAPI 时 FastAPI 对这两个方法共用的 operationId 发出重复告警，逐方法清单和 HTTP 结果均可复查。
- 固定 44 请求的比对经 ASGI 在进程内分派，直接调用 init_db。真实 Uvicorn 启停和恢复另见上表。旧数据准备中的工具请求和附件入库由夹具构造。附件读取、审批决策、草稿生成、账本和迁移使用对应的 Python 业务代码。调度并发、媒体识别、安装器及 TypeScript 行为需各自的验收证据。
- 总控隔离工作树在验收期间有其他提交推进。本次旧源码始终取指定 SHA，当前业务对照始终取固定快照。本次仅写 tests/rewrite-acceptance，未创建提交，未操作原工作树、真实账号、渠道或业务数据库。
