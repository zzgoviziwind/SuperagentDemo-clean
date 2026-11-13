import { useCallback, useEffect, useState } from "react";
import { request } from "./api";

type InboxEvent = {
  id: number;
  source: string;
  content: string;
  created_at?: string;
  data?: Record<string, any>;
};
type InboxPage = { items: InboxEvent[]; has_more: boolean; next_after: number };
const reasonLabels: Record<string, string> = {
  actor_unmapped_or_disabled: "发送人尚未绑定系统身份，或身份已停用",
  identity_not_mapped: "发送人尚未绑定系统身份",
  project_binding_missing_ambiguous_or_disabled:
    "项目绑定缺失、存在多个匹配，或项目已停用",
  actor_not_authorized_for_project: "发送人尚未获得该项目的请求权限",
  unsupported_event_type: "该消息类型暂不支持自动处理",
  ambiguous_or_empty_request: "请求内容为空或含义不明确，需要人工确认",
  explicit_request_required: "尚未识别到明确的工作请求",
  conflicting_analysis_and_write_request: "分析要求与代码修改要求存在冲突",
  ambiguous_issue_reference: "消息提到了多个问题，需确认关联目标",
  invalid_reply_reference: "回复引用无效，需要核对原消息",
  reference_too_long: "消息引用超出支持长度，需要人工核对",
  reply_target_missing_or_ambiguous: "找不到回复目标，或回复目标存在多个匹配",
  conflicting_task_references: "消息中的任务引用相互冲突",
  conflicting_issue_reference: "消息中的问题引用与已关联任务不一致",
  task_owned_by_another_user: "关联任务由其他用户负责，需要核对处理权限",
};
const reasonText = (reason?: string) =>
  reasonLabels[reason ?? ""] ?? "需要人工核对消息归属与授权";
function localTime(value?: string) {
  if (!value) return "时间未提供";
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime())
    ? "时间格式需核对"
    : timestamp.toLocaleString("zh-CN");
}
export function InboxPanel({ onChange }: { onChange: () => Promise<void> }) {
  const [page, setPage] = useState<InboxPage>({
    items: [],
    has_more: false,
    next_after: 0,
  });
  const [cursor, setCursor] = useState(0);
  const [previous, setPrevious] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await request<InboxPage>(
        `/events?routing_status=pending_confirmation&after=${cursor}&limit=50`,
      );
      setPage({
        items: result.items ?? [],
        has_more: result.has_more,
        next_after: result.next_after,
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [cursor]);
  useEffect(() => {
    void load();
  }, [load]);
  async function retry(id: number) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await request<InboxEvent>(
        `/events/${id}/retry-routing`,
        {},
      );
      await load();
      await onChange();
      setNotice(
        result.data?.routing_status === "routed"
          ? "消息已路由，请在任务中查看。"
          : `消息仍待确认，${reasonText(result.data?.routing_reason)}`,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section>
      <div className="section-heading">
        <h2>待确认消息收件箱</h2>
        <button
          disabled={busy || loading}
          onClick={() => {
            setError("");
            void load();
          }}
        >
          刷新收件箱
        </button>
      </div>
      <p className="muted">
        核对身份映射、项目消息源与明确授权后，重新尝试路由。
      </p>
      {error && (
        <p role="alert" className="alert error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="alert success">
          {notice}
        </p>
      )}
      {loading && <p role="status">正在读取待确认消息…</p>}
      {!loading && !page.items.length && !error && (
        <p className="empty">本页暂无待确认消息</p>
      )}
      {page.items.map((event) => (
        <article className="artifact" key={event.id}>
          <strong>
            {(
              { dingtalk: "钉钉", redmine: "Redmine" } as Record<string, string>
            )[event.source] ?? event.source}{" "}
            · 事件 {event.id}
          </strong>
          <small>
            <time dateTime={event.created_at}>
              {localTime(event.created_at)}
            </time>
          </small>
          <pre>{event.content}</pre>
          <p>待确认原因 {reasonText(event.data?.routing_reason)}</p>
          <details>
            <summary>查看来源信息</summary>
            <dl>
              <dt>来源标识</dt>
              <dd>{event.source}</dd>
              <dt>外部用户 ID</dt>
              <dd>{event.data?.actor_id ?? "未提供"}</dd>
              <dt>会话 ID</dt>
              <dd>{event.data?.thread_id ?? "未提供"}</dd>
              <dt>外部项目 ID</dt>
              <dd>{event.data?.project_external_id ?? "未提供"}</dd>
              <dt>问题 ID</dt>
              <dd>{event.data?.issue_id ?? "未提供"}</dd>
              <dt>原始时间</dt>
              <dd>{event.created_at ?? "未提供"}</dd>
              <dt>原始待确认原因</dt>
              <dd>{event.data?.routing_reason ?? "未提供"}</dd>
            </dl>
          </details>
          <button
            disabled={busy || loading}
            onClick={() => void retry(event.id)}
          >
            重新路由消息 {event.id}
          </button>
        </article>
      ))}
      <div className="actions">
        <button
          disabled={busy || loading || !previous.length}
          onClick={() => {
            const next = [...previous];
            setCursor(next.pop() ?? 0);
            setPrevious(next);
          }}
        >
          上一页
        </button>
        <button
          disabled={busy || loading || !page.has_more}
          onClick={() => {
            setPrevious([...previous, cursor]);
            setCursor(page.next_after);
          }}
        >
          下一页
        </button>
      </div>
    </section>
  );
}
