---
name: SuperAgent Workbench
description: 以事件为中心的中文研发协作工作台；记录现有实现，保留业务功能。
colors:
  canvas: "#f2f4f8"
  surface: "#ffffff"
  ink: "#202635"
  muted: "#536075"
  line: "#d9deea"
  accent: "#5143a4"
  accent-deep: "#3c307e"
  accent-surface: "#efecfa"
  sidebar: "#20243a"
  sidebar-text: "#e9eaf4"
  sidebar-muted: "#bdc4da"
  focus: "#5743b5"
typography:
  body:
    fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif'
    fontSize: "16px"
  title:
    fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif'
    fontSize: "25px"
    lineHeight: 1.3
  label:
    fontSize: "12.8px"
rounded:
  panel: "12px"
  nav: "7px"
  filter: "6px"
  badge: "5px"
spacing:
  compact-gap: "8px"
  workspace-gap: "12px"
  page: "14px"
  narrow-page: "8px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "#ffffff"
  button-primary-hover:
    backgroundColor: "{colors.accent-deep}"
    textColor: "#ffffff"
---

## Overview

模式为 Operate：使用者要核对事件来源、判断下一步、查看 Worker 执行与证据，并管理项目和连接。扫描效率、真实状态、明确反馈优先于装饰。此文件于 2026-11-16 从现有工作区提取；不是新的视觉改版提案。

事实来源：`apps/web/src/main.tsx` 按 `style.css` → `workbench-theme.css` 顺序加载样式；后者及实际计算样式优先。历史《页面整合与设计核查-20261115》记录的青绿方案不是当前最终主题；两者冲突时不得回滚现有界面。

## Colors

前言 Token 来自 `workbench-theme.css :root`。冷浅底、白内容面、深色侧栏和克制紫色主操作为当前身份。已有紫色是项目选择，不因通用“反 AI 风格”建议自动替换。

事件状态使用该文件中 `[data-state]` 的四元组 `bg / ink / color / border`：

| 状态 | bg | ink | color | border |
| --- | --- | --- | --- | --- |
| triage | #fff4d8 | #6d460a | #a2660c | #ebd6a6 |
| active | #e9f0ff | #22488a | #3c5d9d | #c7d6f3 |
| review | #efeafa | #573481 | #664799 | #d7c7ef |
| attention | #fceae7 | #8e3027 | #a34438 | #efcdc5 |
| completed | #e4f3e9 | #205b3f | #357351 | #bedfcc |
| closed | #edf0f5 | #495569 | #616e85 | #d8dfea |

状态同时显示文字与数量，不能只靠颜色。`style.css` 存在青绿等历史局部色值，尚未完成全局 Token 迁移；发现时记录具体组件，避免无范围的大批替换。

## Typography

正文基准 16px，Segoe UI / Microsoft YaHei / sans-serif；基础 h1 / h2 / h3 为 31.25 / 25 / 20px。工作台局部覆盖真实存在：导航 14px、事件标题 15px、摘要 13px、小型状态 `.75rem`、事件详情标题 `clamp(1.2rem, 2vw, 1.65rem)`。不要将全部文字强制套同一字号。

中文长标题与消息必须验证折行、截断后查看完整内容及字号缩放。关键信息不可仅用过小的辅助字呈现。

## Layout

桌面采用固定 232px 侧栏和剩余宽度的工作区域；事件中心按当前分栏样式呈现索引和详情，分栏独立滚动。页面内边距 14px、主要工作区间距 12px；600px 以下页面内边距 8px。布局最终由现有 CSS 层叠决定，不能仅凭早期声明推断。

600px 以下事件列表与详情切换，使用“返回事件列表”恢复；管理设置 960px 以下收为单列，抽屉在 540px 以下取消圆角。测试视口为 1440×1000、1024×900、390×844。窄屏测试只是兼容性抽检，不代表全站移动端验收。

## Elevation & Depth

事件索引、详情面板以边框和背景区分，主题明确取消其阴影；详情内部段落优先顶部分隔线。原生 dialog 的项目设置抽屉保留遮罩与阴影，突出模态层级。不要为所有容器添加同等阴影。

## Shapes

主要面板 12px，导航 7px，筛选项 6px，状态标记 5px；抽屉桌面左侧圆角 18px。形状服务于层级，不统一成大圆角卡片。

## Components

- 事件索引：搜索与来源/项目筛选，按状态计数，选中项需有文本和样式反馈；空结果可恢复。
- Redmine 无备注的事件卡片以工单编号和变更类型作为标题，同一工单合并的变更类型去重；缺少变更明细时显示「工单变更」。没有正文的卡片不留摘要空行。
- 未分派的 Redmine 详情沿用卡片标题。消息头单独显示工单编号，有有效来源地址时可在新标签页打开工单。
- 当前搜索、状态、来源和项目条件在列表顶部显示摘要，筛选折叠后仍可识别，并可统一重置；重置后焦点返回搜索框，保留当前详情和未保存名称。空结果提供“查看全部事件”，读取失败不同时呈现无数据结论。窄屏状态筛选按钮至少 44px 高；长标题和消息中的连续字符允许折行，不遮挡相邻操作。
- 事件详情：顶部状态区直接显示「结束事件」，确认后保留原消息和证据。「已结束」统一收纳已完成和已关闭的事件；会话存储仅在架构图中表示处理环节。
- 事件处理和恢复操作常显；同组按钮并排、空间不足时自然换行。更改项目的表单和接管材料在明确点击后显示。
- 渠道回复显示本轮判断及依据，只有渠道确认才显示为已回复。已关闭事件的恢复选项区分「恢复原任务」和「改为只读分析」。
- 主操作按钮：复用 accent，hover 使用 accent-deep；焦点轮廓 2px、偏移 3px，侧栏使用浅色焦点。
- 设置抽屉：复用 `Modal.tsx` / `SettingsDrawer.tsx` 的原生 dialog、可见标题和关闭按钮；检查初始焦点、Tab 包含、Esc 关闭与返回触发点；不擅自替换既有表单保存逻辑。
- 模型设置在管理设置首页独立折叠、独立保存；按阶段分组，窄屏自然堆叠。模型下拉框提供项目预设和已保存的模型，列表外的模型可手动输入。提示词复用设置抽屉，以可换行的正文展示，长文由抽屉统一滚动。
- 动效：现有按钮使用约 180ms 过渡，保留 reduced-motion 规则；截图默认关闭动画以稳定检查，不能据此声称真实动态效果已验收。
- 相关加载、空、失败、禁用状态需按任务验证。未注入的异常状态、真实模型、渠道发送、审批和任务执行不在截图冒烟覆盖内。

## Do's and Don'ts

- 新功能先阅读当前实现并保留业务契约，记录设计依据，按 `docs/前端设计工作流.md` 执行截图—审查—复验。
- 小范围修改沿用当前视觉语言；新模块或明确重设计才研究多个参考并决策，不复制品牌或伪造参考观察。
- 每次视觉结论应有截图、视口、数据和范围；自动断言或评分都不能代替实际查看截图。
- 不因工具安装顺带改页面，不把历史文档当成覆盖近期改动的授权，不把模拟数据验证写成生产验收。
