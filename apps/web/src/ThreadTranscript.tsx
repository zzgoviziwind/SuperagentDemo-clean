import { useEffect, useState } from "react";
import { request } from "./api";
import { ConversationContent } from "./ConversationContent";
type Row = Record<string, any>;
export function ThreadTranscript({ sessionId }: { sessionId: string }) {
  const [record, setRecord] = useState<Row | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function read() {
    setBusy(true);
    setError("");
    try {
      setRecord(
        await request(`/sessions/${encodeURIComponent(sessionId)}/transcript`),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => { void read(); }, [sessionId]);
  return (
    <section className="codex-transcript">
      <h3>Codex 会话 · 真实线程记录</h3>
      <p className="muted">
        读取此会话所属 Codex 线程的可见输入、输出和工具活动。
      </p>
      <button disabled={busy} onClick={() => void read()}>
        {busy ? "正在读取…" : "读取真实线程记录"}
      </button>
      {error && (
        <p className="alert error" role="alert">
          {error}
        </p>
      )}
      {record && (
        <>
          <p role="status">
            {record.complete
              ? "已读取真实线程的完整可见记录"
              : (record.reason ?? "当前仅有平台保存的消息")}
          </p>
          <small>
            记录来源 ·{" "}
            {(
              {
                codex_thread: "Codex 真实线程",
                persisted_visible_messages: "平台保存消息",
              } as Row
            )[record.source] ?? record.source}
          </small>
          {(record.items ?? []).map((item: Row, index: number) => {
            const kind = item.type ?? item.role;
            const text =
              item.text ??
              (Array.isArray(item.content)
                ? item.content
                    .map((part: Row) => part.text ?? "")
                    .filter(Boolean)
                    .join("\n")
                : item.content);
            const title =
              (
                {
                  userMessage: "用户输入",
                  agentMessage: "代理输出",
                  user: "用户输入",
                  assistant: "代理输出",
                  commandExecution: "命令执行",
                  fileChange: "文件修改",
                  mcpToolCall: "外部工具",
                  dynamicToolCall: "工作区工具",
                } as Row
              )[kind] ??
              kind ??
              "线程活动";
            return (
              <article
                className="execution-record"
                key={`${item.turn_id ?? ""}-${item.id ?? index}`}
              >
                <strong>{title}</strong>
                <small> {item.created_at ?? item.started_at ?? "时间未记录"}{item.durationMs != null ? ` · 执行 ${(item.durationMs / 1000).toFixed(1)} 秒` : ""}</small>
                <details open={["userMessage", "user", "agentMessage", "assistant"].includes(kind)}><summary>{["userMessage", "user", "agentMessage", "assistant"].includes(kind) ? "消息内容" : "展开工具调用过程"}</summary>
                {text ? (
                  <ConversationContent
                    content={text}
                    variant={
                      ["userMessage", "user"].includes(kind)
                        ? "input"
                        : "record"
                    }
                  />
                ) : (
                  <ConversationContent
                    content={item}
                    variant={
                      ["userMessage", "user"].includes(kind)
                        ? "input"
                        : "record"
                    }
                  />
                )}
                </details>
              </article>
            );
          })}
        </>
      )}
    </section>
  );
}
