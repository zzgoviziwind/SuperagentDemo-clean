# Windows 本机渠道

Host 入口 `registerChannels(app,store,lease,root,env)` 可从 `packages/channels/index.ts` 或 `apps/server/src/deliveries/channels.ts` 导入。每个 Fastify 实例只创建一个管理器；投递入口会复用它。返回值的 `statuses()` 可直接用于 overview。接入器复用 `ingest(db,payload,env)`，提交收件完成后才推进 `connector_cursors`。真实传输在启用的本机服务中工作。fixture 模式仅使用临时文件收件器；preview 禁用本机渠道。

管理员通过原设置接口启用各连接器。显式 POST `/api/v1/connectors/:name/start` 或 `stop` 控制当前运行。GET `/api/v1/connectors` 返回管理器的实时状态。总控移交时删除 settings 中旧的 GET，保留 settings 配置读写；若先注册旧 GET，本模块为该响应提供实际状态。发送另需 external_delivery_enabled、对应渠道的有效审批、当前规则和来源目标。停止后再开启需要显式启动或重新启用该渠道。

- Redmine 需要 base_url、user_id、project_ids，密钥从 api_key_env 指定的环境变量读取。每轮先 GET /users/current.json 核对身份，按项目分页、读取 journals/attachments 元数据，在完整消费后提交重叠游标。每工单的语义指纹、序列及首次待确认输入复用原键。支持从匹配服务、项目和账号的持久 issue.updated 恢复语义。写评论经原两阶段账本，网络中断和 5xx 归入 unknown。
- DWS 使用管理员配置的 executable、profile、self_ids。精确绑定来源会话和原消息，私聊额外绑定原发送人。进程均以独立参数和 shell:false 启动。stderr ready 后开始收件。已配置历史的群和 @我监听仅在唯一绑定的会话内补收；私聊和无历史配置使用实时订阅。断线保留游标并报告降级。
- 受限飞书回调采用本机 POST `/callbacks/feishu/card`，接收签名的 AES-CBC 加密事件。只有 SUPERAGENT_FEISHU_ENABLED=1、SUPERAGENT_FEISHU_MODE=card 及 APP_ID、OPEN_ID、OWNER_ID、ENCRYPT_KEY、VERIFICATION_TOKEN 齐备时注册（字段统一加 SUPERAGENT_FEISHU_ 前缀）。密钥仅从进程环境读取。校验时间窗、原始字节签名、应用、操作人、已发送卡片 message_id、绑定 owner、动作类型与版本，随后交给现有 Worker 审批。该入口需要预存已确认的卡片记录；本切片覆盖回调接收与决定，不负责创建或发送卡片。Python 原接入为 SDK 长连接，该 HTTP 入口需要管理员单独配置投递路径。Host 只监听回环地址。

### 总控接入

```ts
const channels = registerChannels(app, store, lease, root, env);
// overview 请求处理期间实时调用，返回与 GET /api/v1/connectors 相同的数组。
const connectors = channels.statuses();
```

当前注册顺序为 settings、投递、工作台。settings 保留原 GET 期间，投递模块只替换该成功响应的内容；移除 settings 的 GET 后，渠道模块直接注册它。GET 和 overview 都可使用 `statuses()`。每个状态包含 enabled、configured、missing_configuration、warnings、status、last_error、last_seen。钉钉另含 scopes，每个范围独立显示就绪情况、最近接收和历史补收状态。

管理器将 `readOwnDingTalk(binding,signal)` 接入工作台的管理员私聊同步入口。若总控稍后集中设置 `configureWorkbenchRuntime`，应将该函数与其他运行时能力一同传入。它只读原会话、原对方及限定时间窗，以原消息确认锚点，并让工作台按唯一归属写入本账号的历史。Windows 下 DWS 复用项目的 Windows Job 子进程包，Host 关闭时先关闭订阅输入，再终止剩余的受管进程。分发包需保留既有 `bin/windows-job-x64.exe`。

Redmine 发送前核验当前账号及工单当前项目。发送成功和结果未知的来源回声分别保存为 self_echo 和 self_echo_candidate，旧账本仍须经过原对账接口处理。内置入站提交前会省略空的 uncertain_mentions，避免共享入口把空数组判作歧义；有实际条目的数组原样保留。

### 离线复验

2026-11-18 在 Windows x64、Node 24.22.3 上复跑通过 21/21（存储 12、Host HTTP 6、传输 3），耗时 43.4 秒。Host 严格类型检查通过。冻结 schema 另核对了 43 张表与 28 个显式索引，35 表旧合成库经两种实现迁移后 DDL 和原有行一致。

从独立工作树根目录用 PowerShell 运行。所有收件、账号、工单、DWS、数据库与 Host 都是测试进程自己的临时数据。

```powershell
$node24 = (Get-Command -All node | Where-Object Source -like '*CodexPrimaryRuntime*' | Select-Object -First 1).Source
& $node24 --import ./packages/runtime/test/register-windows-job.mjs --test packages/storage/tests/storage.spec.ts apps/server/src/deliveries/tests/http.spec.ts packages/channels/tests/transport.spec.ts
& $node24 node_modules/typescript/bin/tsc -p apps/server/tsconfig.json
```

HTTP 测试通过真实 Host 入口构建到临时目录，检查 Redmine 成功和 503 后的两条独立写入、原工单调离项目、实际账号不符、来源回声及游标，核对钉钉私聊发送参数、账号切换、额外历史读取和去重。传输测试覆盖分页中断、旧快照恢复、同一时间 A→B→A、群历史补收和飞书签名、身份、原卡、审批版本与重复点击。飞书 HTTP 测试另外验证带密文的挑战、篡改包、错误 token 及关闭开关。真实 DWS 账号返回形状、飞书平台到本机的投递与活跃 Worker 确认需要现场验证；只收到附件元数据的事件仍依赖附件处理模块。
