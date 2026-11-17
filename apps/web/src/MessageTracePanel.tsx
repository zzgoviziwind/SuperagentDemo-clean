import { useEffect, useState } from "react";
import { request, statusNames } from "./api";
import { reasonText } from "./InboxPanel";

type Row = Record<string, any>;
type Receipt = Row & {
  id: number;
  content: string;
  data: Row;
  task_id?: number;
};
type Page = { items: Receipt[]; has_more: boolean; next_after: number };
type Detail = { task: Row; events: Row[]; artifacts: Row[]; approvals: Row[] };
type Node = {
  title: string;
  state: string;
  summary: string;
  evidence: unknown;
};
const scopes = [
  "pending_confirmation",
  "routed",
  "self_echo",
  "self_echo_candidate",
];
const time = (value?: string) =>
  value ? new Date(value).toLocaleString("zh-CN") : "尚无记录";
const routeNames: Record<string, string> = {
  pending_confirmation: "待确认",
  routed: "已关联事件",
  self_echo: "自身回复回声",
  self_echo_candidate: "待核对回复回声",
};

export function traceNodes(
  event: Receipt,
  detail: Detail | null,
  deliveries: Row[],
): Node[] {
  const data = event.data;
  const task = detail?.task;
  const reason = data.routing_reason ?? "";
  const pending = data.routing_status === "pending_confirmation";
  const identityBlocked =
    pending && /^(actor_|identity_|project_binding_)/.test(reason);
  const echo = ["self_echo", "self_echo_candidate"].includes(
    data.routing_status,
  );
  const routed = data.routing_status === "routed";
  const taskSummary = task
    ? `${statusNames[task.status] ?? task.status}${task.last_error ? ` · ${task.last_error}` : ""}`
    : "尚无关联事件记录";
  return [
    {
      title: "渠道触发",
      state: "done",
      summary: `${event.source} · ${time(data.occurred_at)}`,
      evidence: {
        message_id: data.metadata?.message_id,
        actor_id: data.actor_id,
        thread_id: data.thread_id,
        external_id: event.external_id,
      },
    },
    {
      title: "事件收件与去重",
      state: "done",
      summary: `已持久化 · 事件 ${event.id}`,
      evidence: {
        created_at: event.created_at,
        routing_status: data.routing_status,
        reconciled_duplicate_of: data.reconciled_duplicate_of,
      },
    },
    {
      title: "身份与项目授权",
      state: identityBlocked ? "blocked" : routed || pending ? "done" : "idle",
      summary: identityBlocked
        ? reasonText(reason)
        : routed || pending
          ? "路由时授权已通过"
          : "查看路由记录",
      evidence: {
        actor_id: data.actor_id,
        actor: data.actor,
        project_external_id: data.project_external_id,
        routing_reason: reason,
      },
    },
    {
      title: "Router 意图与事件路由",
      state: pending && !identityBlocked ? "blocked" : routed ? "done" : "idle",
      summary: pending
        ? reasonText(reason)
        : echo
          ? routeNames[data.routing_status]
          : `关联事件 ${event.task_id ?? "待定"}`,
      evidence: data,
    },
    {
      title: "Worker 会话与上下文",
      state: task?.codex_thread_id ? "done" : task ? "current" : "idle",
      summary: task ? `事件 ${task.id} · ${taskSummary}` : "等待路由",
      evidence: task ?? {},
    },
    {
      title: "Codex 隔离执行环境",
      state:
        task?.outcome_unknown || task?.status === "failed"
          ? "blocked"
          : task?.status === "running"
            ? "current"
            : task?.codex_turn_id
              ? "done"
              : "idle",
      summary: task?.outcome_unknown
        ? "执行结果未知，待核验"
        : task?.codex_turn_id
          ? taskSummary
          : "尚无执行轮次记录",
      evidence: {
        workspace_path: task?.workspace_path,
        codex_thread_id: task?.codex_thread_id,
        codex_turn_id: task?.codex_turn_id,
        artifacts: detail?.artifacts,
      },
    },
    {
      title: "人工审批与验收",
      state: ["waiting_approval", "review_ready"].includes(task?.status)
        ? "current"
        : task?.status === "completed"
          ? "done"
          : "idle",
      summary:
        task?.status === "completed"
          ? "事件已验收"
          : task
            ? taskSummary
            : "等待事件",
      evidence: {
        approvals: detail?.approvals ?? [],
        events:
          detail?.events.filter((e) =>
            /approval|acceptance/.test(e.event_type),
          ) ?? [],
      },
    },
    {
      title: "原渠道交付",
      state: deliveries.some((d) => d.delivery?.write_status === "unknown")
        ? "blocked"
        : deliveries.some((d) => d.delivery?.write_status === "succeeded")
          ? "done"
          : deliveries.length
            ? "current"
            : "idle",
      summary: deliveries.length
        ? `${deliveries.length} 条事件级回复记录`
        : "尚无事件级回复记录",
      evidence: deliveries,
    },
  ];
}

export function MessageTracePanel({
  onOpenTask,
  onManage,
}: {
  onOpenTask: (id: number) => void;
  onManage: () => void;
}) {
  const [pages, setPages] = useState<Record<string, Page>>({});
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [deliveries, setDeliveries] = useState<Row[]>([]);
  const [nodeIndex, setNodeIndex] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [readAt, setReadAt] = useState("");
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const results = await Promise.all(
          scopes.map(async (scope) => {
            // Refresh every loaded page so rerouted messages leave their previous category.
            const items: Receipt[] = [];
            let after = 0;
            let result: Page;
            const target = pages[scope]?.next_after ?? 0;
            do {
              result = await request<Page>(
                `/events?routing_status=${scope}&after=${after}&limit=100`,
              );
              items.push(...result.items);
              after = result.next_after;
            } while (result.has_more && after < target);
            return [scope, { ...result, items }] as const;
          }),
        );
        if (active) {
          setPages(Object.fromEntries(results));
          setReadAt(new Date().toLocaleTimeString("zh-CN"));
          setError("");
        }
      } catch (e) {
        if (active) setError((e as Error).message);
      }
    }
    void load();
    const timer = window.setInterval(() => {
      if (!document.hidden) void load();
    }, 5000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [generation]);

  const events = Object.values(pages)
    .flatMap((p) => p.items)
    .sort((a, b) => b.id - a.id);
  const event = events.find((e) => e.id === selected) ?? events[0];
  const taskId = event?.task_id;
  useEffect(() => {
    let active = true;
    setDetail(null);
    setDeliveries([]);
    async function load() {
      if (!taskId) return;
      try {
        const [next, replies] = await Promise.all([
          request<Detail>(`/tasks/${taskId}`),
          request<Row[]>(`/tasks/${taskId}/deliveries`),
        ]);
        if (active) {
          setDetail(next);
          setDeliveries(replies);
        }
      } catch (e) {
        if (active) setError((e as Error).message);
      }
    }
    void load();
    const timer = window.setInterval(() => {
      if (!document.hidden) void load();
    }, 5000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [taskId, event?.id, generation]);

  async function more() {
    setBusy(true);
    try {
      const results = await Promise.all(
        Object.entries(pages)
          .filter(([, p]) => p.has_more)
          .map(async ([scope, page]) => {
            const next = await request<Page>(
              `/events?routing_status=${scope}&after=${page.next_after}&limit=100`,
            );
            const merged: Page = {
              ...next,
              items: [...page.items, ...next.items],
            };
            return [scope, merged] as const;
          }),
      );
      setPages((old) => ({ ...old, ...Object.fromEntries(results) }));
      setGeneration((g) => g + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const nodes = event
    ? traceNodes(event, detail?.task.id === taskId ? detail : null, deliveries)
    : [];
  const current = nodes[nodeIndex];
  return (
    <section className="message-trace">
      <div className="section-heading">
        <h2>消息轨迹</h2>
        <button onClick={() => setGeneration((g) => g + 1)}>刷新轨迹</button>
      </div>
      <p className="muted">
        选择消息查看真实接入记录。执行、验收和交付展示关联事件的当前记录。每 5
        秒刷新 · 最近读取 {readAt || "—"}
      </p>
      {error && (
        <p role="alert" className="alert error">
          {error}
        </p>
      )}
      <div className="trace-layout">
        <div className="trace-messages">
          <label>
            搜索消息
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="正文、来源或事件编号"
            />
          </label>
          <div className="trace-message-list">
            {events
              .filter((e) => `${e.id} ${e.source} ${e.content}`.includes(query))
              .map((e) => (
                <button
                  key={e.id}
                  aria-pressed={e.id === event?.id}
                  onClick={() => {
                    setSelected(e.id);
                    setNodeIndex(0);
                  }}
                >
                  <small>
                    {e.source} · #{e.id} · {routeNames[e.data.routing_status]}
                  </small>
                  <span>{e.content}</span>
                  <small>{time(e.created_at)}</small>
                </button>
              ))}
          </div>
          {!events.length && <p>暂无消息记录</p>}
          {Object.values(pages).some((p) => p.has_more) && (
            <button disabled={busy} onClick={() => void more()}>
              加载更多消息
            </button>
          )}
        </div>
        <div className="trace-content">
          {event && (
            <>
              <div className="trace-caption">
                <strong>事件 {event.id}</strong>
                <p>{event.content}</p>
              </div>
              <div className="trace-legend">
                <span>● 已有记录</span>
                <span>◉ 当前处理</span>
                <span>● 阻塞</span>
                <span>○ 待到达／无记录</span>
              </div>
              <div className="trace-diagram" aria-label="消息处理架构图">
                {nodes.map((node, index) => (
                  <div className="trace-step" key={node.title}>
                    <button
                      className={`trace-node ${node.state}`}
                      aria-pressed={index === nodeIndex}
                      onClick={() => setNodeIndex(index)}
                    >
                      <strong>{node.title}</strong>
                      <span>{node.summary}</span>
                    </button>
                    {index < nodes.length - 1 && (
                      <span className="trace-arrow" aria-hidden="true">
                        ↓
                      </span>
                    )}
                  </div>
                ))}
                <div className="trace-storage">
                  <strong>Session 数据库 · 持久状态</strong>
                  <span>来源事件、事件会话、执行产物、审批与交付账本</span>
                </div>
              </div>
              {current && (
                <div className="trace-evidence">
                  <h3>{current.title}</h3>
                  <p>{current.summary}</p>
                  {nodeIndex === 2 && (
                    <button onClick={onManage}>打开管理设置</button>
                  )}
                  {taskId && (
                    <button onClick={() => onOpenTask(taskId)}>
                      查看事件 {taskId}
                    </button>
                  )}
                  <details open>
                    <summary>查看记录依据</summary>
                    <pre>{JSON.stringify(current.evidence, null, 2)}</pre>
                  </details>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
