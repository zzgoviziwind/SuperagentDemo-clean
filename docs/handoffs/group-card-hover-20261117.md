# 指定群卡片悬停样式复查（2026-11-17）

管理设置中的指定群名称按钮被旧的全局悬停样式覆盖，在 Darcula 下出现浅底浅字。悬停背景现使用已有主题强调底色，保留原有编辑和开关行为。

样式 SHA256：EE5353AB287A5EF77DC8048FB348263A838C06B1D79C3714565FC966977061EC

第一轮：Edge 桌面 1440×1000，实际前端与隔离预览后端，通过只读接口提供一张示例群卡片。打开截图检查名称、原名与状态可读性，键盘 Enter 打开编辑、Esc 返回按钮焦点通过。证据：.test-tmp/design-workflow-visual/group-hover-edge。

第二轮：同一隔离预览，桌面 1440×1000、平板 1024×900、窄屏 390×844 均通过。注入旧悬停色复现后移除覆盖；打开三组前后截图，悬停不再发白，文字无溢出，开关位置稳定，编辑及焦点检查通过。证据：.test-tmp/design-workflow-visual/group-hover-review。

npm --prefix apps/web test -- MessageAccessPanel ProductV4：15 项通过。未连接真实群或部署。
