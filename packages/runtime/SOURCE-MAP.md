# Codex 工作区与渠道源码映射

基线 `7b7587d14399659d7951d3e195af863514fbf118`。右侧行为以原仓 `E:/Workspace/Workspace/Project/SuperAgentDemo` 的可读源码为依据，包含未提交工作。原仓 Git 元数据读取被拒绝，未确认原仓 HEAD。总控已固化 `.rewrite-oracle`，指纹 `abf0a6922e8da03d65cd53458df256a509d824c3fbf276f58943cc800201b091`。对照 SHA-256 核对了 13 个关键源码文件，包含执行租约、发送账本、Codex、工作区和渠道入口，均一致。

## Codex 与工作区

| 能力 | Python 源码与验证入口 | 重写需保留的行为 |
| --- | --- | --- |
| 工作区准备与取证 | `superagent/runtime/workspace.py` 的 `prepare_workspace`、`prepare_project_workspace`、`collect_changes`、`validate_workspace_changes`，`tests/runtime/test_workspace.py`、`test_multi_workspace.py` | 多仓库按相对路径保留布局与每仓 SHA，解析本地分支并固定基线；独立 clone 禁用硬链接，拒绝脏源目录，已提交只读分析例外需要显式声明；检查变更路径、链接、敏感文件和输出预算。 |
| 项目目录绑定 | `superagent/api/project_workspace.py` 的 `browse`、`discover_repositories`、`select_directory`、`codex_projects` | 管理授权与根目录约束；Windows 原生文件夹选择限回环地址；Codex 项目列表只读，尚无已验证的原生项目绑定写入。 |
| 本机可执行文件与登录 | `superagent/core/local_agents.py` 的 `discover_executable`、`probe_account`、`connect_agent`、`client_options`，`tests/runtime/test_local_agents.py` | 服务侧选择并固定程序和账号目录；复用本机登录须显式连接，和默认隔离状态分开；订阅身份确认后才进入相应预算规则。 |
| 子进程及请求 | `superagent/runtime/codex.py` 的 `CodexAppServer`，`tests/runtime/test_codex.py`、`tests/e2e/fake_codex.py` | Windows 进程组与树清理，stdio NDJSON、initialize/initialized、请求 ID、stderr 独立、帧上限；thread start/resume/read 与 turn start/steer/interrupt；请求发送后断线或超时计为未知。运行环境按名单继承，插件、Apps、Hooks 禁用，复用登录时加固 MCP 等配置。 |
| 工具和可见历史 | `codex.py` 的 `respond_approval`、`respond_tool`、`read_thread`，`superagent/runtime/readonly_tools.py`，`tests/runtime/test_readonly.py`、`test_local_agents.py` | 维持 read-only、tool-less、workspace-write 各模式约束。审批仅已知请求及允许的单次决策。动态工具绑定作用域及活跃 thread/turn，拒绝越界、链接、硬链接、秘密文件；附件路径、格式和大小受限。历史按可见字段投影。 |
| 执行恢复和结果 | `superagent/core/scheduler.py`、原仓新增 `core/execution.py` 的 `claim_task`、`begin_attempt`、`recover_startup`，`runtime/evidence.py`、`runtime/outcome.py`，`tests/runtime/test_evidence.py`、`test_outcome.py` | 控制层持久化租约、执行尝试、任务版本及绑定 ID。协议证据只归属同一轮；命令、cwd、退出状态及独立检查一起支撑修复验证，只读分析需要真实读取证据和无变更。未确认执行结果需人工核对。 |
| 远程执行和会话桥 | `superagent/runtime/{remote,daemon,chatgpt_bridge}.py`、`core/{execution_nodes,conversation_providers}.py`，`tests/runtime/test_daemon.py` | 保留节点授权、方法白名单、路径根、租约及防重放约束。桥接仅走已有权限和版本控制。原生 ChatGPT 项目建聊及历史同步仍受限。 |

## 渠道

| 能力 | Python 源码与验证入口 | 重写需保留的行为 |
| --- | --- | --- |
| 收件与身份核验 | `superagent/connectors/capabilities.py`、`core/connections.py` 的 `ConnectionManager`、`core/ingestion.py` 的 `ingest_event` | 适配器规范化来源与外部事件身份；控制层持久去重、映射可信主体与项目、路由附件和跟进，正文不能授予权限。 |
| 钉钉 | `superagent/connectors/dingtalk.py` 的 `normalize_event`、`DingTalkListener`、`DingTalkClient`，`connectors/{history,media}.py`、`core/message_access.py` | DWS 就绪/降级、重连和受限历史补查；私聊与群聊范围分开、自回环过滤、原消息/会话及私聊收件人绑定。附件受授权、格式和体积校验，Windows 资源进程有边界。 |
| Redmine | `superagent/connectors/redmine.py` 的 `RedmineClient`、`RedminePoller`、`restore_issue_checkpoint`，`core/connections.py` 的 `PersistentStateStore`，`tests/connectors/test_redmine_snapshots.py` | 分页查询和持久游标、逐工单变化和日志差异、指派/提及范围、已关闭状态语义。评论及指派走动作授权；附件拒绝非同源、重定向和不合法资源；出站回声需绑定实际来源。 |
| 飞书审批 | `superagent/connectors/feishu_callback.py`，`core/feishu_cards.py` 的 `CardApprovals`，`core/feishu_decisions.py`，`tests/integration/test_feishu_cards.py`、`test_feishu_decisions.py` | 已有私聊审批提醒/卡片，回调绑定操作人、任务、审批和当前状态，复用 Worker 决策；陈旧卡片须失效。按已有范围接入，当前不据此声明一般飞书收件、发帖或站点在线能力。 |
| 授权发出、恢复、核对 | `superagent/connectors/common.py` 的 `execute_write`，`core/delivery.py` 的 `PersistentActionLedger`、`recover_claimed`、`publish_draft`、`reconcile_delivery`、`recognize_redmine_echo` | 原仓差异已实际观察到 `mark_dispatching`：持久 claim 后再次校验授权和发件人，进入 dispatching 后才 I/O；过期且未 dispatch 的 claim 可恢复，已 dispatch 无确认按未知冻结。计划绑定目标、内容和动作哈希；对账不得隐式重发。 |

## 阶段 1 的证据边界

- Windows 下启动假的 Codex stdio 子进程，以真实 PID、协议帧、绑定的 thread/turn 和进程退出观察为证据。协议中的 `completed`、输出文本和假命令记录只反映离线样例。
- 假渠道用与业务账本独立的临时持久收件记录证明是否发生模拟外部副作用。发送后丢失确认时，调用方只能判未知，独立收件记录供测试或人工核对。
- 阶段 1 校验运行协议及注入位置。真实账号、渠道连接、业务库、Workspace Git/工具沙箱和独立业务验证另行验收。
