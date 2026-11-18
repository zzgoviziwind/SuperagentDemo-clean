# Windows 运行时专项审查 · 2026-11-18

**Windows 混合进程树 P1 已修复，并通过另一位验收方的复跑。** Windows 10.0.26200、Python 3.12.10；Node 22.20.0 与 24.22.3 各通过原有 15 项检查，内含的 11 项包测试也全部通过。正常关闭、强制关闭、Host 意外退出三种情况下，观察者均取得最末一级进程的退出信号，清理异常为零。[独立复跑结果](../rewrite-acceptance/windows-runtime-results.json)

## P1 修复与交付

|核对项|实现与结果|
|---|---|
|所有权与启动顺序| `packages/windows-job/src/windows-job.c:77–85,107–126`。监督进程持有匿名 kill-on-close Job；设置创建时 Job 列表与标准句柄白名单，挂起创建目标，确认成员关系和所有者状态后恢复主线程。|
|关闭与未知结果| `windows-job.c:45–56,132–155` 在根退出或停止管道生效时终止 Job，核对活动数归零后报告正常结束；监督进程崩溃由最后一个 Job 句柄关闭兜底。包装失败使用 125，运行时将该值作为停止未确认。|
|导入与分发| `packages/windows-job/index.mjs:7` 导出 `spawnOwned(executable,args,{cwd,env})`；`index.d.ts` 定义返回的 child、真实 pid 和 terminate。源包 exe 为 `packages/windows-job/bin/windows-job-x64.exe`，当前服务器 bundle 对应 `apps/server/dist/bin/windows-job-x64.exe`，两份逐字节 SHA-256 相同。构建、安装端的路径规则见 [包说明](../../packages/windows-job/README.md)。|
|实物与原断言| EXE SHA-256 为 `425cd705d1fb3b5e2d47aba00c50145a890a9f664861a0274f2682ac60efe1bc`。独立方记录的运行时传输文件为 `6a3bcc9ff74b453f038a472c761954616ac57c17e9e216dc995ba30e469fb738`，原验收脚本为 `262841e4b6b4e9eecb13405e0fca9af1b60cb0c5b0a63d98a33ff2f3b4647158`。两轮仅使用合成数据和无害进程。[Node 22 日志](../rewrite-acceptance/runtime-v22.20.0.log) · [Node 24 日志](../rewrite-acceptance/runtime-v24.22.3.log)|
|包装专项| 5/5 通过。覆盖真实 PID、Unicode 与特殊参数、二进制标准流、退出码、重复停止、无目标程序、缺所有权管道、监督进程被终止。初次在受限环境启动新编译 exe 被拒，正式报告基于正常 Windows 环境的实际运行。|

当前复跑命令为 `python -I -B packages/windows-job/test/run-runtime-review.py`。它在临时安装布局中使用原验收脚本，`REVIEW_NODE` 可指定第二个本机 Node 版本。保留以下初审记录，以便对应旧版本的失败证据。此处签收范围为 Windows 所有权专项，安装器在干净系统的验收由分发方记录。

## 修复前候选发现

|优先级|精确位置（相对仓库根）|观察、影响及复验条件|
|---|---|---|
|P1 整棵树的停止缺少确认| `packages/runtime/fake-codex.ts:100–104,118–123,207–215`。超时和协议错误还有单进程 kill 分支，分别在第 272、295 行。|正常 close、500 ms 后强制关闭、控制进程直接退出共三例。每例都先持有根、中间工具和末级等待进程的 Windows 同步句柄。根及中间工具退出，末级仍存活；正常和强制关闭时控制进程仍在运行。纯 Node 对照三例全部通过。若把根退出用作允许恢复、重派或清理工作区的依据，旧工具可能仍在工作。修复的验收条件是普通混合树三例中每个进程均有退出信号，无法确认时应保留待核验状态。|
|P2 线程回执缺 ID，已修复| 初审传输文件 `86dd06b8` 的第 130–132 行。复验版 `packages/runtime/fake-codex.ts:167–173,226–233`。|假端先独立记录一次创建，再返回缺 ID 的 thread。初审得到普通 Error。复验时同一用例在两个 Node 版本上均得到 `CodexUnknownOutcome`，实际创建数为 1。当前源码还关闭会话，防止继续使用缺失绑定的执行上下文。|

上表 P1 使用临时副本替换固定的离线协议对端，保留公开入口、传输、关闭与环境构造代码。包自带夹具没有这个混合工具链。所有测试均使用假进程和合成数据，收尾通过协作停止标记及 Windows 句柄确认。

凭据边界另有两处值得保留。候选 `packages/runtime/fixtures/environment.ts:5–26` 为假进程构造合成用户目录和临时目录；`fake-codex.ts:96` 丢弃 stderr。新增的本机入口 `fake-codex.ts:126–143,156–159` 会使用被选择的账号目录和 account/read，此处仅作源码核对。测试专用发送脚本 `fixtures/fake-channel-sender.ts:4–11` 经 argv 接收完整合成投递并把回执写至 stdout，验证结论限于合成正文。

## 冻结 Python 源的边界

核对了清单全部 **346** 个文件，复算内容指纹与指定的 `abf0a6922e8da03d65cd53458df256a509d824c3fbf276f58943cc800201b091` 相同。下表位置相对于 `.rewrite-oracle/`。

|位置|已核对的行为|
|---|---|
| `superagent/runtime/codex.py:90,119,358–393` | **实测**，正常 EOF 后根退出、等待后代仍存活。根在 stdin 关闭后继续等待时，超时分支执行 `taskkill /T`，根和后代都退出。|
| `superagent/connectors/media.py:48–64,172–188,199–224` | **实测**，挂起启动并加入 kill-on-close Job 的媒体路径在正常、超时、取消三种情况下清除后代。模拟 Job 建立失败时返回错误，夹具未创建等待后代。|
| `superagent/runtime/codex.py:129–150,173–189`，`superagent/core/scheduler.py:606–615,825–831` | **实测传输**，正常回执、写后 EOF、写后超时的假收件各一条。后两项均为 unknown，迟到回执被标记，后续只读请求获得自己的结果。**源码**，stdin.write/drain 抛错不在超时转换内，调度器在调用 turn 前已置派发标记，异常处理据此冻结任务。|
| `superagent/core/execution.py:64,129–150`，`superagent/connectors/common.py:76–105`，`superagent/core/delivery.py:417–450,486–503` | **源码**，未知执行阻止再次认领。恢复区分未派发阶段与可能已产生副作用的阶段，投递账本在发送前持久化 dispatching，失去确认后保留未知。该账本位于运行时包外。|
| `superagent/runtime/codex.py:68–119`，`superagent/core/local_agents.py:135–151,188–190` | **实测两个合成目录**，默认隔离模式允许指定的两个模型 key，排除应用、数据库和渠道标记；显式选择合成登录目录后，两个模型 key 都排除，MCP 覆盖及插件禁用参数存在。|
| `superagent/runtime/codex.py:191–193`，`superagent/core/scheduler.py:627`，`superagent/core/reply_worker.py:299–300` | **实测**，stderr 中与合成凭据一致的标记进入运行时事件。两个上层消费者显式跳过该事件。本次没有发现需要引用真实凭据或认定其已进入业务库的证据。|
| `superagent/connectors/dingtalk.py:154–156,255–273`，`superagent/connectors/history.py:12–23`，`superagent/connectors/media.py:174–176`，`superagent/runtime/workspace.py:14,29,53` | **源码**，这些启动点使用父环境；Codex 的凭据白名单只适用于自己的子进程。DWS 写操作超时保留 in-flight 通信并返回未知，历史查询超时针对直接进程 terminate，媒体 Job 约束的是进程生命周期。|

## 修复前执行记录

|套件|结果|独立观察|
|---|---|---|
|冻结 Python|12 项，10 通过、2 失败|失败为 Codex 正常关闭后的后代与原始 stderr。媒体四项、Codex 强制关闭、三种回执、两种环境模式均通过。|
|候选独立检查，每个 Node 版本|14 项，11 通过、3 失败|三条混合树路径失败。纯 Node 树、缺 ID 的线程回执、轮次断线和超时后的再次请求拒绝、凭据环境和 argv、stderr、假渠道丢确认后的收件数与公开错误均通过。|
|候选原包自带测试，每个 Node 版本|11 项全部通过|直接通过包入口运行，含审批绑定、迟到响应、退出码、发布前后硬退出，独立收件数分别为 0 和 1。审查运行器将这组测试计作 1 项，因此外层合计为 15 项、12 通过、3 失败。|

最终复验传输文件 SHA-256 为 `3a8daa8422ee4e0914aa13b557beb643c6fa0fa56c684923a15711ea3971ab53`，渠道文件为 `a39f1098be52972793a2df1fcd0ff86b80bcd9cf75541b5c9367e152a7b41b09`。运行器列出包内各源码散列，在测试结束时再次核对。候选正常请求确认、EOF 和超时用例各检查一条独立收件。渠道异常后重开收件目录，核对 action ID、hash、目标和条数；适配器错误的合成标记未出现在回执和公开错误中。

### 复验

在仓库根目录运行以下命令。安全门槛失败时退出码为 1，报告不会把已知失败转为跳过。

```powershell
python -I -B tests/rewrite-runtime-review/oracle_checks.py
python -I -B tests/rewrite-runtime-review/candidate_checks.py
```

第二条默认使用 PATH 中的 Node。要比对另一版本，把 `REVIEW_NODE` 设为该版本本机可执行文件的完整路径，再运行同一条命令。Python 基准使用 Windows asyncio 的本机回环唤醒机制，运行环境需允许其初始化。

进程树观察在 `candidate_checks.py:59–111`，预先打开同步句柄，夹具收尾后再次等待其退出。未知线程回执断言在 `candidate_driver.mjs:63–67`。基准判据见 [ACCEPTANCE.md](ACCEPTANCE.md)。所有临时目录都在本专项目录内。此次只验收离线运行时；控制层账本的跨服务重启、真实登录、真实渠道和安装后的运行行为均待各自验收。
