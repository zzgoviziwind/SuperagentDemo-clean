import type { DatabaseSync } from 'node:sqlite';
import { isAbsolute, relative, sep } from 'node:path';
import { ChannelError, limitedJson } from './common.ts';
import { actionHash } from '../storage/index.ts';
import type { CardConfig } from './feishu.ts';
const text=(content:string)=>({tag:'plain_text',content});
function approvalCard(task:number,id:number,description:string) {
  const elements:unknown[]=[{tag:'div',text:text(description)}];
  for(const [decision,label] of [['approve','批准'],['reject','拒绝']]) elements.push({tag:'button',type:decision==='approve'?'primary':'default',
    text:text(label),confirm:{title:text('确认'+label+'？'),text:text('此决定将提交给任务 #'+task+'。')},
    behaviors:[{type:'callback',value:{approval_id:id,decision}}]});
  return {schema:'2.0',config:{update_multi:true},header:{title:text('SuperAgent · 任务 #'+task+' · 审批 #'+id)},body:{elements}};
}
async function post(url:string,body:object,signal:AbortSignal,token?:string) {
  const response=await fetch(url,{method:'POST',redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(8000)]),
    headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});
  try {const data=await limitedJson(response,65536);if(!response.ok) throw new ChannelError('feishu_http_error');return data;}
  finally {await response.body?.cancel().catch(()=>{});}
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
  const response=await post('https://accounts.feishu.cn/oauth/v3/token',{grant_type:'client_credentials',client_id:c.appId,client_secret:secret,
    scope:'im:message:send_as_bot'},signal);
  if(typeof response.access_token!=='string'||!response.access_token) throw new ChannelError('feishu_token_unavailable');
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
  let status='unknown',messageId:string|null=null;
  try {
    const result=await post('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id',{receive_id:c.recipient,msg_type:'interactive',
      content:JSON.stringify(approvalCard(Number(row.task),Number(row.id),scope+'请核对范围后决定。'))},signal,response.access_token);
    if(result.code===0 && typeof result.data?.message_id==='string' && /^om_[\w-]{1,150}$/.test(result.data.message_id)){status='sent';messageId=result.data.message_id;}
    else if(Number.isInteger(result.code)&&result.code!==0) status='failed';
  }catch{/* The provider may already have accepted the card. */}
  guard();
  db.prepare("UPDATE feishu_decision_notices SET status=?,message_id=? WHERE approval_id=? AND status='sending'").run(status,messageId,row.id);
}
