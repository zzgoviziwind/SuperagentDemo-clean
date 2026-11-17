import { EventNextStep, deliverySucceeded, STEP_NAMES } from "./EventNextStep";
import { useCallback, useEffect, useRef, useState } from "react";
import { request, statusNames } from "./api";
import { reasonText } from "./InboxPanel";
import { ConversationContent } from "./ConversationContent";
import { subscriptionLabel } from "./ArchitecturePanel";

type Row = Record<string, any>;
type Page = { items: Row[]; has_more: boolean; next_after: number };
type Trace = {
  source_context?: Row;
  related_events?: Row[];
  event: Row;
  attempts: Row[];
  subscriptions: Row[];
  task: Row | null;
  target_tasks?: Row[];
  target_observations?: Row[];
  target_subscriptions?: Row[];
  semantic_routing?: Row;
  routing_session?: Row;
  routing_session_id?: string | null;
  routing_mode?: string;
  worker_session_ids?: string[];
  deliveries: Row[];
  legacy: boolean;
  execution?: Row;
  live_stages?: Row;
};
const stages: Record<string, string> = {
  trigger: "消息触发",
  fast_filter: "快速过滤",
  slow_filter: "语义过滤",
  subscription: "订阅匹配",
  router: "项目分派",
  worker: "Worker",
  execution: "工具执行",
  session_db: "会话存储",
  delivery: "回复交付",
  watchdog: "运行守护",
};
const states: Record<string, string> = {
  passed: "已通过",
  blocked: "已阻止",
  skipped: "已跳过",
  unknown: "待核对",
  pending_confirmation: "待人工确认",
  routed: "已关联事件",
  semantic_pending: "语义判定中",
  semantic_ignored: "语义判定已忽略",
  self_echo: "自身回复回声",
  self_echo_candidate: "待核对回声",
};
const reasons: Record<string, string> = {
  event_received: "消息已持久接收",
  identity_project_type_and_input_validated:
    "身份、项目、消息类型与输入校验通过",
  existing_task_matched: "已找到关联事件，后续消息进入原事件",
  no_existing_task: "未找到已有事件引用，将进入项目分派",
  created_task: "已为新请求创建事件",
  reused_task: "继续使用已有事件",
  semantic_filter_disabled_or_fastpath:
    "本次未启用语义过滤，或通过规则/订阅直通",
  semantic_filter_not_implemented: "历史处理时语义过滤尚未接通，该次记录为跳过",
  not_recorded_in_routing_attempt:
    "该阶段由后续流程推进，本次路由未记录其执行结果",
  stage_not_reached: "处理在前序阶段结束，尚未到达此处",
  self_echo: "识别为系统自身回复，已过滤",
  self_echo_candidate: "疑似系统自身回复，等待核对",
  delivery_echo: "系统回复回声",
  deterministic_rules: "确定性规则",
  issue: "问题引用",
  reply: "回复引用",
};
const sources: Record<string, string> = {
  dingtalk: "钉钉",
  redmine: "Redmine",
  web: "工作台",
};
const labels: Record<string, string> = {
  persisted_settings: "本次已保存策略",
  input: "来源输入",
  response_policy: "消息响应策略",
  conversation_type: "会话类型",
  matched_scope: "命中范围",
  source_event_id: "来源事件",
  reference_types: "引用类型",
  candidate_task_ids: "候选事件",
  selected_task_id: "选中事件",
  method: "分派方式",
  project_id: "项目",
  task_id: "事件",
  task_status: "事件状态",
  route_key: "匹配引用",
  reason: "原因",
  source: "来源",
  actor_id: "发送人标识",
  identity_id: "身份映射",
  event_type: "事件类型",
  thread_id: "渠道会话",
  issue_id: "问题",
  request_kind: "请求类型",
  kind: "处理类型",
  outcome: "处理结果",
  routing_status: "路由状态",
  route: "路由方式",
  mode: "处理模式",
  delivery_id: "交付记录",
  reply_id: "回复记录",
  count: "数量",
  status: "状态",
  error: "错误",
  subscription_id: "订阅",
  enabled: "启用状态",
  capability: "服务能力",
  codex_thread_id: "Codex 线程",
  created: "新建事件",
  message: "说明",
};
const time = (value?: string) =>
  value ? new Date(value).toLocaleString("zh-CN") : "时间未记录";
function facts(value: unknown): string {
  if (value == null) return "未记录";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (Array.isArray(value)) return value.map(facts).join("、") || "无";
  if (typeof value === "object")
    return (
      Object.entries(value)
        .map(([k, v]) => `${labels[k] ?? k} · ${facts(v)}`)
        .join(" / ") || "无额外信息"
    );
  return (
    reasons[String(value)] ??
    states[String(value)] ??
    statusNames[String(value)] ??
    String(value)
  );
}

function sourceTitle(event: Row) {
  const d = event.data ?? {}, m = d.metadata ?? {};
  const name = m.conversation_title ?? m.chat_name ?? m.conversationTitle ?? m.sender_name ?? d.thread_id;
  return `${sources[event.source] ?? event.source}${name ? ` · ${name}` : " · 来源名称未记录"}`;
}
function sender(event: Row) {
  const d = event.data ?? {}, m = d.metadata ?? {};
  return m.sender_name ?? m.senderNick ?? m.actor_name ?? d.actor_id ?? "发送者未记录";
}
function EventRoute({ trace, onOpenTask, onSelectEvent }: { onSelectEvent: (id: number) => void; trace: Trace; onOpenTask: (id: string) => void }) {
  const steps: Row[] = trace.attempts.at(-1)?.steps ?? [];
  const tasks = trace.target_tasks?.length ? trace.target_tasks : trace.task ? [trace.task] : [];
  const blocked = steps.find(s => s.status === "blocked");
  const sent = trace.deliveries.some(d => deliverySucceeded(d));
  const nodes = [
    { title: STEP_NAMES[0], text: "已收到来源消息", state: "done" },
    { title: STEP_NAMES[1], text: blocked ? reasonText(blocked.reason) : tasks.length ? "已分派处理" : states[trace.event.data?.routing_status] ?? "等待分派", state: blocked ? "blocked" : tasks.length ? "done" : "current" },
    { title: STEP_NAMES[2], text: tasks.length ? tasks.map(t => statusNames[t.status] ?? t.status).join("、") : "尚未开始", state: tasks.some(t => t.outcome_unknown || t.status === "failed") ? "blocked" : tasks.every(t => t.status === "completed") && tasks.length ? "done" : tasks.length ? "current" : "idle" },
    { title: STEP_NAMES[3], text: sent ? "已回复来源渠道" : trace.deliveries.length ? "已有回复草稿，尚未确认发送" : "尚无已确认的交付记录", state: sent ? "done" : "idle" },
  ];
  return <article className="linked-record">
    {!!trace.related_events?.length && <section><h3>同事件的来源事件</h3>{trace.related_events.map(e => <button className="related-event" aria-pressed={e.id === trace.event.id} onClick={() => onSelectEvent(e.id)} key={`${e.id}-${e.task_id}`}>{e.conversation_name ?? e.thread_id ?? e.source} · {e.actor_name ?? "发送者未记录"}：{e.content}</button>)}</section>}
    <h3>处理进度</h3>
    <div className="trace-diagram" aria-label="事件处理进度图">{nodes.map((n,i) => <div className="trace-step" key={n.title}><div className={`trace-node ${n.state}`}><strong>{n.state === "done" ? "✓ " : n.state === "blocked" ? "! " : "○ "}{n.title}</strong><span>{n.text}</span></div>{i < nodes.length-1 && <span aria-hidden="true">→</span>}</div>)}</div>
    <p className="muted">处理与核验展示相关工作当前状态；回复以实际发送记录为准。</p>
    {tasks.map(t => {
      const artifacts = (trace.task?.id === t.id ? trace.execution?.artifacts ?? [] : trace.target_observations?.find(o => o.task_id === t.id)?.execution?.artifacts ?? []) as Row[];
      const currentArtifacts = artifacts.filter(a => a.revision === t.revision);
      const kind = ({repair:"代码修复",analysis:"分析报告",reply:"消息回复"} as Row)[t.kind] ?? "处理结果";
      return <section key={t.id}><p><strong>{kind}</strong> · {statusNames[t.status] ?? t.status}{t.status === "review_ready" ? "，请核验交付内容" : t.status === "waiting_approval" ? "，需要你批准下一步操作" : ""}</p><p className="muted">{currentArtifacts.length ? `当前版本已保存 ${currentArtifacts.length} 项结果证据，请查看结果核对内容。` : "尚无当前版本产物证据；执行状态不代表代码已修改或消息已发送。"}</p><button className="primary" onClick={() => onOpenTask(String(t.id))}>查看结果与处理{tasks.length > 1 ? ` · ${t.title ?? t.id}` : ""}</button></section>;
    })}
    {!!trace.deliveries.length && <section><h3>交付内容</h3>{trace.deliveries.map((d,i) => <div key={i}><ConversationContent content={d.draft?.content ?? "回复正文未记录"} /><p>{deliverySucceeded(d) ? "已发送" : "草稿／发送未确认"}</p></div>)}</section>}
  </article>;
}

function WatchdogRuns({ runs }: { runs?: Row[] }) {
  return (
    <>
      {(runs ?? []).map((run: Row) => (
        <details className="execution-record" key={run.id}>
          <summary>
            {time(run.created_at)} · 智能巡检 {run.id} ·{" "}
            {statusNames[run.status] ??
              ({ unknown: "待核验", reconciled: "已核验" } as Row)[
                run.status
              ] ??
              run.status}
          </summary>
          <ConversationContent
            content={run.conclusion ?? run.error ?? "结论尚未形成"}
          />
          {run.correction && <p>人工纠正 · {run.correction}</p>}
          <dl>
            <dt>巡检线程</dt>
            <dd className="break-word">{run.thread_id ?? "尚未创建"}</dd>
            <dt>巡检轮次</dt>
            <dd>{run.turn_id ?? "尚未创建"}</dd>
          </dl>
          <details>
            <summary>巡检输入证据</summary>
            <ConversationContent content={run.evidence} />
          </details>
        </details>
      ))}
    </>
  );
}

export function EventCenter({
  initialEventId,
  onSelectEvent,
  onOpenTask,
  onManage,
  onOpenSession,
}: {
  initialEventId?: number;
  onSelectEvent?: (id: number) => void;
  onOpenTask: (id: string) => void;
  onManage: () => void;
  onOpenSession?: (id: string) => void;
}) {
  const [page, setPage] = useState<Page>({
    items: [],
    has_more: false,
    next_after: 0,
  });
  const [relations, setRelations] = useState<Record<number, Row>>({});
  const [cursor, setCursor] = useState(0);
  const [history, setHistory] = useState<number[]>([]);
  const [source, setSource] = useState("");
  const [status, setStatus] = useState("all");
  const [query, setQuery] = useState("");
  const [trace, setTrace] = useState<Trace | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const selected = useRef<number | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const next = await request<Page>(
        `/events?routing_status=${status}&after=${cursor}&limit=50`,
      );
      const linked = await Promise.allSettled((next.items ?? []).map(async e => { const t = await request<Trace>(`/events/${e.id}/trace`); return [e.id, { tasks: (t.target_tasks?.length ? t.target_tasks : t.task ? [t.task] : []).map(x => x.id), count: t.related_events?.length ?? 0 }] as const; }));
      setRelations(Object.fromEntries(linked.flatMap(r => r.status === "fulfilled" ? [r.value] : [])));
      setPage({
        items: next.items ?? [],
        has_more: next.has_more,
        next_after: next.next_after,
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [cursor, status]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => { if (initialEventId != null) void open(initialEventId); }, [initialEventId]);
  async function open(id: number) {
    onSelectEvent?.(id);
    selected.current = id;
    setTrace(null);
    setError("");
    setNotice("");
    try {
      const value = await request<Trace>(`/events/${id}/trace`);
      if (selected.current === id) setTrace(value);
    } catch (e) {
      if (selected.current === id) setError((e as Error).message);
    }
  }
  async function retry() {
    if (selected.current === null) return;
    const id = selected.current;
    setBusy(true);
    setError("");
    try {
      await request(`/events/${id}/retry-routing`, {});
      await load();
      await open(id);
      setNotice("重新处理已完成，请核对最新一次阶段记录。");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const items = page.items.filter(
    (e) =>
      !["runtime", "system"].includes(e.source) &&
      (!source || e.source === source) &&
      `${e.content} ${e.id}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <>
      <section className="event-toolbar">
        <div className="section-heading">
          <div>
            <h2>事件中心</h2>
            <p className="muted">
              查看事件来自哪里、处理到哪一步，以及交付了什么。
            </p>
          </div>
          <button
            onClick={() => {
              void load();
              if (selected.current !== null) void open(selected.current);
            }}
          >
            刷新事件
          </button>
        </div>
        <div className="filters">
          <label>
            消息来源
            <select value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="">全部来源</option>
              <option value="dingtalk">钉钉</option>
              <option value="redmine">Redmine</option>
              <option value="web">工作台</option>
            </select>
          </label>
          <label>
            处理状态
            <select
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setCursor(0);
                setHistory([]);
                selected.current = null;
                setTrace(null);
              }}
            >
              <option value="all">全部状态</option>
              {Object.entries(states)
                .filter(([key]) =>
                  [
                    "pending_confirmation",
                    "routed",
                    "self_echo",
                    "self_echo_candidate",
                  ].includes(key),
                )
                .map(([key, label]) => (
                  <option value={key} key={key}>
                    {label}
                  </option>
                ))}
            </select>
          </label>
          <label>
            搜索本页
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="消息内容或事件编号"
            />
          </label>
        </div>
        <small className="muted">
          来源与搜索筛选当前加载页，每页最多 50 条事件。
        </small>
      </section>
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
      <div className="event-workbench">
        <section className="event-index">
          <h2>
            消息记录 <span className="count">{items.length}</span>
          </h2>
          {loading && <p role="status">正在读取事件…</p>}
          {items.map((e) => (
            <button
              className={`event-choice ${trace?.related_events?.some(r => r.id === e.id) ? "same-task" : ""}`}
              key={e.id}
              aria-pressed={selected.current === e.id}
              onClick={() => void open(e.id)}
            >
              <div>
                <strong>{sourceTitle(e)}</strong>
                <span className="badge">
                  {states[e.data?.routing_status] ??
                    e.data?.routing_status ??
                    "已接收"}
                </span>
              </div>
              <p><strong>{sender(e)}：</strong>{e.content || "空消息"}</p>
              <small>{relations[e.id]?.tasks?.length ? `平台事件 ${relations[e.id].tasks.map((id: string) => `#${id}`).join("、")} · 共 ${relations[e.id].count} 条相关消息 · ` : e.task_id ? `平台事件 #${e.task_id} · 关联数量读取中 · ` : ""}
                事件 {e.id} · {time(e.created_at)}
              </small>
            </button>
          ))}
          {!loading && !items.length && (
            <p className="empty">本页暂无匹配事件</p>
          )}
          <div className="actions">
            <button
              disabled={!history.length || loading}
              onClick={() => {
                const previous = [...history];
                setCursor(previous.pop() ?? 0);
                setHistory(previous);
              }}
            >
              上一页
            </button>
            <button
              disabled={!page.has_more || loading}
              onClick={() => {
                setHistory([...history, cursor]);
                setCursor(page.next_after);
              }}
            >
              下一页
            </button>
          </div>
        </section>
        <section className="event-detail">
          <div className="section-heading">
            <h2>
              {trace
                ? `事件 ${trace.event.id} 的处理过程`
                : "选择消息查看处理过程"}
            </h2>
          </div>
          {!trace && (
            <div className="conversation-empty">
              <h3>每个决定都有去向</h3>
              <p>在左侧选择消息，核对过滤、订阅、分派与执行记录。</p>
            </div>
          )}
          {trace && (
            <>
              <div className="event-original">
                <small>
                  {sources[trace.event.source] ?? trace.event.source} ·{" "}
                  {time(trace.event.created_at)}
                </small>
                <p><strong>{sender(trace.event)}：</strong>{trace.event.content}</p>
                <dl>
                  <dt>当前处理状态</dt>
                  <dd>
                    {states[trace.event.data?.routing_status] ??
                      trace.event.data?.routing_status ??
                      "已接收"}
                  </dd>
                  <dt>来源会话</dt>
                  <dd>{trace.event.data?.thread_id ?? "未记录"}</dd>
                </dl>
              </div>
              <EventNextStep onOpenSession={onOpenSession} trace={trace} onOpenTask={onOpenTask} onManage={onManage} onRetry={() => void retry()} busy={busy} />
              <EventRoute trace={trace} onOpenTask={onOpenTask} onSelectEvent={id => void open(id)} />
              <details className="linked-record"><summary>处理记录与诊断</summary>
              {trace.legacy && (
                <p className="alert">
                  这条历史事件尚无持久化阶段记录。可核对来源、关联事件和交付记录。
                </p>
              )}
              {trace.attempts.map((attempt) => (
                <details className="trace-attempt" key={attempt.attempt}><summary>第 {attempt.attempt} 次处理 · 完整阶段记录</summary>
                  <div className="section-heading">
                    <h3>第 {attempt.attempt} 次处理</h3>
                    <small>{time(attempt.started_at)}</small>
                  </div>
                  <ol className="lifecycle-timeline">
                    {(attempt.steps ?? []).map((step: Row, index: number) => (
                      <li
                        className={`lifecycle-step step-${step.status}`}
                        key={`${step.stage}-${index}`}
                      >
                        <div className="section-heading">
                          <strong>{stages[step.stage] ?? step.stage}</strong>
                          <span className={`stage-status ${step.status}`}>
                            {states[step.status] ?? step.status}
                          </span>
                        </div>
                        {step.reason && (
                          <p>
                            {reasons[step.reason] ??
                              (step.status === "blocked"
                                ? reasonText(step.reason)
                                : step.reason)}
                          </p>
                        )}
                        {step.detail && (
                          <details>
                            <summary>查看本次判断依据</summary>
                            <div className="step-facts">
                              {facts(step.detail)}
                            </div>
                          </details>
                        )}
                        <small>{time(step.at)}</small>
                      </li>
                    ))}
                  </ol>
                </details>
              ))}
              {!!trace.target_tasks?.length && (
                <article className="linked-record">
                  <h3>全部目标事件</h3>
                  {trace.target_tasks.map((task: Row) => (
                    <div key={task.id} className="actions wrap">
                      <button onClick={() => onOpenTask(String(task.id))}>
                        {task.title ?? `事件 ${task.id}`} ·{" "}
                        {statusNames[task.status] ?? task.status}
                      </button>
                      {onOpenSession && (
                        <button
                          onClick={() => onOpenSession(`worker:${task.id}`)}
                        >
                          查看事件会话
                        </button>
                      )}
                    </div>
                  ))}
                </article>
              )}
              {trace.target_observations?.map((observation: Row) => (
                <article className="linked-record" key={observation.task_id}>
                  <h3>目标事件 {observation.task_id} 的当前观察</h3>
                  <p className="muted">{observation.scope}</p>
                  <dl>
                    <dt>执行状态</dt>
                    <dd>{facts(observation.execution?.state)}</dd>
                    <dt>事件消息</dt>
                    <dd>{observation.message_event_id}</dd>
                    <dt>Worker 线程</dt>
                    <dd className="break-word">
                      {observation.execution?.thread_id ?? "尚未创建"}
                    </dd>
                    <dt>执行轮次</dt>
                    <dd>{observation.execution?.turn_id ?? "尚未创建"}</dd>
                  </dl>
                  {observation.watchdog?.outcome_unknown && (
                    <p className="alert">执行结果未知，需要人工核验</p>
                  )}
                  {observation.watchdog?.last_error && (
                    <p className="danger">{observation.watchdog.last_error}</p>
                  )}
                  <WatchdogRuns runs={observation.watchdog?.runs} />
                  {!!observation.execution?.events?.length && (
                    <details>
                      <summary>当前目标执行记录</summary>
                      {observation.execution.events.map((event: Row) => (
                        <div key={event.id}>
                          <small>
                            {time(event.created_at)} · {event.event_type}
                          </small>
                          <ConversationContent content={event.content} />
                        </div>
                      ))}
                    </details>
                  )}
                  <button
                    onClick={() => onOpenTask(String(observation.task_id))}
                  >
                    进入目标事件查看与介入
                  </button>
                </article>
              ))}
              {trace.routing_session_id && onOpenSession && (
                <button
                  onClick={() => onOpenSession(trace.routing_session_id!)}
                >
                  查看这次 Router 判断
                </button>
              )}
              {trace.routing_mode === "rules" && (
                <p className="muted">本次由规则或订阅直通处理。</p>
              )}
              {trace.semantic_routing && (
                <article className="linked-record">
                  <h3>模型分派记录</h3>
                  <ConversationContent content={trace.semantic_routing} />
                </article>
              )}
              {trace.routing_session && onOpenSession && (
                <button
                  onClick={() => onOpenSession(trace.routing_session!.id)}
                >
                  查看实际分派会话
                </button>
              )}
              {trace.task && (
                <article className="linked-record">
                  <h3>关联事件</h3>
                  <strong>{trace.task.title}</strong>
                  <p>{statusNames[trace.task.status] ?? trace.task.status}</p>
                  {trace.task.last_error && (
                    <p className="danger">{trace.task.last_error}</p>
                  )}
                  <button onClick={() => onOpenTask(String(trace.task!.id))}>
                    查看执行与验证证据
                  </button>
                </article>
              )}
              {trace.task && trace.execution && (
                <article className="linked-record">
                  <h3>当前事件执行证据</h3>
                  <p className="muted">
                    {trace.execution.scope ??
                      "以下为关联事件的当前证据，可能包含其他来源消息推动的执行。"}
                  </p>
                  <dl>
                    <dt>执行状态</dt>
                    <dd>{facts(trace.execution.state)}</dd>
                    <dt>Codex 线程</dt>
                    <dd className="break-word">
                      {trace.execution.thread_id ?? "尚未创建"}
                    </dd>
                    <dt>执行轮次</dt>
                    <dd>{trace.execution.turn_id ?? "尚未创建"}</dd>
                  </dl>
                  {trace.execution.events?.map((e: Row) => (
                    <details className="execution-record" key={e.id}>
                      <summary>
                        {time(e.created_at)} · 执行记录 {e.id}
                      </summary>
                      <small>{e.event_type}</small>
                      <ConversationContent
                        content={e.content || "该记录暂无文本内容"}
                      />
                    </details>
                  ))}
                  {trace.execution.events_truncated && (
                    <p className="muted">
                      此处展示部分执行记录，可进入事件查看完整证据。
                    </p>
                  )}
                  {!!trace.execution.artifacts?.length && (
                    <p>已保存 {trace.execution.artifacts.length} 项事件产物</p>
                  )}
                </article>
              )}
              {trace.task && trace.live_stages?.watchdog && (
                <article className="linked-record">
                  <h3>运行守护记录</h3>
                  <p>{trace.live_stages.watchdog.note}</p>
                  <WatchdogRuns runs={trace.live_stages.watchdog.runs} />
                  <p>
                    {trace.live_stages.watchdog.outcome_unknown
                      ? "执行结果未知，需要人工核验"
                      : "当前未标记执行结果未知"}
                  </p>
                  {trace.live_stages.watchdog.last_error && (
                    <p className="danger">
                      {trace.live_stages.watchdog.last_error}
                    </p>
                  )}
                </article>
              )}
              {!!(
                trace.subscriptions.length || trace.target_subscriptions?.length
              ) && (
                <article className="linked-record">
                  <h3>订阅关系</h3>
                  {[
                    ...trace.subscriptions,
                    ...(trace.target_subscriptions ?? []),
                  ].map((s: Row, index: number) => (
                    <div key={`${s.id}-${index}`}>
                      <p>
                        {s.thread_id
                          ? `${sources[s.source] ?? "来源"}会话订阅`
                          : subscriptionLabel(s.route_key ?? "")}{" "}
                        →{" "}
                        <button onClick={() => onOpenTask(String(s.task_id))}>
                          {s.task_title ?? `事件 ${s.task_id}`}
                        </button>
                      </p>
                      <details>
                        <summary>订阅引用详情</summary>
                        <dl>
                          <dt>完整引用标识</dt>
                          <dd className="break-word">
                            {s.route_key ?? s.thread_id}
                          </dd>
                          <dt>订阅编号</dt>
                          <dd>{s.id}</dd>
                        </dl>
                      </details>
                    </div>
                  ))}
                </article>
              )}
              {!!trace.deliveries.length && (
                <article className="linked-record">
                  <h3>回复交付</h3>
                  {trace.deliveries.map((d: Row, i: number) => (
                    <div key={d.draft?.id ?? i}>
                      <p>{d.draft?.content ?? "回复草稿"}</p>
                      <small>
                        {facts(
                          d.record?.status ??
                            d.draft?.status ??
                            "等待审批或发布",
                        )}
                      </small>
                    </div>
                  ))}
                </article>
              )}
              <div className="actions wrap">
                <button onClick={onManage}>检查身份与项目配置</button>
                <button disabled={busy} onClick={() => void retry()}>
                  {busy ? "正在重新处理…" : "重新路由此事件"}
                </button>
              </div>
              </details>
            </>
          )}
        </section>
      </div>
    </>
  );
}
