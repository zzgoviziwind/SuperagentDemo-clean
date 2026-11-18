# 独立评审 Prompt

把下面整段粘贴给新的评审 Agent。方案地址已写在 Prompt 内。

```text
你是独立架构评审 Agent。请对《SuperAgent TypeScript 重写方案（独立评审稿）》做一次对抗性评审，不要执行方案、不要修改仓库、不要提交。

【方案地址（必须先完整阅读）】
E:\Workspace\Workspace\Project\SuperAgentDemo\.handoffs\2026-11-18-typescript-rewrite\PLAN.md

【仓库与基线】
仓库：E:\Workspace\Workspace\Project\SuperAgentDemo
分支：main
基线：7b7587d14399659d7951d3e195af863514fbf118
注意：当前工作树有另一个会话未提交的 WP1（execution attempt/lease）与 Field Intake 改动，WP2 暂停。你只读；不要 git checkout/reset/clean/commit/push，不要改任何源码或文档。

【必读材料】
1. 上面的 PLAN.md 全文（含附录）
2. AGENTS.md、docs/实施基线.md、docs/接口契约.md
3. docs/handoffs/T1-RELEASE1-WP1.md
4. 关键代码（按 PLAN 附录 A）：scheduler.py、execution.py、delivery.py、connections.py、ingestion.py、capabilities.py、local_agents.py、api/sessions.py、runtime/codex.py、runtime/workspace.py、runtime/evidence.py、main.py
5. 如需要，读评审材料目录：
   C:\Users\examp\.codex\visualizations\2026\11\17\01a1e8cb-6407-76c1-b689-c8a2d01fa7cb\architecture-review-20261118\independent-review-20261118\

【你的任务】
1. 核实事实：自己数 LOC、文件数、测试数、git 历史、未提交改动；不要相信方案里的数字。指出任何与仓库不符的陈述。
2. 判断决策：在“6 天项目、12.5k 后端、9.4k 测试、1 个管理员、2 个真实任务”的前提下，TypeScript 重写是否优于“保留 Python + 进程插件”？给出量化理由，不要泛泛而谈。
3. 审查架构：模块化单体 + 六边形 + 进程插件是否合理？domain 边界、依赖方向、Host 独占不变量是否有漏洞？
4. 审查选型：Node 24 / Fastify 5 / Zod 4 / Drizzle / better-sqlite3 / SQLite lease / Vitest / Electron 是否是最优组合？指出明显更优的替代及代价。
5. 审查 parity：同 schema 迁移、Python oracle、conformance 场景、现有 Playwright E2E 能否防止回归？还缺哪些关键场景？
6. 审查范围：Parity 的“必须保留 / 延后 / 丢弃”是否漏掉真实用户可见行为？有没有把必要能力误删？
7. 审查工期：6–10 周是否可信？最可能超期的三个点是什么？
8. 审查安全：路径校验、凭据、插件信任、审批绕过、命令注入、Windows 进程树，最大的三个漏洞是什么？
9. 审查插件契约：source/agent 两类 + stdio JSON-RPC 是否过度设计？对 2 个渠道是否值得？v1 应该砍到什么程度？
10. 审查 Craft 判断：PLAN 否决 Craft Agents 作底座、Craft Anything 作迁移工具，这个判断是否成立？有没有更适合复用的部分？

【评审方法】
- 先读方案，再读代码；每个结论尽量带 `文件:行号` 或命令输出作为证据。
- 可以运行只读命令（git log/status、rg、pytest 只读用例）；如需跑测试，只用临时 SQLite/临时目录/假渠道，不接真实钉钉、Redmine、Codex 登录、生产库。
- 不要修改工作树；不要为了让测试通过而改代码。
- 区分“事实错误”“风险”“偏好”。不要用“建议进一步评估”这类空话。
- 如果方案的前提不成立（例如 6 天不实、测试不可用、WP1 未完成），直接指出并改变结论。

【输出格式】
# 评审结论
- 结论：proceed / adjust / reject
- 一句话理由
- 置信度（高/中/低）

# 事实核对
| 方案陈述 | 仓库证据 | 是否成立 |

# 关键问题（按严重度）
## P0（阻断）
- 问题、证据、影响、建议
## P1（重要）
...
## P2（次要）
...

# 对 10 个问题的回答
逐条回答，每条 2–5 句，必须带证据或明确说明“无法验证”。

# 工期与范围修正
- 你认为合理的 parity 工期（全职/兼职）
- 你认为必须砍掉/必须保留的范围
- 三个最可能超期的点

# 重写前必须验证的 5 件事
1.
2.
3.
4.
5.

# 如果只能给一个“停止重写”的理由
...
```

## 使用建议

- 让评审 Agent 在独立 worktree 或只读副本中运行，避免和当前 T1 会话抢文件。
- 如果评审结论是 `adjust`，先改 PLAN，再决定是否进入 W0，不要直接开始写代码。
- 如果评审结论是 `reject`，回到“Python + 进程插件”方案，重新估算 4–6 周。
