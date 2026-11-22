import { useEffect, useId, useState, type FormEvent } from "react";
import { request } from "./api";

type Material = { content: string; thread_id?: string; project_path?: string; status?: string; kind?: string; state_version?: number };
type ReturnStatus = { status: string; reason: string | null };
const threadIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

export function HandoffPanel({ taskId, blocked = false, canLink = false }:
  { taskId: number | string; blocked?: boolean; canLink?: boolean }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [material, setMaterial] = useState<Material>();
  const [chat, setChat] = useState("");
  const [turn, setTurn] = useState("");
  const [returnStatus, setReturnStatus] = useState<ReturnStatus>();
  const [linking, setLinking] = useState(false);
  const [linkError, setLinkError] = useState("");
  const contentId = useId();
  const returnUrl = `/sessions/worker:${taskId}/handoff-return`;
  const canReturn = canLink && material?.status === "paused" && ["reply", "analysis"].includes(material.kind ?? "");

  useEffect(() => {
    if (!open || !canReturn || linking || returnStatus && returnStatus.status !== "waiting") return;
    let stopped = false;
    async function refresh() {
      try {
        const result = await request<ReturnStatus>(returnUrl);
        if (!stopped) setReturnStatus(result);
      } catch { /* The server keeps checking even when the page cannot refresh. */ }
    }
    const initially = setTimeout(() => void refresh(), 0);
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      stopped = true;
      clearTimeout(initially);
      clearInterval(timer);
    };
  }, [open, canReturn, linking, returnUrl, returnStatus?.status]);

  async function prepare() {
    setBusy(true);
    setError("");
    setMaterial(undefined);
    setReturnStatus(undefined);
    setLinkError("");
    try {
      let { task } = await request<any>(`/tasks/${taskId}`);
      if (
        ![
          "paused",
          "failed",
          "review_ready",
          "completed",
          "cancelled",
        ].includes(task.status)
      ) {
        await request(`/tasks/${taskId}/controls`, {
          action: "pause",
          expected_state_version: task.state_version,
        });
      }
      for (let i = 0; i < 20; i++) {
        ({ task } = await request<any>(`/tasks/${taskId}`));
        if (task.outcome_unknown)
          throw new Error("停止结果尚未确认，请先核验执行状态。");
        if (
          [
            "paused",
            "failed",
            "review_ready",
            "completed",
            "cancelled",
          ].includes(task.status)
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      const result = await request<Material>(
        `/sessions/worker:${taskId}/handoff`,
        {},
      );
      setMaterial(result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function link(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const threadId = chat.trim().replace(/^codex:\/\/threads\//, "");
    if (!threadIdPattern.test(threadId) || turn.trim() && !threadIdPattern.test(turn.trim())) {
      setLinkError("请粘贴 Codex 会话链接或编号，并核对选填的轮次编号。");
      return;
    }
    setLinkError("");
    setLinking(true);
    try {
      setReturnStatus(await request<ReturnStatus>(returnUrl, {
        thread_id: threadId,
        ...(turn.trim() ? { turn_id: turn.trim() } : {}),
        expected_state_version: material?.state_version,
      }));
    } catch (e) {
      setLinkError((e as Error).message);
    } finally {
      setLinking(false);
    }
  }
  return (
    <>
      <button type="button" aria-expanded={open} aria-controls={open ? contentId : undefined}
        disabled={busy || (!open && blocked)} onClick={() => {
        setOpen(!open);
        if (!open) void prepare();
      }}>{busy ? "正在等待执行安全退出…" : open ? "收起接管材料" : "由我接着做"}</button>
      {open && <div className="event-handoff-content" id={contentId} aria-busy={busy}>
      <p className="muted">
        接管后任务暂停。请带着以下材料在 Codex 排查，再把结论补充到原事件。
      </p>
      {error && <p role="alert">{error}</p>}
      {material && (
        <>
          <div className="actions wrap">
            {material.thread_id && threadIdPattern.test(material.thread_id) &&
              <a href={`codex://threads/${material.thread_id}`}>查看原 Codex 会话</a>}
            {material.project_path &&
              <a href={`codex://new?path=${encodeURIComponent(material.project_path)}`}>在事件项目中打开新会话</a>}
          </div>
          <textarea
            aria-label="Codex 接管材料"
            readOnly
            rows={6}
            value={material.content}
          />
          <button
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(material.content);
              } catch {
                setError("复制不可用，请手动选中材料复制。");
              }
            }}
          >
            复制接管材料
          </button>
          {canReturn && <form className="event-handoff-return" onSubmit={event => void link(event)}>
            <label>Codex 排查会话链接或编号
              <input value={chat} required aria-describedby={`${contentId}-return-hint`}
                onChange={event => { setChat(event.target.value); setLinkError(""); }} />
            </label>
            <label>排查轮次编号（选填）
              <input value={turn} onChange={event => { setTurn(event.target.value); setLinkError(""); }} />
            </label>
            <p id={`${contentId}-return-hint`} className="muted">提交时选定排查轮次，留空取当时的最后一轮。该轮完成后，结论会回到原事件并继续只读分析。</p>
            {linkError && <p role="alert">{linkError}</p>}
            <button type="submit" disabled={linking || returnStatus?.status === "imported"}>
              {linking ? "正在关联…" : "关联并自动继续"}
            </button>
            <p role="status">
              {returnStatus?.status === "waiting" && (returnStatus.reason ?? "等候选定轮次完成，关闭此页面后仍会继续。")}
              {returnStatus?.status === "imported" && "排查结论已补充到原事件，可查看只读分析进度。"}
              {["failed", "stale"].includes(returnStatus?.status ?? "") && returnStatus?.reason}
            </p>
          </form>}
        </>
      )}
    </div>}</>
  );
}
