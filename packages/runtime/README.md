# 阶段 1 离线运行时

[源码映射](SOURCE-MAP.md) 记录冻结 Python 行为及真实适配优先级。阶段 1 的入口为 `index.ts`，由总控显式选用。测试仅使用当前 Node、标准流和合成临时目录。

## 接入

- `FakeCodex.start({ cwd, scenario, exitAt, timeoutMs, turnResponseDelayMs })` 固定启动本包的 app-server 夹具。`cwd` 传入运行方独占的临时目录。`scenario` 可为 `reply`、`analysis`、`repair` 或 `approval`，默认 `reply`。Host 启用 `repairFixture` 时，`approval` 场景在收到批准后只允许改固定样例文件。
- `startThread()` 默认 `read-only`。`startTurn(threadId, prompt)` 返回 `{ threadId, turnId }`，表示收到开始确认。用单个异步消费者读取 `events()`，按 thread/turn 处理 `turn/completed` 或 `runtime/disconnected`。`respondApproval(id, binding, 'approve' | 'reject')` 和 `respondReadTool(id, binding, text)` 只接受当前轮次的对应请求。离线审批通过 `serverRequest/resolved` 回传同轮请求确认。`close()` 返回是否已确认整树退出，`exited` 保留监督进程的业务退出码。
- `openRestrictedCodex(options)` 为 Worker、Router 和 Watchdog 共同的受限入口。`source` 选固定夹具或服务端已固定的本机程序与登录目录。本机 `mode` 可选 `reply`、`analysis` 或 `repair`，默认 `reply`。reply 不允许工具；analysis 只接受同轮 Host `read_file` 回执；repair 使用独立工作区写入策略并拒绝提权。按原约定关闭插件、Hooks、Apps 和 MCP。通过 `account/read` 检查已登录类型及计划，只返回诊断需要的字段。
- `resumeThread(threadId)` 校验响应的 thread ID 和真实 cwd；`steerTurn(binding, content)` 传递 `expectedTurnId` 并校验响应的 turn ID。期限、租约、同轮持久证据和预算由各消费方管理。共享卷和远端 daemon 暂由冻结的 Python 服务承载。
- `FakeChannel.open(root)` 使用调用方独占的临时根目录。`send({ actionId, actionHash, target, content }, checkpoint?)` 将单份收件刷入临时文件，再原子发布到 `root/fake-channel-receipts`。`receipts()` 可在另一个进程中重开并读取。可执行测试中的独立发送进程用于验证发布前后退出。
- 控制层在调用发送前持久化 `dispatching` 并校验授权、目标和版本。在异常或进程中断时，已进入发送的记录应等待核对。假收件保留每次实际写入，重复调用会产生第二条收件，使测试能揭示账本重发错误。
- Windows 启动、强制停止和退出证据使用 `@superagent/windows-job`。返回业务码之前监督进程等待 Job 内无活动进程。退出码 `125`、信号停止或超出等待上限都保留为未知。若构建为单文件 `apps/server/dist/main.js`，随包保留 `dist/fixtures/fake-app-server.ts` 与 `dist/bin/windows-job-x64.exe`。`fixtures/fake-channel-sender.ts` 只供测试。

## 退出注入与可观察结果

| 参数或注入点 | 调用方观察 | 独立证据 |
| --- | --- | --- |
| `before_turn_response` | `turn/start` 抛 `CodexUnknownOutcome` | Codex 夹具退出码 71，无轮次确认，合成 stderr 标记未进入事件与公开错误 |
| `after_turn_response` | 已有轮次 ID，终态缺失 | 退出码 72，保留 `turn/started` 和 `runtime/disconnected` |
| `after_approval_response`（`approval` 场景） | 审批答复已写入 stdin，终态缺失，重启后的实例拒绝旧请求 | 退出码 73，夹具在读取审批答复后退出 |
| `turnResponseDelayMs` 超过 `timeoutMs` | `CodexUnknownOutcome`，会话关闭 | 不接受迟到帧，也不会用该会话重发 |
| `before_receipt` 强制退出 | 无发送确认 | 独立收件方读取 0 条 |
| `after_receipt` 强制退出或抛错 | 无发送确认，传输异常为 `ChannelOutcomeUnknown` | 独立收件方读取 1 条，目标、动作 ID、哈希和内容可核对 |

## 验证与边界

```powershell
npm --prefix packages/runtime test
node node_modules/typescript/bin/tsc -p apps/server/tsconfig.json
```

Windows、Node `v22.20.0`，在可启动 Windows Job 原生程序的隔离临时目录通过 11 项运行时测试。将 `tests/rewrite-runtime-review/candidate_checks.py` 与运行时和 Job 包原样复制到独立临时目录后复跑，15 项全部通过，含混合后代正常退出、强制退出、Host 死亡。测试目录含中文与空格，父进程注入合成渠道、数据库及模型环境标记。假子进程在握手前检查允许的系统字段与隔离目录，握手响应仅包含夹具标识和进程 ID。

`collectFakeTurnEvidence` 只投影同一 thread/turn 的协议记录，并标记 `source: offline-codex-fixture`。Host 可另行绑定合成工作区的实际 Git 差异、固定验证命令和受限文件读取。真实登录、真实模型、真实渠道及 Node 24 安装后运行需要各自的验收。收件测试针对进程退出后的重新打开，未检验突然断电后的文件系统持久性。
