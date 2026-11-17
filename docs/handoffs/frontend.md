# 产品工作台交付记录

> 总控最新结论：本文件按时间保留模块开发记录，后续真实 Codex、渠道、浏览器及最终回归结果见 [总控验收报告](../验收报告.md)。历史未验收说明不覆盖该报告。

## 当前实现

仅修改 `apps/web/` 与本记录。React 19 + TypeScript + Vite 中文工作台包含工作台、任务、项目设置、运行状态。默认请求实际同源 `/api/v1`、`/health`，无运行时假数据入口。页面每 5 秒刷新，隐藏页面暂停轮询。

- 创建任务包含项目、标题、目标、验收标准，以及明确的“分析问题 / 修复代码”选择。发送 kind=analysis|repair，默认 repair。详情兼容旧任务缺少 kind。
- 任务支持状态/项目/来源/文本筛选，展示目标版本、来源、工作目录、事件、证据与差异原文、验证记录与审批动作。
- 补充要求、改变方向、启动、暂停、恢复、取消、重试、批准/拒绝、验收/返工均调用实际 API。消息与控制携带 state_version，审批携带 action_hash，验收携带 revision。
- 网络失败保留表单并显示错误。409 自动读取最新数据并提示用户核对后重提。停止请求成功后显示“等待执行端确认”，后端确认后显示 paused/cancelled；兼容持久化 last_error=正在停止执行 与结构化 stop_requested/pending_control/stop_confirmed。
- 项目表单支持创建/编辑目录、基线分支、验证命令、允许路径、钉钉群和 Redmine 项目映射。
- 接入 auth/me、auth/login、auth/logout。401 展示密码型令牌表单，登录后刷新，登出清理当前任务视图。令牌仅在组件内短暂用于登录请求，不写 localStorage/sessionStorage、前端配置或源码，由后端设置 HttpOnly Cookie。本机无令牌模式直接读取管理员身份。
- 按 admin/member/viewer 隐藏操作。项目配置与连接器控制限管理员；任务控制/审批/验收对管理员或 owner_id 匹配当前 user_id 的 member 显示，服务器仍负责鉴权。
- 连接器 start/stop 已接 API。启用前展开配置状态与项目消息源目标，等待“确认启用”。未配置时禁止确认。所有开发测试使用离线 fixture，未连接真实账号。
- 响应式布局、表单标签、焦点样式、弹窗 Escape、Tab 循环和背景 inert。请求期间禁止重复点击。

## 启动与托管

在 `apps/web` 执行 `npm ci`、`npm run dev`。开发代理将 `/api` 与 `/health` 转到 `127.0.0.1:8765`。开发代理不读取或注入管理员令牌，直接转发浏览器会话 Cookie 与请求自带的 Authorization。代理显式 changeOrigin=false，保留原请求 Host/Origin，后端可继续严格检查同源。浏览器会话登录使用后端 auth 接口。

`npm run build` 输出 `apps/web/dist`，资源路径为 `/assets`。总控在 FastAPI 注册 API 后托管 dist/index.html 和 dist/assets，或使用同源反向代理。页面不依赖前端 URL 路由回退。前端依赖与锁文件均位于 apps/web，未写 Git。

## 验证

Node 22.20.0。类型检查与生产构建通过。Vitest 共 2 个文件、12 项测试，覆盖请求身份/版本、401/409/网络失败、停止确认、创建输入保留和 kind 默认值/提交、消息冲突保留、弹窗键盘、登录与浏览器存储、只读权限和连接器明确确认。测试使用离线 HTTP fixture，不代表真实业务验收。

执行命令为 `npm run typecheck`、`npm run build`、`npm test`。生产 dist 已生成。最新验证时间见后续追加记录。

## 待集成及验收

- 设置持久化编辑、身份映射与回复草稿审批等待总控稳定字段契约。当前设置仅展示脱敏配置，不自动写设置。
- 成员任务权限需要任务响应携带 owner_id。后端未提供该字段时，成员仍能创建/查看，但其任务控制入口会隐藏。需总控统一字段以完成成员权限联调。
- 停止状态仍兼容后端 last_error 精确值，推荐稳定结构化停止请求字段。终态必须由后端真实执行停止回执确认。
- 当前契约没有人工接管导出/导入接口，未提供无后端支撑的接管按钮。
- 尚未完成真实浏览器视觉、真实服务会话 Cookie 和真实 Codex/钉钉/Redmine 全链路验收。构建和离线交互测试不能替代这些验收。

## 2026-11-13 治理与回复闭环增量

本节替代前文“等待设置、身份与回复契约”的限制。新增组件 GovernancePanel、DeliveriesPanel，均调用实际 API。

- 运行状态的管理设置提供持久化运行策略、模型与 codex_effort、并发、预算预留及上限。预算账户展示已用/预留微单位，支持配置账户上限与币种，读取最近 100 条审计。
- 身份映射支持钉钉/Redmine 外部用户到系统用户的绑定、编辑与停用。项目列表逐项明确授权，request 权限独立勾选，默认无项目、无请求权限。仅管理员可见管理入口。
- 连接器配置按治理源码校验字段提供编辑。钉钉包含 executable（字符串或 JSON argv）、profile、self_ids、kind、chat_id；Redmine 包含 base_url、project_ids、user_id、api_key_env、poll_seconds、initial_since、account_map。凭据仅填写环境变量名称，未提供明文 Key 输入。
- 确认启用连接器时，先显式持久化 enabled=true，再调用 start；配置已允许但进程停止时仍可启动。保存配置本身的启用选择是用户明确操作。开发测试均使用离线响应，未操作真实连接器。
- 任务详情新增“原渠道回复”。从已路由的来源事件选择回复目标，保存草稿，展示固定目标/正文/哈希/版本。草稿审批走 /deliveries/{id}/decision，Codex 审批走 /approvals/{id}/decision。按 action.source+kind 判别渠道审批，Codex method 保持原路径。
- 已批准草稿仍需“发送已批准回复”后再次核对预览并明确确认发送。存在 delivery.write_status=unknown 时隐藏发送入口，显示外部核验结果与非空证据的 reconcile 表单。审批与发送分别记录，过期/冲突显示服务错误并读取最新任务与草稿。
- Task.outcome_unknown 进入工作台“需要你处理”。详情提供 stopped/abandoned 与非空证据，携带 expected_state_version 调用任务 reconcile。常规启动/恢复/重试在未知状态禁用，对账后由真实 API 状态决定是否显示恢复。
- 项目改动验收范围为必选项，可明确选择不允许任何修改（[]），或填写仓库相对路径。文案明确 '.' 为整个仓库，这只用于结果验收和审批范围校验，不提供 OS 级子路径隔离。

增量测试覆盖身份显式项目/请求授权、连接器环境变量引用且不自动 start、草稿审批正确 endpoint、发送明确确认、未知发送证据对账、任务未知结果版本对账、项目空范围明确选择。仍需真实浏览器与实际 API 会话/受控外部服务联调，离线交互测试不代表真实渠道验收。

校验补充

- 后端现已在任务响应提供 owner_id，前端成员任务控制可据此判别。
- 治理模型字段最终采用 codex_model / codex_effort。
- 409 保留后端具体原因，并提示刷新核对状态与配置，避免把连接器配置错误全部误标为任务版本错误。
- 最后一轮类型检查、构建与 19 项交互/请求测试结果待下条记录。

最终验证（2026-11-13 15:57）

- npm run typecheck 通过。
- npm run build 通过，生产产物已更新；连接器确认预览显示当前脱敏配置与项目目标。
- npm test 通过，3 个测试文件、19 项测试。
- 仅修改 apps/web 与本交付记录，未连接真实钉钉/Redmine，未进行 Git 写入。
- 真实浏览器视觉和端到端真实服务联调仍由总控验收。

## 最后一轮功能补齐

- 管理员工作台新增待确认消息收件箱，使用真实参数 GET /events?routing_status=pending_confirmation&after=0&limit=50，提供 after 游标上一页/下一页与刷新。展示来源、正文、待确认原因和外部身份/项目引用，管理员可 POST /events/{id}/retry-routing。重试仍待确认时保留具体原因，不误报已路由。
- 预算与审计新增未知费用预留列表 GET /budget-reservations?status=unknown。管理员填写实际费用微单位与非空证据后 POST /budget-reservations/{id}/reconcile，允许实际费用为 0，失败保留输入。
- 原渠道回复新增“使用本次分析结果”，只选当前 revision 的 summary 产物，解析 JSON summary 字符串（兼容 fenced JSON）填入可编辑草稿。此按钮不会保存、审批或发送；仍由用户选择原渠道事件并分别确认后续步骤。
- api.ts 的 409 已保留后端 detail 并附刷新提示，新增回归确保未知预算错误原因可见。
- 按总控要求，本轮使用 JS DOM 交互测试和构建验收。CUA 浏览器不可用，未进行真实浏览器视觉验收，未连接真实外部渠道。
- 本轮结束后停止新增功能，交回根回归。验证结果见下方。

最终前端回归结果（2026-11-13 16:02）

- npm run typecheck 通过。
- npm run build 通过，dist 已更新。
- npm test 通过，4 个测试文件、23 项测试。
- 本轮已停止新增功能，进入根回归。真实浏览器视觉与实际渠道联调未验收。


## 开发代理身份修正

已移除 Vite loadEnv 和管理员 Bearer 注入。即使服务环境存在 SUPERAGENT_API_TOKEN，也不会覆盖浏览器 Cookie 身份或请求 Authorization。Vite 固定监听 127.0.0.1，changeOrigin=false 将浏览器原始 Host 与 Origin 一并送给后端，保持 check_origin 启用。只有确需跨源的本地接入才在后端显式配置 SUPERAGENT_ALLOWED_ORIGINS，无需关闭来源检查。新增配置回归测试确保代理没有 headers/auth/configure 注入。

代理修正回归结果（2026-11-13 16:05）

npm run typecheck、npm test（5 文件 / 24 项）、npm run build 全部通过。新增代理配置测试为离线配置回归，实际浏览器 Cookie/Origin 联调仍需根回归验证。本轮未新增其他功能。

## 产物可读性与完整导出

- 新增 ArtifactView，summary 提取 JSON/fenced JSON 的 summary 文本并显示模型报告状态；changes 展示基线、stat、diff、Git 状态和新增文件名/字节数/SHA256，避免将 content_base64 整块铺在详情页。
- verification 展示测试命令、实际执行、退出码、来源、采集验证状态、事件完整性、模型阻塞、测试输出和失败记录。执行证据按命令展开，采集器证据完整保留可查看；无执行、失败、事件不完整或采集未验证均明确显示未完整验证。
- 每项产物标注目标 revision 与当前/历史版本，提供 GET /api/v1/artifacts/{id}/download 的完整 JSON 下载。任务目标区提供 GET /api/v1/tasks/{id}/export 的完整快照 JSON。使用同源浏览器链接，Cookie 由浏览器正常携带，没有额外身份注入。
- 移除旧的整块原始产物读取区域，完整内容通过下载保留。
- 新增 3 项 JS DOM 回归覆盖摘要可读文本、当前/历史版本、base64 不铺屏且新增文件信息可见、验证失败/未验证状态和下载地址。
- npm run typecheck 与 npm test 已通过，6 个文件、27 项测试。生产构建结果待下条记录。CUA 浏览器不可用，真实下载与视觉验收仍需根回归。

产物展示最终验证（2026-11-13 16:11）

npm run typecheck、npm test（6 文件 / 27 项）、npm run build 全部通过，dist 已更新。仅完成代码、JS DOM 与构建验收，真实浏览器下载/视觉与外部业务联调仍未验收。停止新增功能，交回根回归。

## 本机真实浏览器只读视觉检查

已使用本机既有 Edge 无头模式与 Node 原生 WebSocket 调试接口完成 http://127.0.0.1:8765/ 工作台首页检查，无新增依赖或全局安装，无可见窗口。浏览器使用 data/frontend-visual 下独立测试 Profile，不读取用户日常浏览器资料。未操作真实设置、任务、路由重试、审批、发布或渠道启停。

- /health 与 / HTTP 只读检查返回 200。
- 使用 Emulation.setDeviceMetricsOverride 精确设置宽屏 1440×1000、窄屏 390×844。初版命令行 window-size 截图存在浏览器最小布局宽度导致裁切，未将其作为验收证据。
- 宽屏与窄屏均成功加载工作台标题，无页面 role=alert 错误提示，无超出视口右缘的可见元素。文档宽度分别为 1425、375（视口扣除垂直滚动条），没有横向溢出。
- 实测窄屏页头动作被压成竖排文字，仅修复 apps/web/src/style.css 的窄屏 header flex-wrap 与按钮 white-space。禁用测试浏览器缓存后复查，实际 CSS 为 index-C9s4xOe5.css，窄屏 headerWrap=wrap、buttonWhiteSpace=nowrap，截图中按钮文字正常。
- 修正后 npm run typecheck、npm test（6 文件 / 27 项）、npm run build 全部通过。
- 最终本地证据为 data/frontend-visual/wide-cdp.png、narrow-cdp.png、layout-check.json。read-only-check.mjs 为复查脚本。截图与初版 DOM 文件包含真实收件箱内容，仅保留在被忽略的本机 data 目录，不提交、不在交付正文附图。
- 检查范围限真实首页加载与两种视口的视觉布局。任务详情、配置保存、下载与渠道发送没有在真实数据上执行，仍以 JS DOM 测试和后续受控联调验收区分。

检查结束，测试浏览器已关闭，恢复功能冻结。

## 收件箱最终可读性调整

仅修改收件箱展示，不改变路由、授权与重试 API。

- 已按 ingestion.py 实际已知 routing_reason 显示中文原因，重试后仍待确认的反馈也使用中文。未知原因显示“需要人工核对消息归属与授权”，原始原因保留在详情供核对。
- 来源显示“钉钉 / Redmine”，时间使用浏览器本地 zh-CN 可读格式，time 元素与来源详情保留原始 ISO 时间。
- 外部用户、会话、外部项目和问题 ID 默认收起于“查看来源信息”，展开显示精确值，同时保留来源标识和原始待确认原因。
- 调整现有收件箱回归，覆盖中文来源/原因、本地时间、来源信息默认收起和展开后的精确标识。没有新增视觉依赖。
- 全量 npm test 已通过 6 文件 / 27 项，类型检查通过；最终构建与针对实际 reason 的定向测试结果见下一条。

收件箱文案最终验证（2026-11-13 17:04）

npm run typecheck、npm test（6 文件 / 27 项）、npm run build 均通过。将定向用例切换到真实 actor_unmapped_or_disabled 后，RecoveryPanels 的 3 项测试再次通过。dist 已更新，恢复功能冻结。

## 分析与修复验证记录分型展示

本次只调整 ArtifactView/VerificationView 的展示，未修改后端判定。

- analysis 根据 assessment.task_kind 识别，使用 assessment.verification.status、suggested_status、blocking_tool_failures、事件流完整性及 has_changes=false 展示，只读访问拒绝和未解决错误同时可见。分析不要求测试命令或退出码。
- 已读取当前 scheduler 实际落盘字段 analysis_read_evidence，显示 successful_calls、evidence_calls、file_count、tools、unreadable_files、denied_access、unresolved_errors、truncated_results；同时兼容 analysis_evidence 字段名。limitations 优先读取证据记录，其次读取 assessment.outcome.limitations，缺失时明确说明未提供。
- repair 使用 repair_verified 和后端评估状态/阻塞失败结果，原始失败数量不再直接将已恢复的修复误标失败。assessment.tool_failures 中 recovered=true 的记录显示“历史失败 · 已恢复”，未恢复和恢复状态未知分别展示，命令与输出证据继续保留。无新字段的历史修复记录保留旧式证据展示。
- 新增恰好两个组件回归，分别覆盖只读分析无需测试仍能显示证据通过且改动存在时保持待核验，以及修复有历史恢复失败时仍按后端证据显示通过且存在阻塞失败时保持未通过。
- npm run typecheck、npm test（6 文件 / 29 项）通过，最终生产构建结果见下一条。真实分析任务仍由根回归验收。

分型展示最终回归

npm run typecheck、npm test（6 文件 / 29 项）、npm run build 全部通过，dist 已更新。本次仅修正两个既有任务类型的验证记录展示，恢复功能冻结，真实任务由根回归继续验收。
