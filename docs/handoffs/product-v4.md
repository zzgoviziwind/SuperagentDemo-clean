# 产品 v4 交接

## 跨模块合同

- 前端已使用 GET /agents/local 与 POST /agents/local/connect，按 auth_status 显示实际登录状态，连接响应区分执行准备与额度诊断。
- dingtalk_response_policy 已按 message-response-v4.md 字段和枚举实现，默认三步组件独立于旧高级治理面板，旧能力保留在折叠高级入口。
- 已按 session-routing-v4.md 的 transcript 最终字段接入，semantic:{event_id} 跳真实分流记录，项目讨论保持独立类型名称。
- 架构已用可点击 HTML 节点与定向 SVG 连线，合并 Fast/Slow，订阅虚线绕过 Router，明确共享/隔离上下文、执行环境与存储侧边关系。

## 设计参考

已浏览 Apple Disclosure controls、Anthropic Building effective agents 与 OpenAI Agents SDK Tracing 官方页面。借鉴逐层展开、按工作分支呈现、以实际输入输出和执行状态解释行为。

- [Apple Disclosure controls](https://developer.apple.com/design/human-interface-guidelines/disclosure-controls)
- [Anthropic Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)
- [OpenAI Agents SDK Tracing](https://openai.github.io/openai-agents-python/tracing/)

实现、最终契约与验证结果见下文。


## 实现已落地

- ArchitecturePanel 重做为原图职责拓扑。Fast/Slow 合并，两种响应式坐标布局使用定向 SVG 连线，Filter 到 Worker 为订阅虚线，Router 向两个隔离 Worker 分派，Router/Worker 写 Session DB，Watchdog 指向 DB，Worker 连执行环境，Router 连多信道交互。节点可点选查看真实服务能力与业务入口。Router 表达共享任务摘要，Worker 表达隔离上下文。
- 默认 GovernancePanel 只呈现 SetupPanel 三步，选择本机 Agent、接收哪些消息、结果先审后发。原 AdvancedGovernancePanel 全能力保留，首次展开才请求权限/预算/审计。外部 ChatGPT/MCP 归入高级“外部客户端连接”，运行状态页去掉重复设置墙，原始服务配置和设备绑定折叠。
- Agent 连接使用 GET /agents/local 与 POST /agents/local/connect {agent_id,use_existing_login:true}，显示安装、登录与选择状态，程序位置与版本折叠。其他 Agent 有检测结果但无适配器时禁选。连接响应若需要额度配置会展示实际诊断，订阅账户常规流程无需输入路径、key、预算。
- 响应策略提交 PATCH /settings {dingtalk_response_policy:{direct_messages,group_messages,delivery,default_project_id}}。交付为只生成草稿或批准后可发送。保存不覆盖 connector.kind，组合监听由后端按策略协调。SetupPanel 和运行状态页展示 scopes 每个实际范围和 degraded 部分故障，只有显式确认才 POST /connectors/dingtalk/start。
- 会话新增 kind=routing / semantic:{event_id} 的 AI 分流，项目 router 明确标为“项目讨论”。事件 trace 与 routing/jobs 的真实 routing_session_id 可跳“查看这次 Router 判断”。分流补充沿用原线程消息/版本合同，未知结果可提交核验。Worker 显示 task_kind=reply 的回复任务，新增回复任务创建和回复验证证据展示。
- ThreadTranscript 经 GET /sessions/{id}/transcript 读取平台所属真实线程，显示可见输入、输出及工具活动。complete=false 展示服务端原因及平台保存来源，不把历史快照当完整线程。实际 AI 输入、历史快照、人工记录各有标签，worker_session_ids 可继续跳对应 Worker。
- 高级原运行策略的语义开关此前会重设 Watchdog 值，已修复为只改变该项。

## 验证进展

`npm test` 全量 55 passed（10 文件，21.84 秒），`npm run build` 通过（45 模块）。6 项 v4 回归覆盖三步默认层级、已登录Agent连接请求、业务策略保存、高级渐进展开、分流复核携带版本、真实 transcript 与 Worker 跳转、原图主要定向边、事件跳 Router、reply验证、实际范围 degraded 与确认后启用。

第一轮 Chrome 因8876尚未重启遇新接口404，在读取线程等待时停止，未记通过。总控重启后第二轮桌面/窄屏六场景共12张截图及实际点击通过，无JS/HTTP错误，宽度1440/390均无水平溢出。最后范围状态与间距修正后已再跑六场景、12 张截图，仍无 JS/HTTP 错误与水平溢出。截图与结果位于 .test-tmp/v4-ui/，已查看拓扑、三步默认设置、过滤节点分支说明、折叠高级客户端和历史完整性提示。

未自动选择真实账号、启动渠道或新建模型任务，真实模型端到端消息由总控注入。已追加实际分流会话的 Router 输入输出与 Worker 跳转浏览器记录，详见最后一节。

## 设计来源补充

Apple Onboarding 用于三步短小、交互操作与上下文提示，Anthropic Harness 文章用于可理解主操作和完整任务验收，OpenAI Tracing 用于按实际输入输出解释运行记录。设计原则在本项目实现中采用，未宣称官方认证。

- [Apple Onboarding](https://developer.apple.com/design/human-interface-guidelines/onboarding)
- [Anthropic Harness design](https://www.anthropic.com/research/harness-design-long-running-apps)


## 真实会话只读点击验收

总控注入明确标为“本地注入验收消息，非真实钉钉来信”的 event5，实际模型形成 semantic:5 并创建 reply Worker2。前端已在 Chrome 两种尺寸通过事件5的“查看这次 Router 判断”进入真实分流，读取 Codex 可见输入输出，再点“查看分派的 Worker · 2”进入回复任务并读真实答复。Router 与 Worker 均返回 complete=true/source=codex_thread，页面无 JS/HTTP 错误，宽度1440/390均无溢出。4张追加截图为 .test-tmp/v4-ui/{desktop,narrow}-{routing,reply-worker}.png，结果为 live-results.json，脚本 live-flows.cjs 全程只读。

实际截图发现旧 conversation-message > div 会误将结构化报告排成横向多列，已限制仅消息头使用 flex，长会话标题的动作按钮允许另起行，reply 和模型消息状态补中文。随后完整55项测试再次通过（10文件，22.81秒），构建通过（45模块）。最终只读补拍包含展开真实输入记录与结构化输出纵向排版。

组合监听 scopes 字段已最终对齐后端，补 policy_off 中文状态。显式“确认连接并接收”会先保存当前三步策略再启动连接，现有未运行渠道仍由用户明确启用。真实渠道、外部业务回复、账号安装及模型纠正/私聊续聊的业务验收归总控记录，本前端点击仅观察其已授权验收数据。

最终构建后常规六场景再次只读回归，12张基础截图已更新，加4张真实会话截图共16张。最终已查看结构化输出纵排、中文状态、长标题动作按钮和真实原始输入展开内容。


## 最后一次可读性验收修正

- Worker 真实输入的 messages 按用户/助手/系统角色和正文直接展开，文本数组亦可读，空附件材料省略，非空附件显示正文，原始 JSON 默认折叠为“查看原始输入”。输入使用独立显示语境。
- shared_state 的近期结果、订阅关系及候选任务编号/名称/版本/状态/输入/目标均中文化，状态复用任务中文名称，空列表显示“暂无近期结果”“暂无订阅”“暂无候选任务”。
- 平台会话基础提示固定为“当前显示平台记录，展开真实线程记录可核对原始会话”，原始接口 reason 不直接用于该用户提示。
- 针对性验证 ConversationInput、ProductV4、ProductWorkbench 共16项通过，TypeScript/Vite构建通过。4张真实Router/Worker截图已更新，已实际查看桌面/窄屏Worker输入直接显示角色与正文、附件空项省略、Router中文共享摘要与空态。浏览器读取两条真实线程仍complete=true，无JS/HTTP错误，无水平溢出。
