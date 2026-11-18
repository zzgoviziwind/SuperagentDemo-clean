import { GroupScopeFields } from "./GroupScopeFields";
import { useEffect, useState } from "react";
import { request } from "./api";
import { MessageAccessPanel } from "./MessageAccessPanel";

type Row = Record<string, any>;
const authNames: Record<string, string> = {
  authenticated: "已登录",
  logged_in: "已登录",
  available: "可连接",
  unauthenticated: "需要在本机登录",
  not_logged_in: "需要在本机登录",
  unknown: "登录状态待核对",
  login_required: "需要在本机登录",
  unavailable: "账号检查暂不可用",
  unsupported: "当前适配器未支持",
};
export function SetupPanel({
  settings,
  projects,
  onChange,
  onNavigate,
}: {
  settings: Row;
  projects: Row[];
  onChange: () => Promise<void>;
  onNavigate?: (page: string) => void;
}) {
  const [agents, setAgents] = useState<Row[]>([]);
  const [connection, setConnection] = useState<Row | null>(null);
  const [confirmStart, setConfirmStart] = useState(false);
  const [active, setActive] = useState("");
  const [choice, setChoice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const saved = settings.dingtalk_response_policy;
  const connectorConfig = settings["connectors.dingtalk"] ?? {};
  const [policy, setPolicy] = useState<Row>(
    () =>
      saved ?? {
        direct_messages: "reply",
        group_messages: settings.dingtalk_route_all_mentions
          ? "mentions"
          : "requests",
        delivery: "draft",
        default_project_id: null,
      },
  );
  const groupScope =
    policy.group_scope ??
    (connectorConfig.kind === "group" ? "selected" : "all");
  const groupIds: string[] =
    policy.group_chat_ids ??
    (connectorConfig.chat_id ? [connectorConfig.chat_id] : []);
  function groupProjects(chat: string) {
    return (
      projects
        .filter((project) => project.dingtalk_chat_ids?.includes(chat))
        .map((project) => project.name)
        .join("、") || "尚未绑定项目"
    );
  }
  async function detect() {
    setBusy(true);
    setError("");
    try {
      const data = await request<Row>("/agents/local");
      setAgents(data.items ?? []);
      setActive(data.active_id ?? "");
      setChoice(
        data.active_id ??
          data.items?.find(
            (agent: Row) => agent.installed && agent.id === "codex",
          )?.id ??
          "",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function loadConnection() {
    try {
      const items = await request<Row[]>("/connectors");
      setConnection(
        Array.isArray(items)
          ? (items.find(
              (item) => item.id === "dingtalk" || item.name === "dingtalk",
            ) ?? null)
          : null,
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void detect();
    void loadConnection();
  }, []);
  async function startReceiving() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await request(
        "/settings",
        {
          dingtalk_response_policy: policy,
          ...(policy.delivery === "auto_send"
            ? {
                external_delivery_enabled: true,
                scheduler_enabled: true,
                semantic_routing_enabled: true,
              }
            : {}),
        },
        "PATCH",
      );
      await request("/connectors/dingtalk/start", {});
      setConfirmStart(false);
      await loadConnection();
      setNotice("消息连接启动请求已完成，请核对接收范围状态。");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function connect() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await request<Row>("/agents/local/connect", {
        agent_id: choice,
        use_existing_login: true,
      });
      await detect();
      await onChange();
      setNotice(
        result.budget_configuration_required
          ? "账号已连接，当前账号需要在高级设置核对额度配置。"
          : "本机账号已连接，可在 SuperAgent 查看和继续真实会话。",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await request(
        "/settings",
        {
          dingtalk_response_policy: policy,
          ...(policy.delivery === "auto_send"
            ? {
                external_delivery_enabled: true,
                scheduler_enabled: true,
                semantic_routing_enabled: true,
              }
            : {}),
        },
        "PATCH",
      );
      await onChange();
      await loadConnection();
      setNotice("消息与交付方式已保存。");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const current = agents.find((agent) => agent.id === active);
  const needsReconnect = agents.some(agent => agent.id === "codex" && agent.connection_state === "reconnect_required");
  return (
    <section className="setup-panel">
      <h2>开始使用</h2>
      <p className="muted">
        使用本机 Codex 账号，在 SuperAgent 接收请求、查看会话并审核结果。
      </p>
      {error && (
        <p className="alert error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="alert success" role="status">
          {notice}
        </p>
      )}
      <div className="setup-steps settings-layout">
        <aside className="settings-sidebar">
          <section
            className="setup-step settings-summary"
            aria-label="当前编辑的配置摘要"
          >
            <h3>配置摘要</h3>
            <p className="muted">随当前编辑更新，保存后生效</p>
            <dl>
              <div>
                <dt>私聊</dt>
                <dd>
                  {policy.direct_messages === "reply"
                    ? "回复私聊请求"
                    : "暂不处理"}
                </dd>
              </div>
              <div>
                <dt>群聊</dt>
                <dd>
                  {
                    (
                      {
                        requests: "识别工作请求",
                        mentions: "只响应 @我",
                        off: "暂不处理",
                      } as Row
                    )[policy.group_messages]
                  }
                </dd>
              </div>
              {policy.group_messages === "requests" && (
                <div>
                  <dt>接收范围</dt>
                  <dd>
                    {groupScope === "all"
                      ? "所有群"
                      : `${groupIds.length} 个指定群`}
                  </dd>
                </div>
              )}
              <div>
                <dt>交付</dt>
                <dd>
                  {
                    (
                      {
                        auto_send: "模型判断后自动回复",
                        draft: "只生成草稿",
                        approved_send: "批准后可发送",
                      } as Row
                    )[policy.delivery]
                  }
                </dd>
              </div>
            </dl>
            <a className="settings-save-link" href="#config-回复审批">
              前往保存设置 ↓
            </a>
          </section>
          <div className="setup-step settings-agent">
            <div className="section-heading">
              <h3 id="config-本机Agent">选择本机 Agent</h3>
              <button
                type="button"
                disabled={busy}
                onClick={() => void detect()}
              >
                重新检测
              </button>
            </div>
            <p className="setup-value">
              {current ? `当前使用 ${current.name}` : "尚未选择"} ·
              使用这台电脑已有的登录状态处理工作。
            </p>
            {needsReconnect && <p className="alert error" role="alert">
              之前选择的 Codex 程序已不可用。检测到新版后，请使用原登录重新连接，再回到事件点击重新执行回复。
            </p>}
            {agents.map((agent) => (
              <button
                type="button"
                key={agent.id}
                className="agent-choice"
                aria-pressed={choice === agent.id}
                disabled={busy || !agent.installed || agent.id !== "codex"}
                onClick={() => setChoice(agent.id)}
              >
                <span>
                  <strong>{agent.name}</strong>
                  <small>
                    {agent.installed
                      ? agent.id === "codex"
                        ? (authNames[agent.auth_status] ??
                          agent.auth_status ??
                          "等待账号验证")
                        : "已检测到程序，适配器待支持"
                      : "此电脑未检测到"}
                  </small>
                </span>
                {agent.selected && <span>正在使用</span>}
              </button>
            ))}
            {!agents.length && !busy && <p>尚无可用的检测结果，可重新检测。</p>}
            <button
              type="button"
              className="primary"
              disabled={busy || !choice}
              onClick={() => void connect()}
            >
              {busy ? "正在检查…" : needsReconnect ? "使用原登录重新连接" : "使用已有登录连接"}
            </button>
            <details className="advanced-panel">
              <summary>程序检测详情</summary>
              {agents.map((agent) => (
                <dl key={agent.id}>
                  <dt>{agent.name} 版本</dt>
                  <dd>{agent.version ?? "未提供"}</dd>
                  <dt>程序位置</dt>
                  <dd className="break-word">{agent.executable ?? "未找到"}</dd>
                </dl>
              ))}
            </details>
          </div>
        </aside>
        <form
          className="settings-main-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="setup-step">
            <h3 id="config-消息接入">接收哪些消息</h3>
            <p className="setup-value">
              私聊与群聊分别选择响应范围，让需要处理的消息进入事件。
            </p>
            <div className="setup-policy-grid">
              <label>
                私聊响应
                <select
                  value={policy.direct_messages}
                  onChange={(e) =>
                    setPolicy({ ...policy, direct_messages: e.target.value })
                  }
                >
                  <option value="reply">回复私聊请求</option>
                  <option value="off">暂不处理私聊</option>
                </select>
              </label>
              <label>
                群聊响应
                <select
                  value={policy.group_messages}
                  onChange={(e) =>
                    setPolicy({ ...policy, group_messages: e.target.value })
                  }
                >
                  <option value="requests">识别工作请求</option>
                  <option value="mentions">只响应 @我的消息</option>
                  <option value="off">暂不处理群聊</option>
                </select>
              </label>
            </div>
            {policy.group_messages === "requests" && (
              <GroupScopeFields
                scope={groupScope}
                ids={groupIds}
                names={policy.group_names ?? settings.dingtalk_request_access?.group_names ?? {}}
                originalNames={policy.group_original_names ?? {}}
                onOriginalName={(id, name) =>
                  setPolicy((current) => {
                    const names = current.group_names ?? settings.dingtalk_request_access?.group_names ?? {};
                    const ids = current.group_chat_ids ?? groupIds;
                    if (!ids.includes(id) && !(id in names)) return current;
                    return {
                      ...current,
                      group_scope: current.group_scope ?? groupScope,
                      group_chat_ids: ids,
                      group_names: names,
                      group_original_names: { ...current.group_original_names, [id]: name },
                    };
                  })
                }
                onChange={(scope, ids, names, originalNames) =>
                  setPolicy({
                    ...policy,
                    group_scope: scope,
                    group_chat_ids: ids,
                    group_names: names,
                    group_original_names: originalNames,
                  })
                }
              />
            )}
            {policy.group_messages === "mentions" && (
              <p className="muted">
                当前通过全群 @本人订阅接收消息，再检查发送人及项目授权。
              </p>
            )}
            <p className="setup-value">
              消息接收 ·{" "}
              {(
                {
                  running: "运行中",
                  degraded: "部分范围连接异常",
                  policy_off: "响应已关闭",
                  disabled: "已暂停",
                  stopped: "已停止",
                  failed: "连接失败",
                  starting: "正在连接",
                } as Row
              )[connection?.status] ?? "等待连接配置"}
            </p>
            {connection?.warnings?.map((warning: string) => (
              <p key={warning}>{warning}</p>
            ))}
            {!!connection?.scopes?.length && (
              <details className="connection-scope-details">
                <summary>
                  接收通道详情 · {connection.scopes.length} 个通道
                </summary>
                {connection?.scopes?.map((scope: Row, index: number) => (
                  <p key={index}>
                    {(
                      {
                        "all-direct": "私聊",
                        "all-group": "群聊",
                        "at-me": "群内 @本人",
                        group: "指定群",
                      } as Row
                    )[scope.kind] ?? scope.kind}{" "}
                    {scope.chat_id && (
                      <span className="break-word">
                        {" "}
                        ·{" "}
                        {policy.group_names?.[scope.chat_id] ??
                          settings.dingtalk_request_access?.group_names?.[
                            scope.chat_id
                          ] ??
                          "群名称待配置"}{" "}
                        · {groupProjects(scope.chat_id)}
                      </span>
                    )}
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
                      <span className="danger"> · {scope.last_error}</span>
                    )}
                  </p>
                ))}
              </details>
            )}
            {connection?.configured && connection.status !== "running" && (
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirmStart(true)}
              >
                启用消息接收
              </button>
            )}
            {confirmStart && (
              <div className="alert">
                <p>将保存当前私聊与群聊范围，并连接钉钉账号接收消息。</p>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void startReceiving()}
                >
                  确认连接并接收
                </button>
                <button type="button" onClick={() => setConfirmStart(false)}>
                  返回
                </button>
              </div>
            )}
            {onNavigate && (
              <button type="button" onClick={() => onNavigate("运行状态")}>
                查看消息连接状态
              </button>
            )}
          </div>
          <div className="setup-step">
            <h3 id="config-回复审批">自动回复与交付</h3>
            <p className="setup-value">
              自动模式由模型判断是否还要回复：有必要就发送，已有人答复或无需回时跳过，有疑问才留给你审核。时段和人工审核范围可在「事件规则」设置。
            </p>
            <label>
              交付方式
              <select
                value={policy.delivery}
                onChange={(e) =>
                  setPolicy({ ...policy, delivery: e.target.value })
                }
              >
                <option value="auto_send">模型判断后自动回复</option>
                <option value="draft">只生成草稿</option>
                <option value="approved_send">批准后可发送</option>
              </select>
            </label>
            {policy.delivery === "auto_send" && <>
              <label>
                自动回复有效期（从来信起，分钟）
                <input type="number" min={1} max={1440} required value={policy.reply_max_age_minutes ?? 120}
                  onChange={e => setPolicy({ ...policy, reply_max_age_minutes: e.target.value === "" ? "" : Number(e.target.value) })} />
              </label>
              <label>
                模型回复规则（可选）
                <textarea maxLength={1000} value={policy.reply_guidance ?? ""}
                  onChange={e => setPolicy({ ...policy, reply_guidance: e.target.value })}
                  placeholder="例如：别人已经解释清楚时不再回；仅有“收到”或“谢谢”时不回。" />
              </label>
            </>}
            <button className="primary" disabled={busy}>
              保存消息与交付方式
            </button>
          </div>
        </form>
        <details className="settings-access setup-step">
          <summary>
            <span>
              <strong>人员与项目规则</strong>
              <small>回复范围、人员授权与项目识别</small>
            </span>
            <span className="settings-expand-hint">展开配置</span>
          </summary>
          <MessageAccessPanel
            settings={settings}
            projects={projects}
            onChange={onChange}
          />
        </details>
      </div>
    </section>
  );
}
