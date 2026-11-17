import { useId, useState } from "react";
import { request } from "./api";

export function HandoffPanel({ taskId, blocked = false }: { taskId: number | string; blocked?: boolean }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [material, setMaterial] = useState("");
  const contentId = useId();
  async function prepare() {
    setBusy(true);
    setError("");
    setMaterial("");
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
      const result = await request<any>(
        `/sessions/worker:${taskId}/handoff`,
        {},
      );
      setMaterial(result.content);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
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
        先暂停自动执行，再带着目标、工作目录和已有成果前往
        Codex。人工进展需回到事件补充。
      </p>
      {error && <p role="alert">{error}</p>}
      {material && (
        <>
          <p>
            在 Codex
            打开下方工作目录，查找原会话继续；无法找到时，将材料粘贴到新会话。
          </p>
          <textarea
            aria-label="Codex 接管材料"
            readOnly
            rows={12}
            value={material}
          />
          <button
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(material);
              } catch {
                setError("复制不可用，请手动选中材料复制。");
              }
            }}
          >
            复制接管材料
          </button>
        </>
      )}
    </div>}</>
  );
}
