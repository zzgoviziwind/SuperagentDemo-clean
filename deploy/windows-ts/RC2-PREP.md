# RC2 兼容性修正与冻结交接

本轮待纳入总控冻结 SHA 的改动在 `apps/server/src/field`、`apps/web` 和 `deploy/windows-ts`。版本响应另依赖主控 `apps/server/src/server.ts` 读取 `SUPERAGENT_RELEASE_VERSION` 的改动。最终包使用冻结 SHA 的独立 Git archive 重新构建。开发机工程包的版本名为 `field-git-health-retest`，用来验配置和入口。

## 119 差分的 Field 项

| 接口 | 要点 |
| --- | --- |
| `GET /field-intake/organizer` | 基础版恢复 `offline_sample`。`timeline` 和 `ocr` 分别表达实际能力，工作台继续提供时间轴入口。Python 旧预览没有 `timeline` 时沿用旧表现 |
| `POST /field-intake/records` 和候选审核 | 笔记和人工截图候选恢复冻结版字段。转写和 OCR 候选保留本机证据。候选创建只读任务时记录 `task.assign`；链接、略过和重放仍走现有规则 |
| `GET /field-intake/media-jobs` | 同时间戳按原插入顺序列出。旧 `ready/done` 在工作台显示「待审核」，保留缺依赖提示及原媒体的 Range 读取 |
| `POST /field-intake/analysis/{id}/implement` | 同一事务校验当前分析状态版本、验证证据与同轮摘要，递增原分析状态版本，记录修复任务归属和批准审计。相同请求返回原修复任务，分析的 revision 和 control_version 不变 |

保留受保护响应的 `Cache-Control: no-store` 和本机依赖提示。独立测试运行生成的事件数字 ID 由实际数据库分配。可选 OCR、语音模型安装与注入步骤见 [现场记录说明](./field/README.md#可选本机处理)。

## 分发前复验

2026-11-18 21:49（北京时间）完成包侧冻结验收。工程 EXE 的 SHA-256 为 `D9BA5C19DB11ED7F0F53A066A550A36A246AEA2552715D0B84A1B5263FF2908A`。真实 Git 自动发现和显式选择分别验证成功。两仓分支枚举、项目保存及拒绝缺失分支均通过。12 个变量按名字保存，空值拒绝重启且保留正在运行的实例。安装和重启后 `/health` 返回工程包版本，临时监听已释放。

现场记录的 SQLite 回归 6/6，前端单例及默认并发全量 110/110。审批焦点的原断言保留，新增首次挂载与两次 Tab 断言，异步查找按钮的等待由默认 1 秒改为 3 秒。Edge 两轮检查桌面、平板和窄屏，核对了转写、候选审核和项目抽屉截图。早期工程包启动后在浏览器退出紧接重启时遇到两次瞬时 HTTP 读失败，最终工程包通过禁用探测连接复用及重试后完整复验通过。

按 [Windows 构建说明](./README.md#构建) 传入冻结树构建的服务器、React 源码和经锁文件核对的依赖，使用官方 Node 并保留 `-EnablePythonRollback`、Windows Job 摘要。使用最终生成的 EXE 和临时证据目录执行以下验证。

完整的 [RC2 冻结构建、生命周期与证据 ZIP 命令](./RC2-REPRODUCE.md) 包括固定 RC1、同源故障探针和只含验收文件的证据清单。

```powershell
$testBrowser = @{
    Installer = $finalExe
    BrowserNode = $nodeExe
    WebNodeModules = $webNodeModules
    EvidenceDirectory = $temporaryEvidence
    CheckField = $true
    CheckFieldDependencyHint = $true
    CheckReleaseVersion = $true
}
& .\deploy\windows-ts\Test-InstalledServer.ps1 @testBrowser
& .\deploy\windows-ts\Test-InstalledGit.ps1 -Installer $finalExe -GitExecutable $gitExe -EvidenceDirectory $temporaryEvidence -CheckDwsConfigDirectory
& .\deploy\windows-ts\Test-LongTemp.ps1 -Installer $finalExe -Archive $finalZip -EvidenceDirectory $temporaryEvidence
```

应核对真实安装 EXE 内嵌 ZIP 与单独交付 ZIP 的摘要、实际进程提供的首页资源和 Node、默认关闭的 Codex 及外部渠道。Python 回切继续使用上一轮的同库验收办法。Git 测试在未登录 Codex 的临时双仓中核对自动发现、显式本机路径、分支枚举和多仓项目保存。

安装器支持显式选中 `DWS_CONFIG_DIR`，默认使用私有 HOME。DWS 子进程对该变量的消费由渠道组接入。按量 Codex 通过已有登录和工作台单轮预算预留配置接入。
