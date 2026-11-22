import type { DatabaseSync } from 'node:sqlite';
import { isAbsolute, relative, sep } from 'node:path';
import { ChannelError, limitedJson } from './common.ts';
import { actionHash } from '../storage/index.ts';
import type { CardConfig } from './feishu.ts';
import { nextTaskWorkflow,taskWorkflow,workflowCard } from './feishu-workflow.ts';
const text=(content:string)=>({tag:'plain_text',content});
function approvalCard(task:number,id:number,description:string) {
  const elements:unknown[]=[{tag:'div',text:text(description)}];
  for(const [decision,label] of [['approve','批准'],['reject','拒绝']]) elements.push({tag:'button',type:decision==='approve'?'primary':'default',
    text:text(label),confirm:{title:text('确认'+label+'？'),text:text('此决定将提交给任务 #'+task+'。')},
    behaviors:[{type:'callback',value:{approval_id:id,decision}}]});
  return {schema:'2.0',config:{update_multi:true},header:{title:text('SuperAgent · 任务 #'+task+' · 审批 #'+id)},body:{elements}};
}
async function post(url:string,body:object,signal:AbortSignal,token?:string,method='POST') {
  const response=await fetch(url,{method,redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(8000)]),
    headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});
  try {const data=await limitedJson(response,65536);if(!response.ok) throw new ChannelError('feishu_http_error');return data;}
  finally {await response.body?.cancel().catch(()=>{});}
}
export async function updateWorkflowCard(c:CardConfig,secret:string,messageId:string,body:unknown,signal:AbortSignal) {
  const token=await accessToken(c,secret,signal);
  const result=await post('https://open.feishu.cn/open-apis/im/v1/messages/'+encodeURIComponent(messageId),
    {content:JSON.stringify(body)},signal,token,'PATCH');
  if(result.code!==0) throw new ChannelError('feishu_update_failed');
}
async function accessToken(c:CardConfig,secret:string,signal:AbortSignal):Promise<string> {
  const response=await post('https://accounts.feishu.cn/oauth/v3/token',{grant_type:'client_credentials',client_id:c.appId,client_secret:secret,
    scope:'im:message:send_as_bot'},signal);
  if(typeof response.access_token!=='string'||!response.access_token) throw new ChannelError('feishu_token_unavailable');
  return response.access_token;
}
async function sendCard(c:CardConfig,body:unknown,signal:AbortSignal,token:string) {
  let status='unknown',messageId:string|null=null;
  try {
    const result=await post('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id',{receive_id:c.recipient,msg_type:'interactive',
      content:JSON.stringify(body)},signal,token);
    if(result.code===0 && typeof result.data?.message_id==='string' && /^om_[\w-]{1,150}$/.test(result.data.message_id)){status='sent';messageId=result.data.message_id;}
    else if(Number.isInteger(result.code)&&result.code!==0) status='failed';
  }catch{/* The provider may already have accepted the card. */}
  return {status,messageId};
}
export function upgradeNoticeTable(db:DatabaseSync) {
  if(!db.prepare('PRAGMA table_info(feishu_decision_notices)').all().some(c=>c.name==='message_id'))
    db.exec('ALTER TABLE feishu_decision_notices ADD COLUMN message_id VARCHAR(160)');
}
const pending=`SELECT a.id,a.action,a.action_hash,t.id task,t.workspace_path FROM approvals a JOIN tasks t ON t.id=a.task_id JOIN projects p ON p.id=t.project_id
  JOIN execution_attempts x ON x.id=json_extract(a.action,'$.attempt_id') AND x.task_id=t.id LEFT JOIN governance_task_owners o ON o.task_id=t.id
  WHERE a.status='pending' AND a.revision=t.revision AND a.control_version=t.control_version AND t.kind='repair' AND t.status='waiting_approval'
  AND NOT t.outcome_unknown AND p.enabled AND NOT p.archived AND x.owner=? AND x.phase='approval' AND x.status='waiting_approval'
  AND x.revision=t.revision AND x.control_version=t.control_version AND x.thread_id=t.codex_thread_id AND x.turn_id=t.codex_turn_id
  AND (CASE WHEN t.owner_id='local-admin' THEN COALESCE(o.user_id,t.owner_id) ELSE t.owner_id END)=?
  AND json_extract(a.action,'$.method') IN ('item/commandExecution/requestApproval','item/fileChange/requestApproval')
  AND NOT EXISTS(SELECT 1 FROM feishu_decision_notices n WHERE n.approval_id=a.id)`;
export async function notifyCard(db:DatabaseSync,owner:string,c:CardConfig,secret:string,signal:AbortSignal,guard:()=>void) {
  guard();
  const select=db.prepare(pending+' ORDER BY a.id LIMIT 1'),candidate=select.get(owner,c.owner);
  if(!candidate) return;
  const token=await accessToken(c,secret,signal);
  guard();
  const row=db.prepare(pending+' AND a.id=?').get(owner,c.owner,candidate.id);
  if(!row) return;
  const a=JSON.parse(String(row.action));let scope='运行命令，权限范围为隔离工作区。';
  if(actionHash(a)!==row.action_hash) return;
  if(a.method==='item/fileChange/requestApproval'){
    const grant=a.params?.grantRoot,base=row.workspace_path;
    if(typeof grant!=='string'||typeof base!=='string'||!isAbsolute(grant)||!isAbsolute(base)) return;
    const child=relative(base,grant);
    if(isAbsolute(child)||child==='..'||child.startsWith('..'+sep)) return;
    scope='修改文件，权限范围为 '+(child||'.').slice(0,240)+'。';
  }
  if(!db.prepare("INSERT OR IGNORE INTO feishu_decision_notices(approval_id,status,message_id) VALUES(?,'sending',NULL)").run(row.id).changes) return;
  const {status,messageId}=await sendCard(c,approvalCard(Number(row.task),Number(row.id),scope+'请核对范围后决定。'),signal,token);
  guard();
  db.prepare("UPDATE feishu_decision_notices SET status=?,message_id=? WHERE approval_id=? AND status='sending'").run(status,messageId,row.id);
}

export async function notifyWorkflow(db:DatabaseSync,c:CardConfig,secret:string,signal:AbortSignal,guard:()=>void) {
  guard();
  const candidate=nextTaskWorkflow(db,c.owner);
  if(!candidate) return;
  const token=await accessToken(c,secret,signal);
  guard();
  const current=taskWorkflow(db,c.owner,candidate.taskId);
  if(current?.key!==candidate.key) return;
  if(!db.prepare("INSERT OR IGNORE INTO feishu_workflow_notices(notice_key,task_id,status) VALUES(?,?,'sending')")
    .run(current.key,current.taskId).changes) return;
  const {status,messageId}=await sendCard(c,workflowCard(current),signal,token);
  guard();
  db.prepare("UPDATE feishu_workflow_notices SET status=?,message_id=? WHERE notice_key=? AND status='sending'").run(status,messageId,current.key);
}

export function upgradeTriageNotices(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS feishu_triage_notices (
    event_id INTEGER PRIMARY KEY, status TEXT NOT NULL, message_id TEXT
  )`);
}

export async function notifyTriage(db: DatabaseSync, c: CardConfig, secret: string, signal: AbortSignal,
  guard: () => void, candidate: (id?: number) => number | undefined, origin: string) {
  guard();
  const id = candidate();
  if (id === undefined) return;
  db.prepare("INSERT OR IGNORE INTO feishu_triage_notices(event_id,status) VALUES(?,'retrying')").run(id);
  const token = await accessToken(c, secret, signal);
  guard();
  if (candidate(id) !== id || !db.prepare("UPDATE feishu_triage_notices SET status='sending' WHERE event_id=? AND status='retrying'").run(id).changes) return;

  const link = new URL('/', origin);
  link.searchParams.set('event', String(id));
  const body = { schema: '2.0', header: { title: text(`SuperAgent · 事件 #${id} · 待研判`) }, body: { elements: [
    { tag: 'div', text: text('自动分派暂停。请在运行 SuperAgent 的电脑打开工作台，核对原因并选择分派、关联或关闭。') },
    { tag: 'button', type: 'primary', text: text('查看待研判事件'), behaviors: [{ type: 'open_url', default_url: link.href }] },
  ] } };
  const { status, messageId } = await sendCard(c, body, signal, token);
  guard();
  db.prepare("UPDATE feishu_triage_notices SET status=?,message_id=? WHERE event_id=? AND status='sending'").run(status, messageId, id);
}
