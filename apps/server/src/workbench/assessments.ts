import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { workbenchRuntime, type AssessmentImage, type WorkbenchRuntime } from './runtime.ts';
import { unassignedContext } from './semantic-engine.ts';
import { sourceImagesWithinBudget, verifySourceImages } from './source-images.ts';
import { fail, fields, requireAdmin, type Event, type Fields, type WorkbenchStore } from './store.ts';

const requestSchema = z.object({ event_ids: z.array(z.int().positive()).min(2).max(5),
  request_key: z.string().trim().min(1).max(120).optional() });
const decisionSchema = z.strictObject({
  project_status: z.enum(['suggested', 'needs_context', 'no_project']),
  proposed_project_id: z.int().positive().nullable(),
  evidence_event_ids: z.array(z.int().positive()).max(10),
  reason: z.string().trim().min(1).max(2000),
  missing_context: z.string().max(1000),
  relationship: z.enum(['same_issue', 'different_issues', 'uncertain']),
  relationship_reason: z.string().trim().min(1).max(2000),
});

function comparison(store: WorkbenchStore, ids: number[], runtime?: WorkbenchRuntime) {
  const events = ids.map(id => store.row<Event>('events', 'id', id));
  if (events.some(event => !event?.external_id || event.task_id !== null
    || ['dismissed', 'manually_linked', 'routed', 'self_echo'].includes(String(event.data.routing_status))
    || store.db.prepare('SELECT 1 FROM event_targets WHERE event_id=? LIMIT 1').get(event.id))) {
    fail(422, '请选择尚未分派的来源事件');
  }
  const rows = events as Event[];
  const anchor = rows.at(-1)!;
  const scope = (row: Event) => [row.data.thread_id, row.data.actor_id, fields(row.data.metadata).profile];
  const anchorScope = JSON.stringify(scope(anchor));
  const contexts = rows.map(row => {
    const kind = fields(row.data.metadata).conversation_type;
    if (row.source === 'dingtalk' && (kind == null || kind === 'direct') && JSON.stringify(scope(row)) === anchorScope) {
      return unassignedContext(store, row, process.env, { allowBound: true, resolveRole: runtime?.resolveRole });
    }
  });
  if (contexts.some(context => !context)) fail(422, '事件必须来自同一获准的钉钉私聊');
  const context = { ...contexts.at(-1)!,
    comparison: rows.map(row => ({ event_id: row.id, content: row.content.slice(0, 4000),
      has_image: (Array.isArray(row.data.attachments) && row.data.attachments.length > 0)
        || /\[图片消息\]\s*\(mediaId=[^\s)]+\)/u.test(row.content) })) };
  return { anchor, context, rows };
}

function sourceBinding(store: WorkbenchStore, anchor: Event) {
  const config = fields(store.row('governance_settings', 'key', 'connectors.dingtalk')?.value);
  const { thread_id: conversation, actor_id: peer, occurred_at: at } = anchor.data;
  const { profile, message_id: anchorId, source_account_ids: accounts } = fields(anchor.data.metadata);
  const selfIds = Array.isArray(config.self_ids)
    ? [...new Set(config.self_ids.filter(id => typeof id === 'string' && id.trim()))].sort() : [];
  const anchorTime = typeof at === 'string' && /(?:Z|[+-]\d{2}:?\d{2})$/u.test(at) ? Date.parse(at) : NaN;
  const validId = (id: unknown): id is string => typeof id === 'string' && id.length <= 1024 && !!id
    && !id.startsWith('-') && !/[\s,\x00-\x1f\x7f]/u.test(id);
  const now = Date.now();
  if (!validId(profile) || config.profile !== profile || !selfIds.length || !validId(peer)
    || !validId(conversation) || !validId(anchorId) || selfIds.includes(peer)
    || (accounts != null && (!Array.isArray(accounts) || accounts.some(id => typeof id !== 'string')
      || JSON.stringify([...new Set(accounts)].sort()) !== JSON.stringify(selfIds)))
    || !Number.isFinite(anchorTime) || anchorTime >= now || now - anchorTime > 6 * 86400_000) return;
  const since = new Date(Math.max(now - 6 * 86400_000, anchorTime - 86400_000)).toISOString();
  return { binding: { profile, peer, conversation, anchorId, since, selfIds, until: new Date(now).toISOString() }, anchorTime };
}

async function chatEvidence(store: WorkbenchStore, anchor: Event, runtime?: WorkbenchRuntime) {
  const unavailable = (error: string) => ({ record: { tool: 'chat_evidence', status: 'unavailable', error }, history: [] });
  const read = runtime?.readOwnDingTalk;
  if (!read) return unavailable('history_reader_unavailable');
  const scope = sourceBinding(store, anchor);
  if (!scope) return unavailable('source_scope_unavailable');
  const { binding, anchorTime } = scope;
  const { conversation, anchorId, peer, selfIds, since } = binding;
  try {
    const page = await read(binding, AbortSignal.timeout(30_000));
    if (!page.complete || page.conversationId !== conversation || !Array.isArray(page.messages) || page.messages.length > 1000
      || page.messages.some(message => message.conversationId !== conversation)
      || !page.messages.some(message => message.messageId === anchorId && message.senderId === peer)) {
      return unavailable('source_scope_unconfirmed');
    }
    const history = page.messages.filter(message => (message.senderId === peer || selfIds.includes(message.senderId))
      && typeof message.text === 'string' && Date.parse(message.occurredAt) >= Date.parse(since)
      && Date.parse(message.occurredAt) < anchorTime).slice(-20).map(message => ({ time: message.occurredAt,
        direction: selfIds.includes(message.senderId) ? 'own_account' : 'received', content: message.text.slice(0, 1200) }));
    return { record: { tool: 'chat_evidence', status: 'verified', message_count: history.length }, history };
  } catch { return unavailable('history_read_unconfirmed'); }
}

async function imageEvidence(store: WorkbenchStore, event: Event, runtime: WorkbenchRuntime, stillAuthorized: () => boolean,
  budget: readonly AssessmentImage[]) {
  const event_id = event.id;
  const unavailable = (error: string) => ({ record: { tool: 'source_image', event_id, status: 'unavailable', error }, images: [] });
  if (!runtime.assessmentImagesAvailable?.()) return unavailable('model_image_input_unavailable');
  if (!runtime.readOwnDingTalkImages) return unavailable('source_image_reader_unavailable');
  if (!stillAuthorized()) return unavailable('source_scope_changed');
  const scope = sourceBinding(store, event);
  const config = fields(store.row('governance_settings', 'key', 'connectors.dingtalk')?.value);
  if (!scope || config.enabled !== true) return unavailable('source_scope_unavailable');
  try {
    const read = await runtime.readOwnDingTalkImages({ ...scope.binding, eventId: event_id }, AbortSignal.timeout(45_000));
    if (!stillAuthorized()) return unavailable('source_scope_changed');
    const verified = verifySourceImages(read);
    const images = verified.map(row => ({ ...row.image, eventId: event_id }));
    if (!images.length) return unavailable('no_verified_image');
    if (!sourceImagesWithinBudget([...budget, ...images])) return unavailable('source_image_limit_exceeded');
    return { record: { tool: 'source_image', event_id, status: 'verified', images: verified.map(row => row.evidence) }, images };
  } catch { return unavailable('source_image_read_unconfirmed'); }
}

function validate(text: string, snapshot: ReturnType<typeof comparison>['context']) {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return; }
  const parsed = decisionSchema.safeParse(raw);
  if (!parsed.success) return;
  const value = parsed.data;
  const allowed = new Set([...snapshot.history, ...snapshot.comparison].map(row => row.event_id));
  if (value.evidence_event_ids.some(id => !allowed.has(id))) return;
  if (value.project_status === 'suggested') {
    if (!value.evidence_event_ids.length || !snapshot.candidates.some(row => row.id === value.proposed_project_id)) return;
  } else if (value.proposed_project_id !== null || (value.project_status === 'needs_context' && !value.missing_context.trim())) return;
  return value;
}

export function registerAssessments(app: FastifyInstance, store: WorkbenchStore): void {
  const inFlight = new Map<string, Promise<Fields>>();
  app.post('/api/v1/routing/assessments', async request => {
    const principal = requireAdmin(request);
    const parsed = requestSchema.safeParse(request.body);
    if (!parsed.success) fail(422, '请选择 2 至 5 条来源事件');
    const ids = [...new Set(parsed.data.event_ids)].sort((left, right) => left - right);
    if (ids.length !== parsed.data.event_ids.length) fail(422, '事件编号不能重复');
    const runtime = workbenchRuntime(app);
    const { context, anchor, rows } = comparison(store, ids, runtime);
    const snapshotOf = ({ context, rows }: ReturnType<typeof comparison>) => JSON.stringify([context,
      rows.map(row => {
        const metadata = fields(row.data.metadata);
        return [row.id, row.external_id, row.content, row.data.thread_id, row.data.actor_id, row.data.occurred_at,
          metadata.profile, metadata.message_id, metadata.source_account_ids, row.data.attachments];
      }), store.row('governance_settings', 'key', 'connectors.dingtalk')?.value]);
    const snapshot = snapshotOf({ context, anchor, rows });
    const ready = Boolean(runtime?.runAssessment && (runtime.assessmentAvailable?.() ?? true));
    const id = 'comparison-' + createHash('sha256').update(JSON.stringify([principal.user_id, snapshot,
      ready, Boolean(runtime?.readOwnDingTalk), Boolean(runtime?.readOwnDingTalkImages),
      Boolean(runtime?.assessmentImagesAvailable?.()), parsed.data.request_key])).digest('hex').slice(0, 32);
    const saved = store.db.prepare(`SELECT details FROM governance_audit WHERE action='event.readonly_assessment'
      AND actor=? AND resource=? ORDER BY id LIMIT 1`).get(principal.user_id, id);
    if (typeof saved?.details === 'string') return JSON.parse(saved.details);
    const pending = inFlight.get(id);
    if (pending) return pending;
    const run = async (): Promise<Fields> => {
      const result: Fields = { event_ids: ids, assessment_id: id, status: 'incomplete', evidence: [],
        thread_id: null, turn_id: null, evidence_turn_id: null, visual_inputs: [] };
      const current = () => {
        try { return workbenchRuntime(app) === runtime && snapshotOf(comparison(store, ids, runtime)) === snapshot; }
        catch { return false; }
      };
      if (!ready || !runtime?.runAssessment) {
        result.error = '模型未配置，尚未执行评估';
      } else if (!current()) {
        result.error = '来源授权或状态在评估前已变化';
      } else {
        const chat = await chatEvidence(store, anchor, runtime);
        const imageRecords = [];
        const images: AssessmentImage[] = [];
        const marked = context.comparison.filter(row => row.has_image);
        for (const row of rows.filter(row => marked.some(item => item.event_id === row.id))) {
          const checked = await imageEvidence(store, row, runtime, current, images);
          imageRecords.push(checked.record);
          images.push(...checked.images);
        }
        if (!current()) result.error = '来源授权或状态在评估前已变化';
        else {
          result.evidence = [chat.record, ...imageRecords];
          const output = await runtime.runAssessment(id, { ...context, source_history: chat.history,
            history_fetch: chat.record.status, visual_input_event_ids: images.map(image => image.eventId) }, current, images);
          result.thread_id = output.thread_id;
          result.turn_id = output.turn_id;
          const authorized = current();
          if (!authorized) result.evidence = [];
          const visual = authorized && images.length > 0 && output.thread_id && output.turn_id
            && output.image_turn_id === output.turn_id;
          if (visual) {
            result.evidence_turn_id = output.turn_id;
            result.visual_inputs = images.map(image => image.eventId);
          }
          const decision = output.text && output.thread_id && output.turn_id && authorized && (!images.length || visual)
            ? validate(output.text, context) : undefined;
          if (decision) {
            result.decision = decision;
            if (chat.record.status === 'verified' && visual && imageRecords.every(row => row.status === 'verified')) result.status = 'assessed';
            else result.error = marked.length ? '部分来源证据无法核实' : '所选事件未包含原图';
          } else result.error = output.error ?? '模型结果无效或来源授权已经变化';
        }
      }
      return store.write(() => {
        store.db.prepare('INSERT INTO governance_audit(actor,action,resource,details,created_at) VALUES(?,?,?,?,?)')
          .run(principal.user_id, 'event.readonly_assessment', id, JSON.stringify(result), new Date().toISOString());
        return result;
      });
    };
    const operation = Promise.resolve().then(run).finally(() => inFlight.delete(id));
    inFlight.set(id, operation);
    return operation;
  });
}
