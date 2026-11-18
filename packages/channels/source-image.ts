import type { DatabaseSync } from 'node:sqlite';
import type { DingTalkImageBinding } from '../../apps/server/src/workbench/runtime.ts';
import { invalid } from './resources.ts';

/** Resolve media exclusively from the stored inbound receipt. Caller-supplied paths and URLs are never used. */
export function sourceImageReceipt(db:DatabaseSync,b:DingTalkImageBinding) {
  if(!Number.isSafeInteger(b.eventId) || b.eventId<1) invalid('dws_source_event_mismatch');
  const row=db.prepare(`SELECT content,data,external_id FROM events
    WHERE id=? AND source='dingtalk' AND event_type='message.received' AND external_id IS NOT NULL AND task_id IS NULL
    AND NOT EXISTS(SELECT 1 FROM event_targets WHERE event_id=events.id)`).get(b.eventId);
  if(!row?.external_id) invalid('dws_source_event_mismatch');
  const data=JSON.parse(String(row.data)),meta=data?.metadata;
  const at=Date.parse(data?.occurred_at),since=Date.parse(b.since),until=Date.parse(b.until);
  if(![at,since,until].every(Number.isFinite) || at<since || at>=until) invalid('dws_source_event_time_mismatch');
  if(!meta || meta.profile!==b.profile || meta.message_id!==b.anchorId || data.thread_id!==b.conversation
    || data.actor_id!==b.peer || meta.dws_event_type!=='user_im_message_receive_o2o_all'
    || (meta.conversation_type!=null && meta.conversation_type!=='direct') || meta.self_authored || meta.needs_confirmation
    || (Array.isArray(meta.uncertain_mentions)?meta.uncertain_mentions.length:meta.uncertain_mentions)
    || ['dismissed','manually_linked','routed','self_echo'].includes(data.routing_status)
    || (meta.source_account_ids!=null && (!Array.isArray(meta.source_account_ids)
      || JSON.stringify([...new Set(meta.source_account_ids)].sort())!==JSON.stringify([...new Set(b.selfIds)].sort()))))
    invalid('dws_source_event_mismatch');
  const hints=Array.isArray(data.attachments)?data.attachments:[];
  const marker=/\[图片消息\]\s*\(mediaId=[^\s)]+\)/u;
  if(!hints.length && !marker.test(String(row.content))) invalid('dws_source_image_missing');
  // The text marker only signals media presence. DWS resolves the original message's resource ledger.
  const resourceIds=new Set<string>();
  for(const hint of hints) {
    if(!hint || typeof hint!=='object') continue;
    for(const key of ['mediaId','media_id','fileId','file_id','resourceId','resource_id']){
      if(typeof hint[key]==='string' && hint[key]) resourceIds.add(hint[key]);
    }
  }
  return {snapshot:JSON.stringify([row.external_id,row.content,row.data]),resourceIds};
}
