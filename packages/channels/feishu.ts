import { createDecipheriv, createHash, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { ChannelError } from './common.ts';

export interface CardConfig {appId:string;recipient:string;owner:string;encryptKey:string;verificationToken:string;transport?:'ws'|'http'}
export function cardConfig(env:NodeJS.ProcessEnv):CardConfig|null {
  if(env.SUPERAGENT_SERVICE_MODE==='preview'||env.SUPERAGENT_FEISHU_ENABLED!=='1'||env.SUPERAGENT_FEISHU_MODE!=='card') return null;
  const {SUPERAGENT_FEISHU_APP_ID:appId,SUPERAGENT_FEISHU_OPEN_ID:recipient,SUPERAGENT_FEISHU_OWNER_ID:owner,
    SUPERAGENT_FEISHU_ENCRYPT_KEY:encryptKey,SUPERAGENT_FEISHU_VERIFICATION_TOKEN:verificationToken}=env;
  const transport=env.SUPERAGENT_FEISHU_TRANSPORT==='ws'?'ws':'http';
  return appId&&recipient&&/^ou_[\w-]+$/.test(recipient)&&owner&&(transport==='ws'||encryptKey&&verificationToken)
    ? {appId,recipient,owner,encryptKey:encryptKey??'',verificationToken:verificationToken??'',transport}:null;
}
const operator=z.object({open_id:z.string()});
const cardContext=z.object({open_message_id:z.string().regex(/^om_[\w-]{1,150}$/)});
const actionValue=z.union([
  z.strictObject({approval_id:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),decision:z.enum(['approve','reject'])}),
  z.strictObject({notice:z.string().min(1).max(160),action:z.string().min(1).max(40)}),
]);
const cardEvent=z.object({operator,context:cardContext,action:z.object({
  value:actionValue,form_value:z.object({note:z.string().max(1000).optional()}).optional(),
})});
const validCard=z.object({schema:z.literal('2.0'),header:z.object({event_type:z.literal('card.action.trigger'),app_id:z.string(),token:z.string()}),
  event:cardEvent});
function equal(a:string,b:string){const l=Buffer.from(a),r=Buffer.from(b);return l.length===r.length && timingSafeEqual(l,r);}
export function decodeCard(config:CardConfig,raw:Buffer,timestamp:string,nonce:string,signature:string,now=Date.now()):unknown {
  if(raw.length>128*1024 || !/^\d{10}$/.test(timestamp) || Math.abs(now/1000-Number(timestamp))>300 || !nonce || nonce.length>256 || !/^[a-f0-9]{64}$/.test(signature))
    throw new ChannelError('feishu_signature_invalid');
  const expected=createHash('sha256').update(timestamp+nonce+config.encryptKey).update(raw).digest('hex');
  if(!equal(signature,expected)) throw new ChannelError('feishu_signature_invalid');
  try {
    const envelope=JSON.parse(raw.toString('utf8'));
    if(typeof envelope.encrypt!=='string') throw new Error();
    const ciphertext=Buffer.from(envelope.encrypt,'base64');
    const decipher=createDecipheriv('aes-256-cbc',createHash('sha256').update(config.encryptKey).digest(),ciphertext.subarray(0,16));
    return JSON.parse(Buffer.concat([decipher.update(ciphertext.subarray(16)),decipher.final()]).toString('utf8'));
  } catch { throw new ChannelError('feishu_payload_invalid'); }
}
export function cardReceiver(db:DatabaseSync,config:CardConfig,decide:(owner:string,aid:number,decision:'approve'|'reject',hash:string)=>Promise<string>,
  workflow?:(messageId:string,value:{notice:string;action:string},note:string)=>Promise<unknown>) {
  const pending=new Set<number>();
  const toast=(type:'error'|'info'|'success',content:string)=>({toast:{type,content}});
  async function dispatch(event:z.infer<typeof cardEvent>) {
    if(event.operator.open_id!==config.recipient)
      throw new ChannelError('feishu_identity_mismatch');
    const value=event.action.value;
    if('notice' in value) return workflow?.(event.context.open_message_id,value,event.action.form_value?.note??'')
      ??toast('error','当前服务不支持此卡片');
    const {approval_id:aid,decision}=value;
    const row=db.prepare(`SELECT a.status,a.action_hash,a.revision,a.control_version,t.revision AS current_revision,t.control_version AS current_control,
      t.outcome_unknown,t.status AS task_status,json_extract(a.action,'$.method') AS method,
      CASE WHEN t.owner_id='local-admin' THEN COALESCE(o.user_id,t.owner_id) ELSE t.owner_id END AS owner
      FROM feishu_decision_notices n JOIN approvals a ON a.id=n.approval_id JOIN tasks t ON t.id=a.task_id
      LEFT JOIN governance_task_owners o ON o.task_id=t.id WHERE n.approval_id=? AND n.status='sent' AND n.message_id=?`).get(aid,event.context.open_message_id);
    if(!row || row.owner!==config.owner || !['item/commandExecution/requestApproval','item/fileChange/requestApproval'].includes(String(row.method)))
      return toast('error','卡片或任务归属不匹配');
    if(row.status==='approved'||row.status==='rejected') return toast('info','该审批已有决定');
    if(row.status==='dispatching'||pending.has(aid)) return toast('info','该审批正在提交');
    if(row.status!=='pending'||row.outcome_unknown||row.task_status!=='waiting_approval'||row.revision!==row.current_revision
      || row.control_version!==row.current_control || pending.size>=16) return toast('error','审批已失效或当前不可提交');
    pending.add(aid);
    try {
      const status=await decide(config.owner,aid,decision,String(row.action_hash));
      return status==='approved'||status==='rejected' ? toast('success','审批决定已确认'):toast('info','请核对当前审批状态');
    } catch {return toast('error','审批提交未确认，请核对工作台');}
    finally {pending.delete(aid);}
  }
  return Object.assign(async (payload:unknown)=>{
    const challenge=z.object({type:z.literal('url_verification'),challenge:z.string().min(1).max(512),token:z.string()}).safeParse(payload);
    if(challenge.success && equal(challenge.data.token,config.verificationToken)) return {challenge:challenge.data.challenge};
    const parsed=validCard.safeParse(payload);
    if(!parsed.success) throw new ChannelError('feishu_payload_invalid');
    const {header,event}=parsed.data;
    if(header.app_id!==config.appId||!equal(header.token,config.verificationToken)) throw new ChannelError('feishu_identity_mismatch');
    return dispatch(event);
  },{fromConnection:async (payload:unknown)=>{
    const parsed=cardEvent.extend({app_id:z.literal(config.appId)}).safeParse(payload);
    if(!parsed.success) throw new ChannelError('feishu_payload_invalid');
    return dispatch(parsed.data);
  }});
}
