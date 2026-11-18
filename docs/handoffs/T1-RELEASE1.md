# SuperAgent Release 1 交付记录

任务为 T1-RELEASE1。基线为 `main` 的 `7b7587d14399659d7951d3e195af863514fbf118`。交付保留在当前工作树。

## 改动

| 工作包 | 交付 |
| --- | --- |
| WP1 | 执行尝试账本、原子领取、控制器租约、重启分类、旧审批失效、并行有界关闭。详见 [WP1](T1-RELEASE1-WP1.md)。 |
| WP2 | 决定与撤销、权限过滤、上下文预算和轮次 manifest，覆盖 Repair、Analysis、Reply。详见 [WP2](T1-RELEASE1-WP2.md)。 |
| WP3 | 独立投递循环、两阶段发送账本、执行槽分配、空闲进度判定和绝对期限。 |

WP3 的 `delivery.py`、`connectors/common.py` 和 `main.py` 把自动投递移出 Scheduler 的轮询等待。投递每次处理一个候选，遇到循环异常退避。发送前先持久化 `claimed`，校验当前审批、版本、目标和规则，再持久化 `dispatching`。每次领取以独立令牌围栏，过期领取的旧发送者无法继续派发。渠道结果进入 `succeeded`、`failed` 或 `unknown`。

WP3 的 `scheduler.py`、`reply_worker.py` 和 `main.py` 分开跟踪执行中的 Worker 与等待审批的 Worker。等待审批的 Worker 保有客户端，释放执行槽。继续审批前先检查执行容量，槽满时审批仍为待处理。等待数达到保护阈值时暂停新派发。绝对时钟从领取后的执行入口开始，覆盖启动、轮次、等待审批和证据收集。相同工具项或审批请求的重复事件不刷新进度。等待人工审批暂停空闲计时，绝对期限照常计算。

## 迁移与开关

新增 `execution_attempts`、`controller_leases`、`decisions` 和 `context_manifests`，以及 `artifacts.attempt_id`、`execution_attempts.manifest_id`、`delivery_records.claim_token` 可空字段。迁移由 `init_db()` 执行。旧投递结果和审批历史保留。

| 配置 | 默认 | 新路径 |
| --- | --- | --- |
| `SUPERAGENT_EXECUTION_MODE` | `legacy` | `attempt` 启用执行尝试、容量分配和绝对期限。 |
| `SUPERAGENT_CONTEXT_MODE` | `legacy` | `decisions` 启用决定注入与轮次清单。 |
| `SUPERAGENT_DELIVERY_MODE` | `inline` | `worker` 启用独立自动投递。 |
| `SUPERAGENT_LEDGER_MODE` | `v1` | `v2` 启用两阶段账本。 |
| `SUPERAGENT_MAX_RUN_SECONDS` | `3600` | attempt 模式下的绝对期限，单位为秒。 |
| `SUPERAGENT_MAX_WAITING_APPROVAL` | `4` | attempt 模式下暂停新派发的等待审批数。 |

## 测试

WP3 新增 14 项通过。最终聚焦批次共 320 项，319 项通过，另有 13 个子测试通过，耗时 271.12 秒。唯一失败是原有工作区测试的 Windows 临时目录清理遇到文件占用。换用新临时目录复跑工作区测试及 WP1–WP3 共 41 项，全部通过，耗时 55.29 秒。首次 WP3 专项运行中，强杀测试的子进程缺少测试目录的导入路径，修正后两种强杀场景均通过。已清理测试残留和核对工作仓库 HEAD，`git diff --check` 通过。

Windows 使用临时 SQLite，Codex 和渠道脱网。既有回归中的协议测试使用本机回环和假服务。执行前清除真实连接和凭据变量，将数据库和状态目录指向新建临时目录。隔离准备见 [WP1 测试](T1-RELEASE1-WP1.md#测试)。

```powershell
& .venv/Scripts/python.exe -u -m pytest `
    tests/integration/test_delivery_isolation.py tests/integration/test_context_ownership.py `
    tests/integration/test_execution_ownership.py tests/review/test_review_races.py `
    tests/review/test_artifact_exports.py tests/runtime/test_daemon.py tests/integration/test_execution_nodes.py `
    tests/runtime/test_workspace.py tests/runtime/test_evidence.py tests/runtime/test_approval.py `
    tests/runtime/test_limits.py tests/runtime/test_dynamic_tools.py tests/integration/test_lifecycle.py `
    tests/governance/test_governance.py tests/core/test_api.py tests/integration/test_message_response.py `
    tests/core/test_analysis_readonly.py tests/integration/test_field_intake.py `
    tests/integration/test_autonomous_settings.py tests/integration/test_routing_delivery.py `
    tests/connectors/test_connectors.py tests/integration/test_event_rules.py `
    -q -ra -p no:cacheprovider -o faulthandler_timeout=40 --basetemp (Join-Path $runRoot 'pytest')
```

复跑使用新的 `$runRoot`，同一命令的模块列表改为 `tests/integration/test_delivery_isolation.py tests/integration/test_context_ownership.py tests/integration/test_execution_ownership.py tests/runtime/test_workspace.py`。

## 故障验证

| 场景 | 核对项 |
| --- | --- |
| 慢渠道 | 模拟发送耗时 2 秒。另一个 queued 任务在发送中完成执行，且允许独立查询其 manifest。重复发布只读取发送中账本。 |
| 等待审批 | 执行容量为一时，等待审批的 Worker 让出执行槽。槽满提交审批得到 409，保留待处理状态。释放后提交成功。达到等待保护阈值时暂缓派发。 |
| 重复输出和静默 | 相同进度事件持续重复、静默流和等待审批分别在测试配置的 2.25 秒绝对期限到时冻结。重复进度也可先触发空闲期限。未派发轮次的启动超时标为失败。 |
| 在领取或派发后强杀 | 超过 30 秒的旧 `claimed` 可重试。同一动作只有一次模拟发送。持有控制器租约的重启将遗留 `dispatching` 冻结为 `unknown`。 |
| 版本与结果围栏 | 已回收令牌被拒绝，撤销或过期审批不能开始派发，取消后的不确定结果保持未知，迟到结果不覆盖人工对账。旧 v1 unknown 保持未知。 |
| 已订阅来源 | 决定模式的时间线保留原始事件。投递副本通过其原始事件通过同一权限边界。 |

## 发布前隔离验收（2026-11-19）

先用 PostgreSQL 验收迁移、双实例领取与账本，再用专用测试 Codex 验收超时中断和重启。产品代码和部署配置未改动。

| 范围 | 证据与结果 |
| --- | --- |
| PostgreSQL 16.15 加法迁移 | Windows 上启动只监听 `127.0.0.1` 的一次性实例，先用 `7b7587d` 的代码创建旧库和合成数据，再用当前工作树连续运行两次 `init_db()`。新增表和可空字段齐备，旧产物及旧 `unknown` 账本保留。 |
| PostgreSQL 双实例 | 两个独立 Python 进程中的 `Scheduler.poll` 同时到达领取点，同一 queued 任务只生成 **1 条 attempt 和 1 次 run**。部分唯一索引拒绝同任务的第二条活跃 attempt，SQLSTATE 为 `23505`。控制器使用不同本机锁目录时，数据库拒绝第二个有效租约，释放后接管的 epoch 从 1 增至 2。 |
| PostgreSQL 投递账本 | 用假渠道读取 `dispatching` 已提交后才发送。过期 `claimed` 回收后仅模拟发送一次，旧领取令牌失效。模拟恢复将遗留的 `dispatching` 冻结为 `unknown`。迟到成功回执未覆盖人工对账，v1 的 `unknown` 保留。 |
| 真实 Codex 超时中断 | 用 `0.169.0-alpha.11.1` 和历史验收用的专用登录运行一条合成长文本任务，应用状态存入独立 SQLite。9 秒期限配置下，从验收控制器启动到标记任务耗时 **9.156 秒**。观察到 1 次真实 turn 确认、1 次中断请求和 1 次响应，终态为 `interrupted`，app-server 正常退出。任务为 `waiting_resource + outcome_unknown`，attempt 为 `unknown`。 |
| 真实 Codex 重启恢复 | 在真实 turn 已持久化且仍活跃时，强杀本次测试控制器及其子进程树。数据库租约过期后用同一隔离 SQLite 重启，epoch 从 1 增至 2，最新 `startup_recovered` 记录 `unknown=1`。任务冻结并保留原 thread、turn 和 manifest。库内仍只有 1 条 attempt、1 条 manifest、1 条 `run_started` 和 1 条关联 turn 的事件。 |

PostgreSQL 二进制包的本地 SHA-256 与 EDB 公布值一致，临时实例已停止，临时库和二进制已清理。Codex 重启验收脚本先后修正了 Windows Python 启动器的 PID 判断和启动事件取样顺序。最终以只读方式核对已完成的强杀重启记录，使用最新恢复事件并核对执行记录总数。 [EDB 校验值](https://github.com/EnterpriseDB/edb-installers/issues/696)

本机证据为 [PostgreSQL 结果](../../.test-tmp/release1-acceptance-20261119-ba7c7489/postgres-evidence.json) 和 [Codex 结果](../../.test-tmp/release1-acceptance-20261119-ba7c7489/codex-evidence.json)。同目录保留合成验收脚本 `pg_acceptance.py`、`codex_acceptance.py`。隔离范围覆盖本机 PostgreSQL 与独立 SQLite 上的真实 Codex。真实钉钉、Redmine 和飞书全程关闭。

## 未验证

真实 PostgreSQL 与 Codex 同实例联跑、远端节点的 attempt 模式、Linux、Docker、真实渠道和生产部署仍待验收。整仓全量回归仍待执行。

## 回滚

先停止同一状态库的控制器，再设置 `legacy / legacy / inline / v1` 并重启。保留新增表、字段、清单和未知结果，先按证据对账。账本切回 v1 后，遗留 v2 记录仍挡住同 ID 重发。回切 v2 后由其恢复逻辑重新评估可安全重试的领取记录。

## 风险与下一步

- 使用 v2 而没有独占控制器租约时，遗留 `dispatching` 在 120 秒后才按未知回收。独立投递循环定期检查，再次调用发布接口时也会检查该动作。同一库切换模式前停服务。
- 绝对期限冻结有潜在副作用的任务。运行时和渠道的退出清理可能继续，未知结果需要人工核验。正常关停分别等待投递循环和 Worker 清理。
- 本次真实 Codex 验收使用合成长文本任务，验证超时、进程中断和状态恢复。真实项目工具调用、审批执行和生产容量应在各自验收范围内单独验证。

未发送真实渠道消息，未连接或修改生产库，未发起新的 Codex 登录，未提交或推送工作仓库，未部署。
