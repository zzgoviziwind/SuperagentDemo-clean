import { useEffect, useState } from "react";
import { request } from "./api";
type Rule = {
  name: string;
  enabled: boolean;
  project_id: number | null;
  source: string | null;
  chat_id: string | null;
  actor_id: string | null;
  kind: string | null;
  action: string;
  start_hour: number;
  end_hour: number;
};
const fresh = (): Rule => ({
  name: "",
  enabled: true,
  project_id: null,
  source: null,
  chat_id: null,
  actor_id: null,
  kind: null,
  action: "pause",
  start_hour: 20,
  end_hour: 8,
});
export function EventRulesPanel({
  projects,
}: {
  projects: { id: number; name: string; dingtalk_chat_ids?: string[] }[];
}) {
  const [items, setItems] = useState<Rule[]>([]);
  const [draft, setDraft] = useState<Rule>(fresh);
  const [message, setMessage] = useState("");
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    request<{ items: Rule[] }>("/event-rules")
      .then((r) => {
        setItems(r.items);
        setReady(true);
      })
      .catch((e) => setMessage(e.message));
  }, []);
  async function save(next: Rule[]) {
    setBusy(true);
    try {
      const r = await request<{ items: Rule[] }>(
        "/event-rules",
        { items: next },
        "PUT",
      );
      setItems(r.items);
      setMessage("规则已保存，对后续处理生效。");
      setDraft(fresh());
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const field = (key: keyof Rule, value: any) =>
    setDraft({ ...draft, [key]: value });
  return (
    <section className="panel event-rules">
      <h2>处理规则</h2>
      <p className="muted">
        可单独限制自动回复的时段，也可为指定项目、来源或群聊保留人工审核。回复静默期间仍可处理事件，到期后只自动发送仍在有效期内的回复。
      </p>
      <div className="stack">
        {ready && items.length === 0 && (
          <p className="muted">
            还没有自定义规则。可以先添加夜间安静时段，或为指定项目暂停处理。
          </p>
        )}
        {items.map((r, i) => (
          <article className="panel" key={i}>
            <strong>
              {r.name} · {r.enabled ? "已启用" : "已停用"}
            </strong>
            <p>
              {r.source || "全部来源"} ·{" "}
              {r.actor_id ? `发起人 ${r.actor_id}` : "所有发起人"} ·{" "}
              {(
                { reply: "回复", analysis: "分析", repair: "修复" } as Record<
                  string,
                  string
                >
              )[r.kind || ""] || "所有类别"}
            </p>
            <p>
              {r.action === "quiet" || r.action === "reply_quiet"
                ? `每日 ${r.start_hour}:00—${r.end_hour}:00 ${r.action === "reply_quiet" ? "不自动回复" : "保持安静"}（北京时间）`
                : r.action === "review"
                  ? "回复前人工审核"
                  : "暂停处理"}{" "}
              ·{" "}
              {r.project_id
                ? projects.find((p) => p.id === r.project_id)?.name ||
                  "指定项目"
                : "全部项目"}
              {r.chat_id ? ` · 群 ${r.chat_id}` : ""}
            </p>
            <button
              disabled={!ready || busy}
              onClick={() =>
                save(
                  items.map((x, j) =>
                    j === i ? { ...x, enabled: !x.enabled } : x,
                  ),
                )
              }
            >
              {r.enabled ? "停用" : "启用"}
            </button>
            <button
              disabled={!ready || busy}
              onClick={() => save(items.filter((_, j) => j !== i))}
            >
              删除
            </button>
          </article>
        ))}
      </div>
      <form className="rule-form"
        onSubmit={(e) => {
          e.preventDefault();
          save([
            ...items,
            {
              ...draft,
              name:
                draft.name.trim() ||
                {
                  pause: "暂停自动处理",
                  quiet: "夜间保持安静",
                  reply_quiet: "自动回复静默时段",
                  review: "回复前由我确认",
                }[draft.action] ||
                "事件规则",
            },
          ]);
        }}
      >
        <h3>添加规则</h3>
        <label>
          希望助手怎么做
          <select
            value={draft.action}
            onChange={(e) => field("action", e.target.value)}
          >
            <option value="pause">暂不处理</option>
            <option value="quiet">指定时段保持安静</option>
            <option value="reply_quiet">指定时段暂停自动回复</option>
            <option value="review">回复前由我确认</option>
          </select>
        </label>
        <label>
          适用项目
          <select
            value={draft.project_id || ""}
            onChange={(e) =>
              field(
                "project_id",
                e.target.value ? Number(e.target.value) : null,
              )
            }
          >
            <option value="">全部项目</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        {(draft.action === "quiet" || draft.action === "reply_quiet") && (
          <div>
            <label>
              开始小时（北京时间）
              <input
                type="number"
                min="0"
                max="23"
                value={draft.start_hour}
                onChange={(e) => field("start_hour", Number(e.target.value))}
              />
            </label>
            <label>
              结束小时
              <input
                type="number"
                min="0"
                max="23"
                value={draft.end_hour}
                onChange={(e) => field("end_hour", Number(e.target.value))}
              />
            </label>
          </div>
        )}
        <details>
          <summary>缩小范围 / 自定义名称（可选）</summary>
          <label>
            规则名称
            <input
              value={draft.name}
              onChange={(e) => field("name", e.target.value)}
            />
          </label>
          <label>
            来源
            <select
              value={draft.source || ""}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  source: e.target.value || null,
                  chat_id: null,
                })
              }
            >
              <option value="">全部来源</option>
              <option value="dingtalk">钉钉</option>
              <option value="redmine">Redmine</option>
            </select>
          </label>
          {draft.source === "dingtalk" && (
            <div>
              <label>
                选择群聊
                <select
                  value={draft.chat_id || ""}
                  onChange={(e) => field("chat_id", e.target.value || null)}
                >
                  <option value="">全部群聊</option>
                  {projects
                    .filter(
                      (p) => !draft.project_id || p.id === draft.project_id,
                    )
                    .flatMap((p) =>
                      (p.dingtalk_chat_ids || []).map((id) => (
                        <option key={`${p.id}:${id}`} value={id}>
                          {p.name} · {id}
                        </option>
                      )),
                    )}
                </select>
              </label>
              <details>
                <summary>手动指定未绑定的群聊</summary>
                <input
                  aria-label="群聊 ID"
                  value={draft.chat_id || ""}
                  onChange={(e) => field("chat_id", e.target.value || null)}
                />
              </details>
            </div>
          )}
          <label>
            发起人 ID
            <input
              value={draft.actor_id || ""}
              onChange={(e) => field("actor_id", e.target.value || null)}
            />
          </label>
          <label>
            事件类别
            <select
              value={draft.kind || ""}
              onChange={(e) => field("kind", e.target.value || null)}
            >
              <option value="">所有类别</option>
              <option value="reply">回复</option>
              <option value="analysis">分析</option>
              <option value="repair">修复</option>
            </select>
          </label>
        </details>
        <div className="rule-form-actions"><button className="primary" disabled={!ready || busy} type="submit">
          保存规则
        </button></div>
      </form>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
