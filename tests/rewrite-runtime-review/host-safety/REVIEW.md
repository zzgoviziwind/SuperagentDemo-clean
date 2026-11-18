# TS 权限、外部动作与 Windows 回滚独立验收

2026-11-18，Windows x64。指定的 TS 包通过同库回切验收。TS 在假渠道持久化回执后被强制终止，执行 `node main.js --prepare-python-rollback` 后，冻结 Python 的默认账本和 stock 配置均能直接人工核验。再启 TS 后，每个独立数据目录内仍只有一份假渠道回执。

## 固定包回切

实际运行的 `dist/main.js` SHA-256 为 `B3289B3BE6299C3D9157B0B9F62F38901696CAD4C708152542F3385788F9A8F3`。独立保留整份 [dist 快照](prepare-candidate.zip)，5 个文件的摘要见 [prepared.json](prepared.json)。冻结 Python 文件清单指纹为 `abf0a6922e8da03d65cd53458df256a509d824c3fbf276f58943cc800201b091`，清单中的 Git 提交为 `7b7587d14399659d7951d3e195af863514fbf118`。

| 真实 TS 崩溃后的顺序 | Python 接手时的发送账本 | Python 人工核验 | 再启 TS 并调用发布 | 最终假回执 |
| --- | --- | --- | --- | ---: |
| prepare → 默认账本，开启执行租约 | `unknown`，领取令牌已清除 | HTTP 200，记为 `succeeded` | 返回原人工核验结果 | 1 |
| prepare → stock，两个模式变量均缺省 | `unknown`，领取令牌已清除 | HTTP 200，记为 `succeeded` | 返回原人工核验结果 | 1 |
| 直接启动默认账本，开启执行租约 | `dispatching`，仍有领取令牌 | 拒绝，仅允许核验未知交付 | 恢复为 `unknown` | 1 |
| 直接启动 stock | `dispatching`，仍有领取令牌 | 同上，原 Worker 审批也仍为 `pending` | 恢复为 `unknown` | 1 |

四组各自从空目录启动指定包。使用真实 Host 的草稿、投递审批和发布接口，FakeChannel 写下唯一回执后由 Host 自身终止进程。另一个正在等审批的真实假 Worker 提供独立的任务恢复观察点。两端固定使用同一绝对目录下的 `superagent.db`。测试核对库文件标识、回执全文与摘要、账本和对账事件数。准备组的冻结 Python 经真实启动恢复段，在第一个后台服务启动处停止，再通过原 ASGI 路由进行人工对账及重放。业务账号、外部连接器和后台轮询均未接入。

准备命令在 Host 持有有效租约时拒绝运行。强杀后按库中到期时间自然等待。CLI 获得第 2 代租约并释放，备份通过完整性检查，备份内仍是原 `dispatching` 行。JSON 均返回 `unknown_delivery_ids=["reply-1"]`、`unknown_task_ids=[1]` 和 `dispatches_unknown=1`。网络和子进程调用探针没有记录到调用。两组均只有 1 条人工对账事件。入口见 `apps/server/src/main.ts:20`、`apps/server/src/rollback.ts:17`、`:23`、`:31`、`:38`，固定包中为 `dist/main.js:10558` 和 `:10614`。

**配置差异。** 经过 prepare 后，stock 不需要补传 WP2 或 V2。表中的“开启执行租约”仅设置 `SUPERAGENT_EXECUTION_MODE=attempt`，账本仍用 Python 默认 v1。独立的 v2 对照还设置 `SUPERAGENT_LEDGER_MODE=v2`。这样 Python 可以自行将未决投递转为 `unknown`；仅设置执行模式时只恢复任务和工具审批。冻结代码见 `.rewrite-oracle/superagent/main.py:35`、`:63`、`:74`，以及 `.rewrite-oracle/superagent/core/delivery.py:27`、`:488`、`:579`。

## Host 与渠道边界

下表使用当前工作树源码单独构建 Host，源码、测试用 bundle 和 Job helper 摘要均在 [results.json](results.json)。使用本机 Fastify 注入、两个普通成员、一名只读用户和一名管理员的临时身份。Git 和 Node 只验证一次性合成项目。没有向共享仓库写入 Git 对象或提交。

| 断言 | 实测 | 负责位置 |
| --- | --- | --- |
| 假工具同轮报告命令完成、退出 0，实际未改文件 | `verification` 为 0 行，任务为 `waiting_resource` 且结果未知，人工验收 409 | `apps/server/src/worker/index.ts:321`、`:336` |
| 修复确实有 diff，但管理员配置的合成校验程序返回 9 | 源文件保持原字节，无验证产物，验收 409 | `apps/server/src/worker/index.ts:354`、`packages/runtime/project-workspace.ts:176` |
| 所有者重复并发批准同一动作 | 一次 200、一次 409，仅一个验证产物；其他成员及只读用户均为 403，未消费待批动作 | `apps/server/src/worker/index.ts:570`、`packages/storage/src/approvals.ts:42`、`:56` |
| 人工验收前再次修改同一个受控文件 | 普通夹具及合成 Git 项目均返回 409，状态版本和验收事件数不变；恢复原字节后 200，只写入 1 条验收事件 | `apps/server/src/worker/index.ts:598`、`apps/server/src/worker/acceptance.ts:58`、`:98` |
| 草稿列表可见性 | 管理员及所有者 200，其他成员及只读用户 404 | `apps/server/src/deliveries/index.ts:43`、`apps/server/src/workbench/store.ts:148` |
| 两个工单具有相同更新时间，最后一条评论入库前中断 | 中断时有 3 条，轮询总游标未提交；关闭再开 SQLite、重建 poller 后补齐到 4 条；第三次轮询仍为 4 条，实际回看 120 秒 | `packages/channels/redmine.ts:148`、`:182`、`:193`，使用实际 `ingestChannelEvent` 去重 |
| 工单附件清单及项目、下载来源限制 | 合法文本只取一次正文；未列出的附件 ID、其他项目、其他来源均在取正文前被拒，拒绝目录无文件 | `packages/channels/redmine.ts:51`、`:64`、`:73` |
| 受管截图读取 | 本记录正确字节 200；其他记录、根外合成文件、错误摘要或长度均 404；非管理员读截图 403 | `apps/server/src/field/index.ts:50`、`:86`，`apps/server/src/field/files.ts:111`、`:126` |

**边界。** 文件变更用例覆盖用户点击验收前已发生的改动。源码先等待文件快照，再进入数据库事务，提交时比较已取得的快照；本轮没有证明与外部写入者同时写文件时也具有原子性。位置为 `apps/server/src/worker/index.ts:598` 和 `:603`。普通修复审批的成功样本使用假驱动，源码在 `apps/server/src/worker/index.ts:576` 对其他驱动的批准返回 false。真实账号的审批可用性未验收。

## 安装包阻断与结果

- **P1，固定 B3289B3B 包丢失已派发 Worker 审批的未知状态。** 另起一个合成库，通过真实存储接口持久化 `approval_decision=approve`，程序在取得回执前退出。原审批为 `dispatching`。固定包运行 prepare 后，交付账本和执行尝试均为 `unknown`，但工具审批为 `expired_on_restart`，`approval_response_unknown` 事件为 0。固定包 `dist/main.js:1049` 将 pending 和 dispatching 一并过期。该结果与上表中“尚未批准的 pending 应正常过期”分属两个断言。源码版 `packages/storage/src/controller.ts:9` 会将已派发动作保留为 unknown，并在 `:22` 记录未知响应；源码版的 Python → TS 和 TS → Python → TS 存储用例均已复验。发布已派发审批恢复能力时应以实际重打包产物复跑这一项。[固定包单项证据](dispatched.json) · [源码版对照](results.json)
- **未经过 prepare 的 Python 默认回切仍阻断未决发送的人工核验。** 投递未重复，不过 Python 无法完成对账，stock 还保留了旧 Worker 审批。指定包的四组正反对照已覆盖这个差别。
- **stage4 A 的长临时路径安装失败。** 此 EXE 在审查目录的完整路径及其 NTFS 短名写法下均在解压时报 Windows 路径长度错误。包内最长相对路径为 111 个字符，旧安装器还会追加随机临时目录与 `kit`。新安装器对应代码位于 `deploy/windows-ts/Installer.cs:15` 和 `:31`，使用扩展路径解压。[长路径结果](installer-ts.json) · [短名结果](installer-ts-short.json)
- **显式 A/B 回滚有失败样本。** 通过短盘符映射同一审查目录后，stage4 A 安装、升级 B、故障候选自动恢复 B 和保留两条 SQLite 任务均通过。随后显式切回 A 的健康检查读取响应流失败，恢复 B 时进程退出。第一次失败发生在读取响应流及切换异常恢复路径，位置为 `deploy/windows-ts/SuperAgent.ps1` 的 `Get-LocalResponse` 和 `Switch-Release`。安装包主程序摘要分别以 `53921964`、`67cd6298` 开头，与本次 prepare 验收包不同。[第一次 A/B 实测](installer-ts-drive.json)
- 另用当前安装脚本从源码构建 4 个只含假服务的包。“升级、显式回滚、再前滚、破损载荷拒绝、数据代不兼容拒绝、启动失败自动恢复”均通过，合成计数持续到 5。[四包构建与生命周期结果](installer-build.json)

旧版 A/B 的显式回滚失败，精确位置为安装包内 `SuperAgent.ps1:185`、`:305`、`:321`。独立重跑相同 EXE/ZIP 摘要，六组均通过，包括同库回滚再前滚、卸载中断恢复、重装后保留两条任务。第一次的响应流错误和恢复失败仍留作间歇性问题证据，尚未确定其触发条件。[同包第二轮](installer-ts-drive-repeat.json)

随后对包含 B3289B3B 主程序的新 handoff 安装包，在相同父目录的完整长路径下复验，无盘符映射。实际 TS 首页、健康响应、独立 SQLite、切换 PID 后的同库重启和停服释放端口全部通过。新 EXE 的 SHA-256 为 `5724ba7147be621c08c8583370b8e38f4c989305787c7c8d048ffa35888017fb`。旧包长路径问题在此包和此路径下已通过复验。[新安装包结果](installer-handoff.json)

## 复跑

从工作树根目录运行。用已有的本项目 Python 环境（含冻结 Host 的依赖）、Windows x64 Node 24、Git 和现有 Node 依赖。所有测试实例、SQLite、备份、临时 Git 和解压路径都在本报告目录下；结束后只保留脚本、固定包和 JSON 证据。

```powershell
$review = '.\tests\rewrite-runtime-review\host-safety'
$py = 'E:\Workspace\Workspace\Project\SuperAgentDemo\.venv\Scripts\python.exe'
$node24 = (Get-Command node -All | Where-Object Source -like '*CodexPrimaryRuntime*' | Select-Object -First 1).Source
& $py -IB -X utf8 "$review\prepared.py" $node24
& $py -IB -X utf8 "$review\run.py" $node24
& $py -IB -X utf8 "$review\dispatched.py" $node24
$kits = '.\deploy\windows-ts\.artifacts\stage4\packages'
& $py -IB -X utf8 "$review\installer.py" --ts-kits $kits
& $py -IB -X utf8 "$review\installer.py" --ts-kits $kits --drive-path
$handoff = '.\deploy\windows-ts\.artifacts\stage4\handoff-packages\SuperAgent-stage4-python-handoff-win-x64.exe'
& $py -IB -X utf8 "$review\installer.py" --handoff-kit $handoff
$kitNode = 'C:\Users\examp\AppData\Local\OpenAI\Codex\runtimes\cua_node\bfa21d187eb00b05\bin\node.exe'
$web = 'E:\Workspace\Workspace\Project\SuperAgentDemo\apps\web\node_modules'
& $py -IB -X utf8 "$review\installer.py" --build-node $kitNode --web-modules $web
```

`prepared.py` 在两条 prepare 正例和两条同包直启负例都符合预期时退出 0。`run.py` 将未准备直接回切的两条路线按完整验收要求判定，因此保留非零退出及每条路线的实际状态。安装脚本独立运行 Windows 生命周期场景，记录实际的包摘要、通过阶段及退出码。

`dispatched.py` 对固定包独立运行，要求已派发工具审批为 unknown；该包当前退出 1。固定包替换时须显式更新指纹并重新执行，两个脚本均会在运行前验证包中的主程序摘要。
