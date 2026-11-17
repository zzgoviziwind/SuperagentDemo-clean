import { useCallback, useEffect, useRef, useState } from "react";
import { request, statusNames } from "./api";
import { CoordinationPanel } from "./CoordinationPanel";
import { ConversationContent } from "./ConversationContent";

type Row = Record<string, any>;
type Session = {
  id: string;
  kind: string;
  title: string;
  project_id: number;
  task_id?: number;
  status: string;
  mode: string;
  codex_thread_id?: string;
  state_version?: number;
  outcome_unknown?: boolean;
  last_error?: string;
  event_id?: number;
  task_kind?: string;
  worker_session_ids?: string[];
};
type Detail = { session: Session; messages: Row[]; transcript?: Row };
const kindName = (session: Session) =>
  session.kind === "routing"
    ? "AI 分流 · Router"
    : session.kind === "router"
      ? "项目讨论"
      : session.task_kind === "reply"
        ? "回复事件 · Worker"
        : "Worker";
const time = (value?: string) =>
  value ? new Date(value).toLocaleString("zh-CN") : "";
const sessionStatus = (status: string) =>
  statusNames[status] ??
  (
    {
      idle: "待命",
      applied: "已应用",
      ignored: "已忽略",
      rejected: "待调整",
      unknown: "待核验",
    } as Record<string, string>
  )[status] ??
  status;
const messageStatus: Record<string, string> = {
  submitted: "已提交给模型",
  visible_output: "已保存可见输出",
  applied: "已通过规则校验",
  suggestion: "复核建议已保存",
  queued: "已排队",
  running: "代理处理中",
  completed: "已处理",
  failed: "处理失败",
  unknown: "处理结果待核验",
  note: "已保存为控制备注",
  not_sent: "尚未发送给代理",
};

export function SessionWorkbench({
  projects,
  canWrite,
  onOpenTask,
  initialSessionId,
  onSelectSession,
}: {
  projects: Row[];
  canWrite: boolean;
  onOpenTask: (id: string) => void;
  initialSessionId?: string;
  onSelectSession?: (id: string) => void;
}) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [kind, setKind] = useState("");
  const [project, setProject] = useState("");
  const [content, setContent] = useState("");
  const [changeGoal, setChangeGoal] = useState(false);
  const [evidence, setEvidence] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const selected = useRef("");
  const load = useCallback(async () => {
    try {
      const items = await request<Session[]>("/sessions");
      setSessions(Array.isArray(items) ? items : []);
      if (selected.current) {
        const id = selected.current;
        const next = await request<Detail>(
          `/sessions/${encodeURIComponent(id)}`,
        );
        if (id === selected.current) setDetail(next);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (!document.hidden) void load();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [load]);
  async function open(id: string) {
    selected.current = id;
    onSelectSession?.(id);
    setDetail(null);
    setError("");
    setNotice("");
    setContent("");
    setChangeGoal(false);
    setEvidence("");
    try {
      const value = await request<Detail>(
        `/sessions/${encodeURIComponent(id)}`,
      );
      if (selected.current === id) setDetail(value);
    } catch (e) {
      if (selected.current === id) setError((e as Error).message);
    }
  }
  useEffect(() => {
    if (initialSessionId) void open(initialSessionId);
  }, [initialSessionId]);
  const session = detail?.session;
  const filtered = sessions.filter(
    (s) =>
      (!kind || s.kind === kind) &&
      (!project || String(s.project_id) === project),
  );
  const closed = session && ["completed", "cancelled"].includes(session.status);
  async function reconcile() {
    if (!session || !evidence.trim()) return;
    setBusy(true);
    setError("");
    try {
      await request(`/sessions/${encodeURIComponent(session.id)}/reconcile`, {
        evidence: evidence.trim(),
        expected_state_version: session.state_version,
      });
      setEvidence("");
      setNotice("执行核验已保存，可继续会话。");
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function send() {
    if (!session || !content.trim()) return;
    const id = session.id;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await request(`/sessions/${encodeURIComponent(id)}/messages`, {
        content: content.trim(),
        change_goal: changeGoal,
        expected_state_version: session.state_version,
      });
      if (selected.current === id) {
        setContent("");
        setChangeGoal(false);
        setNotice(
          session.kind === "router" && session.mode === "rules"
            ? "控制备注已保存。"
            : "消息已提交，会话将继续更新。",
        );
      }
      await load();
    } catch (e) {
      setError((e as Error).message);
      await load();
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="session-workbench">
      <section className="session-index">
        <div className="section-heading">
          <h2>会话</h2>
          <button onClick={() => void load()}>刷新会话</button>
        </div>
        <label>
          会话类型
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">全部会话</option>
            <option value="routing">AI 分流 · Router</option>
            <option value="router">项目讨论</option>
            <option value="worker">Worker</option>
          </select>
        </label>
        <label>
          所属项目
          <select value={project} onChange={(e) => setProject(e.target.value)}>
            <option value="">全部项目</option>
            {projects.map((p) => (
              <option value={p.id} key={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <div className="session-list">
          {filtered.map((s) => (
            <button
              key={s.id}
              className="session-choice"
              aria-pressed={selected.current === s.id}
              disabled={busy}
              onClick={() => void open(s.id)}
            >
              <small>{kindName(s)}</small>
              <strong>{s.title}</strong>
              <span>
                {sessionStatus(s.status)} ·{" "}
                {projects.find((p) => p.id === s.project_id)?.name ??
                  `项目 ${s.project_id}`}
              </span>
            </button>
          ))}
        </div>
        {loading && <p role="status">正在读取会话…</p>}
        {!loading && !filtered.length && <p className="empty">暂无匹配会话</p>}
      </section>
      <section className="conversation">
        <div className="section-heading">
          <h2>{session?.title ?? "选择一个会话"}</h2>
          {session?.task_id && (
            <button onClick={() => onOpenTask(String(session.task_id))}>
              进入事件 ↗
            </button>
          )}
        </div>
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
        {!session && (
          <div className="conversation-empty">
            <h3>查看代理上下文，随时补充方向</h3>
            <p>
              AI 分流记录每次实际判断，Worker
              记录事件推进，项目讨论保留背景与建议。
            </p>
          </div>
        )}
        {session && (
          <>
            <div className="conversation-context">
              <span className="badge">
                {kindName(session)} · {sessionStatus(session.status)}
              </span>
              <p>
                {session.kind === "routing"
                  ? "这是来源事件的实际 AI 分流会话。补充事实或纠正判断后，模型在同一线程复核，结果经过权限和事件版本校验。"
                  : session.kind === "router"
                    ? session.mode === "agent"
                      ? "项目讨论代理已启用，建议保存在本地会话中。事件的实际模型判定与人工纠正在事件中心查看。"
                      : "项目讨论代理未启用。人工发言保存为项目控制备注，事件分派状态可在事件中心核对。"
                    : "消息通过事件控制通道提交，代理摘要来自已保存的事件产物。"}
              </p>
              <details>
                <summary>执行线程信息</summary>
                <small>
                  Worker 线程由项目绑定的本机或共享卷 daemon 设备承载，项目
                  Router 讨论线程由控制服务承载。
                </small>
                <small>
                  Codex 线程 · {session.codex_thread_id ?? "尚未创建"}
                </small>
              </details>
            </div>
            {!!session.worker_session_ids?.length && (
              <div className="session-links">
                {session.worker_session_ids.map((id) => (
                  <button
                    key={id}
                    disabled={busy}
                    onClick={() => void open(id)}
                  >
                    查看分派的 Worker · {id.split(":")[1]}
                  </button>
                ))}
              </div>
            )}
            <CoordinationPanel key={`coord-${session.id}`} sessionId={session.id} version={session.state_version} taskId={session.task_id} />
            <p className="thread-reference">原 Codex 会话：{session.codex_thread_id ?? "尚未创建"}</p>
            {detail.transcript && !detail.transcript.complete && (
              <p className="muted">
                当前显示平台记录；原会话可通过上方编号在 Codex 中核对。
              </p>
            )}
            {session.last_error && (
              <p className="alert error">{session.last_error}</p>
            )}
            {session.outcome_unknown && (
              <div className="alert">
                <strong>执行结果待核验</strong>
                <p>核对所属执行设备的线程与进程结果后，填写证据解除保护。</p>
                {["router", "routing"].includes(session.kind) && canWrite && (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void reconcile();
                    }}
                  >
                    <label>
                      会话执行核验证据
                      <textarea
                        value={evidence}
                        onChange={(e) => setEvidence(e.target.value)}
                        required
                      />
                    </label>
                    <button disabled={busy || !evidence.trim()}>
                      提交会话核验
                    </button>
                  </form>
                )}
                {session.task_id && (
                  <button onClick={() => onOpenTask(String(session.task_id))}>
                    进入事件核验结果
                  </button>
                )}
              </div>
            )}
            <div className="message-timeline" aria-label="会话消息时间线">
              {detail.messages.map((m) => (
                <article
                  className={`conversation-message role-${m.role}`}
                  key={m.id}
                >
                  <div>
                    <strong>
                      {m.data?.source === "model_context"
                        ? "本次模型输入"
                        : m.role === "user"
                          ? m.data?.sender ? `${m.data.sender} · ${m.data.direction === "own_account" ? "本账号发言" : m.data.source === "web" ? "平台补充" : m.data.source === "dingtalk" ? "钉钉" : m.data.source === "redmine" ? "Redmine" : "人工发言"}` : "人工发言"
                          : m.role === "assistant"
                            ? "代理回复"
                            : "系统记录"}
                    </strong>
                    <time>{time(m.created_at)}</time>
                  </div>
                  {m.data?.historical_snapshot && (
                    <small>历史输入输出快照</small>
                  )}
                  {m.data?.status && (
                    <small className={`message-status ${m.data.status}`}>
                      {messageStatus[m.data.status] ?? m.data.status}
                    </small>
                  )}
                  <ConversationContent
                    content={m.content}
                    variant={m.role === "user" ? "input" : "record"}
                  />
                </article>
              ))}
              {!detail.messages.length && <p className="empty">会话尚无消息</p>}
            </div>
            {canWrite && !closed && !session.outcome_unknown && (
              <form
                className="conversation-compose"
                onSubmit={(e) => {
                  e.preventDefault();
                  void send();
                }}
              >
                <label>
                  补充说明或纠正方向
                  <textarea
                    rows={4}
                    required
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    placeholder={
                      session.kind === "router"
                        ? "补充项目背景、优先级或分派建议"
                        : "说明需要调整的目标、遗漏的事实或后续要求"
                    }
                  />
                </label>
                {session.kind === "worker" && (
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={changeGoal}
                      onChange={(e) => setChangeGoal(e.target.checked)}
                    />
                    作为新的事件目标提交
                  </label>
                )}
                <button className="primary" disabled={busy || !content.trim()}>
                  {busy
                    ? "正在提交…"
                    : session.kind === "router" && session.mode === "rules"
                      ? "保存控制备注"
                      : "发送到会话"}
                </button>
              </form>
            )}
            {closed && (
              <p className="muted">
                该事件已结束。新增需求可从事件页创建关联事件。
              </p>
            )}
          </>
        )}
      </section>
    </div>
  );
}
