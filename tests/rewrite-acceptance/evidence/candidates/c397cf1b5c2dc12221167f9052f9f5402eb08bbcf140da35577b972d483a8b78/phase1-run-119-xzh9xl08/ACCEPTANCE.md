# RC2 独立验收 · C397

2026-11-18，Windows x64。119/119 项均已在冻结 Python 和固定 TS Host 上实际调用。**B328 的回切阻断、管理员审计 500、十个 TS 路由未注册均已关闭。** RC2 的业务兼容性严格检查仍返回 1。该检查同时记录字段、持久副作用与拒绝条件，当前有 31 项字段或持久记录差异。

## 本次输入

|对象|复验值|
|---|---|
|TS 入口 SHA-256|`c397cf1b5c2dc12221167f9052f9f5402eb08bbcf140da35577b972d483a8b78`|
|已私有复制的完整 dist，5 文件集合 SHA-256|`640df38b462a224aede86c02984a99253ac5b2000e5441686db0347617b70215`|
|冻结 Python 基线及 346 文件指纹|`7b7587d14399659d7951d3e195af863514fbf118`，`abf0a6922e8da03d65cd53458df256a509d824c3fbf276f58943cc800201b091`|
|非空合成底库 SHA-256|`caa2e7e36f6427fdb81593527b0b37107d783e16da550db7dd6e3752e797fde8`|
|运行配置|Node 24.22.3，Python 3.12.10，完整 Uvicorn lifespan；TS 入口 main.js，fixture 驱动，preview 模式；真实连接器关闭。|

各写入口以独立底库副本先走负例，再走合法格式样本。读取用匿名和管理员。工作台回切另有合成 owner、模型运行及桥接样本。所有 HTTP 均在回环端口。私有目录与逐文件指纹见[运行清单](serial/run.json)。

## B328 的十个缺口

|方法与路径（省略 /api/v1）|Python / TS|实测语义与副作用|
|---|---|---|
|GET /connectors/dingtalk/group、GET /connectors/dingtalk/groups|200 / 409|冻结 Python 在渠道关闭时仍调用合成 DWS；TS 命中已注册的渠道关闭判断，两项均无业务写入。真实群查询未运行。|
|POST /subscriptions、DELETE /subscriptions/{subscription_id}|200 / 200|两端分别新增和停用对应订阅，订阅表与审计均有变化；负例分别为 422 和 404。|
|POST /routing/assessments|200 / 200|同一合成私聊两条事件，两端均返回 incomplete。TS 留下 fixture 模型轮次、thread、turn 和审计；部分来源证据不可核实，未验为完整评估。|
|POST /sessions/{ident}/handoff|200 / 200|TS 返回任务 10 的交接内容，任务、审批、事件表均有变化；持久事件字段仍有差异。|
|POST /sessions/{ident}/coordination|200 / 200|目标任务 11 获得一条协调请求。并发重送四次，TS 同键仅一条，Python 同键两条。|
|POST /sessions/{ident}/coordination/{request_id}/apply|200 / 200|两端返回协调请求 105、任务 11，TS 更新任务、事件及事件目标的关联。|
|POST /operations/daemon/poll、POST /operations/daemon/exchange|200 / 503|TS 明确返回 execution_host=python 和同库回切说明。每项四次并发均 503，未写业务表、托管文件或假渠道收件。另以同一数据库文件实际回切到 Python，poll 返回空操作，exchange 接受空事件，两次签名各落一条 nonce。|

因此，旧十项中六项两端返回 200，两项命中禁渠道保护，两项符合 Python 承载约定。六项中包含一次 incomplete 的评估。对应请求体、双端返回及变更记录见[逐请求观测](serial/observations.json)和[承接专项](postcheck/postcheck.json)。

## 串行和并发

|检查|冻结 Python|TS RC2|
|---|---|---|
|119 项串行正负例，各 238 次|合法格式样本有 112 个 2xx，项目 PATCH 的非法类型返回 500|合法格式样本有 105 个 2xx；104 项取得用例所需业务证据。管理员读审计 200，匿名 401。|
|119 项逐路由四客户端，各 476 次|200 × 398，201 × 4，405 × 8，409 × 63，500 × 3|200 × 378，201 × 4，405 × 8，409 × 78，503 × 8，8 次均为两条 daemon|
|并发请求 p50 / p95 / 最大|37.49 / 164.06 / 558.04 ms|7.39 / 20.69 / 564.38 ms|
|另做六客户端混合，各 36 次|均 200，12 次同一来信产生 1 个任务、1 条事件、11 次重复|均 200，持久结果同左|

证据校验覆盖 **476 次串行、952 次逐路由并发、72 次混合请求**，共 1,500 次；回切及后置校验专项请求另计。并发各侧假渠道收件为 0。TS 的来信、委派、分析转实施、桥接、会话协调五种固定键在四次请求后均只保留一条对应键记录。TS 并发订阅四次均 200，新增一行；Python 一次 200、三次 500，同样只新增一行。第二个 TS Host 对同库启动退出 1，原 owner 和 epoch 保持不变，原服务健康 200。[逐路由统计](load/load119.json) · [Python 混合负载](serial/burst-python.json) · [TS 混合负载](serial/burst-ts.json)

## 工作台回切

- 启用巡检后，工作台定时器自动选择任务 15，fixture 子进程完成，记录 thread、turn 和 observe。admin 可见 7 个任务，Alice 看到从 local-admin 回填的任务 1，Bob 看到任务 15，viewer 列表及统计为空；他人详情、附件和导出受限。
- 有效租约下回切被拒且未创建备份。原 Host 停止后执行回切，备份保留模型运行 running/turn_intent 及桥接 pending，主库变为 unknown/turn_intent 和 unknown。冻结 Python 在同一文件 ID 上读到了任务 15 和同一巡检 ID。备份及主库完整性均为 ok。独立读回主库，未决模型运行、桥接、执行尝试及投递四类计数均为 0。[回切详情](recovery/recovery.json) · [四类残留计数](comparison.json)
- 另在全新合成库模拟一条桥接记录拒绝从 pending 更新。回切命令因后置检查退出 1，未输出成功标记。移除该测试故障后在原文件重试，命令退出 0，桥接状态为 unknown，随后由 Python 实际承接两条 daemon 请求。此次覆盖了后置检查中桥接残留的失败分支。[失败与重试证据](postcheck/postcheck.json)

## 剩余差异

串行按路由计数为 4 项正例业务及所采响应头一致、67 项仅所采响应头不同、31 项字段或持久记录差异、7 项行为差异、1 项副作用差异、1 项 Python 负例服务错误、2 项协议 405、4 项前置条件拒绝、2 项约定由 Python 承载，总计 119。严格门槛未通过。全部方法、状态及变更表见[119 项报告](serial/REPORT.md)。

- 上轮 32 项字段差异中，身份增改、执行节点绑定、设置更新、决定创建及撤销、现场记录创建共 7 项已收敛到仅响应头差异。25 项仍列字段类，另有 6 项由原路由缺失或行为差异转为可比较的字段差异。按本轮 31 项展开，共有 228 个规范化差异位置（含响应头）。现场分析转实施已将来源任务 14 的版本从 1 升至 2，子任务 16 及两条审计均落库，此项只余事件编号偏移。收件生命周期中部分授权检查、设置和项目选择证据仍有差异。[逐项与 B328 对照](comparison.json) · [完整字段值](field-values.json)
- 7 项行为差异包括两条群查询、群历史同步、巡检纠正及路由会话对账的 200 / 409，以及非法任务控制和缺失任务巡检的负例状态差异。关闭渠道、缺少进程退出证据与无效输入是不同的裁决条件。[原始输入与返回](serial/observations.json)
- 附件重试的持久终态已对齐。两端停机后均为 failed、空结果；Python 首次响应 pending，TS 首次响应 failed 并给出 disabled。原用例要求观察作业表变化，此次未在任一侧采到该表的行差，故分类仍记作副作用不符。[停机后回读](serial/attachment-after-stop.json)
- 本轮覆盖本机短时并发、合成主体、模拟 Worker 和禁渠道状态。未验证真实远端设备领取非空任务、真实群目录、真实模型、持续负载或本构建的浏览器流程。

## 复验命令

以下命令在工作树根目录运行。准备步骤会生成新的私有运行目录。复验时将 `$run` 和 `$evidence` 取自该次输出。重复使用本次运行目录可只读校验，已发布阶段会拒绝覆盖。

```powershell
$py = 'E:/Workspace/Workspace/Project/SuperAgentDemo/.venv/Scripts/python.exe'
$node24 = (Get-Command -All node | Where-Object { $_.Source -like '*CodexPrimaryRuntime*' } | Select-Object -First 1).Source
$suite = 'tests/rewrite-acceptance'
$sha = 'C397CF1B5C2DC12221167F9052F9F5402EB08BBCF140DA35577B972D483A8B78'
$prepared = & $py -IB -X utf8 "$suite/replay119.py" --node $node24 --dist apps/server/dist --entry-sha256 $sha --prepare-only
if ($LASTEXITCODE -ne 0) { throw '候选快照准备失败' }
$run = ($prepared | Select-String '^Run: ').Line.Substring(5)
$evidence = ($prepared | Select-String '^Evidence: ').Line.Substring(10)
& $py -IB -X utf8 "$suite/replay119.py" --node $node24 --resume $run --entry-sha256 $sha --jobs 4 --fail-on-diff
& $py -IB -X utf8 "$suite/replay_load119.py" --node $node24 --seed-run $run
& $py -IB -X utf8 "$suite/replay_recovery.py" --node $node24 --seed-run $run
& $py -IB -X utf8 "$suite/replay_postcheck.py" --node $node24 --seed-run $run
& $py -IB -X utf8 "$suite/check_http119.py" --evidence $evidence --entry-sha256 $sha
```
