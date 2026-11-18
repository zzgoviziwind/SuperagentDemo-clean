# 投递 HTTP 接入

入口 `index.ts` 导出 `registerDeliveries(app,store,lease,root,env)`。由总控在 `app.ready()` 前注册，使用已有认证、Storage、控制器租约和绝对状态目录。

本模块负责 `GET /api/v1/tasks/:task_id/deliveries` 与同路径 POST，以及 `POST /api/v1/deliveries/:draft_id/{decision,publish,reconcile}`。已核对工作台组的 `workbench/index.ts`、`receipts.ts`、`trace.ts` 与 `API.md`：事件 trace 继续嵌入自己的 deliveries，草稿列表 GET 归本模块。注册函数与工作台共同加载时应只有一个对应 GET。

| 操作 | 输入与结果 |
| --- | --- |
| 读草稿列表 | 复用工作台 `visibleTask`。管理员和归属成员读取非空草稿及当前 `delivery`，非归属成员与 viewer 返回 404。旧任务使用 governance_task_owners 回填归属。 |
| 建草稿 | `{event_id,content}`，从持久来源生成目标、内容和审批哈希，返回草稿与 approval。 |
| 决定 | `{decision,action_hash}`，绑定任务版本、当前内容及来源，返回原审批记录。 |
| 发布 | 先在原账本写 claimed，复查账号、所有权、版本、策略、目标和规则后写 dispatching，再调用渠道。相同动作重放返回原 result；尚在发送时可返回中间状态。 |
| 人工对账 | `{outcome,evidence}`，仅接受 unknown 的最终结论和非空证据，返回同一条账本的最新回执。 |

Fixture 使用运行时的 FakeChannel，在独立状态目录的 `fake-channel-receipts/` 写入回执。专属测试进程同时设置 `SUPERAGENT_DRIVER=fixture` 和 `SUPERAGENT_FIXTURE_EXIT_AFTER_RECEIPT=1` 时，在收件器确认写入后强杀本 Host。验收通过重新打开 SQLite 确认中断时为 dispatching，等待 30 秒租约自然到期，重启后得到 unknown，重放、对账和再次重放后的独立收件数均为 1。

独立验收 PHASE1.md 的第一项曾报告他人可读草稿。修复点在 GET 路由，HTTP 回归已用四种身份和同一非空草稿验证 200/200/404/404，并切换旧任务回填归属复测。独立发行包复验由总控和验收方记录。

## 阶段 2

`registerDeliveries` 同时启动受租约约束的自动投递和附件任务。已绑定当前来源、指引、版本、attempt、thread、turn 的模型回复才具备自动发送资格。旧轮次的自由正文进入人工审核。自动投递复用手动 publish 的两次校验和同一账本。已有同账号答复、过时来信、静默时段、项目或账号变更均阻止相应发送。单次判断循环只消费 Worker 已有产物。按量 Worker 的自动发送还需当前 attempt 的预算凭证，订阅运行使用原审计记录。

Worker 集成入口是 `prepareReplyDecision(db,taskId,attemptId,prompt,manifestItems?)`。在普通 reply 的 thread 已绑定、`store.prepareTurn` 前同步调用，把返回值交给当轮 `client.startTurn`。传入清单时，只有当前来源已包含在清单中才追加判断说明。未绑定的普通回复进入人审。可从 deliveries/index.ts 或 deliveries/replies.ts 导入。

集成回归通过本机 Worker 正常入口执行两个合成按量轮次。零预算时假程序收到的 turn/start 为零。第一笔预算允许自由正文进入人审，核对 10 单位预留并按独立合成用量结算 3。第二笔预算允许带当前来源的结构化 send 经真实 HTTP 到达回环 Redmine；再次 publish 后收到的 PUT 仍为一条。覆盖实际接口与进程，正式模型质量及真实账单需另外验收。

`POST /api/v1/events/:id/retry-attachments` 供管理员重试失败的附件任务。下载重新从配置的渠道读取原工单或原消息的清单，核对实际文件、大小和来源，在当前版本内落入 source_attachment。过期版本不追加产物。

### 附件重试终态

保留冻结库的 `event_attachment_jobs.status=failed` 和 `results=[]`。在同一事务中，事件的 `data.attachments_status` 也置为 `failed`，`attachments_error` 给出中文说明，`attachments_error_code` 区分以下情形。

| 原因码 | 判断条件 | 可以再次处理的条件 |
| --- | --- | --- |
| `disabled` | 来源渠道已配置为禁用、已显式停止，或 Host 使用 fixture/preview 模式 | 管理员启用本机渠道后显式重试 |
| `no_source` | 来源不受支持，或已经启用但缺少可定位的原件。Redmine 需要服务地址、工单号和 1–10 个正整数附件 ID。钉钉需要原 profile、会话 ID 和消息 ID | 补齐可信来源后显式重试 |

同一版本和相同原因重复请求返回 200、`duplicate=true`，复用原结果。即使立刻停止服务也不会留下待下载任务；两种终态均不访问附件地址或写入文件。暂停任务保持暂停。来源可用时返回 `pending`，清理旧原因码，由后台核验成功后记为 `completed`，下载或校验失败记为 `failed`。Host 启动时也会处理旧库已经遗留的不可执行 pending。

HANDOFF-119 的合成种子 SHA-256 为 `5bc2b8435c673c4ebd74ae918e17ae2f72077ba6f1e725304f8ecfe9e067e93e`。在 fixture + preview 的相同副本上，B328 固定包的两项群目录均返回 404，事件 100 重试后立即停机重开为 pending。按当前工作树构建的临时生产入口 main.js SHA-256 为 `e53e57ee6a504f45b15d8051eb74709ca5b2c5889de2fff7fa4d46d3e2f55936`，群单查和群搜索均返回已禁用的 409，事件 100 返回 `failed/disabled`。停机重开原表为 failed、结果为空、任务 10 仍为 paused，两份副本均通过 integrity_check。该指纹对应本次临时构建。

```powershell
& $node24 --import ./packages/runtime/test/register-windows-job.mjs --test apps/server/src/deliveries/tests/stage2.spec.ts
& $node24 node_modules/typescript/bin/tsc -p apps/server/tsconfig.json --noEmit
```
