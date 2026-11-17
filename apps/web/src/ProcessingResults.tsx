import { ArtifactView } from "./ArtifactView";
import { ConversationContent } from "./ConversationContent";
import { statusNames } from "./api";

type Row = Record<string, any>;
const stageNames: Record<string, string> = {
  summary: "执行助手 · 生成结论",
  verification: "系统 · 核验执行证据",
  changes: "系统 · 收集代码改动",
  source_attachment: "接入服务 · 准备附件",
};
const time = (value?: string) => value ? new Date(value).toLocaleString("zh-CN") : "时间未记录";
function verificationLabel(artifact: Row) {
  try {
    const data = typeof artifact.content === "string" ? JSON.parse(artifact.content) : artifact.content;
    if (data?.kind === "reply") return data.turn_status === "completed" ? "回复生成已完成" : "回复生成待核验";
    return statusNames[data?.assessment?.suggested_status] ?? "核验结论需查看记录";
  } catch {
    return "核验记录无法解析";
  }
}

export function ProcessingResults({ artifacts, events, group, onOpenSession }: {
  artifacts: Row[];
  events: Row[];
  group: Row;
  onOpenSession?: (id: string) => void;
}) {
  const ordered = [...artifacts].sort((a, b) => a.id - b.id);
  const current = ordered.filter(a => a.revision === group.revision);
  const latestSummary = current.filter(a => a.kind === "summary").at(-1);
  const verification = current.filter(a => a.kind === "verification").at(-1);
  const remaining = current.filter(a => a !== latestSummary && a !== verification);
  const historical = ordered.filter(a => a.revision !== group.revision);

  function record(artifact: Row) {
    const event = events.find(e => e.data?.artifact_id === artifact.id);
    return <details className="result-record" key={artifact.id}>
      <summary>{stageNames[artifact.kind] ?? "系统 · 保存处理资料"} · {time(artifact.created_at)} · 记录 #{artifact.id}</summary>
      {event?.data?.turn_id && <small className="muted break-word">执行轮次 {event.data.turn_id}</small>}
      <ArtifactView artifact={artifact} revision={group.revision} />
    </details>;
  }

  return <section className="linked-record processing-results">
    <div className="section-heading"><h3>处理结果</h3>{onOpenSession && <button onClick={() => onOpenSession(`worker:${group.id}`)}>打开执行会话</button>}</div>
    <div className="result-stage"><h4>执行助手的最新结论</h4>
      {latestSummary ? <><small className="muted">目标版本 {group.revision} · {time(latestSummary.created_at)}</small><ConversationContent content={latestSummary.content} /></> : <p>当前目标尚未生成结论。</p>}
    </div>
    <div className="result-stage"><h4>系统核验</h4>
      <p className="muted">检查回复是否生成、分析是否有读取依据，或代码改动是否有测试证据。</p>
      {verification ? <><p>最近一次系统评估 · {verificationLabel(verification)}</p><details><summary>查看核验依据 · {time(verification.created_at)}</summary><ArtifactView artifact={verification} revision={group.revision} /></details></> : <p>当前目标尚无核验记录。</p>}
    </div>
    {!!remaining.length && <details><summary>本次处理的其他记录（{remaining.length}）</summary>{remaining.map(record)}</details>}
    {!!historical.length && <details><summary>历史目标的处理记录（{historical.length}）</summary>{historical.map(record)}</details>}
  </section>;
}
