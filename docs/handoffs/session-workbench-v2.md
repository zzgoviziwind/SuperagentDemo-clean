# 会话工作台后端交接

- 新增 `superagent.api.sessions.router`，总控需在应用启动初始化数据库前导入并注册。会话列表支持 `project_id`；Worker 列表与详情只对管理员及任务负责人可见，Router 仅管理员可见。现有内部用户没有项目授权模型，因此不推断成员项目权限。
- Worker 对话读取已存用户事件及 Codex assistant summary 产物，发送直接委托已有任务消息入口，继承版本、终态和未知结果保护。历史没有完整中间消息时不可补造；已存工具事件未作为聊天消息显示。
- Router 表结构位于 `superagent.core.sessions`；消息提交调用总控实现的 `await router_agent.enqueue(project_id, content, expected_state_version)`。由该服务处理原子写入、审计、调度和未知结果，API 不模拟回复。Router 状态由设置标示，实际运行失败应通过状态和错误展示。
- 尚无 ChatGPT 应用会话同步或项目关联；Codex thread ID 不能视作 ChatGPT 链接。Router 需独立真实运行验证，当前测试不证明实际 Codex 或外部平台联通。恢复、中断由总控服务提供。
- 验证：`.venv\Scripts\python.exe -m pytest tests/integration/test_sessions.py -q --basetemp .test-tmp/session-run`：1 passed，覆盖权限隔离、列表筛选、历史读取。系统 Python 缺依赖，使用项目虚拟环境。

## 追加交接

- `item/completed` 的每条 `agentMessage` 持久化为可见事件，并与对应 summary 产物关联去重；同轮相同 item ID 的重复通知不会重复写入。无 item ID 的事件无法按协议标识去重。历史 summary 仍回退显示。
- 初始来源包含钉钉/Redmine 已路由事件；缺少原始创建记录时显示当前任务目标，无法还原变更前目标。新增管理员 `POST /sessions/router:{project_id}/reconcile`：`{evidence,expected_state_version}`，委托 Router 服务核验。
- 追加验证：`... pytest tests/integration/test_sessions.py -q --basetemp .test-tmp/session-run-4`，3 passed，覆盖来源消息、事件与产物去重、过期版本及越权。沙箱不允许正常建立 asyncio socketpair，负向测试直接驱动无需挂起的协程；完整异步运行须由总控在可用环境验收。
