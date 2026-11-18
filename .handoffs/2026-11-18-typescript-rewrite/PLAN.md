# SuperAgent TypeScript 重写方案（独立评审稿）

- 日期：2026-11-18
- 状态：待独立评审，未执行
- 仓库：`E:\Workspace\Workspace\Project\SuperAgentDemo`
- 基线：`main` / `7b7587d14399659d7951d3e195af863514fbf118`
- 当前工作树：有另一个会话未提交的 WP1（execution attempt/lease）与 Field Intake 改动；WP2 暂停。评审和重写前必须先冻结、提交/打 tag 或隔离 worktree。

## 0. 一页结论

1. **现在重写，目标 TypeScript。** 项目只有 6 天（2026-11-13 至 2026-11-18），继续在 Python 上加功能才会变成长期负担。
2. **不是从零重新设计，而是行为移植。** Python 版本冻结为 oracle；9.4k 行测试抽成 parity 场景；先移植不变量，再写实现。
3. **前端不动。** 16k 行 React 19 + Vite 是现有资产，保持 `/api/v1` 兼容，用现有 Playwright 当集成测试。
4. **目标架构是模块化单体 + 六边形边界 + 本地进程插件**，不是微服务。
5. **Craft Agents、Craft Anything 都不作为底座。** 前者是 Agent 工作台，后者是逆向/复刻引擎；只借模式，不借内核。
6. **工期 6–10 周达到 parity**，设三个止损点：W1 垂直切片、W4 Codex 真实任务、W6 UI/渠道集成。任一不通过就停，回退到“Python + 进程插件”。

## 1. 背景与事实

### 1.1 产品

- 本地优先的 Agent 研发工作台：钉钉/Redmine/飞书事件进入，形成任务，由本机 Codex 执行，人工审批/验收，结果回写渠道。
- 当前规模：1 个管理员、2 个被接受的真实任务、2 次真实渠道写；没有 24×7/并发证据。
- 部署：Windows 单机；SQLite 默认；PostgreSQL 在 Compose 中可选。
- 上一轮评审结论：保留产品闭环和栈，不迁服务器，不引入 Temporal/Celery/Magpie；先修执行所有权、上下文归属、默认路径。

### 1.2 代码事实

| 项 | 数值/状态 |
|---|---|
| Python 后端 | 12,516 行，64 文件 |
| Python 测试 | 9,382 行，73 文件 |
| 前端 React/TS | 16,065 行，62 文件 |
| git 历史 | 2026-11-13 至 2026-11-18，共 8 个提交 |
| WP1 | 未提交；记录 128 项通过、9 子测试、76.10s |
| WP2 | 暂停；decisions/context manifests 设计可保留 |
| 当前未提交 | `main.py`、`scheduler.py`、`db.py`、`message_context.py`、`api/operations.py`、前端 Field Intake 等 |

### 1.3 为什么改结论

上一轮按“已运行系统”评估，保留 Python 是合理的。现在三个前提变了：

1. 代码只有 6 天，沉没成本低；越晚换，迁移面越大。
2. 维护者明确不信任 Python；这是产品/维护意愿问题，不是可以用技术证据压过去的。
3. TypeScript 同时改善分发（Electron/安装器）、插件生态（npm/多语言进程）、前后端同语言；这些正好对应“开源 + 一键接入”。

Python 不是不能做，而是**继续做会让维护者长期别扭**，这本身就是充分的重写理由。

## 2. 决策与备选

### 2.1 选定

**A. TypeScript 重写，行为移植，前端不动，6–10 周 parity。**

### 2.2 备选与否决理由

| 方案 | 结论 | 理由 |
|---|---|---|
| B. 保留 Python + 进程插件 | 条件备选 | 4–6 周、风险低；若 2 个月内必须上线，选 B。但它不解决维护者不信任 Python 的问题 |
| C. Fork Craft Agents | 否决 | 它是 session/document 型 Agent 工作台，没有 task/attempt/approval/delivery 内核；Bun/React 18/JSON 存储，fork 后要换持久层和领域模型 |
| D. 用 Craft Anything 重建 | 否决 | Rust 逆向/复刻引擎，只能复刻外部可见行为；看不到状态机、账本、附件范围等不变量。最多做 1–2 天 UI 参考 |
| E. Go/Rust 重写 | 否决 | 分发好但生态/UI/Agent SDK 弱，开发速度慢；TS 是唯一同时改善分发、桌面、插件生态的目标 |

## 3. 目标架构

### 3.1 形态

```text
apps/
  server/          Fastify 组合根：路由、认证、SSE、静态资源
  web/             现有 React 19 + Vite，不改
packages/
  domain/          纯 TS：实体、状态机、策略；零 I/O
  application/     用例：ClaimTask / RunTurn / DecideApproval / DeliverReply
  contracts/       Zod schema、OpenAPI、插件 manifest
  adapters/        SQLite/Postgres、Git、Codex、Clock、ID
  plugin-sdk/      Host ↔ Plugin JSON-RPC
plugins/
  source-redmine/
  source-dingtalk/
  source-feishu/
  agent-codex/
  agent-claude/
tests/
  unit/ integration/ conformance/ e2e/
```

### 3.2 四条硬规则

1. 依赖方向只能是 `server → application → domain`；`domain` 不 import Fastify、Drizzle、`fs`、`child_process`。用 `dependency-cruiser` 在 CI 卡住。
2. **Host 独占安全不变量**：身份、去重、项目绑定、审批、投递账本、审计。插件不能直接写 DB。
3. 每个外部写都有幂等键和账本状态：`claimed → dispatching → sent | unknown | failed`；`unknown` 绝不自动重试。
4. 每个执行都有 attempt + lease + fence：`state_version` 管 UI 并发，`control_version` 管控制围栏，`epoch` 管控制器接管。

### 3.3 为什么不是微服务

当前是单机、低并发、强一致的小系统。拆服务只会引入网络分区、分布式事务和运维成本。插件是**本地进程**，不是服务；Host 仍是唯一写入者。

## 4. 技术选型

| 领域 | 选定 | 不选 | 理由 |
|---|---|---|---|
| 运行时 | Node 24 LTS | Bun | 原生模块、Windows 服务、Electron 工具链更稳；Bun 只做脚本 |
| 语言 | TypeScript strict + ESM | JS | 边界类型、可重构 |
| HTTP | Fastify 5 | NestJS / Hono | schema-first、SSE 简单、开销低；Nest 的 DI 不适合领域层 |
| 校验 | Zod 4 + fastify-type-provider-zod | TypeBox 混用 | 一份 schema 生成 TS、OpenAPI、前端 client |
| 数据库 | SQLite WAL + better-sqlite3；Postgres 可选 | libsql | 成熟、同步、Windows 预编译；单机零运维 |
| ORM | Drizzle + 手写 SQL migration | Prisma | 无引擎二进制、SQL 可控、双库支持 |
| 并发 | DB lease + `BEGIN IMMEDIATE` + 每任务 mutex | Redis/BullMQ | 不引入额外基础设施 |
| 调度 | 进程内 loop + DB outbox | Temporal/Celery | 本地优先；多主机时再评估 |
| Agent | JSON-RPC over stdio 的 driver | 直接绑 Codex | 可替换、多 Agent、统一会话目录 |
| 渠道 | 进程插件 | 核心 if/else | 隔离 SDK 依赖和崩溃域 |
| 前端 | 保留 React 19 + Vite | Next/Remix | 16k 行，重写收益为负 |
| 桌面 | Electron 优先，Tauri 后评估 | 先 Tauri | 单语言、生态成熟；Tauri 需要 Rust 维护者 |
| 打包 | electron-builder / NSIS | pkg / Node SEA | 原生模块、自动更新更可靠 |
| 日志 | pino + redact | winston | 结构化、低开销、脱敏方便 |
| 指标 | prom-client | 重 APM | 本地 `/metrics` 够用 |
| 测试 | Vitest + Playwright + 故障注入 | Jest | ESM、速度快；沿用现有 Playwright |
| Lint/格式 | Biome + dependency-cruiser | ESLint + Prettier | 快，且能卡边界 |
| 仓库 | pnpm workspaces | Nx | 规模小，保持简单 |
| 许可 | Apache-2.0 + DCO | MIT | 专利授权，适合企业使用 |

补充约束：

- 不要 NestJS（DI/装饰器与领域层冲突）。
- 不要 Prisma（引擎二进制、迁移不可控、SQLite 并发不透明）。
- 不要 Bun 上生产（原生模块/Windows 服务/Electron 工具链仍有摩擦）。
- 不要 Redis/BullMQ/Temporal（单机低并发；DB lease + outbox 足够）。
- 不要 GraphQL/tRPC（现有 REST + SSE 已在用；OpenAPI 生成类型即可）。
- 桌面壳第一周不做；先 headless 本地 Web，W5–W6 再套 Electron。若“一键”是首页需求，W1 就 spike 打包/自动更新。

## 5. 领域模型与不变量

### 5.1 实体

- `projects`、`repositories`、`source_bindings(source, external_id, project_id)`
- `events`（来源事件，唯一 `(source, external_id)`）
- `tasks`（状态机、`state_version`、`control_version`、`revision`、`outcome_unknown`）
- `execution_attempts`（owner、attempt_no、phase、lease、fence）
- `controller_leases`（owner、epoch、expires_at）
- `approvals`（action_hash、revision、control_version、status）
- `delivery_records`（幂等键、claimed/dispatching/sent/unknown/failed）
- `artifacts`（evidence、changes、summary，可空 attempt_id）
- `decisions`、`context_manifests`（WP2 设计）
- `agent_sessions`（driver、external_id、workspace、title、updated_at、status）
- `plugin_installations`（manifest、version、enabled、status）
- `audit_log`（append-only）

### 5.2 任务状态

保留现有语义：`queued / running / waiting_approval / waiting_resource / waiting_input / review_ready / completed / cancelled / failed / paused`。

关键不变量：

- 同一任务最多一个活跃 attempt；领取用条件更新 + 部分唯一索引。
- turn 请求发出前持久化 `phase=turn`；断开/强杀后结果为 `unknown`，不自动重试。
- 审批绑定 `action_hash + revision + control_version + attempt_id`；重启后旧审批 `expired_on_restart`。
- 投递先写 `claimed` 再发送；发送结果未知只记 `unknown`，不自动重放。
- 附件只接受插件产出的受管目录路径；Host 校验 `realpath`、大小、类型、数量。
- `waiting_approval` 不占执行槽；慢投递不延迟 queued 任务。

### 5.3 数据兼容

- 重写期间保持表名、列名、整数主键、ISO UTC 字符串时间兼容；新表只做加法。
- 先跑现有 `superagent.db` 的副本；确认 TS 能读写、UI 能跑，再切换。
- migration 用 SQL 文件，不用 Drizzle `push`；SQLite/Postgres 的部分索引分别验证。
- 切换前备份；保留 `python-reference-20261118` tag 作为回滚点。

## 6. 插件契约

### 6.1 Manifest

```json
{
  "id": "source-dingtalk",
  "version": "0.1.0",
  "kind": "source",
  "protocol": 1,
  "entry": ["python", "-m", "superagent_dingtalk"],
  "capabilities": ["receive", "reply", "attachments"],
  "configSchema": { "type": "object", "properties": {} },
  "secrets": ["DWS_PROFILE"],
  "platforms": ["win32"]
}
```

### 6.2 Source 插件

`probe / start / stop / ack / send / download`

- 插件只做平台 I/O 和规范化；Host 负责去重、项目绑定、授权、账本、审计。
- Host 持久化事件后才 `ack`；插件未收到 ack 必须重试；重复事件由 Host 唯一约束丢弃。
- `send` 携带幂等键，返回 `sent | unknown`；Host 不因 `unknown` 自动重试。
- 附件由插件下载到 Host 指定临时目录，返回 `{path, sha256, size, content_type}`；Host 校验后移入受管目录。

### 6.3 Agent Driver

`probe / list_sessions / start / resume / turn / steer / approve / cancel / read`

- 统一事件：`turn.started`、`message.delta`、`tool.request`、`approval.request`、`turn.completed`。
- Codex app-server 是第一个 driver；Claude/Gemini 等后续按同一契约接入。
- `list_sessions` 由 driver 解析自己的会话存储，Host 只合并规范化元数据；不在核心解析各家格式。

### 6.4 传输与安全

- NDJSON JSON-RPC over stdio；Host spawn，不经过 shell；env 白名单。
- 心跳、超时、最大帧、stderr 日志、崩溃退避重启。
- 插件不能直接写 DB；所有写通过 Host RPC。
- 进程隔离只解决依赖/崩溃域，不是安全沙箱；第三方插件需签名/信任提示。
- 凭据只允许环境变量引用，不进 argv、日志、manifest。

## 7. API 与前端

- 保持 `/api/v1` 路径和响应形状；新增 OpenAPI 由 Zod 生成，前端生成 typed client。
- 保留 SSE `/api/v1/events/stream`；认证、CSRF、cookie 语义与现有一致。
- 现有 React 页面不改业务行为；Field Intake 等未提交功能先冻结，不纳入首轮 parity。
- 验收：现有 Playwright 用例直接跑在新后端上；截图/交互回归作为 UI 门槛。

## 8. 实施阶段

| 阶段 | 内容 | 出口 |
|---|---|---|
| **W0 冻结** | 总控提交 WP1、打 tag `python-reference-20261118`；WP2/WP3 停在文档；导出 DB schema、测试场景、API 契约 | Python 可随时启动做 oracle |
| **W1 垂直切片** | pnpm monorepo + Fastify + SQLite schema + claim/lease + 假 Agent turn + 审批 + 投递账本 + 重启恢复 | **G1：20 个核心场景通过，否则停** |
| **W2–W3 核心** | domain 状态机、repository、auth/audit、SSE、任务/消息/验收/对账、WP2 决策注入、WP3 投递 worker | 现有前端可连新后端跑通主流程 |
| **W4 Codex** | Codex driver、workspace/git/diff、evidence、真实任务在数据库副本上跑 | **G2：一个真实 repair + 一个 analysis 达到 parity** |
| **W5 渠道** | Redmine、钉钉（dws）、飞书卡片、附件下载与路径校验 | 三个渠道适配器可独立启停 |
| **W6 集成** | 现有 Playwright UI 回归、故障注入、性能基线、Electron 打包 | **G3：UI E2E + 杀进程/断线/重复投递全过** |
| **W7 切换** | 同 schema 迁移、备份、停 Python、启 TS、回滚演练 | 可回滚到 Python tag |
| **W8 缓冲** | 修 parity 差异、文档、开源脚手架 | 发布 |

工期：全职 + AI 辅助 6–8 周；兼职 10–12 周。不要承诺两周。

## 9. Parity 范围

**必须保留**

- 登录/角色/审计
- 项目、仓库、允许路径
- 事件接入/去重/附件
- 任务生命周期/控制/消息/对账/验收
- 执行 attempt/lease/恢复
- Codex 执行/工作区/证据
- 审批（Web + 飞书）
- 投递账本/回复
- 钉钉/Redmine
- SSE 与现有 UI 接口

**延后**

- 远端执行节点/daemon
- 语义路由/Router Agent/Watchdog
- 预算与模型用量
- 事件分组
- Field Intake（若当前不是用户主路径）

**丢弃**

- `SourceAdapter` 死接口
- 重复的状态写入路径
- Windows 专用路径硬编码（改为 driver capability）
- 为兼容保留的 legacy 分支

原则：用户可见的保留，内部实验的延后，死代码丢弃。目标是把 12.5k 行压到 6–8k 行。

## 10. 验证方案

1. **Conformance 场景**：从 73 个 Python 测试文件抽 ~100 个行为场景，写成 YAML/TS；同一 runner 可指向 Python 或 TS 的 HTTP 基址，对比 task 状态、events、approvals、ledger、artifacts（归一化时间/ID）。
2. **Golden trace**：Python 跑一遍，记录 HTTP/DB 结果；TS 回放，diff。
3. **故障注入**：强杀子进程、DB 锁、turn 中断、审批重启、重复 webhook、慢投递、断网。
4. **真实任务**：在数据库副本上跑 1 个 repair + 1 个 analysis，不接受模拟结果当业务验收。
5. **UI E2E**：现有 Playwright 用例 + 截图；不接真实渠道。
6. **切换/回滚**：复制 DB → 启 TS → 验证 → 备份 → 停 Python → 切端口；失败回滚 tag。

## 11. 风险

| 风险 | 处理 |
|---|---|
| 丢失隐性不变量 | Python 作 oracle；parity 场景 + 故障注入；unknown 不自动重试 |
| AI 生成 TS 再次失控 | strict、no `any`、domain 零 I/O、依赖边界 CI、每个用例先写测试 |
| 工期超支 | G1/G2/G3 三个止损点；范围冻结，不做“顺手重构” |
| 渠道 SDK 差异 | 飞书用官方 Node SDK；钉钉继续走 `dws` CLI；Redmine 用 fetch |
| Windows 打包 | W1 就 spike Electron 安装/自动更新/杀进程树 |
| 数据迁移 | 保持表结构兼容；只做加法迁移；先跑 DB 副本；切换前备份 |
| 两套代码漂移 | Python 冻结，只修致命问题；所有新功能只进 TS |
| 插件协议过度设计 | v1 只做 source/agent/approval 三类；不做市场、热重载、沙箱、RBAC |

## 12. 请评审重点回答

1. 6 天项目、12.5k 后端、9.4k 测试的前提下，“现在重写”是否比“保留 Python + 进程插件”更优？请给出量化理由。
2. 6–10 周 parity 的估算是否可信？最可能超期的三个点是什么？
3. Node 24 + Fastify 5 + Zod + Drizzle + better-sqlite3 的选型是否有明显更优替代？为什么？
4. SQLite + `BEGIN IMMEDIATE` + DB lease 是否足以支撑当前规模？什么信号出现时应转 Postgres？
5. 插件契约（source/agent 两类 + stdio JSON-RPC）是否过度设计？对 2 个渠道是否值得？
6. 同 schema 迁移 + Python oracle + 现有前端 E2E 的组合，能否有效防止 parity 回归？还缺什么？
7. Parity 范围中“延后/丢弃”的项是否会影响真实用户？有没有漏掉必须保留的行为？
8. Electron 优先、Tauri 后评估是否合理？桌面壳是否应该更晚做？
9. 安全上最大的三个漏洞是什么？（路径、凭据、插件信任、审批绕过、命令注入）
10. 如果只能给一个“停止重写”的理由，会是什么？

## 附录 A：评审需要核对的代码

- `superagent/core/scheduler.py`：claim、run、approval、stop_run、恢复
- `superagent/core/execution.py`：attempt/lease/fence（WP1）
- `superagent/core/delivery.py`：账本、claim、unknown
- `superagent/core/connections.py`：连接器生命周期、配置、附件分支
- `superagent/core/ingestion.py`：来源校验、项目绑定、策略
- `superagent/connectors/capabilities.py`：静态 SOURCES、未使用的 SourceAdapter
- `superagent/core/local_agents.py`：只接受 codex、静态列表、Windows 发现
- `superagent/api/sessions.py`：Codex-only transcript
- `superagent/runtime/codex.py`：app-server、CODEX_HOME、UnknownOutcome
- `superagent/runtime/workspace.py`：clone/diff/allowed_paths
- `superagent/runtime/evidence.py`：同 turn 证据、验收
- `superagent/main.py`：lifespan、审批、启动恢复、ProjectIn
- `docs/handoffs/T1-RELEASE1-WP1.md`：WP1 已实现行为
- `docs/实施基线.md`、`docs/接口契约.md`、`AGENTS.md`

## 附录 B：参考

- Craft Agents：<https://github.com/craft-ai-agents/craft-agents-oss>（仅参考，不作底座）
- Craft Anything：<https://github.com/storytold/craft-anything>（仅 UI 参考，不作迁移工具）
- 评审材料：`C:\Users\examp\.codex\visualizations\2026\11\17\01a1e8cb-6407-76c1-b689-c8a2d01fa7cb\architecture-review-20261118\independent-review-20261118\`
