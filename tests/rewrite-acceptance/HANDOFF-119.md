# B328 构建独立验收交接

2026-11-18，Windows x64。冻结 Python 与固定 TS 都已完成 119/119 个方法与路径的 HTTP 回放和逐路由并发。**本包暂缓全量签收**。当前首要阻断是回切命令的成功标记与主库状态不符，另有 10 个入口未注册，管理员读取审计稳定返回 500。

## 固定输入

|对象|本轮值|
|---|---|
|Python 基线提交| `7b7587d14399659d7951d3e195af863514fbf118` |
|冻结 Python 源指纹，346 个文件| `abf0a6922e8da03d65cd53458df256a509d824c3fbf276f58943cc800201b091` |
|冻结接口契约 SHA-256| `f5718d78f6e5b64a8c23c1b37b8100084511420bc588a5ba9aa0b7f28d84811c` |
|TS 的 main.js SHA-256| `b3289b3be6299c3d9157b0b9f62f38901696cad4c708152542f3385788f9a8f3` |
|完整 dist，5 个相对路径和文件散列规范化后 SHA-256| `7b95d6858a4dbeef308a488bbceb57708e30aada6c8943b75547e4dc3cb58425` |
|共用合成底库，克隆前 SHA-256| `5bc2b8435c673c4ebd74ae918e17ae2f72077ba6f1e725304f8ecfe9e067e93e` |
|阶段 0 输入 SHA-256| `7ddc38cd2088781c96d99ad63d5c264f13111636d7eaf17a8ea0b49dcc8fc03b` |
|运行时和入口|Python 3.12.10，Uvicorn 完整 lifespan。Node 24.22.3，Fastify 的 main.js。|

每个写入口、每一侧和每种压测各自克隆底库。种子含 7 个任务、两个项目、来源事件、草稿及审批、预算、会话、合成图片、音频与文本附件。克隆后按所在目录改写样本绝对路径。临时 HOME、配置、附件、SQLite、收件和日志均位于本验收目录。服务仅监听回环地址，TS 使用 `SUPERAGENT_DRIVER=fixture`、`SUPERAGENT_SERVICE_MODE=preview`。真实连接器关闭。目录选择、DWS 群查询、本机账号发现使用明确的外部边界替身。巡检专项才打开 watchdog。初始底库含时间、UUID 和路径，重新制种时文件散列可变，同一轮两端必须来自同一底库。[逐文件指纹](evidence/replay-dist.json) · [运行环境](evidence/http119-b3289b3be629/run.json) · [输入构造](replay_fixture.py) · [逐路由请求](replay_cases.py)

## 119 项与并发结果

59 个 GET 各发匿名、管理员两例。每侧匿名访问有 58 个 401 和 1 个健康检查 200。60 个写入口各发负例、合法格式样本两例。逐请求保存实际响应、业务行字段变化、托管文件散列变化及假渠道收件计数。客户端以未知实体、非法字段、无效版本、鉴权失败或协议错误等方式触发负例。两端各 238 次，共 476 次。TS 的 96 项合法请求取得了可核对的业务响应，包含下表的字段或持久记录差异。仅凭权限拒绝通过业务验收的入口为 0。[119 项状态表](evidence/http119-b3289b3be629/REPORT.md) · [原始请求与副作用](evidence/http119-b3289b3be629/observations.json)

|双端串行分类|项数|
|---|---:|
|正例业务响应、观察到的持久结果及所采响应头对齐|4|
|正例业务抽查对齐，仅所采响应头有差异|57|
|字段或持久记录有差异|32|
|业务或负例拒绝行为有差异|7|
|附件重试的副作用有差异|1|
|一侧服务错误（TS 正例 1、Python 负例 1）|2|
|TS 路由未注册|10|
|MCP 按协议拒绝 GET、DELETE，405 且 Allow 为 POST|2|
|两端均触发前置条件拒绝|4|

四个客户端同时向同一入口发合法格式请求，每侧 119 × 4，共 **952 次**。状态码中的 409 含同一状态版本竞争、重复操作及已知功能前置条件。每批结束独立观察业务表与托管目录，122 个服务运行组的 SQLite 完整性均为 ok，假渠道收件数为 0。下列时间为本机单批四客户端的请求延迟分布。[逐请求并发结果与状态变化](evidence/http119-b3289b3be629/load119.json)

|服务|HTTP 200 / 201 / 404 / 405 / 409 / 500|p50|p95|最大|
|---|---|---:|---:|---:|
|冻结 Python|401 / 4 / 0 / 8 / 60 / 3|56.88 ms|184.68 ms|738.26 ms|
|TS B328|339 / 4 / 40 / 8 / 81 / 4|8.08 ms|19.90 ms|43.13 ms|

另做每端 6 客户端混合读写，24 次读取加同一来信 12 次重送。两端各 36 次返回 200、11 次标记重复，各新增 1 个任务和 1 条事件，假渠道收件为 0。四客户端场景中，来信、委派、分析转实施和桥接操作在两端均各保留一条指定键记录。TS 桥接并发返回两个 200、两个“操作进行中”409，仍只有一条桥接记录。[Python 混合负载](evidence/http119-b3289b3be629/burst-python.json) · [TS 混合负载](evidence/http119-b3289b3be629/burst-ts.json)

## 主控修复与裁决项

1. **回切命令遗漏工作台未决状态。** 两个独立库都观察到相同结果。原 Host 停止后，给合成库放入一个已到 `turn_intent` 的 `running` 模型运行及一个 `pending` 桥接操作。固定包的 `--prepare-python-rollback` 退出 0、返回 `prepared: true`，备份与主库均通过完整性检查。备份正确保留原态，主库两条记录也仍为原态。期望主库标为 `unknown`、保留原 phase。实际 dist 的回切流程在 `startController` 后直接执行 `sweepDeliveries`。验收时工作树的 `apps/server/src/rollback.ts` 已含 `recoverOnly()`，需在下一份明确指纹的包上复验。冻结 Python 完整启动，在同一文件 ID 上读到任务 15 和上轮巡检。回切前后没有假渠道收件。[回切输出、状态、备份散列和 Python 回读](evidence/http119-b3289b3be629/recovery.json)
2. **管理员审计。** `GET /api/v1/audit` 在相同非空治理审计库上 Python 200，TS 单次 500，四客户端再现 4/4 个 500。两端匿名均 401。主控应以管理员和非空旧库复核查询。[逐项证据](evidence/http119-b3289b3be629/classification.json)
3. **TS 未注册 10 项。** 以下路径省略共同前缀 `/api/v1`。这些入口的合法样本在 Python 均返回 200，TS 返回 Fastify 的路由未注册响应。群查询使用离线 DWS 子进程，路由评估覆盖无模型时的 `incomplete` 返回与审计写入。

   |方法|路径|
   |---|---|
   |GET| `/connectors/dingtalk/group`、`/connectors/dingtalk/groups` |
   |POST、DELETE| `POST /subscriptions`、`DELETE /subscriptions/{subscription_id}` |
   |POST| `/operations/daemon/poll`、`/operations/daemon/exchange`、`/routing/assessments` |
   |POST| `/sessions/{ident}/handoff`、`/sessions/{ident}/coordination`、`/sessions/{ident}/coordination/{request_id}/apply` |

4. **五个 Python 200 / TS 409 需要契约裁决。** 自有钉钉历史同步的 Python 返回新增 0，TS 明示历史读取未接入。巡检纠正、语义路由纠正、路由调度、路由会话对账在 Python 均有持久变更，TS 在本样本下拒绝并保持业务表原态。巡检和会话拒绝分别要求进程退出证明，路由调度样本保持默认开关。另有两个负例状态不同，非法 task control 为 409 / 422，缺失任务的 watchdog 为 409 / 404。已同意的归属收紧单独按新安全基准判定。[请求负载与两端响应](evidence/http119-b3289b3be629/observations.json)
5. **附件与展示字段。** 事件 100 重试当次两端均返回受理。服务停止后重新打开各自的库，Python 的附件作业为 `failed`，TS 为 `pending`，结果均为 `[]`。样本未提供可下载附件，尚缺成功取回文件和长时间收敛的证明。32 项字段或持久记录差异包含重启后旧工具审批 `pending / expired_on_restart`、审计字段、模型提示、额外事件导致的数字 ID 偏移和现场记录整理器返回。分类文件保留差异位置与预期表，逐请求文件保留原值；32 项需要逐项裁决。[逐项分类](evidence/http119-b3289b3be629/classification.json)
6. **冻结 Python 本身的负例与并发缺陷。** `PATCH /projects/2` 提交 `{"allowed_paths":42}`，Python 500、TS 422，合法改名均为 200。四次并发订阅得到一次 200、三次 500，数据库仅新增一条订阅，日志报唯一键冲突。同一协调请求键 `request-b` 并发四次均 200，却在同一个目标任务 11 新增两条内容相同的协调事件，ID 为 109 和 110。TS 的订阅和协调入口均待补。[并发响应与落库行](evidence/http119-b3289b3be629/load119.json)

## 已验证的新版行为和边界

- 同一合成库上的第二个 Host 在获取独占锁时以退出码 1 结束，原 Host 的 owner 和 epoch 保持一致，健康接口 200。运行中直接执行回切命令另行得到“原控制器的租约仍有效”，备份数为 0。[第二 Host 记录](evidence/http119-b3289b3be629/load119.json) · [回切租约记录](evidence/http119-b3289b3be629/recovery.json)
- 通过 HTTP 开启巡检，真实工作台定时器自动选择任务 15。没有手动发起 run。独立 fixture 模型子进程产生 thread 和 turn，运行记录为 `completed`，进程树已退出，巡检查询返回 `observe`。[定时器和模型运行记录](evidence/http119-b3289b3be629/recovery.json)
- 管理员看到全部 7 个任务。旧任务 1 的 `local-admin` 按治理 owner 归属 Alice，她可读附件、下载及导出。Bob 只看到任务 15。viewer 列表和统计为空，访问两人的详情、导出及抽查附件均为 404。各角色统计与其可见任务相符。[四角色结果](evidence/http119-b3289b3be629/recovery.json)
- 四个前置条件用例为本机合成账号连接、重启后历史工具审批、关闭媒体功能时的上传和重试。本轮未测真实账号、渠道或外部模型。浏览器与活跃工具审批的两轮阶段 1 证据继续按当时包指纹引用。本轮负载以四客户端短时并发为范围，未做长时间吞吐或持续积压试验。

## 复验命令

以下为 B328 验收当时的命令记录。后续版本已经按“完整入口 SHA / 运行目录 / 阶段”独立归档。新候选请使用[当前复验命令](RC-REPLAY.md)。B328 的 32 项明细见[字段与预期](B328-32.md)。

在本工作树根目录运行。主入口先验证冻结源清单与 dist 全部五个文件。默认使用私有快照，快照目录缺失时会核对工作树 dist 的完整指纹。命令中的 `$sample` 指向本次底库。用新一轮控制台打印的 `Run:` 目录可复放新一轮输入。

```powershell
$python = 'E:/Workspace/Workspace/Project/SuperAgentDemo/.venv/Scripts/python.exe'
$node24 = (Get-Command -All node | Where-Object { $_.Source -like '*CodexPrimaryRuntime*' } | Select-Object -First 1).Source
$suite = 'tests/rewrite-acceptance'
$sample = "$suite/phase1-run-119-ewsg5_sb"
& $python -IB -X utf8 "$suite/check_http119.py"
& $python -IB -X utf8 "$suite/replay119.py" --node $node24 --jobs 4 --fail-on-diff
& $python -IB -X utf8 "$suite/replay_load119.py" --node $node24 --seed-run $sample
& $python -IB -X utf8 "$suite/replay_recovery.py" --node $node24 --seed-run $sample
```

第一条只读校验证据。第二条新建所有用例并刷新该指纹的串行报告，遇待裁决差异返回非零；加 `--resume $sample` 可基于首次运行留存记录重新分类。第三条保存并发状态与延迟，程序成功退出表示采样完成。第四条在回切状态与预期不符时先保存证据，再返回非零。阶段 0–4 总入口见[验收矩阵](MATRIX.md)。本会话不能直接投递至父级总控聊天，以上交接已保存在总控可读取的共享工作树内。
