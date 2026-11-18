import { useState } from "react";
import { request } from "./api";

export function InlineAgentCheck() {
  const [agent, setAgent] = useState<Record<string, any>>();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  async function check(connect = false) {
    setBusy(true);
    setStatus("");
    try {
      if (connect) await request("/agents/local/connect", {agent_id: "codex", use_existing_login: true});
      const result = await request<{items: Record<string, any>[]}>("/agents/local");
      const codex = result.items?.find(item => item.id === "codex");
      setAgent(codex);
      setStatus(codex?.connection_state === "connected" ? "本机 Codex 已连接，可重新执行回复。" :
        !codex?.installed ? "本机未检测到 Codex。" :
        codex.auth_status === "authenticated" ? "已检测到本机登录，可在此连接。" : "请先在本机登录 Codex，再检查。");
    } catch (error) {
      setStatus((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return <div>
    <div className="actions wrap">
      <button disabled={busy} onClick={() => void check()}>检查本机 Agent</button>
      {agent?.auth_status === "authenticated" && agent.connection_state !== "connected" &&
        <button disabled={busy} onClick={() => void check(true)}>连接本机 Codex</button>}
    </div>
    {status && <p role="status">{status}</p>}
  </div>;
}
