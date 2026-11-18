# SuperAgent 审计：证据矩阵

评估对象为 2026-11-17 的工作树快照，HEAD `fc5cf2d0e497319b81fb00397ecca39a1cd516ec` 加当时已存在的工作树改动。SHA-256 清单（本机证据：`evidence/source-sha256.txt`）绑定源码、测试和构建配置。证据路径相对于仓库根目录，行号按快照；批次和场景号见[测试记录](test-results.md)。

- 指标得分 = 权重 × L ÷ 5。L0 缺失；L1 设计/接口；L2 部分实现；L3 基本实现；L4 本项通过自动化及必要边界/故障测试；L5 有代表性长期/负载数据并达到可靠性目标。L4 限于对应子能力及验证环境，替身不证明生产接入。没有源码最高 L1；源码独有最高 L3；容错未跑对应故障最高 L3；无持续数据最高 L4。
- N/V 按 0 计入保守总分，但不是 L0。上界只展开 N/V 行的潜在证据等级，固定其余分数，不代表达到该等级。50/53 项已判定（权重 95.5%）；16/53 项达到本轮执行验证门槛（权重 32.5%）；无 L5。

| 维度 | 权重 | 保守得分 | 含 N/V 可能上界 |
| --- | ---: | ---: | ---: |
| R Router / Worker | 12 | 7.2 | 7.2 |
| E 事件驱动和主动性 | 10 | 6 | 6 |
| A 长期自主运行 | 10 | 4.4 | 6.4 |
| S 存算分离 | 10 | 5.6 | 7.2 |
| M 上下文与记忆 | 10 | 4.5 | 4.5 |
| T 异步工具执行 | 8 | 4 | 4 |
| W Watchdog 与容错 | 10 | 4.4 | 4.4 |
| C 多 Agent 协作 | 8 | 4.4 | 4.4 |
| P 权限、安全与审批 | 8 | 6 | 6 |
| O 可观测性与审计 | 6 | 3 | 3 |
| G 工程化和可扩展性 | 4 | 2.2 | 2.2 |
| D 端到端交付 | 4 | 1.6 | 2 |
| **总计** | **100** | **53.3** | **57.3** |

## R · Router / Worker（12 分）

| 指标 | 权重 | 等级 | 得分 | 状态 | 源码证据（路径:行） | 当次测试或未验证项 | 缺口与建议 |
| --- | ---: | ---: | ---: | --- | --- | --- | --- |
| R1 职责隔离、可控的分流 | 3 | L4 | 2.4 | 执行验证 | superagent/core/semantic_routing.py:132,222,320；superagent/core/router_agent.py:110；superagent/core/scheduler.py:185 | B2：结构化分派、失效授权、错误结果 | 规则/语义/讨论三条路径已存在；统一分派接口和路由延迟预算。 |
| R2 独立 Session 和隔离工作区 | 3 | L3 | 1.8 | 已实现 | superagent/core/scheduler.py:256,312-357；superagent/runtime/workspace.py:35-56 | B1：本机 git clone 被拒；H2 未跑到业务 | 修复工作区按任务克隆，实际并行模型隔离标待复验；验证不同进程、线程、仓库基线。 |
| R3 并行与任务生命周期、结果返回 | 3 | L3 | 1.8 | 已实现 | superagent/core/scheduler.py:132-183,513-529,591-617；superagent/main.py:340-383 | H2、H4：黑盒未达断言；B2 部分状态路径 | 最多四个进程内槽位，审批占槽；把人工等待和执行槽分开，验证独立结果与取消。 |
| R4 队列公平、协调瓶颈及失效域 | 3 | L2 | 1.2 | 部分实现 | superagent/core/scheduler.py:157-183；superagent/core/semantic_routing.py:203-235；superagent/core/delivery.py:465-514 | H2、持续负载未验证 | 单事件语义泵且自动交付阻塞调度 tick；拆泵与持久租约，测队龄和故障隔离。 |

## E · 事件驱动和主动性（10 分）

| 指标 | 权重 | 等级 | 得分 | 状态 | 源码证据（路径:行） | 当次测试或未验证项 | 缺口与建议 |
| --- | ---: | ---: | ---: | --- | --- | --- | --- |
| E1 IM、工单和人工入口 | 2 | L3 | 1.2 | 已实现 | superagent/core/connections.py:450-455,517-618；superagent/connectors/redmine.py:379；superagent/connectors/dingtalk.py:116,203 | B2：规范化后入站；DWS 子进程未确认 | 钉钉流、Redmine 轮询，飞书以审批为主；在授权测试租户核对接收游标和回执。 |
| E2 确定性过滤与语义判断 | 2 | L4 | 1.6 | 执行验证 | superagent/core/ingestion.py:75-111,437-445；superagent/core/semantic_routing.py:64-93,132-152,320-374 | B2：结构化动作校验、撤权、注入无影响 | 可选语义慢路径；增加分渠道样本和限流。 |
| E3 关联、订阅、退订与扇出 | 2 | L4 | 1.6 | 执行验证 | superagent/core/subscriptions.py:9-33,49-122；superagent/api/event_groups.py:386-405 | B1：幂等投递、作用域、禁用/重启用 | 保留目标维度投递证据，扩至有边界的 CI 事件。 |
| E4 去重、并发重复与写回声 | 2 | L4 | 1.6 | 执行验证 | superagent/core/db.py:52-62；superagent/core/ingestion.py:75-109；superagent/core/delivery.py:61-137,340-372 | B2：并发重复、Redmine 回声、未知发送 | 事件积压和高基数风暴治理仍单列 R4；加入口速率预算和队列高水位。 |
| E5 Git/CI 事件及业务定时触发 | 2 | L0 | 0 | 未实现 | superagent/core/connections.py:571-618；superagent/core/event_rules.py:7-18；superagent/main.py:28-56 | H10：无该入口；范围内源码检查 | 轮询和安静时段不是业务触发器；按一个实际 CI 用例加签名接入、定时槽去重。 |

## A · 长期自主运行（10 分）

| 指标 | 权重 | 等级 | 得分 | 状态 | 源码证据（路径:行） | 当次测试或未验证项 | 缺口与建议 |
| --- | ---: | ---: | ---: | --- | --- | --- | --- |
| A1 授权事件到任务与有条件回复 | 2 | L4 | 1.6 | 执行验证 | superagent/core/ingestion.py:75-109,437-445；superagent/core/delivery.py:465-522 | B2：语义创任务、自动回复规则和幂等 | 复验接入授权、终端回执、Quiet/过期通知。 |
| A2 完成后按目标自动推进 | 2 | L2 | 0.8 | 部分实现 | superagent/core/scheduler.py:166-169,513-529；superagent/core/event_groups.py:62-144；superagent/main.py:403-451 | B1：协作回流；B2 规则自动回复 | 有协作和回复推进；没有可检查的多阶段目标计划。只做固定场景的状态机。 |
| A3 约束、预算、终止与人工等待 | 2 | L3 | 1.2 | 已实现 | superagent/core/db.py:29-51；superagent/core/scheduler.py:281-301,562-589；superagent/core/governance.py:637-706 | B1/B3：预算与会话账；H4/9 部分 | 需求和验收可存，按量预留；补独立截止时间、尝试预算和等待提醒。 |
| A4 无人值守故障后的续作 | 2 | L2 | 0.8 | 部分实现 | superagent/main.py:28-44,386-402；superagent/core/semantic_routing.py:188-214 | H1/H9：恢复函数将执行和审批改为未知 | 可取回已知检查点，未知须对账；区分可安全重试、结果未知及待人输入。 |
| A5 持续运行、真实负载与稳定性 | 2 | N/V（至 L5） | 0–2 | 未验证 | superagent/main.py:185；deploy/compose.yaml:25-57 | 无有代表性的长期运行/SLO 数据 | 同一构建冻结负载和故障集，记录 SLO、人工触达率和长尾。 |

## S · 存算分离（10 分）

| 指标 | 权重 | 等级 | 得分 | 状态 | 源码证据（路径:行） | 当次测试或未验证项 | 缺口与建议 |
| --- | ---: | ---: | ---: | --- | --- | --- | --- |
| S1 事件、任务、产物与备份持久化 | 2 | L4 | 1.6 | 执行验证 | superagent/core/db.py:29-109；deploy/snapshot.py:49-108 | B3：SQLite 快照往返、校验和、拒绝覆盖 | 引入版本化迁移及一致性备份演练。 |
| S2 可重载 Session 和控制进程重启 | 2 | L3 | 1.2 | 已实现 | superagent/core/scheduler.py:324-357；superagent/main.py:28-44；superagent/api/sessions.py:173-238 | H1：状态/ID 保留；真实模型重载未验 | 线程 ID 来自运行时；会话实际历史随 Codex home 存储，缺迁移/恢复契约。 |
| S3 独立节点执行与环境绑定 | 2 | L3 | 1.2 | 已实现 | superagent/runtime/daemon.py:32-103,114-151；superagent/runtime/remote.py:12-90；superagent/core/scheduler.py:312-317 | B1 节点数据层；双进程 TCP 未验 | 节点有真执行代码；准备工作区仍在控制端，要求同路径共享，未证明可任意迁移。 |
| S4 租约、节点断线和迟到结果拒绝 | 2 | L4 | 1.6 | 执行验证 | superagent/core/execution_nodes.py:43-57,154-225 | B1：过期、重启、不回放、跨节点迟到响应拒绝 | 仅验证数据层；节点端子进程树与回执持久性仍缺。 |
| S5 PostgreSQL 部署、主备与恢复 | 2 | N/V（至 L4） | 0–1.6 | 未验证 | superagent/core/db.py:84-109；deploy/compose.yaml:14-57；deploy/snapshot.py:19-32,49-108 | 本环境无 Docker/pg_ctl/psql；未启动外部数据库 | 独立 PG 测事务争用、迁移、备份回滚、双启动拒绝；现有架构未声称多主。 |

## M · 上下文与记忆（10 分）

| 指标 | 权重 | 等级 | 得分 | 状态 | 源码证据（路径:行） | 当次测试或未验证项 | 缺口与建议 |
| --- | ---: | ---: | ---: | --- | --- | --- | --- |
| M1 跟进、旧摘要和跨会话线索 | 2.5 | L4 | 2 | 执行验证 | superagent/core/message_context.py:61-99；superagent/core/scheduler.py:239-252；superagent/core/semantic_routing.py:49-63,95-107 | B2：已保存上下文用于接续分流；H8：旧历史仍在库 | 结构化持久存储和同受众摘要；加入原文可追溯指针。 |
| M2 长输入裁剪、压缩与 Token 预算 | 2.5 | L2 | 1 | 部分实现 | superagent/core/message_context.py:23-32,61-64；superagent/core/scheduler.py:25-47；superagent/api/sessions.py:218-235 | H8：31 条输入中只注入 24 条；旧决策被裁掉 | 计数和字符裁剪已有；全轮 Token 控制、版本化摘要及截断指针未见。 |
| M3 按需取证、旧决策召回 | 2.5 | L3 | 1.5 | 已实现 | superagent/core/unassigned_routing.py:117-187；superagent/core/semantic_routing.py:607-678；superagent/runtime/readonly_tools.py:1-48；superagent/api/sessions.py:173-241 | B2：Router 指定取历史/附件；H8：Worker 旧决策默认召回不足 | 已分配 Worker 的动态工具主要读文件；扩展按 ID 取事件、决策、验收记录。 |
| M4 召回质量及压缩保真回归 | 2.5 | L0 | 0 | 未实现 | superagent/core/message_context.py:61-99；tests/integration/test_semantic_routing.py:76-184 | H8：只验证裁剪；无召回正确率基准 | 构造黄金数据集：决策命中、反例、撤权、过期覆盖和 Token 开销。 |

## T · 异步工具执行（8 分）

| 指标 | 权重 | 等级 | 得分 | 状态 | 源码证据（路径:行） | 当次测试或未验证项 | 缺口与建议 |
| --- | ---: | ---: | ---: | --- | --- | --- | --- |
| T1 非阻塞协议和异步结果 | 2 | L3 | 1.2 | 已实现 | superagent/runtime/codex.py:119-190,229-275；superagent/core/scheduler.py:341-379；superagent/runtime/remote.py:67-90 | H7 协议端未到达；B2 接口/事件替身 | 围绕 Codex 壳非阻塞；需要长工具并行、发信接续和公平性实跑。 |
| T2 超时、取消、进程清理 | 2 | L3 | 1.2 | 已实现 | superagent/runtime/codex.py:134-153,358-393；superagent/core/scheduler.py:562-617 | H4 无真实子进程清理证据；H6 验证空闲检测边界 | 存在 RPC/空闲超时和进程树清理路径；测拒中断、孙进程和绝对超时。 |
| T3 独立工具 Job ID/状态/控制 | 2 | L2 | 0.8 | 部分实现 | superagent/core/execution_nodes.py:58-81,142-151；superagent/runtime/evidence.py:57-119 | B1：远端 RPC 租约；本地命令只见协议 item | 工具命令能取证，缺跨轮的持久工具作业句柄、状态查询和取消。 |
| T4 重启后绑定未完成工具 | 2 | L2 | 0.8 | 部分实现 | superagent/core/execution_nodes.py:218-225；superagent/main.py:28-44；superagent/core/scheduler.py:348-363 | H1：只保存线程/轮次并冻结；B1：迟到操作被拒 | 明确 job 级身份和副作用检查点；可证实幂等才自动恢复。 |

## W · Watchdog 与容错（10 分）

| 指标 | 权重 | 等级 | 得分 | 状态 | 源码证据（路径:行） | 当次测试或未验证项 | 缺口与建议 |
| --- | ---: | ---: | ---: | --- | --- | --- | --- |
| W1 进程、协议故障和无输出检测 | 2 | L3 | 1.2 | 已实现 | superagent/core/scheduler.py:435-438,531-539,562-589；superagent/runtime/codex.py:154-190 | H4/H6：网络进程阻断；模拟重复增量能延长出活 | 失联/异常可进入未知；独立健康监督和有效进展信号待补。 |
| W2 空转、重复失败、僵尸任务治理 | 2 | L2 | 0.8 | 部分实现 | superagent/core/scheduler.py:562-585；superagent/core/watchdog.py:122-202 | H6：重复增量越过 1 秒空闲阈值；B2：模拟模型 pause | 模型可给建议，未见可重复的循环计数/停滞、重试熔断。 |
| W3 有限重试、退避与恢复分层 | 2 | L2 | 0.8 | 部分实现 | superagent/core/semantic_routing.py:267-296；superagent/connectors/dingtalk.py:203-234；superagent/main.py:340-383 | B2：模型异常保留、人工修正、循环下次仍活 | 局部连接器退避存在；模型/工具无统一安全重试策略，写入未知继续锁住。 |
| W4 不明副作用防回放和人工对账 | 2 | L4 | 1.6 | 执行验证 | superagent/core/delivery.py:340-396,450-463；superagent/connectors/common.py:75-102；superagent/main.py:386-402 | B2：并发 claim、未知写入、失败停机；H1/H9 启动处理 | 同一 action 留账和人工对账；外部回查、误报率和跨节点证据仍待验证。 |
| W5 控制进程外的控制环及就绪探针 | 2 | L0 | 0 | 未实现 | superagent/api/operations.py:25-38；superagent/core/watchdog.py:104-137；superagent/main.py:28-67,185；deploy/compose.yaml:25-57 | 部署/源码检查；未做实际重启演练 | Compose 有进程重启策略；巡检与 API 同进程，静态健康不发现调度失活。加独立的业务进度监督。 |

## C · 多 Agent 协作（8 分）

| 指标 | 权重 | 等级 | 得分 | 状态 | 源码证据（路径:行） | 当次测试或未验证项 | 缺口与建议 |
| --- | ---: | ---: | ---: | --- | --- | --- | --- |
| C1 任务拆分、数量上限和子 Worker | 2 | L4 | 1.6 | 执行验证 | superagent/api/event_groups.py:347-383；superagent/core/event_groups.py:98-144 | B1：子任务上限、只读请求、幂等且不递归 | 保留角色上限；实体并发没有本次运行证据，见 R3。 |
| C2 交接、结果回流和父任务保护 | 2 | L4 | 1.6 | 执行验证 | superagent/core/event_groups.py:62-96；superagent/api/sessions.py:244-285 | B1：结果回流一次，尊重暂停和版本 | 保留结论为证据；增加结果来源、产物版本和超时状态。 |
| C3 分支及文件冲突、合并时并发 | 2 | L2 | 0.8 | 部分实现 | superagent/runtime/workspace.py:35-56,222-260；superagent/main.py:436-449 | B1：路径/差异限制；实际克隆阻断 | 不同克隆隔离；缺共享目标上的合并冲突/过期基线决策，不自动合并。 |
| C4 依赖协调与独立代码 Review | 2 | L1 | 0.4 | 仅有部分设计 | superagent/core/event_groups.py:62-144；superagent/main.py:403-451 | B1/B2：父子消息和人工验收；无独立 Review 绑定 | 父子回流不等价于依赖图或独立审查，先支持一个有身份的 diff 审查门。 |

## P · 权限、安全与审批（8 分）

| 指标 | 权重 | 等级 | 得分 | 状态 | 源码证据（路径:行） | 当次测试或未验证项 | 缺口与建议 |
| --- | ---: | ---: | ---: | --- | --- | --- | --- |
| P1 实例鉴权、角色、项目/节点授权 | 2 | L4 | 1.6 | 执行验证 | superagent/main.py:72-80；superagent/core/governance.py:218-274；superagent/core/execution_nodes.py:123-140 | B1/B3：重放、角色、失效即拒绝 | 受信任共享空间；若未来转多租户，需独立进程、凭据和资源级读取授权。 |
| P2 审批动作哈希、版本和人工接管 | 2 | L3 | 1.2 | 已实现 | superagent/main.py:386-402,461-525；superagent/core/delivery.py:320-372；apps/web/src/main.tsx:265-286,528-627 | B2/H9：后端失败保护；F1/F3：审批深链接全量失败、定向通过 | 后端动作绑定已验；有效链接的可达性和聚焦仍须稳定通过。 |
| P3 计量预留、并发额度和未知费用 | 2 | L4 | 1.6 | 执行验证 | superagent/core/governance.py:637-706；superagent/core/model_usage.py:6-22 | B1/B3：SQLite 并发和未知费用；订阅不虚造金额 | 缺每任务 Token/绝对时限及真实价格结算，按用途分别展示。 |
| P4 不可信外部内容的工具/决策隔离 | 2 | L4 | 1.6 | 执行验证 | superagent/runtime/codex.py:92-119,195-227,315-346；superagent/core/scheduler.py:364-399；superagent/core/semantic_routing.py:132-152,320-374 | B1/B2：路径拒绝、非法模型输出/失效权限 | L4 范围为确定性边界；不代表沙箱不可绕过或提示注入全面防住。 |

## O · 可观测性与审计（6 分）

| 指标 | 权重 | 等级 | 得分 | 状态 | 源码证据（路径:行） | 当次测试或未验证项 | 缺口与建议 |
| --- | ---: | ---: | ---: | --- | --- | --- | --- |
| O1 收件至任务和外部结果链路 | 1.5 | L4 | 1.2 | 执行验证 | superagent/api/lifecycle.py:59-147；superagent/core/lifecycle.py:8-30；superagent/core/subscriptions.py:23-33 | B3：扇出各自因果证据、未知写入可查 | 用 effect/attempt 的稳定关联传播，区分来源事件与共享任务结果。 |
| O2 版本、审批、阻塞及产物审计 | 1.5 | L4 | 1.2 | 执行验证 | superagent/main.py:386-451,526-555；superagent/core/governance.py:276-285；superagent/api/governance.py:135-143 | B2/B3：失败理由、恢复和历史；B1：只在有证据时验收 | 统一记录路径，补 DB/队列维度及保留策略。 |
| O3 成本、用量与失败原因统计 | 1.5 | L2 | 0.6 | 部分实现 | superagent/core/model_usage.py:11-22；superagent/core/governance.py:671-706；superagent/main.py:543-555 | B1/B3：预留与未知归因，未取得真实费用 | 建立聚合成功率、失败阶段码和真实 Token 计量；未知单独统计。 |
| O4 全链 Trace、指标告警与 SLO | 1.5 | L0 | 0 | 未实现 | superagent/main.py:185,543-555；deploy/compose.yaml:54-57；requirements-lock.txt（OpenTelemetry 仅依赖） | 无可用 Trace 跨进程导出或 SLO 报表 | 先做结构化 attempt 日志和最小队列、停滞、回执指标。 |

## G · 工程化和可扩展性（4 分）

| 指标 | 权重 | 等级 | 得分 | 状态 | 源码证据（路径:行） | 当次测试或未验证项 | 缺口与建议 |
| --- | ---: | ---: | ---: | --- | --- | --- | --- |
| G1 代码接口/连接器可替换 | 1 | L3 | 0.6 | 已实现 | superagent/core/connections.py:415-440,571-618；superagent/connectors/common.py:33-37；superagent/core/semantic_routing.py:154-163 | B2：可注入替身；新来源注册未验证 | 保留轻量 ports；连接器目前集中硬编码，不造通用插件市场。 |
| G2 Runtime 与模型可替换 | 1 | L2 | 0.4 | 部分实现 | superagent/core/local_agents.py:107-133；superagent/core/scheduler.py:303-315；superagent/core/conversation_providers.py:26-41 | B3：配置合法性；Codex/Pi 互换未见 | 本地/远端均 Codex；一个小 Runtime 契约或等效适配证据即可。 |
| G3 配置校验、迁移和版本锁 | 1 | L3 | 0.6 | 已实现 | superagent/core/governance.py:313-495；superagent/core/db.py:88-109；deploy/Dockerfile:1-10 | B3：无效配置/环境脱敏；仅向前补列 | 版本化 schema、配置快照与迁移失败演练。 |
| G4 隔离回归和交付构建 | 1 | L3 | 0.6 | 已实现 | pytest.ini:1-2；tests/e2e/test_blackbox.py:20-116；apps/web/package.json:6-11 | B0–B3、F1–F2：存在测试且构建通过，但完整回归未绿 | 把安全用例编入可重复 CI 阶段、前端恢复全绿。 |

## D · 端到端交付（4 分）

| 指标 | 权重 | 等级 | 得分 | 状态 | 源码证据（路径:行） | 当次测试或未验证项 | 缺口与建议 |
| --- | ---: | ---: | ---: | --- | --- | --- | --- |
| D1 需求、分析、修改、测试流程 | 1 | L3 | 0.6 | 已实现 | superagent/core/scheduler.py:256-270,324-358,485-529；tests/e2e/test_blackbox.py:144-167 | H10：黑盒启动被挡；B1 验规则与证据解析 | 验证真实 Codex 在一次性仓库从缺陷触发到修复测试。 |
| D2 产物、测试与变更核验 | 1 | L3 | 0.6 | 已实现 | superagent/runtime/evidence.py:9-55,57-129；superagent/runtime/outcome.py:4-102；superagent/main.py:436-451 | B1：错线程/测试失败不等于通过；F2 是工作台自身构建 | 版本化构建产物和测试记录应与确切提交 SHA/差异绑定。 |
| D3 Review 与交付范围治理 | 1 | L2 | 0.4 | 部分实现 | superagent/main.py:403-451,534-541；superagent/core/delivery.py:397-449 | B2：旧版本保护与假渠道；缺独立 Review | 人工验收存在；无独立审查证据强门，SQL/配置/发布分类未强制。 |
| D4 部署/CI 跟进与交付确认 | 0.5 | L0 | 0 | 未实现 | superagent/core/connections.py:571-618；superagent/main.py:403-451 | 未见应用业务持续交付编排 | 首版明确不自动部署；可接收并验证 CI/手动发布回执，不引入自动上线。 |
| D5 真实模型及渠道的代表性闭环 | 0.5 | N/V（至 L4） | 0–0.4 | 未验证 | tests/runtime/test_local_agents_live.py:12；tests/e2e/test_blackbox.py:45-51,318-342 | 没有调用真实账号、渠道和业务仓库 | 隔离真实模型和测试收件人，确认工具证据、审批、回执和恢复。 |

前端和替身测试证据计入对应指标；过去的成功日志不抵消本轮失败。原型的特性不计入本项目实际分。
