import type { Event, Fields, WorkbenchStore } from './store.ts';
import type { DatabaseSync } from 'node:sqlite';
import { fail, fields, now } from './store.ts';
import type { DingTalkHistoryBinding, WorkbenchRuntime } from './runtime.ts';

function zonedTime(value: string): number {
  return /(?:Z|[+-]\d{2}:?\d{2})$/u.test(value) ? Date.parse(value) : NaN;
}

function historyBinding(store: WorkbenchStore, rows: Event[], until: string): DingTalkHistoryBinding {
  const config = fields(store.row('governance_settings', 'key', 'connectors.dingtalk')?.value);
  const { profile, self_ids: selfIds } = config;
  if (typeof profile !== 'string' || !profile || !Array.isArray(selfIds)
    || !selfIds.length || selfIds.some(id => typeof id !== 'string' || !id) || !config.executable) {
    fail(409, '未配置钉钉账号');
  }
  const anchors = rows.flatMap(event => {
    const data = event.data;
    const meta = fields(data.metadata);
    if (event.source !== 'dingtalk' || !['routed', 'manually_linked'].includes(String(data.routing_status))
      || meta.conversation_type !== 'direct' || meta.profile !== profile || meta.self_authored
      || typeof meta.message_id !== 'string' || !meta.message_id || typeof data.occurred_at !== 'string'
      || !Number.isFinite(zonedTime(data.occurred_at)) || typeof data.thread_id !== 'string' || !data.thread_id
      || typeof data.actor_id !== 'string' || !data.actor_id || selfIds.includes(data.actor_id)) return [];
    return [{ profile, peer: data.actor_id, conversation: data.thread_id, anchorId: meta.message_id, since: data.occurred_at }];
  });
  if (new Set(anchors.map(anchor => JSON.stringify([anchor.conversation, anchor.peer]))).size !== 1) {
    fail(409, '此事件没有唯一且可核对的钉钉私聊');
  }
  anchors.sort((a, b) => zonedTime(a.since) - zonedTime(b.since));
  const binding = anchors[0];
  const window = zonedTime(until) - zonedTime(binding.since);
  if (window <= 0 || window > 7 * 86400_000) fail(409, '未能完整核对原钉钉会话，请稍后重试或手动补充');
  const history = fields(config.history);
  return { ...binding, until, selfIds, historyTimezone: typeof history.history_timezone === 'string'
    ? history.history_timezone : undefined, senderMap: fields(history.sender_map) };
}

export function dingtalkContextTarget(db: DatabaseSync, profile: string, conversation: string, time: string,
  peer?: string, quote?: string) {
  const rows = db.prepare(`SELECT e.task_id, julianday(json_extract(e.data,'$.occurred_at')) AS at
    FROM events e JOIN tasks t ON t.id=e.task_id JOIN projects p ON p.id=t.project_id
    WHERE e.source='dingtalk' AND e.external_id IS NOT NULL AND p.enabled AND NOT p.archived
    AND json_extract(e.data,'$.thread_id')=? AND json_extract(e.data,'$.metadata.profile')=?
    AND (json_extract(e.data,'$.routing_status') IN ('routed','manually_linked','self_context')
      OR (? IS NOT NULL AND json_extract(e.data,'$.routing_status')='context_only'))
    AND ((? IS NOT NULL AND json_extract(e.data,'$.metadata.message_id')=?) OR
      (? IS NULL AND json_extract(e.data,'$.metadata.conversation_type')='direct'
        AND NOT COALESCE(json_extract(e.data,'$.metadata.self_authored'),0)
        AND (? IS NULL OR json_extract(e.data,'$.actor_id')=?)
        AND julianday(json_extract(e.data,'$.occurred_at')) BETWEEN julianday(?,'-30 minutes') AND julianday(?)))
    ORDER BY at DESC,e.id DESC LIMIT 2`).all(conversation,profile,quote??null,quote??null,quote??null,quote??null,peer??null,peer??null,time,time);
  const [latest,other]=rows;
  if (!latest || (other && other.task_id!==latest.task_id && (quote || latest.at===other.at))) return;
  return Number(latest.task_id);
}

export async function syncDingTalkHistory(
  store: WorkbenchStore, groupId: number, getRows: () => Event[], actor: string, runtime?: WorkbenchRuntime,
  signal:AbortSignal=AbortSignal.timeout(30_000),
) {
  const binding = historyBinding(store, getRows(), now());
  if (!runtime?.readOwnDingTalk) fail(409, '钉钉历史读取未接入，请手动补充');
  let page;
  try {
    page = await runtime.readOwnDingTalk(binding, signal);
  } catch {
    fail(409, '未能完整核对原钉钉会话，请稍后重试或手动补充');
  }
  if (!page?.complete || page.conversationId !== binding.conversation || !Array.isArray(page.messages)
    || page.messages.length > 1000 || page.messages.some(row => row?.conversationId !== binding.conversation)
    || !page.messages.some(row => row.messageId === binding.anchorId && row.senderId === binding.peer)) {
    fail(409, '未能完整核对原钉钉会话，请稍后重试或手动补充');
  }
  const since = Math.floor(zonedTime(binding.since) / 1000) * 1000;
  const own = page.messages.filter(row => binding.selfIds.includes(row.senderId)
    && typeof row.text === 'string' && row.text.trim());
  for (const row of own) {
    const time = typeof row.occurredAt === 'string' ? zonedTime(row.occurredAt) : NaN;
    if (!Number.isFinite(time) || time < since || time >= zonedTime(binding.until)
      || typeof row.messageId !== 'string' || !row.messageId || row.messageId.length > 255 || row.text.length > 100000) {
      fail(409, '未能完整核对原钉钉会话，请稍后重试或手动补充');
    }
  }
  return store.write(() => {
    signal.throwIfAborted();
    const current = historyBinding(store, getRows(), binding.until);
    if (JSON.stringify(current) !== JSON.stringify(binding)) fail(409, '事件来源已变化，请刷新后再同步');
    let added = 0;
    for (const row of own) {
      if (dingtalkContextTarget(store.db,binding.profile,binding.conversation,row.occurredAt,binding.peer) !== groupId) continue;
      const key = `${binding.profile}:${binding.conversation}:${row.messageId}`;
      if (key.length > 255) fail(409, '钉钉消息标识无效');
      const metadata: Fields = { profile: binding.profile, message_id: row.messageId, sender_name: row.senderName ?? null,
        self_authored: true, at_me: false, conversation_type: 'direct', dws_event_type: 'user_im_message_receive_o2o_all',
        quoted_message: null, forward_messages: [], event_id: null, project_id: null };
      const data = { source: 'dingtalk', external_id: key, event_type: 'message.received', actor_id: row.senderId,
        thread_id: binding.conversation, project_external_id: binding.conversation, issue_id: null,
        content: row.text, occurred_at: row.occurredAt, attachments: [], metadata, routing_status: 'self_context' };
      const result = store.db.prepare(`INSERT INTO events(task_id,source,external_id,event_type,content,data,created_at)
        VALUES (?,'dingtalk',?,'message.received',?,?,?) ON CONFLICT(source,external_id) DO UPDATE SET
        task_id=excluded.task_id,data=excluded.data WHERE events.task_id IS NULL
        AND json_extract(events.data,'$.metadata.self_authored')=1
        AND json_extract(events.data,'$.routing_reason')='self_context_unmatched'`)
        .run(groupId, key, row.text, JSON.stringify(data), now());
      added += Number(result.changes);
    }
    if (added) store.audit(actor, 'event_group.sync_own_dingtalk', groupId, { added });
    return { added };
  });
}

export function recentDingTalkAnchors(store:WorkbenchStore, profile:string, after:number, hours:number,
  conversation?:string,peer?:string) {
  return store.rows<Event>('events',`WHERE id IN (SELECT MAX(e.id) FROM events e JOIN tasks t ON t.id=e.task_id
    JOIN projects p ON p.id=t.project_id
    WHERE e.source='dingtalk' AND e.external_id IS NOT NULL AND p.enabled AND NOT p.archived
    AND t.status NOT IN ('completed','cancelled') AND t.id>?
    AND json_extract(e.data,'$.metadata.profile')=? AND json_extract(e.data,'$.metadata.conversation_type')='direct'
    AND json_extract(e.data,'$.routing_status') IN ('routed','manually_linked')
    AND julianday(json_extract(e.data,'$.occurred_at'))>=julianday('now',?)
    AND (? IS NULL OR json_extract(e.data,'$.thread_id')=?)
    AND (? IS NULL OR json_extract(e.data,'$.actor_id')=?) GROUP BY t.id) ORDER BY task_id LIMIT 1`,
  after,profile,'-'+hours+' hours',conversation??null,conversation??null,peer??null,peer??null);
}
