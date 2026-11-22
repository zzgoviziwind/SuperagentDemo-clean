import { useState } from "react";
import { request } from "./api";
import { reasonText } from "./InboxPanel";
import { eventStates, type EventState } from "./eventState";

type Row = Record<string, any>;
type Action = "close" | "create" | "link";

export function triageReason(reason?: string) {
  return ({
    attendance_notice: "例行考勤通知，无需处理。",
    acknowledgement_only: "仅确认收到，无需处理。",
    closed_manually: "人工确认无需处理，原消息已保留。",
    linked_manually: "人工关联为处理上下文。",
    semantic_ignored: "识别为无需处理的消息。",
    sender_reply_disabled: "此发送人未开启自动处理。",
    message_response_policy_off_or_scope: "消息不在自动处理范围内。",
    self_echo: "系统自己的回复，无需重复处理。",
    semantic_queued: "等待识别消息是否需要处理。",
    semantic_running: "正在识别消息是否需要处理。",
    project_suggested: "已找到可能的项目，请核对后安排处理。",
    project_needs_context: "现有资料不足，事件已登记，等待补充上下文。",
    project_no_project: "暂未发现项目归属，事件仍保留。",
    project_available_for_routing_review: "现在已有可匹配的项目，可以重新检查分派。",
  } as Record<string, string>)[reason ?? ""] ?? reasonText(reason);
}

function noticeText(status: unknown) {
  if (status === "disabled") return "飞书待研判提醒未启用，请在工作台处理";
  if (status === "sent") return "飞书提醒已投递";
  if (status === "failed") return "飞书拒绝了提醒，请在工作台处理";
  if (status === "unknown" || status === "sending") return "飞书投递尚未确认";
  if (status === "retrying") return "飞书提醒等待重试";
  return "飞书暂无投递记录";
}

export function EventTriage({ item, busy, onAction, onRetry, onManage, onError }: {
  item: Row;
  busy: boolean;
  onAction: (action: Action, ids: number[], options?: Row) => Promise<void>;
  onRetry: (id: number) => void;
  onManage: () => void;
  onError: (message: string) => void;
}) {
  const messages: Row[] = item.messages;
  const [picked, setPicked] = useState<number[]>(() => messages
    .filter(m => item.state === "closed" || m.state !== "closed").map(m => m.id));
  const [action, setAction] = useState<"create" | "link" | null>(null);
  const [options, setOptions] = useState<{ projects: Row[]; groups: Row[] }>();
  const [loading, setLoading] = useState(false);
  const [target, setTarget] = useState("");
  const [title, setTitle] = useState(() => messages[0]?.content?.trim().split("\n")[0].slice(0, 100) ?? "");
  const [goal, setGoal] = useState("");
  const [kind, setKind] = useState("analysis");
  const selected = messages.filter(m => picked.includes(m.id));
  const canClose = selected.some(m => m.state !== "closed");
  const canLink = selected.length > 0 && selected.every(m =>
    !["self_echo", "self_echo_candidate"].includes(m.data?.routing_status));
  const targetGroup = options?.groups.find(g => String(g.id) === target);
  const retryable = selected.length === 1 && selected[0].state !== "closed"
    && selected[0].data?.routing_status === "pending_confirmation";
  const assessment = selected.length === 1 ? selected[0].data?.project_assessment : undefined;
  const registered = item.event;

  async function choose(next: "create" | "link") {
    setAction(next);
    setTarget(next === "create" && assessment?.proposed_project_id
      ? String(assessment.proposed_project_id) : "");
    if (options) return;
    setLoading(true);
    try {
      setOptions(await request("/event-groups/triage-options"));
    } catch (error) {
      onError((error as Error).message);
      setAction(null);
    } finally {
      setLoading(false);
    }
  }

  return <section className="event-action-strip" aria-label="事件研判">
    <strong>{eventStates[(item.state ?? "triage") as EventState]}</strong>
    {item.state !== "closed" && <div className="event-close-action">
      <button disabled={busy || !canClose}
        onClick={() => void onAction("close", selected.filter(m => m.state !== "closed").map(m => m.id))}>关闭，无需处理</button>
    </div>}
    {item.state === "closed"
      ? <p>原消息已保留。如需处理，可手动新建事件或关联到已有事件。</p>
      : registered
        ? <p>事件 #{registered.id} 已登记 · 暂未分派项目或 Worker。</p>
        : <p>核对消息归属：可关闭无须处理的消息，或选定消息开始处理。</p>}
    {messages.length > 1 ? <fieldset className="event-triage-messages">
      <legend>选择要操作的消息</legend>
      {messages.map(m => <label key={m.id}>
        <input type="checkbox" checked={picked.includes(m.id)} onChange={e =>
          setPicked(previous => e.target.checked ? [...previous, m.id] : previous.filter(id => id !== m.id))} />
        <span>{m.content?.slice(0, 80) || `消息 #${m.id}`} · {eventStates[m.state as EventState] ?? "待研判"}
          {m.state === "triage" && <small className="triage-message-status">{triageReason(m.triage_reason ?? m.data?.routing_reason)}
            {Object.hasOwn(m, "triage_notice_status") && <> · {noticeText(m.triage_notice_status)}</>}</small>}
        </span>
      </label>)}
    </fieldset> : <p>{triageReason(messages[0]?.triage_reason ?? messages[0]?.data?.routing_reason)}</p>}
    {messages.length === 1 && item.state === "triage" && Object.hasOwn(messages[0], "triage_notice_status") &&
      <p className="muted">{noticeText(messages[0].triage_notice_status)}</p>}
    {assessment && <>
      <p>研判依据：{assessment.reason}</p>
      {assessment.missing_context && <p>需要补充：{assessment.missing_context}</p>}
    </>}
    <div className="actions wrap">
      {canLink && <>
        <button disabled={busy || loading} onClick={() => void choose("create")}>
          {registered ? "指定项目并安排处理" : "新建事件并关联消息"}
        </button>
        <button disabled={busy || loading} onClick={() => void choose("link")}>关联已有事件</button>
      </>}
      {item.state === "triage" && <details>
        <summary>检查自动分派</summary>
        <div className="actions wrap">
          <button onClick={onManage}>检查身份与项目配置</button>
          <button disabled={busy || !retryable} onClick={() => onRetry(selected[0].id)}>重新检查所选消息</button>
        </div>
      </details>}
    </div>
    {loading && <p role="status">正在读取可用项目与事件…</p>}
    {action && options && <form className="event-triage-form" onSubmit={e => {
      e.preventDefault();
      void onAction(action, selected.map(m => m.id), action === "link"
        ? { group_id: targetGroup?.id, expected_state_version: targetGroup?.state_version }
        : { project_id: Number(target), title, goal, kind });
    }}>
      <label>{action === "create" ? "所属项目" : "已有事件"}
        <select required value={target} onChange={e => setTarget(e.target.value)}>
          <option value="">{action === "create" ? "请选择项目" : "请选择事件"}</option>
          {action === "create"
            ? options.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)
            : options.groups.map(group => <option key={group.id} value={group.id}>#{group.id} · {group.title} · {group.project}</option>)}
        </select>
      </label>
      {action === "create" && <>
        <label>事件名称<input required maxLength={300} value={title} onChange={e => setTitle(e.target.value)} /></label>
        <label>处理方式<select value={kind} onChange={e => setKind(e.target.value)}>
          <option value="analysis">只读分析</option>
          <option value="reply">拟定答复</option>
          <option value="repair">修复问题</option>
        </select></label>
        <label>处理要求<textarea required maxLength={20000} value={goal} onChange={e => setGoal(e.target.value)} /></label>
      </>}
      <p className="muted">所选消息会作为处理上下文保存，不会成为自动回复的目标。</p>
      <div className="actions">
        <button type="submit" className="primary" disabled={busy || !canLink || !target
          || (action === "create" && (!title.trim() || !goal.trim()))}>
          {action === "create" ? "创建并开始处理" : "确认关联"}
        </button>
        <button type="button" disabled={busy} onClick={() => setAction(null)}>返回</button>
      </div>
    </form>}
  </section>;
}
