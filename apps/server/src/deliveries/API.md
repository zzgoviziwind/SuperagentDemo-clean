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
