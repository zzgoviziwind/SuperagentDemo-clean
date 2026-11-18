# SuperAgent Windows 候选版

在 Windows 10 或 11 的 x64 用户会话中运行交付目录里的安装 EXE。程序自带 Node 24 和工作台文件，可离线安装。首次试用请使用独立目录和端口，并在工作台新建测试项目。启动地址会打印在命令窗口中，默认是 `http://127.0.0.1:18765`。

## 启动与工作台

1. 打开工作台，进入项目设置，绑定本机仓库和基线分支。修复任务还需要配置允许修改的相对路径及可在本机执行的项目验证命令。使用 Git 工作区时，主机需要可用的 Git。若项目设置中看不到分支，运行 `SuperAgent.cmd -Action Diagnose` 查看选中的 Git；安装在自定义位置时，使用 `Configure -GitExecutable` 指定现有 git.exe 的绝对路径，再运行 `Restart`。
2. 通过安装目录里的 `SuperAgent.cmd -Action Configure` 显式指定已有 Codex 程序和账号目录，重启后在管理设置中连接本机账号。打开调度后，Worker 才会领取任务。真实模型使用需要本机的有效登录、对应权限以及所选账号的预算策略。
3. 在事件中心查看来源消息和处理记录，在 Worker 中查看当前版本、工具审批和验证产物。结果未知的发送应先核对接收方记录，再在原草稿中登记成功或失败及依据。
4. 基础现场记录支持手工录入及转写时间轴导入。语音识别、视频抽帧和 OCR 使用另外配置的本机组件。配置方法在安装目录的 `field/README.md`。

## 更新应用或回退版本

以下命令使用默认安装位置。自定义安装位置时替换第一行。

```powershell
$manager = "$env:LOCALAPPDATA\SuperAgent\SuperAgent.cmd"
& $manager -Action Status
& $manager -Action Diagnose
```

升级前执行 `Stop`，将 `data` 及另行配置的附件、媒体目录一起备份。用新的安装 EXE 指向同一位置和端口即可升级。升级启动失败时检查 `Diagnose` 中的活动版本和日志。切换到上一版应用使用 `Rollback`。卸载程序使用 `Uninstall`，数据和配置保留在原位置。

## 用原 Python 服务接回同一份数据

停用自动调度及外部发送，停止当前实例，执行 `PreparePythonRollback`。成功后会打印数据库、备份文件及需人工核验的任务、投递、工具审批、模型运行和会话桥接操作编号。先核对接收方回执或原执行记录，再登记处理结果。原 Python 服务的启动参数、执行环境、附件路径以及交还给 TS 的步骤见随包的 `PYTHON-ROLLBACK.md`。冷备份用于恢复选定时间点的完整数据，同库回切会保留在新版中产生的记录。原 Python 的运行环境需要单独准备。

远端执行节点继续由原 Python 控制器和 daemon 协同处理。回切后沿用原节点绑定和共享目录。Windows 本机 Worker 支持单仓和多仓工作区，绑定远端的项目会等待远端资源。

需要桌面 MCP 桥接时，安装包提供 Bearer HTTP 接口；只接受 STDIO 的桌面客户端可沿用原 Python 桥接程序。基础工作台和本机 HTTP 服务随包运行。
