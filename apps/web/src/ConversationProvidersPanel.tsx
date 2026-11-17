import { useEffect, useState } from "react";
import { request } from "./api";

type Provider = {
  id: string;
  status: string;
  reason?: string;
  execution_readiness?: string;
  capabilities: string[];
  transport?: string;
  transports?: string[];
  mcp_endpoint?: string;
  automatic_history_sync?: boolean;
};
const names: Record<string, string> = {
  codex_local: "本地 Codex",
  chatgpt_project: "ChatGPT 项目同步",
  chatgpt_mcp_bridge: "ChatGPT 客户端接入",
};
const states: Record<string, string> = {
  available: "接口可用",
  blocked: "接入受阻",
  requires_client_connection: "等待客户端连接",
};
const actions: Record<string, string> = {
  list: "列出会话",
  create: "创建事件",
  continue: "继续会话",
  read: "读取消息",
  control: "控制事件",
};

export function ConversationProvidersPanel() {
  const [items, setItems] = useState<Provider[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function load() {
    setBusy(true);
    setError("");
    try {
      const result = await request<{ items: Provider[] }>(
        "/conversation-providers",
      );
      setItems(result.items);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  return (
    <section>
      <div className="section-heading">
        <h3>ChatGPT 与会话接入</h3>
        <button disabled={busy} onClick={() => void load()}>
          重新诊断接入
        </button>
      </div>
      {error && (
        <p className="alert error" role="alert">
          {error}
        </p>
      )}
      {items.map((provider) => (
        <article className="linked-record" key={provider.id}>
          <strong>{names[provider.id] ?? provider.id}</strong>
          <p>{states[provider.status] ?? provider.status}</p>
          {provider.reason && <p>{provider.reason}</p>}
          {provider.execution_readiness && (
            <p>{provider.execution_readiness}</p>
          )}
          {!!provider.capabilities.length && (
            <p>
              {provider.capabilities
                .map((action) => actions[action] ?? action)
                .join(" · ")}
            </p>
          )}
          {provider.mcp_endpoint && (
            <p>
              HTTP MCP 入口 · <code>{provider.mcp_endpoint}</code>
            </p>
          )}
          {provider.automatic_history_sync !== undefined && (
            <p>
              自动历史同步
              {provider.automatic_history_sync ? "已支持" : "未接通"}
            </p>
          )}
        </article>
      ))}
      <details className="advanced-panel">
        <summary>客户端连接配置</summary>
        <p>
          在支持本地 MCP 的客户端配置本项目 Python 进程，工作目录为项目根目录。
        </p>
        <pre>python -m superagent.runtime.chatgpt_bridge</pre>
        <p>
          通过本机环境提供 SUPERAGENT_BRIDGE_URL 和
          SUPERAGENT_BRIDGE_TOKEN。访问令牌由平台身份配置管理。
        </p>
        <p>重新诊断读取服务端能力声明。客户端安装和连接结果需在客户端核对。</p>
      </details>
    </section>
  );
}
