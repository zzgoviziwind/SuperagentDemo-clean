# 事件工作台 v5 后端

- trace 增加 source_context、architecture_flow（只由实际 attempts 派生）、related_events、router_lifecycle。
- sessions/{ident}/coordination 支持 GET 列表、POST 结构化申请；字段 target_task_id、event_id 或 source_reference、evidence、expected_state_version、request_key。
- sessions/{ident}/coordination/{request_id}/apply 为管理员明确应用，重新检查来源身份、项目绑定、目标版本、结束/未知状态。运行目标须暂停并等执行退出。
- 追加关联使用 canonical EventTarget；保留原任务和历史，不声称迁移或消除旧 Worker。重复应用不重复投递。跨项目拒绝。
- 未捕捉来源只持久化 awaiting_source；本轮无自动远程抓取，不伪装已收到。
- 单事件判定线程 + 项目持久讨论是工程变体；未实现定期开新、批处理、自动压缩。
- 基线 lifecycle/sessions 11 tests 通过；新增协调用例运行中由总控复核。
