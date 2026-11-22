import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { codexThreadReader, configureWorkbenchRuntime, registerWorkbench,
  type DingTalkHistoryBinding, type SemanticDecision, type SessionBinding } from './index.ts';
import { registerControls } from '../controls.ts';
import { checkHandoffReturn } from './handoff-return.ts';
import { nextTriageNotice } from './event-groups.ts';
import { notifyTriage } from '../../../../packages/channels/feishu-notices.ts';
import { WorkbenchStore } from './store.ts';
import { dirname } from 'node:path';

const oracle = JSON.parse(readFileSync(new URL('../../../../tests/rewrite-acceptance/stage0-evidence.json', import.meta.url), 'utf8'));
const schema: Record<string, string> = oracle.sample.oracle.sqlite_schema;
const at = '2026-11-17T08:00:00.000000+00:00';
const route = '/api/v1';
type Input = Record<string, SQLInputValue>;

describe('工作台与冻结 SQLite 表兼容', () => {
  let db: DatabaseSync;
  let app: FastifyInstance;
  function insert(table: string, row: Input) {
    const keys = Object.keys(row);
    db.prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
      .run(...Object.values(row));
  }
  function event(id: number, row: Input) {
    insert('events', { id, task_id: null, source: 'web', external_id: null, event_type: 'message',
      content: '', data: '{}', created_at: at, ...row });
  }
  function project(id: number, archived = 0) {
    insert('projects', { id, name: `项目 ${id}`, repo_path: '合成 工作区', base_branch: 'main',
      repositories: '[{"path":"子目录","base_branch":"main"}]', test_command: '', allowed_paths: '[]',
      dingtalk_chat_ids: '["chat"]', redmine_project_ids: '["7"]', enabled: Number(!archived), archived, created_at: at });
  }
  function task(id: number, row: Input) {
    insert('tasks', { id, title: `任务 ${id}`, goal: '合成目标', project_id: 1, kind: 'analysis',
      owner_id: 'alice', outcome_unknown: 0, status: 'queued', revision: 1, state_version: 1, control_version: 1,
      source: 'web', acceptance_criteria: '', created_at: at, updated_at: at, ...row });
  }
  const get = (url: string, user = 'admin') => app.inject({ url: route + url, headers: { 'x-fixture-user': user } });
  const post = (url: string, payload: object, user = 'admin') =>
    app.inject({ method: 'POST', url: route + url, payload, headers: { 'x-fixture-user': user } });

  beforeEach(() => {
    vi.stubEnv('SUPERAGENT_USERS_JSON', undefined);
    vi.stubEnv('SUPERAGENT_API_TOKEN', undefined);
    db = new DatabaseSync(':memory:');
    const statements = Object.values(schema);
    db.exec(statements.filter(sql => sql.startsWith('CREATE TABLE')).join(';\n'));
    db.exec(statements.filter(sql => !sql.startsWith('CREATE TABLE')).join(';\n'));
    app = Fastify();
    app.addHook('onRequest', async request => {
      const user = request.headers['x-fixture-user'] ?? request.headers.authorization?.match(/^Bearer fixture-([\w-]+)$/)?.[1];
      if (typeof user === 'string' && user !== 'anonymous') {
        request.principal = { user_id: user, role: user === 'admin' ? 'admin' : user === 'viewer' ? 'viewer' : 'member',
          authentication: 'bearer' };
      }
    });
    app.setErrorHandler((error, _request, reply) => {
      const fault = error as Error & { statusCode?: number };
      return reply.code(fault.statusCode ?? 500).send({ detail: fault.message });
    });
    registerControls(app, db);
    registerWorkbench(app, db);
    project(1);
    project(2, 1);
    task(1, { status: 'completed', owner_id: 'local-admin', title: '待核验' });
    task(2, { owner_id: 'bob', codex_thread_id: 'saved-thread' });
    task(3, { owner_id: 'bob', project_id: 2, status: 'paused', outcome_unknown: 1 });
    insert('governance_task_owners', { task_id: 1, user_id: 'alice' });
    event(1, { source: 'dingtalk', external_id: 'original', event_type: 'message.received', content: '同一源 % 要核验',
      data: JSON.stringify({ actor_id: 'actor', routing_status: 'routed', thread_id: 'chat',
        metadata: { profile: 'p', sender_name: '张三' },
        _lifecycle: [{ attempt: 1, steps: [{ stage: 'router', status: 'passed' }] }] }) });
    for (const id of [1, 2]) {
      event(id + 1, { task_id: id, source: 'dingtalk', external_id: `copy-${id}`,
        event_type: 'message.received', content: '同一源 % 要核验',
        data: JSON.stringify({ source_event_id: 1, routing_status: 'delivered', metadata: { sender_name: '张三' },
          occurred_at: '2026-11-17T16:00:00.123456+08:00' }) });
      insert('event_targets', { id, event_id: 1, task_id: id, subscription_id: id === 1 ? 1 : null,
        message_event_id: id + 1, created_at: at });
    }
    event(4, { task_id: 1, content: '人工补充' });
    event(5, { task_id: 2, source: 'runtime', event_type: 'assistant_message', content: '历史答复', data: '{"artifact_id":1}' });
    event(6, { source: 'redmine', external_id: 'closed', event_type: 'issue.changed',
      data: '{"issue_id":"42","metadata":{"issue_is_closed":true,"details":[{"property":"attr","name":"status_id"}]}}' });
    event(7, { source: 'dingtalk', external_id: 'unassigned', content: '待分派',
      data: '{"routing_status":"pending_confirmation"}' });
    event(8, { task_id: 3, source: 'redmine', external_id: 'unknown-task', event_type: 'issue.comment', content: '历史待核验' });
    insert('worker_subscriptions', { id: 1, task_id: 1, project_id: 1, source: 'dingtalk',
      thread_key: 'key', thread_id: 'chat', profile: 'p', enabled: 1, created_at: at });
    insert('task_routes', { id: 1, task_id: 2, project_id: 1, route_key: 'issue:42' });
    insert('artifacts', { id: 1, task_id: 2, kind: 'summary', revision: 1, content: '历史答复', created_at: at });
    insert('artifacts', { id: 2, task_id: 1, kind: 'patch', revision: 1, content: '旧任务产物', created_at: at });
    insert('approvals', { id: 1, task_id: 2, revision: 1, control_version: 1, action_hash: 'fixture-hash',
      action: '{"target":{"issue_id":42}}', status: 'pending', created_at: at });
    insert('semantic_routing_jobs', { event_id: 1, project_id: 1, status: 'unknown', context: '{"text":"分流历史"}',
      output: '旧模型结果', created_at: at, updated_at: at });
    insert('governance_identities', { id: 1, source: 'dingtalk', actor_id: 'actor', user_id: 'admin', enabled: 1 });
    insert('governance_identity_grants', { identity_id: 1, project_ids: '[1]', permissions: '["request"]' });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await app.close();
    db.close();
  });

  it('保留归档项目历史、认证边界和导出的持久证据', async () => {
    expect((await get('/tasks', 'anonymous')).statusCode).toBe(401);
    expect((await get('/projects', 'viewer')).json()).toMatchObject([{ id: 1, enabled: true, archived: false,
      repositories: [{ path: '子目录', base_branch: 'main' }] }]);
    expect((await get('/tasks?project_id=2&status=paused', 'bob')).json()).toMatchObject([{ id: 3, outcome_unknown: true }]);
    const detail = (await get('/tasks/2', 'bob')).json();
    expect(detail.events.map((e: { id: number }) => e.id)).toEqual([3, 5]);
    expect(detail.approvals[0].action).toEqual({ target: { issue_id: 42 } });
    const response = await get('/tasks/2/export', 'bob');
    expect(response.headers['content-disposition']).toBe('attachment; filename="task-2-evidence.json"');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({ format_version: 1, ...detail });
    const download = await get('/artifacts/1/download', 'bob');
    expect(download.headers['content-disposition']).toBe('attachment; filename="artifact-1.json"');
    expect(download.json()).toEqual(detail.artifacts[0]);
    expect((await get('/tasks/0')).statusCode).toBe(404);
  });

  it('两位成员和 viewer 的任务、证据、产物及统计使用相同可见性', async () => {
    const idList = (response: { json: () => { id: number }[] }) => response.json().map(row => row.id);
    expect(idList(await get('/tasks', 'alice'))).toEqual([1]);
    expect(idList(await get('/tasks', 'bob'))).toEqual([3, 2]);
    expect(idList(await get('/tasks', 'viewer'))).toEqual([]);
    expect(idList(await get('/tasks', 'local-admin'))).toEqual([]);
    expect(idList(await get('/tasks'))).toEqual([3, 2, 1]);
    for (const [user, taskId, artifactId] of [
      ['alice', 2, 1], ['bob', 1, 2], ['viewer', 1, 2], ['viewer', 2, 1], ['local-admin', 1, 2],
    ] as const) {
      for (const path of [`/tasks/${taskId}`, `/tasks/${taskId}/export`, `/artifacts/${artifactId}`,
        `/artifacts/${artifactId}/download`]) {
        const result = await get(path, user);
        expect(result.statusCode, `${user} ${path}`).toBe(404);
        expect(result.json()).toEqual({ detail: '记录不存在' });
        expect(result.headers['content-disposition']).toBeUndefined();
      }
    }
    expect((await get('/tasks/1', 'alice')).json().artifacts).toMatchObject([{ id: 2 }]);
    expect((await get('/tasks/1/export', 'alice')).json().task.id).toBe(1);
    expect((await get('/artifacts/2', 'alice')).json()).toMatchObject({ task_id: 1 });
    expect((await get('/artifacts/2/download', 'alice')).statusCode).toBe(200);
    const view = async (user: string) => {
      const { counts, active_tasks, pending_approvals } = (await get('/overview', user)).json();
      return { counts, active: active_tasks.map((task: { id: number }) => task.id),
        pending: pending_approvals.map((approval: { task_id: number }) => approval.task_id) };
    };
    expect(await view('alice')).toEqual({ counts: { completed: 1 }, active: [], pending: [] });
    expect(await view('bob')).toEqual({ counts: { queued: 1, paused: 1 }, active: [2, 3], pending: [2] });
    expect(await view('viewer')).toEqual({ counts: {}, active: [], pending: [] });
    expect(await view('admin')).toEqual({ counts: { completed: 1, queued: 1, paused: 1 }, active: [2, 3], pending: [2] });
    expect((await get('/event-groups/index', 'alice')).json()).toMatchObject({ total: 1, counts: { review: 1 } });
    expect((await get('/event-groups/index', 'viewer')).json()).toEqual({ total: 0, counts: {}, items: [], has_more: false });
  });

  it('事件流按任务权限发出通知，按最后收到的事件 ID 恢复', async () => {
    app.addHook('onSend', async (request, _reply, payload) => {
      if (!request.url.startsWith('/api/v1/events/stream') || !payload || typeof payload !== 'object'
        || !(Symbol.asyncIterator in payload)) return payload;
      const frames: string[] = [];
      const stream = payload as NodeJS.ReadableStream;
      for await (const chunk of stream) {
        const frame = String(chunk);
        if (frame.startsWith(': heartbeat')) return frames.join('');
        frames.push(frame);
      }
      return frames.join('');
    });
    const stream = (user: string, after?: number) => app.inject({ url: route + '/events/stream',
      headers: { 'x-fixture-user': user, ...(after === undefined ? {} : { 'last-event-id': String(after) }) } });
    const ids = (body: string) => [...body.matchAll(/^id: (\d+)$/gm)].map(match => Number(match[1]));
    const responses = await Promise.all([stream('alice'), stream('alice', 2), stream('bob'), stream('viewer')]);
    for (const response of responses) expect(response.headers['content-type']).toMatch(/^text\/event-stream/);
    expect(responses.map(response => ids(response.body))).toEqual([[2, 4], [4], [3, 5, 8], []]);
    expect(responses[2].body).not.toContain('历史答复');
    expect((await stream('anonymous')).statusCode).toBe(401);
  }, 10_000);

  it('先按项目、来源与状态筛选再分页，且组内只展示原始收件', async () => {
    const url = '/event-groups/index?project_id=1&source=dingtalk&q=同一源';
    const page = (await get(url + '&limit=1')).json();
    expect(page).toMatchObject({ total: 2, counts: { review: 1, active: 1 }, has_more: true,
      items: [{ key: 'group:2', messages: [{ id: 1 }] }] });
    const second = (await get(url + '&offset=1&limit=1')).json();
    expect(second.items[0].group.processing_status).toBe('needs_review');
    expect(second.items[0].messages.map((e: { id: number }) => e.id)).toEqual([1, 4]);
    const review = (await get(url + '&status=needs_action&limit=1')).json();
    expect(review).toMatchObject({ total: 1, counts: { review: 1, active: 1 }, has_more: false });
    expect((await get('/event-groups/index?status=finished')).json().items).toMatchObject(
      [{ messages: [{ id: 6, triage_reason: 'redmine_closed_status_notice' }] }]);
    expect((await get('/event-groups/index?limit=0')).statusCode).toBe(422);
    expect((await get('/event-groups', 'alice')).json()).toMatchObject([{ id: 1 }]);
    expect((await get('/event-groups/1', 'bob')).statusCode).toBe(404);
    expect((await get('/event-groups/1', 'viewer')).statusCode).toBe(404);
  });

  it('将核验写入单组历史，拒绝过期版本、非来源事件和未知执行状态', async () => {
    const url = '/event-groups/1/events/1/resolution';
    const payload = { status: 'resolved', evidence: '合成收件已核验', expected_state_version: 1 };
    expect((await post('/event-groups/1/events/4/resolution', payload, 'alice')).statusCode).toBe(404);
    expect((await post('/event-groups/3/events/8/resolution', payload, 'bob')).json().detail).toBe('执行结果未知，请先核验');
    expect((await post(url, { ...payload, evidence: '   ' }, 'alice')).statusCode).toBe(422);
    expect((await post(url, payload, 'alice')).json()).toMatchObject({ id: 1,
      processing: { status: 'resolved', actor: 'alice', evidence: '合成收件已核验' } });
    expect((await post(url, payload, 'alice')).statusCode).toBe(409);
    const first = (await get('/event-groups/1')).json();
    expect(first.group).toMatchObject({ status: 'completed', processing_status: 'completed', state_version: 2,
      revision: 1, control_version: 1, pending_event_count: 0 });
    expect(first.events.filter((e: { event_type: string }) => e.event_type === 'event_resolution')).toHaveLength(1);
    const second = (await get('/event-groups/2')).json();
    expect(second.events[0].processing).toEqual({ status: 'pending', evidence: '' });
    expect(second.group.state_version).toBe(1);
    expect(db.prepare('SELECT task_id FROM events WHERE id = 1').get()?.task_id).toBeNull();
  });

  it('保留原跟进关系，禁止重启已结束的组并记录成功变更', async () => {
    const url = '/event-groups/1/following/1';
    expect((await post(url, { enabled: false, expected_state_version: 1 }, 'bob')).statusCode).toBe(404);
    expect((await post(url, { enabled: false, expected_state_version: 1 }, 'alice')).json())
      .toMatchObject({ id: 1, enabled: false });
    expect((await post(url, { enabled: false, expected_state_version: 1 }, 'alice')).statusCode).toBe(409);
    expect((await post(url, { enabled: true, expected_state_version: 2 }, 'alice')).statusCode).toBe(409);
    const group = (await get('/event-groups/1')).json();
    expect(group.following).toMatchObject([{ id: 1, enabled: false }]);
    expect(group.events.filter((e: { event_type: string }) => e.event_type === 'following_changed')).toHaveLength(1);
  });

  it('旧 owner 未设置外部身份授权时仍可重命名和创建同项目的幂等委派', async () => {
    db.exec("UPDATE tasks SET status = 'queued' WHERE id = 1");
    expect(db.prepare("SELECT id FROM governance_identities WHERE user_id = 'alice'").get()).toBeUndefined();
    const rename = '/event-groups/1/rename';
    expect((await post(rename, { title: ' 新标题 ', expected_state_version: 1 }, 'alice')).json())
      .toMatchObject({ title: '新标题', state_version: 2, control_version: 1 });
    expect((await post(rename, { title: '过期标题', expected_state_version: 1 }, 'alice')).statusCode).toBe(409);
    const url = '/event-groups/1/delegations';
    const body = { goal: '同项目只读协作', request_key: 'fixture-key', expected_state_version: 2 };
    expect((await post(url, body, 'bob')).statusCode).toBe(404);
    const delegated = (await post(url, body, 'alice')).json();
    expect(delegated).toMatchObject({ task_id: 1, event_type: 'collaboration_requested',
      data: { child_group_id: 4, status: 'pending' } });
    expect((await post(url, body, 'alice')).json()).toEqual(delegated);
    expect((await post(url, { ...body, goal: '变更的目标' }, 'alice')).statusCode).toBe(409);
    expect((await get('/event-groups/4', 'alice')).json().group)
      .toMatchObject({ owner_id: 'alice', project_id: 1, kind: 'analysis', state_version: 1 });
    expect((await get('/event-groups/1', 'alice')).json().group).toMatchObject({ state_version: 3 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM tasks').get()?.count).toBe(4);
  });

  it('按角色返回会话，历史去除重复摘要并标明 Codex 记录不完整', async () => {
    const worker = '/sessions/worker%3A2';
    expect((await get('/sessions', 'viewer')).json()).toEqual([]);
    expect((await get('/sessions?project_id=1', 'bob')).json()).toMatchObject([{ id: 'worker:2' }]);
    expect((await get(worker, 'alice')).statusCode).toBe(404);
    expect((await get('/sessions/router%3A1', 'bob')).statusCode).toBe(404);
    expect((await get('/sessions/semantic%3A1', 'alice')).statusCode).toBe(404);
    const messages = (await get(worker, 'bob')).json().messages;
    expect(messages).toMatchObject([{ id: 'event:5', role: 'assistant', content: '历史答复' },
      { id: 'event:3', role: 'user', created_at: '2026-11-17T08:00:00.123456Z', data: { sender: '张三' } }]);
    expect((await get(worker + '/transcript', 'bob')).json()).toMatchObject({ thread_id: 'saved-thread',
      complete: false, source: 'persisted_visible_messages', items: messages });
    expect((await get('/sessions/semantic%3A1')).json()).toMatchObject({
      session: { status: 'unknown', outcome_unknown: true, worker_session_ids: ['worker:1', 'worker:2'] },
      messages: [{ id: 'legacy-input:1', content: '{"text": "分流历史"}' }, { id: 'legacy-output:1' }] });
    expect((await get('/sessions')).json().map((s: { id: string }) => s.id))
      .toEqual(['worker:3', 'worker:2', 'worker:1', 'router:1', 'router:2', 'semantic:1']);
    event(9, { task_id: 1, event_type: 'coordination_request', content: '旧任务调配' });
    event(10, { task_id: 2, event_type: 'coordination_request', content: '同项目调配' });
    expect((await get('/sessions/worker%3A1/coordination', 'alice')).json()).toMatchObject([{ id: 9 }]);
    expect((await get('/sessions/router%3A1/coordination')).json()).toMatchObject([{ id: 9 }, { id: 10 }]);
    expect((await get('/sessions/worker%3A1/coordination', 'bob')).statusCode).toBe(404);
  });

  it('对收件、跟踪、全局订阅和路由候选执行管理员检查', async () => {
    for (const url of ['/architecture', '/events', '/events/1/trace', '/routing/jobs', '/subscriptions']) {
      expect((await get(url, 'alice')).statusCode).toBe(403);
    }
    expect((await get('/architecture')).json()).toMatchObject({ counts: { events: 6, subscriptions: 2 } });
    const page = (await get('/events?routing_status=all&source=dingtalk&q=%25&limit=1')).json();
    expect(page).toMatchObject({ items: [{ id: 1 }], next_after: 1, has_more: true });
    expect((await get('/events?routing_status=all&source=dingtalk&q=%25&limit=1&after=1')).json())
      .toMatchObject({ items: [{ id: 2 }], next_after: 2, has_more: true });
    expect((await get('/events/1/trace')).json()).toMatchObject({ routing_session_id: 'semantic:1', routing_mode: 'unknown',
      worker_session_ids: ['worker:1', 'worker:2'], live_stages: { worker: { state: 'fanout', target_task_ids: [1, 2] } },
      target_observations: [{ task_id: 1 }, { task_id: 2, execution: { thread_id: 'saved-thread', events: [{ id: 5 }] } }],
      architecture_flow: [{ attempt: 1, nodes: [{ architecture_node: 'router', visited: true }] }] });
    expect((await get('/subscriptions')).json()).toMatchObject({ items: [{ reference_kind: 'issue' },
      { reference_kind: 'thread', subscription_type: 'explicit', enabled: true }] });
    expect((await get('/routing/jobs')).json()).toMatchObject({ items: [{ event_id: 1, correction_tasks: [{ id: 2 }] }],
      next_after: 1, has_more: false });
    db.exec("UPDATE governance_identity_grants SET permissions = '[]'");
    expect((await get('/routing/jobs')).json().items[0].correction_tasks).toEqual([]);
  });

  it('待研判链接按权限定位，飞书提醒只投递一次且不携带来源正文', async () => {
    const link = '/event-groups/index?event_id=7&limit=1';
    expect((await get(link, 'alice')).json().items).toEqual([]);
    expect((await get(link)).json().items).toMatchObject([{ state: 'triage', messages: [{ id: 7, triage_notice_status: 'disabled' }] }]);
    expect((await get('/event-groups/index?counts_only=1')).json()).toEqual({ counts: expect.objectContaining({ triage: 1 }) });

    const store = new WorkbenchStore(db);
    const candidate = (id?: number) => nextTriageNotice(store, id);
    const send = () => notifyTriage(db, { owner: 'admin', appId: 'fixture', recipient: 'ou_fixture',
      encryptKey: '', verificationToken: '' }, 'fixture', AbortSignal.timeout(1000), () => {}, candidate, 'http://127.0.0.1:8878');
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ access_token: 'fixture' }))
      .mockResolvedValueOnce(Response.json({ code: 0, data: { message_id: 'om_fixture' } }));
    try {
      await send();
      await send();
      expect(fetch).toHaveBeenCalledTimes(2);
      const body = JSON.parse(String(fetch.mock.calls[1][1]?.body));
      expect(body.content).toContain('http://127.0.0.1:8878/?event=7');
      expect(body.content).not.toContain('待分派');
      expect((await get(link)).json().items[0].messages[0].triage_notice_status).toBe('sent');

      event(9, { source: 'dingtalk', external_id: 'later', event_type: 'message.received', content: '合成待办',
        data: '{"routing_status":"pending_confirmation"}' });
      fetch.mockImplementationOnce(async () => {
        expect((await post('/event-groups/triage', { action: 'close', event_ids: [9] })).statusCode).toBe(200);
        return Response.json({ access_token: 'fixture' });
      });
      await send();
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(candidate()).toBeUndefined();

      event(10, { source: 'dingtalk', external_id: 'quiet', content: '规则暂停',
        data: '{"routing_status":"pending_confirmation","routing_reason":"private_policy_hold"}' });
      expect(candidate()).toBeUndefined();
      event(11, { source: 'dingtalk', external_id: 'unconfirmed', content: '合成待办',
        data: '{"routing_status":"pending_confirmation"}' });
      fetch.mockResolvedValueOnce(Response.json({ access_token: 'fixture' })).mockRejectedValueOnce(new TypeError('fixture timeout'));
      await send();
      await send();
      expect(fetch).toHaveBeenCalledTimes(5);
      expect((await get('/event-groups/index?event_id=11')).json().items[0].messages[0].triage_notice_status).toBe('unknown');
    } finally {
      fetch.mockRestore();
    }
  });

  it('人工分派批量校验、回滚旧版本并为历史来信追加执行输入', async () => {
    insert('semantic_routing_jobs', { event_id: 7, project_id: 1, status: 'queued', context: '{}',
      output: '', created_at: at, updated_at: at });
    insert('event_routing_sessions', { event_id: 7, status: 'queued', state_version: 3, outcome_unknown: 0, updated_at: at });
    db.exec("UPDATE tasks SET status='review_ready' WHERE id=2");
    const endpoint = '/event-groups/triage';
    const link = { action: 'link', event_ids: [7, 7], group_id: 2, expected_state_version: 1 };
    expect((await post(endpoint, link, 'bob')).statusCode).toBe(403);
    expect((await post(endpoint, { ...link, expected_state_version: 8 })).statusCode).toBe(409);
    expect(db.prepare('SELECT task_id FROM events WHERE id=7').get()?.task_id).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS count FROM governance_audit').get()?.count).toBe(0);
    const linked = (await post(endpoint, link)).json();
    expect(linked.group).toMatchObject({ id: 2, status: 'waiting_input', revision: 2, control_version: 2, state_version: 2 });
    expect(linked.messages).toMatchObject([{ id: 1 }, { id: 7, data: { routing_status: 'manually_linked' } }]);
    expect(db.prepare('SELECT status FROM approvals WHERE id=1').get()?.status).toBe('expired');
    expect(db.prepare('SELECT status FROM semantic_routing_jobs WHERE event_id=7').get()?.status).toBe('closed');
    expect(db.prepare('SELECT state_version FROM event_routing_sessions WHERE event_id=7').get()?.state_version).toBe(4);
    expect(db.prepare('SELECT message_event_id FROM event_targets WHERE event_id=7').get()?.message_event_id).toBe(9);
    expect((await post(endpoint, link)).statusCode).toBe(409);
    expect((await post(endpoint, { action: 'close', event_ids: [6] })).json()).toMatchObject({
      messages: [{ id: 6, state: 'closed', data: { routing_status: 'dismissed', triage_actor: 'admin' } }],
    });
    event(10, { source: 'dingtalk', external_id: 'picture', content: '[图片消息] (mediaId=fixture)',
      data: '{"thread_id":"chat","metadata":{"profile":"p","message_id":"pic"}}' });
    const created = (await post(endpoint, { action: 'create', event_ids: [10], project_id: 1,
      title: ' 分派任务 ', goal: '处理图片' })).json();
    expect(created.group).toMatchObject({ owner_id: 'admin', title: '分派任务', status: 'waiting_resource' });
    expect(created.messages).toMatchObject([{ id: 10, data: { attachments_status: 'pending' } }]);
    expect(db.prepare('SELECT status FROM event_attachment_jobs WHERE event_id=10').get()?.status).toBe('pending');
  });

  it('只导入已确认私聊中本账号且唯一归属于当前组的消息', async () => {
    const anchorAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const ownAt = new Date(Date.now() - 4 * 60_000).toISOString();
    db.prepare("UPDATE events SET task_id=2, data=json_set(data,'$.occurred_at',?, '$.metadata.conversation_type','direct', '$.metadata.message_id','origin') WHERE id=1")
      .run(anchorAt);
    insert('governance_settings', { key: 'connectors.dingtalk', value: '{"profile":"p","self_ids":["me"],"executable":"fixture-only"}',
      updated_at: at });
    const endpoint = '/event-groups/2/sync-own-dingtalk';
    const reader = vi.fn(async (_binding: DingTalkHistoryBinding) => ({ complete: true, conversationId: 'chat', messages: [
      { conversationId: 'chat', messageId: 'origin', senderId: 'actor', occurredAt: anchorAt, text: '来信' },
      { conversationId: 'chat', messageId: 'own', senderId: 'me', occurredAt: ownAt, text: '我的说明' },
      { conversationId: 'chat', messageId: 'peer', senderId: 'actor', occurredAt: ownAt, text: '对方的其他发言' },
    ] }));
    configureWorkbenchRuntime(app, { readOwnDingTalk: reader });
    expect((await post(endpoint, {}, 'bob')).statusCode).toBe(403);
    expect(reader).not.toHaveBeenCalled();
    expect((await post(endpoint, {})).json()).toEqual({ added: 1 });
    expect(reader.mock.calls[0]?.[0]).toMatchObject({ profile: 'p', conversation: 'chat', peer: 'actor', anchorId: 'origin' });
    expect((await post(endpoint, {})).json()).toEqual({ added: 0 });
    const result = (await get('/event-groups/2')).json().events.find((row: { external_id: string }) => row.external_id === 'p:chat:own');
    expect(result).toMatchObject({ task_id: 2, content: '我的说明', requires_resolution: false, data: { routing_status: 'self_context' } });
    expect(db.prepare("SELECT 1 FROM events WHERE external_id='p:chat:peer'").get()).toBeUndefined();
    reader.mockResolvedValueOnce({ complete: false, conversationId: 'chat', messages: [] });
    expect((await post(endpoint, {})).statusCode).toBe(409);
  });

  it('会话沿用任务发言的权限和版本，Router 写入持久便笺，语义复核保留证据', async () => {
    const as = (user: string) => ({ authorization: 'Bearer fixture-' + user });
    const dispatch = (path: string, payload: object, user = 'admin') =>
      app.inject({ method: 'POST', url: route + path, payload, headers: as(user) });
    const worker = '/sessions/worker%3A2/messages';
    expect((await dispatch(worker, { content: '补充', expected_state_version: 1 }, 'alice')).statusCode).toBe(404);
    expect((await dispatch(worker, { content: '补充', expected_state_version: 1 }, 'bob')).json()).toMatchObject({
      task_id: 2, event_type: 'message', data: { actor: 'bob' },
    });
    expect((await dispatch(worker, { content: '补充', expected_state_version: 1 }, 'bob')).statusCode).toBe(409);
    const router = '/sessions/router%3A1/messages';
    expect((await dispatch(router, { content: ' 关于项目的便笺 ', expected_state_version: 1 })).json())
      .toMatchObject({ role: 'user', content: '关于项目的便笺', data: { status: 'note' } });
    expect((await dispatch(router, { content: '旧版本', expected_state_version: 1 })).statusCode).toBe(409);
    insert('governance_settings', { key: 'semantic_routing_enabled', value: 'true', updated_at: at });
    const stopped = vi.fn(async () => true);
    configureWorkbenchRuntime(app, { hasStoppedSession: stopped });
    const semantic = '/sessions/semantic%3A1';
    expect((await dispatch(semantic + '/messages', { content: '复核', expected_state_version: 1 })).statusCode).toBe(409);
    expect((await dispatch(semantic + '/reconcile', { evidence: '已核实进程退出', expected_state_version: 1 })).json())
      .toMatchObject({ status: 'idle', outcome_unknown: false, state_version: 2 });
    expect(stopped).toHaveBeenCalledWith({ kind: 'semantic', id: 1 });
    expect((await dispatch(semantic + '/messages', { content: ' 针对分派复核 ', expected_state_version: 2 })).json())
      .toMatchObject({ role: 'user', content: '针对分派复核', data: { status: 'queued', actor: 'admin' } });
    expect((await get(semantic)).json()).toMatchObject({
      session: { state_version: 3, status: 'queued', routing_status: 'rejected' },
      messages: [{ content: '{"text": "分流历史"}' }, { content: '旧模型结果' },
        { content: '已核实进程退出' }, { content: '针对分派复核' }],
    });
  });

  it('Codex transcript 只读取绑定线程并验证返回的线程及所有权', async () => {
    const reader = vi.fn(async (_binding: SessionBinding, _method: 'thread/read',
      _params: { threadId: string; includeTurns: true }) => ({ thread: { id: 'saved-thread', turns: [{ id: 'real-turn',
      items: [{ id: 'visible', type: 'agentMessage', text: '可见结果' }, { id: 'private', type: 'reasoning' }],
    }] } }));
    configureWorkbenchRuntime(app, { readThread: codexThreadReader(reader) });
    const url = '/sessions/worker%3A2/transcript';
    expect((await get(url, 'alice')).statusCode).toBe(404);
    expect(reader).not.toHaveBeenCalled();
    expect((await get(url, 'bob')).json()).toMatchObject({ complete: true, source: 'codex_thread',
      items: [{ id: 'visible', turn_id: 'real-turn' }] });
    expect(reader.mock.calls[0]?.slice(0, 3)).toEqual([{ kind: 'worker', id: 2 }, 'thread/read',
      { threadId: 'saved-thread', includeTurns: true }]);
    reader.mockResolvedValueOnce({ thread: { id: 'wrong-thread', turns: [] } });
    expect((await get(url, 'bob')).json()).toMatchObject({ complete: false, source: 'persisted_visible_messages' });
  });

  it('分派纠正保留既有投递，对新判定验证授权与运行时落库结果', async () => {
    const atPath = '/routing/jobs/1/correction';
    const evidence = '人工核对了原分派';
    const note = { action: 'confirm', kind: 'analysis', task_id: null, state_version: null, reason: '已见原任务' };
    const apply = vi.fn(async (id: number, decision: SemanticDecision) => {
      db.prepare("UPDATE semantic_routing_jobs SET decision=?, status='ignored' WHERE event_id=?")
        .run(JSON.stringify(decision), id);
      return { newly_applied: false };
    });
    const schedule = vi.fn(async () => ({ checked: 1, routed_event_ids: [] }));
    configureWorkbenchRuntime(app, { applySemanticCorrection: apply, scheduleSemantic: schedule });
    expect((await post('/routing/schedule', {}, 'bob')).statusCode).toBe(403);
    expect(schedule).not.toHaveBeenCalled();
    expect((await post('/routing/schedule', { event_id: 7 })).json()).toEqual({ checked: 1, routed_event_ids: [] });
    expect(schedule).toHaveBeenCalledWith(7, 'admin');
    expect((await post(atPath, { decision: note, evidence })).json()).toMatchObject({ event_id: 1, newly_applied: false });
    expect(apply).not.toHaveBeenCalled();
    expect((await get('/sessions/semantic%3A1')).json().messages).toHaveLength(3);
    expect(db.prepare('SELECT count(*) AS count FROM event_targets WHERE event_id=1').get()?.count).toBe(2);
    insert('semantic_routing_jobs', { event_id: 7, project_id: 1, status: 'rejected', context: '{}',
      output: '', created_at: at, updated_at: at });
    db.exec("UPDATE events SET data=json_set(data,'$.actor_id','actor') WHERE id=7");
    const newPath = '/routing/jobs/7/correction';
    expect((await post(newPath, { decision: { ...note, action: 'dispatch', task_id: 2, state_version: 100 }, evidence })).statusCode)
      .toBe(409);
    expect(apply).not.toHaveBeenCalled();
    expect((await post(newPath, { decision: { ...note, action: 'ignore' }, evidence })).json())
      .toMatchObject({ event_id: 7, status: 'ignored', newly_applied: false, decision: { action: 'ignore' } });
    expect(apply).toHaveBeenCalledExactlyOnceWith(7, { ...note, action: 'ignore' }, evidence, 'admin');
  });

  it('巡检历史和纠正使用原记录，启用开关控制实际调用', async () => {
    const url = '/operations/watchdog';
    insert('watchdog_runs', { id: 'fixture-run', task_id: 2, state_version: 1, status: 'unknown',
      evidence: '{"turn":"old"}', conclusion: '{}', correction: '', created_at: at });
    const run = vi.fn(async (taskId: number) => {
      insert('watchdog_runs', { id: 'new-run', task_id: taskId, state_version: 1, status: 'completed',
        evidence: '{"turn":"new"}', conclusion: '{"action":"none"}', correction: '', created_at: at });
      return 'new-run';
    });
    configureWorkbenchRuntime(app, { runWatchdog: run, hasStoppedWatchdog: async () => true });
    expect((await get(url, 'bob')).statusCode).toBe(403);
    expect((await get(url + '?task_id=2')).json()).toMatchObject({ enabled: false, interval_seconds: 60,
      items: [{ id: 'fixture-run', evidence: { turn: 'old' } }] });
    expect((await post(url + '/tasks/2/run', {})).statusCode).toBe(409);
    expect(run).not.toHaveBeenCalled();
    insert('governance_settings', { key: 'watchdog_enabled', value: 'true', updated_at: at });
    expect((await post(url + '/tasks/2/run', {})).statusCode).toBe(409);
    expect(run).not.toHaveBeenCalled();
    expect((await post(url + '/fixture-run/messages', { content: ' 退出证据 ', reconcile_unknown: true })).json())
      .toMatchObject({ status: 'reconciled', correction: '退出证据' });
    expect((await post(url + '/tasks/2/run', {})).json()).toEqual({ run_id: 'new-run' });
    expect(run).toHaveBeenCalledExactlyOnceWith(2);
    expect(db.prepare("SELECT content FROM events WHERE source='watchdog'").get()?.content).toBe('退出证据');
  });

  it('Bearer 桥接按快照分页并重放原操作，未知结果不会重复发言', async () => {
    const url = '/conversation-providers';
    const as = (user: string) => ({ authorization: 'Bearer fixture-' + user });
    const inject = (path: string, user: string, payload?: object) => app.inject({
      method: payload ? 'POST' : 'GET', url: route + url + path, headers: as(user), payload,
    });
    expect((await get(url + '/bridge/status')).statusCode).toBe(401);
    const path = '/bridge/sessions/worker%3A2';
    expect((await inject(path, 'alice')).statusCode).toBe(404);
    const first = (await inject(path + '?limit=1', 'bob')).json();
    const second = (await inject(path + '?after=1&limit=1', 'bob')).json();
    expect(first.snapshot).toBe(second.snapshot);
    expect(first.messages[0].id).not.toBe(second.messages[0].id);
    const body = { action: 'message', session_id: 'worker:2', request_key: 'send-once',
      content: '桥接补充', expected_state_version: 1 };
    const ops = '/bridge/operations';
    expect((await inject(ops, 'bob', body)).json()).toMatchObject({ session_id: 'worker:2', duplicate: false });
    expect((await inject(ops, 'bob', body)).json()).toMatchObject({ session_id: 'worker:2', duplicate: true });
    expect((await inject(ops, 'bob', { ...body, content: '不同正文' })).statusCode).toBe(409);
    expect((await inject(ops + '/send-once', 'alice')).statusCode).toBe(404);
    expect((await inject(ops + '/send-once', 'bob')).json()).toMatchObject({ status: 'completed' });
    expect((await inject(path, 'bob')).json().snapshot).not.toBe(first.snapshot);
    const stale = { ...body, request_key: 'stale' };
    expect((await inject(ops, 'bob', stale)).statusCode).toBe(409);
    expect((await inject(ops, 'bob', stale)).statusCode).toBe(409);
    expect((await inject(ops + '/stale', 'bob')).json()).toMatchObject({ status: 'unknown', result: null });
    expect(db.prepare("SELECT COUNT(*) AS count FROM events WHERE task_id=2 AND content='桥接补充'").get()?.count).toBe(1);
    const mcp = (method: string, params: object) => inject('/mcp', 'bob', { jsonrpc: '2.0', id: 1, method, params });
    expect((await mcp('tools/list', {})).json().result.tools).toHaveLength(5);
    const rpc = (await mcp('tools/call', { name: 'superagent_read', arguments: { session_id: 'worker:2', limit: 1 } })).json();
    expect(rpc.result.isError).toBe(false);
    expect(JSON.parse(rpc.result.content[0].text).session.id).toBe('worker:2');
    expect((await mcp('tools/call', { name: 'superagent_read', arguments: { session_id: 'worker:1' } })).json().result.isError).toBe(true);
    db.exec("UPDATE tasks SET owner_id='alice' WHERE id=2");
    expect((await inject(ops + '/send-once', 'bob')).statusCode).toBe(404);
  });

  it('接管只为可见的已退出本机任务生成材料，并发只暂停和记账一次', async () => {
    db.exec("UPDATE tasks SET status='review_ready',codex_thread_id='saved-legacy' WHERE id=1");
    const url = '/sessions/worker:1/handoff';
    expect((await post(url, {}, 'bob')).statusCode).toBe(404);
    expect((await post(url, {}, 'viewer')).statusCode).toBe(404);
    expect((await post('/sessions/router:1/handoff', {})).statusCode).toBe(422);
    const requests = await Promise.all(Array.from({ length: 4 }, () => post(url, {}, 'alice')));
    expect(requests.map(result => result.statusCode)).toEqual([200, 200, 200, 200]);
    expect(requests.map(result => result.json())).toEqual(Array(4).fill(requests[0].json()));
    expect(requests[0].json()).toMatchObject({ task_id: 1, thread_id: 'saved-legacy' });
    expect(requests[0].json().content).toContain('当前状态：paused；任务版本：2');
    expect(db.prepare("SELECT count(*) AS n FROM events WHERE event_type='manual_handoff'").get()?.n).toBe(1);
  });

  it('关联明确的项目排查轮次，完成后只回填一次并继续原任务的只读分析', async () => {
    const threadId = '00000000-0000-4000-8000-000000000001';
    const turnId = '00000000-0000-4000-8000-000000000002';
    const otherTurnId = '00000000-0000-4000-8000-000000000003';
    const cwd = process.cwd();
    let sourceCwd = dirname(cwd);
    let turnStatus = 'interrupted';
    const readThread = vi.fn(async () => ({ thread: { id: threadId, cwd: sourceCwd, turns: [
      { id: turnId, status: turnStatus, completedAt: turnStatus === 'completed' ? 1795050000 : null, error: null, items: [
        { type: 'agentMessage', phase: 'commentary', text: '过程消息' },
        { type: 'agentMessage', phase: 'final_answer', text: '合成排查结论' },
      ] },
      { id: otherTurnId, status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text: '无关追问' }] },
    ] } }));
    db.prepare('UPDATE projects SET repo_path=? WHERE id=1').run(cwd);
    db.exec("UPDATE tasks SET status='review_ready',kind='reply',codex_thread_id='old-reply' WHERE id=1");
    configureWorkbenchRuntime(app, { readThread });
    const handoff = (await post('/sessions/worker:1/handoff', {})).json();
    const url = '/sessions/worker:1/handoff-return';
    const body = { thread_id: threadId, turn_id: turnId, expected_state_version: handoff.state_version };
    expect((await post(url, body, 'alice')).statusCode).toBe(403);
    expect(readThread).not.toHaveBeenCalled();
    expect((await post(url, body)).statusCode).toBe(409);
    sourceCwd = cwd;
    expect((await post(url, body)).json()).toMatchObject({ status: 'waiting' });
    const store = new WorkbenchStore(db);
    const poll = () => checkHandoffReturn(store, readThread, fn => store.write(fn), () => 'admin', new AbortController().signal);
    const due = () => db.exec("UPDATE events SET data=json_set(data,'$.next_check',0) WHERE event_type='codex_handoff_return'");
    await poll();
    expect((await get(url)).json()).toMatchObject({ status: 'waiting' });
    expect(db.prepare('SELECT status FROM tasks WHERE id=1').get()?.status).toBe('paused');
    turnStatus = 'completed';
    due();
    await Promise.all([poll(), poll()]);
    expect((await get(url)).json()).toMatchObject({ status: 'imported' });
    expect(db.prepare('SELECT kind,status,codex_thread_id FROM tasks WHERE id=1').get())
      .toMatchObject({ status: 'queued', kind: 'analysis', codex_thread_id: null });
    const evidence = db.prepare("SELECT content FROM events WHERE task_id=1 AND json_extract(data,'$.provenance')='codex_handoff_result'").all();
    expect(evidence).toEqual([{ content: 'Codex 接管排查结论（待核验）：\n合成排查结论' }]);

    const nextHandoff = (await post('/sessions/worker:1/handoff', {}));
    expect(nextHandoff.statusCode).toBe(409);
    db.exec("UPDATE tasks SET status='review_ready' WHERE id=1");
    const resumed = (await post('/sessions/worker:1/handoff', {})).json();
    expect((await post(url, { ...body, expected_state_version: resumed.state_version })).statusCode).toBe(200);
    db.exec('UPDATE tasks SET state_version=state_version+1 WHERE id=1');
    await poll();
    expect((await get(url)).json()).toMatchObject({ status: 'stale' });
    expect(db.prepare('SELECT status FROM tasks WHERE id=1').get()?.status).toBe('paused');
  });

  it('跨所有权的调配申请不可见，管理员并发重复申请及应用只追加一次', async () => {
    event(9, { task_id: 1, source: 'redmine', external_id: 'coord-original', event_type: 'issue.comment',
      content: '调配原件', data: '{"actor_id":"coord-admin","project_external_id":"7","routing_status":"routed"}' });
    insert('governance_identities', { id: 2, source: 'redmine', actor_id: 'coord-admin', user_id: 'admin', enabled: 1 });
    insert('governance_identity_grants', { identity_id: 2, project_ids: '[1]', permissions: '["request"]' });
    const path = '/sessions/worker:1/coordination';
    const body = { target_task_id: 2, event_id: 9, evidence: '已确认应补充', expected_state_version: 1, request_key: 'stable' };
    expect((await post(path, body, 'alice')).statusCode).toBe(404);
    expect((await post('/sessions/worker:2/coordination', body, 'bob')).statusCode).toBe(404);
    const requested = await Promise.all(Array.from({ length: 4 }, () => post(path, body)));
    expect(requested.map(result => result.statusCode)).toEqual([200, 200, 200, 200]);
    const requestId = requested[0].json().id;
    expect(requested.map(result => result.json().id)).toEqual(Array(4).fill(requestId));
    expect((await post(path, { ...body, evidence: '不同内容' })).statusCode).toBe(409);
    const apply = '/sessions/worker:2/coordination/' + requestId + '/apply';
    expect((await post(apply, {}, 'bob')).statusCode).toBe(403);
    const applied = await Promise.all(Array.from({ length: 4 }, () => post(apply, {})));
    expect(applied.map(result => result.statusCode)).toEqual([200, 200, 200, 200]);
    expect(applied[0].json()).toMatchObject({ id: requestId, data: { status: 'applied', retained_task_ids: [1] } });
    expect(db.prepare('SELECT task_id FROM events WHERE id=9').get()?.task_id).toBe(1);
    expect(db.prepare('SELECT count(*) AS n FROM event_targets WHERE event_id=9 AND task_id=2').get()?.n).toBe(1);
    expect(db.prepare('SELECT state_version FROM tasks WHERE id=2').get()?.state_version).toBe(2);
    event(12, { task_id: 1, source: 'redmine', external_id: 'member-original', event_type: 'issue.comment',
      content: '由旧 owner 映射成员发起', data: '{"actor_id":"coord-admin","project_external_id":"7","routing_status":"routed"}' });
    db.exec("UPDATE governance_identities SET user_id='alice' WHERE id=2");
    configureWorkbenchRuntime(app, { resolveRole: user => user === 'alice' ? 'member' : undefined });
    const forbidden = await post(path, { ...body, event_id: 12, request_key: 'source-other-owner', expected_state_version: 2 });
    expect(forbidden.statusCode).toBe(200);
    expect((await post('/sessions/worker:2/coordination/' + forbidden.json().id + '/apply', {})).statusCode).toBe(403);
    expect(db.prepare('SELECT COUNT(*) AS n FROM event_targets WHERE event_id=12').get()?.n).toBe(0);
  });

  it('两条经授权的同一私聊可做只读评估，无模型时审计真实缺口且不派发', async () => {
    for (const id of [9, 10]) event(id, { source: 'dingtalk', external_id: 'assess-' + id,
      event_type: 'message.received', content: '能帮我查一下进展吗',
      data: '{"actor_id":"actor","thread_id":"unbound-direct","metadata":{"profile":"p","dws_event_type":"user_im_message_receive_o2o_all","uncertain_mentions":[]},"routing_status":"pending_confirmation"}' });
    const url = '/routing/assessments';
    expect((await post(url, { event_ids: [9, 10] }, 'alice')).statusCode).toBe(403);
    expect((await post(url, { event_ids: [9, 9] })).statusCode).toBe(422);
    const results = await Promise.all([post(url, { event_ids: [9, 10] }), post(url, { event_ids: [10, 9] })]);
    expect(results.map(result => result.statusCode)).toEqual([200, 200]);
    expect(results[0].json()).toMatchObject({ event_ids: [9, 10], status: 'incomplete', thread_id: null, turn_id: null });
    expect(results[1].json().assessment_id).toBe(results[0].json().assessment_id);
    expect(db.prepare("SELECT count(*) AS n FROM governance_audit WHERE action='event.readonly_assessment'").get()?.n).toBe(1);
    expect(db.prepare('SELECT task_id FROM events WHERE id=9').get()?.task_id).toBeNull();
  });

  it('兼容旧语义判定的仅记账重放，未知巡检和会话仍要求退出确认', async () => {
    event(9, { source: 'redmine', external_id: 'legacy-ignore', data: '{"routing_status":"ignored"}' });
    insert('semantic_routing_jobs', { event_id: 9, project_id: 1, status: 'ignored', context: '{}',
      decision: '{"action":"ignore","reason":"样本"}', output: '', created_at: at, updated_at: at });
    const path = '/routing/jobs/9/correction';
    expect((await post(path, { decision: { action: 'ignore', reason: '样本' }, evidence: '人工核验' })).json())
      .toMatchObject({ event_id: 9, status: 'ignored', newly_applied: false });
    expect((await post(path, { decision: { action: 'dispatch', reason: '缺少版本' }, evidence: '人工核验' })).statusCode).toBe(409);
    expect(db.prepare('SELECT count(*) AS n FROM event_routing_messages WHERE event_id=9').get()?.n).toBe(2);
    insert('router_sessions', { project_id: 1, status: 'unknown', state_version: 1, outcome_unknown: 1, updated_at: at });
    insert('watchdog_runs', { id: 'legacy-unknown-watchdog', task_id: 1, state_version: 1, status: 'unknown',
      evidence: '{}', conclusion: '{}', correction: '', created_at: at });
    expect((await post('/sessions/router:1/reconcile', { evidence: '已停止', expected_state_version: 1 })).statusCode).toBe(409);
    expect((await post('/operations/watchdog/legacy-unknown-watchdog/messages',
      { content: '已核验', reconcile_unknown: true })).statusCode).toBe(409);
    expect(db.prepare('SELECT outcome_unknown FROM router_sessions WHERE project_id=1').get()?.outcome_unknown).toBe(1);
    expect(db.prepare("SELECT status FROM watchdog_runs WHERE id='legacy-unknown-watchdog'").get()?.status).toBe('unknown');
  });
});
