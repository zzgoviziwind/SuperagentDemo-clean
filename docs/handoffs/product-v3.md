# 产品界面 v3 交接

## 已实现

所有修改限定 apps/web/ 与本文件，保留此前未提交成果。

- 管理设置新增 semantic_routing_enabled、watchdog_enabled、watchdog_interval_seconds，提交现有 /settings。Router 项目讨论与事件语义分派分别使用已有独立开关。
- 事件中心适配 target_tasks 多目标，逐任务进入 Worker 会话或任务。模型分派记录取 semantic_routing 实际持久内容。
- RoutingPanel 读取分页 GET /routing/jobs，展示真实模型 thread_id/turn_id、完整输入输出与决定。POST /routing/jobs/{event_id}/correction 提交人工说明、证据及快照任务版本。POST /routing/schedule 检查待确认事件，未知结果通过纠正入口处理。
- 订阅页 GET /subscriptions 兼容旧引用与 subscription_type=explicit，新建 POST /subscriptions，停用 DELETE /subscriptions/{id}。按项目筛选可选任务，保留来源账号 profile 高级项，旧引用与显式订阅同数字 ID 使用不同 React key。
- OperationsPanel 在运行状态页读取 GET /operations/nodes 和 /operations/watchdog，支持 PATCH /operations/projects/{id}/execution-node，POST /operations/watchdog/tasks/{task_id}/run，POST /operations/watchdog/{run_id}/messages，提供核验未知巡检选项与进入任务介入入口。设备最近连接兼容后端 Unix 秒。
- 手动巡检请求超时 260 秒覆盖后端默认 240 秒，其余接口仍为 15 秒。失败保留输入，展示后端错误，允许刷新核对。
- ChatGPT 接入页 GET /conversation-providers 诊断服务能力，展示真实项目同步阻塞原因、MCP 能力与 HTTP 入口（后端提供时），折叠客户端命令和环境变量名配置说明。凭据不进入页面。
- ConversationContent 增加语义决定与守护结论中文字段，原始证据默认折叠。

## 集成说明

需总控完成 main.py 路由及后台服务注册，并保证 settings 白名单支持上述三键。设备白名单、共享工作目录与凭据通过服务端配置，页面仅选择已授权设备。Watchdog 独立会话证据和人工介入在运行状态页，语义 Router 实际会话证据和人工纠正在事件中心，项目 Router/Worker 聊天沿用会话工作台。

GET /events/{id}/trace 当前 target_tasks 由后端返回，前端不推断未返回的目标。保留单 task 的历史执行证据区。

## 验证

第一轮既有测试因 /tasks mock 缺失导致新增订阅表单异常，已增加数组形状保护。随后全量 46 passed。补充创建订阅、手动巡检后最终全量验证为 48 passed（9 文件），35.14 秒。`npm run build` 通过（TypeScript 检查与 Vite 构建，43 模块）。新增 8 项流程测试覆盖人工纠正版本与失败保留、设备状态与任务介入、ChatGPT 诊断重试、多订阅停用、多任务会话跳转、设备绑定与守护纠正、订阅创建和手动巡检。

## 局限

- Windows UI 工具初始化失败，报 failed to launch codex app-server，系统找不到指定的路径（os error 3）。后续按照总控授权改用本机 Chrome 无头模式完成隔离演示截图与实际点击验证，详见下节。
- 组件测试使用离线 HTTP 响应，不能视为真实设备、真实模型或真实 ChatGPT 账号验收。
- ChatGPT 指定项目自动建聊、自动历史同步的公共契约仍未提供。界面使用服务能力显示阻塞；STDIO/HTTP 客户端连接与实际账号安装由后端交接界定。
- 本会话未启动真实渠道、部署或提交代码。


## 总控审查收尾

- 已搜索前端未接入、未实现、未实施、占位、实验等文案。保留两类真实状态，ChatGPT 自动历史同步由后端能力声明决定，以及历史 semantic_filter_not_implemented 阶段明确注明当时未接通。
- 架构说明已准确描述可启用的独立只读语义模型、多对多订阅、权限/版本校验后应用、共享卷 daemon 执行与独立模型 Watchdog。Router 架构入口进入事件中心查看实际分派，项目讨论页说明其独立开关。
- 会话线程说明支持项目绑定执行设备，移除 GET /sessions 尚不提供的 Watchdog 类型筛选，真实巡检会话在运行状态与事件详情展示。
- 兼容 lifecycle 新增 target_observations、target_subscriptions、live_stages.watchdog.runs。每目标展示真实 Worker 线程、轮次、消息事件、执行记录及 WatchdogRun 的线程、结论、纠正、输入证据，可直接进入目标任务介入。旧单 task 追踪保持兼容。
- 构建复验通过，Vite 43 模块。新增逐目标真实巡检字段的组件回归，全量 49 passed（9 文件），31.34 秒。


## 本机浏览器视觉与实际点击验收

2026-11-14，依总控授权将 playwright-core 单独装入 .deps/browser-check，使用本机 C:/Program Files/Google/Chrome/Application/chrome.exe 无头模式。仅允许 http://127.0.0.1:8876，页面全部其他来源请求通过路由阻止，浏览器关闭后台联网、扩展与组件更新。实际使用隔离演示数据，执行与真实渠道保持关闭。

- 实际点击主导航进入首页、事件中心，打开首个来源事件的完整追踪，打开 Worker 会话与消息时间线，进入运行状态刷新设备与守护记录，进入管理设置的 ChatGPT 接入页重新诊断并展开客户端配置。
- 桌面 1440×1000 与窄屏 390×844 各验证五页，10 张全页截图保存在 .test-tmp/v3-ui/{desktop,narrow}-{home,events,sessions,operations,chatgpt}.png，逐页已查看截图。实际点击和布局记录在 .test-tmp/v3-ui/results.json，可复跑 .test-tmp/v3-ui/flows.cjs。
- 初次发现窄屏八个导航被挤成逐字竖排，会话长标题旁动作按钮逐字换行。已修复 apps/web/src/style.css，小屏导航改三列网格，标题动作区允许换行且按钮禁止收缩，重新生成并检查截图。
- 最终十页记录均无页面 JavaScript 错误，无 HTTP 4xx/5xx，documentWidth 分别为 1440/390，与窗口一致，主内容无水平越界。聊天、事件阶段、空设备与守护状态、ChatGPT 项目同步阻塞原因及客户端配置均可见。
- 修复后 npm test 全量 49 passed（9 文件，36.03 秒），npm run build 通过（43 模块）。
- 此视觉验收覆盖隔离演示实际读取与导航点击。真实设备、模型巡检执行和真实 ChatGPT 账号安装依各自模块验收记录。


总控真实模型复验后提高后端默认巡检超时至 240 秒，前端手动巡检相应使用 260 秒。其他接口仍使用 15 秒。后端超时和 UnknownOutcome 的 409 沿用现有具体错误及刷新提示。

超时调整后验证 `npm test -- src/ExtendedWorkbench.test.tsx src/api.test.ts` 为 15 passed，包含手动巡检实际请求定时器 260000ms 断言；`npm run build` 通过。视觉版式沿用已完成的 10 张截图验收。


## 最终可读性修正

事件详情底部复用订阅页的 subscriptionLabel，显示 Redmine 问题编号、钉钉消息引用或来源会话订阅，目标任务可点击。内部 route_key/thread_id 和订阅编号放入默认关闭的详情。semantic_filter_disabled_or_fastpath 映射为“本次未启用语义过滤，或通过规则/订阅直通”，历史 semantic_filter_not_implemented 保留当时处理语境。

最终全量 49 passed（9 文件，15.06 秒），构建通过。重新跑本机 Chrome 的五页桌面/窄屏实际点击流程，更新十张截图与 results.json，均无脚本/HTTP错误和水平溢出。已查看最终桌面与窄屏事件截图，底部订阅长 hash 已收起，可读来源与任务入口可见。
