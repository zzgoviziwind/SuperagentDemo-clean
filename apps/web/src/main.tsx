import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ApiError,
  controlLabel,
  request,
  statusNames,
  isDeliveryApproval,
} from "./api";
import { GovernancePanel } from "./GovernancePanel";
import { DeliveriesPanel } from "./DeliveriesPanel";
import { InboxPanel } from "./InboxPanel";
import { ArtifactView } from "./ArtifactView";
import "./style.css";

type Row = Record<string, any>;
type Task = Row & {
  id: string;
  title: string;
  goal: string;
  project_id: string;
  status: string;
  revision: number;
  state_version: number;
};
type Detail = { task: Task; events: Row[]; artifacts: Row[]; approvals: Row[] };
const pretty = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value, null, 2);
const date = (value?: string) =>
  value ? new Date(value).toLocaleString("zh-CN") : "—";
const lines = (value: string) =>
  value
    .split(/[\n,，]/)
    .map((item) => item.trim())
    .filter(Boolean);
const emptyProject = {
  name: "",
  repo_path: "",
  base_branch: "main",
  test_command: "",
  allowed_paths: "",
  dingtalk_chat_ids: "",
  redmine_project_ids: "",
  enabled: true,
};

export function App() {
  const [page, setPage] = useState("工作台");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [projects, setProjects] = useState<Row[]>([]);
  const [connectors, setConnectors] = useState<Row[]>([]);
  const [overview, setOverview] = useState<Row>({});
  const [settings, setSettings] = useState<Row>({});
  const [health, setHealth] = useState<Row>({});
  const [user, setUser] = useState<Row | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const [token, setToken] = useState("");
  const [connectorConfirm, setConnectorConfirm] = useState<string | null>(null);
  const isAdmin = user?.role === "admin";
  const canWrite = !!user && ["admin", "member"].includes(user.role);
  const [detail, setDetail] = useState<Detail | null>(null);
  const selected = useRef<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState("");
  const [filter, setFilter] = useState({
    status: "",
    project: "",
    source: "",
    search: "",
  });
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({
    title: "",
    goal: "",
    project_id: "",
    acceptance_criteria: "",
    kind: "repair",
  });
  const [project, setProject] = useState(emptyProject);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [pathMode, setPathMode] = useState("");
  const [reconcileEvidence, setReconcileEvidence] = useState("");
  const [reconcileOutcome, setReconcileOutcome] = useState("stopped");
  const [message, setMessage] = useState("");
  const [changeGoal, setChangeGoal] = useState(false);
  const [review, setReview] = useState("");
  const [tab, setTab] = useState("事件");
  const [requested, setRequested] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    const results = await Promise.allSettled([
      request<Task[]>("/tasks"),
      request<Row[]>("/projects"),
      request<Row[]>("/connectors"),
      request<Row>("/overview"),
      request<Row>("/health"),
      request<Row>("/settings"),
      request<Row>("/auth/me"),
    ]);
    const setters = [
      setTasks,
      setProjects,
      setConnectors,
      setOverview,
      setHealth,
      setSettings,
      (data: Row) => {
        setUser(data);
        setLoginOpen(false);
      },
    ] as ((data: any) => void)[];
    const failures: string[] = [];
    results.forEach((result, index) => {
      if (result.status === "fulfilled") setters[index](result.value);
      else {
        failures.push(result.reason.message);
        if (result.reason instanceof ApiError && result.reason.status === 401) {
          setUser(null);
          setLoginOpen(true);
          setTasks([]);
          setProjects([]);
          setDetail(null);
        }
      }
    });
    if (selected.current) {
      const id = selected.current;
      try {
        const next = await request<Detail>(`/tasks/${encodeURIComponent(id)}`);
        if (selected.current === id) setDetail(next);
      } catch (e) {
        failures.push((e as Error).message);
      }
    }
    setError([...new Set(failures)].join(" "));
    setLoading(false);
    setLastRefresh(new Date().toLocaleTimeString("zh-CN"));
  }, []);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  async function mutate(operation: () => Promise<unknown>, success: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await operation();
      setNotice(success);
      await refresh();
      return true;
    } catch (e) {
      setError((e as Error).message);
      if (e instanceof ApiError && e.status === 401) {
        setUser(null);
        setLoginOpen(true);
      }
      if (e instanceof ApiError && e.status === 409)
        await refresh().then(() => setError(e.message));
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function openTask(id: string) {
    selected.current = id;
    setDetail(null);
    setPage("任务");
    setError("");
    setMessage("");
    setReview("");
    setReconcileEvidence("");
    try {
      const next = await request<Detail>(`/tasks/${encodeURIComponent(id)}`);
      if (selected.current === id) setDetail(next);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function navigate(next: string) {
    selected.current = null;
    setDetail(null);
    setPage(next);
  }
  async function control(action: string) {
    if (!detail) return;
    const task = detail.task;
    await mutate(
      async () => {
        await request(`/tasks/${encodeURIComponent(task.id)}/controls`, {
          action,
          expected_state_version: task.state_version,
        });
        setRequested((old) => {
          const next = { ...old };
          delete next[task.id];
          if (["pause", "cancel"].includes(action)) next[task.id] = action;
          return next;
        });
      },
      ["pause", "cancel"].includes(action)
        ? "停止请求已接收，执行端确认后更新状态。"
        : "控制请求已接收。",
    );
  }
  function taskStatus(task: Task) {
    if (task.outcome_unknown) return "执行结果未知 · 待对账";
    return requested[task.id] &&
      !["paused", "cancelled", "completed", "failed"].includes(task.status)
      ? "已请求停止 · 等待执行端确认"
      : controlLabel(task);
  }
  function taskRows(items: Task[]) {
    return items.length ? (
      <div className="task-list">
        {items.map((task) => (
          <button
            className="task-row"
            key={task.id}
            onClick={() => void openTask(task.id)}
          >
            <span>
              <strong>{task.title}</strong>
              <small>
                {projects.find((p) => p.id === task.project_id)?.name ??
                  task.project_id}{" "}
                · {task.source ?? "web"} · {date(task.updated_at)}
              </small>
              {task.last_error && (
                <small className="danger">{task.last_error}</small>
              )}
            </span>
            <span className={`badge ${task.status}`}>{taskStatus(task)}</span>
            <span aria-hidden>↗</span>
          </button>
        ))}
      </div>
    ) : (
      <p className="empty">暂无任务</p>
    );
  }
  const task = detail?.task;
  const canTaskWrite =
    isAdmin ||
    (user?.role === "member" &&
      !!task?.owner_id &&
      String(task.owner_id) === user.user_id);
  const filtered = tasks.filter(
    (t) =>
      (!filter.status || t.status === filter.status) &&
      (!filter.project || String(t.project_id) === filter.project) &&
      (!filter.source || t.source === filter.source) &&
      `${t.title} ${t.goal}`
        .toLowerCase()
        .includes(filter.search.toLowerCase()),
  );
  const attention = tasks.filter(
    (t) =>
      t.outcome_unknown ||
      ["waiting_input", "waiting_approval", "review_ready", "failed"].includes(
        t.status,
      ),
  );

  return (
    <div className="shell">
      <aside inert={creating}>
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            navigate("工作台");
          }}
        >
          <span className="logo">S</span>SuperAgent
        </a>
        <p className="workspace-label">研发协作空间</p>
        <nav aria-label="主导航">
          {["工作台", "任务", "项目设置", "运行状态"].map((item, index) => (
            <button
              key={item}
              aria-current={page === item ? "page" : undefined}
              onClick={() => navigate(item)}
            >
              <span aria-hidden>{["◫", "☷", "◇", "◉"][index]}</span>
              {item}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <span className={`dot ${health.status ? "online" : ""}`} />
          {health.status ? "控制服务已连接" : "等待连接服务"}
          <small>Web · 钉钉 · Redmine</small>
        </div>
      </aside>
      <main inert={creating}>
        <header>
          <div>
            <p className="eyebrow">
              SUPERAGENT / {page === "任务" && task ? "任务详情" : page}
            </p>
            <h1>{task?.title ?? page}</h1>
          </div>
          <div className="actions">
            {user ? (
              <>
                <span className="muted">
                  {user.name ?? user.username ?? user.user_id ?? user.role}
                </span>
                <button
                  disabled={busy}
                  onClick={() =>
                    void mutate(async () => {
                      await request("/auth/logout", {});
                      setUser(null);
                      setTasks([]);
                      setProjects([]);
                      setOverview({});
                      setDetail(null);
                      selected.current = null;
                      setToken("");
                    }, "已退出当前会话。")
                  }
                >
                  登出
                </button>
              </>
            ) : (
              <button onClick={() => setLoginOpen(true)}>登录</button>
            )}
            <button onClick={() => void refresh()} disabled={busy}>
              刷新
            </button>
            {canWrite && (
              <button className="primary" onClick={() => setCreating(true)}>
                ＋ 新建任务
              </button>
            )}
          </div>
        </header>
        {loginOpen && !user && (
          <section>
            <h2>登录工作空间</h2>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                await mutate(async () => {
                  const current = await request<Row>("/auth/login", { token });
                  setUser(current);
                  setToken("");
                  setLoginOpen(false);
                }, "已登录工作空间。");
              }}
            >
              <label>
                访问令牌
                <input
                  type="password"
                  autoComplete="off"
                  required
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                />
              </label>
              <button className="primary" disabled={busy}>
                登录
              </button>
            </form>
          </section>
        )}
        {error && (
          <div role="alert" className="alert error">
            {error}
            <button onClick={() => void refresh()}>重新连接 / 刷新</button>
          </div>
        )}
        {notice && (
          <div role="status" className="alert success">
            {notice}
          </div>
        )}
        {loading && <p role="status">正在读取工作空间…</p>}
        {page === "工作台" && (
          <>
            <div className="intro">
              <h2>让每项工作持续向前</h2>
              <p>集中查看进展、证据和需要你决定的事项。</p>
            </div>
            <div className="metrics">
              {[
                ["需要你处理", attention.length],
                [
                  "正在执行",
                  overview.counts?.running ??
                    tasks.filter((t) => t.status === "running").length,
                ],
                [
                  "待验收",
                  overview.counts?.review_ready ??
                    tasks.filter((t) => t.status === "review_ready").length,
                ],
                ["项目", projects.length],
              ].map(([label, count]) => (
                <div className="metric" key={label}>
                  <span>{label}</span>
                  <strong>{count}</strong>
                </div>
              ))}
            </div>
            <section>
              <h2>
                需要你处理 <span className="count">{attention.length}</span>
              </h2>
              {taskRows(attention)}
            </section>
            {isAdmin && <InboxPanel onChange={refresh} />}
            <section>
              <h2>正在推进</h2>
              {taskRows(
                tasks.filter(
                  (t) =>
                    !t.outcome_unknown &&
                    ["queued", "running", "waiting_resource"].includes(
                      t.status,
                    ),
                ),
              )}
            </section>
            <section>
              <h2>最近交付</h2>
              {taskRows(
                tasks
                  .filter((t) =>
                    ["review_ready", "completed"].includes(t.status),
                  )
                  .slice(0, 8),
              )}
            </section>
          </>
        )}
        {page === "任务" && !selected.current && (
          <>
            <div className="filters">
              <label>
                搜索
                <input
                  value={filter.search}
                  onChange={(e) =>
                    setFilter({ ...filter, search: e.target.value })
                  }
                  placeholder="任务标题或目标"
                />
              </label>
              <label>
                状态
                <select
                  value={filter.status}
                  onChange={(e) =>
                    setFilter({ ...filter, status: e.target.value })
                  }
                >
                  <option value="">全部状态</option>
                  {Object.entries(statusNames).map(([key, value]) => (
                    <option key={key} value={key}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                项目
                <select
                  value={filter.project}
                  onChange={(e) =>
                    setFilter({ ...filter, project: e.target.value })
                  }
                >
                  <option value="">全部项目</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                来源
                <select
                  value={filter.source}
                  onChange={(e) =>
                    setFilter({ ...filter, source: e.target.value })
                  }
                >
                  <option value="">全部来源</option>
                  {[...new Set(tasks.map((t) => t.source).filter(Boolean))].map(
                    (s) => (
                      <option key={s}>{s}</option>
                    ),
                  )}
                </select>
              </label>
            </div>
            <section>{taskRows(filtered)}</section>
          </>
        )}
        {page === "任务" && selected.current && !task && (
          <p role="status">任务详情尚未载入，请刷新重试。</p>
        )}
        {task && detail && (
          <>
            <button className="back" onClick={() => navigate("任务")}>
              ← 返回任务列表
            </button>
            <section>
              <div className="section-heading">
                <h2>当前目标</h2>
                <span className={`badge ${task.status}`}>
                  {taskStatus(task)}
                </span>
              </div>
              <p className="goal">{task.goal}</p>
              <a
                className="download-link"
                href={`/api/v1/tasks/${encodeURIComponent(task.id)}/export`}
                download
              >
                导出任务完整快照 JSON
              </a>
              <dl>
                <dt>任务类型</dt>
                <dd>{task.kind === "analysis" ? "分析问题" : "修复代码"}</dd>
                <dt>验收标准</dt>
                <dd>{pretty(task.acceptance_criteria) || "尚未填写"}</dd>
                <dt>版本</dt>
                <dd>
                  目标 {task.revision} · 状态 {task.state_version} · 控制{" "}
                  {task.control_version ?? "—"}
                </dd>
                <dt>来源</dt>
                <dd>
                  {task.source} {pretty(task.source_ref)}
                </dd>
                <dt>工作目录</dt>
                <dd>{task.workspace_path || "尚未建立"}</dd>
                <dt>最近更新</dt>
                <dd>{date(task.updated_at)}</dd>
              </dl>
              {task.last_error && (
                <p className="alert error">{task.last_error}</p>
              )}
              {task.outcome_unknown && (
                <div className="alert error">
                  <h3>执行结果未知</h3>
                  <p>
                    请核对执行进程、工作目录和外部动作后提交证据。确认停止后进入已暂停，可手动恢复；放弃后进入已取消。
                  </p>
                  {canTaskWrite && (
                    <form
                      onSubmit={async (e) => {
                        e.preventDefault();
                        if (
                          await mutate(
                            () =>
                              request(
                                `/tasks/${encodeURIComponent(task.id)}/reconcile`,
                                {
                                  outcome: reconcileOutcome,
                                  evidence: reconcileEvidence,
                                  expected_state_version: task.state_version,
                                },
                              ),
                            "任务执行结果已对账。",
                          )
                        )
                          setReconcileEvidence("");
                      }}
                    >
                      <label>
                        执行对账结果
                        <select
                          value={reconcileOutcome}
                          onChange={(e) => setReconcileOutcome(e.target.value)}
                        >
                          <option value="stopped">确认执行已停止</option>
                          <option value="abandoned">确认放弃此任务</option>
                        </select>
                      </label>
                      <label>
                        执行核验证据
                        <textarea
                          required
                          value={reconcileEvidence}
                          onChange={(e) => setReconcileEvidence(e.target.value)}
                        />
                      </label>
                      <button disabled={busy || !reconcileEvidence.trim()}>
                        提交执行对账
                      </button>
                    </form>
                  )}
                </div>
              )}
              <div className="actions wrap" hidden={!canTaskWrite}>
                {(task.status === "queued"
                  ? [["start", "启动"]]
                  : ["paused", "waiting_input"].includes(task.status)
                    ? [["resume", "恢复"]]
                    : task.status === "failed"
                      ? [["retry", "重试"]]
                      : [
                            "running",
                            "waiting_input",
                            "waiting_approval",
                            "waiting_resource",
                          ].includes(task.status)
                        ? [["pause", "暂停"]]
                        : []
                ).map(([action, label]) => (
                  <button
                    key={action}
                    disabled={busy || !!task.outcome_unknown}
                    onClick={() => void control(action)}
                  >
                    {label}
                  </button>
                ))}
                {!["completed", "cancelled"].includes(task.status) && (
                  <button
                    className="danger"
                    disabled={busy}
                    onClick={() => void control("cancel")}
                  >
                    取消任务
                  </button>
                )}
              </div>
            </section>
            <div className="detail-grid">
              <section>
                <div className="tabs" aria-label="任务记录">
                  {["事件", "证据与差异", "审批", "原渠道回复"].map((name) => (
                    <button
                      key={name}
                      aria-pressed={tab === name}
                      onClick={() => setTab(name)}
                    >
                      {name}
                    </button>
                  ))}
                </div>
                {tab === "原渠道回复" && (
                  <DeliveriesPanel
                    key={task.id}
                    taskId={task.id}
                    events={detail.events}
                    approvals={detail.approvals}
                    artifacts={detail.artifacts}
                    revision={task.revision}
                    canWrite={canTaskWrite}
                    onChange={refresh}
                  />
                )}
                {tab === "事件" &&
                  (detail.events.length ? (
                    <ol className="timeline">
                      {detail.events.map((event, i) => (
                        <li key={event.id ?? i}>
                          <small>
                            {date(event.created_at ?? event.occurred_at)} ·{" "}
                            {event.type ?? event.event_type ?? event.kind}
                          </small>
                          <pre>
                            {pretty(event.content ?? event.payload ?? event)}
                          </pre>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p className="empty">暂无事件</p>
                  ))}
                {tab === "证据与差异" && (
                  <>
                    {detail.artifacts.length ? (
                      detail.artifacts.map((a, i) => (
                        <ArtifactView
                          key={a.id ?? i}
                          artifact={a}
                          revision={task.revision}
                        />
                      ))
                    ) : (
                      <p className="empty">暂无产物，尚无可审阅的验证证据。</p>
                    )}
                  </>
                )}
                {tab === "审批" &&
                  (detail.approvals.length ? (
                    detail.approvals.map((a) => (
                      <article key={a.id} className="artifact">
                        <strong>
                          {a.title ?? a.action_type ?? "动作审批"}
                        </strong>
                        <pre>{pretty(a.action ?? a.payload ?? a)}</pre>
                        <p>
                          状态 {a.status} · 版本 {a.revision ?? "—"}
                        </p>
                        {isDeliveryApproval(a) && (
                          <button onClick={() => setTab("原渠道回复")}>
                            查看回复草稿与发送审批
                          </button>
                        )}
                        {a.status === "pending" &&
                          canTaskWrite &&
                          !isDeliveryApproval(a) && (
                            <div className="actions">
                              <button
                                className="primary"
                                disabled={busy || !a.action_hash}
                                onClick={() =>
                                  void mutate(
                                    () =>
                                      request(
                                        `/approvals/${encodeURIComponent(a.id)}/decision`,
                                        {
                                          decision: "approve",
                                          action_hash: a.action_hash,
                                        },
                                      ),
                                    "审批决定已提交。",
                                  )
                                }
                              >
                                批准
                              </button>
                              <button
                                disabled={busy || !a.action_hash}
                                onClick={() =>
                                  void mutate(
                                    () =>
                                      request(
                                        `/approvals/${encodeURIComponent(a.id)}/decision`,
                                        {
                                          decision: "reject",
                                          action_hash: a.action_hash,
                                        },
                                      ),
                                    "拒绝决定已提交。",
                                  )
                                }
                              >
                                拒绝
                              </button>
                            </div>
                          )}
                      </article>
                    ))
                  ) : (
                    <p className="empty">暂无审批</p>
                  ))}
              </section>
              <div>
                <section hidden={!canTaskWrite}>
                  <h2>补充要求</h2>
                  <form
                    onSubmit={async (e) => {
                      e.preventDefault();
                      if (
                        await mutate(
                          () =>
                            request(
                              `/tasks/${encodeURIComponent(task.id)}/messages`,
                              {
                                content: message,
                                change_goal: changeGoal,
                                expected_state_version: task.state_version,
                              },
                            ),
                          changeGoal
                            ? "新方向已提交，请核对目标版本与执行状态。"
                            : "补充要求已接收。",
                        )
                      )
                        setMessage("");
                    }}
                  >
                    <label>
                      要求内容
                      <textarea
                        required
                        value={message}
                        onChange={(e) => setMessage(e.target.value)}
                        rows={5}
                      />
                    </label>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={changeGoal}
                        onChange={(e) => setChangeGoal(e.target.checked)}
                      />
                      改变任务方向
                    </label>
                    {changeGoal && (
                      <p className="muted">
                        提交后更新目标版本，旧方案审批需重新核对。
                      </p>
                    )}
                    <button
                      className="primary"
                      disabled={
                        busy || ["completed", "cancelled"].includes(task.status)
                      }
                    >
                      提交要求
                    </button>
                  </form>
                </section>
                <section hidden={!canTaskWrite}>
                  <h2>交付验收</h2>
                  <label>
                    验收意见 / 返工原因
                    <textarea
                      value={review}
                      onChange={(e) => setReview(e.target.value)}
                      rows={3}
                    />
                  </label>
                  <div className="actions wrap" hidden={!canTaskWrite}>
                    <button
                      className="primary"
                      disabled={busy || task.status !== "review_ready"}
                      onClick={() =>
                        void mutate(
                          () =>
                            request(
                              `/tasks/${encodeURIComponent(task.id)}/acceptance`,
                              {
                                accepted: true,
                                comment: review,
                                revision: task.revision,
                              },
                            ),
                          "验收已提交。",
                        )
                      }
                    >
                      通过验收
                    </button>
                    <button
                      disabled={
                        busy || task.status !== "review_ready" || !review.trim()
                      }
                      onClick={() =>
                        void mutate(
                          () =>
                            request(
                              `/tasks/${encodeURIComponent(task.id)}/acceptance`,
                              {
                                accepted: false,
                                comment: review,
                                revision: task.revision,
                              },
                            ),
                          "返工意见已提交。",
                        )
                      }
                    >
                      要求返工
                    </button>
                  </div>
                  <p className="muted">待验收时可操作，返工请填写具体差距。</p>
                </section>
              </div>
            </div>
          </>
        )}
        {page === "项目设置" && (
          <div className="detail-grid">
            <section>
              <h2>已绑定项目</h2>
              {projects.length ? (
                projects.map((p) => (
                  <button
                    className="project-row"
                    key={p.id}
                    onClick={() => {
                      setProjectId(p.id);
                      setPathMode(p.allowed_paths?.length ? "paths" : "none");
                      setProject({
                        ...emptyProject,
                        ...p,
                        allowed_paths: (p.allowed_paths ?? []).join("\n"),
                        dingtalk_chat_ids: (p.dingtalk_chat_ids ?? []).join(
                          "\n",
                        ),
                        redmine_project_ids: (p.redmine_project_ids ?? []).join(
                          "\n",
                        ),
                      });
                    }}
                  >
                    <strong>{p.name}</strong>
                    <small>{p.repo_path}</small>
                    <span>
                      {p.base_branch} · {p.enabled ? "已启用" : "已停用"}
                    </span>
                  </button>
                ))
              ) : (
                <p className="empty">尚未绑定项目</p>
              )}
              <button
                hidden={!isAdmin}
                onClick={() => {
                  setProjectId(null);
                  setPathMode("");
                  setProject(emptyProject);
                }}
              >
                ＋ 添加项目
              </button>
            </section>
            <section hidden={!isAdmin}>
              <h2>{projectId ? "编辑项目" : "绑定项目"}</h2>
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  const body = {
                    ...project,
                    allowed_paths:
                      pathMode === "none" ? [] : lines(project.allowed_paths),
                    dingtalk_chat_ids: lines(project.dingtalk_chat_ids),
                    redmine_project_ids: lines(project.redmine_project_ids),
                  };
                  if (
                    await mutate(
                      () =>
                        request(
                          projectId
                            ? `/projects/${encodeURIComponent(projectId)}`
                            : "/projects",
                          body,
                          projectId ? "PATCH" : "POST",
                        ),
                      "项目配置已保存。",
                    )
                  ) {
                    setProjectId(null);
                    setProject(emptyProject);
                    setPathMode("");
                  }
                }}
              >
                <label>
                  改动验收范围
                  <select
                    required
                    value={pathMode}
                    onChange={(e) => setPathMode(e.target.value)}
                  >
                    <option value="">明确选择允许范围</option>
                    <option value="none">不允许任何修改（空路径列表）</option>
                    <option value="paths">允许指定仓库相对路径</option>
                  </select>
                </label>
                <p className="muted">
                  允许路径用于结果验收与审批范围校验。填写 .
                  表示整个仓库。此配置不提供操作系统级子路径隔离。
                </p>
                {Object.entries({
                  name: "项目名称",
                  repo_path: "仓库绝对目录",
                  base_branch: "基线分支",
                  test_command: "验证命令（管理员配置）",
                  allowed_paths: "改动验收允许路径（每行一项）",
                  dingtalk_chat_ids: "钉钉群 ID（每行一项）",
                  redmine_project_ids: "Redmine 项目 ID（每行一项）",
                })
                  .filter(
                    ([key]) => key !== "allowed_paths" || pathMode === "paths",
                  )
                  .map(([key, label]) => (
                    <label key={key}>
                      {label}
                      {key.endsWith("ids") || key === "allowed_paths" ? (
                        <textarea
                          required={key === "allowed_paths"}
                          value={project[key as keyof typeof project] as string}
                          onChange={(e) =>
                            setProject({ ...project, [key]: e.target.value })
                          }
                        />
                      ) : (
                        <input
                          required={[
                            "name",
                            "repo_path",
                            "base_branch",
                          ].includes(key)}
                          value={project[key as keyof typeof project] as string}
                          onChange={(e) =>
                            setProject({ ...project, [key]: e.target.value })
                          }
                        />
                      )}
                    </label>
                  ))}
                <label className="check">
                  <input
                    type="checkbox"
                    checked={project.enabled}
                    onChange={(e) =>
                      setProject({ ...project, enabled: e.target.checked })
                    }
                  />
                  启用项目
                </label>
                <button className="primary" disabled={busy}>
                  保存项目
                </button>
              </form>
            </section>
          </div>
        )}
        {page === "运行状态" && (
          <>
            <section>
              <h2>控制服务</h2>
              <dl>
                <dt>状态</dt>
                <dd>{health.status ?? "尚未连接"}</dd>
                <dt>版本</dt>
                <dd>{health.version ?? "—"}</dd>
                <dt>最近读取</dt>
                <dd>{lastRefresh || "—"}</dd>
              </dl>
              <p className="muted">
                页面每 5
                秒刷新，隐藏页面时暂停轮询。身份由服务端会话或部署层提供。
              </p>
            </section>
            <section>
              <h2>消息与执行连接</h2>
              {connectors.length ? (
                <div className="connector-grid">
                  {connectors.map((c) => (
                    <article className="connector" key={c.id}>
                      <h3>{c.name}</h3>
                      <span className="badge">{c.status}</span>
                      <p>
                        {c.configured ? "已配置" : "待配置"} ·{" "}
                        {c.enabled ? "已启用" : "未启用"}
                      </p>
                      <small>最后联系 {date(c.last_seen)}</small>
                      {c.last_error && <p className="danger">{c.last_error}</p>}
                      {isAdmin && (
                        <div className="actions wrap">
                          {[
                            "running",
                            "ready",
                            "connected",
                            "starting",
                          ].includes(c.status) ? (
                            <button
                              disabled={busy}
                              onClick={() =>
                                void mutate(
                                  () =>
                                    request(
                                      `/connectors/${encodeURIComponent(c.id)}/stop`,
                                      {},
                                    ),
                                  "连接器停止请求已提交。",
                                )
                              }
                            >
                              停止连接
                            </button>
                          ) : (
                            <button
                              disabled={busy}
                              onClick={() => setConnectorConfirm(c.id)}
                            >
                              启用连接
                            </button>
                          )}
                        </div>
                      )}
                      {isAdmin && connectorConfirm === c.id && (
                        <div>
                          <p>
                            配置状态 {c.configured ? "已配置" : "尚未配置"}
                            。启用后将监听以下项目目标。
                          </p>
                          <ul>
                            {projects.map((p) => (
                              <li key={p.id}>
                                {p.name} ·{" "}
                                {pretty(
                                  c.id === "dingtalk"
                                    ? p.dingtalk_chat_ids
                                    : p.redmine_project_ids,
                                )}
                              </li>
                            ))}
                          </ul>
                          <pre>
                            {pretty(
                              c.config ?? settings[`connectors.${c.id}`] ?? {},
                            )}
                          </pre>
                          <div className="actions wrap">
                            <button
                              className="primary"
                              disabled={busy || !c.configured}
                              onClick={() =>
                                void mutate(async () => {
                                  if (!c.enabled)
                                    await request(
                                      "/settings",
                                      {
                                        [`connectors.${c.id}`]: {
                                          ...settings[`connectors.${c.id}`],
                                          enabled: true,
                                        },
                                      },
                                      "PATCH",
                                    );
                                  await request(
                                    `/connectors/${encodeURIComponent(c.id)}/start`,
                                    {},
                                  );
                                  setConnectorConfirm(null);
                                }, "连接器启用请求已提交，请核对实际状态。")
                              }
                            >
                              确认启用
                            </button>
                            <button onClick={() => setConnectorConfirm(null)}>
                              返回
                            </button>
                          </div>
                        </div>
                      )}
                    </article>
                  ))}
                </div>
              ) : (
                <p className="empty">暂无连接状态，请核对服务配置。</p>
              )}
            </section>
            <section>
              <h2>服务配置（脱敏）</h2>
              <pre>{pretty(settings)}</pre>
              <p className="muted">凭据在服务环境或本机凭据管理中配置。</p>
            </section>
            {isAdmin && (
              <GovernancePanel
                settings={settings}
                projects={projects}
                onChange={refresh}
              />
            )}
          </>
        )}
        <footer>
          SuperAgent · 持续研发协作 <span>最近读取 {lastRefresh || "—"}</span>
        </footer>
      </main>
      {creating && (
        <div className="modal-backdrop">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-title"
            onKeyDown={(e) => {
              if (e.key === "Escape" && !busy) setCreating(false);
              if (e.key === "Tab") {
                const focusable = e.currentTarget.querySelectorAll<HTMLElement>(
                  "button:not(:disabled), input, textarea, select",
                );
                const first = focusable[0];
                const last = focusable[focusable.length - 1];
                if (e.shiftKey && document.activeElement === first) {
                  e.preventDefault();
                  last?.focus();
                } else if (!e.shiftKey && document.activeElement === last) {
                  e.preventDefault();
                  first?.focus();
                }
              }
            }}
          >
            <div className="section-heading">
              <h2 id="create-title">新建任务</h2>
              <button
                aria-label="关闭新建任务"
                disabled={busy}
                onClick={() => setCreating(false)}
              >
                关闭
              </button>
            </div>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (
                  await mutate(async () => {
                    const created = await request<Task>("/tasks", {
                      ...draft,
                      source: "web",
                    });
                    setCreating(false);
                    setDraft({
                      title: "",
                      goal: "",
                      project_id: "",
                      acceptance_criteria: "",
                      kind: "repair",
                    });
                    await openTask(created.id);
                  }, "任务已创建，请核对目标后启动。")
                )
                  setCreating(false);
              }}
            >
              <label>
                项目
                <select
                  autoFocus
                  required
                  value={draft.project_id}
                  onChange={(e) =>
                    setDraft({ ...draft, project_id: e.target.value })
                  }
                >
                  <option value="">选择项目</option>
                  {projects
                    .filter((p) => p.enabled)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                任务类型
                <select
                  value={draft.kind}
                  onChange={(e) => setDraft({ ...draft, kind: e.target.value })}
                >
                  <option value="repair">修复代码</option>
                  <option value="analysis">分析问题</option>
                </select>
              </label>
              <label>
                任务标题
                <input
                  required
                  value={draft.title}
                  onChange={(e) =>
                    setDraft({ ...draft, title: e.target.value })
                  }
                />
              </label>
              <label>
                目标
                <textarea
                  required
                  rows={4}
                  value={draft.goal}
                  onChange={(e) => setDraft({ ...draft, goal: e.target.value })}
                />
              </label>
              <label>
                验收标准
                <textarea
                  rows={3}
                  value={draft.acceptance_criteria}
                  onChange={(e) =>
                    setDraft({ ...draft, acceptance_criteria: e.target.value })
                  }
                  placeholder="预期交付、验证范围与完成条件"
                />
              </label>
              {error && (
                <p role="alert" className="danger">
                  {error}
                </p>
              )}
              <button
                className="primary"
                disabled={busy || !projects.some((p) => p.enabled)}
              >
                {busy ? "正在提交…" : "创建任务"}
              </button>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}

const container = document.getElementById("root");
if (container)
  createRoot(container).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
