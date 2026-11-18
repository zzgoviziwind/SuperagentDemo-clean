# Windows 本机渠道

Host 入口 `registerChannels(app,store,lease,root,env)` 可从 `packages/channels/index.ts` 或 `apps/server/src/deliveries/channels.ts` 导入。每个 Fastify 实例只创建一个管理器；投递入口会复用它。返回值的 `statuses()` 可直接用于 overview。接入器复用 `ingest(db,payload,env)`，提交收件完成后才推进 `connector_cursors`。真实传输在启用的本机服务中工作。fixture 模式仅使用临时文件收件器；preview 禁用本机渠道。

管理员通过原设置接口启用各连接器。显式 POST `/api/v1/connectors/:name/start` 或 `stop` 控制当前运行。渠道模块拥有 GET `/api/v1/connectors`。工作台每次生成 overview 时读取同一管理器状态。设置提交后调用 `await reconcileChannels(app, changes)`。发送另需 external_delivery_enabled、有效审批、当前规则和来源目标。

工作台原图端口为 `readOwnDingTalkImages(binding: DingTalkImageBinding, signal: AbortSignal): Promise<readonly DingTalkSourceImage[]>`，类型由工作台的 `runtime.ts` 定义。Host 将渠道注册的端口交给工作台调度器。绑定携带 `eventId` 及原私聊的 profile、peer、conversation、anchorId、selfIds 和时间窗。渠道重读原事件和当前授权，在完整私聊历史确认原消息后按消息 ID 读取 DWS 资源清单。成功时只返回内存中的 `{ contentType, bytes: Buffer }`。每次最多 4 个文件、单个 10 MiB、合计 20 MiB，限时 30 秒，按 SHA-256 去重，下载目录在返回前清理。fixture 和 preview 下保留此端口缺省。

- Redmine 需要 base_url、user_id、project_ids，密钥从 api_key_env 指定的环境变量读取。每轮先 GET /users/current.json 核对身份，按项目分页、读取 journals/attachments 元数据，在完整消费后提交重叠游标。每工单的语义指纹、序列及首次待确认输入复用原键。支持从匹配服务、项目和账号的持久 issue.updated 恢复语义。写评论经原两阶段账本，网络中断和 5xx 归入 unknown。
- DWS 使用管理员配置的 executable、profile、self_ids。精确绑定来源会话和原消息，私聊额外绑定原发送人。进程均以独立参数和 shell:false 启动。stderr ready 后开始收件。已配置历史的群和 @我监听仅在唯一绑定的会话内补收；私聊和无历史配置使用实时订阅。断线保留游标并报告降级。
- 受限飞书回调采用本机 POST `/callbacks/feishu/card`，接收签名的 AES-CBC 加密事件。SUPERAGENT_FEISHU_ENABLED=1、SUPERAGENT_FEISHU_MODE=card 及 APP_ID、OPEN_ID、OWNER_ID、ENCRYPT_KEY、VERIFICATION_TOKEN 齐备时注册（字段统一加 SUPERAGENT_FEISHU_ 前缀）。加配 APP_SECRET 后，后台对当前负责人和当前 Worker 审批创建单人卡片，先写 sending，再记录提供商返回的 message_id。已有通知行阻止重发，旧表原地增加 message_id 列。回调校验时间窗、签名、应用、原卡、操作人和审批版本。冻结 Python 使用 SDK 长连接，本机 HTTP 回调需要管理员配置平台入口。
- Redmine 的 account_map 将账号名映射到正整数数组，例如 `{"owner":[5,9]}`。设置与传输使用相同的数值与大小约束。
- 管理员搜群使用 `GET /api/v1/connectors/dingtalk/groups?q=群名&cursor=上一页游标`。按当前启用的 profile 和 executable 执行只读 `chat +chat-search --query <群名> --limit 20 --format json`，后续页附 `--cursor`。响应保留 items、complete、has_more、stop_reason 和 next_cursor。未授权返回 403，缺少配置、停用或运行模式禁用返回 409，查询/游标无效返回 422，响应结构错误返回 502，DWS 失败或 25 秒超时返回 503。

### 总控接入

对于旧配置中只有 ID 的群，管理员可调用 `GET /api/v1/connectors/dingtalk/group?chat_id=...`，按相同配置执行只读 `+conversation-info`。DWS 返回同一 ID、明确为群聊、且标题非空时才返回原名。

```ts
const channels = registerChannels(app, store, lease, root, env);
// overview 请求处理期间实时调用，返回与 GET /api/v1/connectors 相同的数组。
const connectors = channels.statuses();
```

另可直接调用 `connectorStatuses(app)`。每个状态包含 enabled、configured、missing_configuration、warnings、status、last_error、last_seen。钉钉另含 scopes，各范围独立显示就绪情况、最近接收和历史补收状态。

管理器将 `readOwnDingTalk(binding,signal)` 接入工作台的管理员私聊同步入口。若总控稍后集中设置 `configureWorkbenchRuntime`，应将该函数与其他运行时能力一同传入。它只读原会话、原对方及限定时间窗，以原消息确认锚点，并让工作台按唯一归属写入本账号的历史。Windows 下 DWS 复用项目的 Windows Job 子进程包，Host 关闭时先关闭订阅输入，再终止剩余的受管进程。分发包需保留既有 `bin/windows-job-x64.exe`。

Redmine 发送前核验当前账号及工单当前项目。发送成功和结果未知的来源回声分别保存为 self_echo 和 self_echo_candidate，旧账本仍须经过原对账接口处理。内置入站提交前会省略空的 uncertain_mentions，避免共享入口把空数组判作歧义；有实际条目的数组原样保留。

### 离线复验

Windows x64、Node 24.22.3 的传输和 Host 回归覆盖管理员启停、游标、绑定账号、原消息、独立收件与故障恢复。存储及跨实现回切的独立命令见 `packages/storage/CONTRACT.md`。

从独立工作树根目录用 PowerShell 运行。所有收件、账号、工单、DWS、数据库与 Host 都是测试进程自己的临时数据。

```powershell
$node24 = (Get-Command -All node | Where-Object Source -like '*CodexPrimaryRuntime*' | Select-Object -First 1).Source
& $node24 --import ./packages/runtime/test/register-windows-job.mjs --test packages/storage/tests/storage.spec.ts apps/server/src/deliveries/tests/http.spec.ts apps/server/src/deliveries/tests/stage2.spec.ts packages/channels/tests/transport.spec.ts
& $node24 node_modules/typescript/bin/tsc -p apps/server/tsconfig.json --noEmit
& $node24 node_modules/vitest/vitest.mjs run --config vitest.config.ts --configLoader runner --no-cache apps/server/src/deliveries/tests/source-image.test.ts
```

阶段 2 通过临时 Host 的真实 HTTP 和独立收件端验证单次自动投递、人审、静默、过时、跨版本、重新发布和重启。附件覆盖 Redmine 下载失败、管理员重试和版本失效，以及 DWS 原私聊资源清单与会话不匹配。计费测试在临时目录编译只响应本地协议的程序，检查零预算时的实际 turn 数、非零预算的单条预留和人工结算。群目录使用真实受管子进程，检查两页参数、超时后进程退出及在途停用。正式账号、飞书公网入口和供应商真实用量仍需现场验证。
