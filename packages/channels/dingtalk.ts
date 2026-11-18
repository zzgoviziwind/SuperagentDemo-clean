import { spawnOwned } from '@superagent/windows-job';
import { statSync } from 'node:fs';
import { readFile, mkdtemp } from 'node:fs/promises';
import { accept, directory, discard, fileMime, filename, inventory, invalid, MiB } from './resources.ts';
import { basename, delimiter, extname, isAbsolute, join } from 'node:path';
import { once } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import type { Readable } from 'node:stream';
import { ChannelError, CursorStore, utc } from './common.ts';
import type { Incoming, Emit } from './common.ts';
import type { Fields, Json } from '../storage/index.ts';
import type { DingTalkHistoryBinding, DingTalkHistoryPage } from '../../apps/server/src/workbench/runtime.ts';

export interface DwsConfig {
  executable:string|string[];profile:string;self_ids:string[];cwd?:string;kind?:'group'|'at-me'|'all-direct';chat_id?:string;
  history?:{chat_ids:string[];initial_since:string;history_timezone:string;page_limit?:number;timeout?:number;sender_map?:Record<string,string>};
}
export interface Scope {kind:'group'|'at-me'|'all-direct'|'all-group';chatId?:string}
const types={'at-me':'user_im_message_receive_at',group:'user_im_message_receive_group','all-direct':'user_im_message_receive_o2o_all','all-group':'user_im_message_receive_group_all'};
const maxBytes=1024*1024;
async function* lines(stream:Readable) {
  const decoder=new StringDecoder('utf8');
  let tail='';
  for await(const chunk of stream) {
    tail+=decoder.write(chunk);
    let at:number;
    while((at=tail.indexOf('\n'))>=0) {
      const line=tail.slice(0,at).replace(/\r$/,'');
      if(Buffer.byteLength(line)>maxBytes) throw new ChannelError('dws_frame_too_large');
      tail=tail.slice(at+1);yield line;
    }
    if(Buffer.byteLength(tail)>maxBytes) throw new ChannelError('dws_frame_too_large');
  }
  tail+=decoder.end();if(tail) yield tail;
}
export function normalizeDws(raw:Record<string,any>,config:DwsConfig,scope:Scope):Incoming {
  const type=raw.type,conversation=raw.conversation_id,message=raw.message_id,actor=raw.sender_open_dingtalk_id;
  const group=scope.kind==='group'||scope.kind==='all-group';
  if((type!==types[scope.kind] && !(group && [types.group,types['all-group']].includes(type)))
      || (scope.chatId && conversation!==scope.chatId) || (raw.profile!==undefined && raw.profile!==config.profile)
      || ![conversation,message,actor].every(v=>typeof v==='string' && v.trim())) throw new ChannelError('dws_identity_or_scope_mismatch');
  const meta:Fields={profile:config.profile,source_account_ids:[...new Set(config.self_ids)].sort(),message_id:message,sender_name:raw.sender??null,self_authored:config.self_ids.includes(actor),
    at_me:type===types['at-me'],dws_event_type:type,conversation_type:scope.kind==='all-direct'?'direct':group?'group':'unknown',
    event_id:raw.event_id??null,project_id:null,quoted_message:raw.quoted_message??null,forward_messages:raw.forward_messages??[]};
  const q=raw.quoted_message;
  if(q!=null) {
    if(typeof q.message_id==='string' && q.message_id.trim()===q.message_id && q.message_id && q.message_id!==message && q.conversation_id===conversation) meta.reply_to_message_id=q.message_id;
    else meta.needs_confirmation=true;
  }
  const content=String(raw.content??'');
  const attachments:Json[]=raw.attachments?.length?raw.attachments:/\[图片消息\]\s*\(mediaId=[^\s)]+\)/.test(content)?[{kind:'image',source:'dingtalk_message'}]:[];
  return {source:'dingtalk',external_id:[config.profile,conversation,message].join(':'),event_type:'message.received',actor_id:actor,
    thread_id:conversation,project_external_id:conversation,content,occurred_at:utc(raw.event_time??raw.timestamp??raw.create_time),attachments,metadata:meta};
}
async function executable(c:DwsConfig,args:string[],env:NodeJS.ProcessEnv) {
  if(!c.profile || !c.self_ids?.length) throw new ChannelError('dws_account_unconfigured');
  const command=Array.isArray(c.executable)?c.executable:[c.executable];
  if(!command[0]) throw new ChannelError('dws_executable_unavailable');
  const childEnv:NodeJS.ProcessEnv={};
  for(const k of ['PATH','SystemRoot','WINDIR','HOME','APPDATA','LOCALAPPDATA','USERPROFILE','TEMP','TMP','LANG']) if(env[k]) childEnv[k]=env[k];
  let binary=command[0];
  if(!isAbsolute(binary)) {
    if(basename(binary)!==binary) throw new ChannelError('dws_executable_unavailable');
    const file=process.platform==='win32' && !extname(binary)?binary+'.exe':binary;
    binary=(env.PATH??'').split(delimiter).filter(isAbsolute).map(dir=>join(dir,file))
      .find(path=>statSync(path,{throwIfNoEntry:false})?.isFile())??'';
  }
  if(!binary || (process.platform==='win32' && extname(binary).toLowerCase()!=='.exe')) throw new ChannelError('dws_executable_unavailable');
  const owned=await spawnOwned(binary,[...command.slice(1),'--profile',c.profile,...args],{cwd:c.cwd??process.cwd(),env:childEnv});
  owned.child.stdin.on('error',()=>{});
  return owned;
}
async function runJson(c:DwsConfig,args:string[],env:NodeJS.ProcessEnv,signal:AbortSignal,write=false) {
  signal.throwIfAborted();
  const {child:p,terminate:kill}=await executable(c,args,env), end=once(p,'close');
  signal.addEventListener('abort',kill,{once:true});
  if(signal.aborted) kill();
  p.stderr.resume();p.stdin.end();
  let buf='',bytes=0;
  const read=async()=>{
    for await(const line of lines(p.stdout)) {bytes+=Buffer.byteLength(line);if(bytes>maxBytes) throw new ChannelError('dws_output_too_large');buf+=line+'\n';}
  };
  try {
    const [[code]]=await Promise.all([end,read()]);
    if(code!==0) throw new Error();
    const response=JSON.parse(buf);
    if(response.error || ['failure','partial_failure'].includes(response.outcome)) throw new Error();
    return response.data??response.result??response;
  }catch {throw new ChannelError(write?'dws_write_outcome_unknown':'dws_read_failed',write);}
  finally {signal.removeEventListener('abort',kill);if(p.exitCode===null && !p.signalCode) kill();await end.catch(()=>{});}
}
export async function downloadDws(c:DwsConfig,conversation:string,message:string,dir:string,env:NodeJS.ProcessEnv,signal:AbortSignal) {
  if(!conversation || !message || message.includes(',')) invalid('dws_media_scope_missing');
  await verifyDws(c,env,signal);
  const scratch=await mkdtemp(join(await directory(dir),'.dws-'));
  const stop=new AbortController(),active=AbortSignal.any([signal,stop.signal]);
  let probing:Promise<void>|undefined;
  const monitor=setInterval(()=>{
    probing??=inventory(scratch).then(()=>{},()=>stop.abort()).finally(()=>{probing=undefined;});
  },50);
  try {
    const page=await runJson({...c,cwd:scratch},['chat','+messages-mget','--msg-ids',message,'--no-reactions','--no-threads',
      '--download-resources','--output-dir','downloads','--format','json'],env,active);
    clearInterval(monitor);await probing;active.throwIfAborted();requireHistory(page,conversation);
    const ledger=page.resourceDownloads,items=ledger?.downloads;
    if(page.messages.length!==1 || page.messages[0].conversationId!==conversation || page.messages[0].messageId!==message ||
      ledger?.ok!==true || ledger.partial!==false || ledger.failedCount!==0 || ledger.failures?.length || !Array.isArray(items) ||
      !items.length || items.length>10 || ledger.requestedCount!==items.length || ledger.downloadedCount!==items.length) invalid('dws_media_incomplete');
    const files=await inventory(scratch),results=[];
    for(const item of items) {
      const path=item.localPath;
      if(typeof path!=='string'||!path.startsWith('downloads/') || !files.has(path) || files.get(path)!==item.sizeBytes ||
        !item.resourceId || !['fileId','mediaId'].includes(item.resourceType)||item.messageId!==message) invalid('dws_media_unverified');
      files.delete(path);active.throwIfAborted();
      const name=filename(basename(path));
      results.push(await accept(dir,name,await readFile(join(scratch,path)),fileMime(name),10*MiB));
    }
    if(files.size) invalid('dws_media_unlisted_files');
    return results;
  }finally{clearInterval(monitor);await probing;await discard(dir,scratch);}
}
export async function verifyDws(c:DwsConfig,env:NodeJS.ProcessEnv,signal:AbortSignal) {
  const status=await runJson(c,['auth','status','--readonly','--format','json'],env,AbortSignal.any([signal,AbortSignal.timeout(5000)]));
  const identity=status.identity??status.user??status;
  const ids=[identity.openDingTalkId,identity.open_dingtalk_id,identity.userId,identity.user_id];
  if(status.authenticated===false || status.loggedIn===false || !ids.some(v=>typeof v==='string' && c.self_ids.includes(v)))
    throw new ChannelError('dws_account_mismatch');
}
export async function replyDws(c:DwsConfig,target:Fields,content:string,actionId:string,env:NodeJS.ProcessEnv,signal:AbortSignal) {
  if(target.profile!==c.profile || !target.conversation_id || !target.message_id || !content.trim()) throw new ChannelError('dws_target_mismatch');
  const args=['chat','+messages-reply','--group',String(target.conversation_id),'--message-id',String(target.message_id),
    '--content',content,'--idempotency-key',actionId,'--format','json','--yes'];
  if(target.recipient_id!==undefined) {
    if(typeof target.recipient_id!=='string'||!target.recipient_id.trim()) throw new ChannelError('dws_recipient_missing');
    args.push('--open-dingtalk-id',target.recipient_id);
  }
  const reply=await runJson(c,args,env,AbortSignal.any([signal,AbortSignal.timeout(8000)]),true);
  if(!['sent','delivered','succeeded','success'].includes(reply.deliveryStatus)) throw new ChannelError('dws_write_outcome_unknown',true);
  return {write_status:'succeeded',verification:reply.deliveryStatus,message_id:reply.messageId??null};
}

function historyTime(value:unknown,zone:string) {
  if(typeof value==='number') return utc(value);
  if(typeof value!=='string') throw new ChannelError('dws_history_time_invalid');
  if(/(Z|[+-]\d\d:\d\d)$/i.test(value)) return utc(value);
  const naive=value.replace(' ','T');
  if(zone==='UTC' || /^[+-]\d\d:\d\d$/.test(zone)) return utc(naive+(zone==='UTC'?'Z':zone));
  // Resolve the DWS local wall time; require a unique UTC mapping even at DST transitions.
  const fmt=new Intl.DateTimeFormat('sv-SE',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  const nominal=Date.parse(naive+'Z'),expected=naive.slice(0,19);
  const offsets=new Set([-86400000,0,86400000].map(delta=>{const v=nominal+delta;return Date.parse(fmt.format(v).replace(' ','T')+'Z')-Math.floor(v/1000)*1000;}));
  const candidates=[...offsets].map(o=>nominal-o).filter(v=>fmt.format(v).replace(' ','T')===expected);
  if(candidates.length!==1) throw new ChannelError('dws_history_timezone_ambiguous');
  return utc(candidates[0]);
}
function requireHistory(page:any,chat:string) {
  if(page.complete!==true || page.hasMore!==false || page.failures?.length || page.messagesComplete===false || page.enrichment?.complete===false
    || page.truncatedByPageLimit || page.truncatedByMaxItems || ['page_limit','max_items','item_limit','timeout','single_page','failed'].includes(page.stopReason)
    || !Array.isArray(page.messages) || (page.conversationId??chat)!==chat) throw new ChannelError('dws_history_incomplete');
}
export async function readOwnDingTalk(c:DwsConfig,b:DingTalkHistoryBinding,env:NodeJS.ProcessEnv,signal:AbortSignal):Promise<DingTalkHistoryPage> {
  const since=Date.parse(utc(b.since)),end=utc(b.until),window=Date.parse(end)-since;
  if(window<=0 || window>7*86400000 || !b.anchorId || !b.peer || !b.conversation || c.profile!==b.profile || c.self_ids.includes(b.peer)
    || b.selfIds.length!==c.self_ids.length || b.selfIds.some(id=>!c.self_ids.includes(id))) throw new ChannelError('dws_private_scope_mismatch');
  const start=utc(Math.floor(since/1000)*1000);
  await verifyDws(c,env,signal);
  const page=await runJson(c,['chat','+chat-messages','--open-dingtalk-id',b.peer,'--start',start,'--end',end,
    '--order','asc','--page-all','--page-limit','5','--no-reactions','--format','json'],env,signal);
  requireHistory(page,b.conversation);
  if(page.messages.length>1000) throw new ChannelError('dws_history_incomplete');
  const messages:DingTalkHistoryPage['messages'][number][]=[];
  for(const row of page.messages) {
    if((row.conversationId??b.conversation)!==b.conversation || !row.senderId) throw new ChannelError('dws_private_scope_mismatch');
    const sender=String(row.senderId),senderId=c.history?.sender_map?.[sender]??sender;
    if(!c.self_ids.includes(senderId) && !(senderId===b.peer && row.messageId===b.anchorId)) continue;
    if(typeof row.messageId!=='string'||!row.messageId.trim()) throw new ChannelError('dws_history_identity_missing');
    const time=row.createTime;
    if(typeof time==='string' && !/(Z|[+-]\d\d:\d\d)$/i.test(time) && !c.history?.history_timezone) throw new ChannelError('dws_history_time_invalid');
    const occurredAt=historyTime(time,c.history?.history_timezone??'UTC');
    if(occurredAt<start || occurredAt>=end) throw new ChannelError('dws_history_time_scope_mismatch');
    messages.push({messageId:row.messageId,senderId,occurredAt,conversationId:b.conversation,text:typeof row.text==='string'?row.text:'',senderName:row.senderName});
  }
  if(!messages.some(r=>r.senderId===b.peer && r.messageId===b.anchorId)) throw new ChannelError('dws_private_anchor_missing');
  return {complete:true,conversationId:b.conversation,messages};
}
async function replay(c:DwsConfig,scope:Scope,checkpoint:string,env:NodeJS.ProcessEnv,signal:AbortSignal) {
  const history=c.history!;
  const chats=scope.chatId ? history.chat_ids.filter(x=>x===scope.chatId):history.chat_ids;
  const start=utc(Math.floor(Date.parse(checkpoint)/1000)*1000),end=utc(Date.now());
  const result=new Map<string,Incoming>();
  for(const chat of chats) {
    const at=scope.kind==='at-me';
    const args=['chat',at?'+search-msg':'+chat-messages','--group',chat,'--start',start,'--end',end,
      '--order','asc','--page-all','--page-limit',String(history.page_limit??40),'--no-reactions','--format','json'];
    if(at) args.push('--at-me');
    const page=await runJson(c,args,env,AbortSignal.any([signal,AbortSignal.timeout((history.timeout??120)*1000)]));
    requireHistory(page,chat);
    for(const row of page.messages) {
      const time=historyTime(row.createTime,history.history_timezone);
      if(time<start || time>=end || (row.conversationId??chat)!==chat || !row.senderId) throw new ChannelError('dws_history_scope_mismatch');
      const event=normalizeDws({type:types[scope.kind],conversation_id:chat,message_id:row.messageId,create_time:time,
        sender_open_dingtalk_id:history.sender_map?.[String(row.senderId)]??String(row.senderId),content:row.text??''},c,scope);
      result.set(event.external_id,event);
    }
  }
  return [...result.values()].sort((a,b)=>a.occurred_at.localeCompare(b.occurred_at)||a.external_id.localeCompare(b.external_id));
}
export async function listenDws(c:DwsConfig,scope:Scope,state:CursorStore,emit:Emit,env:NodeJS.ProcessEnv,signal:AbortSignal,ready:()=>void) {
  signal.throwIfAborted();
  await verifyDws(c,env,signal);
  const key='dingtalk:'+c.profile+':'+scope.kind+':'+(scope.chatId??'');
  const args=['event','+listen-im','--kind',scope.kind,'--events','message','--format','ndjson'];
  if(scope.chatId) args.push('--chat-id',scope.chatId);
  const {child:p,terminate}=await executable(c,args,env),closed=once(p,'close');
  let killer:ReturnType<typeof setTimeout>|undefined;
  const stop=()=>{p.stdin.end();killer??=setTimeout(terminate,500);};
  signal.addEventListener('abort',stop,{once:true});
  if(signal.aborted) stop();
  let resolveReady!:()=>void,rejectReady!:(reason:unknown)=>void;
  const promise=new Promise<void>((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
  const gate={promise,resolve:resolveReady,reject:rejectReady};
  const timeout=setTimeout(()=>gate.reject(new ChannelError('dws_ready_timeout')),8000);
  const stderr=(async()=>{for await(const line of lines(p.stderr)) if(/^\[event\] ready(?: |$)/.test(line)) gate.resolve();})();
  const reader=(async()=>{
    await gate.promise; clearTimeout(timeout);
    const history=c.history && scope.kind!=='all-direct';
    async function accept(e:Incoming) {
      signal.throwIfAborted();await emit(e);signal.throwIfAborted();
      const before=state.get<string>(key);
      if(!before || before<e.occurred_at) state.set(key,e.occurred_at);
    }
    if(history) for(const e of await replay(c,scope,state.get<string>(key)??c.history!.initial_since,env,signal)) await accept(e);
    ready();
    for await(const line of lines(p.stdout)) { if(line.trim()) await accept(normalizeDws(JSON.parse(line),c,scope)); }
  })();
  try {
    await Promise.all([closed.then(()=>gate.reject(new ChannelError('dws_exited_before_ready'))),stderr,reader]);
    if(!signal.aborted) throw new ChannelError('dws_disconnected');
  } finally {
    clearTimeout(timeout);signal.removeEventListener('abort',stop);
    stop();await closed.catch(()=>{});clearTimeout(killer);
  }
}
