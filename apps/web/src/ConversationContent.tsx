import { statusNames } from "./api";

type Row = Record<string, any>;
const reportLabels: Record<string, string> = {
  id: "编号",
  title: "事件名称",
  revision: "目标版本",
  input: "输入内容",
  goal: "事件目标",
  recent_results: "近期结果",
  subscriptions: "订阅关系",
  artifact_id: "产物编号",
  role: "消息角色",
  summary: "处理摘要",
  reason: "判定说明",
  action: "处理决定",
  kind: "工作类型",
  content: "来源消息",
  tasks: "候选事件",
  shared_state: "共享事件摘要",
  project_id: "所属项目",
  event_id: "来源事件",
  task_id: "目标事件",
  state_version: "事件版本",
  applied: "应用结果",
  status: "状态",
  findings: "发现",
  changes: "改动",
  tests: "验证",
  risks: "风险",
  limitations: "限制",
  next_steps: "后续步骤",
  conclusion: "结论",
  evidence: "证据",
  result: "结果",
};
const valueLabels: Record<string, string> = {
  ...statusNames,
  user: "用户",
  assistant: "助手",
  system: "系统",
  developer: "执行规则",
  create: "创建事件",
  dispatch: "关联已有事件",
  ignore: "忽略事件",
  confirm: "等待人工确认",
  reply: "回复消息",
  analysis: "只读分析",
  repair: "修改修复",
  observe: "持续观察",
  needs_human: "需要人工介入",
  pause: "请求暂停",
  passed: "通过",
  failed: "失败",
  blocked: "受阻",
  completed: "已完成",
  review_ready: "待验收",
  success: "成功",
};
function readable(value: unknown, field?: string): string {
  if (value == null) return "未记录";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (Array.isArray(value)) {
    if (!value.length)
      return (
        (
          {
            recent_results: "暂无近期结果",
            subscriptions: "暂无订阅",
            tasks: "暂无候选事件",
          } as Record<string, string>
        )[field ?? ""] ?? "无"
      );
    return value.map((item) => readable(item)).join("\n");
  }
  if (typeof value === "object")
    return Object.entries(value)
      .map(
        ([key, entry]) =>
          `${reportLabels[key] ?? key} · ${readable(entry, key)}`,
      )
      .join("\n");
  return valueLabels[String(value)] ?? String(value);
}
export function ConversationContent({
  content,
  variant = "record",
}: {
  content: unknown;
  variant?: "input" | "record";
}) {
  let report: Row | null = null;
  if (content && typeof content === "object" && !Array.isArray(content))
    report = content as Row;
  if (typeof content === "string" && content.trim().startsWith("{")) {
    try {
      const value = JSON.parse(content);
      if (value && typeof value === "object" && !Array.isArray(value))
        report = value;
    } catch {
      /* The response may be ordinary prose beginning with a brace. */
    }
  }
  if (!report)
    return <p>{typeof content === "string" ? content : readable(content)}</p>;
  const attachment = report.attachment_material;
  const hasAttachment =
    attachment &&
    (typeof attachment === "object"
      ? Object.keys(attachment).length > 0
      : String(attachment).trim().length > 0);
  if (Array.isArray(report.messages))
    return (
      <div className="conversation-report conversation-input">
        {report.messages.map((message: Row, index: number) => (
          <article className="execution-record" key={index}>
            <h4>{valueLabels[message?.role] ?? "消息"}</h4>
            <ConversationContent
              variant="input"
              content={
                Array.isArray(message?.content)
                  ? message.content
                      .map(
                        (part: Row) =>
                          part?.text ?? part?.content ?? readable(part),
                      )
                      .join("\n")
                  : (message?.content ?? message)
              }
            />
          </article>
        ))}
        {hasAttachment && (
          <div>
            <h4>附件内容</h4>
            <p>{readable(report.attachment_material)}</p>
          </div>
        )}
        <details>
          <summary>查看原始输入</summary>
          <pre>{JSON.stringify(report, null, 2)}</pre>
        </details>
      </div>
    );
  const entries = Object.entries(report).filter(([key]) => key in reportLabels);
  return (
    <div className="conversation-report">
      {entries.length ? (
        entries.map(([key, value]) => (
          <div key={key}>
            <h4>{reportLabels[key]}</h4>
            <p>{readable(value, key)}</p>
          </div>
        ))
      ) : (
        <p>
          {variant === "input"
            ? "可展开原始输入核对完整内容。"
            : "已保存一份结构化代理报告，可展开原始记录核对。"}
        </p>
      )}
      <details>
        <summary>
          {variant === "input" ? "查看原始输入" : "查看原始报告"}
        </summary>
        <pre>{JSON.stringify(report, null, 2)}</pre>
      </details>
    </div>
  );
}
