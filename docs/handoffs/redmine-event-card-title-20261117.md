# Redmine 无备注事件标题验证（2026-11-17）

- 范围：事件中心列表。已命名事件和有正文的标题继续使用原内容；Redmine 无备注消息以工单编号和实际变更类型补标题，不渲染空摘要。
- 数据：独立预览后端；浏览器复用列表响应，将一张模拟 Redmine 卡片替换为同工单的两条无备注变更（分别是空字符串和纯空格）。未连接真实 Redmine。
- 第一轮：`npm.cmd --prefix apps/web run test:visual -- --project=desktop --grep 'Redmine changes without notes'`。Edge 1440×1000，打开 `redmine-title-baseline-20261117` 的 `13-redmine-no-notes.png`：状态和时间可见，标题留白，对应断言失败。
- 第二轮：`npm.cmd --prefix apps/web run test:visual -- event-center-ux.pw.ts`。Edge 1440×1000、1024×900、390×844，9 项通过。打开 `redmine-title-fixed-20261117` 中三张同名截图，工单编号和两种变更类型均可读，平板标题正常折行，状态和时间未被遮挡。筛选恢复、焦点返回和长文本溢出回归通过。
- 证据目录：`.test-tmp/design-workflow-visual/`。验收时 `GroupedEvents.tsx` 的 SHA-256 为 `1f71ef7d380c8362f922ee071f3c46827e2760a9e5b75e0d497d03ee07119ffc`。
- 事件组组件测试 9 项通过，前端构建通过（输出至隔离目录）。未部署，未验证真实渠道数据。

## 追加：详情标题与工单链接

- 第一轮打开 `redmine-link-baseline-20261117` 的 `14-redmine-message-links.png`：左侧已有补全标题，右侧仍是「事件研判」，消息头无工单链接。
- 修复后，两处标题一致。Redmine 消息用来源地址和工单编号生成链接，支持部署在子路径的 Redmine；缺少有效地址时保留工单编号文字。发送人编号独立展示。
- 核查期间 `apps/web/dist/index.html` 已切到 `index-Ctg9o7F4.js`。复制当前静态文件到 `.test-tmp/redmine-live-front-check/snapshot`，在隔离后端复用 `event-center-ux.pw.ts`：Edge 1440×1000、1024×900、390×844 共 9 项通过，两条消息的链接地址正确，实点打开了新标签页的模拟工单。打开三种视口的 `14-redmine-message-links.png`，标题和链接均可读，状态与时间正常折行。证据在 `.test-tmp/design-workflow-visual/redmine-link-served-snapshot-20261117/`。
- 事件中心及工作台组件测试 29 项通过；单独构建到隔离目录通过。本会话未发布、未重启服务，未连接真实 Redmine；验收仅覆盖现有静态文件的副本和模拟数据。
