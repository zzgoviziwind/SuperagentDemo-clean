# 阶段 4 Windows 分发验收

交付范围为工程验收包。正式分发件等待总控给出最终源码号，届时从该源码构建前后端、核对 Job helper，并记录最终包摘要。

## 官方运行时

从 [Node.js 官网 Windows x64 ZIP](https://nodejs.org/download/release/v24.22.3/node-v24.22.3-win-x64.zip) 下载 Node `v24.22.3`。将下载到本地的 [官方 SHA-256 清单](https://nodejs.org/download/release/v24.22.3/SHASUMS256.txt) 与 [官方发行记录](https://nodejs.org/en/blog/release/v24.22.3) 核对。ZIP、解出的 EXE 和实际运行的 Node 指纹在各自阶段校验。

| 文件 | SHA-256 |
| --- | --- |
| `node-v24.22.3-win-x64.zip` | `E612AF99F626AB415EA225AF6BCE5C971FEB448CB5CAE250BB1C3FA50C5F7D9F` |
| `win-x64/node.exe` | `86FC4785327DB5F5C7558DC6156C543B433C313E813A222E088086222AB4AFA6` |

ZIP 和原始清单保存在 `.artifacts/node-official`，运行时在其 `runtime` 目录。旧本机 Codex 运行时仅作备用，打包时采用 `operator-supplied` 来源。SHA-256 校验使用官网 HTTPS 清单和同版发行公告中的摘要。

## 验收输入

| 工程包 | TS 入口 SHA-256 | EXE SHA-256 |
| --- | --- | --- |
| `stage4-ts-a` | `539219645BBBA36A469940AB847AF22539418D2779047208E242DDD0ECE3467C` | `FF4C2D27A0BF0779FF5C0F5278331DABD8180C183D242028E9A643B360143991` |
| `stage4-ts-b` | `67CD629891AB831B57DF4229B23741D9FC827BBE51231705FB0FB554431D70D0` | `2DB69A5B1E5397E8B5068632D749CCE793B01A5AAD7272ABEC9482E7C5A32184` |
| `stage4-ts-failed-start` | 同 `stage4-ts-b` | `0FCE2311D71699488BC62415B9F86F48B3DA625E9472021BEC0C2E48D79B5ABF` |

第一份 TS 产物来自此前已验证的 Field Intake 安装样本。第二份来自当前工作树一次独立复制的 `apps/server/dist`。故障包保留第二份真实 TS 主程序，构造错误的包模块类型让 Node 在加载真实 TS 构建产物时失败。生产依赖使用独立的 `.deps/server-production`。三份都包含摘要为 `425CD705D1FB3B5E2D47ABA00C50145A890A9F664861A0274F2682AC60EFE1BC` 的 Windows Job helper。

安装输入与结果保存在 `.artifacts/stage4`。使用 [构建和普通用户安装指南](./README.md) 生成工程包，`-Version` 对应上表。构建时给出通过校验的官方 ZIP。回归测试只走临时用户目录和选定的高位回环端口，使用实际 TS API 写入合成项目和任务。

```powershell
$stage = (Resolve-Path '.\deploy\windows-ts\.artifacts\stage4').Path
$pkgs = Join-Path $stage 'packages'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\deploy\windows-ts\Test-TSLifecycle.ps1 `
  -FirstInstaller (Join-Path $pkgs 'SuperAgent-stage4-ts-a-win-x64.exe') `
  -UpgradeInstaller (Join-Path $pkgs 'SuperAgent-stage4-ts-b-win-x64.exe') `
  -FailingInstaller (Join-Path $pkgs 'SuperAgent-stage4-ts-failed-start-win-x64.exe') `
  -EvidenceDirectory $stage
```

## 实测结果

| 场景 | 结果 |
| --- | --- |
| 真实 TS A 安装、A 升级到 B | 通过。实际 Node 可执行文件匹配官方摘要。两个版本的 TS 入口摘要和 PID 均不同。A 创建任务 1，B 读到任务 1 并新建任务 2 |
| B 升级到启动故障包 | 通过。安装命令返回失败，候选留下 Node 启动错误。自动恢复真实 TS B，原回滚目标为 A，两条任务都能读回 |
| 手动回滚及切回 | 通过。实际入口摘要从 B 切至 A 再切回 B。A 可读取 B 创建的任务 |
| 正在运行时卸载及中断续做 | 通过。人为占用一个受管清单触发删除失败，诊断提示 `uninstall-incomplete`。释放文件后重试，程序版本移除，端口关闭，SQLite、启动配置、日志和无关文件均保留 |
| 使用原位置重装 | 通过。无须重新指定端口，B 恢复使用原位置和端口，两条真实 TS 任务可读取，原启动配置摘要一致 |
| 配置与缺依赖提示 | 通过。另起 B 实例验证了合成 Codex 路径选择、凭据进程内注入、诊断提示缺失变量、保存禁用的合成 Redmine 配置，以及缺本机语音模型时的时间轴导入提示 |

真实轮换日志为 `.artifacts/stage4/lifecycle-run.log`，证据目录为 `ts-life-d2325081a116`，端口 `64382`。配置验证日志为 `configuration-run.log`，证据目录为 `superagent-ts-d5d2098571f248f1928a0650a38994cd`，端口 `52191`。两项脚本都以退出码 0 完成，临时服务已停止。

工程包、官方 Node ZIP 和完整临时目录保留在 `.artifacts`。官方摘要清单、两轮原始输出、失败启动日志及 18 项摘要索引另存到 [阶段 4 留存目录](./evidence/stage4/REPRODUCE.md)。该目录也记录官方运行时准备和三个工程包的构建参数。

## 验收环境

- 同一 Windows x64 开发机的普通用户会话，测试脚本要求管理员权限检查为 false。测试绕开系统 Node，直接校验安装后实际服务 PID 的 Node EXE 摘要。
- **干净 VM 未验。** 2026-11-18 的普通用户只读检查显示 Windows Sandbox、Hyper-V 和 Hyper-V PowerShell 管理组件均禁用，Hyper-V 来宾查询命名空间不可用。本机常见工具路径中未发现 VirtualBox、VMware 或 QEMU 的启动入口。虚拟机平台已启用，当前用户没有已登记的 WSL 发行版。 [Windows 可选功能状态含义](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-optionalfeature)
- 现有本地账号中有一个候选。排除当前账号和内置账号后有两个已启用账号，其中一个在非特殊 Windows 用户配置文件清单中无对应项，且未直接加入本机 Administrators 组。该账号用途和登录授权尚未确认。若账号持有方确认它是测试账号并亲自登录，可补做新用户配置文件安装验收。它仍共享这台开发机的系统组件。此次只查询数量和状态，系统账号与安全设置保持原状。
- 样本未签名。服务端跨数据代迁移、真实 Codex 登录和渠道收发交由独立验收。
