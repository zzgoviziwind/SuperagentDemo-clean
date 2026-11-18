# T1-RELEASE1 WP2 决定与上下文清单

基线为 `main` 的 `7b7587d14399659d7951d3e195af863514fbf118`。本记录覆盖 WP2，依赖已交付的 WP1 工作树改动。

## 改动

| 文件 | 实现 |
| --- | --- |
| `superagent/core/db.py` | 新增 `decisions`、`context_manifests`。现有 `execution_attempts` 新增可空的 `manifest_id`。迁移可重复执行。 |
| `superagent/core/context.py`、`superagent/core/message_context.py` | 组装当前有效决定、近期事件、同范围近期工作和上轮摘要。决定优先，组装部分使用 80,000 字符预算，决定部分最多 16,000 字符。清单记录 ID、来源、字符数及纳入、截断结果。 |
| `superagent/core/scheduler.py`、`superagent/core/reply_worker.py` | Repair、Analysis、Reply 在 `start_turn` 前提交清单，随后关联 turn。进入 `review_ready` 前检查清单与实际轮次匹配。Field Intake 的渠道回复条件和历史附件查询已纳入回归。 |
| `superagent/api/context.py`、`superagent/main.py` | 提供决定创建、撤销、查询和清单读取接口，写操作存审计。 |
| `tests/integration/test_context_ownership.py` | 覆盖 31 条事件、早期决定、撤销、历史摘要、权限、预算、清单故障、Reply、Field Intake、加法迁移。 |

决定默认从当前项目与当前任务召回。项目级决定由管理员创建和撤销，任务级决定由任务负责人或管理员管理。绑定来源事件的决定只对有权使用该来源的任务可见。任务更换项目后，新提示从当前项目取上下文，历史清单由管理员继续查阅。

开启 `decisions` 后，每轮 Worker 新建 Codex thread，避免恢复已携带旧决定的 thread。上轮摘要和近期工作摘要若由当前已撤销或超出当前任务范围的决定生成，会留在历史记录中，并在本轮清单中标为未纳入。原始事件按当前任务权限作为历史证据提供。Field Intake 继续使用原渠道回复条件和附件选择规则。

## 接口

- `POST /api/v1/decisions` 写入决定，`POST /api/v1/decisions/{decision_id}/revoke` 保存撤销原因和操作者。
- `GET /api/v1/decisions` 和 `GET /api/v1/tasks/{task_id}/decisions` 支持按状态查询。管理员可按项目查询，成员可按本人负责的任务查询。
- `GET /api/v1/attempts/{attempt_id}/context` 查询该次执行清单。`GET /api/v1/tasks/{task_id}/context` 同时支持未开启 WP1 attempt 模式的轮次。

## 测试

最终合并运行 **180 项通过，9 个子测试通过，耗时 215.51 秒**。包含 WP2 新增 8 项、WP1 18 项、原有聚焦回归 100 项，以及 API、消息回复、只读分析和 Field Intake 回归。有一条 Starlette TestClient 弃用提醒。`git diff --check` 通过。

在仓库根目录运行，沿用 [WP1 的隔离准备](T1-RELEASE1-WP1.md#测试)。使用 Windows 本机回环、临时目录和离线替身。WP2 用例显式开启 `decisions`，并覆盖执行模式独立切换。现有回归使用默认上下文路径。

```powershell
& .venv/Scripts/python.exe -u -m pytest `
    tests/integration/test_context_ownership.py tests/integration/test_execution_ownership.py `
    tests/review/test_review_races.py tests/review/test_artifact_exports.py `
    tests/runtime/test_daemon.py tests/integration/test_execution_nodes.py `
    tests/runtime/test_workspace.py tests/runtime/test_evidence.py tests/runtime/test_approval.py `
    tests/runtime/test_limits.py tests/runtime/test_dynamic_tools.py tests/integration/test_lifecycle.py `
    tests/governance/test_governance.py tests/core/test_api.py tests/integration/test_message_response.py `
    tests/core/test_analysis_readonly.py tests/integration/test_field_intake.py `
    -q -ra -p no:cacheprovider -o faulthandler_timeout=40 --basetemp (Join-Path $runRoot 'pytest')
```

## 故障验证

- 31 条事件中，最早来源事件落在时间线预算外，已有的关键决定和 ID 仍进入提示。清单记录 24 条实际纳入，以及超出数量和文本上限的项。
- 撤销后新轮次跳过该决定及引用它的旧摘要。旧清单仍可核对。同负责人其他任务、不同负责人、其他项目和已换项目的历史来源均经过负向检查。
- 注入清单写入故障时，假 Codex 未收到 `start_turn`。轮次启动后人工移除清单时，任务被冻结，未进入 `review_ready`。
- 回复 Worker 在执行模式仍为 `legacy` 时可生成可查询的清单。`attempt_id` 为空。
- 两次运行旧 SQLite 加法迁移，旧 attempt 仍可读取。`decisions` 和 `context_manifests` DDL 已按 SQLite、PostgreSQL 方言编译。

## 未验证与风险

- 真实 Codex、真实渠道、PostgreSQL 实例和上线后的端到端行为待验收。当前验证使用临时 SQLite 和离线替身。
- 清单的字符预算覆盖决定、事件、近期工作和摘要。任务目标、固定提示和附件继续适用原有规则。决定正文与撤销原因对常见凭据格式做脱敏。
- 撤销从下次派发快照起生效。已经派发的 turn 按原快照执行。

## 回滚

以 `SUPERAGENT_CONTEXT_MODE=legacy` 重启控制器。默认即为 `legacy`。保留新增表、字段和历史清单。WP1 的开关可独立设置。

未发送真实渠道消息，未操作真实数据库，未调用真实 Codex 登录，未提交或推送。WP3 等待确认。
