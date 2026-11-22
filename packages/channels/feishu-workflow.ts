import type { DatabaseSync } from 'node:sqlite';
import { clearTimeout,setTimeout } from 'node:timers';
import type { CardConfig } from './feishu.ts';

export const workflowLabels = {
  retry_attachments:'重试附件', resume:'恢复执行', retry:'重试任务', cancel:'关闭任务',
  supplement:'补充并继续', accept:'通过验收', rerun:'重新生成', publish:'确认并发送', reject:'拒绝草稿',
  delivery_succeeded:'确认已发送', delivery_failed:'确认未发送', execution_stopped:'确认执行已停止',
} as const;
export type WorkflowAction=keyof typeof workflowLabels;
const needsNote=new Set<WorkflowAction>(['supplement','delivery_succeeded','delivery_failed','execution_stopped']);
const text=(content:string)=>({tag:'plain_text',content});
const effectiveOwner="CASE WHEN t.owner_id='local-admin' THEN COALESCE(o.user_id,t.owner_id) ELSE t.owner_id END";

export function upgradeWorkflowNotices(db:DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS feishu_workflow_notices (
    notice_key TEXT PRIMARY KEY, task_id INTEGER NOT NULL, status TEXT NOT NULL, message_id TEXT UNIQUE
  )`);
}

export function taskWorkflow(db:DatabaseSync,owner:string,taskId:number) {
  const t=db.prepare(`SELECT t.id,t.status,t.kind,t.last_error,t.outcome_unknown,t.state_version,t.revision,t.control_version FROM tasks t
    JOIN projects p ON p.id=t.project_id LEFT JOIN governance_task_owners o ON o.task_id=t.id
    WHERE t.id=? AND ${effectiveOwner}=? AND p.enabled AND NOT p.archived`).get(taskId,owner);
  if(!t) return;
  const draft=db.prepare(`SELECT d.id,d.content,a.status,a.action_hash,json_extract(l.result,'$.write_status') delivery
    FROM reply_drafts d JOIN approvals a ON a.id=d.approval_id LEFT JOIN delivery_records l ON l.action_id='reply-'||a.id
    WHERE d.task_id=? AND ((a.revision=? AND a.control_version=?) OR json_extract(l.result,'$.write_status')='unknown')
    ORDER BY (json_extract(l.result,'$.write_status') IS 'unknown') DESC,d.id DESC LIMIT 1`).get(t.id,t.revision,t.control_version);
  const failedMedia=db.prepare(`SELECT 1 FROM event_attachment_jobs WHERE task_id=? AND status='failed' AND event_id>
    COALESCE((SELECT MAX(id) FROM events WHERE task_id=? AND event_type='project_rebound'),0)`).get(t.id,t.id);
  const summary=()=>String(db.prepare("SELECT content FROM artifacts WHERE task_id=? AND revision=? AND kind='summary' ORDER BY id DESC LIMIT 1")
    .get(t.id,t.revision)?.content??'');
  let reason:string, actions:WorkflowAction[];
  let kind=String(t.status);
  if(draft?.delivery==='unknown') {
    kind='delivery_unknown';reason='渠道尚未确认发送结果。请在原会话核对并填写凭据。';actions=['delivery_succeeded','delivery_failed'];
  } else if(t.outcome_unknown) {
    kind='execution_unknown';reason='执行退出结果待核验。确认已经停止后填写依据。';actions=['execution_stopped'];
  } else if(t.status==='waiting_input' && failedMedia) {
    kind='attachments';reason='来源附件获取或校验失败。可以重试本事件的全部失败附件。';actions=['retry_attachments','cancel'];
  } else if(t.status==='waiting_input') {
    reason=String(t.last_error??'需要补充信息或确认后继续。');actions=['supplement','resume','cancel'];
  } else if(t.status==='failed' || t.status==='paused') {
    reason=String(t.last_error??(t.status==='failed'?'任务执行失败。':'任务已暂停。'));
    actions=[t.status==='failed'?'retry':'resume','cancel'];
  } else if(t.status==='waiting_resource' && t.last_error!=='正在准备来源附件' && t.last_error!=='正在停止执行') {
    reason=String(t.last_error??'等待执行资源。');actions=['resume','cancel'];
  } else if(t.status==='review_ready') {
    if(draft?.delivery==='claimed'||draft?.delivery==='dispatching') return;
    if(draft?.delivery==null && draft && ['pending','approved'].includes(String(draft.status))) {
      if(String(draft.content).length<=5000) {
        kind='draft';reason='请核对将发往原渠道的回复。批准后使用当前渠道权限和版本校验发送。\n\n'+String(draft.content);
        actions=draft.status==='pending'?['publish','reject','supplement']:['publish','supplement'];
      } else {
        kind='draft_long';reason='回复超出卡片可审核长度。可以补充要求生成简短回复。';actions=['supplement','rerun','cancel'];
      }
    } else if(t.kind==='reply') {
      const skip=db.prepare(`SELECT 1 FROM events WHERE task_id=? AND event_type='reply_decision'
        AND json_extract(data,'$.revision')=? AND json_extract(data,'$.control_version')=? AND json_extract(data,'$.decision')='skip'`)
        .get(t.id,t.revision,t.control_version);
      if(draft?.delivery==='succeeded'||skip) return;
      reason=draft?.delivery==='failed'?'原渠道未发送成功。可以重新生成当前回复。':'当前回复需要进一步处理。';
      actions=['supplement','rerun','cancel'];
    } else {
      reason='执行结果待验收。\n\n'+summary().slice(0,4000);actions=['accept','supplement','cancel'];
    }
  } else return;
  return {key:[taskId,t.state_version,kind,draft?.id??0,draft?.status??'',draft?.delivery??''].join(':'),
    taskId,version:Number(t.state_version),revision:Number(t.revision),reason:reason.slice(0,6300),actions,
    draft:draft?{id:Number(draft.id),hash:String(draft.action_hash),status:String(draft.status)}:undefined};
}
export type TaskWorkflow=NonNullable<ReturnType<typeof taskWorkflow>>;

export function nextTaskWorkflow(db:DatabaseSync,owner:string) {
  const tasks=db.prepare(`SELECT t.id FROM tasks t LEFT JOIN governance_task_owners o ON o.task_id=t.id
    WHERE ${effectiveOwner}=? AND (t.status IN ('waiting_input','waiting_resource','failed','paused','review_ready')
      OR t.outcome_unknown OR EXISTS (SELECT 1 FROM reply_drafts d JOIN delivery_records l ON l.action_id='reply-'||d.approval_id
        WHERE d.task_id=t.id AND json_extract(l.result,'$.write_status')='unknown')) ORDER BY t.id`).all(owner);
  const sent=db.prepare('SELECT 1 FROM feishu_workflow_notices WHERE notice_key=?');
  for(const task of tasks) {
    const workflow=taskWorkflow(db,owner,Number(task.id));
    if(workflow && !sent.get(workflow.key)) return workflow;
  }
}

export function workflowCard(workflow:TaskWorkflow,result?:string,retry=false) {
  const elements:unknown[]=[{tag:'div',text:text(result??workflow.reason)}];
  const button=(action:WorkflowAction,form:boolean)=>({tag:'button',type:action==='cancel'?'danger':'default',
    text:text(workflowLabels[action]),...(form?{name:action,action_type:'form_submit'}:{}),
    confirm:{title:text('确认'+workflowLabels[action]+'？'),text:text('此操作将提交给任务 #'+workflow.taskId+'。')},
    behaviors:[{type:'callback',value:{notice:workflow.key,action}}]});
  const actions=result&&!retry?[]:workflow.actions;
  const noteActions=actions.filter(action=>needsNote.has(action));
  if(noteActions.length) elements.push({tag:'form',name:'human_input',elements:[
    {tag:'input',name:'note',placeholder:text('填写补充说明或核验依据'),required:true,max_length:1000},
    ...noteActions.map(action=>button(action,true)),
  ]});
  elements.push(...actions.filter(action=>!needsNote.has(action)).map(action=>button(action,false)));
  return {schema:'2.0',config:{update_multi:true},header:{title:text('SuperAgent · 任务 #'+workflow.taskId+(result?' · 处理结果':' · 待处理'))},body:{elements}};
}

export function workflowReceiver(db:DatabaseSync,c:CardConfig,act:(task:TaskWorkflow,action:WorkflowAction,note:string)=>Promise<string>,
  update?:(id:string,card:ReturnType<typeof workflowCard>)=>Promise<void>) {
  const active=new Set<string>();
  const toast=(type:'error'|'info'|'success',content:string)=>({toast:{type,content}});
  return async(messageId:string,value:{notice:string;action:string},note:string) => {
    if(!Object.hasOwn(workflowLabels,value.action)) return toast('error','卡片操作无效');
    const action=value.action as WorkflowAction;
    const row=db.prepare("SELECT task_id FROM feishu_workflow_notices WHERE notice_key=? AND message_id=? AND status='sent'")
      .get(value.notice,messageId);
    if(!row) return toast('error','卡片记录不存在');
    const workflow=taskWorkflow(db,c.owner,Number(row.task_id));
    if(!workflow || workflow.key!==value.notice || !workflow.actions.includes(action)) return toast('info','任务已更新，请使用最新卡片');
    if(needsNote.has(action) && !note.trim()) return toast('error','请填写说明或核验依据');
    if(active.has(workflow.key)||active.size>=16) return toast('info','操作正在提交，请稍候');
    active.add(workflow.key);
    const done=act(workflow,action,note.trim()).then(content=>toast('success',content),
      ()=>toast('error','操作未确认，请查看最新任务状态')).finally(()=>active.delete(workflow.key));
    if(!update) return done;
    let timer:ReturnType<typeof setTimeout>|number|undefined;
    try {
      const response=await Promise.race([done,new Promise<undefined>(resolve=>{timer=setTimeout(resolve,1500);})]);
      void done.then(result=>{
        if(result.toast.type==='success' || !response) return update(messageId,workflowCard(workflow,result.toast.content,result.toast.type==='error'));
      }).catch(()=>{});
      return response??toast('info','操作正在处理，结果将更新到此卡片');
    } finally {clearTimeout(timer);}
  };
}
