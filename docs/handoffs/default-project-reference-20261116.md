# 默认工作区与跨项目只读（2026-11-16）

- 本机主服务已将共享测试项目 #7 绑定到 D:\helian\hlzj-workspace\show，作为钉钉未识别请求的默认项目。三个子仓库的基线为 hlzj/main、web-physical-manage/智能主检-dev-integrate、interface/main。事件 #5 已追加归属纠正 #331；尚未把其旧工作区、执行线程和项目字段迁移到新项目。
- 新项目表单默认只读。允许项目内修改可直接选择；允许部分修改时才填写相对路径。验证命令、钉钉群 ID 和 Redmine 项目 ID 均可留空。默认工作区与只读资料范围各自独立。
- 项目新字段 reference_access 可选 workspace、projects、directories，默认 workspace。directories 使用 reference_dirs 指定明确的资料目录。只对管理员持有的只读分析开放。工作区外读工具使用 @refs/别名/相对路径；原工作区普通路径保持原行为，禁止绕过配置读取绝对路径、整盘、链接或敏感目录。获得跨目录上下文的事件保留结果供工作台查看，渠道回复被阻止。
- POST /api/v1/tasks/{id}/project 接收 project_id、expected_state_version、reason。仅管理员可对停止且无未知结果的事件换项目；历史消息、结果、执行记录保留，旧审批失效，旧项目的跟进订阅停用。下一轮建立独立新路径和线程。只读分析按指定分支的已提交内容准备工作区，无需覆盖或使用原目录未提交内容。
- 新功能尚未加载到本机主服务；本轮未停止服务，外部发送继续关闭。

## 主服务部署与 #5 实测

- 用户确认后重启 8765，数据库备份通过完整性检查，新前端资源 index-DSTBoil_.js 已由主服务提供。备份位于 deploy/backups/load-default-project-20261116-075410。
- 事件 #5 正式由项目 #2 改绑到共享测试 #7，换绑记录 #334；原消息、摘要和工作区保留为历史。新线程使用独立工作区 data/workspaces/5-p7-e334。
- 实际跨项目只读：此次运行捕获授权后，项目配置立即恢复为仅当前工作区。Agent 分别读了 show 的 hlzj/pom.xml 和德阳参照的 @refs/project-2/PROJECT_CONTEXT.md 前 15 行。报告 #37、验证 #39：两次读取都成功，未拒绝，未修改工作区，状态待验收。
- 外部发送保持关闭，发送账本仍为 4 条。未执行任何医院环境更改或报告重跑。
