# 运行时交付记录（仍需集成验收）

> 总控最新结论：本文件按时间保留模块开发记录，后续真实 Codex、渠道、浏览器及最终回归结果见 [总控验收报告](../验收报告.md)。历史未验收说明不覆盖该报告。

`superagent.runtime.codex.CodexAppServer` 提供契约中的接口，并增加 `read_thread(thread_id)`。显式传入可执行文件，`config` 中 `timeout` 为请求超时秒数，`max_line_bytes` 为协议单行上限（默认 8 MiB，范围 64 KiB–32 MiB），仅允许 model 传给 thread/start；其他字段（含 sandbox、approvalPolicy 和任意嵌套配置）拒绝。事件保留原始服务器请求，提供 stderr、迟到响应、协议读取错误、断连、终止未确认和强制终止事件。超时和断连的请求结果未知，控制层应持久化 thread/turn ID、事件、审批和版本并对账，不能盲目重试。

关闭时先对已知活动轮次请求 interrupt，等待完成通知，再关闭 stdin 等待进程退出；不响应时强制终止进程树。中断请求成功不代表副作用撤销；丢失 start 响应时活动轮次未知，也须对账。Windows taskkill 及脱离进程组的子进程尚未充分验证。

`prepare_workspace(repo_path, base_branch, task_id, workspaces_root)` 创建独立克隆，要求原仓库干净和本地基线分支。`collect_changes(path, base_sha=None, max_file_bytes=1048576, max_total_bytes=8388608)` 返回基线到工作区的 `diff/stat/status`、解析后的 `base_sha` 和未跟踪文件 `untracked_artifacts`（路径、大小、SHA-256、base64 内容）。调用方必须传入 prepare 返回的 base_sha 才能包括模型提交后的变化；默认 HEAD 仅兼容旧调用。未跟踪文件拒绝符号链接、越界、特定敏感名称和超限；敏感名称筛选不是秘密扫描，使用者仍须执行内容级保密审查，忽略文件不收集。受信任的项目绑定和产物访问控制由控制层实现。

验证：在完整本机环境运行 `python -m unittest discover -s tests/runtime -v`，2 项通过；覆盖假进程初始化、审批、迟到响应、interrupt，以及临时仓库已提交变更、未跟踪文件内容和敏感名称拒绝。受限环境中 Windows asyncio 事件循环卡住，本机完整环境可运行。未完成大消息、断连、恶意竞争修改、真实进程树和 Linux 验证。

本机显式可执行文件 `C:\Users\examp\AppData\Local\OpenAI\Codex\bin\9e1da79431da526b\codex.exe` 的 `app-server --help` 可用；未生成本机 schema，未做真实认证或模型冒烟。构造配置不允许覆盖默认线程审批及 sandbox；集成时仍须验证实际进程与权限边界。参考 https://developers.openai.com/codex/app-server/ 。没有提交、部署或发送外部业务内容。

## 执行结果与验收

新增 `superagent.runtime.outcome.assess_outcome`，由控制层传入轮次状态、原始事件、工作区差异、独立验证记录和模型结构化报告，返回建议状态及工具失败与缺失证据的原因。修复任务需要差异与独立验证证据，分析任务需要分析证据；即便证据齐全也仅建议 `review_ready`，不能直接标记完成。工具失败项保留原始 item，便于审计。控制层须采集并持久化这些证据、限定事件属于相应轮次并执行状态转换。未识别的工具失败或缺失事件不能证明工具成功，调用方须校验事件完整性；模型报告不替代独立证据。

总控报告的真实 Codex 验收中模型虽发出 `turn/completed`，但工具执行被策略阻止，未修改和测试，真实修复未通过；未绕过策略。离线负向用例覆盖该场景，以及完成轮次缺少证据时的分析/修复判断。`python -m unittest discover -s tests/runtime -v` 共 5 项通过（完整本机环境）。

## EvidenceCollector 与调度器对接

```python
from superagent.runtime.evidence import EvidenceCollector
from superagent.runtime.outcome import assess_outcome

collector = EvidenceCollector(thread_id, turn_id, workspace_path, project.test_command)
# 每个原始事件都按顺序传入；仅接收 threadId 和 turnId 均匹配的事件。
collector.add_event(raw_event)
# 断连、协议错误、历史缺口、无法证明事件完整时调用：
collector.mark_incomplete()
evidence = collector.snapshot()
# 保存 evidence["commands"] 和 evidence["tool_failures"]；原始事件仍需保存并按轮次过滤。
assessment = assess_outcome(
    task_kind="fix",  # scheduler 的 repair 映射为 fix；analysis 映射为 analysis
    turn_status=turn_status,
    events=filtered_turn_events,
    changes=collect_changes(workspace_path, base_sha),
    verification=evidence["verification"],
    outcome=structured_model_outcome,
)
# assessment["suggested_status"] 为 waiting_input 或 review_ready；控制层仍须应用 revision/control_version 栅栏。
```

`commands` 每条包含 `id, command, status, exitCode, output, cwd, completed_event`，字段来自同一轮次的原始 commandExecution item。仅当项目配置的 `test_command` 非空且与执行的 command 完全一致，或与受信任系统 shell 的单一命令参数完全一致、cwd 是工作区根目录、收到 completed 事件且 status=completed、exitCode=0、output 为字符串、事件流完整，验证才为 passed。命令字段或 cwd 缺失、包装器导致命令不完全一致均保守视为未验证；不得用模型总结替代。此匹配证明记录的命令成功退出，不证明测试充分，也不排除命令自身可能掩盖失败；按项目管理的测试命令和人工验收判断。分析任务可无 diff，仍必须呈现工具失败和分析依据。命令输出和原始事件可能含敏感信息，应由控制层限制访问并按保密策略处理，不能默认对外发送。

当前 scheduler 已调用 EvidenceCollector 并将验证证据传给 assess_outcome。`tool_failures` 需要保留，即便后续重试通过也不能静默抹除。完整本机 schema 字段和真实事件兼容性尚待验证；收集器对不匹配字段失败关闭。

## 路径授权、图片与模型参数

- `validate_allowed_paths(workspace_path, paths, allowed_paths) -> list[str]`：所有路径均为 Git 风格仓库相对路径；空 allowed_paths 不允许任何变更，`["."]` 允许仓库内所有普通路径。路径穿越、绝对路径、反斜线、现存符号链接或 Windows reparse point 被拒绝。审批处理需先将可信的审批路径转换成仓库相对路径，再同时检查所有源和目标；不能安全转换时拒绝审批。它检查当前文件系统，不能抵御检查后路径被并发替换；控制层需隔离写入并在执行前后重新检查。
- `changed_paths(workspace_path, base_sha)` 以 NUL 分隔 Git 输出收集基线以来跟踪文件的旧/新路径和未跟踪路径；`validate_workspace_changes(workspace_path, base_sha, allowed_paths)` 对这些路径全部执行检查，任一不符抛出 ValueError。调度器在生成结果、允许进入 review_ready 之前必须调用；任何越界或无法检查都不可进入 review_ready。Git 忽略文件、进程对工作区外副作用以及改动后恢复的历史不会体现在最终差异中。
- 本机生成的 `TurnStartParams` schema 支持 `sandboxPolicy.workspaceWrite.writableRoots`，但 schema 未证明这些是对仓库工作目录的排他限制；当前客户端默认 workspace-write，不能保证仅 allowed_paths 可写。上述检查不是运行时沙箱，不能阻止已经发生的越界写入或撤销副作用；严格执行时限制需要单独的操作系统隔离方案及跨平台验收。
- `await client.start_turn(thread_id, prompt, model=None, effort=None, image_paths=None, attachment_root=None)` 后四项为关键字参数；控制层将治理配置 `codex_model`、`codex_effort` 分别传给 model、effort。参数不传保持旧行为。模型和强度兼容性由控制层与可用模型列表校验。图片传绝对路径列表，必须位于受信任 attachment_root 下、无链接或 reparse，最多 10 张且每张最多 10 MiB；支持 PNG/JPEG/GIF/WebP 文件签名，使用 schema 中 `{type:"localImage",path:绝对路径}`。签名检查不是完整文件安全或解码验证；调用方负责可信存储、防并发替换、授权、生命周期和限制数据外发。检查与 app-server 读取之间存在竞争，不能将其当作隔离机制。
- 测试 `python -m unittest discover -s tests/runtime -p test_policy.py -v`：2 项通过，链接创建测试因本机权限跳过；Windows reparse、Linux 链接、审批真实结构及真实模型图片读取尚未验收。具体集成状态以当前 scheduler 为准。


## 有界差异与启动配置

`collect_changes` 的 `max_total_bytes`（默认 8 MiB）现在同时限制未跟踪文件的 base64 内容及 diff、stat、status 的 UTF-8 输出总量；单个未跟踪文件仍受 `max_file_bytes` 限制。Git 输出按流读取并在超限时终止、抛出 ValueError，不返回被截断的差异。路径枚举也有独立 8 MiB 上限。最终 JSON 元数据和转义可能额外占用空间，控制层应对序列化结果设置自己的持久化上限。已跟踪及未跟踪变化路径均检查链接与 Windows reparse；文件系统检查仍有并发替换风险。

CodexAppServer 的 config 仅接受客户端参数 `timeout`、`max_line_bytes` 和已核对线程字段 `model`；沙箱、审批策略及任意未知配置均直接拒绝。`effort` 通过 `start_turn(..., effort=...)` 指定。`python -m unittest discover -s tests/runtime -p test_limits.py -v` 两项通过：超限跟踪差异、模拟 reparse 与危险配置拒绝。真实 Windows reparse 的端到端测试仍未完成。


## 服务专用 Codex 状态与证据顺序

`SUPERAGENT_CODEX_HOME` 可指定服务专用状态目录的绝对路径；未设置时使用服务启动工作目录下的 `data/codex-state`。子进程继承系统必需变量以及 `OPENAI_API_KEY`、`CODEX_API_KEY`，不继承应用、Redmine、数据库等其余变量。服务目录持久保存会话，不复制用户个人配置；目录中存在 config.toml、命名 profile 配置或异常插件目录结构时拒绝启动；兼容 Codex 自动创建的 plugins/cache 和 .remote-plugin-install-staging。真实系统级配置、项目配置及同一 OS 用户文件访问仍需另行隔离或审计；环境白名单不是 OS 安全边界。

如使用 ChatGPT 登录，请以服务运行账户将 `CODEX_HOME` 设为与 `SUPERAGENT_CODEX_HOME` 相同的专用绝对目录，再手动运行 `codex login --device-auth`，按提示完成登录；`codex login status` 可检查状态。登录和状态检查结束后，必须从服务启动环境删除父进程的 `CODEX_HOME`（PowerShell：`Remove-Item Env:CODEX_HOME`），保留 `SUPERAGENT_CODEX_HOME`，再启动服务；否则服务会将相同的父 `CODEX_HOME` 视为个人目录并拒绝启动。也可使用服务进程环境中的 OpenAI API key。请勿复制整个个人 Codex 目录。实际认证和真实跨进程恢复尚未验收；假 app-server 仅验证了同一专用目录跨两个 client 保存并恢复测试记录。本机 `codex --ignore-user-config app-server --help` 明确报未知参数，因此没有使用该选项。

EvidenceCollector 的 verification 保留同名结构，但测试成功之后的 fileChange、commandExecution、mcpToolCall 事件会使旧验证失效；有并发工具未结束也不通过。后续同一轮次相同命令和 cwd 的成功测试被 collector 认定为最终有效时，`assess_outcome` 可将普通非零测试失败标为 recovered，`tool_failures` 保留全部历史，`blocking_tool_failures` 列出仍阻塞的失败；拒绝、策略阻止、server error 仍阻塞。scheduler 需要以 `assessment['blocking_tool_failures']` 和 `assessment['suggested_status']` 为门槛，不能用原始 tool_failures 是否为空作为阻塞条件；仍应保留失败历史。策略拒绝识别依赖结构化状态与已知输出标记，未知格式不能保证被识别。

## 分析任务的只读设置

调度器按任务类型在新建和恢复时均传 `read_only=True`：`await client.start_thread(cwd, instructions, read_only=True)` 或 `await client.resume_thread(thread_id, read_only=True)`。修复任务省略此参数或设为 False，保持 workspace-write。两种情况均显式发送 `approvalPolicy=on-request`；只读分析的审批处理也必须拒绝任何扩大写入权限的请求，否则无法保证只读。参数必须是 bool。`assess_outcome` 的分析任务如收到实际 diff、未跟踪产物或非空 status，将返回 `analysis_workspace_changed` 和 waiting_input。工作区变更收集失败或缺失时调度器应单独视为证据不足，不能推断没有改动。

本机生成的 ThreadResumeParams schema 包含 sandbox 与 approvalPolicy；离线参数及负向判断测试 2 项通过。尚未以真实 Codex 完成只读写入阻止或恢复验证。模型若执行外部副作用，文件系统只读本身并不构成外部动作隔离。


## 插件缓存与启动限制

实查服务专用目录的 `plugins/cache` 已含多个远程插件缓存，并非空目录。app-server 启动参数固定传入 `--disable plugins --disable apps --disable remote_plugin --disable hooks --disable plugin_discovery_prefetch`，并拒绝专用目录下的配置文件和 plugins 中非 cache/staging 项，也拒绝这些顶层路径为链接或 reparse。用本机 CLI `features list` 验证了这些 feature 在相同禁用参数下为 false，`app-server --print-startup-config` 接受参数；假进程测试验证参数传递、缓存重启及异常状态拒绝。该验证没有证明所有系统级或项目级 MCP 配置、已有已启动进程及其他外部工具均不可用；要实现强隔离仍需独立账户和受限运行环境。未读取或修改专用目录凭据，也未干扰已运行任务。

## 审批决定选项

运行时保留原始请求的 method 和 `availableDecisions`。批准仅发送一次性 `accept`；拒绝优先 `decline`，不可用时发送 `cancel`（本机 schema 说明 cancel 同时中断轮次）。如果服务端显式给出选项但没有安全可用决定，抛出 CodexError 并保留待处理请求，不发送 session 批准或策略修改。缺少该字段时，按本机生成的 command/file 审批响应 schema 使用 accept/decline；本机生成的请求 schema 没有声明 availableDecisions，而真实请求提供了该字段，因此不可断言 decline 总是可用。离线审批选项测试 2 项及既有协议测试 1 项通过。总控另已实际确认新配置下 `mcpServerStatus/list` 返回空列表；这不证明其他类型的外部能力均被隔离。


## 测试命令包装与重试通知

EvidenceCollector 对 command 采用完整匹配：直接命令必须等于 test_command；支持受信任系统位置的 PowerShell/pwsh 或 sh/bash 的三参数 shell 包装，解析后唯一 payload 必须与 test_command 完全一致。额外参数、多条命令、未知 shell 或非系统目录中的同名可执行文件均不通过。Windows 使用 SystemRoot/ProgramFiles/ProgramW6432 定位允许的系统目录；Linux 使用 /bin 或 /usr/bin。其他合法包装保守认作未验证，Linux 尚未真实环境验收。命令匹配不替代权限隔离或验证测试本身的充分性。

本机 ErrorNotification schema 的 willRetry 为必填布尔字段。`assess_outcome` 仅对 codexErrorInfo 明确为 httpConnectionFailed、responseStreamConnectionFailed、responseStreamDisconnected 之一，且 willRetry=true、同一线程轮次后续明确 completed、独立验证通过的通知标记 recovered；未知或缺失类型、重试次数耗尽、策略、安全、鉴权和 sandbox 错误均阻塞。原始通知保留在 tool_failures；未重试、缺失完成事件、缺失验证或其他轮次的完成事件均仍阻塞。控制层须保证传入事件属于同一轮次并在事件流缺口时将验证设为未通过。测试命令包装与重试判断离线测试分别 4、5 项通过；真实修复验收仍需由总控执行。

## 只读动态工具对接（协议核对）

本机实验版 schema：`thread/start` 的 `dynamicTools` 为工具 spec 数组，每项 `type:function,name,description,inputSchema`；`thread/resume` **没有 dynamicTools 字段**，需依赖原线程持久化的工具定义，不能假设可重新绑定，真实恢复须验收。初始化使用 `capabilities.experimentalApi=true`。服务端请求为 `{id,method:"item/tool/call",params:{threadId,turnId,callId,tool,arguments,namespace?}}`；回复为 `{id,result:{contentItems:[{type:"inputText",text:"..."}],success:boolean}}`，id 是服务端请求 id 而非 callId。运行时拟提供 `respond_tool(request_id, result)`，result 严格是上述 result 对象。

三个工具均无 namespace、禁止额外参数：`list_files` 参数 `{path:string}`；`read_file` 参数 `{path:string,start_line?:integer,max_lines?:integer}`，start_line 从 1 开始，max_lines 为 1–200；`search_text` 参数 `{path:string,query:string}`。所有 path 均为仓库相对路径，由控制层强制 allowed_paths、链接/reparse、大小/数量/超时、只读和敏感数据约束；禁止任意文件、网络和 shell。控制层需绑定 thread/turn、只在分析任务接受已声明工具、处理错误并对结果做上限控制。修复线程不得使用此工具。原样展示调用请求与工具结果须考虑敏感信息；响应只允许 inputText。
