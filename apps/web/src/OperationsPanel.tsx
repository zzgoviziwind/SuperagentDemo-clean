import { useCallback, useEffect, useState } from "react";
import { request, statusNames } from "./api";
import { ConversationContent } from "./ConversationContent";

type Row = Record<string, any>;

export function OperationsPanel({
  onOpenTask,
  projects = [],
  tasks = [],
}: {
  onOpenTask: (id: string) => void;
  projects?: Row[];
  tasks?: Row[];
}) {
  const [nodes, setNodes] = useState<Row | null>(null);
  const [watchdog, setWatchdog] = useState<Row | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [projectId, setProjectId] = useState("");
  const [nodeId, setNodeId] = useState("");
  const [taskId, setTaskId] = useState("");
  const [reportId, setReportId] = useState("");
  const [content, setContent] = useState("");
  const [reconcile, setReconcile] = useState(false);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  async function act(path: string, body: Row, method = "POST") {
    setBusy(true);
    setErrors([]);
    setNotice("");
    try {
      await request(path, body, method, path.endsWith("/run") ? 260000 : 15000);
      setNotice("操作已提交，请核对最新运行记录。");
      setContent("");
      setReportId("");
      await load();
    } catch (e) {
      setErrors([(e as Error).message]);
    } finally {
      setBusy(false);
    }
  }
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    const results = await Promise.allSettled([
      request<Row>("/operations/nodes"),
      request<Row>("/operations/watchdog"),
    ]);
    const setters = [setNodes, setWatchdog];
    const labels = ["执行设备", "智能守护"];
    const nextErrors: string[] = [];
    results.forEach((result, index) => {
      if (result.status === "fulfilled") setters[index](result.value);
      else
        nextErrors.push(`${labels[index]}读取失败 · ${result.reason.message}`);
    });
    setErrors(nextErrors);
    setLoading(false);
  }, []);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (!document.hidden) void load();
    }, 10000);
    return () => window.clearInterval(timer);
  }, [load]);
  const nodeItems = Array.isArray(nodes)
    ? nodes
    : (nodes?.items ?? nodes?.nodes ?? []);
  const reports = Array.isArray(watchdog)
    ? watchdog
    : (watchdog?.items ?? watchdog?.reports ?? []);
  return (
    <section>
      <div className="section-heading">
        <h2>执行设备与智能守护</h2>
        <button disabled={loading} onClick={() => void load()}>
          刷新运行记录
        </button>
      </div>
      {errors.map((error) => (
        <p className="alert error" role="alert" key={error}>
          {error}
        </p>
      ))}
      <h3>执行设备</h3>
      {nodeItems.map((node: Row) => (
        <article className="linked-record" key={node.id}>
          <strong>{node.name ?? node.id}</strong>
          <p>
            {node.status ??
              (node.online === undefined
                ? "状态未提供"
                : node.online
                  ? "在线"
                  : "离线")}
          </p>
          {node.last_seen && (
            <p>
              最近连接 ·{" "}
              {new Date(
                typeof node.last_seen === "number"
                  ? node.last_seen * 1000
                  : node.last_seen,
              ).toLocaleString("zh-CN")}
            </p>
          )}
          {node.last_error && <p className="danger">{node.last_error}</p>}
          <details>
            <summary>设备绑定详情</summary>
            <ConversationContent content={JSON.stringify(node, null, 2)} />
          </details>
        </article>
      ))}
      {nodes && !nodeItems.length && <p className="empty">当前使用本机 Codex 执行。远端设备连接后在此显示。</p>}
      {!!projects.length && (
        <details className="advanced-panel">
          <summary>高级执行设备绑定</summary>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void act(
                `/operations/projects/${projectId}/execution-node`,
                { node_id: nodeId || null },
                "PATCH",
              );
            }}
          >
            <h3>项目执行设备</h3>
            <label>
              设备所属项目
              <select
                required
                value={projectId}
                onChange={(e) => {
                  setProjectId(e.target.value);
                  setNodeId(
                    nodes?.bindings?.find(
                      (b: Row) => String(b.project_id) === e.target.value,
                    )?.node_id ?? "",
                  );
                }}
              >
                <option value="">选择项目</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              执行设备
              <select
                value={nodeId}
                onChange={(e) => setNodeId(e.target.value)}
              >
                <option value="">本机 Codex</option>
                {nodeItems
                  .filter((n: Row) =>
                    n.project_ids?.some(
                      (id: number) => String(id) === projectId,
                    ),
                  )
                  .map((n: Row) => (
                    <option value={n.id} key={n.id}>
                      {n.id} · {n.online ? "在线" : "离线"}
                    </option>
                  ))}
              </select>
            </label>
            <button disabled={busy || !projectId}>保存设备绑定</button>
          </form>
        </details>
      )}
      {notice && (
        <p className="alert success" role="status">
          {notice}
        </p>
      )}
      <h3>智能守护</h3>
      {!!tasks.length && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act(`/operations/watchdog/tasks/${taskId}/run`, {});
          }}
        >
          <label>
            立即巡检事件
            <select
              required
              value={taskId}
              onChange={(e) => setTaskId(e.target.value)}
            >
              <option value="">选择事件</option>
              {tasks
                .filter((t) => !["completed", "cancelled"].includes(t.status))
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.title}
                  </option>
                ))}
            </select>
          </label>
          <button disabled={busy || !taskId}>执行一次智能巡检</button>
        </form>
      )}
      {watchdog?.enabled !== undefined && (
        <div className="actions"><p>周期检查{watchdog.enabled ? "已启用" : "已关闭"}</p><button disabled={busy} onClick={() => void act('/settings', {watchdog_enabled: !watchdog.enabled}, 'PATCH')}>{watchdog.enabled ? '关闭周期巡检' : '启用周期巡检'}</button></div>
      )}
      {watchdog?.last_error && (
        <p className="alert error">{watchdog.last_error}</p>
      )}
      {reports.map((report: Row) => (
        <article className="linked-record" key={report.id}>
          <div className="section-heading"><strong>事件 #{report.task_id} · 智能巡检</strong><small>{report.created_at && new Date(report.created_at).toLocaleString('zh-CN')}</small></div>
          <p>{statusNames[report.status] ?? report.status} · {({observe: "持续观察", needs_human: "需要人工介入", pause: "请求暂停"} as Row)[report.conclusion?.action ?? report.action] ?? report.conclusion?.action ?? report.action}</p>
          <ConversationContent content={report.summary ?? report.conclusion?.reason ?? report.reason ?? report.error ?? "等待巡检结论"} />
          {report.task_id && (
            <button onClick={() => onOpenTask(String(report.task_id))}>
              查看事件并介入
            </button>
          )}
          <button
            disabled={busy || report.status === "running"}
            onClick={() => {
              setReportId(String(report.id));
              setContent(report.correction ?? "");
              setReconcile(false);
            }}
          >
            纠正守护判断
          </button>
          <details>
            <summary>守护判断证据</summary>
            <ConversationContent content={JSON.stringify(report, null, 2)} />
          </details>
        </article>
      ))}
      {watchdog && !reports.length && <p className="empty">尚无智能守护结论</p>}
      {reportId && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act(
              `/operations/watchdog/${encodeURIComponent(reportId)}/messages`,
              { content, reconcile_unknown: reconcile },
            );
          }}
        >
          <label>
            守护纠正说明或核验证据
            <textarea
              required
              maxLength={10000}
              value={content}
              onChange={(e) => setContent(e.target.value)}
            />
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={reconcile}
              onChange={(e) => setReconcile(e.target.checked)}
            />
            已核验巡检未知结果
          </label>
          <button disabled={busy || !content.trim()}>保存守护纠正</button>
        </form>
      )}
      <details className="advanced-panel">
        <summary>设备与守护配置</summary>
        <p>
          设备身份与受管目录由服务端环境配置，项目设备可在此绑定，守护周期可在管理设置中调整。连接失败后核对设备进程、共享工作区路径与服务日志，再刷新运行记录。
        </p>
      </details>
    </section>
  );
}
