import { useId, useState } from "react";
import { Modal } from "./Modal";

type Project = {id: number; name: string; enabled: boolean};
export function ProjectRebind({task, projects, busy, onRebind}: {
  task: {project_id: string}; projects: Project[]; busy: boolean;
  onRebind: (projectId: number, reason: string) => Promise<boolean>;
}) {
  const [target, setTarget] = useState("");
  const [reason, setReason] = useState("");
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const title = useId();
  const options = projects.filter(p => p.enabled && String(p.id) !== String(task.project_id));
  if (!options.length) return null;
  function close() { setOpen(false); setTarget(""); setReason(""); setError(""); }
  return <>
    <button type="button" aria-haspopup="dialog" disabled={busy} onClick={() => setOpen(true)}>更改所属项目</button>
    {open && <Modal className="action-confirm-dialog" labelledBy={title} busy={busy} onClose={close}>
      <h2 id={title}>更改所属项目</h2>
      <p className="muted">消息和历史结果会保留。确认后可在新项目的独立工作区继续。</p>
      {error && <p role="alert">{error}</p>}
      <form onSubmit={async e => {
        e.preventDefault();
        if (busy || !target || !reason.trim()) return;
        setError("");
        if (await onRebind(Number(target), reason.trim())) close();
        else setError("更改未保存。请核对事件状态和目标项目后重试。");
      }}>
        <label>目标项目<select required data-dialog-autofocus value={target} onChange={e => setTarget(e.target.value)}>
          <option value="">选择项目</option>
          {options.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select></label>
        <label>更换原因<input required value={reason} maxLength={1000} onChange={e => setReason(e.target.value)} /></label>
        <div className="actions wrap">
          <button type="button" disabled={busy} onClick={close}>返回</button>
          <button className="primary" disabled={busy || !target || !reason.trim()}>保存所属项目</button>
        </div>
      </form>
    </Modal>}
  </>;
}
