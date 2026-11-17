# 后端治理交付

> 总控最新结论：本文件按时间保留模块开发记录，后续真实 Codex、渠道、浏览器及最终回归结果见 [总控验收报告](../验收报告.md)。历史未验收说明不覆盖该报告。

## 文件与启动集成

本会话仅修改 `superagent/core/governance.py`、`superagent/api/governance.py`、`tests/governance/` 和本交付记录。未提交 Git。

总控在 `main.py` 启动前导入 `superagent.api.governance.router`，再 `app.include_router(router)`，导入会注册新表，现有 `init_db()` 自动创建。删除 main 原有 `/settings`、`/auth/me` 重复路由。

HTTP middleware 使用 `authenticate_request(request)`，把返回值写入 `request.state.principal`。`HTTPException` 在 middleware 中需显式捕获并返回 `JSONResponse({"detail": exc.detail}, status_code=exc.status_code)`，不能直接抛给最外层。

免鉴权访问路径包括 `/health`、静态前端和 `POST /api/v1/auth/login`、`POST /api/v1/auth/logout`。后两者自身校验 Origin，登录校验令牌。其他 `/api/v1` 必须验证身份。路由模块自身也有 Depends 校验，不能依赖前端隐藏按钮。

## 登录与身份

- `SUPERAGENT_API_TOKEN` 对应 `admin` 用户和 admin 角色，兼容旧单用户测试。
- `SUPERAGENT_USERS_JSON` 为 JSON 数组，每项有 `user_id`、`role`、`token`，role 为 admin/member/viewer。值只从环境变量读取。重复 ID、重复 token、非法角色和空配置数组均导致 503，拒绝降级。与单用户令牌的角色冲突拒绝启动鉴权。
- `POST /api/v1/auth/login` 请求 JSON `{"token":"环境变量配置的令牌"}`，返回当前用户，不回显令牌。无效请求手工返回错误，避免输入回显。前端可直接 POST，不把令牌保存在 URL 或浏览器存储。
- 登录设置 `superagent_session` HttpOnly、SameSite=Strict cookie，路径 `/api/v1`，有效期 3600 秒。远程网页登录要求 HTTPS，并设置 Secure。仅回环开发 HTTP 可使用无 Secure 的 cookie。
- cookie 仅含用户 ID、到期时间、随机 nonce 和凭据 HMAC 指纹，并有签名。每次验证重新核对当前凭据指纹和角色，令牌轮换或删除立即失效，角色变化立即生效。默认进程随机签名密钥，进程重启会话失效。多进程部署需共享环境变量 `SUPERAGENT_SESSION_SECRET`，至少 32 字节。
- `POST /api/v1/auth/logout` 清除 cookie，校验 Origin。签名会话的已复制副本在剩余有效期内仍可验证，令牌轮换可以立即吊销该凭据的全部会话。
- 登录、退出及 cookie 写请求校验同源 Origin。开发前端跨端口时显式设置 `SUPERAGENT_ALLOWED_ORIGINS=http://localhost:5173`。该配置不替代应用 CORS 配置，Vite 同源代理无需额外配置。代理 TLS 终止时由服务器配置受信代理，模块不自行相信任意转发请求头。
- `GET /auth/me` 返回 `user_id`、`role`、`authentication`。Bearer 继续可用，存在 Authorization 时不回退 cookie。
- 未配置令牌，仅回环客户端及 localhost/127.0.0.1/[::1] Host 允许开发身份，同时拒绝外部 Origin，防 DNS rebinding。`testclient` 仅用于进程内测试。
- `/identities` GET/POST/PATCH、DELETE `/{id}` 仅管理员。DELETE 禁用并保留历史。`resolve_actor(source, actor_id)` 返回 `{user_id, role, source, actor_id}` 或 None，移除用户配置后映射自动失效。
- 身份映射还持久化 `project_ids` 和 `permissions`，请求例为 `{"source":"dingtalk","actor_id":"外部标识","user_id":"已配置用户","project_ids":[1],"permissions":["request"],"enabled":true}`。必须由管理员显式授予现有项目 ID 和 request 权限。默认列表为空，历史映射默认无权限。权限存储为独立新表，现有 identities 表无需新增列。GET/写入响应及 resolve_actor 都包含这两个字段。PATCH 是完整替换映射，省略授权列表会清空授权。

## API 权限接线

`require_permission(principal, action, owner_id=None)` 拒绝未知 action。admin 可执行已知动作，member 可创建任务及修改自己负责的任务，viewer 仅只读。历史任务无负责人时 member 修改失败，需管理员明确分配。

| API | action |
| --- | --- |
| 任务/项目/产物/审批/概览读取 | read 或 task.read/project.read/artifact.read/approval.read |
| 项目创建和修改 | project.write |
| 任务创建 | task.create |
| 任务消息、控制、验收 | task.message、task.control、task.accept |
| 审批决定 | approval.decide |
| 事件人工注入 | event.inject |
| 任务负责人调整 | task.assign |
| 接入配置修改、启停、人工轮询、测试发送 | settings.write |
| 接入状态读取 | connector.read |

main 的任务修改及审批路由先在同一事务读取任务，再用实际 `task.owner_id` 调 require_permission。任务创建将 principal.user_id 写入 owner_id。连接器创建用 resolve_actor 的 user_id，不能采用消息正文中自报的身份。外部 member 事件同样要验证任务负责人。viewer 外部事件不可触发写动作。

`assign_task_owner(task_id,user_id,actor,session=...)` 与 `task_owner(task_id,session=...)` 支持 db.Task.owner_id。旧模型缺少该列时使用 governance_task_owners 表作为兼容。优先使用 db.Task.owner_id 为统一来源。

迁移给历史任务 owner_id 填入 local-admin 时，task_owner 优先保留已有 TaskOwner 的显式分配，避免历史负责人丢失。当前 ingestion 创建任务已明确写入 actor 的 owner_id，并保留 TaskOwner 分配，前端负责人字段与权限读取一致。此交付没有跨范围修改 ingestion。

设置和身份更改自动记录审计。main 的其他写操作可在其事务调用 `audit_action(session, principal, action, resource, details)`，details 仅接受结构化任务、版本、状态字段，避免原始正文或凭据进入审计。管理员可 GET `/api/v1/audit?limit=100`，上限 1000。

## 持久设置

`get_setting(key,default=None)`、`set_setting(key,value)`、`settings_snapshot()`、`update_settings(values,actor=...)`。PATCH 批量先验证再单事务写入，未知字段拒绝，所有秘密须环境变量配置。

允许字段为 external_delivery_enabled、scheduler_enabled、max_concurrent_tasks（1–4）、dingtalk_enabled、redmine_enabled、budget_hard_limit_micros、budget_reservation_estimate_micros、codex_model、codex_effort、connectors.dingtalk、connectors.redmine。布尔字段不接受字符串，金额为非负整数微单位或 null。默认关闭接入、发送及调度。

### 前端配置契约

正规 PATCH `/api/v1/settings` 支持下例。点号是 JSON key 的一部分，连接器对象完整替换。GET 返回同样字段。api_key_env 仅保存环境变量名称，真实密钥不读取进响应和审计。

```json
{
  "scheduler_enabled": false,
  "max_concurrent_tasks": 1,
  "codex_model": "gpt-6.1-sol",
  "codex_effort": "medium",
  "budget_hard_limit_micros": 10000000,
  "budget_reservation_estimate_micros": 500000,
  "connectors.redmine": {
    "enabled": false,
    "base_url": "https://redmine.example",
    "project_ids": [7],
    "user_id": 12,
    "api_key_env": "HLZJ_REDMINE_API_KEY",
    "poll_seconds": 30,
    "initial_since": "2026-11-13T00:00:00Z",
    "account_map": {"alice": [12]}
  },
  "connectors.dingtalk": {
    "enabled": false,
    "executable": "dws",
    "profile": "work",
    "self_ids": ["当前账号外部ID"],
    "kind": "at-me"
  }
}
```

- Redmine project_ids 为 Redmine 项目正整数 ID，user_id 为接收者在 Redmine 的正整数 ID。account_map 是 @login 到用户 ID 数组。与治理身份授权中的本地项目 ID 分别使用对应系统 ID。
- poll_seconds 范围 1–86400。initial_since 需要带时区的 ISO 时间。base_url 禁止用户名密码、query 和 fragment。未知字段、明文 api_key、秘密参数均拒绝。
- 钉钉 kind 可为 at-me 或 group，group 必须明确 chat_id，at-me 省略 chat_id。executable 可为路径字符串或命令数组，禁止凭据参数。启用时必须有 executable/profile/self_ids。
- 钉钉可配置 history 对象，字段为 chat_ids、initial_since、history_timezone、sender_map、page_limit、timeout。使用连接器模块共享 validate_configuration 校验。chat_ids 必须明确限定范围，group 模式须与 chat_id 一致。initial_since 为起始时间，history_timezone 指明历史时间所属时区（例如 +08:00），sender_map 把历史 sender ID 映射到外部 open ID。page_limit 为 1–40，timeout 为 1–300 秒。已验证通过正式 PATCH /settings 保存后 GET 与真实 ConnectionManager 读取一致，保存不会启动真实账号。
- dingtalk_enabled/redmine_enabled 保留兼容，PATCH 时会原子更新对应 connectors 对象的 enabled 并保留其他配置。和完整对象同时给出矛盾值返回 422。新界面直接使用 connectors 对象。
- codex_model 默认 gpt-6.1-sol，codex_effort 默认 medium，支持 low/medium/high/xhigh/max/ultra，null 表示继承运行时。字段统一为 codex_effort。codex_reasoning_effort 属于未知字段并返回 422。总控需确保 scheduler 也读取 codex_effort。
- ConnectionManager 原有 get_config 读取 connectors.redmine/connectors.dingtalk，现已与持久设置匹配。保存配置后通过已有 start/stop API 重启对应连接器，当前连接器不会因保存设置自动重建进程。未保存持久配置时 GET 可以显示经过校验的 SUPERAGENT_REDMINE_CONFIG / SUPERAGENT_DINGTALK_CONFIG 环境配置，非法或含秘密 URL 的配置不回显。
- 模型及 effort 只验证配置格式。模型对特定 effort 的实际支持应由本机 app-server 的 model/list 返回值验证，管理界面可展示后端提供的动态能力。官方文档明确模型列表包含 supportedReasoningEfforts，不能把本地枚举当成每个模型均支持。[OpenAI App Server](https://learn.chatgpt.com/docs/app-server)

## Scheduler 预算接线

金额均为账户币种的整数微单位，1000000 表示 1 币种单位。`None` 表示不限额，`0` 是硬限制为零。不得用 0 表示未知成本。

1. 管理员 PATCH `/api/v1/budgets/global`，请求 `hard_limit_micros` 和 `currency`，或调用 `configure_budget("global", limit, currency="USD")`。GET `/budgets` 仅管理员。修改全局账户和 settings 的 budget_hard_limit_micros 会在同一事务双向同步。账户未配置时 reserve 拒绝执行。
2. 每个执行回合开始前调用 `reserve_budget(account_id, request_key, estimate_micros, estimate_basis, task_id=None)`。request_key 必须持久绑定唯一执行尝试，可用 task ID + revision + control_version + turn attempt。相同标识、相同参数返回原预留，参数变化返回 409。已结算请求返回原记录，调用方不得将其当成新执行授权。
3. estimate_micros 必须来自明确的 token/价格或人工预算预留依据。硬预算拒绝未知及零估算，额度不足返回 409，任务应转 waiting_resource。预留采用数据库原子条件 UPDATE，并锁账户串行处理幂等键，避免多个 worker 同时透支。
4. 有真实 usage 和价格依据才调用 `settle_budget(reservation_id, actual_micros, usage)`。usage 允许 input_tokens/output_tokens/total_tokens/cached_input_tokens/pricing_version/source/model。不可写原始请求、令牌和任意模型正文。结算原子释放预留、增加真实用量，重复结算幂等，冲突用量返回 409。实际高于估算仍按真实值记账，后续准入被阻止。
5. 缺失 usage、启动中断或未知结果调用 `settle_budget(reservation_id)`，状态 unknown 并保留预留，不宣称费用为零。已确认未启动的回合，可用真实零消耗证明结算 actual_micros=0，并附 source/pricing_version 等结构化依据。unknown 后收到真实 usage 可再次结算。重启后不能自行清空预留。

管理员可 GET `/api/v1/budget-reservations?account_id=global&status=unknown&limit=100` 查询预留。status 可选 reserved/unknown/settled，limit 为 1–1000。返回预留 ID、任务 ID、估算金额与依据、实际金额、usage、状态和时间。actual_micros 为 null 时界面应显示待对账。

POST `/api/v1/budget-reservations/{id}/reconcile` 仅管理员，请求为 `{"actual_micros":60000,"evidence":"供应商账单或确认未执行的证据"}`。金额为账户币种整数微单位，依据非空且最多 2000 字符。服务器原子结算并记录操作者及依据，重复同金额同依据幂等，不同金额或依据返回 409，不能重复扣款。明确零消费需要人工提供依据。

前端文案需说明预算预留是估算，Codex 套餐可能不回传实际费用。无法确认实际费用时保留 unknown，不把预留估算作为实际消费。人工对账不可从模型自然语言推算价格。

硬限制约束已花费加预留的准入，不保证供应商实际费用不超过预估。若要求真实消费不超过限额，需要执行器及供应商侧支持 token 上限与可靠计价，当前 Codex usage 未提供费用时应保留 unknown。

## 验证

使用项目 `.venv`，TEMP/TMP 指向 `data/test-tmp`。测试只用独立临时 SQLite 和进程内 API，无真实账号访问。

最终运行 35 项全部通过（8.19 秒），包含网页登录、cookie 篡改与过期、HTTPS、Origin、角色实时变化和凭据轮换。真实跨模块测试直接使用 governance 身份映射与 ingestion.ingest_event，覆盖默认无授权、缺 request、合法项目授权成功建任务、viewer 降权拒绝和未知项目拒绝，没有 mock actor 数据。Windows 受限环境的事件循环在创建回环 socketpair 时阻塞，经允许本地连接后执行正常。并发预算测试覆盖 24 次争抢、相同预留重复、16 次重复结算、未知用量占额、超限与币种切换拒绝。SQLite 结果不代表 PostgreSQL 并发验收。

建议总控合并后运行 `python -m pytest tests/governance -q --basetemp data/test-tmp/governance-final`，并补 main 路由的 member/viewer 跨任务越权验收。真实 Codex usage 定价和 PostgreSQL 并发待联调。

2026-11-13 配置及人工对账补充验收共 59 项通过（9.82 秒）。新增测试以正规 PATCH /settings 保存配置，并通过真实 ConnectionManager 验证读取一致，覆盖秘密 URL/明文 api_key/错误类型拒绝、兼容启用字段同步、模型默认值和人工对账的权限、审计、重复提交、冲突结算及一次扣款。最终命令为 `python -m pytest tests/governance -q --basetemp data/test-tmp/governance-config-verified`。

当前核对 scheduler.py 与 settings_snapshot 均统一读取 codex_effort，模型配置只有 codex_model/codex_effort 一组字段。scheduler_enabled/max_concurrent_tasks/预算字段已见调度器通过 settings_snapshot 读取。此前记录的调度器旧字段与 ingestion 负责人集成项均已修正。本会话只修改治理所有权文件，治理新增特性已冻结。

最终交接回归执行 `python -m pytest tests/governance tests/review/test_review_races.py -q --basetemp data/test-tmp/governance-history-final`，共 64 项通过（13.25 秒）。新增正式接口 history 配置联通测试同时检查 settings_snapshot 字段集合、codex_effort 默认值及旧名称缺席。测试未启动真实连接器。现有 Starlette/httpx 测试依赖有一条弃用警告，测试结果通过。PostgreSQL 并发与真实外部联调仍按前述范围待验收。
