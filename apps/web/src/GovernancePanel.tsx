import { useCallback, useEffect, useState } from "react";
import { request } from "./api";
import { BudgetReconciliation } from "./BudgetReconciliation";

type Row = Record<string, any>;
const split = (text: string) =>
  text
    .split(/[\n,，]/)
    .map((item) => item.trim())
    .filter(Boolean);
const emptyIdentity = {
  source: "dingtalk",
  actor_id: "",
  user_id: "",
  enabled: true,
  project_ids: [] as number[],
  permissions: [] as string[],
};
const numberValue = (text: string) => (text === "" ? null : Number(text));

export function GovernancePanel({
  settings,
  projects,
  onChange,
}: {
  settings: Row;
  projects: Row[];
  onChange: () => Promise<void>;
}) {
  const [tab, setTab] = useState("运行策略");
  const [identities, setIdentities] = useState<Row[]>([]);
  const [budgets, setBudgets] = useState<Row[]>([]);
  const [audit, setAudit] = useState<Row[]>([]);
  const [identity, setIdentity] = useState(emptyIdentity);
  const [policy, setPolicy] = useState<Row>({
    scheduler_enabled: settings.scheduler_enabled ?? false,
    external_delivery_enabled: settings.external_delivery_enabled ?? false,
    max_concurrent_tasks: settings.max_concurrent_tasks ?? 1,
    codex_model: settings.codex_model ?? "",
    codex_effort: settings.codex_effort ?? "medium",
    budget_hard_limit_micros: settings.budget_hard_limit_micros ?? null,
    budget_reservation_estimate_micros:
      settings.budget_reservation_estimate_micros ?? null,
  });
  const [name, setName] = useState("dingtalk");
  const [connector, setConnector] = useState<Row>(
    settings["connectors.dingtalk"] ?? { enabled: false },
  );
  const [budgetEdits, setBudgetEdits] = useState<Record<string, Row>>({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const responses = await Promise.allSettled([
      request<Row[]>("/identities"),
      request<Row[]>("/budgets"),
      request<Row[]>("/audit?limit=100"),
    ]);
    const setters = [setIdentities, setBudgets, setAudit];
    const errors: string[] = [];
    responses.forEach((response, index) => {
      if (response.status === "fulfilled") setters[index](response.value);
      else errors.push(response.reason.message);
    });
    if (errors.length) setError(errors.join(" "));
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  async function act(operation: () => Promise<unknown>, success: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await operation();
      await load();
      await onChange();
      setNotice(success);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  function connectorField(key: string, label: string, type = "text") {
    return (
      <label key={key}>
        {label}
        <input
          type={type}
          value={
            Array.isArray(connector[key])
              ? JSON.stringify(connector[key])
              : (connector[key] ?? "")
          }
          onChange={(e) =>
            setConnector({
              ...connector,
              [key]:
                type === "number"
                  ? numberValue(e.target.value)
                  : e.target.value,
            })
          }
        />
      </label>
    );
  }
  return (
    <section>
      <h2>管理设置</h2>
      <div className="tabs">
        {["运行策略", "身份与项目授权", "连接器配置", "预算与审计"].map(
          (item) => (
            <button
              key={item}
              aria-pressed={tab === item}
              onClick={() => setTab(item)}
            >
              {item}
            </button>
          ),
        )}
      </div>
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
      {tab === "运行策略" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act(
              () =>
                request(
                  "/settings",
                  { ...policy, codex_model: policy.codex_model || null },
                  "PATCH",
                ),
              "运行策略已保存。",
            );
          }}
        >
          <label className="check">
            <input
              type="checkbox"
              checked={policy.scheduler_enabled}
              onChange={(e) =>
                setPolicy({ ...policy, scheduler_enabled: e.target.checked })
              }
            />
            启用任务调度
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={policy.external_delivery_enabled}
              onChange={(e) =>
                setPolicy({
                  ...policy,
                  external_delivery_enabled: e.target.checked,
                })
              }
            />
            允许已审批的外部回复发送
          </label>
          <label>
            最大并发任务
            <input
              type="number"
              min={1}
              max={4}
              required
              value={policy.max_concurrent_tasks}
              onChange={(e) =>
                setPolicy({
                  ...policy,
                  max_concurrent_tasks: Number(e.target.value),
                })
              }
            />
          </label>
          <label>
            Codex 模型
            <input
              value={policy.codex_model}
              onChange={(e) =>
                setPolicy({ ...policy, codex_model: e.target.value })
              }
            />
          </label>
          <label>
            推理强度
            <select
              value={policy.codex_effort}
              onChange={(e) =>
                setPolicy({ ...policy, codex_effort: e.target.value })
              }
            >
              {["low", "medium", "high", "xhigh", "max", "ultra"].map(
                (value) => (
                  <option key={value}>{value}</option>
                ),
              )}
            </select>
          </label>
          {[
            "budget_hard_limit_micros",
            "budget_reservation_estimate_micros",
          ].map((key, i) => (
            <label key={key}>
              {i
                ? "单次预算预留估算（微单位，可留空）"
                : "全局预算上限（微单位，可留空）"}
              <input
                type="number"
                min={0}
                max={10 ** 15}
                step={1}
                value={policy[key] ?? ""}
                onChange={(e) =>
                  setPolicy({ ...policy, [key]: numberValue(e.target.value) })
                }
              />
            </label>
          ))}
          <button className="primary" disabled={busy}>
            保存运行策略
          </button>
        </form>
      )}
      {tab === "身份与项目授权" && (
        <div className="detail-grid">
          <div>
            {identities.map((row) => (
              <article className="artifact" key={row.id}>
                <strong>
                  {row.source} · {row.actor_id}
                </strong>
                <p>
                  {row.user_id} · {row.enabled ? "已启用" : "已停用"}
                </p>
                <p>
                  授权项目{" "}
                  {(row.project_ids ?? [])
                    .map(
                      (id: number) =>
                        projects.find((p) => p.id === id)?.name ?? id,
                    )
                    .join("、") || "无"}{" "}
                  · 权限 {(row.permissions ?? []).join("、") || "无"}
                </p>
                <div className="actions wrap">
                  <button
                    onClick={() => setIdentity({ ...emptyIdentity, ...row })}
                  >
                    编辑授权
                  </button>
                  <button
                    disabled={busy || !row.enabled}
                    onClick={() =>
                      void act(
                        () => request(`/identities/${row.id}`, {}, "DELETE"),
                        "身份映射已停用。",
                      )
                    }
                  >
                    停用身份
                  </button>
                </div>
              </article>
            ))}
            {!identities.length && <p className="empty">暂无身份映射</p>}
          </div>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const {
                source,
                actor_id,
                user_id,
                enabled,
                project_ids,
                permissions,
              } = identity;
              if (
                await act(
                  () =>
                    request("/identities", {
                      source,
                      actor_id,
                      user_id,
                      enabled,
                      project_ids,
                      permissions,
                    }),
                  "身份与项目授权已保存。",
                )
              )
                setIdentity(emptyIdentity);
            }}
          >
            <label>
              外部来源
              <select
                value={identity.source}
                onChange={(e) =>
                  setIdentity({ ...identity, source: e.target.value })
                }
              >
                <option value="dingtalk">钉钉</option>
                <option value="redmine">Redmine</option>
              </select>
            </label>
            <label>
              外部用户 ID
              <input
                required
                value={identity.actor_id}
                onChange={(e) =>
                  setIdentity({ ...identity, actor_id: e.target.value })
                }
              />
            </label>
            <label>
              系统用户 ID
              <input
                required
                value={identity.user_id}
                onChange={(e) =>
                  setIdentity({ ...identity, user_id: e.target.value })
                }
              />
            </label>
            <fieldset>
              <legend>明确授权的项目</legend>
              {projects.map((p) => (
                <label className="check" key={p.id}>
                  <input
                    type="checkbox"
                    checked={identity.project_ids.includes(Number(p.id))}
                    onChange={(e) =>
                      setIdentity({
                        ...identity,
                        project_ids: e.target.checked
                          ? [...identity.project_ids, Number(p.id)]
                          : identity.project_ids.filter(
                              (id) => id !== Number(p.id),
                            ),
                      })
                    }
                  />
                  {p.name}
                </label>
              ))}
            </fieldset>
            <label className="check">
              <input
                type="checkbox"
                checked={identity.permissions.includes("request")}
                onChange={(e) =>
                  setIdentity({
                    ...identity,
                    permissions: e.target.checked ? ["request"] : [],
                  })
                }
              />
              允许从已授权项目发起请求
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={identity.enabled}
                onChange={(e) =>
                  setIdentity({ ...identity, enabled: e.target.checked })
                }
              />
              启用身份映射
            </label>
            <button className="primary" disabled={busy}>
              保存身份授权
            </button>
          </form>
        </div>
      )}
      {tab === "连接器配置" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              const config = { ...connector };
              if (name === "dingtalk") {
                if (typeof config.self_ids === "string")
                  config.self_ids = split(config.self_ids);
                if (
                  typeof config.executable === "string" &&
                  config.executable.trim().startsWith("[")
                )
                  config.executable = JSON.parse(config.executable);
                if (config.kind !== "group") delete config.chat_id;
              } else {
                if (typeof config.project_ids === "string")
                  config.project_ids = split(config.project_ids).map(Number);
                if (typeof config.account_map === "string") {
                  if (config.account_map.trim())
                    config.account_map = JSON.parse(config.account_map);
                  else delete config.account_map;
                }
                if (!config.initial_since) delete config.initial_since;
              }
              await request(
                "/settings",
                { ["connectors." + name]: config },
                "PATCH",
              );
            }, "连接器配置已保存。请在连接状态中明确启动并核对实际状态。");
          }}
        >
          <label>
            连接器
            <select
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                const config = settings["connectors." + e.target.value] ?? {
                  enabled: false,
                };
                setConnector({
                  ...config,
                  executable: Array.isArray(config.executable)
                    ? JSON.stringify(config.executable)
                    : config.executable,
                  ...(e.target.value === "redmine"
                    ? {
                        account_map: config.account_map
                          ? JSON.stringify(config.account_map, null, 2)
                          : "",
                      }
                    : {}),
                });
              }}
            >
              <option value="dingtalk">钉钉</option>
              <option value="redmine">Redmine</option>
            </select>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={connector.enabled ?? false}
              onChange={(e) =>
                setConnector({ ...connector, enabled: e.target.checked })
              }
            />
            允许启用此连接器
          </label>
          {name === "dingtalk" ? (
            <>
              {connectorField("executable", "DWS 可执行文件或 JSON 参数数组")}
              {connectorField("profile", "DWS 组织 Profile")}
              <label>
                自身账号 ID（每行一项）
                <textarea
                  value={
                    Array.isArray(connector.self_ids)
                      ? connector.self_ids.join("\n")
                      : (connector.self_ids ?? "")
                  }
                  onChange={(e) =>
                    setConnector({ ...connector, self_ids: e.target.value })
                  }
                />
              </label>
              <label>
                监听范围
                <select
                  value={connector.kind ?? "at-me"}
                  onChange={(e) =>
                    setConnector({ ...connector, kind: e.target.value })
                  }
                >
                  <option value="at-me">@本人</option>
                  <option value="group">指定群</option>
                </select>
              </label>
              {connector.kind === "group" &&
                connectorField("chat_id", "指定群 ID")}
            </>
          ) : (
            <>
              {connectorField("base_url", "Redmine 服务地址", "url")}
              {connectorField("user_id", "Redmine 当前用户 ID", "number")}
              <label>
                Redmine 项目 ID（每行一项）
                <textarea
                  value={
                    Array.isArray(connector.project_ids)
                      ? connector.project_ids.join("\n")
                      : (connector.project_ids ?? "")
                  }
                  onChange={(e) =>
                    setConnector({ ...connector, project_ids: e.target.value })
                  }
                />
              </label>
              {connectorField("api_key_env", "API Key 环境变量名称")}
              {connectorField("poll_seconds", "轮询间隔（秒）", "number")}
              {connectorField(
                "initial_since",
                "首次同步起点（带时区 ISO8601）",
              )}
              <label>
                账号别名映射（JSON 对象，可留空）
                <textarea
                  value={
                    typeof connector.account_map === "object"
                      ? JSON.stringify(connector.account_map, null, 2)
                      : (connector.account_map ?? "")
                  }
                  onChange={(e) =>
                    setConnector({ ...connector, account_map: e.target.value })
                  }
                />
              </label>
            </>
          )}
          <p className="muted">
            凭据通过服务进程环境变量或 DWS 本机 Profile
            管理。保存配置后在连接状态中明确启动。
          </p>
          <button className="primary" disabled={busy}>
            保存连接器配置
          </button>
        </form>
      )}
      {tab === "预算与审计" && (
        <>
          <BudgetReconciliation
            onChange={async () => {
              await load();
              await onChange();
            }}
          />
          <h3>预算账户</h3>
          {budgets.map((account) => {
            const edit = budgetEdits[account.id] ?? account;
            return (
              <form
                key={account.id}
                onSubmit={(e) => {
                  e.preventDefault();
                  void act(
                    () =>
                      request(
                        `/budgets/${encodeURIComponent(account.id)}`,
                        {
                          hard_limit_micros: edit.hard_limit_micros,
                          currency: edit.currency,
                        },
                        "PATCH",
                      ),
                    "预算上限已保存。",
                  );
                }}
              >
                <p>
                  {account.id} · 已用 {account.spent_micros} · 预留{" "}
                  {account.reserved_micros} 微单位
                </p>
                <label>
                  账户上限（微单位，留空为无上限）
                  <input
                    type="number"
                    min={0}
                    max={10 ** 15}
                    step={1}
                    value={edit.hard_limit_micros ?? ""}
                    onChange={(e) =>
                      setBudgetEdits({
                        ...budgetEdits,
                        [account.id]: {
                          ...edit,
                          hard_limit_micros: numberValue(e.target.value),
                        },
                      })
                    }
                  />
                </label>
                <label>
                  币种
                  <input
                    required
                    value={edit.currency}
                    onChange={(e) =>
                      setBudgetEdits({
                        ...budgetEdits,
                        [account.id]: { ...edit, currency: e.target.value },
                      })
                    }
                  />
                </label>
                <button disabled={busy}>保存账户预算</button>
              </form>
            );
          })}
          {!budgets.length && <p className="empty">暂无预算账户</p>}
          <h3>最近审计记录</h3>
          <button disabled={busy} onClick={() => void load()}>
            刷新审计
          </button>
          {audit.map((row) => (
            <article className="artifact" key={row.id}>
              <small>
                {row.created_at} · {row.actor}
              </small>
              <p>
                {row.action} · {row.resource}
              </p>
              <pre>{JSON.stringify(row.details, null, 2)}</pre>
            </article>
          ))}
        </>
      )}
    </section>
  );
}
