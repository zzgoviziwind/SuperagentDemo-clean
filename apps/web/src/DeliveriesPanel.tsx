import { useCallback, useEffect, useState } from "react";
import { request } from "./api";

type Row = Record<string, any>;
export function DeliveriesPanel({
  taskId,
  events,
  approvals,
  artifacts = [],
  revision,
  canWrite,
  onChange,
}: {
  taskId: string;
  events: Row[];
  approvals: Row[];
  artifacts?: Row[];
  revision?: number;
  canWrite: boolean;
  onChange: () => Promise<void>;
}) {
  const [drafts, setDrafts] = useState<Row[]>([]);
  const [eventId, setEventId] = useState("");
  const [content, setContent] = useState("");
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
      event.data?.routing_status === "routed",
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
  return (
    <div>
      <h2>原渠道回复</h2>
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
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (
              await act(
                () =>
                  request(`/tasks/${encodeURIComponent(taskId)}/deliveries`, {
                    event_id: Number(eventId),
                    content,
                  }),
                "回复草稿已保存，核对目标与正文后审批。",
              )
            )
              setContent("");
          }}
        >
          <label>
            回复来源事件
            <select
              required
              value={eventId}
              onChange={(e) => setEventId(e.target.value)}
            >
              <option value="">选择已路由的来源事件</option>
              {targets.map((event) => (
                <option key={event.id} value={event.id}>
                  {event.source} · 事件 {event.id} ·{" "}
                  {event.data?.thread_id ?? event.data?.issue_id} ·{" "}
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
              required
              rows={5}
              value={content}
              onChange={(e) => setContent(e.target.value)}
            />
          </label>
          <button
            type="button"
            disabled={busy || !summaryText()}
            onClick={() => setContent(summaryText())}
          >
            使用本次分析结果
          </button>
          <button disabled={busy || !targets.length} className="primary">
            保存回复草稿
          </button>
        </form>
      )}
      {!drafts.length && <p className="empty">暂无回复草稿</p>}
      {drafts.map((draft) => {
        const approval =
          draft.approval ?? approvals.find((a) => a.id === draft.approval_id);
        const status = draft.delivery?.write_status;
        const check = reconciliation[draft.id] ?? {
          outcome: "succeeded",
          evidence: "",
        };
        return (
          <article className="artifact" key={draft.id}>
            <h3>回复草稿 #{draft.id}</h3>
            <p>
              审批 {approval?.status ?? "等待读取审批"} · 发送{" "}
              {status ?? "尚未发送"}
            </p>
            <pre>{JSON.stringify(approval?.action?.target ?? {}, null, 2)}</pre>
            <pre>{draft.content}</pre>
            <small>
              动作哈希 {approval?.action_hash ?? "—"} · 目标版本{" "}
              {approval?.revision ?? "—"}
            </small>
            {canWrite && approval?.status === "pending" && (
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
            {canWrite && approval?.status === "approved" && !status && (
              <>
                <button disabled={busy} onClick={() => setConfirmId(draft.id)}>
                  发送已批准回复
                </button>
                {confirmId === draft.id && (
                  <div className="alert">
                    <p>确认将以上正文发送到展示的原渠道目标。</p>
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={() =>
                        void act(async () => {
                          await request(`/deliveries/${draft.id}/publish`, {});
                          setConfirmId(null);
                        }, "发送请求已处理，请核对发送结果。")
                      }
                    >
                      确认发送到原渠道
                    </button>
                    <button onClick={() => setConfirmId(null)}>返回</button>
                  </div>
                )}
              </>
            )}
            {status === "unknown" && (
              <div className="alert error">
                <p>发送结果未知，需要在原渠道核验后对账。</p>
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
                    <button disabled={busy || !check.evidence.trim()}>
                      提交发送对账
                    </button>
                  </form>
                )}
              </div>
            )}
            {draft.delivery && (
              <pre>{JSON.stringify(draft.delivery, null, 2)}</pre>
            )}
          </article>
        );
      })}
    </div>
  );
}
