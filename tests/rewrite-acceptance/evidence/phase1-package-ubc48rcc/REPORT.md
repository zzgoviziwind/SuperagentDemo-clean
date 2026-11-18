# RC2 草稿来源及阶段 1 实包复验

ZIP SHA-256 为 bf4593ef65608835c766b43349ba8fdfea5a14609472fe1cd47a7f22da48c9dc。使用包内 Node、服务依赖和网页，业务数据与回执均为合成数据。每轮从独立旧库开始。

| 样本 | 观察 |
|---|---|
| [原失败轮 HTTP](../rc2-phase1-20261118T155924Z/auto-1/http.json) 和 [原结果](../rc2-phase1-20261118T155924Z/auto-1/result.json) | bob 创建草稿一次，HTTP 200。admin 随后读到两条同正文草稿 2、3。该轮运行目录已清理，按原 attempt ID 未找到对应 SQLite，无法从原库逐条认定创建者。 |
| [原时序复跑](../rc2-draft-forensics-20261118T160438Z) | 三个独立合成库各有一条草稿；三次均为 bob 的 POST 返回草稿 2。各库仅有 reply_decision_input，未记录自动建稿。 |
| [复现双草稿的 SQLite 摘录](../rc2-draft-overlap-20261118T160719Z/wait-then-old-post/audit.json) 和 [手建响应](../rc2-draft-overlap-20261118T160719Z/wait-then-old-post/result.json) | 先等自动落库，再保留旧测试的任务验收与 bob 手建操作。对同一任务 2、来源事件 4，runtime 的 reply_decision 和 reply_draft_created 均指向草稿 2；bob 的成功响应指向草稿 3。审批 ID 分别为 3、4，业务 revision 均为 1，审批 control_version 分别为 1、2。 |
| [先验收后审批的实测](../phase1-package-omnqwa1v/round-1/http.json) | 仅有自动草稿 2。任务先验收后控制版本升至 2，草稿审批仍为 1，原审批提交返回 409。保留该轮 SQLite。 |
| [自动第一轮](round-1/result.json) 和 [第二轮](round-2/result.json) | 各轮 review_ready 后均读取唯一自动草稿，来源事件 4、正文“离线样例结果”、revision/control_version 均为 1，实际 attempt 对齐。零次手建，复用同一审批和 action hash 完成投递、强杀、人工对账及重放，再完成任务验收。修复任务及其审批、五份 Worker 与修复产物的 Python 同库回读均通过。 |
| [人工第一轮](../phase1-package-anj3dl4f/round-1/result.json) 和 [第二轮](../phase1-package-anj3dl4f/round-2/result.json) | 每轮 bob 仅创建一次，只有一条“离线人工草稿，核对收到”，无自动建稿事件。 |

四轮均由 admin 在浏览器完成对账，刷新显示“已回复”，页面错误为零。admin 和 bob 分别读到同一条草稿，alice 和 viewer 均收到 404。每轮最终假渠道回执 1 张，SQLite integrity_check 为 ok。四份最终库均已解压只读核对草稿、审批版本、事件与来源。每轮目录含 synthetic.sqlite.gz，可与对应 HTTP 记录和截图交叉核对。
