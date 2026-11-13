# ENG-11/12 验收与部署交接

> 总控最新结论：本文件按时间保留模块开发记录，后续真实 Codex、渠道、浏览器及最终回归结果见 [总控验收报告](../验收报告.md)。历史未验收说明不覆盖该报告。

## 交付范围

仅修改 tests/e2e、deploy、docs/运维与验收.md 和本文件。未提交 Git。黑盒通过独立 HTTP 服务、独立临时 Git 仓库、真实 Python 假 Codex 进程及本机假 Redmine 服务操作，测试不导入 superagent 内部实现。

- 任务到项目绑定、隔离目录、真实协议审批、可检查产物、项目测试及人工验收。
- 取消与迟到完成、改方向旧审批、暂停恢复、重启未知结果封禁与显式人工对账恢复。
- 4 个并行隔离任务、第 5 项排队和消息接收。
- 两个任务各自审批，以及同一 turn 两项审批的独立可批准性。
- 未鉴权事件、重复重投跨重启、已授权身份和项目范围的 Redmine 事件到验收闭环。
- 工具失败但 turn 正常结束的负向用例。
- 真实 settings/connector API 接入本机假 Redmine，模拟写入到达但回执丢失，备份恢复后重复 publish 返回原 unknown，远端模拟写入计数保持 1。
- SQLite 快照往返、unknown 保留、文件篡改及清单新增文件拒绝、防覆盖和目录边界。

## 最新验证

运行命令为 `.venv/Scripts/python.exe -m unittest discover -s tests/e2e -v`。最终 18 项全套通过，耗时 202.108 秒，包含运行时采集器的最终契约、同一 turn 双审批、真实设置接入及 unknown 备份恢复不重发。无 skip，无 teardown 错误。

假 Codex 从控制层 prompt 提取管理员配置的 test_command，在自己的真实子进程执行后回传精确 command/cwd/exitCode/output，最后输出 status/summary JSON。控制服务以 EvidenceCollector 采集验证。负向假进程会返回 blocked by policy 工具失败及正常 turn/completed，必须保持未通过。

Windows 启动、健康、默认调度关闭和停机均已验证。最终独立 StateDirectory＋18766 端口的启停复验通过。备份恢复 PowerShell 包装脚本完成过本机停机数据库往返。PowerShell 语法和 Compose YAML、localhost 端口、依赖健康、持久卷、构建路径已静态验证。

普通受限运行阻止 localhost socket。全部 HTTP/进程验收使用获准的本机测试执行权限。Windows taskkill /T 受系统 WMI Quota violation/Provider load failure 影响，脚本及测试已优先采用 .NET 进程树终止，taskkill 为兼容后备。测试遇失败会明确报错，不吞掉 teardown 异常。旧版本测试曾在 venv launcher 后留下数据库句柄，现按拥有的 Popen 句柄/PID 终止完整树并等待退出。

## 部署和操作

- deploy/start.ps1、stop.ps1 默认使用 deploy/state，新增 StateDirectory 参数供独立测试记录。后续本会话测试只使用 tests/e2e/.tmp/script-* 和独立端口，不操作根会话的 8765 工作台。
- deploy/compose.yaml 提供 API、Web/Nginx、PostgreSQL，默认仅发布 localhost。Python 3.12 和 Node22 镜像分别使用已有锁文件。
- Nginx 转发原 Authorization 和 Cookie，保留 member/viewer 身份。未给请求注入管理员令牌。用户登录取得 HttpOnly 会话。TLS 由可信前置代理设置 Proto，并同步调整 Origin。
- snapshot.py 离线备份 SQLite 或调用 pg_dump。恢复只输出到全新目录，核对 SHA-256 和完整清单，生成 RECONCILIATION_REQUIRED.txt，不启动任务。
- 账户配置、secret 环境引用、启动/健康/停机/备份恢复、保留和未知副作用对账见 docs/运维与验收.md。

一次手工启停复验曾因已有共用进程记录拒绝启动，其 finally 调用了默认 stop。已将手工清理改为仅在本次成功启动后执行，并为测试增加独立 StateDirectory。总控随后通知 8765 为交付工作台，后续测试避开该实例和记录。

## 未验证与交付限制

- Docker 当前未安装。未运行 docker compose config、镜像构建、容器健康及 HTTPS 登录，YAML 静态检查不等于容器运行。
- PostgreSQL 服务、并发领取、迁移及备份恢复未运行。SQLite 证据只覆盖单进程离线验收。
- 总控真实 Codex 冒烟遇工具策略阻止，真实修复未通过。本测试只验证假协议调度及证据链。
- 真实钉钉 OAuth/监听/回复和 Redmine 账号/工单尚未联调。所有发送均仅到本机假服务。
- 浏览器视觉验收由总控记录环境阻塞，工作台 UI 交互和生产构建由前端/总控单独验收。
- RPO 24h/RTO 4h 为目标，尚未实测全量恢复耗时。

最新回归中还修复了假 Codex 在 Windows 默认管道编码下未能识别中文测试命令前缀的问题，stdin/stdout 显式 UTF-8。修复后由假进程真实执行精确项目测试命令，采集证据进入 review_ready，最终18项全绿。
