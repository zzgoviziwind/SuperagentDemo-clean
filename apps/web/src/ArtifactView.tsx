import { VerificationView } from "./VerificationView";
type Row = Record<string, any>;
const text = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value, null, 2);
function parse(content: unknown): unknown {
  if (typeof content !== "string") return content;
  const normalized = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(normalized);
  } catch {
    return content;
  }
}

export function ArtifactView({
  artifact,
  revision,
}: {
  artifact: Row;
  revision: number;
}) {
  const parsed = parse(artifact.content);
  const data =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Row)
      : null;
  function content() {
    if (artifact.kind === "summary")
      return (
        <>
          {data?.status && <p>模型报告状态 {text(data.status)}</p>}
          <pre>{data?.summary ? text(data.summary) : text(parsed)}</pre>
        </>
      );
    if (artifact.kind === "changes") {
      if (!data)
        return (
          <p className="danger">改动产物无法解析，请下载完整 JSON 核对。</p>
        );
      return (
        <>
          <p>基线提交 {data.base_sha ?? "未提供"}</p>
          <h4>改动统计</h4>
          <pre>{text(data.stat) || "无已跟踪文件统计"}</pre>
          <h4>代码差异</h4>
          <pre>{text(data.diff) || "无已跟踪文件差异"}</pre>
          <h4>新增文件</h4>
          {Array.isArray(data.untracked_artifacts) &&
          data.untracked_artifacts.length ? (
            <ul>
              {data.untracked_artifacts.map((file: Row, index: number) => (
                <li key={file.path ?? index}>
                  <strong>{file.path ?? "未提供文件名"}</strong> ·{" "}
                  {file.size ?? "未知"} 字节
                  {file.sha256 && <small>SHA256 {file.sha256}</small>}
                </li>
              ))}
            </ul>
          ) : (
            <p>无新增文件记录</p>
          )}
          {data.status && (
            <details>
              <summary>Git 文件状态</summary>
              <pre>{text(data.status)}</pre>
            </details>
          )}
        </>
      );
    }
    if (artifact.kind === "verification") {
      if (!data)
        return (
          <>
            <p className="danger">验证记录无法解析，验证状态未确认。</p>
            <pre>{text(parsed)}</pre>
          </>
        );
      return <VerificationView data={data} />;
    }
    return <pre>{text(parsed)}</pre>;
  }
  return (
    <article className="artifact">
      <h3>
        {artifact.name ??
          artifact.title ??
          (
            {
              summary: "分析摘要",
              changes: "代码改动",
              verification: "验证记录",
            } as Record<string, string>
          )[artifact.kind] ??
          artifact.kind ??
          "产物"}
      </h3>
      <small>
        目标版本 {artifact.revision ?? "未提供"} ·{" "}
        {artifact.revision === revision ? "当前版本" : "历史版本"}
        {artifact.verification_status
          ? ` · ${artifact.verification_status}`
          : ""}
      </small>
      {content()}
      <a
        className="download-link"
        href={`/api/v1/artifacts/${encodeURIComponent(artifact.id)}/download`}
        download
      >
        下载完整产物 JSON
      </a>
    </article>
  );
}
