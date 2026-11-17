# 工作台视觉更新 · 2026-11-17

本次更新共用前端主题，统一浅灰蓝导航、当前页提示、页面标题、按钮、控件和面板。事件中心与 Worker 使用列表分隔线和浅蓝选中反馈；管理设置去掉表单外面的重复面板。原页面入口、权限和操作保持原有逻辑。

参考：[GitLab Pajamas 导航侧栏](https://design.gitlab.com/patterns/navigation-sidebar/)强调固定的品牌区与稳定分组，用在工作空间和配置入口；[IBM Carbon 左侧面板](https://www.carbondesignsystem.com/building-blocks/core/components/ui-shell-left-panel/specifications)将侧栏视为共用应用框架，用在中性侧栏色阶与一致的当前页反馈；[Atlassian 导航指南](https://support.atlassian.com/navigation/docs/navigation-reference-guide/)强调共用布局和核心行动位置，用在全站页标题和独立的「提出事件」按钮。

两轮在 Microsoft Edge、1440×1000 / 1024×900 / 390×844 下使用独立模拟数据，截图和 trace 保存于 `.test-tmp/design-workflow-visual/workbench-refresh-{1,2}-20261117/`。

第一轮 9 项通过。查看事件详情、Worker 与管理设置截图后，发现旧规则隐藏了事件中心页标题、桌面双栏仍显示只在窄屏需要的返回列表按钮、管理设置有重复外框；第二轮修正这些问题，并提高 Worker 空态文字可读性。

第二轮全部 18 项通过。打开桌面事件详情和管理设置、平板 Worker、窄屏事件详情截图，核对标题可见、面板对齐、文字换行和返回入口；窄屏导航继续在页面上方展开，占用较多首屏空间。项目抽屉键盘焦点约束及 Esc 返回通过；生产构建通过。

正式服务、真实业务数据、外部渠道与真机不在本次验证范围内。
