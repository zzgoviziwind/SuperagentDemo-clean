import { useEffect, useId, useState, type FormEvent } from "react";
import { request } from "./api";
import { SettingsDrawer } from "./SettingsDrawer";

const stages = [
  ["semantic_routing", "事件分流"],
  ["router", "项目讨论"],
  ["reply", "普通回复"],
  ["analysis", "只读分析"],
  ["repair", "代码修复"],
  ["watchdog", "独立巡检"],
] as const;
const efforts = ["low", "medium", "high", "xhigh", "max", "ultra"];
// Models listed in the project's implementation baseline.
const presetModels = ["gpt-6.1-sol", "gpt-6.1-terra"];
const customModel = ":custom";
type Stage = (typeof stages)[number][0];
type Profile = { model?: string | null; effort?: string | null };
type Profiles = Partial<Record<Stage, Profile>>;
type Settings = {
  codex_model?: string | null;
  codex_effort?: string | null;
  codex_task_profiles?: Profiles;
};

type Prompt = { title: string; text: string };

function ProfileFields({ profile, models, defaultLabel, onChange }: {
  profile: Profile;
  models: ReadonlySet<string>;
  defaultLabel: string;
  onChange: (change: Profile) => void;
}) {
  const id = useId();
  const [manual, setManual] = useState(false);
  const value = profile.model ?? "";

  return (
    <div className="codex-profile-fields">
      <label htmlFor={id}>
        Codex 模型
        <select id={id} value={manual ? customModel : value} onChange={(event) => {
          const selected = event.target.value;
          setManual(selected === customModel);
          onChange({ model: selected === customModel ? "" : selected });
        }}>
          <option value="">{defaultLabel}</option>
          {[...models].map((model) => <option key={model} value={model}>{model}</option>)}
          {!manual && value && !models.has(value) && <option value={value}>{value}</option>}
          <option value={customModel}>手动输入…</option>
        </select>
      </label>
      <label>
        推理强度
        <select value={profile.effort ?? ""} onChange={(event) => onChange({ effort: event.target.value })}>
          <option value="">{defaultLabel}</option>
          {efforts.map((effort) => <option key={effort}>{effort}</option>)}
        </select>
      </label>
      {manual && (
        <label className="codex-custom-model" htmlFor={`${id}-manual`}>
          自定义模型名称
          <input
            id={`${id}-manual`}
            required
            pattern={String.raw`.*\S.*`}
            maxLength={200}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={value}
            onChange={(event) => onChange({ model: event.target.value })}
          />
        </label>
      )}
    </div>
  );
}

function PromptPreview({ stage, label, onClose }: { stage: Stage; label: string; onClose: () => void }) {
  const [prompts, setPrompts] = useState<Prompt[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    request<Record<Stage, Prompt[]>>("/codex-prompts").then(
      (result) => { if (active) setPrompts(result[stage] ?? []); },
      (err: Error) => { if (active) setError(err.message); },
    );
    return () => { active = false; };
  }, [stage]);

  return (
    <SettingsDrawer title={`${label} · 提示词`} onClose={onClose}>
      <p className="muted">这里展示 SuperAgent 当前使用的指令和任务模板。【】中的内容由实际任务填入；已有会话可能沿用创建时的指令。</p>
      {error ? <p role="alert" className="alert error">{error}</p>
        : prompts === null ? <p role="status">正在读取提示词…</p>
        : prompts.length === 0 ? <p>当前没有可展示的提示词。</p>
        : prompts.map(({ title, text }) => (
          <section className="codex-prompt" key={title}>
            <h3>{title}</h3>
            <pre>{text}</pre>
          </section>
        ))}
    </SettingsDrawer>
  );
}

export function CodexProfilesPanel({ settings, onChange }: {
  settings: Settings;
  onChange: () => Promise<void>;
}) {
  const [global, setGlobal] = useState<Profile>({
    model: settings.codex_model,
    effort: settings.codex_effort === undefined ? "medium" : settings.codex_effort,
  });
  const [profiles, setProfiles] = useState<Profiles>(settings.codex_task_profiles ?? {});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<(typeof stages)[number] | null>(null);
  const models = new Set([
    ...presetModels,
    settings.codex_model,
    ...Object.values(settings.codex_task_profiles ?? {}).map((profile) => profile.model),
  ].filter((model): model is string => Boolean(model)));

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setNotice("");
    setError("");
    try {
      const overrides = Object.fromEntries(stages.flatMap(([stage]) => {
        const model = profiles[stage]?.model?.trim() || null;
        const effort = profiles[stage]?.effort || null;
        return model || effort ? [[stage, { model, effort }]] : [];
      }));
      await request("/settings", {
        codex_model: global.model?.trim() || null,
        codex_effort: global.effort || null,
        codex_task_profiles: overrides,
      }, "PATCH");
      await onChange();
      setNotice("模型设置已保存，从下一轮执行起生效。");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save}>
      <p className="muted">
        各阶段可分别设置模型和推理强度，也可选“沿用全局”。列表外的模型可手动输入，请确认当前 Codex 账号支持所选模型和强度。
      </p>
      <fieldset className="settings-group codex-profile" disabled={busy}>
        <legend>全局默认</legend>
        <ProfileFields profile={global} models={models} defaultLabel="由 Codex 决定"
          onChange={(change) => setGlobal((previous) => ({ ...previous, ...change }))} />
      </fieldset>
      <div className="codex-profile-grid">
        {stages.map((entry) => {
          const [stage, label] = entry;
          return (
            <fieldset className="settings-group codex-profile" key={stage} disabled={busy}>
              <legend>{label}</legend>
              <ProfileFields profile={profiles[stage] ?? {}} models={models} defaultLabel="沿用全局"
                onChange={(change) => setProfiles((previous) => ({
                  ...previous,
                  [stage]: { ...previous[stage], ...change },
                }))} />
              <button type="button" className="codex-prompt-button" onClick={() => setPreview(entry)}>
                查看提示词
              </button>
            </fieldset>
          );
        })}
      </div>
      <button className="primary" disabled={busy}>{busy ? "正在保存…" : "保存模型设置"}</button>
      {error && <p className="alert error" role="alert">{error}</p>}
      {notice && <p className="alert success" role="status">{notice}</p>}
      {preview && <PromptPreview stage={preview[0]} label={preview[1]} onClose={() => setPreview(null)} />}
    </form>
  );
}
