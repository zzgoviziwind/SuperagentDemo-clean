# 本机 Agent 接入 v4

## 接口契约

- 挂载 `superagent.api.local_agents.router`，在 `db.init_db()` 前导入模块。
- `GET /api/v1/agents/local` 管理员扫描返回 `{items:[{id,name,installed,executable,version,auth_status,capabilities,selected}],active_id}`。Codex 可选，其他 Agent 检测结果明确无适配器。
- `POST /api/v1/agents/local/connect {agent_id:"codex",use_existing_login:true}` 管理员操作，服务器重新扫描且通过 app-server `account/read` 验证后持久化选择，仅保存程序路径和 Codex home，不保存凭据。
- 总控统一使用 `resolve_executable()` 获取命令，`resolve_home()` 获取本次账户目录，`client_options()` 获取 `CodexAppServer` 构造关键字。未选择本机模式时兼容原环境变量与专用账户模式。Scheduler、Router、Watchdog 均应通过这些 helper 取值，避免独立解析。
- `agent_status()` 是异步状态函数。`resolve_executable()` 与 `resolve_home()`、`client_options()` 为同步 helper。明确连接前不会自动启用本机登录。
- `uses_subscription_account() -> bool` 仅对持久选中、已通过 account/read 验证且 auth_type=chatgpt 的 Codex 账号返回 True。总控 `core/model_usage.py` 负责统一金额预留分流。`client_options() -> dict` 返回 `use_existing_login`、`codex_home` 供 `CodexAppServer(..., **client_options())` 使用。
- runtime 新增显式构造选项 `use_existing_login=False, codex_home=None`，默认安全行为保持原状。读取真实线程使用 `read_thread(thread_id)` 返回 `{thread:...}`，只保留可见用户/助手/工具字段，隐藏 reasoning 一律移除。会话归属校验由 sessions 接口在调用前完成。
- 最终签名 `await read_thread(thread_id, *, include_turns=True) -> {thread: ...}`。现有构造默认专用账号，以免既有调用意外读取本机账号。所有本机执行调用显式加 `**client_options()`，总控负责 Scheduler/Router/Watchdog，回复与语义会话分别接入。
- `start_thread(..., read_only=True, tool_less=True)` 与 `resume_thread(..., read_only=True, tool_less=True)` 已支持。该选项不注入动态读取工具，也拒绝动态工具结果回送；协议未承诺完全禁用所有内建工具。回复调用方必须使用受管空目录、只读 sandbox、拒绝审批并拒收有工具活动的结果，文案不得称完全隔离。

## 订阅额度方案

本机 ChatGPT 登录选择后以 `account/read` 验证 auth_mode，`account/rateLimits/read` 查询订阅限额可用性。该模式无需用户预填金额。建议总控对明确选中的 ChatGPT managed 账户跳过金额预留门槛，继续记录 token 用量与运行状态，金额保持未知且不累加虚构费用。API key 和专用服务账号保持现有预算策略。额度耗尽、鉴权失败沿用等待资源及可见诊断。

## Pane 源码核实

读取固定提交 `1f18556e9bf569091e893a5437dce5d8f77eb8de`。`contracts/runpane/contract.json` 为 Codex 配置了 `@agentclientprotocol/codex-acp`、`CODEX_PATH` 和本机 CLI 版本门槛。`adapterSetup.ts` 校验已装 CLI 并启动 Pane 打包的 ACP 适配器。`sessionImport/sources/codex.ts` 从 `$CODEX_HOME/sessions`、索引及锁文件识别真实本机会话，`agentTranscript/codex.ts` 读取可见用户与助手正文。因此参考的实际产品路径是本机 CLI／适配器与本地会话持久化。SuperAgent 延续现有官方 app-server 调用层，复用其账号目录保存真实线程。

- [Pane Agent 契约](https://github.com/greenfield-inc/Pane/blob/1f18556e9bf569091e893a5437dce5d8f77eb8de/contracts/runpane/contract.json)
- [Pane 适配器设置](https://github.com/greenfield-inc/Pane/blob/1f18556e9bf569091e893a5437dce5d8f77eb8de/main/src/services/agentChat/adapterSetup.ts)
- [Pane Codex 会话导入](https://github.com/greenfield-inc/Pane/blob/1f18556e9bf569091e893a5437dce5d8f77eb8de/main/src/services/sessionImport/sources/codex.ts)
- [Pane Codex 可见历史](https://github.com/greenfield-inc/Pane/blob/1f18556e9bf569091e893a5437dce5d8f77eb8de/main/src/services/agentTranscript/codex.ts)
- [官方 app-server 账户与线程协议](https://learn.chatgpt.com/docs/app-server)

官方 `account/read {refreshToken:false}` 验证本机 managed 登录，令牌由 Codex 管理。`thread/read {threadId,includeTurns:true}` 可读取真实保存的轮次，最新官方文档已提示分页线程应迁移到 `thread/turns/list`。本机 0.167.0-alpha.4.1 实际支持当前读取调用，本轮真实验证通过。

## 实现与安全边界

- 自动搜索本机桌面安装目录、VS Code 扩展目录、npm 原生包与 PATH。Windows 直接选择 native exe，避免把 `.cmd` 传给无 shell 子进程。其他 Agent 尚无适配器时 capabilities 为空且不可连接。
- 显式连接使用 `LocalAgentSelection` 持久化程序、home、验证过的账号类型和操作人。后续环境变量变化不会将已选账号换到其他目录。新表尚未迁移时 helper 兼容旧专用账号行为，其余数据库错误正常上抛。
- 本机模式显式开启，默认构造仍拒绝用户目录并检查服务账户配置。现有登录模式通过子进程 CODEX_HOME 复用账号与真实线程，移除继承的 API Key 环境覆盖；不会复制、返回或保存认证文件内容。
- 状态扫描复查已选中 home 的真实账号类型并更新验证记录。发现退出登录、读取失败或改用 API Key 后，订阅额度 helper 不再返回 True。该 helper 使用最近一次持久验证，模型实际鉴权仍由 Codex 校验。
- 子进程继续禁用 plugins/apps/remote_plugin/hooks，现有账号模式通过命令行覆盖清空 MCP servers、设置只读启动策略，不修改用户 config.toml。新线程仍沿用原只读／workspace-write 及审批策略。
- `read_thread` 返回可见消息和已知工具字段，过滤 reasoning、未知内部项目、原始 rollout 路径及基础指令。sessions 负责先验证平台线程所有权，不能直接向浏览器开放任意 thread ID。
- 连接成功且为已验证 ChatGPT managed 账号，自动开启 Scheduler、语义路由及讨论 Router。API key 等账号仅在 global 预算有足够余额且单轮估算有效时启用。渠道、发送与 Watchdog 开关由原工作流管理。
- `tool_less` 参数是回复调用侧受控流程选项，实际服务器仍可能调用内建工具；本轮没有宣称完全无工具协议。调用方拒绝审批并核验工具事件。

## 验证

2026-11-14 对本机真实程序完成 account/read，输出仅为 installed=true、auth_status=authenticated、auth_type=chatgpt。凭据和邮箱未输出。

总控进一步通过本机真实探测及 connect，在隔离数据库记录 `Codex 0.167.0-alpha.4.1`、authenticated/chatgpt、execution_enabled=true、budget_configuration_required=false。总控证据位于 `.test-tmp/v4-connect/result.json`，该连接验证未调用推理，未修改生产配置。

隔离真实模型测试 `.venv/Scripts/python.exe -m pytest tests/runtime/test_local_agents_live.py -q -s --basetemp .local/pytest-local-agents-live-v4`，进程环境显式启用 `SUPERAGENT_TEST_EXISTING_CODEX=1`。结果 1 passed，11.63s。测试在空目录创建线程、只请求固定短答、完成真实轮次，关闭进程后重新启动、恢复同一线程并读取可见历史。无工具或外部渠道请求，默认测试集跳过该实际账号测试。

定向回归 `.venv/Scripts/python.exe -m pytest tests/runtime/test_local_agents.py tests/runtime/test_environment.py tests/runtime/test_codex.py tests/runtime/test_readonly.py tests/runtime/test_policy.py tests/runtime/test_dynamic_tools.py -q --basetemp .local/pytest-local-agents-v4-final` 返回 21 passed、1 skipped、1 条既有 httpx 弃用警告，11.72s。覆盖连接持久化、管理员权限、拒绝路径注入、API key 预算保护、旧库未迁移兼容、账号目录固定、隐藏推理过滤、原安全环境和工具协议。

跨模块 Scheduler/Router/Watchdog 以及模型预算分流由总控集成，当前文件所有权未跨写。产品界面和真实渠道业务验收不在该隔离验证结果之内。

全运行时回归 `.venv/Scripts/python.exe -m pytest tests/runtime -q --basetemp .local/pytest-local-agents-v4-runtime-all` 返回 40 passed、2 skipped、9 subtests passed，58.56s，一条既有 httpx 弃用警告。新增真实账号测试默认跳过，另一个跳过来自既有策略测试。

真实模型补充配置完整性核验，显式设置同一测试开关运行 `tests/runtime/test_local_agents_live.py`，结果 1 passed，17.95s；验证用户 config.toml 测试前后 SHA-256 一致。只输出通过状态，不输出配置内容、认证材料或邮箱。

最终追加账号状态切换保护后，`tests/runtime/test_local_agents.py` 再验 12 passed，4.96s，一条既有 httpx 弃用警告。`git diff --check -- superagent/runtime/codex.py` 通过。

## 追加交付——钉钉组合监听

总控扩展分配 `core/connections.py` 与专用连接测试，原有并行修改保留。`CombinedDingTalkListener` 聚合独立监听进程，按显式保存的 `dingtalk_response_policy` 生成真实 DWS 范围。

- 私聊 reply 启动 `all-direct`，off 不启动私聊流。
- 群聊 mentions 启动 `at-me`。群聊 requests 在原配置为指定 group 时保留该群，否则启动 `all-group`，事件继续经过原有项目绑定、身份及授权过滤。
- 尚未显式保存新 policy 时保留旧单 kind 范围。未使用 DWS 不存在的 `all` kind。
- 两个范围分别 start/stop。仅全部 running 时整体显示 running，部分故障显示 degraded。双 off 显示 policy_off 且没有子进程。逐项 scopes 包含 kind、chat_id、status、last_error、last_seen、history_recovery、history_chat_ids。
- 群历史仅传给群 listener，恢复范围精确列为 history_chat_ids。私聊始终没有 replay，也不把群游标用于私聊恢复。私聊采用实时流，断线期间消息没有历史回补保证。
- `await manager.reconcile()` 比较运行实例的连接配置及原始 policy。仅重配已经运行的渠道，串行停止旧实例后启动新范围。停止失败保留原对象并返回可见错误，不启动替代进程。总控已将 PATCH/settings 接入 reconcile。策略保存不会自动启动原本未运行的渠道。
- 已与 UI 会话对齐 scopes、degraded、policy_off 及历史范围字段。DingTalkListener 放开 all-group 参数由原文件所有者处理，总控更新旧测试中显式双范围应有两个 start/stop 的断言。

验证使用独立离线 Python 假 DWS 进程，实际同时收到 direct/group 归一化事件，覆盖局部启动失败、运行后故障、关闭失败保留、策略切换释放旧进程、禁用停止、legacy 单监听、双 off 和历史只赋予群流。开发全程未连接真实钉钉。

最终组合与现有连接回归命令 `.venv/Scripts/python.exe -m pytest tests/integration/test_combined_listeners.py tests/integration/test_routing_delivery.py tests/connectors -q --basetemp .local/pytest-combined-listeners-v4-final` 返回 151 passed、58 subtests passed，73.05s，一条既有 httpx 弃用警告。聚合对象还提供 `health()` 返回 status、scopes、last_error、last_seen。
