import { reasonText } from "./InboxPanel";
type Row = Record<string, any>;
export const STEP_NAMES = ['接收', '识别与分派', '处理与核验', '回复与收尾'];
export const deliverySucceeded = (d: Row) => d.record?.result?.write_status === 'succeeded';
export const replyNeedsEngine = (t: Row) => t.kind === 'reply' && t.status === 'waiting_resource' &&
  !t.outcome_unknown && [
    '本机回复引擎配置无效，请在 Agent 页面检查连接',
    '未配置本机回复引擎',
    '本机 Codex 的执行配置不可用。请到「管理设置 → 本机 Agent」重新连接。',
    '尚未连接本机 Codex。请到「管理设置 → 本机 Agent」连接。',
  ].includes(t.last_error);
export function nextAction(t: Row): string {
  if (t.outcome_unknown) return '先核验执行是否已停止，提交对账证据；不能直接重试。';
  if (t.processing_status === 'reply_sent') return '渠道已确认发送，回复内容和发送记录可在下方查看。';
  if (t.processing_status === 'reply_skipped') return '本轮无需向原会话回复，判断依据见下方渠道回复。';
  if (t.kind === 'reply' && t.status === 'review_ready') {
    if (t.reply_decision === 'skip') return '本轮无需向原会话回复，判断依据见下方渠道回复。';
    return '回复判断已完成，请查看下方渠道回复状态。需要核实项目代码时，在事件处理中选择改为只读分析。';
  }
  if (replyNeedsEngine(t)) return '消息已接收，本轮回复尚未启动。可在事件处理中检查本机 Agent，再重新执行回复。';
  return ({queued:'等待调度；若长期未开始，请检查调度开关、节点与预算。', running:'正在执行；可补充信息、暂停或取消。', waiting_approval:'核对本次工具动作并批准或拒绝；批准只授权这次动作。', waiting_input:'补充缺少的信息或调整目标，再点击恢复；保存补充不等于恢复。', paused:'确认目标和工作区后点击恢复，从保留的任务继续。', failed:'检查失败证据，修正原因后重试；不会自动重发外部消息。', waiting_resource:'检查下方具体原因；附件失败可重试附件，节点或预算问题需先修复配置。', review_ready:'查看当前版本产物和验证证据，再验收或退回补充。', completed:'执行已验收；继续核对来源事件是否解决，以及回复是否真正发送。', cancelled:'事件已关闭，原消息和处理记录已保留。需要继续时可使用恢复选项。'} as Record<string,string>)[t.status] ?? '状态未识别，请查看处理记录，不推断已完成。';
}
export function EventNextStep({trace,onOpenTask,onManage,onRetry,busy,onOpenSession}: {trace:Row;onOpenTask:(id:string)=>void;onManage:()=>void;onRetry:()=>void;busy:boolean;onOpenSession?:(id:string)=>void}) {
  const tasks:Row[] = trace.target_tasks?.length ? trace.target_tasks : trace.task ? [trace.task] : [];
  const pending=trace.event.data?.routing_status === 'pending_confirmation';
  const deliveries:Row[]=trace.deliveries ?? [];
  return <section className="next-step-card" aria-label="下一步处理">
    <h3>现在需要做什么</h3>
    <p><strong>处理目标：</strong>{tasks.length ? tasks.map(t=>t.goal || t.title).join('；') : '尚未形成处理目标；先确认来源、权限和请求内容。'}</p>
    {!tasks.length && <><p>{pending ? `当前等待分派确认：${reasonText(trace.event.data?.routing_reason)}。修改配置后可重新检查；语义结果未知时应先进入分派管理核验。` : '是否继续处理取决于来源策略和分派结果；忽略的事件不会自动执行。'}</p>{pending && <div className="actions"><button onClick={onManage}>检查身份、项目与策略</button>{trace.routing_session_id && onOpenSession && <button onClick={()=>onOpenSession(trace.routing_session_id)}>打开分派会话与核验</button>}<button disabled={busy || trace.semantic_routing?.status === 'unknown'} onClick={onRetry}>修正后重新检查</button></div>}</>}
    {tasks.map(t=><article key={t.id}><strong>{t.title}</strong><p>{nextAction(t)}</p>{t.last_error && <p role="status">当前原因：{t.last_error}</p>}<button className="primary" onClick={()=>onOpenTask(String(t.id))}>进入处理 · {t.outcome_unknown ? '核验未知结果' : t.status === 'waiting_approval' ? '审核动作' : ['waiting_input','paused','failed'].includes(t.status) ? '补充与恢复' : '查看结果和操作'}</button><small> 当前需求版本 {t.revision ?? '未知'}；计划变化与原因见处理记录。</small></article>)}
    <p><strong>完成条件：</strong>当前版本结果通过核验、来源事件逐条确认；需要回复时另行审批并发送。代码修复还需真实测试证据。</p>
    <p><strong>回复与收尾：</strong>{deliveries.length ? `${deliveries.filter(deliverySucceeded).length} / ${deliveries.length} 条回复已确认发送。其余需检查草稿、审批或发布结果。` : '暂无回复记录；不要将执行完成视为已回复。'} 目标渠道：{trace.event.source}；外部问题状态自动同步尚未实现。</p>
    <p className="muted">预计完成时间未知。下一次推进由调度、模型返回或上述人工操作触发；后续步骤是条件路径，不是已经执行的事实。相关任务证据可能包含其他来源事件。</p>
  </section>;
}
