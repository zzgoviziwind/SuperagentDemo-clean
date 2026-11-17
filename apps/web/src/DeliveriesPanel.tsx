import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { request } from "./api";
import { ConversationContent } from "./ConversationContent";
import { Modal } from "./Modal";

type Row = Record<string, any>;
export type ReplyEdit = { eventId: string; content: string };
export const emptyReplyEdit: ReplyEdit = { eventId: "", content: "" };
type UpdateReplyEdit = (update: (current: ReplyEdit) => ReplyEdit) => void;

function replyTarget(event?: Row, target?: Row, channel = event?.source) {
  const data = event?.data;
  const meta = data?.metadata;
  if (channel === "redmine") {
    const issue = target?.issue_id ?? data?.issue_id;
    return issue == null ? "Redmine · 问题编号未显示" : `Redmine · 问题 #${issue}`;
  }
  if (channel === "dingtalk") {
    const conversation = target?.conversation_id ?? data?.thread_id;
    const name = meta?.conversation_title ?? meta?.chat_name;
    const recipient = target?.recipient_id;
    const destination = recipient
      ? `私聊 ${meta?.sender_name ? meta.sender_name + " · " : ""}${recipient}`
      : [name, conversation].filter(Boolean).join(" · ");
    return `钉钉 · ${destination || "会话标识未显示"}`;
  }
  return "原渠道 · 回复目标未显示";
}
export function DeliveriesPanel({
  taskId,
  events,
  approvals,
  artifacts = [],
  revision,
  taskStatus,
  outcomeUnknown = false,
  edit: sharedEdit,
  updateEdit: updateSharedEdit,
  controlVersion,
  canWrite,
  onChange,
}: {
  taskId: string;
  events: Row[];
  approvals: Row[];
  artifacts?: Row[];
  revision?: number;
  taskStatus?: string;
  outcomeUnknown?: boolean;
  edit?: ReplyEdit;
  updateEdit?: UpdateReplyEdit;
  controlVersion?: number;
  canWrite: boolean;
  onChange: () => Promise<void>;
}) {
  const editor = useRef<HTMLDetailsElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const dialogTitle = useId();
  const focusEditor = useRef(false);
  const [drafts, setDrafts] = useState<Row[]>([]);
  const [localEdit, updateLocalEdit] = useState(emptyReplyEdit);
  const edit = sharedEdit ?? localEdit;
  const updateEdit = updateSharedEdit ?? updateLocalEdit;
  const { eventId, content } = edit;
  const [replacement, setReplacement] = useState<ReplyEdit | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmId, setConfirmId] = useState<number | null>(null);
  const [reconciliation, setReconciliation] = useState<
    Record<string, { outcome: string; evidence: string }>
  >({});
  const load = useCallback(async () => {
    try {
      setDrafts(
        await request<Row[]>(`/tasks/${encodeURIComponent(taskId)}/deliveries`),
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }, [taskId]);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (!document.hidden) void load();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [load]);
  async function act(operation: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await operation();
      setNotice(message);
      await load();
      await onChange();
      return true;
    } catch (e) {
      setError((e as Error).message);
      await load();
      await onChange();
      return false;
    } finally {
      setBusy(false);
    }
  }
  const targets = events.filter(
    (event) =>
      ["dingtalk", "redmine"].includes(event.source) &&
      ["routed", "delivered"].includes(event.data?.routing_status),
  );
  const summaryArtifact = artifacts
    .filter(
      (artifact) =>
        artifact.kind === "summary" && artifact.revision === revision,
    )
    .at(-1);
  function summaryText() {
    const raw = summaryArtifact?.content;
    if (typeof raw !== "string")
      return typeof raw?.summary === "string" ? raw.summary : "";
    const text = raw
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "");
    try {
      const parsed = JSON.parse(text);
      return typeof parsed?.summary === "string" ? parsed.summary : "";
    } catch {
      return text;
    }
  }
  useLayoutEffect(() => {
    if (!focusEditor.current || replacement) return;
    focusEditor.current = false;
    if (editor.current) editor.current.open = true;
    input.current?.focus({ preventScroll: true });
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    input.current?.scrollIntoView?.({ block: "nearest", behavior: reduceMotion ? "instant" : "smooth" });
  }, [edit, replacement]);

  function applyReplacement(next: ReplyEdit) {
    focusEditor.current = true;
    updateEdit(() => next);
    setReplacement(null);
    setNotice("已填入编辑区，请核对目标和正文后保存。");
  }

  function replaceEdit(next: ReplyEdit) {
    if (content.trim() && (content !== next.content || eventId !== next.eventId)) {
      setReplacement(next);
    } else {
      applyReplacement(next);
    }
  }

  const deliveryBlocked = outcomeUnknown || taskStatus === "cancelled";
  return (
    <div>

      {error && (
        <p role="alert" className="alert error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="alert success">
          {notice}
        </p>
      )}
      {canWrite && (
        <details ref={editor} className="reply-editor"><summary>撰写新的回复草稿</summary><p className="muted">选择回复对象并编辑正文，保存后在下方核对、批准并发送到原会话。</p>{deliveryBlocked && <p role="status">{outcomeUnknown ? "请先核验任务执行结果，再保存、批准或发送回复。" : "请先恢复处理，再保存和审批回复。"}</p>}<form
          onSubmit={async (e) => {
            e.preventDefault();
            if (busy || deliveryBlocked || !targets.some((target) => String(target.id) === eventId) || !content.trim()) return;
            if (
              await act(
                () =>
                  request(`/tasks/${encodeURIComponent(taskId)}/deliveries`, {
                    event_id: Number(eventId),
                    content,
                  }),
                "回复草稿已保存，请在下方批准草稿，再点击发送到原渠道。",
              )
            )
              updateEdit((current) => current === edit ? { ...current, content: "" } : current);
          }}
        >
          <label>
            回复来源事件
            <select
              required
              value={eventId}
              onChange={(e) => {
                const value = e.target.value;
                updateEdit((current) => ({ ...current, eventId: value }));
              }}
            >
              <option value="">选择已路由的来源事件</option>
              {targets.map((event) => (
                <option key={event.id} value={event.id}>
                    {replyTarget(event)} ·{" "}
                  {event.content?.slice(0, 50)}
                </option>
              ))}
            </select>
          </label>
          {!targets.length && (
            <p className="muted">暂无可回复的钉钉或 Redmine 来源事件。</p>
          )}
          <label>
            回复草稿
            <textarea
              ref={input}
              required
              rows={5}
              value={content}
              onChange={(e) => {
                const value = e.target.value;
                updateEdit((current) => ({ ...current, content: value }));
              }}
            />
          </label>
          <div className="actions wrap">
          <button
            type="button"
            disabled={busy || !summaryText()}
            onClick={() => replaceEdit({ eventId, content: summaryText() })}
          >
            将本次结果填入回复框
          </button>
          <button disabled={busy || !targets.some((target) => String(target.id) === eventId) || !content.trim() || deliveryBlocked} className="primary">
            保存草稿，待审批发送
          </button>
          </div>
          <p className="muted">填入结果会替换回复框中的正文。保存草稿后，还需批准并确认发送。</p>
        </form></details>
      )}
      {replacement && canWrite && (
        <Modal className="action-confirm-dialog" labelledBy={dialogTitle} onClose={() => setReplacement(null)}>
          <h2 id={dialogTitle}>替换当前回复草稿？</h2>
          <p>编辑框中的正文会被替换。</p>
          {eventId !== replacement.eventId && <p>回复目标也会改为：{replyTarget(events.find((event) => String(event.id) === replacement.eventId))}</p>}
          <div className="actions wrap">
            <button type="button" data-dialog-autofocus onClick={() => setReplacement(null)}>保留当前草稿</button>
            <button type="button" className="primary" onClick={() => applyReplacement(replacement)}>替换草稿</button>
          </div>
        </Modal>
      )}
      {events.some(e => e.data?.routing_status === "self_context") &&
        <p className="muted">消息列表已有本账号发言。平台发送状态单独记录。</p>}
      {(() => {
        const judgment = [...events].reverse().find(e => e.source === "runtime" && e.event_type === "reply_decision"
          && e.data?.revision === revision && e.data?.control_version === controlVersion);
        if (!judgment) return !drafts.length && <p className="empty">暂无平台回复草稿</p>;
        const label = ({ skip: "本轮无需回复", review: "本轮建议人工确认", send: "本轮建议回复" } as Row)[judgment.data.decision];
        return <p><strong>{label}</strong> · {judgment.content}</p>;
      })()}
      {drafts.map((draft) => {
        const approval =
          draft.approval ?? approvals.find((a) => a.id === draft.approval_id);
        const status = draft.delivery?.write_status;
        const check = reconciliation[draft.id] ?? {
          outcome: "",
          evidence: "",
        };
        const source = events.find(event => String(event.id) === String(draft.event_id));
        const destination = replyTarget(source, approval?.action?.target, approval?.action?.source ?? source?.source);
        const stale = taskStatus === "cancelled" || (revision != null && approval?.revision != null && approval.revision !== revision) || (controlVersion != null && approval?.control_version != null && approval.control_version !== controlVersion);
        const title = status === "succeeded" ? "已回复" : status === "unknown" ? "发送结果未知" : status === "failed" ? "回复发送失败" : stale ? "历史回复草稿" : "尚未回复";
        return (
          <article className={`artifact reply-card reply-${status ?? 'draft'}`} key={draft.id}>
            <h4>{title}</h4>
            <p>{status === "succeeded" ? "已记录渠道发送成功。" : status === "unknown" ? "渠道未返回明确结果。可在原会话核对，系统不会重试这次发送。" : status === "failed" ? "已记录发送失败。修正失败原因后，可点击重新编辑回复，保存新草稿并审批发送。" : stale ? "此草稿的审批已失效。可复用正文，按当前目标重新编辑、审批发送。" : approval?.status === "pending" ? "核对正文后批准，再确认发送。" : approval?.status === "approved" ? "正文已批准，下一步发送到原会话。" : "草稿审批已结束，可重新撰写回复。"}</p>
            <p className="muted">{destination}</p>
            <ConversationContent content={draft.content} />
            {canWrite && status !== "unknown" && status !== "succeeded" && (stale || status === "failed" || approval?.status === "rejected") && (
              <div className="actions wrap">
                <button disabled={busy} onClick={() => replaceEdit({ eventId: String(draft.event_id), content: draft.content })}>{status === "failed" ? "重新编辑回复" : "复用为新草稿"}</button>
              </div>
            )}
            {canWrite && !deliveryBlocked && !stale && approval?.status === "pending" && (
              <div className="actions wrap">
                <button
                  disabled={busy}
                  onClick={() =>
                    void act(
                      () =>
                        request(`/deliveries/${draft.id}/decision`, {
                          decision: "approve",
                          action_hash: approval.action_hash,
                        }),
                      "草稿审批已提交。",
                    )
                  }
                >
                  批准回复草稿
                </button>
                <button
                  disabled={busy}
                  onClick={() =>
                    void act(
                      () =>
                        request(`/deliveries/${draft.id}/decision`, {
                          decision: "reject",
                          action_hash: approval.action_hash,
                        }),
                      "回复草稿已拒绝。",
                    )
                  }
                >
                  拒绝回复草稿
                </button>
              </div>
            )}
            {canWrite && !deliveryBlocked && !stale && approval?.status === "approved" && !status && (
              <>
                <button disabled={busy} onClick={(event) => {
                  event.currentTarget.focus({ preventScroll: true });
                  setConfirmId(draft.id);
                }}>
                  发送已批准回复
                </button>
                {confirmId === draft.id && (
                  <Modal className="action-confirm-dialog" labelledBy={dialogTitle} busy={busy} onClose={() => setConfirmId(null)}>
                    <h2 id={dialogTitle}>确认发送回复</h2>
                    <p><strong>发送到：</strong>{destination}</p>
                    <ConversationContent content={draft.content} />
                    <div className="actions wrap">
                      <button type="button" data-dialog-autofocus disabled={busy} onClick={() => setConfirmId(null)}>取消发送</button>
                      <button type="button" className="primary" disabled={busy} onClick={() => {
                        setConfirmId(null);
                        void act(() => request(`/deliveries/${draft.id}/publish`, {}), "发送请求已处理，请核对发送结果。");
                      }}>确认发送到原渠道</button>
                    </div>
                  </Modal>
                )}
              </>
            )}
            {status === "unknown" && (
              <details className="reply-diagnostics">
                <summary>记录渠道核实结果</summary>
                {canWrite && (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void act(
                        () =>
                          request(`/deliveries/${draft.id}/reconcile`, check),
                        "对账结果已记录。",
                      );
                    }}
                  >
                    <label>
                      外部核验结果
                      <select
                        value={check.outcome}
                        onChange={(e) =>
                          setReconciliation((old) => ({
                            ...old,
                            [draft.id]: { ...check, outcome: e.target.value },
                          }))
                        }
                      >
                        <option value="">请选择实际核实结果</option>
                        <option value="succeeded">已确认发送成功</option>
                        <option value="failed">已确认发送失败</option>
                      </select>
                    </label>
                    <label>
                      核验证据
                      <textarea
                        required
                        value={check.evidence}
                        onChange={(e) =>
                          setReconciliation((old) => ({
                            ...old,
                            [draft.id]: { ...check, evidence: e.target.value },
                          }))
                        }
                      />
                    </label>
                    <button disabled={busy || !check.outcome || !check.evidence.trim()}>
                      提交发送对账
                    </button>
                  </form>
                )}
              </details>
            )}
            <details className="reply-diagnostics"><summary>发送详情与诊断</summary>
              <p>草稿 #{draft.id} · 目标版本 {approval?.revision ?? "—"}</p>
              <pre>{JSON.stringify({target: approval?.action?.target, approval: approval?.status, delivery: draft.delivery}, null, 2)}</pre>
            </details>
          </article>
        );
      })}
    </div>
  );
}
