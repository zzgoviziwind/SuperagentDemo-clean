import { useEffect, useState } from "react";
import { request } from "./api";

type Person = {
  actor_id: string;
  name: string;
  reply: boolean;
  project_ids: number[];
};
type Access = {
  mode: string;
  owner_user_id: string;
  project_ids: number[];
  people: Person[];
  project_hints: { project_id: number; keywords: string[] }[];
  group_names: Record<string, string>;
  on_unmatched: string;
  default_project_id: number | null;
};
type Row = Record<string, any>;
const defaults: Access = {
  mode: "mapped",
  owner_user_id: "admin",
  project_ids: [],
  people: [],
  project_hints: [],
  group_names: {},
  on_unmatched: "pending",
  default_project_id: null,
};

export function MessageAccessPanel({
  settings,
  projects,
  onChange,
}: {
  settings: Row;
  projects: Row[];
  onChange: () => Promise<void>;
}) {
  const [config, setConfig] = useState<Access>(() => ({
    ...defaults,
    ...settings.dingtalk_request_access,
  }));
  const [senders, setSenders] = useState<Person[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void request<Row>(
      "/events?source=dingtalk&routing_status=pending_confirmation&limit=50",
    )
      .then((data) => {
        const people = new Map<string, Person>();
        for (const event of data.items ?? []) {
          const id = event.data?.actor_id;
          if (id)
            people.set(id, {
              actor_id: id,
              name: event.data?.metadata?.sender_name ?? "",
              reply: true,
              project_ids: [],
            });
        }
        if (live) setSenders([...people.values()]);
      })
      .catch(() => {
        if (live) setError("最近发送人读取失败，可手动输入发送人标识。");
      });
    return () => {
      live = false;
    };
  }, []);
  function updatePerson(index: number, values: Partial<Person>) {
    setConfig({
      ...config,
      people: config.people.map((person, i) =>
        i === index ? { ...person, ...values } : person,
      ),
    });
  }
  function projectChoices(ids: number[], change: (ids: number[]) => void) {
    return (
      <div className="access-projects">
        {projects.map((project) => (
          <label className="check" key={project.id}>
            <input
              type="checkbox"
              checked={ids.includes(Number(project.id))}
              onChange={(e) =>
                change(
                  e.target.checked
                    ? [...ids, Number(project.id)]
                    : ids.filter((id) => id !== Number(project.id)),
                )
              }
            />
            {project.name}
          </label>
        ))}
      </div>
    );
  }
  async function save() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await request("/settings", { dingtalk_request_access: config }, "PATCH");
      await onChange();
      setNotice(
        "人员与项目规则已保存，后续消息按新规则处理。历史待确认消息可在事件中重新检查。",
      );
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="setup-step message-access"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h3>哪些人可以请求处理</h3>
      {error && (
        <p role="alert" className="alert error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <label>
        人员回复范围
        <select
          value={config.mode}
          onChange={(e) => setConfig({ ...config, mode: e.target.value })}
        >
          <option value="mapped">使用已有身份与项目授权</option>
          <option value="all">全部回复，可排除指定人员</option>
          <option value="selected">仅回复配置人员</option>
          <option value="off">所有人都不回复</option>
        </select>
      </label>
      <p className="muted">
        配置人员中的“不回复”优先。全部回复与指定人员模式会授予下方项目的请求权限，代码执行继续使用工具审批和项目目录配置。
      </p>
      <label>
        承接任务的系统用户 ID
        <input
          required
          value={config.owner_user_id}
          onChange={(e) =>
            setConfig({ ...config, owner_user_id: e.target.value })
          }
        />
      </label>
      <fieldset>
        <legend>默认候选项目</legend>
        {projectChoices(config.project_ids, (ids) =>
          setConfig({ ...config, project_ids: ids }),
        )}
      </fieldset>
      <label>
        从待确认消息添加发送人
        <select
          value=""
          onChange={(e) => {
            const person = senders.find(
              (sender) => sender.actor_id === e.target.value,
            );
            if (
              person &&
              !config.people.some((item) => item.actor_id === person.actor_id)
            )
              setConfig({ ...config, people: [...config.people, person] });
          }}
        >
          <option value="">选择发送人</option>
          {senders.map((person) => (
            <option key={person.actor_id} value={person.actor_id}>
              {person.name || person.actor_id}
            </option>
          ))}
        </select>
      </label>
      {config.people.map((person, index) => (
        <fieldset key={index} className="person-rule">
          <legend>人员规则</legend>
          <label>
            人员名称
            <input
              value={person.name}
              onChange={(e) => updatePerson(index, { name: e.target.value })}
            />
          </label>
          <label>
            钉钉发送人标识
            <input
              required
              value={person.actor_id}
              onChange={(e) =>
                updatePerson(index, { actor_id: e.target.value.trim() })
              }
            />
          </label>
          <label>
            是否回复
            <select
              value={person.reply ? "reply" : "off"}
              onChange={(e) =>
                updatePerson(index, { reply: e.target.value === "reply" })
              }
            >
              <option value="reply">回复</option>
              <option value="off">不回复</option>
            </select>
          </label>
          <fieldset>
            <legend>此人的候选项目（留空使用默认候选项目）</legend>
            {projectChoices(person.project_ids, (ids) =>
              updatePerson(index, { project_ids: ids }),
            )}
          </fieldset>
          <button
            type="button"
            onClick={() =>
              setConfig({
                ...config,
                people: config.people.filter((_, i) => i !== index),
              })
            }
          >
            移除此人规则
          </button>
        </fieldset>
      ))}
      <button
        type="button"
        onClick={() =>
          setConfig({
            ...config,
            people: [
              ...config.people,
              { actor_id: "", name: "", reply: true, project_ids: [] },
            ],
          })
        }
      >
        添加人员规则
      </button>
      <h3>识别消息所属项目</h3>
      <p className="muted">
        按消息中的项目名称或关键词、群信息、同一人同一会话的历史归属及个人候选项目识别。多个匹配会进入下方未识别处理。
      </p>
      {projects.map((project) => (
        <label key={project.id}>
          {project.name} 的识别关键词
          <input
            value={
              config.project_hints
                .find((hint) => hint.project_id === Number(project.id))
                ?.keywords.join("，") ?? ""
            }
            onChange={(e) =>
              setConfig({
                ...config,
                project_hints: [
                  ...config.project_hints.filter(
                    (hint) => hint.project_id !== Number(project.id),
                  ),
                  {
                    project_id: Number(project.id),
                    keywords: e.target.value.split(/[,，]/),
                  },
                ],
              })
            }
            placeholder="例如 德阳，德阳市人民医院"
          />
        </label>
      ))}
      <label>
        无法识别所属项目时
        <select
          value={config.on_unmatched}
          onChange={(e) =>
            setConfig({ ...config, on_unmatched: e.target.value })
          }
        >
          <option value="pending">留在事件中心待确认</option>
          <option value="ask">回复追问所属项目</option>
          <option value="default">使用默认项目处理</option>
        </select>
      </label>
      <label>
        承接追问或未识别消息的默认项目
        <select
          value={config.default_project_id ?? ""}
          onChange={(e) =>
            setConfig({
              ...config,
              default_project_id: e.target.value
                ? Number(e.target.value)
                : null,
            })
          }
        >
          <option value="">请选择默认项目</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </label>
      <p className="muted">
        默认项目可绑定已有空目录，用于通用问答。追问将生成回复任务，用户补充项目后继续处理原始请求，发送方式沿用自动回复与交付配置。
      </p>
      <button className="primary" disabled={busy}>
        保存人员与项目规则
      </button>
    </form>
  );
}
