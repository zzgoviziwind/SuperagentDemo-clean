# SuperAgent Release 1 交接文档

- **交接时间**：2026-11-18（Asia/Shanghai）
- **模式**：单任务交接（一项任务，一段启动 prompt）
- **任务 ID**：`T1-RELEASE1`
- **任务名称**：实现 SuperAgent Release 1（WP1–WP3）
- **当前状态**：架构评审、修复方案、转交草稿已完成；**实现尚未开始**；仓库无业务代码改动。

## 1. 共同目标

把 SuperAgent 从“依赖人工记忆和单进程偶然性”的状态，推进到可验证的 Release 1：

1. 同一任务最多一个执行所有者；重复启动/两个 worker 不会各自启动 Codex。
2. 重启/崩溃后按 attempt 分类恢复：未开始可重建、可能有副作用冻结、旧审批过期。
3. 平台拥有业务决定/撤销/引用图；Worker 能看到当前有效决定；每次模型调用有 `context_manifest`。
4. 投递与调度隔离；两阶段账本；等待审批不占执行槽；重复输出/长命令有绝对期限。

**验收目标是“边界收紧”，不是增加平台能力。** 不迁服务器、不引入 Magpie/Temporal/Celery、不重写、不做多租户、不接真实渠道。

## 2. 已确认的约束与决策

- 仓库：`E:\Workspace\Workspace\Project\SuperAgentDemo`
- 分支/基线：`main`，HEAD `7b7587d14399659d7951d3e195af863514fbf118`
- 工作树：tracked 文件 0 修改；11 个既有未跟踪文件在 `docs/superagent-audit/evidence/`。不要清理/提交它们。
- 平台：Windows、Python 3.12、`.venv\Scripts\python.exe`；SQLite 单进程为当前验收环境。
- 只做 Release 1；Release 2（daemon 韧性、验证/部署/指标、节点 v2、服务器、Magpie）不在本次范围。
- 不 commit/push/reset/checkout/clean；改动留给总控提交。不修改 `.git`。
- 不发送真实钉钉/Redmine、不调用真实 Codex 登录、不操作真实业务数据库/凭据；使用临时 SQLite、假 Codex/假渠道。
- 迁移只做加法：新表/新列 nullable，不删除/重命名现有字段；SQLite/PostgreSQL 兼容。
- 新行为用环境开关，默认保持旧行为；测试中显式开启新路径，验证后再逐个切换。
- 如果与 `AGENTS.md` 的多会话文件所有权冲突，停止并报告，不要强行修改他人文件。

## 3. 已完成的输入（接手方应读）

| 材料 | 绝对路径 | 用途 |
| --- | --- | --- |
| 第一轮评审 | `C:\Users\examp\.codex\visualizations\2026\11\17\01a1e8cb-6407-76c1-b689-c8a2d01fa7cb\architecture-review-20261118\independent-review-20261118\独立架构评审报告-20261118.md` | 14 项发现、状态权威、部署/编排对比 |
| 第二轮评审 | `...\independent-review-20261118\第二轮独立评审-职责边界与解耦-20261118.md` | 产品/规模/瓶颈、Magpie/解耦/Router/上下文判断 |
| 修复方案 | `...\independent-review-20261118\修复方案-20261118.md` | **权威实施细节**：WP1–WP5 的文件/表/接口/验收/回滚 |
| 转交草稿 | `...\independent-review-20261118\转交Prompt-20261118.md` | 与本次任务同源的更长任务书，可交叉核对 |
| 基线/契约 | `E:\Workspace\Workspace\Project\SuperAgentDemo\docs\实施基线.md`、`docs\接口契约.md`、`README.md` | 产品边界与接口 |
| 审计证据 | `docs\superagent-audit\test-results.md`、`evidence-matrix.md`、`evidence\` | 已验证/未验证边界 |

若上述评审目录不可读，先向用户索取；不要凭记忆重写方案。

## 4. 任务 T1-RELEASE1

### 角色

实现会话（backend/Python），只做 Release 1 的代码、迁移、测试和交付记录；不做架构再评审。

### 目标

按 `修复方案-20261118.md` 的 **WP1 → WP2 → WP3** 顺序实现，每完成一个 WP 运行测试并停下汇报，不一次性改完。

### 工作边界

**可以修改/新增**

- `superagent/core/execution.py`（新增）
- `superagent/core/context.py`（新增）
- `superagent/core/scheduler.py`
- `superagent/main.py`
- `superagent/core/db.py`
- `superagent/core/delivery.py`
- `superagent/core/message_context.py`
- `superagent/connectors/common.py`
- `superagent/api/operations.py` 或新增 `superagent/api/attempts.py` / `api/context.py`
- `tests/integration/test_execution_ownership.py`、`tests/integration/test_context_ownership.py`、`tests/integration/test_delivery_isolation.py`（新增）
- `docs/handoffs/` 下新增本次交付记录
- 本交接目录内文档（如需补充）

**不要修改**

- `apps/web/`（本任务不做前端重设计；如 API 变更要求最小兼容，先报告）
- 真实渠道/部署/数据库配置
- 其他会话拥有的无关文件
- 评审报告/修复方案（只读引用）

### 依赖与启动条件

- **无阻塞依赖，可立即启动。**
- 先读 `修复方案-20261118.md` 的“目标与非目标 / 设计不变量 / WP1–WP3 / 迁移与兼容 / 验收矩阵 / 风险与停止条件”。
- 先做代码勘察，输出一页计划（状态转移点、`bump()` 调用、启动恢复/审批失效点、拟改文件、迁移方式、3 个最易回归点）；确认后再改。

### 实施步骤（摘要，细节以修复方案为准）

1. **WP1 执行所有权与恢复**
   - `execution_attempts`、`controller_leases`；`claim_task` 条件更新 + 唯一约束原子领取。
   - `Scheduler.poll` 只对成功 claim 的任务启动 `run(ident, attempt_id)`；`run` 校验 owner/status，按 workspace/thread/turn/approval/evidence 更新 attempt。
   - 启动恢复：未开始→可重建；有 turn/审批→unknown；pending 审批→`expired_on_restart`。
   - shutdown 有界 drain（≤20s），未确认才标 unknown。
2. **WP2 上下文决定/manifest**
   - `decisions`、`context_manifests`；Context Assembler；Worker 提示注入“当前有效决定 + ID”。
   - 撤销后不注入；跨项目/越权为零；`start_turn` 前写 manifest。
3. **WP3 投递隔离/期限**
   - 独立 delivery loop；两阶段账本（`claimed`→`dispatching`→终态）。
   - `executing` 容量，waiting_approval 不占槽；`SUPERAGENT_MAX_RUN_SECONDS` 绝对期限；重复事件不续命。

### 交付物

- 代码 + 迁移 + 新增测试 + 必要的兼容处理。
- 每个 WP 的测试命令/结果/耗时/失败原因。
- `docs/handoffs/` 交付记录（实现、测试、限制、回滚）。
- 变更 diff 概览（不 commit）。
- 明确声明：未发送真实渠道消息、未操作真实数据库、未提交/推送。

### 验收条件

- 两个 Scheduler 实例对同一 queued 任务：只有一个 attempt/一个 run。
- 强杀/重启：未开始可重建；turn 中 unknown；旧审批 409；无重复文件/测试。
- 31 事件 + 最早关键决定：Worker 提示含决定 ID；manifest 记录 included/truncated；撤销后不注入；跨项目/越权为零。
- 慢投递不延迟 queued 任务；waiting_approval 不阻塞新任务。
- 重复相同事件 2–3 秒触发超时；静默流也超时。
- 现有 100 项聚焦测试不回归。

## 5. 已验证 / 未验证 / 待办

**已验证（历史/上一轮）**

- HEAD/分支/工作树状态；31/31 源码指纹。
- 12 个隔离探针（双实例、强杀、投递、空闲、账本、上下文、daemon、节点、审批、备份）。
- 100 项聚焦测试（见 `evidence/pytest-subset.txt`）。
- 代码调查：三套上下文预算、无 manifest/取证、Router/语义不被 scheduler 读取、无 Magpie 集成。

**未验证（不要当作已通过）**

- 真实 Codex 当前版本、真实钉钉/Redmine、PostgreSQL/Linux/Docker。
- 全量回归在本环境未跑通（上一轮 7% 停滞）。
- 本任务的新实现本身（尚未开始）。

**待办（本次任务）**

- T1-RELEASE1：WP1–WP3 实现、测试、交付记录。
- 后续（不在本次）：WP4 daemon、WP5 验证/部署/指标、节点 v2、常驻主机、Magpie 实验。

## 6. 风险与停止条件

**风险**

- `Scheduler.run` 状态转移多、与 API 共享；改领取/attempt 易回归。用条件更新 + 现有测试 + 新故障测试，分两次提交。
- 上下文注入增加 token；必须预算/截断，避免挤占执行上下文。
- `expired_on_restart` 新状态影响前端/旧测试；按“非 pending 不可决定”兼容。
- 等待审批不占槽可能提高并发；加 `max_waiting_approval` 上限。
- 两阶段账本改变旧 `unknown` 语义；旧记录不迁移，避免误重发。

**立即停止并报告**

- 需要真实凭据/渠道/生产库才能继续。
- 需要修改 `AGENTS.md` 中其他会话所有权文件。
- 迁移需要删除/重命名字段，或 SQLite/PostgreSQL 不能同时成立。
- 测试出现真实外部写入，或两次以上无法解释的失败。
- 代码现状与修复方案的关键假设不一致（如 `Scheduler.run` 已被他人重构）。

## 7. 启动顺序

1. 读本文件、`修复方案-20261118.md`、`AGENTS.md`、`docs/实施基线.md`、`docs/接口契约.md`。
2. 代码勘察 + 一页计划；确认后进入 WP1。
3. WP1 → 测试/汇报 → WP2 → 测试/汇报 → WP3 → 测试/汇报。
4. 不主动进入 Release 2 / 节点 v2 / 服务器 / Magpie。

---

**交接文档路径**：`E:\Workspace\Workspace\Project\SuperAgentDemo\.handoffs\2026-11-18-superagent-release1\HANDOFF.md`
