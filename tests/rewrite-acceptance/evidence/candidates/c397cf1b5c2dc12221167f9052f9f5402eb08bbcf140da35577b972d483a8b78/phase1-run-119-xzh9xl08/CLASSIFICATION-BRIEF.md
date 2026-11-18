# C397 双端验收分类简报

**119 项均有冻结 Python 与 TS 的独立 HTTP 观测，未注册路由为 0。** 上一包的回切阻断和管理员审计 500 已关闭。严格兼容性检查仍有 40 项待裁决，其中 31 项是字段或持久记录差异、7 项是行为差异、1 项是附件重试、1 项是冻结 Python 的负例 500。主控宜先看路由历史能否解释当次选择、治理审计能否追溯初始归属和版本，以及禁渠道时的产品行为。[119 项逐路由状态](serial/REPORT.md) · [与 B328 对照](comparison.json)

## 119 项的分类依据

|验收类别|项数|本轮观察及解释|
|---|---:|---|
|正例业务与所采响应头一致|4|健康检查、产物下载、现场截图、任务导出。健康接口只对照应用状态，其余按用例核对实际返回内容。|
|正例业务一致，仅所采响应头不同|67|64 项由 TS 增加 `Cache-Control: no-store`。登录、注销两项的 cookie 属性顺序及 SameSite 大小写不同，注销时 Python 还给出 expires，两端均为 Max-Age=0。媒体读取一项以 filename 与 UTF-8 filename* 表达同一文件名。|
|字段或持久记录差异|31|合法输入均得到业务响应。下表按主要原因逐组列明，完整清单含 228 个规范化差异位置。|
|行为差异|7|3 项渠道读取、2 项未知结果的退出证明、2 项负例校验。具体条件见后表。|
|副作用不符|1|事件 100 重试时，Python 首次返回 pending，TS 已返回 failed 并给出 disabled。用例要求采到作业表变化，本次两端的采样窗口均未观察到该表行差。停机回读均为 failed，结果均为空数组。[附件终态](serial/attachment-after-stop.json)|
|服务错误|1|给 `PATCH /projects/2` 提交整数 `allowed_paths=42`，冻结 Python 返回 500，TS 返回 422。两端合法改名均为 200。|
|前置条件拒绝|4|两端均 409。分别为无可用本机账号、历史工具审批没有活跃轮次，以及关闭语音识别时上传媒体和重试。仅验证了拒绝分支。|
|协议拒绝通过|2|MCP 的 GET、DELETE 在鉴权后均返回 405、空正文及 `Allow: POST`。|
|约定由 Python 承载|2|daemon poll、exchange 在 TS 返回 503，声明 `execution_host=python`，未写业务表。回切后同库 Python 实际处理两次合成签名请求并保存两条 nonce。[同库承接](postcheck/postcheck.json)|

## 31 项字段或持久记录差异

入口均省略 `/api/v1`。每个入口只按一个主要原因计数。

|主要原因|项数|涉及入口、证据和裁决点|
|---|---:|---|
|本端新事件编号顺延|12|投递 decision、reconcile；事件组 delegations、resolution、following、rename；现场分析 implement；会话 coordination、coordination/apply；任务 acceptance、project、reconcile。TS 的启动恢复事件占用了 ID 109，任务创建样本的业务事件因此为 110，Python 为 109。这 12 项除所采响应头外仅有生成编号或关联编号差异。宜按本端回查关联判断。|
|初始归属或消息版本的审计信息减少|4|直接建任务和桥接建任务均从 `task.assign`、`details.user_id=admin` 变为 `task.create`、空 details。任务和 Worker 会话两个发言入口均少 `revision=1` 和 `state_version=2`。需确认历史归属与当次发言版本能否由稳定记录还原。|
|事件分派过程证据不同|2|注入事件和路由调度取得了业务结果。TS 的生命周期记录缺少部分过滤检查、设置快照、项目候选与选择依据；调度另增加审计行。需确认历史查询能否解释当时的决定。|
|能力声明、提示及工具 Schema 不同|4|provider 列表与 bridge/status 均少列 STDIO，仍声明 HTTP。codex-prompts 的模板正文、标题及渠道回复段落有差异。MCP tools/list 的说明和输入 Schema 不同，包括安全整数上界与可空类型写法。应以最终包实际提供的入口、工具校验及运行指令裁决。|
|重启使旧工具审批失效|2|审批 1 由 pending 变为 expired_on_restart；概览待办 ID 因此从 [1,3] 变为 [3]。这是同一个状态变化在历史列表和待办列表的两处表现。|
|能力与禁用原因的扩展字段|3|媒体作业列表新增语音模型未配置的 reason；现场整理器新增 `ocr=false`、`timeline=true`；节点声明新增 `execution_host=python`。本样本中媒体作业的对应状态、整理器 mode 已对齐。|
|离线评估拿到的证据不同|1|routing/assessments 两端均为 incomplete。TS 留下 fixture 的 thread、turn、decision 和审计，注明历史读取不可用；Python 返回 ValueError，缺少该模型轮次。真实历史证据链仍待实测。|
|重复纠正刷新时间不同|1|routing/jobs/correction 两端均为 ignored、`newly_applied=false`。Python 另更新路由作业的 updated_at，TS 本次未改该行。若更新时间用于轮询，需明确约定。|
|TS 新增治理或交接留痕|2|会话 handoff 的事件增加 actor、控制版本、状态版本，并更新任务时间。保存事件规则额外写 `event_rules.update` 审计，记录规则数，并更新设置时间。需裁决这些新增记录的历史查询语义。|

字段路径、数组位置、两端实际值和缺失键可在[完整字段对照](field-values.json)中逐项核对；[串行观测](serial/observations.json)同时保存全部 119 项的正例与负例。

## 7 项行为差异

|项数|入口与原因|Python / TS|
|---:|---|---|
|2|钉钉 group 和 groups。在连接器关闭时，冻结 Python 仍通过离线 DWS 替身查询，TS 先检查渠道启用状态。|200 / 409|
|1|事件组 sync-own-dingtalk。Python 完成空同步，新增 0 条；TS 明示该历史读取尚未接入。|200 / 409|
|2|巡检 messages 和 Router 会话 reconcile。Python 接受样本中的人工核验，TS 要求进程已经退出的证据，保持原未知状态。|200 / 409|
|1|任务 controls 的非法 action。Python 按冲突处理，TS 按输入取值无效处理；合法暂停均成功。|负例 409 / 422|
|1|watchdog/tasks/run 使用不存在的任务 ID。Python 返回冲突，TS 返回实体缺失；用有效 ID 的禁用样本两端均 409。|负例 409 / 404|

**并发与证据边界。** 四客户端下，冻结 Python 的同一订阅得到三次 500，同一协调请求键落了两条事件。TS 两项均只新增一条对应记录。两端假渠道收件均为 0。串行归档保留每侧 238 次请求的观测正文或按类型采集的内容摘要、响应头、数据库与托管文件变化；并发归档保留每次请求的状态、耗时、响应摘要、选定字段及每批持久变化。C397 并发时未采集完整响应正文。原有观测与分类按原样保留。[逐次并发观测](load/load119.json) · [混合回放 Python](serial/burst-python.json) · [混合回放 TS](serial/burst-ts.json) · [全部结果与复验命令](ACCEPTANCE.md)
