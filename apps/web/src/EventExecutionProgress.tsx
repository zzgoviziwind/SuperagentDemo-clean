import { nextAction, replyNeedsEngine } from './EventNextStep';

type Row = Record<string, any>;
export type ProgressTarget = 'supplement' | 'results' | 'verification' | 'reply' | 'messages' | 'approval';

const kinds: Record<string, string> = { analysis: '只读分析', repair: '代码修复', reply: '生成回复' };
const reasonLabels: Record<string, string> = {
  analysis_workspace_changed: '只读分析期间工作区发生了变更',
  analysis_evidence_missing: '缺少有效的只读分析依据',
  tool_failure: '有工具调用失败',
  turn_not_completed: '执行轮次未正常结束',
  structured_outcome_missing: '未生成可核验的结构化结果',
  model_reports_incomplete: '执行助手报告结果尚未完成',
  change_evidence_missing: '缺少代码改动证据',
  verification_missing_or_failed: '缺少通过的验证记录',
};

function currentRun(task: Row, detail?: Row | null) {
  if (!detail?.task || detail.task.state_version !== task.state_version) return null;
  const events: Row[] = [...(detail?.events ?? [])].sort((a, b) => b.id - a.id);
  const start = events.find(e => e.event_type === 'run_started');
  if (!start || start.data?.revision !== task.revision || start.data?.control_version !== task.control_version) return null;
  return { start, events };
}

export function hasVerificationError(task: Row) {
  return task.status === 'waiting_input' && /^(只读分析存在|结果证据不足或工具失败)/.test(task.last_error ?? '');
}

function verificationBlock(task: Row, run: ReturnType<typeof currentRun>, detail?: Row | null) {
  if (task.status !== 'waiting_input' || !run) return null;
  const { start, events } = run;
  const end = events.find(e => e.id > start.id && e.event_type === 'verification_incomplete');
  if (!end) return null;
  const reasons = new Set<string>(Array.isArray(end.data?.reasons)
    ? end.data.reasons.flatMap((reason: string) => reasonLabels[reason] ? [reasonLabels[reason]] : []) : []);
  const artifact = (detail?.artifacts as Row[] | undefined)?.filter(a =>
    a.kind === 'verification' && a.revision === task.revision &&
    a.created_at >= start.created_at && a.created_at <= end.created_at
  ).sort((a, b) => b.id - a.id)[0];
  if (artifact) {
    try {
      const record = typeof artifact.content === 'string' ? JSON.parse(artifact.content) : artifact.content;
      if (task.kind === 'analysis' && record?.has_changes) reasons.add(reasonLabels.analysis_workspace_changed);
      if (record?.analysis_read_evidence?.denied_access) reasons.add('读取权限被拒绝');
      if (record?.analysis_read_evidence?.unresolved_errors > 0) reasons.add('仍有读取错误未解决');
    } catch { /* The verification event may still contain displayable reasons. */ }
  }
  return { reasons: [...reasons], time: end.created_at };
}

export function EventExecutionProgress({ task, detail, supplementAvailable, operationsAvailable, jump }: {
  task: Row;
  detail?: Row | null;
  supplementAvailable: boolean;
  operationsAvailable: boolean;
  jump: (target: ProgressTarget) => void;
}) {
  const kind = kinds[task.kind] ?? '任务处理';
  const run = currentRun(task, detail);
  const verification = verificationBlock(task, run, detail);
  const legacyVerification = hasVerificationError(task);
  const blocked = !!verification || legacyVerification;
  const ordinary: Record<string, string> = {
    queued: `${kind}已排队，等待开始`,
    running: `正在${kind}`,
    waiting_input: blocked ? `${kind}已停在结果核验` : `${kind}等待人工处理`,
    waiting_approval: `${kind}等待操作审批`,
    waiting_resource: replyNeedsEngine(task) ? '回复尚未启动，等待连接本机 Agent' : `${kind}等待执行条件`,
    paused: `${kind}已暂停`,
    failed: `${kind}执行失败`,
    review_ready: task.kind === 'reply' ? '回复判断已完成，查看渠道结果' : `${kind}已提交结果，等待验收`,
    completed: task.pending_event_count ? '任务已验收，原消息仍待核验' : '任务已完成',
    cancelled: '事件已关闭',
  };
  const stage = task.outcome_unknown ? '执行结果未知，等待人工核对'
    : task.last_error === '正在停止执行' ? '正在停止，等待执行端确认'
    : task.processing_status === 'reply_sent' ? '回复已发送，渠道已确认'
    : task.processing_status === 'reply_skipped' ? '回复判断已完成，本轮无需回复'
    : ordinary[task.status] ?? '当前阶段待核对';
  const explicitReason = typeof task.last_error === 'string' && task.last_error.trim();
  const reason = verification?.reasons.length ? verification.reasons.join('；')
    : legacyVerification && task.last_error.startsWith('只读分析存在')
      ? '只读分析未通过核验，现有记录未指出是工作区变更、权限不足，还是读取失败。'
    : explicitReason || (blocked ? '系统未记录具体阻塞原因。' : task.status === 'waiting_input' ? '系统未记录具体缺项。' : '');
  const next = task.outcome_unknown ? '请按下方提示核对原执行，再提交证据。'
    : task.last_error === '正在停止执行' ? '等待状态更新，无需再次操作。'
    : blocked ? (verification?.reasons.includes('读取权限被拒绝')
      ? '检查所属项目和读取权限，修正后点击「恢复」。'
      : '先查看核验记录。缺少材料时先保存补充；问题解决后点击「恢复」。')
    : task.status === 'waiting_input' ? '先核对处理记录。如有信息要补充，保存后点击「恢复」。'
    : task.status === 'completed' ? (task.pending_event_count ? '逐条核对原消息是否已解决。' : '无需继续执行；可查看处理记录。')
    : task.status === 'running' ? '执行仍在进行，暂时无需操作。'
    : nextAction(task);
  let action: [ProgressTarget, string] | undefined;
  if (!task.outcome_unknown && task.last_error !== '正在停止执行') {
    if (blocked) action = ['verification', '查看核验记录'];
    else if (task.status === 'failed') action = ['results', '查看处理记录'];
    else if (task.status === 'waiting_input') action = supplementAvailable ? ['supplement', '补充信息'] : ['results', '查看处理记录'];
    else if (task.status === 'waiting_approval' && operationsAvailable) action = ['approval', '查看待审批动作'];
    else if (task.status === 'review_ready') action = task.kind === 'reply'
      ? operationsAvailable ? ['reply', '查看渠道回复'] : ['results', '查看处理结果']
      : ['results', '查看待验收结果'];
    else if (task.status === 'completed' && task.pending_event_count) action = ['messages', '核对原消息'];
  }
  const startTime = task.status === 'running' ? run?.start.created_at : undefined;
  const time = verification?.time ?? startTime ?? task.updated_at;
  return <>
    <div className="event-progress-summary" role="status">
      <h3>{stage}</h3>
      {time && <small className="muted">{verification ? '核验时间' : startTime ? '本轮开始' : '任务更新'}：<time dateTime={time}>{new Date(time).toLocaleString('zh-CN')}</time></small>}
      {reason && <p><strong>停在这里的原因：</strong>{reason}</p>}
      <p><strong>下一步：</strong>{next}</p>
    </div>
    {action && <div className="actions wrap event-progress-actions">
      <button className="primary" type="button" onClick={() => jump(action[0])}>{action[1]}</button>
      {blocked && supplementAvailable && <button type="button" onClick={() => jump('supplement')}>补充信息</button>}
    </div>}
  </>;
}
