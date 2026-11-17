# ChatGPT 桥接交接 v3

## 集成接口

- 总控在 `main.py` 导入并挂载 `superagent.api.conversation_providers.router`，必须在静态文件挂载前注册。该导入注册新增账本表，随后执行现有 `init_db()` 即可。
- `GET /api/v1/conversation-providers` 返回本地 Codex 与 ChatGPT 项目同步的真实能力声明。
- `/api/v1/conversation-providers/bridge` 提供受 Bearer 鉴权的 status、sessions、sessions/{ident}、operations/{request_key} 和 POST operations。写操作必须携带 request_key，消息和控制必须携带 expected_state_version。
- `python -m superagent.runtime.chatgpt_bridge` 是独立 MCP STDIO 进程，通过环境变量 SUPERAGENT_BRIDGE_URL（默认 http://127.0.0.1:8765）和 SUPERAGENT_BRIDGE_TOKEN 调用上述服务。无需 OpenAI API Key。
- 仅本轮分配的新文件被修改，main.py 挂载由总控完成。

## 官方边界

2026-11-14 查阅并打开官方资料。Conversations API 未提供 ChatGPT 项目 ID 绑定及应用内聊天历史同步契约，因此项目自动建聊能力返回 blocked。客户端内建聊天工具不用于独立服务。

- [Conversations API](https://developers.openai.com/api/reference/resources/conversations/methods/create)
- [桌面客户端 MCP 与 STDIO 配置](https://learn.chatgpt.com/docs/extend/mcp)
- [ChatGPT Web 自定义 MCP](https://developers.openai.com/api/docs/guides/custom-mcp-server)
- [插件鉴权](https://developers.openai.com/plugins/build/auth)

本交付提供本地桌面 MCP STDIO 及 `POST /api/v1/conversation-providers/mcp` 无状态 Streamable HTTP（JSON 返回）。HTTP 所有握手和工具调用均要求平台 Bearer 令牌，GET/DELETE 返回 405。无需分配 MCP session ID，也不接受客户端指定身份。ChatGPT Web 插件安装支持 streaming HTTP/SSE 和 OAuth，本机 Bearer 端点的公开 HTTPS 与 OAuth 授权服务器部署仍需另行完成，当前不能称 Web 插件已接通。未公开服务或开启隧道。官方桌面文档记载本地 MCP 支持，用户客户端的具体账号和菜单仍需安装验证。

## 安装

1. 总控挂载路由并重启平台，现有 `init_db()` 创建 `conversation_bridge_operations` 表。当前后台无需新增循环。
2. 使用现有平台环境变量配置身份 `SUPERAGENT_USERS_JSON` 或 `SUPERAGENT_API_TOKEN`。桥接的所有端点拒绝匿名，即使本机平台允许无凭据浏览也必须为桥接配置令牌。令牌沿用现有 member/admin 权限，viewer 无写权限，成员仅访问自己任务，Router 仅管理员。
3. 支持本地 MCP 的桌面客户端可配置 STDIO，命令为 `E:\Workspace\superagentDemo\.venv\Scripts\python.exe`，参数为 `-m superagent.runtime.chatgpt_bridge`，工作目录为 `E:\Workspace\superagentDemo`。通过客户端环境变量转发 `SUPERAGENT_BRIDGE_TOKEN`，可选转发 `SUPERAGENT_BRIDGE_URL`。令牌从进程环境或凭据管理读取，不粘贴到聊天、源码或配置示例。
4. 支持 Bearer 的 Streamable HTTP 客户端使用平台源地址加 `/api/v1/conversation-providers/mcp`，通过受保护的环境变量提供 Authorization。HTTP 仅本机明文允许，远程必须 HTTPS。STDIO 进程拒绝 HTTP 重定向，防止令牌跟随跳转。
5. ChatGPT Web 实际插件安装还需可访问 HTTPS 与 OAuth 授权服务。当前未配置、未安装到用户账号，未验证真实 ChatGPT 工具调用。未完成的部署不能算最后只剩点击安装。

## 工具及消息契约

- `superagent_status` 返回能力和当前身份。
- `superagent_sessions {project_id?}` 列出可见 Worker/Router。
- `superagent_read {session_id,after?,limit?}` 返回 session、messages、snapshot、next_after、has_more。分页 cursor 为 snapshot 内偏移；snapshot 变化必须从 0 重读并按消息 ID 去重，避免遗留产物回填导致漏读。只读取平台可见消息，不读取或暴露模型隐藏推理。
- `superagent_operation` 使用 action=create/message/control。create 需 project_id、title、content，默认 kind=analysis，返回 worker:{task_id}。消息和控制需 session_id、expected_state_version，消息可 change_goal，控制支持 start/pause/resume/cancel/retry。创建后正常执行仍需现有本机 Codex、预算和执行配置。
- `superagent_receipt {request_key}` 返回本身份操作账本。写入 request_key 限 128 字母数字及 `_.-`，同身份同键不同内容返回 409，已完成返回原结果和 duplicate=true。当前权限变化后，历史结果回执也重新验证会话访问权限。
- 平台执行和回执分开提交。先持久化 pending 再调用原有业务操作，再写 completed。进程在中间崩溃、调用取消或执行异常时保留 pending/unknown，重复请求 409，防止副作用被自动再次执行。核验需读取会话、任务事件和回执，由管理员明确判断已有执行结果。当前没有自动重放或清除未知回执入口。确定未执行后需要新请求键发起新的明确意图。
- MCP 无状态 HTTP 不发 session ID；已初始化通知返回 202，GET/DELETE 返回 405，JSON-RPC 不支持的方法返回 -32601，畸形 JSON 返回 -32700，工具业务错误通过 isError=true 返回。所有请求含 Bearer，来源检查复用平台 Origin 规则。支持 2024-11-05、2025-03-26、2025-06-18 协议版本。

## 验证与局限

隔离数据库测试命令 `.venv/Scripts/python.exe -m pytest tests/integration/test_conversation_providers.py -q --basetemp .local/pytest-chatgpt-bridge-v3`。Windows 本机回环测试使用 require_escalated 运行。

2026-11-14 首轮完整结果 16 passed，11.61s。覆盖实际现有 create_task/message/control 链路、中文、消息版本冲突、持久去重、并发唯一约束、写后异常保护、身份冲突、跨用户和权限变更隔离、分页 snapshot、STDIO 独立 Python 进程经真实回环 HTTP 到实际后端，以及 Streamable HTTP 鉴权/握手/list/call/error。补充真实回环 HTTP MCP 握手测试后重跑结果见下文。

最初普通权限运行因系统临时目录权限失败；提升权限后遇并行文件短暂语法错误，文件所有者修复后重跑已通过。测试全程使用临时数据库和离线令牌，无真实账号外部写入。现有 TestClient 依赖产生一条 httpx 弃用警告。

平台外部项目 ID、外部 conversation ID 和链接均为空，未伪造 ChatGPT 项目链接。MCP 客户端按用户意图读取、写入平台，实现工具级双向操作；完整 ChatGPT 聊天历史自动同步仍未实现。没有使用客户端内建工具冒充服务端公共 API。

最终验证命令 `.venv/Scripts/python.exe -m pytest tests/integration/test_conversation_providers.py tests/integration/test_sessions.py -q --basetemp .local/pytest-chatgpt-bridge-v3-final` 返回 20 passed，7.58s，一条既有 httpx 弃用警告。新增真实回环 HTTP MCP 握手、工具列表、状态调用、未知工具错误和无令牌 401 均已通过。
