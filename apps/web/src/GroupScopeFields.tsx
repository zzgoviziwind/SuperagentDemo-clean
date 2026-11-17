import { useEffect, useRef, useState } from "react";
import { SettingsDrawer } from "./SettingsDrawer";
import { request } from "./api";

type Group = { id: string; name: string };
type SearchResult = {
  items: Group[];
  complete: boolean;
  has_more?: boolean;
  next_cursor?: string | null;
};
export function GroupScopeFields({
  scope,
  ids,
  names,
  originalNames = {},
  onOriginalName,
  onChange,
}: {
  scope: string;
  ids: string[];
  names: Record<string, string>;
  originalNames?: Record<string, string>;
  onOriginalName?: (id: string, name: string) => void;
  onChange: (
    scope: string,
    ids: string[],
    names: Record<string, string>,
    originalNames: Record<string, string>,
  ) => void;
}) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<Group[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [incomplete, setIncomplete] = useState(false);
  const [panel, setPanel] = useState<string | null>(null);
  const [remarks, setRemarks] = useState<Record<string, string>>({});
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [searchedQuery, setSearchedQuery] = useState("");
  const searchVersion = useRef(0);
  const cache = useRef(
    new Map<string, { result: SearchResult; time: number }>(),
  );
  const [resolvedNames, setResolvedNames] = useState<Record<string, string>>(
    {},
  );
  const [nameErrors, setNameErrors] = useState<Record<string, boolean>>({});
  const groupOriginalNames = { ...originalNames, ...resolvedNames };
  const knownIds = [
    ...new Set([...Object.keys(names), ...Object.keys(originalNames), ...ids]),
  ];
  const currentGroupIds = useRef(new Set(knownIds));
  currentGroupIds.current = new Set(knownIds);
  const groupKey = JSON.stringify([...knownIds].sort());
  async function resolveOriginalName(id: string, live: () => boolean) {
    try {
      const group = await request<Group>(
        `/connectors/dingtalk/group?chat_id=${encodeURIComponent(id)}`,
        undefined,
        "GET",
        30000,
      );
      if (group.id !== id || !group.name?.trim())
        throw new Error("群原名未返回");
      if (live() && currentGroupIds.current.has(id)) {
        setResolvedNames((current) => ({ ...current, [id]: group.name }));
        setNameErrors((current) => ({ ...current, [id]: false }));
        onOriginalName?.(id, group.name);
      }
    } catch {
      if (live()) setNameErrors((current) => ({ ...current, [id]: true }));
    }
  }
  useEffect(() => {
    let live = true;
    const missing = (JSON.parse(groupKey) as string[]).filter(
      (id) => !groupOriginalNames[id],
    );
    async function loadNames() {
      while (live && missing.length) {
        const id = missing.shift()!;
        await resolveOriginalName(id, () => live);
      }
    }
    void Promise.all(
      Array.from({ length: Math.min(3, missing.length) }, loadNames),
    );
    return () => {
      live = false;
    };
  }, [groupKey]);
  function toggle(id: string, enabled: boolean) {
    onChange(
      scope,
      enabled ? [...ids, id] : ids.filter((item) => item !== id),
      { ...names, [id]: names[id] ?? "" },
      groupOriginalNames,
    );
  }
  function closePanel() {
    searchVersion.current += 1;
    setBusy(false);
    setPanel(null);
  }
  async function search(cursor = "") {
    const term = query.trim();
    const version = ++searchVersion.current;
    setBusy(true);
    setError("");
    if (!cursor) {
      setItems([]);
      setIncomplete(false);
      setNextCursor(null);
    }
    try {
      const path = `/connectors/dingtalk/groups?q=${encodeURIComponent(term)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const cached = cache.current.get(path);
      const result =
        cached && Date.now() - cached.time < 60000
          ? cached.result
          : await request<SearchResult>(path, undefined, "GET", 30000);
      if (version !== searchVersion.current) return;
      if (cache.current.size >= 50) cache.current.clear();
      cache.current.set(path, { result, time: Date.now() });
      setItems((previous) => [
        ...new Map(
          [...(cursor ? previous : []), ...(result.items ?? [])].map((item) => [
            item.id,
            item,
          ]),
        ).values(),
      ]);
      setIncomplete(result.complete !== true);
      setSearchedQuery(term);
      setNextCursor(
        result.has_more === true &&
          result.next_cursor &&
          result.next_cursor !== cursor
          ? result.next_cursor
          : null,
      );
    } catch (error) {
      if (version === searchVersion.current) setError((error as Error).message);
    } finally {
      if (version === searchVersion.current) setBusy(false);
    }
  }
  return (
    <div className="group-reception-settings">
      <label>
        群接收范围
        <select
          value={scope}
          onChange={(e) =>
            onChange(e.target.value, ids, names, groupOriginalNames)
          }
        >
          <option value="selected">指定群</option>
          <option value="all">所有群</option>
        </select>
      </label>
      <fieldset disabled={scope === "all"} className="configured-groups">
        <legend>已配置的指定群</legend>
        <div className="configured-group-grid">
          {knownIds.map((id) => (
            <div
              className={`configured-group${ids.includes(id) ? "" : " group-disabled"}`}
              key={id}
            >
              <span className="group-avatar" aria-hidden="true">
                群
              </span>
              <button
                type="button"
                className="group-name-button"
                onClick={() => setPanel(id)}
              >
                <strong>
                  {names[id]?.trim() || groupOriginalNames[id] || "未命名群"}
                </strong>
                <small>
                  群原名：
                  {groupOriginalNames[id] ||
                    (nameErrors[id] ? "暂时无法获取" : "正在获取…")}
                </small>
                <small>{ids.includes(id) ? "已开启" : "已关闭"} · 编辑</small>
              </button>
              <input
                type="checkbox"
                role="switch"
                className="group-switch"
                aria-label={`${names[id]?.trim() || groupOriginalNames[id] || "未命名群"}接收开关`}
                checked={ids.includes(id)}
                onChange={(e) => toggle(id, e.target.checked)}
              />
            </div>
          ))}
        </div>
        {!knownIds.length && (
          <p className="muted">暂无指定群，可按名称查找添加。</p>
        )}
        <button
          type="button"
          className="group-add-button"
          onClick={() => setPanel("add")}
        >
          ＋ 添加指定群
        </button>
      </fieldset>
      {panel && scope !== "all" && (
        <SettingsDrawer
          title={panel === "add" ? "添加指定群" : "编辑指定群"}
          onClose={closePanel}
        >
          {panel === "add" ? (
            <>
              <label>
                按钉钉群名称查找
                <input
                  value={query}
                  onChange={(e) => {
                    searchVersion.current += 1;
                    setBusy(false);
                    setQuery(e.target.value);
                    setItems([]);
                    setNextCursor(null);
                    setIncomplete(false);
                    setError("");
                  }}
                  onKeyDown={(e) => {
                    if (
                      e.key === "Enter" &&
                      !e.nativeEvent.isComposing &&
                      query.trim() &&
                      !busy
                    ) {
                      e.preventDefault();
                      void search();
                    }
                  }}
                  placeholder="输入群名称关键词"
                />
              </label>
              <button
                type="button"
                disabled={busy || !query.trim()}
                onClick={() => void search()}
              >
                {busy ? "正在查询…" : "查找群"}
              </button>
              {error && (
                <p role="alert" className="danger">
                  {error}
                </p>
              )}
              {incomplete && (
                <p className="muted">
                  {nextCursor
                    ? "已显示部分群，可继续加载或缩小关键词。"
                    : "当前为部分候选，请缩小群名称关键词继续查找。"}
                </p>
              )}
              {items.map((item) => (
                <div className="group-search-result" key={item.id}>
                  <strong>{item.name}</strong>
                  <label>
                    群备注（{item.name}）
                    <input
                      value={
                        remarks[item.id] ??
                        (names[item.id]?.trim() || item.name)
                      }
                      maxLength={200}
                      placeholder="默认使用钉钉群名，可修改"
                      onChange={(e) =>
                        setRemarks({ ...remarks, [item.id]: e.target.value })
                      }
                    />
                  </label>
                  <button
                    type="button"
                    disabled={ids.includes(item.id)}
                    onClick={() =>
                      onChange(
                        scope,
                        [...new Set([...ids, item.id])],
                        {
                          ...names,
                          [item.id]:
                            remarks[item.id]?.trim() ||
                            names[item.id]?.trim() ||
                            item.name,
                        },
                        { ...groupOriginalNames, [item.id]: item.name },
                      )
                    }
                  >
                    {ids.includes(item.id) ? "已添加" : "添加此群"}
                  </button>
                </div>
              ))}
              {nextCursor && searchedQuery === query.trim() && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void search(nextCursor)}
                >
                  {busy ? "正在加载…" : "加载更多群"}
                </button>
              )}
            </>
          ) : (
            <>
              <p className="muted">
                编辑后返回列表，保存消息与交付方式后生效。
              </p>
              <label>
                钉钉群原名
                <input
                  readOnly
                  value={groupOriginalNames[panel] ?? ""}
                  placeholder={
                    nameErrors[panel] ? "暂时无法获取群原名" : "正在获取群原名…"
                  }
                />
              </label>
              {nameErrors[panel] && (
                <button
                  type="button"
                  onClick={() => void resolveOriginalName(panel, () => true)}
                >
                  重新获取群原名
                </button>
              )}
              <p className="muted break-word">群标识：{panel}</p>
              <label>
                群备注
                <input
                  value={names[panel] ?? ""}
                  maxLength={200}
                  placeholder="默认使用钉钉群名，可修改"
                  onChange={(e) =>
                    onChange(
                      scope,
                      ids,
                      { ...names, [panel]: e.target.value },
                      groupOriginalNames,
                    )
                  }
                />
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  role="switch"
                  checked={ids.includes(panel)}
                  onChange={(e) => toggle(panel, e.target.checked)}
                />
                接收此群消息
              </label>
              <button
                type="button"
                className="danger"
                onClick={() => {
                  const remainingNames = { ...names };
                  const remainingOriginalNames = { ...groupOriginalNames };
                  delete remainingNames[panel];
                  delete remainingOriginalNames[panel];
                  setRemarks((current) => {
                    const remaining = { ...current };
                    delete remaining[panel];
                    return remaining;
                  });
                  setResolvedNames((current) => {
                    const remaining = { ...current };
                    delete remaining[panel];
                    return remaining;
                  });
                  onChange(
                    scope,
                    ids.filter((id) => id !== panel),
                    remainingNames,
                    remainingOriginalNames,
                  );
                  closePanel();
                }}
              >
                删除此群
              </button>
            </>
          )}
          <div className="settings-drawer-footer">
            <span className="muted">返回后请保存消息与交付方式</span>
            <button type="button" className="primary" onClick={closePanel}>
              完成，返回列表
            </button>
          </div>
        </SettingsDrawer>
      )}
      {scope === "all" && (
        <p className="muted">
          当前接收所有群，已配置的指定群保留，切换回指定群后继续使用。
        </p>
      )}
    </div>
  );
}
