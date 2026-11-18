# 阶段 1 独立复测记录

2026-11-18，Windows。**最终开发包在两个独立临时根中完成自动 Worker、工具审批、任务验收、强杀、浏览器对账和 Python 同库回切。此前的两项阻断均已关闭。** 本次以真实进程和非空旧库验收阶段 1 的业务闭环。安装器与干净 Windows 用户环境待独立验收。

## 最终构建的两轮实证

固定整份 `apps/server/dist`，在复制前后及每轮启动前核对文件集。5 份文件包括 main.js、Windows Job 可执行文件及 fixtures 下的 environment.ts、fake-app-server.ts、fake-channel-sender.ts。集合 SHA-256 使用按相对路径排序的「路径 → 文件 SHA-256」映射，按紧凑 JSON 的 UTF-8 字节计算。

|范围|SHA-256|
|---|---|
|最终 dist 文件集合|`2857939ef3b88904a4d220acaf70e5615a1502fecd323f437f96970e9f54f50c`|
|main.js|`67cd629891ab831b57df4229b23741d9fc827bbe51231705fb0fb554431d70d0`|
|windows-job-x64.exe|`425cd705d1fb3b5e2d47aba00c50145a890a9f664861a0274f2682ac60efe1bc`|

逐文件指纹与私有副本定位见[最终 dist 清单](evidence/final-dist.json)。Node 24.22.3、冻结 Python 3.12.10、Chromium Headless Shell 149.0.7827.55。沿用下文相同的旧库、消息、身份、fixture 和进程级强杀开关。最终两轮使用真实 Worker 摘要“离线样例结果”创建渠道草稿。为修复任务的预置校验，仅通过项目接口对本轮合成项目设置 `allowed_paths=["."]`，Host 的 PATH 只增加本机 Git 程序目录。Git 基线及可写文件均位于合成 Worker 工作区。

|本轮核对项|两轮实测|
|---|---|
|自动回复|同一私聊注入两次，仅有一条任务 2。假 Codex 实际进程返回 thread/turn。宿主验证为无工具回复，摘要、验证产物属于同一 attempt，成员验收为 completed。|
|修复及工具审批|合成任务 3 到达 waiting_approval，审批 4 错 hash 返回 409，仍为 pending。归属成员用正确 hash 批准后收到 approved，重放返回 409。任务到达 review_ready，独立核对 fixture-value.txt 的实际内容为 `after\n`，变更集只含该文件，Host 预置命令退出码为 0。旧 revision 验收 409，当前 revision 验收成功并持久化 completed。|
|草稿权限|同一条非空草稿在 admin 和归属成员 bob 身份下均返回 200、1 条，ID 与正文相同。另一成员 alice 及 viewer 均返回 404、0 条。旧任务 local-admin 经治理映射归 alice。任务列表、详情、导出、历史附件与新产物下载、overview 的活动及待批范围亦通过。|
|进程强杀与 UI|首轮 PID 31496 → 46916，第二轮 51260 → 36280。收件后的 Host 均以 1 退出，账本为 dispatching。分别等待 25.883、25.108 秒到原租约到期，重启移除退出开关，epoch 1 → 2，恢复为 unknown。浏览器填入独立回执号提交后返回 200，刷新显示“已回复”。逐张核对两轮截图，浏览器页面脚本错误均为零。|
|同库回切|第二个 Host 正常退出，冻结 Uvicorn 重开本轮相同文件。文件标识分别为 11540474046230819、3940649675134084。每轮逐件对齐回复产物 2 件和修复产物 3 件的 ID、kind、revision、attempt_id 与内容 SHA-256；回读原工具批准、旧托管附件和渠道对账证据。重复发布后各轮只有 1 份真实假渠道文件，SQLite integrity_check 均为 ok。|

- 首轮有[业务和产物结果](evidence/phase1-final-1/result.json)、[逐次 HTTP](evidence/phase1-final-1/http.json)、[独立回执](evidence/phase1-final-1/receipt.json)、[对账前](evidence/phase1-final-1/01-unknown.png)、[刷新后](evidence/phase1-final-1/02-after-reload.png)。
- 第二轮有[业务和产物结果](evidence/phase1-final-2/result.json)、[逐次 HTTP](evidence/phase1-final-2/http.json)、[独立回执](evidence/phase1-final-2/receipt.json)、[对账前](evidence/phase1-final-2/01-unknown.png)、[刷新后](evidence/phase1-final-2/02-after-reload.png)。

两轮的审批交互通过正式 HTTP 完成，浏览器实际承担管理员对账。修复任务使用离线协议进程和合成 Git 工作区。旧结果中的 `candidate_signoff` 是总体验收标记，最终包业务回放的退出码两次均为 0。可复验的阶段 3、4 逐路由范围见 [119 项矩阵](ROUTES-119.md)。

## 旧构建记录

以下两轮记录使用早期构建。彼时自动 Worker 握手与关联草稿权限均有缺陷，投递回放用人工草稿完成。保留这些记录供相同用例作前后对照。

## 固定输入和版本

|项目|取值|
|---|---|
|Python 基线|旧库由提交 `7b7587d14399659d7951d3e195af863514fbf118` 的代码生成。回切使用冻结快照，346 份文件，集合指纹 `abf0a6922e8da03d65cd53458df256a509d824c3fbf276f58943cc800201b091`，Python 3.12.10。|
|契约与业务输入|契约 SHA-256 `f5718d78f6e5b64a8c23c1b37b8100084511420bc588a5ba9aa0b7f28d84811c`。基础 [input.json](input.json) SHA-256 `7ddc38cd2088781c96d99ad63d5c264f13111636d7eaf17a8ea0b49dcc8fc03b`。两轮均新建独立目录、项目、附件、用户目录和 SQLite。|
|TS 与浏览器|真实入口 `apps/server/dist/main.js`，Node 24.22.3。每轮启动前逐字节复制 dist，两次启动共用本轮副本。前端由工作树的 apps/web 构建到本轮临时目录，两轮实际提供的 JS、CSS 及 HTML 散列见各轮结果。Playwright 驱动 Chromium Headless Shell 149.0.7827.55，1440 × 1000，中文界面。|
|四个合成身份|admin，member alice，member bob，viewer。任务 1 的历史 owner 为 local-admin，governance 归属 alice；新私聊消息由测试身份映射至 bob，归属任务 2。两个任务属于同一项目。|
|渠道及故障开关|预览模式，Host 仅监听本机，`SUPERAGENT_DATA_DIR` 指向本轮 root。为经过投递业务条件，仅临时开启合成钉钉与外部投递，`SUPERAGENT_DRIVER=fixture` 写本地回执。强杀进程显式传入 `SUPERAGENT_FIXTURE_EXIT_AFTER_RECEIPT=1`，第二个进程删去此变量。回切前通过接口关闭调度、钉钉及外部投递，并用 Python 接口确认所有连接器关闭。|
|消息与草稿|来源 dingtalk，合成私聊线程 fixture-thread，消息 crash-001。重复注入返回相同事件和任务。草稿正文“离线人工草稿，核对收到”，动作 reply-3。检查回执的目标、正文及 action_hash，对照批准内容及真实回执目录中的文件数。|

## 强杀、对账和同库回切

|观测|第一轮|第二轮|
|---|---|---|
|main.js SHA-256|`b182fe360d0022a136733f031748938d4edcb0fcf58b1b12f7bb5f606f023c42`|`c3d8f2011f561384fa15e267f2e561b851363aa3a89b6a064141a289aaff7606`|
|首次 PID → 重启 PID|39808 → 5524|1352 → 41972|
|退出与恢复|首次退出码 1，账本 dispatching；按原租约等待 29.688 秒，再启动新 Host|首次退出码 1，账本 dispatching；按原租约等待 29.671 秒，再启动新 Host|
|接管与重新发布|epoch 从 1 变为 2，账本变为 unknown。重放发布后回执仍为 1 份|相同|
|浏览器操作|登录 → 事件中心 → 渠道回复 → 记录渠道核实结果。仅选择“已确认发送成功”时按钮仍禁用；填写本轮回执号、点击提交后返回 200|相同|
|刷新后|页面显示“已回复”，手工核实入口消失。账本保留核验证据，重放成功动作仍为原回执|相同|
|Python 回切|正常关闭第二个 TS 进程，冻结 Uvicorn 重开同一路径，文件 ID 为 254734853923392339|文件 ID 为 16888498603600083；同一轮前后相等|
|回切后的业务证据|任务 2 可导出，旧附件内容与原摘要相同，对账结果及证据可读；Python 重放相同动作后回执仍为 1 份，SQLite integrity_check 为 ok|相同|

两轮逐张打开对账前、刷新后的截图，核对了橙色未知状态、核验证据输入框、提交控件和绿色“已回复”卡片。浏览器均无页面脚本错误，只有登录前的受保护请求返回 401。浏览器发送的两项 POST 为登录与对账，均返回 200。Windows 浏览器验证使用独立 Chromium 配置，覆盖管理员对账路径。

- 第一轮有[逐项结果](evidence/phase1-manual/result.json)、[独立收件凭据](evidence/phase1-manual/receipt.json)、[浏览器记录](evidence/phase1-manual/browser.json)、[对账前](evidence/phase1-manual/01-unknown.png)及[刷新后](evidence/phase1-manual/02-after-reload.png)截图。该轮 JSON 的 passed 指此次投递回放。
- 第二轮有[逐项结果及权限表](evidence/phase1-repeat/result.json)、[独立收件凭据](evidence/phase1-repeat/receipt.json)、[浏览器记录](evidence/phase1-repeat/browser.json)、[对账前](evidence/phase1-repeat/01-unknown.png)及[刷新后](evidence/phase1-repeat/02-after-reload.png)截图。各轮目录另含两次 Host 和回切 Uvicorn 的日志。

## 阻断与通过范围

1. **草稿读取未按任务归属过滤。** 在第二轮非空样本中，admin 和归属成员 bob 各读到任务 2 的一条草稿，符合预期。非归属成员 alice 与 viewer 同样各读到一条，HTTP 200。对应任务详情与导出对二者均返回 404。修复复测要求同一份非空草稿在 admin、bob 下保留，在 alice、viewer 下均不可见。
2. **原样包的自动 Worker 握手失败。** 在与第二轮相同的 `c3d8f201…` 包中独立打开调度后，任务 2 在 workspace 阶段失败，错误为 initialize 时 process disconnected。thread/turn 均为空，假收件数为 0。包内 fake-app-server.ts 引用了同目录的 environment.ts，而实际 dist 缺此文件。较早版本的诊断试验仅在私有副本中补齐该文件，获得了 thread/turn，但最终为 waiting_resource、outcome_unknown=true，原因记录为进程树退出未确认。集成 Worker 自动生成结果、任务验收、产物回切仍待原样包通过。[Worker 三次实测](evidence/worker-checks.json)
3. **任务主界面的四身份读取通过。** admin 看到任务 1/2，alice 仅看到经 governance 回填的旧任务 1，bob 仅看到任务 2，viewer 为空。核对列表、同项目筛选、详情、导出、旧附件元数据与下载响应、overview 的状态计数、活动任务及待审批。成员对另一归属任务的详情和导出为 404，viewer 计数及待审批均为空。权限项通过 HTTP 独立验证；浏览器截图仅覆盖管理员操作。
4. **Windows 进程树单独复测通过。** Node 22.20.0、24.22.3 各 15/15，内含离线套件各 11/11。混合进程树的正常结束、强制结束、所有者进程退出各 3/3，两个版本均无清理失败记录。独立脚本 SHA-256 `262841e4b6b4e9eecb13405e0fca9af1b60cb0c5b0a63d98a33ff2f3b4647158`，原生 exe SHA-256 `425cd705d1fb3b5e2d47aba00c50145a890a9f664861a0274f2682ac60efe1bc`。临时 npm 布局只复制项目内的包，运行前逐文件比较。详见[双版本结果](windows-runtime-results.json)、[Node 22 日志](runtime-v22.20.0.log)和[Node 24 日志](runtime-v24.22.3.log)。

## 复跑入口

在独立工作树根目录执行 PowerShell。每轮打印自己的临时证据目录。自动 Worker 与独立投递各有一个入口。投递路径结束后，脚本也检查四身份的草稿可见性；有违规读取时以失败退出，并先保留已通过的强杀、浏览器和回切记录。

```powershell
$py = 'E:\Workspace\Workspace\Project\SuperAgentDemo\.venv\Scripts\python.exe'
$node22 = (Get-Command node).Source
$node24 = (Get-Command -All node | Where-Object { $_.Source -like '*CodexPrimaryRuntime*' } | Select-Object -First 1).Source
$deps = 'E:\Workspace\Workspace\Project\SuperAgentDemo\apps\web\node_modules'
$chromium = 'C:\Users\examp\AppData\Local\ms-playwright\chromium_headless_shell-1228\chrome-headless-shell-win64\chrome-headless-shell.exe'
$options = @('--node', $node24, '--web-deps', $deps, '--browser-exe', $chromium)
& $py -IB -X utf8 tests/rewrite-acceptance/phase1.py @options
& $py -IB -X utf8 tests/rewrite-acceptance/phase1.py @options --manual-draft
& $py -IB -X utf8 tests/rewrite-acceptance/windows_runtime.py $node22 $node24
```

复跑最终构建时，在同一 PowerShell 会话内指定固定的目录及散列。若在新工作树复跑，可将 `$dist` 指向具有相同五份文件及散列的 dist 目录。

```powershell
$tests = 'tests/rewrite-acceptance'
$pin = Get-Content "$tests/evidence/final-dist.json" -Raw | ConvertFrom-Json
$dist = Join-Path $tests $pin.private_dist
& $py -IB -X utf8 "$tests/phase1.py" @options --dist $dist --expect-dist-sha256 $pin.dist_sha256
& $py -IB -X utf8 "$tests/route_matrix.py" --check
```

最后一条命令在每个指定 Node 版本下执行未经修改的 `python -I -B tests/rewrite-runtime-review/candidate_checks.py`。本轮验证的是隔离开发包和真实本机进程。安装器、干净 Windows 用户环境、完整 119 路由的 TS 差分以及阶段 2–4 其余条目见[验收矩阵](MATRIX.md)；这些项目仍待独立实测。
