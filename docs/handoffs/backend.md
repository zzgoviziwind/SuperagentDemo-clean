# 控制后端调度交接

> 总控最新结论：本文件按时间保留模块开发记录，后续真实 Codex、渠道、浏览器及最终回归结果见 [总控验收报告](../验收报告.md)。历史未验收说明不覆盖该报告。

## 范围与运行

`superagent/core/scheduler.py` 接入异步 Codex app-server、独立克隆工作区、任务/审批/事件/产物持久化、同轮结果证据、版本栅栏、暂停取消、空闲超时和预算预留。配置 `SUPERAGENT_CODEX_EXECUTABLE`（路径或 JSON argv）、`SUPERAGENT_WORKSPACES_ROOT`、`SUPERAGENT_ATTACHMENTS_ROOT`；`SUPERAGENT_MAX_PARALLEL_WORKERS` 最大 4，受治理设置 `max_concurrent_tasks` 进一步限制。管理员需启用 `scheduler_enabled`、配置全局预算和正数 `budget_reservation_estimate_micros` 才领取工作。运行时读取 `codex_model` 与 `codex_effort`。启动命令见总控文档。

执行前原子预留，启动后无可核实价格/用量则预留标记 unknown 并保留，不伪造 0 成本。线程及回合 ID 持久化。`Task.outcome_unknown` 用于标记运行结果未知；断连、协议错误、启动 turn 后异常和停止超时进入 waiting_resource，须人工对账，旧审批按版本失效。空闲超时配置 `SUPERAGENT_RUN_IDLE_TIMEOUT_SECONDS`，默认 1800 秒；等待审批不计入空闲。启动恢复、角色鉴权、reconcile 和连接器接线在总控 `main.py` 及其他模块。

项目配置的测试命令由 Codex 受控执行，**控制服务不直接运行项目测试命令**。仅接受当前 thread/turn 的 commandExecution 完成事件，要求命令与项目 test_command 精确匹配、cwd 为工作区、状态完成、退出码为零且包含输出；真实结构化模型报告和工作区差异也必需，模型转轮完成本身不构成验收。命令失败、缺少报告或证据转 waiting_input；工具策略阻止时不会绕过执行。实际输出可含敏感信息，需限制产物访问及外发。

使用 `validate_workspace_changes` 检查基线差异；审批请求按当前 allowed_paths 校验 grantRoot 或拒绝无法限制范围的命令，空范围拒绝。路径检查只能发现最终结果，无法保证运行时仅能写允许目录，也不能阻止进程对工作区外的副作用；严格隔离仍需操作系统能力。审批决定时须再次校验最新项目授权，由总控接线。默认原始仓库必须干净，不能覆盖。

当前 revision 的 source_attachment 从受管根路径重新校验大小、SHA-256 与链接/reparse；图片经 localImage 输入 Codex，UTF-8 文本总量上限 256 KiB，PDF 传受管路径并提示未必可读；其余类型拒绝。图片读取和校验之间存在竞态；路径防护、外部资料保密和模型可否读取 PDF 仍需真实接入验收。

## 验证与限制

- 离线 `pytest tests/core tests/e2e -q`：25 项通过。运行期间补充了事件轮次归属检查与启动错误脱敏；最终文件随后重跑主链、同轮双审批、工具失败和空闲未知 4 项，全部通过。
- 本机图片假协议测试：受管图片进入 localImage，附件篡改拒绝；来源下载至调度的完整图片链仍需 QA 验证。
- 一次 core/runtime 组合回归中，运行时环境隔离测试在并行修改期间失败，单项立即重跑通过；最终整套运行时测试需由总控在集成稳定后执行。
- Windows 测试曾出现 taskkill 未能终止测试服务导致 SQLite 文件占用，后续 25 项整套成功不代表已验证所有进程树故障。PostgreSQL 并发、Linux 及断电/灾备恢复仍待验证。
- 真实 Codex 曾受本机工具执行策略阻止，真实代码修复、钉钉及 Redmine 均未完成联调。不能将离线模拟视为真实业务验收。未提交 Git。

## 只读分析补充

analysis 任务在 thread/start 与 thread/resume 都显式传 `read_only=True`；运行时缺少该能力时拒绝执行。提示不要求运行项目测试。文件修改及命令提权审批请求自动拒绝，分析结果出现工作区变更时进入 waiting_input，不允许 review_ready。测试仅证明调度传参和拒绝逻辑；实际 Codex 沙箱与底层操作系统隔离仍需独立真实验收。

独立假 Codex 定向测试：只读启动、不携带项目测试命令、恶意改动阻止交付、拒绝审批后只读恢复共 3 项通过；使用独立 Codex 配置目录的 repair 主链额外 1 项通过。注意共享服务 Codex 配置目录在真实运行后出现 plugins 目录，运行时会话正核查其安全检查与后续启动的兼容性。

## 分析任务只读文件工具

分析任务可通过同轮 dynamic tool 调用 `list_files`、`read_file`、`search_text`，不使用 shell 或网络。只接受匹配当前 thread/turn 的 analysis 请求，路径限定独立工作区；拒绝穿越、绝对路径、链接/reparse、硬链接及敏感名称。限文件与总读取字节、遍历数、深度、输出和操作时间；文本搜索为固定子串，返回行号。审批提权保持拒绝。

事件只审计工具名、读取文件数量、成功、截断和拒绝，不记录搜索词或正文；verification 保留调用数量、证据读取数、工具名、不可读取数和截断提示。单纯列目录不能作为分析依据；安全访问拒绝、未恢复读取错误不能靠后续成功掩盖。权限等读取错误报告 unreadable_files 和截断；正常二进制或非 UTF-8 文件记录 skipped_binary，不冒充读取。列表/搜索截断作为 limitation 供人工审阅。旧分析线程没有工具版本标记时新建只读线程并记录替换，不清理工作区和消息。文件检查与使用之间仍有竞争窗口，不能替代操作系统隔离。

最终 `pytest tests/core/test_readonly_tools.py tests/core/test_analysis_readonly.py -q`：9 项通过，覆盖路径与敏感文件、硬链接、输出上限、模拟权限错误与二进制区分、假 Codex 工具请求读取 README 并引用行号、拒绝后续成功掩盖及修复任务主链。Windows symlink/reparse 实测受系统创建权限限制；真实 Codex 只读分析及操作系统隔离仍需独立验收。

`search_text` 另支持在单个受管文本文件中搜索，仍拒绝敏感、二进制、越界及链接路径，并遵守同一字节和输出上限。定向只读工具测试 6 项通过；真实新 revision 验证由总控进行。
