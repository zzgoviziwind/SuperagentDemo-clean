# Windows 回切候选包专项复跑

输入可以是交付 ZIP、以 `main.js` 为根的 dist ZIP，或 dist 目录。复跑器对实际复制并执行的完整 dist 取指纹，算法与 119 报告一致：对“相对路径 → 文件 SHA-256”按键排序，以无空白 UTF-8 JSON 编码后再取 SHA-256。完整发布 ZIP 使用包内 Node 和服务依赖，逐一对照 `release.json` 校验实际解出的运行文件。独立 dist 使用指定 Node 和工作树已安装的服务依赖。

每次保存到 `evidence/<完整 dist SHA-256>/<UTC 时间及唯一编号>/recovery.json`。每份记录包含输入 ZIP 摘要、manifest 版本、逐文件摘要、Node/执行脚本指纹、两个场景的初始库、备份和主库状态、冻结 Python 读回及第二次 prepare 的结果。复跑器只写新文件。原 B328 的 [测试包](../prepare-candidate.zip)、[工具审批失败证据](../dispatched.json) 和 [交付回切证据](../prepared.json) 沿用原位置。

## 复跑命令

从仓库根目录运行 PowerShell。最终实包的两组测试使用同一个 `$zip` 和交付清单中的 `$publishedSha`。第一组输出的证据路径用于读取这份包的入口和完整 dist 指纹。

```powershell
$review = 'tests/rewrite-runtime-review/host-safety/rc-replay'
$py = 'E:\Workspace\Workspace\Project\SuperAgentDemo\.venv\Scripts\python.exe'
$stateRun = @(& $py -IB -X utf8 "$review/replay.py" --dist $zip --expect-zip $publishedSha)
$state = Get-Content -LiteralPath $stateRun[-1] -Raw -ErrorAction Stop | ConvertFrom-Json
& $py -IB -X utf8 "$review/ledger.py" --dist $zip --expect-zip $publishedSha --expect-main $state.candidate.main_sha256 --expect-dist $state.candidate.dist_sha256
if ($LASTEXITCODE -ne 0 -or !$state.pass) { throw '实包回切验收未通过，请查看本次 JSON' }
```

对于独立 dist，可额外锁定入口或完整文件集指纹。下例复跑 B328，预期返回 1，JSON 列出未满足的断言。

```powershell
$node24 = (Get-Command node -All | Where-Object Source -like '*CodexPrimaryRuntime*' | Select-Object -First 1).Source
& $py -IB -X utf8 "$review/replay.py" --node $node24 --dist "$review/../prepare-candidate.zip" --expect-dist 7b95d6858a4dbeef308a488bbceb57708e30aada6c8943b75547e4dc3cb58425
```

两个场景各用同一份 [合成底库](seed.sqlite.gz) 的独立副本。解压后的 SQLite SHA-256 为 `57637fcc70bbbb90a6cbd9194665d1c7c928916c696ad0749914844ece2c5828`。底库由 `30bceacbf141cfb143bc0eab9d004761f23201ba` 的实际存储接口生成，已批准的动作进入 `dispatching` 后，测试进程退出 73，未生成工具回执；测试时钟令已退出进程的数据库租约到期。生成脚本也可用 `make_seed.py <Node路径> --out <新文件路径>` 另建样本，新样本的 attempt ID 和文件摘要可变。

## 验收条件

| 项目 | prepare 前及首份备份 | prepare 后主库、stock Python 读回及再次 prepare |
| --- | --- | --- |
| 已派发工具审批 | 有 1 条 approve 决定，无响应确认，审批为 `dispatching` | 审批与尝试均为 `unknown`；任务结果未知；唯一一条 `approval_response_unknown` 的 approval ID 和 attempt ID 与决定匹配 |
| 桥接操作 | 同一 actor 和 request key 的行是 `pending` | 原行转为 `unknown`；原本完成的对照行保留结果 |
| 工作台运行 | watchdog，scope 15，`running/turn_intent`，无进程退出证明 | 原行变为 `unknown/turn_intent`，退出标志保持 0；已完成行不受影响 |
| 只有 bridge 的旧库 | 有上述待处理 bridge，未创建 TS 的 `workbench_model_runs` 表 | 同一条 bridge 仍须冻结为 `unknown` |

另查主库文件标识、SQLite 完整性、备份前态、重复 prepare 不重复写未知事件、投递账本转为 unknown，以及假渠道回执数为 0。模型和 bridge 的中断行按 119 报告的持久字段注入。冻结 Python 使用实际默认启动恢复段，在第一个后台服务前截断，随后用 ORM 读取同一数据库。两端均限制网络和外部进程；运行中不接账号。

源码位置：`packages/storage/src/controller.ts:8`、`:22` 恢复已派发审批及其事件；`apps/server/src/workbench/scheduler.ts:196`、`:198` 分别冻结运行和 bridge。RC1 的 `apps/server/src/rollback.ts:32` 以运行表的存在决定是否调用两项恢复；工作树预验版该行改为无条件调用，并在 `:34` 检查是否还存在未决记录。生产实现不属于本专项的修改范围。

## 实测记录

| 输入 | 已派发审批 | 119 pending bridge | 119 workbench run | 只有 bridge 的旧库 |
| --- | --- | --- | --- | --- |
| [B328 旧包](evidence/7b95d6858a4dbeef308a488bbceb57708e30aada6c8943b75547e4dc3cb58425/20261118T132051Z-1f94e9d7/recovery.json) | 失败，误记过期，未知事件 0 条 | 失败，仍 pending | 失败，仍 running | 失败 |
| [RC1 发布 ZIP，30bceac](evidence/e4e6bd0ed5f83f07c677dd94ca4ced9130bdfa90ed57e1e9d842fba37e1979ff/20261118T132104Z-cf6fd302/recovery.json) | 通过 | 通过 | 通过 | 失败，prepare 返回成功，主库仍 pending |
| [工作树预验包，main 79ba2f04](evidence/b67dab4526b593fc330f2e35ecd59c209be4284bb5d43678e6bca9a4e8e9600b/20261118T132122Z-efcc4669/recovery.json) | 通过 | 通过 | 通过 | 通过 |
| [指定 dist，main C397CF1B](evidence/640df38b462a224aede86c02984a99253ac5b2000e5441686db0347617b70215/20261118T132422Z-76841038/recovery.json) | 通过，首次未知事件 1 条，再次 prepare 新增 0 条 | 通过 | 通过 | 通过 |

RC1 的包内 `main.js:1028` 处理已派发审批，`:5749` 和 `:5750` 处理运行和桥接操作，`:10691` 是运行表存在性判断。工作树预验使用单独构建的 dist，构建输入摘要随该次证据留存。[预验输入摘要](evidence/b67dab4526b593fc330f2e35ecd59c209be4284bb5d43678e6bca9a4e8e9600b/20261118T132122Z-efcc4669/sources.json)

## C397 的账本与阻断结论

本次输入是 5 文件 dist，使用 Node 24.22.3、工作树依赖和冻结 Python 3.12.10。`main.js` 的 SHA-256 为 `C397CF1B5C2DC12221167F9052F9F5402EB08BBCF140DA35577B972D483A8B78`，完整 dist 指纹为 `640df38b462a224aede86c02984a99253ac5b2000e5441686db0347617b70215`。留存的 [dist 副本](inputs/640df38b462a224aede86c02984a99253ac5b2000e5441686db0347617b70215.zip) 的 ZIP SHA-256 为 `298f5b0d044aa4f1085ff1bf65f54b27ce1f82b075f6e34fff43b91eb1d8f311`。本次结论限于该 dist。

| 实际 Host 崩溃后的路径 | Python 读取及人工核验 | TS 再次发布 | 假渠道回执 |
| --- | --- | --- | --- |
| prepare → Python 默认账本（attempt） | `unknown`，人工核验 HTTP 200；对账事件 1 条 | `succeeded` | 1 张 |
| prepare → stock Python（执行和账本都取默认） | `unknown`，人工核验 HTTP 200；对账事件 1 条 | `succeeded` | 1 张 |
| 直接启动 Python，分别使用上述两种配置 | `dispatching`，两者均拒绝人工核验 | `unknown` | 各 1 张 |

准备回切时，活跃租约使 CLI 拒绝执行。Host 在假渠道写入回执后崩溃，租约自然到期，CLI 成功冻结原 `superagent.db` 并释放租约；探针观察到的外部进程和网络调用均为 0。Python 完成人工核验后，TS 再次发布读回同一证据，回执内容和数据库文件标识一致。四个用例复用 B328 的原始断言。[完整账本证据](evidence/640df38b462a224aede86c02984a99253ac5b2000e5441686db0347617b70215/20261118T132800Z-54104a07/ledger.json)

在 C397 上，已派发工具审批、投递账本以及 119 的 bridge、workbench run 回切均通过；只有 bridge 的旧库也通过。本专项未发现剩余阻断。跳过 prepare 仍会使冻结 Python 无法核验未决投递。C397 包内 `main.js:1029` 写入审批未知事件，`:5984`、`:5985` 分别冻结运行和 bridge，`:11667` 调用恢复。对应源码为 `packages/storage/src/controller.ts:22`、`apps/server/src/workbench/scheduler.ts:196`、`:198`、`apps/server/src/rollback.ts:32`。B328 的旧包及 `dispatched.json`、`prepared.json`、`results.json` 已按先前的 SHA-256 逐一复核。

在仓库根目录沿用上文的 `$review`、`$py`、`$node24` 可复跑两组证据，每次各生成一个新目录。

```powershell
$main = 'c397cf1b5c2dc12221167f9052f9f5402eb08bbcf140da35577b972d483a8b78'
$dist = '640df38b462a224aede86c02984a99253ac5b2000e5441686db0347617b70215'
$zipSha = '298f5b0d044aa4f1085ff1bf65f54b27ce1f82b075f6e34fff43b91eb1d8f311'
$candidateArgs = @('--node', $node24, '--dist', "$review/inputs/$dist.zip", '--expect-zip', $zipSha, '--expect-main', $main, '--expect-dist', $dist)
& $py -IB -X utf8 "$review/replay.py" @candidateArgs
& $py -IB -X utf8 "$review/ledger.py" @candidateArgs
```
