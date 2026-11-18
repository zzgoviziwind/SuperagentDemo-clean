# Windows SQLite 存储交接

基线 `7b7587d14399659d7951d3e195af863514fbf118`，加 `docs/rewrite/oracle.json` 固定的源码快照 `abf0a6922e8da03d65cd53458df256a509d824c3fbf276f58943cc800201b091`。以下路径以 `.rewrite-oracle/` 为根。交接依据为 `docs/handoffs/T1-RELEASE1-WP1.md`、`T1-RELEASE1-WP2.md` 和含 WP3 的 `T1-RELEASE1.md`。开发前已读独立方 `tests/rewrite-acceptance/MATRIX.md`（SHA-256 `4fe4646c9e5f41582a0dd3097f6ea8a74fcc40abe9bea41f3dbdec44630e2f68`）；1.1、3.1、4.1 分别覆盖旧库、审批和投递。

| 原表及关键关联 | Python 依据 | 写入与恢复契约 |
| --- | --- | --- |
| projects、tasks、events、artifacts | core/db.py 的 init_db、core/execution.py 的 claim_task | 保留主键、NULL、JSON、布尔值、来源唯一键和产物原文。领取只接受 queued、结果已知、无活跃 attempt。任务版本自增一次，领取与 attempt 插入同事务。 |
| controller_leases、execution_attempts | core/execution.py 的 ControllerLease、begin_attempt、recover_startup | controller 单例，10 秒续约、30 秒到期，接管增加 epoch。写入核对 owner、epoch、到期时间。attempt 唯一键 (task_id,attempt_no) 及每任务一个活跃 attempt 的部分唯一索引。 |
| attempts 的 workspace_path、base_sha、thread_id、turn_id、phase | core/scheduler.py 的 mark_turn_dispatch、_finish_attempt | 已登记工作区和基线持久保存。claimed/workspace/thread 且无 turn 可安全放弃并重排；已进入 turn（即使 turn_id 为 NULL）、approval、evidence 或未知执行结果须冻结。 |
| approvals、events、governance_audit | main.py 的 _decide_worker_approval、reconcile_task | 工具请求绑定 attempt、revision、control_version 和动作哈希。决定先提交 dispatching，再由调用方响应协议。重启使未决定的 pending 过期，已派发的 dispatching 进入 unknown，已确认的 approved/rejected 保留。任务对账须有证据、已退出、当前版本。 |
| decisions、context_manifests、execution_attempts.manifest_id | core/context.py 的 write_manifest、link_turn、require_manifest | 按原作用域保留历史决定与撤销，清单绑定项目、任务、attempt、版本、thread 与 turn。阶段 1 接收调用方组装好的 items，随 turn 派发前提交。上下文选择与权限过滤属于领域层。 |
| reply_drafts、approvals、events、delivery_records | core/delivery.py 的 PersistentActionLedger、recover_claimed、reconcile_delivery | 草稿绑定来源和审批；action_id 为 reply-{approval_id}，状态在 result.write_status，claim_token 每次更新。领取和派发各校验一次。claimed 超过 30 秒可回收，遗留 dispatching 独占启动即冻结，在线扫描满 120 秒冻结。旧 unknown 与人工结论均阻止重发。 |
| router_sessions、router_messages | main.py 的 _service_lifespan | 遗留运行中的 Router 与待执行消息标记未知。 |
| 其他 Python 模块表与索引 | 所有注册到 core/db.Base.metadata 的模型 | 新库按冻结 SQLite DDL 建表；既有表按 Python init_db 的已知列增量迁移。迁移保留额外表、列、业务数据和历史账本。 |

## 阶段 1 调用顺序

原生 ESM 入口 `packages/storage/index.ts` 与 `src/index.ts`，实测 Node 24.22.3。SQLite DDL 嵌入 TS，随服务打包。集成方显式传入数据库文件路径。独立临时目录运行测试。

1. `openStorage(path, options?)` 打开连接并迁移。返回的 `db` 是同一原表连接，供项目、设置、收件与查询模块使用。`close()` 关闭连接。
2. `startController(owner)` 先取得本机互斥及数据库租约，再在同一数据库事务分类恢复；返回 `{lease,recovery}`。调度方按时 `renewLease(lease)`，失效立即停派；停止所有执行及投递后 `releaseLease(lease)`。
3. `claimTask(lease,taskId)` 返回 attempt 或 null。`beginAttempt` 仅成功一次。工作区、thread、turn 派发意图和返回的 turn ID 分步持久化；完成必须绑定当前 attempt 与证据。每次改变状态均以短同步事务提交，实际协议或渠道 I/O 在事务外。
4. 工具审批的请求、派发、回执使用独立方法；调用方同轮检查权限、工作区范围、执行容量、期限及活动客户端。外部回复另走草稿审批，账本在领取和转派发时均调用领域层的同步授权函数，拒绝时整笔回滚。
5. `reconcileTask`、`reconcileDelivery` 仅处理未知结果，提交证据及关联事件；不触发派发。任务对账后显式恢复才可再次领取。

## 导出与复验

| 模块 | 接口 |
| --- | --- |
| 控制器 | `openStorage(path,{stateRoot?,clock?})`、`startController`、`renewLease`、`releaseLease`、`close`。clock 为 Unix 毫秒函数。文件目录需已创建。 |
| Worker | `claimTask → beginAttempt → recordWorkspace → recordThread → prepareTurn → bindTurn → completeAttempt`。遇错使用 `failAttempt`。prepareTurn 的可选 items 控制本轮是否持久化清单。completeAttempt 接收上层已核验的同轮产物。 |
| 工具审批 | `requestWorkerApproval → dispatchWorkerDecision → finishWorkerDecision`。dispatch 接收同步 authorize 函数。调用方处理 StorageConflict 并终止当次派发。 |
| 回复 | `createDraft → decideDraft → claimDelivery → markDispatching → finishDelivery`。claim 返回 null 时读取 `deliveryResult(actionId)`。只有 markDispatching 的成功返回值可交给发送器。实时授权回调在两次写入时分别执行。 |
| 核对 | `sweepDeliveries(lease)` 回收过期账本。`reconcileTask(lease,taskId,{outcome,evidence,expectedStateVersion,actor,isStopped})` 与 `reconcileDelivery(draftId,outcome,evidence)`。 |

从仓库根运行，`$node` 指向 Node 24，`$py` 指向配有冻结依赖的 Python 3.12。测试使用本机临时目录。

```powershell
& $node --test packages/storage/tests/storage.spec.ts
& $node node_modules/typescript/bin/tsc --noEmit --strict --skipLibCheck --module NodeNext --target es2023 --allowImportingTsExtensions --types node packages/storage/index.ts
& $py -IB packages/storage/tests/oracle_schema.py
& $py -IB packages/storage/tests/legacy_roundtrip.py --node $node
& $py -IB -X utf8 packages/storage/tests/rollback_http.py --node $node
```

Windows 复验通过 12 项存储测试、严格类型检查、43 表及 28 个显式索引核对。基线 Python 建立的 35 表非空合成库分别交给 Python 与 TS 迁移，TS 连续打开两次，所有旧列逐行比对、全库 DDL 及 integrity_check 通过。子进程并发领取仅一条记录；在 thread、turn 请求意图、投递收件三个位置强杀后重启，分别核对任务状态与独立收件次数。子进程测试通过注入时钟推进租约到期。

阶段 1 覆盖 attempt 模式与 v2 账本的存储路径。TS 本机互斥采用独立 SQLite 连接，Python 文件锁使用不同文件；跨实现切换应先停止原控制器，保留数据库租约。调度器的定时续约、执行容量与关闭期限、WP2 的决定选择、人工授权及证据质量核验由对应上层负责。动作哈希支持可精确移植的 JSON 整数；浮点动作参数暂不支持。

## 冻结后回切 Python

停止 TS Host、Worker 和写入子进程，确认独立发送端已退出。正常关闭会释放租约，异常退出后沿用原 30 秒租期。回切工具在原库与原 stateRoot 上执行下列顺序，成功关闭后再启动 Python。

```ts
const store = openStorage(path, {stateRoot});
try {
  const {lease, recovery} = store.startController(owner);
  const sweep = store.sweepDeliveries(lease);
  // recovery.approvals_unknown 和 recovery.dispatches_unknown 是本次新冻结的行数。
  // sweep 是随后一次在线扫描，可以均为零。
} finally {
  store.close();
}
```

独占启动同事务冻结两类派发。工具审批的 `approval_decision` 事件内容 `approve/reject` 记录人作出的决定，`approvals.status` 的 `approved/rejected` 记录已确认的响应。若旧版恢复已经写入 `expired_on_restart`，仅在同任务、同审批、同 attempt（旧库允许均为空）仍有派发事件时，将该历史行修复为 `unknown`。当前版本任务进入 `waiting_resource/outcome_unknown=1`，旧版本历史不覆盖新任务。外部回复账本的 `dispatching` 变为 `result.write_status=unknown` 并清空领取令牌。重复准备不会再次推进任务版本或生成重复的审批未知事件。

在冻结 Python 下，读取 `GET /api/v1/tasks/{id}` 获取当前版本，向 `POST /api/v1/tasks/{id}/reconcile` 提交 `outcome=stopped|abandoned`、非空 `evidence` 和 `expected_state_version`。核验后任务分别为 paused/cancelled，审批历史保留 unknown。独立收件证据走 `POST /api/v1/deliveries/{draftId}/reconcile`，提交 `outcome=succeeded|failed` 和 `evidence`。两接口均仅接受一次，原审批决定接口重复提交返回 409。

`rollback_http.py` 在两份临时库分别强制中止合成 TS 写入进程，连续两次执行上面的准备流程，再以完整 lifespan 启动冻结 Python 的真实回环 HTTP。default 打开 attempt、使用默认 ledger，stock 两项均取默认。两组任务与投递核验分别为 200/409，每组独立收件一直为一份。验收不操作业务库。直接启动冻结 Python 跳过准备步骤仍沿用 Python 原有恢复行为。
