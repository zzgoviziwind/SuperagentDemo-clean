# 事件工作台 v5 独立验收

日期：2026-11-14。

## 架构依据

核对本机保存的 DeepSeek 原文（D:/myfiles/daily/daily/00-Inbox/SuperAgent.md），忽略 %% 注释区：2.1 原型采用单常驻 Router Session 与批处理，同时允许 Router 层内部多会话和确定性逻辑；3.2 订阅命中直通 Worker，越界交回 Router，Thread 与 Worker 多对多。本项目每事件判定线程＋项目持久讨论是实现变体，不等于原文单常驻批处理，未验证自动压缩。

## 已验证

- 独立前端完整测试：12 文件、61 项通过（2026-11-14 15:12）。首轮发现两处旧交互断言失败，前端已修复并复跑。
- 新增独立负向验收 tests/e2e/test_coordination_acceptance.py：7 项通过，覆盖完成、取消、结果未知、运行中、来源无权限、来源不匹配、申请后版本变化；均确认没有创建投递且申请仍待处理。
- 要求补齐申请应用按钮，已由前端完成，含冲突显示测试。

## 边界

CUA 无可用浏览器或原生应用：iab unavailable；库存 apps=[]、browsers=[]，原生 app-server 启动报系统找不到指定路径。因此浏览器视觉、节点真实点击和真实 Codex 工具展开未完成，不以组件测试代替现场验收。

上述测试使用隔离 SQLite 与模拟身份，不向真实钉钉、Redmine 外发，不改业务数据库。未捕捉来源仅登记待获取，尚无自动拉取闭环；关联为追加来源并保留原任务，并非删除/合并原任务。Worker 自动调用 Router 调配工具未验证。

完整后端测试正在执行，最终结果待总控补记。

独立预览已重启并HTTP核验：http://127.0.0.1:8876 首页200；事件1 trace返回新增架构/来源/关联字段；scheduler/router/semantic/external_delivery均false。未进行真实渠道或模型执行。

完整后端独立验收最终结果：445 passed，2 skipped，67 subtests passed，耗时319.44秒。命令 .venv/Scripts/python.exe -m pytest tests -q --basetemp .pytest-v5-independent-full。此运行收集后才新增的7例负向验收另计，已独立通过。唯一警告为既有Starlette/httpx弃用提示。
