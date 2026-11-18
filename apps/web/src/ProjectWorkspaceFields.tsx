import { useEffect, useRef, useState } from "react";
import { ApiError, request } from "./api";

type Repository = { path: string; base_branch: string };
type Listing = {
  path: string;
  parent: string | null;
  directories: { name: string; path: string; repository: boolean }[];
  branches: string[];
  current_branch?: string;
  repositories?: { name: string; path: string }[];
  repositories_complete?: boolean;
  warning?: string;
};

export function ProjectWorkspaceFields({
  path,
  repositories,
  onChange,
}: {
  path: string;
  repositories: Repository[];
  onChange: (path: string, repositories: Repository[]) => void;
}) {
  const generation = useRef(0);
  const [codexProjects, setCodexProjects] = useState<
    { id: string; name: string; path: string }[]
  >([]);
  const [rootBranches, setRootBranches] = useState<string[]>([]);
  useEffect(() => {
    void request<{ items: typeof codexProjects }>(
      "/project-workspace/codex-projects",
    )
      .then((d) => setCodexProjects(d.items ?? []))
      .catch(() => {});
  }, []);
  useEffect(() => {
    let active = true;
    setRootBranches([]);
    const timer = setTimeout(() => {
      if (path)
        void request<Listing>(
          `/project-workspace?path=${encodeURIComponent(path)}`,
        )
          .then((data) => {
            if (active) setRootBranches(data.branches ?? []);
          })
          .catch(() => {
            if (active) setRootBranches([]);
          });
    }, 300);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [path]);
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState("");
  const [selecting, setSelecting] = useState(false);
  const [webBrowseAvailable, setWebBrowseAvailable] = useState(false);
  const [branches, setBranches] = useState<Record<string, string[]>>({});
  const repositoryPaths = JSON.stringify(repositories.map((repo) => repo.path));
  useEffect(() => {
    let active = true;
    generation.current += 1;
    setBranches({});
    setListing(null);
    setError("");
    const paths: string[] = JSON.parse(repositoryPaths);
    void Promise.all(
      paths.map(async (relative) => {
        const listing = await request<Listing>(
          `/project-workspace?path=${encodeURIComponent(path + "/" + relative)}`,
        );
        return [relative, listing.branches ?? []] as const;
      }),
    )
      .then((entries) => {
        if (active) setBranches(Object.fromEntries(entries));
      })
      .catch((error) => {
        if (active) setError((error as Error).message);
      });
    return () => {
      active = false;
      generation.current += 1;
    };
  }, [path, repositoryPaths]);
  async function browse(value: string) {
    const version = generation.current;
    try {
      const result = await request<Listing>(
        `/project-workspace?path=${encodeURIComponent(value)}`,
      );
      if (version !== generation.current) return;
      setListing(result);
      setError("");
    } catch (e) {
      if (version === generation.current) setError((e as Error).message);
    }
  }
  async function selectDirectory() {
    const version = generation.current;
    setSelecting(true);
    setError("");
    try {
      const result = await request<{ path: string | null }>(
        "/project-workspace/select-directory",
        { path },
        "POST",
        190000,
      );
      if (version !== generation.current || !result.path) return;
      onChange(result.path, []);
      setListing(null);
    } catch (e) {
      if (version !== generation.current) return;
      setError((e as Error).message);
      if (e instanceof ApiError && [501, 503].includes(e.status))
        setWebBrowseAvailable(true);
    } finally {
      setSelecting(false);
    }
  }
  async function scan() {
    const version = generation.current;
    try {
      const root = await request<Listing>(
        `/project-workspace?path=${encodeURIComponent(path)}`,
      );
      const discovered =
        root.repositories ?? root.directories.filter((d) => d.repository);
      const candidates = await Promise.all(
        discovered.map(async (d) => ({
          directory: d,
          listing: await request<Listing>(
            `/project-workspace?path=${encodeURIComponent(d.path)}`,
          ),
        })),
      );
      if (version !== generation.current) return;
      setBranches(
        Object.fromEntries(
          candidates.map((c) => [c.directory.name, c.listing.branches]),
        ),
      );
      onChange(
        path,
        candidates.map(
          (c) =>
            repositories.find((r) => r.path === c.directory.name) ?? {
              path: c.directory.name,
              base_branch: c.listing.current_branch ?? "",
            },
        ),
      );
      setError(
        root.repositories_complete === false
          ? "目录较大，仅识别了部分仓库，请选择更具体的项目目录。"
          : (root.warning ?? ""),
      );
    } catch (e) {
      if (version === generation.current) setError((e as Error).message);
    }
  }
  return (
    <section className="workspace-fields">
      <label>
        从本机 Codex 项目选择
        <select
          value={codexProjects.find((p) => p.path === path)?.id ?? ""}
          onChange={(e) => {
            const project = codexProjects.find((p) => p.id === e.target.value);
            if (project) onChange(project.path, []);
          }}
        >
          <option value="">选择已有项目</option>
          {codexProjects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} · {p.path}
            </option>
          ))}
        </select>
      </label>
      <datalist id="project-branches">
        {rootBranches.map((branch) => (
          <option key={branch} value={branch} />
        ))}
      </datalist>
      <div className="actions">
        <button
          type="button"
          disabled={selecting}
          onClick={() => void selectDirectory()}
        >
          {selecting ? "正在选择目录…" : "选择项目目录"}
        </button>
        {webBrowseAvailable && (
          <button type="button" onClick={() => void browse(path)}>
            网页浏览目录
          </button>
        )}
        <button type="button" disabled={!path} onClick={() => void scan()}>
          识别目录下的仓库
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      {listing && (
        <div className="directory-browser">
          <strong>{listing.path}</strong>
          <div className="actions">
            <button
              type="button"
              onClick={() => {
                onChange(listing.path, []);
                setListing(null);
              }}
            >
              使用此目录
            </button>
            <button
              type="button"
              disabled={!listing.parent}
              onClick={() => void browse(listing.parent!)}
            >
              上一级
            </button>
            <button type="button" onClick={() => setListing(null)}>
              关闭
            </button>
          </div>
          <div className="directory-list">
            {listing.directories.map((d) => (
              <button
                type="button"
                key={d.path}
                onClick={() => void browse(d.path)}
              >
                {d.name}
                {d.repository ? " · Git 仓库" : ""}
              </button>
            ))}
          </div>
        </div>
      )}
      {!!repositories.length && (
        <>
          <h3>子仓库与基线</h3>
          <p className="muted">
            Worker
            在包含以下仓库的独立项目目录中执行，按任务需要处理相应仓库。各仓库使用自己的基线分支。
          </p>
          {repositories.map((repo, index) => (
            <div className="repository-row" key={repo.path}>
              <strong>{repo.path}</strong>
              <select
                aria-label={`${repo.path} 基线分支`}
                value={repo.base_branch}
                onChange={(e) =>
                  onChange(
                    path,
                    repositories.map((r, i) =>
                      i === index ? { ...r, base_branch: e.target.value } : r,
                    ),
                  )
                }
              >
                {[
                  ...new Set([
                    repo.base_branch,
                    ...(branches[repo.path] ?? []),
                  ]),
                ].map((branch) => (
                  <option key={branch} value={branch}>
                    {branch || "请选择基线分支"}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() =>
                  onChange(
                    path,
                    repositories.filter((_, i) => i !== index),
                  )
                }
              >
                移除仓库
              </button>
            </div>
          ))}
        </>
      )}
    </section>
  );
}
