import { ProjectRebind } from "./ProjectRebind";
import { InlineAgentCheck } from "./InlineAgentCheck";
import { SettingsDrawer } from "./SettingsDrawer";
import { Modal } from "./Modal";
import { MessageRecords } from './MessageRecords';
import { ConversationContent } from './ConversationContent';
import { ProjectWorkspaceFields } from './ProjectWorkspaceFields';
import { GroupedEvents } from "./GroupedEvents";
import { FieldImplementation, FieldIntake } from "./FieldIntake";
import { EventGroupDiagnostics } from "./EventGroups";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ApiError,
  request,
  statusNames,
  isDeliveryApproval,
} from "./api";
import { GovernancePanel } from "./GovernancePanel";
import { DeliveriesPanel, emptyReplyEdit, type ReplyEdit } from "./DeliveriesPanel";
import { ArchitecturePanel, SubscriptionsPanel } from "./ArchitecturePanel";
import { SessionWorkbench } from "./SessionWorkbench";
import { RoutingPanel } from "./RoutingPanel";
import { OperationsPanel } from "./OperationsPanel";
import { HandoffPanel } from "./HandoffPanel";
import { EventRulesPanel } from "./EventRulesPanel";
import { replyNeedsEngine } from "./EventNextStep";
import type { EventScope } from "./eventState";
import "./style.css";
import "./workbench-theme.css";
import "./ide-shell.css";
import "./darcula.css";
import { WorkbenchIcon } from "./WorkbenchIcon";
import { ContentPaletteSelect } from "./ContentPaletteSelect";

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
const workspacePaths = ["/tasks", "/projects", "/connectors", "/health", "/settings", "/auth/me"] as const;
type WorkspacePath = typeof workspacePaths[number];
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
  repositories: [] as {path: string; base_branch: string}[],
  name: "",
  repo_path: "",
  base_branch: "main",
  test_command: "",
  reference_access: "workspace",
  reference_dirs: "",
  allowed_paths: "",
  dingtalk_chat_ids: "",
  redmine_project_ids: "",
  enabled: true,
};

export function App() {
  const [sessionId, setSessionId] = useState("");
  const [configTarget, setConfigTarget] = useState("");
  const [focusedGroup, setFocusedGroup] = useState<string>();
  const [eventScope, setEventScope] = useState<EventScope>({ status:"", project:"" });
  const [eventHomeVersion, resetEventHome] = useState(0);
  const [page, setPage] = useState("事件中心");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [projects, setProjects] = useState<Row[]>([]);
  const [connectors, setConnectors] = useState<Row[]>([]);
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
  const inFlight = useRef(new Map<string, Promise<unknown>>());
  const [workspaceErrors, setWorkspaceErrors] = useState<Partial<Record<WorkspacePath, string>>>({});
  const [taskError, setTaskError] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState("");
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({
    title: "",
    goal: "",
    project_id: "",
    acceptance_criteria: "",
    kind: "repair",
  });
  const [project, setProject] = useState(emptyProject);
  const [projectEditorOpen, setProjectEditorOpen] = useState(false);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [pathMode, setPathMode] = useState("none");
  const [reconcileEvidence, setReconcileEvidence] = useState("");
  const [reconcileOutcome, setReconcileOutcome] = useState("");
  const [replySnapshot, setReplySnapshot] = useState<{ taskId: string; drafts: Record<string, any>[] | null }>();
  const [replyEdits, setReplyEdits] = useState<Record<string, ReplyEdit>>({});
  const [ending, setEnding] = useState<{ id: string; version: number } | null>(null);
  const [message, setMessage] = useState("");
  const [changeGoal, setChangeGoal] = useState(false);
  const [review, setReview] = useState("");
  const [controlError, setControlError] = useState("");

  const clearEvent = useCallback(() => {
    selected.current = null;
    setFocusedGroup(undefined);
    setDetail(null);
    setTaskError("");
    setEnding(null);
  }, []);

  const expireSession = useCallback(() => {
    clearEvent();
    setReplyEdits({});
    setUser(null);
    setLoginOpen(true);
    setTasks([]);
    setProjects([]);
  }, [clearEvent]);

  const read = useCallback(async <T,>(path: string, afterWrite = false): Promise<T> => {
    const previous = inFlight.current.get(path);
    if (previous && afterWrite) await previous.catch(() => {});
    let pending = inFlight.current.get(path);
    if (!pending) {
      pending = request<T>(path).finally(() => inFlight.current.delete(path));
      inFlight.current.set(path, pending);
    }
    return pending as Promise<T>;
  }, []);

  const refreshWorkspace = useCallback(async (paths: readonly WorkspacePath[], afterWrite = false) => {
    const results = await Promise.allSettled(paths.map(path => read<any>(path, afterWrite)));
    const errors: Partial<Record<WorkspacePath, string>> = {};
    let expired = false;
    results.forEach((result, index) => {
      const path = paths[index];
      if (result.status === "rejected") {
        errors[path] = (result.reason as Error).message;
        expired ||= result.reason instanceof ApiError && result.reason.status === 401;
        return;
      }
      errors[path] = "";
      switch (path) {
        case "/tasks": setTasks(result.value); break;
        case "/projects": setProjects(result.value); break;
        case "/connectors": setConnectors(result.value); break;
        case "/health": setHealth(result.value); break;
        case "/settings": setSettings(result.value); break;
        case "/auth/me": setUser(result.value); setLoginOpen(false); break;
      }
    });
    if (expired) expireSession();
    setWorkspaceErrors(previous => ({ ...previous, ...errors }));
    setLoading(false);
    setLastRefresh(new Date().toLocaleTimeString("zh-CN"));
  }, [expireSession, read]);

  const refreshTask = useCallback(async (id: string, afterWrite = false) => {
    if (selected.current !== id) return;
    try {
      const next = await read<Detail>(`/tasks/${encodeURIComponent(id)}`, afterWrite);
      if (selected.current === id) {
        setDetail(previous => previous && String(previous.task.id) === id &&
          previous.task.state_version > next.task.state_version ? previous : next);
        setTaskError("");
      }
    } catch (e) {
      if (selected.current !== id) return;
      if (e instanceof ApiError && e.status === 401) expireSession();
      setTaskError((e as Error).message);
    }
  }, [expireSession, read]);

  const refresh = useCallback(async () => {
    await Promise.all([
      refreshWorkspace(workspacePaths, true),
      selected.current ? refreshTask(selected.current, true) : undefined,
    ]);
  }, [refreshTask, refreshWorkspace]);

  useEffect(() => {
    void refreshWorkspace(workspacePaths);
  }, [refreshWorkspace]);

  useEffect(() => {
    if (!user || busy || (page !== "运行状态" && page !== "事件中心")) return;
    let polling = false;
    async function poll() {
      if (document.hidden || polling) return;
      polling = true;
      try {
        if (page === "运行状态") await refreshWorkspace(["/health", "/connectors"]);
        else if (selected.current) await refreshTask(selected.current);
      } finally {
        polling = false;
      }
    }
    const onVisible = () => { if (!document.hidden) void poll(); };
    const timer = window.setInterval(() => {
      void poll();
    }, 5000);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [Boolean(user), busy, page, refreshTask, refreshWorkspace]);

  async function mutate(operation: () => Promise<unknown>, success?: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await operation();
      if (success) setNotice(success);
      await refresh();
      return true;
    } catch (e) {
      setError((e as Error).message);
      if (e instanceof ApiError && e.status === 401) expireSession();
      if (e instanceof ApiError && e.status === 409)
        await refresh();
      return false;
    } finally {
      setBusy(false);
    }
  }
  const openTask = useCallback(async (value: string) => {
    const id = String(value);
    if (selected.current !== id) {
      setControlError("");
      setDetail(null);
      setTaskError("");
      setError("");
      setMessage("");
      setChangeGoal(false);
      setReview("");
      setReconcileEvidence("");
      setReconcileOutcome("");
      setEnding(null);
    }
    setFocusedGroup(id);
    selected.current = id;
    setPage("事件中心");
    await refreshTask(id);
  }, [refreshTask]);
  const signedIn = Boolean(user);
  useEffect(() => {
    if (!signedIn) return;
    const params = new URLSearchParams(window.location.search);
    const target = params.get("task") ?? "";
    const approval = params.get("approval") ?? "";
    if (/^[1-9]\d{0,15}$/.test(target) && /^[1-9]\d{0,15}$/.test(approval)) {
      void openTask(target);
    }
  }, [signedIn, openTask]);
  function navigate(next: string) {
    const [destination, target = ""] = next.split("#");
    const nextPage = ["任务", "事件"].includes(destination) ? "事件中心" : destination === "会话工作台" ? "Worker 工作台" : destination;
    if (page !== nextPage) clearEvent();
    setConfigTarget(target);
    setPage(nextPage);
  }
  async function control(action: string) {
    if (!detail || busy || detail.task.outcome_unknown || detail.task.last_error === "正在停止执行") return;
    const task = detail.task;
    setControlError("");
    await mutate(
      async () => {
        try {
          const next = await request<Task>(`/tasks/${encodeURIComponent(task.id)}/controls`, {
            action,
            expected_state_version: task.state_version,
          });
          if (selected.current !== String(task.id)) return;
          if (String(next?.id) === String(task.id) && next.state_version >= task.state_version) {
            setDetail(current => current && String(current.task.id) === String(task.id) &&
              current.task.state_version <= next.state_version ? { ...current, task: next } : current);
          }
          const message = next?.last_error === "正在停止执行" ? "停止请求已接收，执行端确认后更新状态。"
            : next?.status === "cancelled" ? "事件已结束，处理记录和原消息已保留。"
            : next?.status === "paused" ? "事件已暂停。"
            : action === "analyze" && next?.status === "queued" ? "已转为只读分析并进入队列。"
            : action === "resume" && next?.status === "queued" ? "已恢复处理并进入队列。"
            : "控制请求已接收。";
          setNotice(message);
          if (action === "cancel") setEnding(null);
        } catch (e) {
          if (selected.current === String(task.id)) {
            setControlError((e as Error).message);
            if (action === "cancel") setEnding(null);
          }
          throw e;
        }
      },
    );
  }
  const task = detail?.task;
  const controlBlocked = !!task?.outcome_unknown || task?.last_error === "正在停止执行";
  const readError = [...new Set([...Object.values(workspaceErrors), taskError].filter(Boolean))].join(" ");
  const canTaskWrite =
    isAdmin ||
    (user?.role === "member" &&
      !!task?.owner_id &&
      String(task.owner_id) === user.user_id);

  const eventSupplement = task && canTaskWrite && !["completed", "cancelled"].includes(task.status) ? (
    <details className="advanced-panel">
      <summary>补充给 Agent</summary>
      <p className="muted">补充会保存到本事件和执行会话。若任务正在等待人工处理，保存后请回到顶部点击「恢复」。</p>
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
            rows={3}
          />
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={changeGoal}
            onChange={(e) => setChangeGoal(e.target.checked)}
          />
          调整处理目标
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
          添加补充
        </button>
      </form>
    </details>
  ) : null;

  const endEventAction = task && canTaskWrite && task.status !== "cancelled" ? <>
    <button type="button" className="danger" disabled={busy || controlBlocked}
      onClick={() => setEnding({ id: String(task.id), version: task.state_version })}>结束事件</button>
    {ending?.id === String(task.id) && (
      <Modal className="action-confirm-dialog" labelledBy="end-event-title" busy={busy} onClose={() => setEnding(null)}>
        <h2 id="end-event-title">结束此事件？</h2>
        <p>事件「{task.title}」将移到「已结束」。原消息和处理记录会保留，未发送的旧审批将失效。</p>
        {(ending.version !== task.state_version || controlBlocked) && <p role="status">事件状态已变化，请返回核对后再操作。</p>}
        <div className="actions wrap">
          <button type="button" data-dialog-autofocus disabled={busy} onClick={() => setEnding(null)}>返回</button>
          <button type="button" className="danger" disabled={busy || controlBlocked || ending.version !== task.state_version}
            onClick={() => void control("cancel")}>确认结束事件</button>
        </div>
      </Modal>
    )}
  </> : null;
  const canAnalyzeReply = canTaskWrite && task?.kind === "reply" &&
    ["paused", "waiting_input", "review_ready", "completed", "cancelled", "failed"].includes(task.status);
  const canHandoff = canTaskWrite && task && !["cancelled", "completed"].includes(task.status);
  const eventControls = task && detail && (task.outcome_unknown || task.last_error === "正在停止执行" || canHandoff || canAnalyzeReply || task.status === "cancelled") ? (
    <div className="event-controls" key={task.id}>
      <h3>{task.status === "cancelled" ? "恢复选项" : "事件处理"}</h3>
      {task.status === "cancelled" && <p className="muted">关闭时间：{date([...detail.events].reverse().find((e: Row) => (e.event_type === "control" || e.event_type === "stopped") && e.content === "cancel")?.created_at ?? task.updated_at)}</p>}
      {replyNeedsEngine(task) && canTaskWrite && <div className="actions wrap engine-recovery">
        {isAdmin && <InlineAgentCheck key={task.id} />}
        <button className="primary" disabled={busy || controlBlocked} onClick={()=>void control("resume")}>重新执行回复</button>
      </div>}

      {task.last_error === "正在停止执行" && <p role="status">已请求停止 · 等待执行端确认</p>}
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
                if (busy || !reconcileOutcome || !reconcileEvidence.trim()) return;
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
                    "Worker 执行结果已核验。",
                  )
                )
                  if (selected.current === String(task.id)) {
                    setReconcileEvidence("");
                    setReconcileOutcome("");
                  }
              }}
            >
              <label>
                执行对账结果
                <select
                  required
                  value={reconcileOutcome}
                  onChange={(e) => setReconcileOutcome(e.target.value)}
                >
                  <option value="">请选择实际核验结论</option>
                  <option value="stopped">确认执行已停止</option>
                  <option value="abandoned">确认结束此事件</option>
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
              {reconcileOutcome && <p className="muted">{reconcileOutcome === "stopped" ? "提交后任务将进入已暂停，可手动恢复。" : "提交后任务将结束，原消息与处理记录会保留。"}</p>}
              <button disabled={busy || !reconcileOutcome || !reconcileEvidence.trim()}>
                提交执行对账
              </button>
            </form>
          )}
        </div>
      )}
      <div className="actions wrap task-control-actions" hidden={!canTaskWrite}>
        {canAnalyzeReply && <button className="primary" disabled={busy || controlBlocked} onClick={() => void control("analyze")}>改为只读分析</button>}
        {(task.status === "waiting_input"
          ? [["resume", "恢复"], ["pause", "暂停"]]
          : task.status === "queued"
          ? [["start", "启动"]]
          : ["paused", "cancelled"].includes(task.status)
            ? [["resume", task.status === "cancelled" ? "恢复原任务" : "恢复"]]
            : task.status === "failed"
              ? [["retry", "重试"]]
              : [
                    "running",
                    "waiting_approval",
                    "waiting_resource",
                  ].includes(task.status)
                ? [["pause", "暂停"]]
                : []
        ).map(([action, label]) => (
          <button
            key={action}
            disabled={busy || controlBlocked}
            onClick={() => void control(action)}
          >
            {label}
          </button>
        ))}
        {isAdmin && !controlBlocked && ["paused", "waiting_input", "review_ready", "failed"].includes(task.status) &&
        <ProjectRebind task={task} projects={projects as {id:number; name:string; enabled:boolean}[]} busy={busy}
          onRebind={(projectId, reason) => mutate(() => request(`/tasks/${task.id}/project`, {
            project_id: projectId, reason, expected_state_version: task.state_version,
          }), "所属项目已更换，确认后可在新工作区继续。")} />}
        {canHandoff && <HandoffPanel taskId={task.id} blocked={busy || controlBlocked} />}
      </div>
      {(canAnalyzeReply || canHandoff || task.status === "cancelled" && canTaskWrite) && <p className="muted control-hints">
        {task.status === "cancelled" && "恢复原任务会按原目标和类型重新排队。"}
        {canAnalyzeReply && "只读分析的结论仅保存在事件里。"}
        {canHandoff && "人工接管会暂停自动执行并生成接管材料。"}
      </p>}
    </div>
  ) : null;

  const hasReferenceReads = detail?.events.some(e => e.event_type === "analysis_reference_scope");
  const activeApprovals = detail?.approvals.filter(a =>
    a.status === "pending" && a.revision === task?.revision && a.control_version === task?.control_version
    && task?.status === "waiting_approval" && !task.outcome_unknown && !isDeliveryApproval(a)
  ) ?? [];
  const reviewLink = new URLSearchParams(window.location.search);
  const reviewLinkId = reviewLink.get("task") === String(task?.id) ? reviewLink.get("approval") : null;
  const eventReply = task && detail ? (
    <section className="event-reply-section"><h3>渠道回复</h3>
    {hasReferenceReads && <p className="muted">此事件使用了跨目录资料，结果仅在工作台内查看。</p>}
      <DeliveriesPanel
        key={task.id}
        taskId={String(task.id)}
        events={detail.events}
        approvals={detail.approvals}
        artifacts={detail.artifacts}
        revision={task.revision}
        taskStatus={task.status}
        outcomeUnknown={!!task.outcome_unknown}
        edit={replyEdits[task.id] ?? emptyReplyEdit}
        updateEdit={(update) => setReplyEdits(current => {
          const previous = current[task.id] ?? emptyReplyEdit;
          const next = update(previous);
          if (next === previous) return current;
          if (next.content || next.eventId) return { ...current, [task.id]: next };
          const remaining = { ...current };
          delete remaining[task.id];
          return remaining;
        })}
        controlVersion={task.control_version}
        canWrite={canTaskWrite && !hasReferenceReads}
        onSnapshot={setReplySnapshot}
        onChange={refresh}
      />
    </section>
  ) : null;
  const eventOperations = task && detail ? (
          <>
            {isAdmin && task.kind === 'analysis' && ['review_ready', 'completed'].includes(task.status) &&
              !task.outcome_unknown && detail.events.some(e => e.source === 'field' && e.event_type === 'message.received') &&
              <FieldImplementation key={`${task.id}:${task.state_version}`} id={String(task.id)} version={task.state_version}
                onOpen={id => void openTask(String(id))} />}
            <div className="detail-grid">
              <section aria-label="执行审批">
                {
                  (activeApprovals.length ? (
                    activeApprovals.map((a) => (
                      <article key={a.id} data-execution-approval={a.id} tabIndex={-1} className="artifact">
                        <strong>
                          {a.title ?? a.action_type ?? "动作审批"}
                        </strong>
                        <p>{isDeliveryApproval(a) ? "发送环节：批准后仍需确认发送，请先核对回复内容与收件渠道。" : "执行环节：请核对本次操作的用途与范围，再决定是否允许继续。"}</p><details><summary>查看操作范围与技术详情</summary><pre>{pretty(a.action ?? a.payload ?? a)}</pre></details>
                        <p>
                          状态 {a.status} · 版本 {a.revision ?? "—"}
                        </p>

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
                {reviewLinkId && !activeApprovals.some(a => String(a.id) === reviewLinkId) &&
                  <p role="status">此链接对应的审批已处理或失效，请查看任务当前状态。</p>}
              </section>
              <div>
                <section hidden={!canTaskWrite || task.status !== "review_ready" || task.kind === "reply"}>
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
            <EventGroupDiagnostics id={String(task.id)} onOpen={openTask} />
          </>
        ) : null;

  return (
    <div className="shell ide-shell">
      <header className="ide-toolbar">
        <a
          className="brand"
          aria-label="SuperAgent"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            clearEvent();
            resetEventHome(version => version + 1);
            navigate("事件中心");
          }}
        >
          <span className="logo" aria-hidden="true">S</span>
          <span className="brand-copy">SuperAgent</span>
        </a>
        <span className="ide-workspace-name">研发协作空间</span>
        <ContentPaletteSelect />
        {canWrite && <button className="primary ide-create" aria-haspopup="dialog" onClick={event => {
          event.currentTarget.focus({ preventScroll: true });
          setError("");
          setCreating(true);
        }}>＋ 提出事件</button>}
          <details className="ide-account"><summary>{user ? (user.name ?? user.username ?? user.user_id ?? user.role) : "账号与登录"}</summary><div className="account-actions">
            {user ? (
              <>
                <button
                  disabled={busy}
                  onClick={() =>
                    void mutate(async () => {
                      await request("/auth/logout", {});
                      setUser(null);
                      setReplyEdits({});
                      setTasks([]);
                      setProjects([]);
                      setDetail(null);
                      clearEvent();
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
          </div></details>
      </header>
      <aside className="ide-rail">
        <nav aria-label="主导航">
          {[
            { title: "工作空间", items: [["事件中心", "事件"], ["Worker 工作台", "Worker"], ...(isAdmin ? [["现场记录", "现场"]] : [])] },
            { title: "配置与连接", items: [["项目设置", "项目"], ...(isAdmin ? [["事件规则", "规则"], ["管理设置", "设置"]] : []), ["运行状态", "状态"]] },
          ].map(group => <div className="ide-tool-group" role="group" aria-label={group.title} key={group.title}>
            {group.items.map(([item, label]) => <button type="button" key={item} title={item} aria-label={item}
              aria-current={page === item ? "page" : undefined} onClick={() => navigate(item)}>
              <WorkbenchIcon name={item} /><span aria-hidden="true">{label}</span>
            </button>)}
          </div>)}
          {isAdmin && <details className="ide-tools-more">
            <summary title="更多工具" aria-label="更多工具" data-current={["消息记录", "订阅关系", "分派复核"].includes(page)}>
              <WorkbenchIcon name="更多工具" /><span aria-hidden="true">更多</span>
            </summary>
            <div className="ide-more-items">
              {["消息记录", "订阅关系", "分派复核"].map(item => <button type="button" key={item}
                aria-current={page === item ? "page" : undefined} onClick={event => {
                  const menu = event.currentTarget.closest("details");
                  if (menu) {
                    menu.open = false;
                    menu.querySelector("summary")?.focus();
                  }
                  navigate(item);
                }}><WorkbenchIcon name={item} />{item}</button>)}
            </div>
          </details>}
        </nav>
      </aside>
      <main className={page === "事件中心" ? "workspace-page event-center-page" : page === "Worker 工作台" ? "workspace-page worker-page" : page === "消息记录" ? "workspace-page" : "content-page"}>
        <header className="workbench-page-heading">
          <h1><WorkbenchIcon name={page} />{page}</h1>
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
        {!creating && error && (
          <div role="alert" className="alert error">{error}</div>
        )}
        {readError && (
          <div role="alert" className="alert error">
            {readError}
            <button onClick={() => void refresh()}>重新连接 / 刷新</button>
          </div>
        )}
        {notice && (
          <div role="status" className="alert success">
            {notice}
          </div>
        )}
        {loading && <p role="status">正在读取工作空间…</p>}

        {page === "消息记录" && isAdmin && <MessageRecords onOpenEvent={id => void openTask(id)} />}
        {page === "项目设置" && (
          <div className="project-settings">
            <section>
              <h2>已绑定项目</h2>
              {projects.length ? (
                projects.map((p) => (
                  <button
                    className={`project-row${String(projectId) === String(p.id) ? " selected" : ""}`}
                    aria-pressed={String(projectId) === String(p.id)}
                    key={p.id}
                    onClick={() => {
                      setProjectEditorOpen(true);
                      setProjectId(p.id);
                      setPathMode(p.allowed_paths?.includes(".") ? "all" : p.allowed_paths?.length ? "paths" : "none");
                      setProject({
                        ...emptyProject,
                        ...p,
                        allowed_paths: (p.allowed_paths ?? []).join("\n"),
                        reference_dirs: (p.reference_dirs ?? []).join("\n"),
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
                    <small>{p.repo_path}{String(settings.dingtalk_request_access?.default_project_id) === String(p.id) ? " · 默认工作区" : ""}</small>
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
                  setProjectEditorOpen(true);
                  setProjectId(null);
                  setPathMode("none");
                  setProject(emptyProject);
                }}
              >
                ＋ 添加项目
              </button>
            </section>
            {isAdmin && projectEditorOpen && <SettingsDrawer title={projectId ? `编辑项目 · ${project.name}` : "绑定项目"} onClose={() => setProjectEditorOpen(false)}>
              {error && <p role="alert" className="danger">{error}</p>}
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  const body = {
                    ...Object.fromEntries(Object.keys(emptyProject).map(key => [key, project[key as keyof typeof project]])),
                    allowed_paths:
                      pathMode === "all" ? ["."] : pathMode === "paths" ? lines(project.allowed_paths) : [],
                    reference_dirs: project.reference_access === "directories" ? lines(project.reference_dirs) : [],
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
                    setProjectEditorOpen(false);
                    setProjectId(null);
                    setProject(emptyProject);
                    setPathMode("none");
                  }
                }}
              >
                <ProjectWorkspaceFields key={projectId ?? "new"} path={project.repo_path} repositories={project.repositories} onChange={(repo_path, repositories) => setProject(current => ({...current, repo_path, repositories}))} />
                <label>
                  改动验收范围
                  <select
                    required
                    value={pathMode}
                    onChange={(e) => setPathMode(e.target.value)}
                  >
                    <option value="none">只读，不接受改动</option>
                    <option value="all">允许项目工作区内的改动</option>
                    <option value="paths">允许指定仓库相对路径</option>
                  </select>
                </label>
                <p className="muted">
                  只读分析可直接使用默认值。只有选择「指定仓库相对路径」时，才需要填写例如 hlzj/src。
                </p>
                <label>
                  Agent 读取范围
                  <select value={project.reference_access} onChange={e => setProject(current => ({...current, reference_access: e.target.value}))}>
                    <option value="workspace">仅当前事件的工作区</option>
                    <option value="projects">当前工作区 + 所有已启用项目（只读）</option>
                    <option value="directories">当前工作区 + 指定资料目录（只读）</option>
                  </select>
                </label>
                {project.reference_access === "directories" && <label>额外资料目录（每行一个绝对路径）
                  <textarea required value={project.reference_dirs} onChange={e => setProject(current => ({...current, reference_dirs: e.target.value}))} />
                </label>}
                {project.reference_access !== "workspace" && <p className="muted">
                  供管理员负责的只读分析使用。跨目录结果保留在本事件，不向原消息渠道发送。
                </p>}
                {Object.entries({
                  name: "项目名称",
                  repo_path: "项目根目录",
                  base_branch: "基线分支",
                  test_command: "验证命令（可选，仅修复任务使用）",
                  allowed_paths: "改动验收允许路径（每行一项）",
                  dingtalk_chat_ids: "绑定钉钉群（可选，每行一个群 ID）",
                  redmine_project_ids: "绑定 Redmine 项目（可选，每行一个项目 ID）",
                })
                  .filter(
                    ([key]) => (key !== "allowed_paths" || pathMode === "paths") && (key !== "base_branch" || !project.repositories.length),
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
                          list={key === "base_branch" ? "project-branches" : undefined}
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
                <div className="settings-drawer-footer">
                <button className="primary" disabled={busy}>
                  保存项目
                </button>
                {projectId && <button type="button" disabled={busy} onClick={async () => {
                  if (await mutate(() => request(`/projects/${projectId}`, {}, "DELETE"), "项目已移除，有历史记录的项目已归档。")) { setProjectEditorOpen(false); setProjectId(null); setProject(emptyProject); }
                }}>删除项目</button>}
                </div>
              </form>
            </SettingsDrawer>}
          </div>
        )}
        {page === "事件规则" && isAdmin && <EventRulesPanel projects={projects as {id: number; name: string}[]} />}
        {page === "管理设置" && isAdmin && (
          <GovernancePanel
            target={configTarget}
            onNavigate={navigate}
            settings={settings}
            projects={projects}
            onChange={refresh}
          />
        )}
        {page === "Worker 工作台" && user && (
          <SessionWorkbench
            initialSessionId={sessionId}
            onSelectSession={setSessionId}
            projects={projects}
            canWrite={canWrite}
            onOpenTask={(id) => void openTask(id)}
          />
        )}
        {page === "订阅关系" && isAdmin && (
          <SubscriptionsPanel
            projects={projects}
            onOpenTask={(id) => void openTask(id)}
          />
        )}
        {page === '现场记录' && isAdmin && <FieldIntake projects={projects.map(p => ({ id: p.id, name: p.name, enabled: p.enabled }))} onOpen={id => {
          setEventScope({ status: '', project: '' });
          void openTask(String(id));
        }} />}
        {page === "事件中心" && user && (
            <GroupedEvents key={eventHomeVersion} taskDetail={detail} initialGroupId={focusedGroup} operations={eventOperations} reply={eventReply} replySnapshot={replySnapshot} operationsId={task ? String(task.id) : undefined}
              linkedApprovalId={reviewLinkId}
              initialScope={eventScope} onScopeChange={setEventScope} projects={projects} canManage={isAdmin}
              overview={<ArchitecturePanel onNavigate={navigate} isAdmin={isAdmin} eventStatus={eventScope.status} />}
              endAction={endEventAction} controls={<>
                {controlError && <p role="alert" className="alert error">{controlError}</p>}
                {eventControls}
              </>} supplement={eventSupplement}
              onSelectGroup={id => { if (id) void openTask(id); else clearEvent(); }}
              onRefreshTask={id => refreshTask(id, true)}
              onOpenSession={(id) => {
                setSessionId(id);
                navigate("Worker 工作台");
              }}
              onOpenTask={(id) => void openTask(id)}
              onManage={() => navigate("管理设置")}
            />
        )}
        {page === "分派复核" && isAdmin && <section><h2>分派管理与人工复核</h2>
            {isAdmin && <RoutingPanel
              onOpenSession={(id) => {
                setSessionId(id);
                navigate("Worker 工作台");
              }}
            />}
</section>}
        {page === "运行状态" && (
          <>
            {isAdmin && (
              <OperationsPanel
                projects={projects}
                tasks={tasks}
                onOpenTask={(id) => void openTask(id)}
              />
            )}
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
                      <span className="badge">
                        {(
                          {
                            running: "运行中",
                            degraded: "部分连接异常",
                            policy_off: "响应已关闭",
                            disabled: "已停用",
                            stopped: "已停止",
                            failed: "连接失败",
                          } as Row
                        )[c.status] ?? c.status}
                      </span>
                      <p>
                        {c.configured ? "已配置" : "待配置"} ·{" "}
                        {c.enabled ? "已启用" : "未启用"}
                      </p>
                      <small>最后联系 {date(c.last_seen)}</small>
                      {c.warnings?.map((warning: string) => <p key={warning}>{warning}</p>)}
                      {c.scopes?.map((scope: Row, index: number) => (
                        <p key={index}>
                          {(
                            {
                              "all-direct": "私聊",
                              "all-group": "群聊",
                              "at-me": "群内 @本人",
                              group: "指定群",
                            } as Row
                          )[scope.kind] ?? scope.kind}{" "}
                          ·{" "}
                          {(
                            {
                              running: "接收中",
                              failed: "连接失败",
                              stopped: "已停止",
                              starting: "正在连接",
                            } as Row
                          )[scope.status] ?? scope.status}
                          {scope.last_error && (
                            <span className="danger">
                              {" "}
                              · {scope.last_error}
                            </span>
                          )}
                        </p>
                      ))}
                      {c.last_error && <p className="danger">{c.last_error}</p>}{!c.configured && <div className="alert"><p>待配置 · {(c.missing_configuration ?? []).join('、') || '请填写连接账号和接收范围'}</p><button onClick={() => navigate('管理设置')}>填写连接配置</button></div>}
                      {isAdmin && (
                        <div className="actions wrap">
                          {[
                            "running",
                            "ready",
                            "connected",
                            "degraded",
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
            <details className="advanced-panel">
              <summary>高级服务诊断</summary>
              <pre>{pretty(settings)}</pre>
              <p className="muted">凭据在服务环境或本机凭据管理中配置。</p>
            </details>
          </>
        )}

      </main>
      <footer className="ide-status">
        <span><span className={`dot ${health.status ? "online" : ""}`} aria-hidden="true" />{health.status ? "控制服务已连接" : "等待连接服务"}</span>
        {settings.service_mode === "preview" && <span className="ide-preview">独立预览 · 自动执行已关闭</span>}
        <span className="ide-channels">Web · 钉钉 · Redmine</span>
      </footer>
      {creating && (
        <Modal className="event-create-dialog" labelledBy="create-title" busy={busy} onClose={() => {
          setError("");
          setCreating(false);
        }}>
            <div className="section-heading">
              <h2 id="create-title">提出事件</h2>
              <button
                type="button"
                aria-label="关闭提出事件"
                disabled={busy}
                onClick={() => { setError(""); setCreating(false); }}
              >
                关闭
              </button>
            </div>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (busy) return;
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
                  }, "事件已登记，进入事件处理。");
              }}
            >
              <label>
                项目
                <select
                  data-dialog-autofocus
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
                处理方式
                <select
                  value={draft.kind}
                  onChange={(e) => setDraft({ ...draft, kind: e.target.value })}
                >
                  <option value="reply">回复消息</option>
                  <option value="repair">修复代码</option>
                  <option value="analysis">分析问题</option>
                </select>
              </label>
              <label>
                问题标题
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
              <div role="alert">
                {error && <p className="danger">
                  {error}
                </p>}
              </div>
              <button
                className="primary"
                disabled={busy || !projects.some((p) => p.enabled)}
              >
                {busy ? "正在提交…" : "登记事件"}
              </button>
            </form>
        </Modal>
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
