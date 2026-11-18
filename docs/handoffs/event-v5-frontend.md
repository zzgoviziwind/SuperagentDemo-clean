# 事件工作台 v5 前端交接

- EventCenter 复用架构总览 TopologyGraph，以最近路由步骤高亮订阅直达/Router 分派路线；缺失步骤不标通过。
- 来源名称/发送者以原始字段及 ID 降级；同任务事件、直接 Worker 会话入口、Router 生命周期和模型判定详情。
- ThreadTranscript 自动读取绑定线程；用户/助手内容展开，工具活动折叠；仅展示有记录的时间和 durationMs。
- SessionWorkbench 增加关联申请：已捕捉事件或未捕捉来源引用，提交不等同已投递。后端 apply 有管理接口，当前前端未提供执行按钮。
- 验证：npm --prefix apps/web run build 通过（2026-11-14）。整体测试由独立验收会话执行。
- 边界：界面为 Codex 可见历史呈现，不是嵌入原生 Codex 客户端；未知时间不推算。暂未进行浏览器视觉验收。
`n补充：已完成管理员应用关联按钮，呈现事件、目标、依据及服务端冲突反馈；提交前读取目标任务版本，支持 Router 中选择目标。新增 CoordinationPanel 负向测试；修订自动读取与直接 Worker 导航的既有断言。构建再次通过。
