import { useEffect, useState } from "react";
import { request, statusNames } from "./api";
import { ConversationContent } from "./ConversationContent";

type Row = Record<string, any>;
export function RoutingPanel({
  onOpenSession,
}: {
  onOpenSession?: (id: string) => void;
}) {
  const [page, setPage] = useState<Row>({ items: [] });
  const [after, setAfter] = useState(0);
  const [history, setHistory] = useState<number[]>([]);
  const [selected, setSelected] = useState<Row | null>(null);
  const [action, setAction] = useState("confirm");
  const [kind, setKind] = useState("analysis");
  const [taskId, setTaskId] = useState("");
  const [reason, setReason] = useState("");
  const [evidence, setEvidence] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  async function load() {
    try {
      setPage(await request(`/routing/jobs?after=${after}&limit=50`));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void load();
  }, [after]);
  async function schedule() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await request<{ checked: number }>(
        "/routing/schedule",
        {},
      );
      setNotice(`已检查 ${result.checked} 条待确认事件。`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function correct() {
    if (!selected) return;
    const target = (
      selected.correction_tasks ??
      selected.context?.tasks ??
      []
    ).find((task: Row) => String(task.id) === taskId);
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await request(`/routing/jobs/${selected.event_id}/correction`, {
        decision: {
          action,
          kind,
          task_id: action === "dispatch" ? target.id : null,
          state_version: action === "dispatch" ? target.state_version : null,
          reason,
        },
        evidence,
      });
      setSelected(null);
      setEvidence("");
      setReason("");
      setNotice("分派纠正已提交，请核对事件目标。");
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section>
      <div className="section-heading">
        <h2>语义分派记录</h2>
        <button
          disabled={busy}
          onClick={() => {
            setError("");
            void load();
          }}
        >
          刷新分派记录
        </button>
      </div>
      <button disabled={busy} onClick={() => void schedule()}>
        检查待确认事件
      </button>
      {error && (
        <p className="alert error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="alert success" role="status">
          {notice}
        </p>
      )}
      {(page.items ?? []).map((job: Row) => (
        <article className="linked-record" key={job.event_id}>
          <strong>
            事件 {job.event_id} ·{" "}
            {statusNames[job.status] ??
              ({ unknown: "待核验", ignored: "已忽略" } as Row)[job.status] ??
              job.status}
          </strong>
          {job.error && <p className="danger">{job.error}</p>}
          {job.routing_session_id && onOpenSession && (
            <button onClick={() => onOpenSession(job.routing_session_id)}>
              查看这次 Router 判断
            </button>
          )}
          <ConversationContent content={job.decision ?? "判定尚未形成"} />
          <details>
            <summary>实际模型会话与输入输出</summary>
            <dl>
              <dt>线程</dt>
              <dd className="break-word">{job.thread_id ?? "尚未创建"}</dd>
              <dt>轮次</dt>
              <dd>{job.turn_id ?? "尚未创建"}</dd>
            </dl>
            <ConversationContent content={job.context} />
            <ConversationContent content={job.output} />
          </details>
          <button
            disabled={busy || job.status === "running"}
            onClick={() => {
              setSelected(job);
              setTaskId("");
              setAction("confirm");
              setReason("");
              setEvidence("");
            }}
          >
            人工纠正事件 {job.event_id}
          </button>
        </article>
      ))}
      {!page.items?.length && <p className="empty">暂无语义分派记录</p>}
      <div className="actions">
        <button
          disabled={!history.length}
          onClick={() => {
            const previous = [...history];
            setAfter(previous.pop() ?? 0);
            setHistory(previous);
          }}
        >
          上一页分派
        </button>
        <button
          disabled={!page.has_more}
          onClick={() => {
            setHistory([...history, after]);
            setAfter(page.next_after);
          }}
        >
          下一页分派
        </button>
      </div>
      {selected && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void correct();
          }}
        >
          <h3>纠正事件 {selected.event_id}</h3>
          <label>
            分派决定
            <select value={action} onChange={(e) => setAction(e.target.value)}>
              <option value="confirm">保留待确认</option>
              <option value="create">创建事件</option>
              <option value="dispatch">关联已有事件</option>
              <option value="ignore">忽略事件</option>
            </select>
          </label>
          <label>
            工作类型
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="reply">回复消息</option>
              <option value="analysis">只读分析</option>
              <option value="repair">修改修复</option>
            </select>
          </label>
          {action === "dispatch" && (
            <label>
              快照中的目标事件
              <select
                required
                value={taskId}
                onChange={(e) => setTaskId(e.target.value)}
              >
                <option value="">选择目标</option>
                {(
                  selected.correction_tasks ??
                  selected.context?.tasks ??
                  []
                ).map((task: Row) => (
                  <option key={task.id} value={task.id}>
                    {task.title} · 版本 {task.state_version}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            判定说明
            <textarea
              required
              maxLength={2000}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <label>
            人工核验证据
            <textarea
              required
              maxLength={4000}
              value={evidence}
              onChange={(e) => setEvidence(e.target.value)}
            />
          </label>
          <button
            disabled={busy || !reason.trim() || !evidence.trim()}
            className="primary"
          >
            提交分派纠正
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setSelected(null)}
          >
            关闭纠正
          </button>
        </form>
      )}
    </section>
  );
}
