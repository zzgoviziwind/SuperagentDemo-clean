# T1-RELEASE1 WP1 执行所有权与恢复

基线为 `main` 的 `7b7587d14399659d7951d3e195af863514fbf118`。本记录仅覆盖 WP1。

## 改动

| 文件 | 实现 |
| --- | --- |
| `superagent/core/db.py` | 新增 `execution_attempts`、`controller_leases` 与活跃 attempt 部分唯一索引。现有 `artifacts` 新增可空的 `attempt_id`。 |
| `superagent/core/execution.py` | 在一个事务内领取任务并持久化 attempt。启动先获得本机锁和数据库租约，再分类恢复。数据库租约每 10 秒续约，超时 30 秒，接管递增 epoch。 |
| `superagent/core/scheduler.py`、`superagent/core/reply_worker.py` | Repair、Analysis、Reply 共用领取入口。attempt 追踪工作区、thread、turn、审批及证据。Worker 事件与产物关联 attempt。 |
| `superagent/main.py`、`superagent/api/operations.py` | 启动时冻结可能已执行的任务，失效旧 Worker 审批。正常关闭先停止派发，再并行停止 Worker，异步 drain 上限为 20 秒。任务 owner 或管理员可通过 `GET /api/v1/operations/tasks/{task_id}/attempts` 查看尝试记录。 |
| `tests/integration/test_execution_ownership.py` | 临时 SQLite、假 Codex、假渠道、子进程强杀、审批路由、关闭及迁移覆盖。 |

领取条件包含 `queued`、已知运行结果和无活跃 attempt。领取将任务置为 `running`，只推进一次 `state_version`。后续 Worker 状态写入检查当前版本。暂停、取消、关停设置控制版本围栏，确认退出后关闭 attempt，停止未确认时冻结为 `waiting_resource + outcome_unknown`。

turn 请求发出前持久化 `phase=turn`。即使应答尚未返回，只要可能已派发就按未知恢复。已登记并保留基线的预备工作区可接着使用。部分创建而未登记的工作区保留在原 attempt 路径，新 attempt 使用自己的路径。因改目标而进入 `waiting_input` 的任务也会在旧 turn 尚未确认退出时冻结。

## 测试

最终合并运行 **128 项通过，9 个子测试通过，耗时 76.10 秒**。其中 WP1 新增 18 项，原有聚焦回归 100 项，API 回归 10 项。有一条 Starlette TestClient 弃用提醒。`git diff --check` 通过。

在仓库根目录运行。将数据库、状态目录、工作区、附件、回复和 Codex 状态目录指向本次新建的临时目录，清除渠道、执行节点、模型及凭据环境变量。WP1 用例自行开启 `attempt`，其他用例走默认路径。

```powershell
& .venv/Scripts/python.exe -u -m pytest `
    tests/integration/test_execution_ownership.py tests/review/test_review_races.py `
    tests/review/test_artifact_exports.py tests/runtime/test_daemon.py `
    tests/integration/test_execution_nodes.py tests/runtime/test_workspace.py `
    tests/runtime/test_evidence.py tests/runtime/test_approval.py tests/runtime/test_limits.py `
    tests/runtime/test_dynamic_tools.py tests/integration/test_lifecycle.py `
    tests/governance/test_governance.py tests/core/test_api.py `
    -q -ra -p no:cacheprovider -o faulthandler_timeout=30 --basetemp (Join-Path $runRoot 'pytest')
```

初次运行停在 Windows asyncio 创建唤醒套接字。最终在允许本机回环的条件下重跑，使用临时库和已有离线测试替身。

## 故障验证

| 场景 | 检查结果 |
| --- | --- |
| 两个 Scheduler 与并发领取 | 同一任务仅一个 attempt，一个 Worker 调用。错误 owner 与重复调用均未启动假 turn。 |
| 强杀于领取前、领取后、工作区部分创建、工作区登记后、thread 后 | 任务保持或恢复为 `queued`，原需求及 revision 保留。重建后只有一份模拟写文件和测试动作记录。 |
| 强杀于 turn 发出尚未拿到 ID、turn 进行中、turn 完成后证据提交前 | 任务与 attempt 冻结。重复调度无法领取，未生成第二份模拟副作用或验证产物。 |
| 审批与重启 | 活跃审批在新路径上可正常决定，旧 Worker 审批变为 `expired_on_restart`，HTTP 返回 409。渠道草稿审批保留原状态。 |
| 租约与关闭 | 验证同机锁互斥、进程退出后租约未过期时拒绝接管、过期后 epoch 递增、续租丢失通知停止。确认退出时任务暂停，关闭卡住时在测试设定的短上限内返回并冻结，迟到退出保持未知。 |
| 旧 SQLite | 连续运行两次迁移，既有产物仍可读取，历史产物的 `attempt_id` 为空。SQLite 和 PostgreSQL 的部分索引 DDL 均通过 SQLAlchemy 编译。 |

## 回滚

默认使用 `SUPERAGENT_EXECUTION_MODE=legacy`。隔离验收时显式开启 `attempt`。同一状态库切换模式前先停止控制器。回滚时以 `legacy` 重启并保留新增表、字段及已有未知记录。未知任务先按现有流程人工对账，再决定是否恢复。WP1 未改动其他开关。

## 未验证与风险

- 未进行真实 Codex、真实渠道、真实 PostgreSQL 数据库、Linux、Docker 或远端节点在 attempt 模式下的验收。原远端节点路径的 legacy 回归使用本机临时服务和假 Codex。
- 20 秒是 Worker 异步 drain 的等待预算。失联数据库的连接超时和操作系统回收孤立进程需要分别验收。
- 同一状态库须统一执行模式。旧模式控制器沿用旧恢复方式和调度入口，切换时不得与 attempt 模式并行运行。
- 两个控制器使用不同状态目录时依赖数据库租约。跨主机时钟偏差和长时间断网需要独立验收。

未发送真实渠道消息，未操作真实数据库，未调用真实 Codex 登录，未提交或推送。WP2 等待确认。
