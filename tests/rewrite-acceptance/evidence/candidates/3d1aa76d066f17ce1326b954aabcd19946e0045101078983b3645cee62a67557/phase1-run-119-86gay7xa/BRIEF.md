# Windows RC2 最终 ZIP 复验简报

119 个方法与路径已在冻结 Python 基线和 ZIP 内 TS 服务完成回放。回切及回切后接管通过，串行严格比对有 40 项待裁决，暂缓全量等价签收。

## 输入与范围

版本 0_2_0-rc2-0fa9b3e。外层 ZIP SHA-256 为 bf4593ef65608835c766b43349ba8fdfea5a14609472fe1cd47a7f22da48c9dc，与指定值相符。使用包内 Node v24.22.3，完整 dist 共 7 个文件。Node 与 dist 文件散列均已和包清单核对。两端使用回环地址、隔离 SQLite 和合成账号、事件及附件。结果限于手册覆盖的接口和回切路径。[实包来源与指纹](package-input.json) · [运行记录与底库指纹](serial/run.json)

## 串行分类

59 个读入口和 60 个写入口，每侧各 238 次请求。首次两个 Python 服务就绪超时，沿用原底库与快照，仅补跑未完成组。严格模式在归档完整分类后返回 1。[首次超时](serial-first-attempt.json) · [逐路由分类](serial/REPORT.md) · [请求、响应与副作用](serial/observations.json)

|分类|项数|
|---|---:|
|业务抽查通过|4|
|业务抽查通过，响应头有差异|67|
|字段或持久记录差异|32|
|行为差异|6|
|服务错误|1|
|副作用不符|1|
|协议拒绝通过|2|
|前置条件拒绝|4|
|按约定由 Python 承载|2|

六项行为差异涉及钉钉单群查询、群列表、同步本人群、手动巡检、巡检消息及会话对账。项目更新负例在 Python 返回 500、TS 返回 422，两端正例均为 200。附件重试两端均返回 200，均缺预期的 event_attachment_jobs 记录，停服后均为 failed 且结果为空。[字段与状态码](serial/classification.json) · [附件停服后回读](serial/attachment-after-stop.json)

## 并发与回切

逐路由 4 客户端并发，每侧 476 个响应。Python 的 POST /subscriptions 出现 1 次 500，同组另 3 次为 200。TS 的 8 次 503 全部来自约定由 Python 承载的 daemon poll 和 exchange。两侧模拟渠道收件均为 0。第二个 TS 控制器被拒绝，原租约持有者与 epoch 保持一致，原服务健康检查返回 200。[并发响应与租约](load/load119.json)

混合并发每侧 36 次请求。12 次同键事件提交识别出 11 次重复，每侧仅新增 1 个任务，数据库完整性检查通过。[Python 混合并发](serial/burst-python.json) · [TS 混合并发](serial/burst-ts.json)

有效租约期间回切被拒绝。停服后，备份保留模型运行 running 和桥接操作 pending，主库两条记录均转为 unknown。Python 在同一数据库文件回读任务和巡检记录成功。注入残留 pending 时，回切命令返回失败；解除模拟阻碍后重试成功，Python 接管 poll 和 exchange 均返回 200。[备份与主库状态](recovery/recovery.json) · [残留拒绝与接管](postcheck/postcheck.json)

最终证据核验退出码为 0，覆盖 476 次串行、952 次逐路由并发及 72 次混合请求，共 1,500 次。回切状态匹配预期。本次仅生成验收记录，没有修改产品。
