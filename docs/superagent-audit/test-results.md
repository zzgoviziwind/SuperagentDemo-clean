# 非破坏性验证记录

## 执行范围

- 2026-11-17，北京时间。Windows、Python 3.12.10、pytest 9.2.0、Node 22.20.0、Git 2.45.1.windows.1。基线 HEAD `fc5cf2d0e497319b81fb00397ecca39a1cd516ec`，包含未提交改动。实际测试的 226 个文件见 SHA-256 清单（本机证据：`evidence/source-sha256.txt`）；后端仅对被忽略的 `.test-tmp/superagent-audit-20261117` 副本执行，前端在原路径使用既有依赖，构建产物写入隔离目录。
- 回查时，快照与原工作树有四个文件差异：`superagent/core/feishu_decisions.py`、`tests/integration/test_feishu_decisions.py`、`deploy/verify_feishu_card.py`、`deploy/verify-feishu-card.ps1`；本审计没有修改它们。快照后的飞书改动不计入当次验证。按清单可重跑同版本；重跑前先校验哈希。
- 所用真实资源仅临时 SQLite、临时文件、样例 Git 仓库和模拟适配器；没有访问工作台 8765、项目数据库、真实模型、真实账号、真实消息或任何 Git 远端。无业务源码改动、提交或部署。
- TCP 回环黑盒启动遇到 Winsock 10013，Windows 默认 asyncio 事件循环初始化也未在本轮等待窗口内完成。Git for Windows 在本地克隆时调用的 MSYS 子进程遇到 `NtCreateDirectoryObject ... 0xC0000022`。没有申请更高权限。分别改用 SQLite 直接调用及明确拒绝 I/O 的单线程定时测试循环，验证可执行的逻辑；它们不能替代协议、进程树、TCP、真实 Git 或模型验收。

## 执行批次

| 批次 | 执行命令简写 | 实际结果 | 耗时（墙钟） | 原始证据 |
| --- | --- | --- | ---: | --- |
| B0 | 标准 pytest 全量与独立收集 | 独立收集 562 项；全量在本机环境下未完成，主动停止审计自己启动的进程；无全量通过/失败数 | 收集 3.66 s（pytest 报告）；全量未完成 | 收集结果（本机证据：`evidence/backend-collected.txt`）；H0 复现相同 TCP 权限问题 |
| B1 | 标准 pytest，数据层、规则、工作区和取证抽样 | 57 通过、1 失败、1 跳过、2 未选；另 9 个子断言通过。工作区测试失败由隔离 Git 克隆限制复现；硬链接不可用而跳过 1 条 | 23.55 s | B1（本机证据：`evidence/backend-no-socket.txt`）、本地 clone 诊断（本机证据：`evidence/git-clone-diagnostic.txt`） |
| B2 | 同进程定时测试循环跑语义分流、路由/交付、审批、巡检 | 136 通过、1 失败、15 未选。通过含 H1/H6/H8 的第一版 3 个探针；唯败是 DWS 历史回放测试需要启动真正的假 DWS 子进程，替代循环不支持其 I/O，监听状态未至 running。不给 DWS 进程集成计分 | 62.89 s | B2（本机证据：`evidence/backend-socketless.txt`）、[定时测试运行器](evidence/socketless_runner.py) |
| B3 | 标准 pytest，角色/预算/审计链/SQLite 快照 | 43 通过、32 未选；包括角色边界、并发预算账、IO 外的事件追踪、SQLite 快照往返和异常 | 12.50 s | B3（本机证据：`evidence/backend-lifecycle-governance.txt`） |
| B4 | 5 个同进程控制探针 | 5 通过；三个是复验，另两个分别验证静默超时和只向正确 Worker 追加。探针证实的缺口本身不算能力通过 | 7.66 s | B4（本机证据：`evidence/inprocess-probes.txt`）、[探针源码](evidence/inprocess_probes.py) |
| H0 | 四个真实子进程黑盒探针 | 4 个在 fixture 启动检查报 10013，测试正文未运行；无功能失败判定 | 50.28 s | H0（本机证据：`evidence/probes-pytest.txt`）、[黑盒探针源码](evidence/audit_probes.py) |
| F1 | `npm test` | 108 通过、2 失败（21 文件，1 文件失败） | 43.84 s | F1（本机证据：`evidence/frontend-vitest.txt`） |
| F2 | `npm run build -- --outDir <隔离路径>` | 类型检查、Vite 生产构建成功，67 个模块，产物写入隔离目录 | 23.88 s | F2（本机证据：`evidence/frontend-build.txt`） |
| F3 | `npm test -- src/App.test.tsx -t '飞书链接打开当前审批\|事件中心使用满高'`（正则分隔符为普通竖线） | 审批链接通过、布局断言再次失败、20 未选 | 11.89 s | F3（本机证据：`evidence/frontend-targeted.txt`） |

B1–B4 合计 **238 个不同的通过项**，其中 233 个仓库测试，5 个新增审计探针；另有 2 个环境/运行器相关失败、1 跳过。三项重复探针没有重复计数。挑选用例与测试替身有偏，不能将通过数当作全量通过率或生产成功率。前端全量失败判断以 F1 为准，F3 用来区分可重现性。

F1/F3 的判断依据：

- `apps/web/src/App.test.tsx:93–100`：同一源码的全量失败为“找不到批准按钮”，定向通过。打开链接本身不应提交决定；暂无证据确认线上会丢审批或必现。对应入口 `apps/web/src/main.tsx:265–286,528–627`。以延迟加载、有效与过期链接的真实浏览器回归区分测试时序问题和产品问题。
- `apps/web/src/App.test.tsx:111–117`：账号字段 `closest("aside")` 两次返回 null；`apps/web/src/main.tsx:716,742` 的账号位于上方导航，侧栏另有 `aside`。证据支持布局与旧断言不一致，是否还要维持旧布局属于产品验收，不能据此认定整个工作台坏了。

## 十个要求场景

| 场景 | 前置与执行步骤 | 预期 | 实际与证据 | 裁决及失败/限制 |
| --- | --- | --- | --- | --- |
| **H1 执行中强停恢复** | H0 假 Codex 接轮次后拟杀专属 PID 树再起；B4 用 SQLite 预置运行/待批/排队，调用真实启动恢复代码，后台循环替换为空操作 | 原状态、线程与副作用有迹；未知不可自动重放，安全项有明确恢复路径 | B4：运行及待批改成 `waiting_resource / outcome_unknown`，线程和轮次保留，队列仍在，重试 409。见 `inprocess_probes.py::test_restart_handler_fences_approval_and_running_rows` | **部分验证**。真强停的前置被回环 10013 阻断；未验证进程树、未确认外部写、真实会话恢复。 |
| **H2 两 Worker 隔离与汇总** | 两任务/四任务的已有黑盒，分别取工作区、线程、审批、结果；B1 验子任务结果回流和独立目标 | 分别执行、互不串写、各自得出可归属结果 | `tests/e2e/test_blackbox.py:214–265` 收集到但未得原生结果；B1 子结果回流与目标隔离通过，克隆失败日志可复现 | **部分验证**。流程数据隔离可复核；真实并行进程和隔离克隆 N/V，受 TCP/Git 本机限制。 |
| **H3 重复事件幂等** | SQLite ，同外部 ID 重复/并发提交、并发账本 claim，另测不重复追加目标 | 同一收件、目标和外部动作至多一个正式账本记录 | B1 扇出测试通过；B2 `test_concurrent_duplicate_receipts_and_crashed_send_claim`、回声和待核验测试通过 | **通过（本轮 SQLite 与模拟渠道）**。跨 PG 实例、重启真实 HTTP 路径未验。 |
| **H4 工具不返回、超时和取消** | B4 真实监视函数接无输出事件迭代替身，idle 阈值 1 秒；B2 模拟巡检超时、停止不确认 | 不无限等待；取消必须确认，未确认不重试 | B4 实际抛 `TimeoutError`；B2 `test_elapsed_timeout_preserves_unknown_record`、`test_unconfirmed_stop_is_recorded_as_unknown` 通过 | **部分验证**。真实命令/后台子进程取消、绝对超时和重启回收 N/V。 |
| **H5 模型接口失败与恢复** | 将语义模型 runner 换成抛异常的替身，继续泵并提交人工修正 | 失败有据、可安全重试才重试，未知不能擅自重复 | B2 `test_failed_call_never_replayed_and_manual_correction_idempotent`、`test_background_loop_recovers_from_one_iteration_error` 通过：未自动重播，人工纠正可幂等推进 | **部分验证**。未调用实际模型；未知保护通过，已知临时失败的有界退避重试未形成统一策略。 |
| **H6 无效循环/持续失败** | B4 每 150 ms 返回同一个 delta，1 秒空闲阈值，观察 >2 秒；B2 注入 Watchdog 模型 pause 和无效结果 | 重复输出不延长有效进度；识别并按预算停止/升级 | B4 14 次相同增量通过监视，未触发空闲阈值，复现缺口。B2 模型建议路径能暂停或记录未知 | **未达到预期**。证实空闲监视可以被重复输出延续；整机 Watchdog 在现实重复失败场景未验。 |
| **H7 活动任务追加事件** | B4 SQLite 预置两个活动 Worker，直接调用真实 Web 处理函数向第二个追加；假客户端记录 steer 目标。B1 验外部事件扇出和中断钩子 | 正确线程、轮次和修订，其他 Worker 不收消息 | B4 只存到 Worker 2，且调用 `steer(t2,u2)`。B1 权限/版本中断路径通过。H0 真实进程探针未启动 | **部分验证**。平台路由有效；未验证实际模型对 steer 的处理和最终输出。 |
| **H8 长上下文压缩和历史召回** | B4 SQLite 存 31 条各逾 4,200 字符文本，关键旧决策放首条；执行真实 timeline/描述/提示构建 | 裁剪后仍保留可回溯索引，关键决策可召回 | 仅注入最近 24 条，提示 76,034 字符；最早决策仍在库，但缺席提示，近期长文本尾也不在。B2 验 Router 选择性材料读取 | **部分能力通过，召回目标未达**。证实平台裁剪和丢信息，不推断真实模型压缩表现。 |
| **H9 待审批重启** | 预置当前版审批与 `waiting_approval`，运行实际启动处理后再次决定 | 审计记录可见，旧会话不可审批，且有安全接管路径 | B4：审批记录仍在，任务变未知/待资源，旧按钮对应后端决定 409。已有黑盒 `test_restart_waiting_approval_requires_reconciliation` 只收集 | **部分验证**。系统不会原样继续等待同一个运行时请求；必须先对账并发起新轮/新审批，符合当前安全策略。 |
| **H10 从分析、改码、测试、Review 到交付** | 仓库已有 `test_full_delivery_and_persistence`、`test_authorized_redmine_event_routes_once_into_delivery`；分段查命令、差异、审批、交付 | 可查工作的可重跑证据、独立 Review、同版本回执 | B1 运行取证与失败判断，B2 运行审批保护、模拟授权渠道写回，F2 构建工作台；整条新鲜项目链未获本轮运行结果 | **整链 N/V**。TCP/Git 阻断基础；真实模型/渠道、独立 Review 和 CI/部署回执也不在已验证能力中。 |

未执行：真实账号与真实业务渠道，任何生产部署/数据库，独立 PostgreSQL（本环境找不到 Docker/pg_ctl/psql），Playwright 浏览器截图（隔离预览依赖回环端口；本轮不改界面），持续水平与负载、主备切换以及全量原生回归。未从已有历史日志借分。

## 复跑命令（PowerShell）

使用已准备的快照目录。若需重建，在新目录按 清单（本机证据：`evidence/source-sha256.txt`） 逐条复制并核对 SHA-256，不要覆盖其他人的目录。以下只在隔离目录执行；每次用全新的 `--basetemp`。使用已有 venv 与 node_modules。遇到同一权限错误跳过 TCP/Git 专项，不连接现有工作台。

```powershell
$repo = (Get-Location).Path
$evidence = Join-Path $repo 'docs/superagent-audit/evidence'
$python = Join-Path $repo '.venv/Scripts/python.exe'
$scratch = Join-Path $repo '.test-tmp/superagent-audit-20261117'
# 校验快照，勿因工作树继续变化改用未经标识的源码
Get-Content (Join-Path $evidence 'source-sha256.txt') | ForEach-Object {
  $checksum, $relative = $_ -split '  ', 2
  if ((Get-FileHash -LiteralPath (Join-Path $scratch $relative)).Hash -ne $checksum) {
    throw "快照哈希不匹配: $relative"
  }
}
Get-ChildItem Env: | Where-Object Name -Match '^(SUPERAGENT_|DINGTALK_|REDMINE_|HLZJ_|FEISHU_|LARK_|CODEX_|OPENAI_|ANTHROPIC_|DEEPSEEK_|GITHUB_|GH_|GIT_CONFIG_)' |
  ForEach-Object { Remove-Item -LiteralPath "Env:$($_.Name)" }
$env:GIT_CONFIG_NOSYSTEM='1'
$env:GIT_CONFIG_GLOBAL='NUL'
$env:PYTHONDONTWRITEBYTECODE='1'
$env:SUPERAGENT_DATABASE_URL='sqlite:///' + (Join-Path $scratch 'repro-guard.db').Replace('\','/')
$run = [guid]::NewGuid().ToString('N')
Set-Location $scratch
# B0：收集；原生全量仅在隔离主机确认回环和本地 clone 可用后执行
& $python -m pytest tests --collect-only -q -p no:cacheprovider
# B1
& $python -m pytest tests/integration/test_subscriptions.py tests/integration/test_execution_nodes.py tests/runtime/test_outcome.py tests/runtime/test_evidence.py tests/runtime/test_workspace.py tests/runtime/test_limits.py tests/core/test_readonly_tools.py tests/governance/test_model_usage.py tests/integration/test_event_groups.py -k 'not http_contract and not end_accepted' -q -ra -p no:cacheprovider --basetemp "repro-b1-$run"
# B2（新增探针现在共有五条；原批次只有前三条）
& $python (Join-Path $evidence 'socketless_runner.py') (Join-Path $evidence 'inprocess_probes.py') tests/integration/test_semantic_routing.py tests/integration/test_autonomous_settings.py tests/integration/test_watchdog.py tests/review/test_review_races.py tests/integration/test_routing_delivery.py tests/integration/test_router_agent.py -k 'not management_api and not manual_review_returns and not preserves_new_revision and not acceptance_rechecks and not process_does_not_inherit and not real_dws and not real_http and not api_admin and not member_task_owner and not manager_shutdown and not redmine_stop_retains and not dws_downloaded_image and not silent_stream and not running_web_message' -q -ra -s -p no:cacheprovider --basetemp "repro-b2-$run"
# B3
& $python -m pytest tests/governance/test_governance.py tests/e2e/test_snapshot.py tests/integration/test_lifecycle.py -k '(permissions or auth_roles or rebinding or owner_persistence or budget_concurrent or budget_unknown or budget_invalid or budget_requires or environment_connector or codex_defaults or SnapshotAcceptance or test_lifecycle) and not manual_budget' -q -ra -p no:cacheprovider --basetemp "repro-b3-$run"
# B4
& $python (Join-Path $evidence 'socketless_runner.py') (Join-Path $evidence 'inprocess_probes.py') -s -q -ra -p no:cacheprovider --basetemp "repro-b4-$run"
# H0：仅在允许回环且工作区为一次性副本时运行
# & $python -m pytest (Join-Path $evidence 'audit_probes.py') -s -q -ra -p no:cacheprovider --basetemp "repro-h0-$run"
Set-Location (Join-Path $repo 'apps/web')
npm test
npm run build -- --outDir (Join-Path $scratch "web-dist-$run")
npm test -- src/App.test.tsx -t '飞书链接打开当前审批|事件中心使用满高'
```
