import { useCallback, useEffect, useState } from "react";
import { request, statusNames } from "./api";
type Row = Record<string, any>;
const eventNames: Record<string,string> = {created:"事件已登记", message:"补充信息", goal_changed:"目标调整", run_started:"Worker 开始处理", review_ready:"等待结果核验", control:"人工控制", collaboration_requested:"请求协作", collaboration_result:"协作结果返回", event_resolution:"事件处理结论", following_changed:"持续跟进变更", assistant_message:"Worker 处理记录", verification_incomplete:"验证尚未通过", workspace_prepared:"执行环境已准备", run_error:"执行异常"};

const isSource = (e: Row) => ["dingtalk", "redmine", "web"].includes(e.source) && e.requires_resolution;

export function EventGroupDetail({ id, canWrite, onOpen, onSession, onChanged }: {
  id: string; canWrite: boolean; onOpen: (id: string) => void; onSession: () => void; onChanged: () => Promise<void>;
}) {
  const [data, setData] = useState<Row | null>(null), [error, setError] = useState("");
  const [evidence, setEvidence] = useState(""), [eventId, setEventId] = useState("");
  const [goal, setGoal] = useState(""), [kind, setKind] = useState("analysis"), [busy, setBusy] = useState(false);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const load = useCallback(async () => { setData(await request<Row>(`/event-groups/${id}`)); }, [id]);
  useEffect(() => { void load().catch(e => setError(e.message)); const timer = setInterval(() => { if (!document.hidden) void load().catch(e => setError(e.message)); }, 5000); return () => clearInterval(timer); }, [load]);
  async function act(path: string, body: Row) {
    setBusy(true); setError("");
    try { await request(`/event-groups/${id}/${path}`, { ...body, expected_state_version: data?.group.state_version }); await load(); await onChanged(); return true; }
    catch(e) { setError((e as Error).message); await load().catch(() => {}); return false; }
    finally { setBusy(false); }
  }
  const sources = (data?.events ?? []).filter(isSource);
  return <section className="event-group-detail"><div className="section-heading"><h2>来源与处理结果</h2><button onClick={onSession}>打开执行会话</button></div>
    <p className="muted">以下仅列外部消息和人工输入；内部运行信息收在底部诊断记录中。</p>
    {error && <p role="alert">{error}</p>}
    <ol className="group-timeline">{sources.map((e: Row) => <li key={e.id}>
      <div><strong>事件 #{e.id}</strong> · {e.source} · {new Date(e.created_at).toLocaleString("zh-CN")}<span className="badge">{e.requires_resolution ? ({pending:"待核验", resolved:"已解决", dismissed:"无需处理"} as Row)[e.processing.status] : "过程记录"}</span></div>
      <p className="event-content">{e.content || eventNames[e.event_type] || "处理过程记录"}</p>{e.processing.evidence && <p>处理依据：{e.processing.evidence}</p>}
      {e.data?.child_group_id && <button onClick={() => onOpen(String(e.data.child_group_id))}>查看协作 Worker #{e.data.child_group_id}</button>}
      {e.requires_resolution && canWrite && <button onClick={() => {setEventId(String(e.id)); setEvidence("");}}>核对此事件</button>}
    </li>)}</ol>{data && !sources.length && <p>暂无外部或人工来源事件。</p>}
    {data && <div aria-label="当前处理进度" className="processing-flow" style={{display:"flex", flexWrap:"wrap", gap:12, padding:"16px 0"}}>
      <div className="badge">✓ 来源已接收</div><span aria-hidden="true">→</span>
      <div className={`badge ${data.group.status}`}>执行处理 · {statusNames[data.group.status] ?? "状态待核实"}</div><span aria-hidden="true">→</span>
      <div className="badge">结果核对 · {sources.some((e: Row) => !["resolved", "dismissed"].includes(e.processing?.status)) ? "仍有来源待核验" : sources.length ? "来源均已核对" : "暂无来源"}</div>
      {data.group.last_error && <p role="alert">阻塞原因：{data.group.last_error}</p>}
    </div>}
    {canWrite && eventId && <div className="advanced-panel"><h3>核对事件 #{eventId}</h3><label>处理依据<textarea value={evidence} onChange={e => setEvidence(e.target.value)} /></label><div className="actions wrap">{[["resolved","确认已解决"],["dismissed","无需处理"],["pending","重新打开"]].map(([status,label]) => <button key={status} disabled={busy || !evidence.trim()} onClick={() => void act(`events/${eventId}/resolution`, {status,evidence}).then(ok => {if(ok) setEventId("");})}>{label}</button>)}</div></div>}
    <details><summary>持续跟进的来源</summary><p>停止跟进仅停止后续投递，保留历史事件。群消息关联不等于订阅整个群。</p>{(data?.following ?? []).map((f: Row) => <p key={f.id}>{f.source} · {f.thread_id} · {f.enabled ? "跟进中" : "已停止"} {canWrite && <button disabled={busy} onClick={() => void act(`following/${f.id}`, {enabled: !f.enabled})}>{f.enabled ? "停止跟进" : "恢复跟进"}</button>}</p>)}{!data?.following?.length && <p>暂无持续跟进关系，Router 仍可按问题引用关联后续事件。</p>}</details>
    {canWrite && <details><summary>请求 Worker 协作</summary><p>为明确的分工创建独立 Worker 会话。结果返回到处理记录，由主 Worker 汇总核验；暂停状态不会自动恢复。</p><label>协作目标<textarea value={goal} onChange={e => {setGoal(e.target.value); setKey(crypto.randomUUID());}} /></label><label>协作方式<select value={kind} onChange={e => {setKind(e.target.value); setKey(crypto.randomUUID());}}><option value="analysis">只读分析</option><option value="repair">修改与验证</option></select></label><button disabled={busy || !goal.trim()} onClick={() => void act("delegations", {goal,kind,request_key:key}).then(ok => {if(ok) {setGoal(""); setKey(crypto.randomUUID());}})}>委派子 Worker</button></details>}

  </section>;
}

export function EventGroupDiagnostics({ id, onOpen }: { id: string; onOpen?: (id: string) => void }) {
  const [data, setData] = useState<Row | null>(null), [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    const load = async () => { try { const result = await request<Row>(`/event-groups/${id}`); if (live) { setData(result); setError(""); } } catch (e) { if (live) setError((e as Error).message); } };
    void load();
    const timer = setInterval(() => { if (!document.hidden) void load(); }, 5000);
    return () => { live = false; clearInterval(timer); };
  }, [id]);
  const records = (data?.events ?? []).filter((e: Row) => !isSource(e));
  return <>{error && <p role="alert">{error}</p>}
    <details><summary>处理过程与诊断（{records.length} 条记录）</summary><ol>{records.map((e: Row) => <li key={e.id}><strong>{eventNames[e.event_type] || "处理记录"}</strong> · {new Date(e.created_at).toLocaleString("zh-CN")}<p className="event-content">{e.content}</p>{e.data?.child_group_id && <button onClick={() => onOpen?.(String(e.data.child_group_id))}>查看协作结果</button>}</li>)}</ol></details></>;
}
