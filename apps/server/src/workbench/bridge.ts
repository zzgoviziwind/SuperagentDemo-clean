import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { callCanonical } from './canonical.ts';
import { postSessionMessage } from './session-writes.ts';
import { displayJson, listSessions, sessionDetail } from './sessions.ts';
import type { Fields, Principal, WorkbenchStore } from './store.ts';
import { fail, fields, integer, now, principalOf } from './store.ts';

const root = '/api/v1/conversation-providers';
const names = ['list', 'create', 'continue', 'read', 'control'];

function capabilities() {
  const exterior = { external_project_id: null, external_conversation_id: null, external_url: null };
  return { items: [
    { id: 'codex_local', status: 'available', source_application: 'codex', capabilities: names,
      session_id_format: 'worker:{task_id}|router:{project_id}', ...exterior,
      execution_readiness: '执行前仍需配置并验证本机 Codex 运行时' },
    { id: 'chatgpt_project', status: 'blocked', source_application: 'chatgpt', capabilities: [], ...exterior,
      reason: '当前无指定 ChatGPT 项目并自动同步历史的接入',
      documentation_url: 'https://developers.openai.com/api/reference/resources/conversations/methods/create' },
    { id: 'chatgpt_mcp_bridge', status: 'requires_client_connection', source_application: 'chatgpt',
      transports: ['streamable_http'], mcp_endpoint: root + '/mcp', authentication: 'platform_bearer',
      web_installation_status: 'requires_https_and_oauth', capabilities: names, automatic_history_sync: false,
      reason: '本地客户端可通过 Bearer HTTP 连接。ChatGPT Web 需要 HTTPS 与 OAuth。',
      documentation_url: 'https://learn.chatgpt.com/docs/extend/mcp' },
  ] };
}

function bearer(request: FastifyRequest): Principal {
  const principal = principalOf(request);
  if (principal.authentication !== 'bearer' || !request.headers.authorization?.startsWith('Bearer ')) {
    fail(401, '桥接需要配置平台 Bearer 访问令牌');
  }
  return principal;
}

function read(store: WorkbenchStore, principal: Principal, id: string, input: Fields) {
  const after = integer(input.after ?? 0, 'after');
  const limit = integer(input.limit ?? 100, 'limit');
  if (after < 0 || limit < 1 || limit > 200) fail(422, '游标或分页大小无效');
  const detail = sessionDetail(store, id, principal);
  const snapshot = createHash('sha256').update(displayJson(detail.messages, true)).digest('hex');
  const messages = detail.messages.slice(after, after + limit);
  return { session: detail.session, messages, snapshot, next_after: after + messages.length,
    has_more: after + messages.length < detail.messages.length };
}

function receipt(store: WorkbenchStore, principal: Principal, key: string) {
  const operation = store.rows('conversation_bridge_operations', 'WHERE actor_id=? AND request_key=?',
    principal.user_id, key)[0];
  if (!operation) fail(404, '操作不存在');
  const id = fields(operation.result).session_id;
  if (typeof id === 'string') sessionDetail(store, id, principal);
  return operation;
}

const operationSchema = z.strictObject({
  request_key: z.string().min(1).max(128).regex(/^[A-Za-z0-9_.-]+$/),
  action: z.enum(['create', 'message', 'control']),
  session_id: z.string().nullable().default(null),
  project_id: z.int().positive().nullable().default(null),
  title: z.string().min(1).max(300).nullable().default(null),
  content: z.string().min(1).max(20000).nullable().default(null),
  kind: z.enum(['analysis', 'repair', 'reply']).default('analysis'),
  change_goal: z.boolean().default(false),
  expected_state_version: z.int().positive().nullable().default(null),
  control: z.enum(['start', 'pause', 'resume', 'cancel', 'retry']).nullable().default(null),
});

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(fields(value)[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

async function operation(app: FastifyInstance, store: WorkbenchStore, request: FastifyRequest, principal: Principal,
  input: unknown) {
  const parsed = operationSchema.safeParse(input);
  if (!parsed.success) fail(422, '桥接操作字段无效');
  const body = parsed.data;
  let workerId: number | undefined;
  if (body.action === 'create') {
    if (principal.role === 'viewer') fail(403, '当前身份无权创建任务');
    if (!body.project_id || !body.title?.trim() || !body.content?.trim()) fail(422, '创建会话需要项目、标题及内容');
  } else {
    if (!body.session_id || body.expected_state_version === null
      || (body.action === 'message' && !body.content?.trim()) || (body.action === 'control' && !body.control)) {
      fail(422, '消息与控制需要会话、当前版本及操作内容');
    }
    const { session } = sessionDetail(store, body.session_id, principal);
    if (body.action === 'control' && (session.kind !== 'worker' || typeof session.task_id !== 'number')) {
      fail(422, '任务控制仅适用于 Worker 会话');
    }
    if (typeof session.task_id === 'number') workerId = session.task_id;
  }
  const hash = createHash('sha256').update(canonicalJson(body)).digest('hex');
  const attempt = store.write(() => {
    const previous = store.rows('conversation_bridge_operations', 'WHERE actor_id=? AND request_key=?',
      principal.user_id, body.request_key)[0];
    if (previous) {
      if (previous.payload_hash !== hash) fail(409, '幂等键已用于不同内容');
      if (previous.status !== 'completed') fail(409, '操作进行中或结果未知，请读取回执核验，禁止自动重放');
      const result = fields(previous.result);
      if (typeof result.session_id !== 'string') fail(409, '原操作回执不完整，请核验');
      sessionDetail(store, result.session_id, principal);
      return { result } as const;
    }
    const time = now();
    const { lastInsertRowid } = store.db.prepare(`INSERT INTO conversation_bridge_operations
      (actor_id,request_key,payload_hash,status,created_at,updated_at) VALUES (?,?,?,'pending',?,?)`)
      .run(principal.user_id, body.request_key, hash, time, time);
    return { operationId: lastInsertRowid } as const;
  });
  if (attempt.result) return { ...attempt.result, duplicate: true };
  try {
    const result = body.action === 'create'
      ? await callCanonical(app, request, '/api/v1/tasks', '/api/v1/tasks',
        { project_id: body.project_id, title: body.title, goal: body.content, kind: body.kind })
      : body.action === 'message'
        ? await postSessionMessage(app, store, request, body.session_id!,
          { content: body.content, change_goal: body.change_goal, expected_state_version: body.expected_state_version })
        : await callCanonical(app, request, '/api/v1/tasks/:id/controls', `/api/v1/tasks/${workerId}/controls`,
          { action: body.control, expected_state_version: body.expected_state_version });
    const saved = { session_id: body.action === 'create' ? `worker:${result.id}` : body.session_id, result };
    if (typeof saved.session_id !== 'string') fail(409, '未能确认已执行操作的会话');
    sessionDetail(store, saved.session_id, principal);
    store.db.prepare(`UPDATE conversation_bridge_operations SET status='completed',result=?,updated_at=?
      WHERE id=? AND status='pending'`).run(JSON.stringify(saved), now(), attempt.operationId);
    return { ...saved, duplicate: false };
  } catch (error) {
    store.db.prepare(`UPDATE conversation_bridge_operations SET status='unknown',last_error=?,updated_at=?
      WHERE id=? AND status='pending'`).run('执行未完整确认，请核验会话与任务状态', now(), attempt.operationId);
    throw error;
  }
}

const recordSchema = (properties: Fields, required: string[] = []) =>
  ({ type: 'object', properties, required, additionalProperties: false });
const tool = (name: string, description: string, inputSchema: unknown, readOnlyHint = true) => ({
  name, description, inputSchema,
  annotations: { readOnlyHint, destructiveHint: !readOnlyHint, idempotentHint: true, openWorldHint: false },
});
const tools = [
  tool('superagent_status', '读取已认证平台的会话能力。', recordSchema({})),
  tool('superagent_sessions', '列出当前可访问的会话。', recordSchema({ project_id: { type: 'integer', minimum: 1 } })),
  tool('superagent_read', '读取会话历史。快照变化后从零开始重新读取。', recordSchema({
    session_id: { type: 'string' }, after: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 200 },
  }, ['session_id'])),
  tool('superagent_operation', '创建 Worker、发言或控制任务。先读取版本并保留请求键。',
    z.toJSONSchema(operationSchema, { io: 'input' }), false),
  tool('superagent_receipt', '用原请求键读取当前身份的持久回执。',
    recordSchema({ request_key: { type: 'string', minLength: 1, maxLength: 128 } }, ['request_key'])),
];
const protocolVersions = ['2024-11-05', '2025-03-26', '2025-06-18'];
const toolArguments = {
  superagent_status: z.strictObject({}),
  superagent_sessions: z.strictObject({ project_id: z.int().positive().optional() }),
  superagent_read: z.strictObject({ session_id: z.string(), after: z.int().nonnegative().optional(),
    limit: z.int().min(1).max(200).optional() }),
  superagent_receipt: z.strictObject({ request_key: z.string().min(1).max(128) }),
  superagent_operation: operationSchema,
};

export function registerBridge(app: FastifyInstance, store: WorkbenchStore): void {
  const status = (principal: Principal) => ({ ...capabilities(), authenticated: true, principal });
  const list = (principal: Principal, args: Fields) =>
    listSessions(store, principal, args.project_id === undefined ? undefined : integer(args.project_id, 'project_id'));
  app.get(root, request => { principalOf(request); return capabilities(); });
  app.get(root + '/bridge/status', request => status(bearer(request)));
  app.get(root + '/bridge/sessions', request => list(bearer(request), fields(request.query)));
  app.get<{ Params: { id: string } }>(root + '/bridge/sessions/:id', request =>
    read(store, bearer(request), request.params.id, fields(request.query)));
  app.get<{ Params: { key: string } }>(root + '/bridge/operations/:key', request => receipt(store, bearer(request), request.params.key));
  app.post(root + '/bridge/operations', request => operation(app, store, request, bearer(request), request.body));
  app.route({ method: ['GET', 'DELETE'], url: root + '/mcp', handler(request, reply) {
    bearer(request);
    return reply.header('allow', 'POST').code(405).send();
  } });
  app.post(root + '/mcp', { bodyLimit: 1_000_000, errorHandler(error, _request, reply) {
    if (error.code === 'FST_ERR_CTP_INVALID_JSON_BODY' || (error instanceof SyntaxError && error.statusCode === 400)) {
      return reply.code(200).send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON 解析失败' } });
    }
    return reply.send(error);
  } }, async (request, reply) => {
    const principal = bearer(request);
    const protocol = request.headers['mcp-protocol-version'];
    if (protocol !== undefined && !protocolVersions.includes(String(protocol))) fail(400, 'MCP 协议版本不支持');
    const body = fields(request.body);
    const frame = { jsonrpc: '2.0', id: body.id ?? null };
    const error = (code: number, message: string) => ({ ...frame, error: { code, message } });
    if (body.jsonrpc !== '2.0') return error(-32600, '无效 JSON-RPC 请求');
    if (!Object.hasOwn(body, 'id')) return body.method === 'tools/call'
      ? error(-32600, '无效 JSON-RPC 请求') : reply.code(202).send();
    const params = fields(body.params);
    if (body.params !== undefined && params !== body.params) return error(-32602, '参数必须为对象');
    if (body.method === 'initialize') {
      return { ...frame, result: { protocolVersion: protocolVersions.includes(String(params.protocolVersion))
        ? params.protocolVersion : '2025-06-18', capabilities: { tools: {} },
        serverInfo: { name: 'superagent-local-bridge', version: '1.0.0' },
        instructions: '先读取会话版本。写操作保留请求键，超时后先查询回执。' } };
    }
    if (body.method === 'ping') return { ...frame, result: {} };
    if (body.method === 'tools/list') return { ...frame, result: { tools } };
    if (body.method !== 'tools/call') return error(-32601, '方法不存在');
    try {
      const name = params.name;
      if (typeof name !== 'string' || !Object.hasOwn(toolArguments, name)) fail(422, '工具不存在');
      const args = toolArguments[name as keyof typeof toolArguments].parse(params.arguments ?? {});
      let value;
      switch (name) {
        case 'superagent_status': value = status(principal); break;
        case 'superagent_sessions': value = list(principal, args); break;
        case 'superagent_read': value = read(store, principal, String(fields(args).session_id), args); break;
        case 'superagent_receipt': value = receipt(store, principal, String(fields(args).request_key)); break;
        case 'superagent_operation': value = await operation(app, store, request, principal, args); break;
        default: throw new Error('Unknown tool');
      }
      return { ...frame, result: { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false } };
    } catch (error) {
      const raw = fields(error).statusCode;
      const status = typeof raw === 'number' && raw >= 400 && raw < 500 ? raw : 422;
      return { ...frame, result: { content: [{ type: 'text', text: `工具调用未确认（${status}），请检查参数、权限与操作回执。` }],
        isError: true } };
    }
  });
}
