# 飞书私聊审批提醒

本文描述链接模式。直接在飞书中批准或拒绝，请见[飞书私聊卡片审批](feishu-card-approval-20261117.md)。

首版只提醒当前版本、仍由在线 Worker 等待的修复任务操作审批（文件修改、命令执行）。按任务负责人筛选，不发送普通进度、只读分析、回复草稿、交付验收、结果未知或过期审批。本次未改这些流程的人工判定规则，也未接通其他待决类别。

## 飞书后台

1. 在[飞书开发者后台](https://open.feishu.cn/app)创建企业自建应用，添加「机器人」能力。
2. 在权限管理开通应用身份权限「以应用的身份发消息」`im:message:send_as_bot`，应用可用范围只包含指定收件人，创建并发布版本，按组织要求完成审核。不需要配置事件订阅、回调或读消息权限。
3. 记录应用的 App ID、App Secret，并用该应用上下文获取收件人的 `open_id`。若没有收件人 ID，可在开放平台用该应用调试「通过手机号或邮箱获取用户 ID」，此查询可能需要额外权限；发送提醒本身无需保留通讯录权限。
4. 在 SuperAgent 启动进程的环境里设置 `SUPERAGENT_FEISHU_ENABLED=1`、`SUPERAGENT_FEISHU_APP_ID`、`SUPERAGENT_FEISHU_APP_SECRET`、`SUPERAGENT_FEISHU_OPEN_ID`、`SUPERAGENT_FEISHU_OWNER_ID` 与 `SUPERAGENT_FEISHU_WORKBENCH_URL`。负责人填工作台对应账号（例如 `local-admin`，以实际任务归属为准）。密钥只在本机凭据管理或受保护的启动环境中填写。
5. 工作台地址应为手机能够访问的受控 HTTPS 入口，不能填本机回环地址。链接只打开现有工作台，登录后定位审批；提交决定仍校验负责人、当前版本、操作哈希和执行会话。平台收到决定后由 Worker 继续处理。

飞书参考：[应用机器人](https://open.feishu.cn/document/client-docs/bot-v3/bot-overview)、[发送消息](https://open.feishu.cn/document/server-docs/im-v1/message/create)、[自建应用获取访问凭证](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/tenant_access_token)。

发送前持久化领取记录。同一审批不会在重复扫描或服务重启时重发。Feishu 明确拒绝与结果未知分别记录并写入服务日志；发送结果未知时不重发，排查对应记录后再核对。预览环境强制关闭真实发送。

真实私聊、移动端 HTTPS 入口及真实 Worker 审批仍需上线验证。本次没有向真实飞书账号发消息，也没有重启主服务。

本地验证：5 项后端专项与模拟 Worker 端到端回归通过（当前审批筛选、重复扫描、私聊消息格式、预览隔离、提交后续跑、旧版本失效）；工作台 22 项交互测试通过，包含从飞书链接定位审批和旧链接状态。测试发送器未请求飞书。
