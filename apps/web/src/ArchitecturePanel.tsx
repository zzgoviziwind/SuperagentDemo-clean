import { useEffect, useState } from "react";
import { request } from "./api";
import { eventBucketStage, eventBuckets, topologyNames, type EventScope } from "./eventState";

type Row = Record<string, any>;
const modules = [
  {
    id: "trigger",
    name: "环境触发",
    en: "Trigger",
    text: "钉钉消息、Redmine 更新成为来源事件，保留原始内容与来源关联。",
    destination: "事件中心",
  },
  {
    id: "filter",
    name: topologyNames.filter,
    en: "Fast Filter / Slow Filter",
    text: "快速规则核对身份、项目和回声。启用语义路由后，模型判断工作意图。订阅命中时，消息直接进入已有 Worker。",
    destination: "事件中心",
  },
  {
    id: "router",
    name: topologyNames.router,
    en: "Router",
    text: "在共享事件摘要中判断新请求，创建或选择事件。每次 AI 分流有真实输入、输出和会话，人工可复核。",
    destination: "事件中心",
  },
  {
    id: "delivery",
    name: topologyNames.delivery,
    en: "Channels",
    text: "在工作台继续沟通，或审批后向原钉钉、Redmine 渠道发送回复，交付结果持久保存。",
    destination: "事件",
  },
  {
    id: "worker",
    name: topologyNames.worker,
    en: "Worker",
    text: "多个事件各自拥有隔离上下文，使用绑定的本机或共享卷设备执行，并保存验证证据。",
    destination: "会话工作台",
  },
  {
    id: "execution",
    name: topologyNames.execution,
    en: "Environment",
    text: "本机 Codex 和共享卷 daemon 承载模型执行，控制服务管理工作区、审批与最终验证。",
    destination: "运行状态",
  },
  {
    id: "session_db",
    name: topologyNames.session_db,
    en: "Session DB",
    text: "保存 Router、Worker 的可见消息、事件状态和来源关联，支持追踪、继续与恢复。",
    destination: "会话工作台",
  },
  {
    id: "watchdog",
    name: "智能守护",
    en: "Watchdog",
    text: "独立巡检会话读取已保存的事件证据，记录观察、人工介入或暂停决定，支持纠正与核验。",
    destination: "运行状态",
  },
];

const statusGuide = {
  triage: "来源消息待判断是否需要处理、归入哪个事件。",
  active: "消息正在识别，或事件已排队、正在执行。",
  needs_action: "可能在等待补充、审批或验收，也可能需要检查暂停、失败或资源异常。",
  finished: "已完成或关闭的事件可查历史记录；是否发出回复，以发送记录为准。",
} satisfies Record<Exclude<EventScope["status"], "">, string>;
const desktopNodes = [
  ["trigger", 10, 35, 170, 90],
  ["filter", 225, 35, 180, 100],
  ["router", 465, 30, 300, 110],
  ["delivery", 820, 35, 175, 90],
  ["worker-a", 390, 225, 190, 95],
  ["worker-b", 640, 225, 190, 95],
  ["execution", 865, 225, 130, 95],
  ["session_db", 340, 410, 490, 100],
  ["watchdog", 10, 410, 220, 100],
] as const;
const mobileNodes = [
  ["trigger", 105, 10, 150, 90],
  ["filter", 105, 150, 150, 110],
  ["router", 20, 350, 145, 100],
  ["delivery", 195, 350, 145, 100],
  ["worker-a", 20, 550, 145, 100],
  ["worker-b", 195, 550, 145, 100],
  ["execution", 195, 770, 145, 110],
  ["session_db", 20, 770, 145, 110],
  ["watchdog", 20, 960, 145, 100],
] as const;
const desktopEdges = [
  ["trigger-filter", "M180 80 H225"],
  ["filter-router", "M405 80 H465"],
  ["router-channels", "M765 80 H820"],
  ["filter-worker", "M315 135 V272 H390", "subscription"],
  ["router-worker-a", "M565 140 V180 H485 V225"],
  ["router-worker-b", "M695 140 V180 H735 V225"],
  ["router-db", "M465 110 H440 V170 H355 V410", "storage"],
  ["worker-a-db", "M485 320 V410", "storage"],
  ["worker-b-db", "M735 320 V410", "storage"],
  ["worker-a-environment", "M580 290 H605 V365 H850 V295 H865"],
  ["worker-b-environment", "M830 265 H865"],
  ["watchdog-db", "M230 460 H340", "storage"],
];
const mobileEdges = [
  ["trigger-filter", "M180 100 V150"],
  ["filter-router", "M155 260 V310 H92 V350"],
  ["router-channels", "M165 400 H195"],
  ["filter-worker", "M255 205 H350 V520 H267 V550", "subscription"],
  ["router-worker-a", "M92 450 V550"],
  ["router-worker-b", "M130 450 V495 H225 V550"],
  ["router-db", "M20 400 H9 V825 H20", "storage"],
  ["worker-a-db", "M65 650 V770", "storage"],
  ["worker-b-db", "M240 650 V705 H135 V770", "storage"],
  ["worker-a-environment", "M165 605 H180 V740 H240 V770"],
  ["worker-b-environment", "M300 650 V770"],
  ["watchdog-db", "M92 960 V880", "storage"],
];

export function TopologyGraph({
  route = [],
  nodeStates = {},
  mobile,
  active,
  onSelect,
  relatedNodes,
}: {
  route?: string[];
  nodeStates?: Record<string, string>;
  mobile: boolean;
  active: string;
  onSelect: (id: string) => void;
  relatedNodes?: readonly string[];
}) {
  const width = mobile ? 360 : 1000;
  const height = mobile ? 1080 : 550;
  const nodes = mobile ? mobileNodes : desktopNodes;
  const edges = mobile ? mobileEdges : desktopEdges;
  const suffix = mobile ? "mobile" : "desktop";
  return (
    <div
      className={`topology-graph topology-${suffix}`}
      style={{ aspectRatio: `${width}/${height}` }}
      aria-label="SuperAgent 分支架构"
    >
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="topology-lines"
        aria-label="处理方向与存储关系"
      >
        <defs>
          <marker
            id={`arrow-${suffix}`}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M0 0 L10 5 L0 10 Z" fill="currentColor" />
          </marker>
        </defs>
        {edges.map(([id, d, type]) => (
          <path
            key={id}
            data-edge={id}
            className={`topology-edge edge-${type ?? "flow"} ${route.includes(id) ? "event-route-active" : ""}`}
            d={d}
            markerEnd={`url(#arrow-${suffix})`}
          />
        ))}
        <text
          x={mobile ? 285 : 270}
          y={mobile ? 292 : 200}
          className="topology-edge-label"
        >
          订阅直达
        </text>
        <text
          x={mobile ? 130 : 600}
          y={mobile ? 485 : 174}
          className="topology-edge-label"
        >
          分派
        </text>
      </svg>
      {nodes.map(([nodeId, x, y, w, h]) => {
        const id = nodeId.startsWith("worker-") ? "worker" : nodeId;
        const item = modules.find((m) => m.id === id)!;
        return (
          <button
            key={nodeId}
            className={`topology-node topology-node-${id}`}
            aria-pressed={active === id}
            data-status-related={relatedNodes?.includes(id) || undefined}
            onClick={() => onSelect(id)}
            style={{
              left: `${(x / width) * 100}%`,
              top: `${(y / height) * 100}%`,
              width: `${(w / width) * 100}%`,
              height: `${(h / height) * 100}%`,
            }}
          >
            <small>{nodeStates[nodeId] ?? nodeStates[id] ?? item.en}</small>
            <strong>
              {item.name}
              {nodeId.startsWith("worker-")
                ? nodeId.endsWith("a")
                  ? " A"
                  : " B"
                : ""}
            </strong>
            <span>
              {id === "router"
                ? "共享上下文"
                : id === "worker"
                  ? "隔离上下文"
                  : id === "filter"
                    ? "规则校验 + 语义判定"
                    : id === "watchdog"
                      ? "读取持久证据"
                      : id === "delivery"
                        ? "工作台 · 钉钉 · Redmine"
                        : id === "execution"
                          ? "本机 / 共享卷设备"
                          : id === "trigger"
                            ? "消息与外部变化"
                            : "状态 · 消息 · 证据"}
            </span>
          </button>
        );
      })}
    </div>
  );
}
export function ArchitecturePanel({
  onNavigate,
  isAdmin,
  eventStatus = "",
}: {
  onNavigate: (page: string) => void;
  isAdmin: boolean;
  eventStatus?: EventScope["status"];
}) {
  const [data, setData] = useState<Row | null>(null);
  const [error, setError] = useState("");
  const [active, setActive] = useState("router");
  useEffect(() => {
    if (!isAdmin) return;
    let alive = true;
    const refresh = async () => {
      try {
        const next = await request<Row>("/architecture");
        if (alive) { setData(next); setError(""); }
      } catch(e) { if (alive) setError((e as Error).message); }
    };
    void refresh();
    return () => { alive = false; };
  }, [isAdmin]);
  const current = modules.find((item) => item.id === active)!;
  const guide = eventStatus ? statusGuide[eventStatus] : null;
  const relatedNodes = eventStatus ? eventBuckets[eventStatus].stages : undefined;
  const capability = (id: string) =>
    data?.stages
      ?.filter((stage: Row) =>
        id === "filter"
          ? ["fast_filter", "slow_filter"].includes(stage.stage)
          : stage.stage === id,
      )
      .map((stage: Row) => stage.capability)
      .join(" · ");
  return (
    <section className="architecture-panel topology-panel event-overview">
      <div className="section-heading">
        <div>
          <h2>架构总览</h2>
          <p className="muted">从消息到协作。点击图中模块查看说明，或选择左侧事件查看处理详情。</p>
        </div>
      </div>
      <div className="topology-status-guide">
        <div role="status">
          {eventStatus && guide ? (
            <>
              <p><strong>{eventBucketStage(eventStatus)}</strong> · {eventBuckets[eventStatus].label}</p>
              <p>{guide} 图中虚线框标出同名模块，实际进度请查看事件详情。</p>
            </>
          ) : <p>选择左侧状态，查看它通常对应的架构环节。</p>}
        </div>
        {!guide && <dl>
          {(Object.keys(statusGuide) as (keyof typeof statusGuide)[]).map(key => (
            <div key={key}><dt>{eventBucketStage(key)}</dt><dd>{eventBuckets[key].label}</dd></div>
          ))}
        </dl>}
      </div>
      {error && (
        <p className="alert error" role="alert">
          {error}
        </p>
      )}
      <TopologyGraph mobile={false} active={active} onSelect={setActive} relatedNodes={relatedNodes} />
      <TopologyGraph mobile active={active} onSelect={setActive} relatedNodes={relatedNodes} />
      <div className="topology-key">
        <span>实线表示处理、分派和存储方向</span>
        <span>虚线表示订阅命中后直达 Worker</span>
      </div>
      <div className="module-detail">
        <div>
          <h3>
            {current.name} <span className="muted">{current.en}</span>
          </h3>
          <p>{current.text}</p>
          <p className="capability-note">
            当前服务能力 ·{" "}
            {capability(active) || (isAdmin ? "正在读取" : "管理员可查看")}
          </p>
        </div>
        {current.destination !== "事件中心" && (isAdmin ||
          !["订阅关系", "管理设置"].includes(
            current.destination,
          )) && (
          <button onClick={() => onNavigate(current.destination)}>
            进入{current.destination} ↗
          </button>
        )}
      </div>
      {isAdmin && <div className="module-actions"><button onClick={() => onNavigate(active === "trigger" ? "管理设置#消息接入" : active === "execution" ? "管理设置#本机Agent" : active === "watchdog" || active === "router" || active === "worker" ? "管理设置#运行策略" : active === "delivery" ? "管理设置#回复审批" : active === "session_db" ? "会话工作台" : "事件规则")}>配置{current.name} ↗</button></div>}
      {active === "filter" && isAdmin && (
        <button onClick={() => onNavigate("订阅关系")}>管理直达订阅</button>
      )}
    </section>
  );
}

export function subscriptionLabel(routeKey: string) {
  const issue = routeKey.match(/(?:^|:)issue:(\d+)$/);
  if (issue) return `Redmine / 问题 #${issue[1]}`;
  if (routeKey.startsWith("dingtalk:message")) return "钉钉消息引用";
  if (routeKey.startsWith("redmine:message")) return "Redmine 事件引用";
  return "事件消息引用";
}

export function SubscriptionsPanel({
  projects,
  onOpenTask,
}: {
  projects: Row[];
  onOpenTask: (id: string) => void;
}) {
  const [data, setData] = useState<Row>({ items: [] });
  const [error, setError] = useState("");
  const [selectedStatuses, setSelectedStatuses] = useState<string[]>([]);
  const [project, setProject] = useState("");
  const busy = false;
  const notice = "";
  async function reload() { setData(await request<Row>("/subscriptions")); }
  useEffect(() => {
    let alive = true;
    request<Row>("/subscriptions")
      .then((value) => {
        if (alive) setData(value);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, []);
  const items = (data.items ?? []).filter(
    (row: Row) => !project || String(row.project_id) === project,
  );
  return (
    <section className="subscriptions-panel">
      <div className="section-heading">
        <div>
          <h2>来源跟进与历史关联</h2>
          <p className="muted">
            {data.scope ?? "查看来源会话、历史引用与目标事件之间的持久关联。"}
          </p>
        </div>
        <label>
          筛选项目
          <select value={project} onChange={(e) => setProject(e.target.value)}>
            <option value="">全部项目</option>
            {projects.map((p) => (
              <option value={p.id} key={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
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
      <button
        disabled={busy}
        onClick={() => {
          setError("");
          void reload().catch((e) => setError(e.message));
        }}
      >
        刷新订阅
      </button>
      <div className="subscription-list">
        {items.map((row: Row) => (
          <article
            className="subscription-card"
            key={`${row.subscription_type ?? "legacy"}-${row.id}`}
          >
            <div>
              <small>
                {row.subscription_type === "explicit"
                  ? "会话订阅"
                  : "历史消息引用"}
              </small>
              <strong>
                {row.thread_id
                  ? `${row.source === "dingtalk" ? "钉钉" : "Redmine"} / ${row.thread_id}`
                  : subscriptionLabel(row.route_key ?? "")}
              </strong>
            </div>
            <span aria-hidden>→</span>
            <div>
              <small>
                {row.project_name ??
                  projects.find((p) => String(p.id) === String(row.project_id))
                    ?.name ??
                  `项目 ${row.project_id}`}
              </small>
              <button onClick={() => onOpenTask(String(row.task_id))}>
                {row.task_title ?? `事件 ${row.task_id}`} ↗
              </button>
            </div>
            <details className="subscription-technical">
              <summary>技术详情</summary>
              <dl>
                <dt>完整引用标识</dt>
                <dd className="break-word">{row.route_key}</dd>
                <dt>事件编号</dt>
                <dd>{row.task_id}</dd>
                <dt>订阅编号</dt>
                <dd>{row.id}</dd>
              </dl>
            </details>
          </article>
        ))}
      </div>
      {!items.length && !error && (
        <p className="empty">
          暂无关联。来源事件进入事件后会在此展示；请在事件中管理持续跟进。
        </p>
      )}
    </section>
  );
}
