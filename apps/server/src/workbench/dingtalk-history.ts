import type { Event, Fields, WorkbenchStore } from './store.ts';
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

function candidates(store: WorkbenchStore, binding: DingTalkHistoryBinding) {
  return store.rows<Event>('events', `WHERE source = 'dingtalk' AND task_id IN (SELECT id FROM tasks)
    AND json_extract(data, '$.thread_id') = ? AND json_extract(data, '$.metadata.profile') = ?
    AND json_extract(data, '$.metadata.conversation_type') = 'direct'
    AND json_extract(data, '$.routing_status') IN ('routed','manually_linked')`, binding.conversation, binding.profile);
}

export async function syncDingTalkHistory(
  store: WorkbenchStore, groupId: number, getRows: () => Event[], actor: string, runtime?: WorkbenchRuntime,
) {
  const binding = historyBinding(store, getRows(), now());
  if (!runtime?.readOwnDingTalk) fail(409, '钉钉历史读取未接入，请手动补充');
  let page;
  try {
    page = await runtime.readOwnDingTalk(binding, AbortSignal.timeout(30_000));
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
    const current = historyBinding(store, getRows(), binding.until);
    if (JSON.stringify(current) !== JSON.stringify(binding)) fail(409, '事件来源已变化，请刷新后再同步');
    const sources = candidates(store, binding);
    let added = 0;
    for (const row of own) {
      const time = zonedTime(row.occurredAt);
      const recent = sources.filter(event => typeof event.data.occurred_at === 'string'
        && zonedTime(event.data.occurred_at) >= time - 30 * 60_000 && zonedTime(event.data.occurred_at) <= time);
      const targets = new Set(recent.map(event => event.task_id));
      if (targets.size !== 1 || !targets.has(groupId)) continue;
      const key = `${binding.profile}:${binding.conversation}:${row.messageId}`;
      if (key.length > 255) fail(409, '钉钉消息标识无效');
      const metadata: Fields = { profile: binding.profile, message_id: row.messageId, sender_name: row.senderName ?? null,
        self_authored: true, at_me: false, conversation_type: 'direct', dws_event_type: 'user_im_message_receive_o2o_all',
        quoted_message: null, forward_messages: [], event_id: null, project_id: null };
      const data = { source: 'dingtalk', external_id: key, event_type: 'message.received', actor_id: row.senderId,
        thread_id: binding.conversation, project_external_id: binding.conversation, issue_id: null,
        content: row.text, occurred_at: row.occurredAt, attachments: [], metadata, routing_status: 'self_context' };
      const result = store.db.prepare(`INSERT INTO events(task_id,source,external_id,event_type,content,data,created_at)
        VALUES (?,'dingtalk',?,'message.received',?,?,?) ON CONFLICT(source,external_id) DO NOTHING`)
        .run(groupId, key, row.text, JSON.stringify(data), now());
      added += Number(result.changes);
    }
    if (added) store.audit(actor, 'event_group.sync_own_dingtalk', groupId, { added });
    return { added };
  });
}
