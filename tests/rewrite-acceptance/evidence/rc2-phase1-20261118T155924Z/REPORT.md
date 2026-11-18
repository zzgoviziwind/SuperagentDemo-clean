# RC2 实包阶段 1

指定 ZIP 的 SHA-256 为 bf4593ef65608835c766b43349ba8fdfea5a14609472fe1cd47a7f22da48c9dc。回切两种底库均通过，账本四条路径均通过。阶段 1 未达到自动路径连续两轮通过的条件。

| 实测 | 结果 |
|---|---|
| [回切](../../../rewrite-runtime-review/host-safety/rc-replay/evidence/2986bf738840928c4263f82cb79aef0606ccce58a42ff5d7b3d14592251c1c9c/20261118T154756Z-a269cf7a/recovery.json) | 已派发审批、桥接、工作台运行、备份、Python 同库读回及重复 prepare 通过。 |
| [账本](../../../rewrite-runtime-review/host-safety/rc-replay/evidence/2986bf738840928c4263f82cb79aef0606ccce58a42ff5d7b3d14592251c1c9c/20261118T154852Z-12c1a099/ledger.json) | prepare 两组正常回切，跳过 prepare 两组负对照符合预期。 |
| [文档原有输入](../rc2-phase1-20261118T155333Z/auto-1/failure.txt) | 启用合成钉钉时缺少 executable，PATCH settings 返回 422。此前一次临时目录选择也被 probe 的路径保护拒绝。 |
| [人工草稿](../rc2-phase1-20261118T155529Z/manual/result.json) | 使用离线配置后，四身份、强杀恢复、浏览器对账、Python 回切全部通过。 |
| [自动第一轮](auto-1/result.json) | 任务 2 返回两条同正文草稿，ID 2、3，admin 的单草稿断言失败。此轮停止于投递前，未证明重复发送。 |
| [自动第二轮](auto-2/result.json) | 回复与修复验收完成，审批和版本校验通过，唯一变更为 fixture-value.txt。四身份、浏览器对账、Python 同库回读通过，假渠道回执一张。 |
| [进程树附测](../rc2-phase1-20261118T155107Z/windows-runtime-results.json) | 工作树独立套件在 Node 22 和 24 下退出码均为 0。 |

补测从 ZIP 取 Node、服务、依赖和网页资源，校验包清单。在临时测试入口补齐本地适配器、合成 Git 基线和项目验证命令，按 repositories[0].snapshot 读取唯一仓库的变更，同时检查正文、文件内容、回执和草稿数量。差异见 [harness.diff](harness.diff)。业务进程使用独立合成库和回环端口。浏览器以 admin 对账，四身份权限通过正式 HTTP 检查。两组成功的浏览器截图均已打开复核。完整安装和真实渠道不在本次范围。
