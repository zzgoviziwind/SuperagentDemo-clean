# Windows TypeScript 重写进度

基线 `7b7587d14399659d7951d3e195af863514fbf118`。独立分支 `codex/typescript-windows-rewrite`。原 main 与此基线相同。另一会话工作树中的 19 个已跟踪文件有变动，另有 WP1、WP2、WP3 和现场记录源码、测试及文档。冻结的 346 个文件位于本工作区 `.rewrite-oracle`，逐文件 SHA-256 在 `oracle.json` 中，集合指纹 `abf0a6922e8da03d65cd53458df256a509d824c3fbf276f58943cc800201b091`。原根目录数据库大小为 0 字节。独立验收需另建有内容的合成旧库。

| 关口 | 状态 | 接续工作 |
| --- | --- | --- |
| 0 行为冻结 | 通过 | 两轮各 44 次进程内 HTTP，35 张旧表迁至 43 张表，附件和账本非空。另用真实 uvicorn 进程分别跑默认与 WP 模式，重启保留 unknown。见 `tests/rewrite-acceptance/RESULTS.md`、`uvicorn-results.json`。静态清单与 OpenAPI 同为 119 项 |
| 1 安装和业务闭环 | 执行中 | Fastify 实际处理已授权 Redmine 来信，进程内 HTTP 重放只建一条任务，关闭重开后工作台组索引可读。待浏览器、进程强杀、独立收件计数及安装验证 |
| 2 行为移植 | 待完成 | 按清单逐项联通，保持默认模式与历史数据可读 |
| 3 差分与故障 | 待完成 | 两端复跑、抽查落库与副作用次数 |
| 4 交付 | 待完成 | 干净机、同库回滚、候选包签收 |

总控负责 HTTP、鉴权、集成及发布判断。执行存储、运行时渠道、工作台分发、独立验收分别维护指定模块。工作台读写接口与 Windows 进程安全复核单独并行。只使用隔离端口和合成数据。首次核查发现旧方案中“WP2 暂停”已经过时，WP1–3 的模式与交接已纳入基准。历史测试报告中的结果只用于定位场景。

### 集成记录

- 初次独立进程树复核在 Node 22、24 均发现三种路径留下末级工具进程，见 `tests/rewrite-runtime-review/REVIEW.md`。Windows Job helper 已加入开发构建，待同一套负例与 Host 层复测。此问题阻断分发。
- 工作台任务详情与产物历史访问按当前真实 owner 检查。安全裁决为 admin 或归属 member 可读，旧 local-admin 行沿用已保存的治理归属；viewer 及其他成员禁止跨用户浏览。验收方已收到该变更。
- 可重建的 Python 对照包为 `.deps/rewrite-oracle-abf0a692.zip`，SHA-256 为 `8d4998ae4c48b255b0963a2139b54fb7b8bdea6924f31ce35da6432e2c243229`。用 `python deploy/rewrite/oracle_bundle.py restore <zip>` 可逐文件验证并恢复。安装试样位于 `deploy/windows-ts/.artifacts/actual/packages/`，正式发布判断待全部关口证据。
