type Row = Record<string, any>;
const text = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value, null, 2);

export function VerificationView({ data }: { data: Row }) {
  const assessment = data.assessment;
  const analysis = assessment?.task_kind === "analysis";
  const readEvidence =
    data.analysis_evidence ?? data.analysis_read_evidence ?? {};
  const blocking = Array.isArray(assessment?.blocking_tool_failures)
    ? assessment.blocking_tool_failures
    : [];
  const failures: Row[] = assessment?.tool_failures?.length
    ? assessment.tool_failures
    : Array.isArray(data.tool_failures)
      ? data.tool_failures
      : [];
  const commands: Row[] = Array.isArray(data.tool_evidence)
    ? data.tool_evidence
    : [];
  const streamComplete = data.stream_incomplete === false;
  const ready =
    assessment?.suggested_status === "review_ready" &&
    !blocking.length &&
    streamComplete;
  const analysisVerified =
    ready &&
    assessment?.verification?.status === "passed" &&
    data.has_changes === false &&
    readEvidence.denied_access !== true &&
    !(readEvidence.unresolved_errors > 0);
  const legacyRepairVerified =
    data.tests_executed === true &&
    data.exit_code === 0 &&
    streamComplete &&
    !data.model_reported_blocked &&
    !failures.length &&
    data.collector_verification?.status === "passed";
  const repairVerified =
    data.repair_verified === undefined
      ? legacyRepairVerified
      : data.repair_verified === true && ready;
  const verified = analysis ? analysisVerified : repairVerified;
  const limitations =
    readEvidence.limitations ??
    assessment?.outcome?.limitations ??
    data.limitations;
  return (
    <>
      <p className={verified ? "success alert" : "error alert"}>
        {verified
          ? analysis
            ? "只读分析证据通过"
            : "验证证据通过"
          : "验证未通过或尚未完整验证"}
      </p>
      {analysis ? (
        <>
          <h4>只读分析证据</h4>
          <dl>
            <dt>成功调用</dt>
            <dd>{readEvidence.successful_calls ?? "未记录"}</dd>
            <dt>有效取证调用</dt>
            <dd>{readEvidence.evidence_calls ?? "未记录"}</dd>
            <dt>读取文件数</dt>
            <dd>{readEvidence.file_count ?? "未记录"}</dd>
            <dt>只读工具</dt>
            <dd>
              {Array.isArray(readEvidence.tools)
                ? readEvidence.tools.join("、") || "无工具记录"
                : "未记录"}
            </dd>
            <dt>工作区改动</dt>
            <dd>
              {data.has_changes === false
                ? "未产生改动"
                : data.has_changes === true
                  ? "存在改动，需人工处理"
                  : "未记录"}
            </dd>
            <dt>访问拒绝</dt>
            <dd>
              {readEvidence.denied_access === true
                ? "存在访问拒绝"
                : readEvidence.denied_access === false
                  ? "无"
                  : "未记录"}
            </dd>
            <dt>未解决错误</dt>
            <dd>{readEvidence.unresolved_errors ?? "未记录"}</dd>
            <dt>不可读文件</dt>
            <dd>{readEvidence.unreadable_files ?? "未记录"}</dd>
            <dt>截断结果</dt>
            <dd>{readEvidence.truncated_results ?? "未记录"}</dd>
          </dl>
          <h4>分析限制</h4>
          {Array.isArray(limitations) ? (
            limitations.length ? (
              <ul>
                {limitations.map((item: unknown, index: number) => (
                  <li key={index}>{text(item)}</li>
                ))}
              </ul>
            ) : (
              <p>后端未记录额外限制</p>
            )
          ) : (
            <pre>
              {limitations
                ? text(limitations)
                : "未提供限制说明，请结合只读证据核对分析范围。"}
            </pre>
          )}
        </>
      ) : (
        <>
          <dl>
            <dt>测试命令</dt>
            <dd>{text(data.command) || "未提供"}</dd>
            <dt>实际执行</dt>
            <dd>
              {data.tests_executed === true ? "已记录执行" : "未确认执行"}
            </dd>
            <dt>退出码</dt>
            <dd>{data.exit_code ?? data.returncode ?? "未记录"}</dd>
            <dt>证据来源</dt>
            <dd>{data.source ?? "未提供"}</dd>
            <dt>采集验证</dt>
            <dd>{data.collector_verification?.status ?? "未提供"}</dd>
          </dl>
          <h4>测试输出</h4>
          <pre>{text(data.output) || "无测试输出记录"}</pre>
        </>
      )}
      <dl>
        <dt>后端评估</dt>
        <dd>{assessment?.suggested_status ?? "未记录"}</dd>
        <dt>事件流</dt>
        <dd>
          {streamComplete
            ? "记录完整"
            : data.stream_incomplete === true
              ? "不完整，仍需核验"
              : "完整性未记录"}
        </dd>
        <dt>阻塞失败数</dt>
        <dd>{assessment ? blocking.length : "未记录"}</dd>
      </dl>
      {!!assessment?.reasons?.length && (
        <pre className="danger">{text(assessment.reasons)}</pre>
      )}
      <h4>失败记录</h4>
      {failures.length ? (
        failures.map((failure, index) => (
          <div key={failure.id ?? index}>
            <p className={failure.recovered === true ? "muted" : "danger"}>
              {failure.recovered === true
                ? "历史失败 · 已恢复"
                : failure.recovered === false
                  ? "失败 · 尚未恢复"
                  : "历史工具失败，恢复情况见后端评估"}
            </p>
            <pre>{text(failure)}</pre>
          </div>
        ))
      ) : (
        <p>无已记录的工具失败，仍需核对验证状态与证据完整性。</p>
      )}
      {!analysis && (
        <>
          <h4>执行证据</h4>
          {commands.length ? (
            commands.map((item, index) => (
              <details key={item.id ?? index}>
                <summary>
                  {item.command || "未记录命令"} · 退出码{" "}
                  {item.exit_code ?? "未记录"} · {item.status ?? "状态未记录"}
                </summary>
                <p>工作目录 {item.cwd ?? "未记录"}</p>
                <pre>{text(item.output) || "无输出记录"}</pre>
              </details>
            ))
          ) : (
            <p>无工具执行证据</p>
          )}
        </>
      )}
      <details>
        <summary>{analysis ? "完整只读核验证据" : "采集器核验证据"}</summary>
        <pre>
          {text(
            analysis
              ? { ...readEvidence, verification: assessment?.verification }
              : (data.collector_verification ?? "未提供"),
          )}
        </pre>
      </details>
    </>
  );
}
