# 产品界面第二轮交接

## 交付范围

- 默认进入架构总览。九个可点选模块覆盖 Trigger、Fast Filter、Slow Filter、Router、Subscription、Worker、Execution、Session DB、Watchdog。模块说明使用中文业务名称，实际能力由 `/architecture` 提供。首页同时保留待处理、正在推进、最近交付、待确认收件箱。
- 事件中心读取 `/events?routing_status=all`，支持处理状态、来源、内容筛选和游标翻页。来源和搜索作用于当前页，界面明确标注每页最多 50 条。点选消息读取 `/events/{id}/trace`，按处理次数显示服务端保存的每条阶段记录，同阶段多条记录完整保留。
- 历史事件无 attempts 时显示历史记录提示。当前关联任务的 execution、live_stages 与单次路由记录分区显示。执行原文逐项折叠，任务、订阅和交付有可读视图。
- 订阅关系页读取 `/subscriptions`，显示引用 → 项目与任务，支持项目筛选、进入任务。
- 订阅主视图使用来源引用类型、问题编号、任务标题和项目名称，完整 route_key 置于默认折叠的技术详情。架构图明确说明语义过滤为扩展位、当前跳过。
- 会话工作台读取 `/sessions` 和 `/sessions/{id}`，区分 Router 与 Worker，按项目筛选，五秒轮询更新，显示消息时间线、本地线程信息、消息处理状态及人工纠正输入。消息提交携带 state_version，失败保留输入。
- Router rules 模式显示控制备注入口，agent 模式显示项目讨论代理入口。未知执行结果时显示核验表单，提交 `/sessions/{id}/reconcile`。Worker 对账转入原任务操作。
- 代理结构化报告直接显示 summary、status、findings 等可读字段，原始报告默认折叠。消息 queued/running/completed/failed/unknown/note/not_sent 显示对应中文状态。
- 管理设置按执行与项目讨论、回复原渠道、钉钉请求识别分组，模型、并发和预算默认折叠。新增 router_agent_enabled 开关。接入程序与组织配置进入高级折叠，既有凭据引用、权限和操作流程保留。
- 原 MessageTracePanel、InboxPanel、GovernancePanel 和任务操作继续保留。旧消息轨迹放在事件中心的“历史消息辅助核对”折叠区域。

## 修改文件

- `apps/web/src/main.tsx`
- `apps/web/src/style.css`
- `apps/web/src/GovernancePanel.tsx`
- `apps/web/src/ArchitecturePanel.tsx`
- `apps/web/src/EventCenter.tsx`
- `apps/web/src/SessionWorkbench.tsx`
- `apps/web/src/ConversationContent.tsx`
- `apps/web/src/App.test.tsx`
- `apps/web/src/ProductWorkbench.test.tsx`

## 验证

工作目录 `apps/web`，Node 22.20.0，使用项目既有依赖。

- `npm run build` 已通过 TypeScript 检查与 Vite 生产构建。
- `npm test` 已通过 8 个文件、40 项测试。新增六项覆盖架构能力与跳转、全事件来源筛选与多次真实阶段、订阅任务跳转、Worker 版本冲突保留输入、Router 规则备注与未送达状态、可读报告与原文折叠。
- 原有两项测试随预期产品入口变更更新首页文案和事件中心导航断言，既有任务、权限、预算、交付和登录回归保留。

## 总控集成与验收

- 需要注册 lifecycle 和 sessions API 路由，并完成 router_agent_enabled 后端设置及真实项目讨论执行。
- 本会话没有启动真实钉钉或 Redmine，也没有外发、部署或 Git 操作。
- 浏览器工具当前没有可用浏览器，原生后端返回路径缺失，视觉验收尚未完成。已静态核对窄屏网格、长标题与标识换行，并补充小屏订阅筛选区纵向布局。上述自动化为界面与 API 契约模拟验证，真实后端联调由总控完成。
- 架构中的语义过滤与阶段级 Watchdog 能力按后端回执如实显示当前状态。当前任务执行证据可能由其他来源消息推动，界面保留后端提供的范围说明。
- Router 与 Worker 使用本机 app-server 线程。界面仅提供本地线程标识。
