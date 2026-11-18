import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

const account = z.object({
  user_id: z.string().min(1).refine(value => !!value.trim()),
  token: z.string().min(1).refine(value => !!value.trim()),
  role: z.enum(['admin', 'member', 'viewer'])
});
type Account = z.infer<typeof account>;
export type Principal = Omit<Account, 'token'> & { authentication: 'local' | 'bearer' | 'session' };
declare module 'fastify' {
  interface FastifyRequest { principal: Principal }
}
export function fail(statusCode: number, message: string): never {
  throw Object.assign(new Error(message), { statusCode });
}
function equal(left: string, right: string) {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function configured(env: NodeJS.ProcessEnv) {
  let users: Account[] = [];
  if (env.SUPERAGENT_USERS_JSON !== undefined) {
    try { users = z.array(account).nonempty().parse(JSON.parse(env.SUPERAGENT_USERS_JSON)); }
    catch { fail(503, '用户身份配置无效'); }
    if (new Set(users.map(u => u.user_id)).size !== users.length ||
        new Set(users.map(u => u.token)).size !== users.length) fail(503, '用户身份配置重复');
  }
  const token = env.SUPERAGENT_API_TOKEN;
  if (token) {
    if (users.some(u => equal(token, u.token) && (u.role !== 'admin' || u.user_id !== 'admin'))) {
      fail(503, '单用户令牌与多用户身份配置冲突');
    }
    users.push({ token, role: 'admin', user_id: 'admin' });
  }
  return users;
}
const local = new Set(['localhost', '127.0.0.1', '[::1]']);
export function roleOf(env: NodeJS.ProcessEnv, userId: string) {
  const accounts = configured(env);
  return accounts.find(a=>a.user_id === userId)?.role ?? (!accounts.length && userId === 'admin' ? 'admin' : undefined);
}
function origin(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { fail(403, '请求来源无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) fail(403, '请求来源无效');
  return url;
}
function localRequest(req: FastifyRequest, env: NodeJS.ProcessEnv) {
  if (!req.headers.host || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.ip)) {
    fail(403, '服务仅允许本机访问');
  }
  const host = origin('http://' + req.headers.host);
  if (!local.has(host.hostname)) fail(403, '本地访问地址无效');
  if (req.headers.origin) {
    const supplied = origin(req.headers.origin).origin;
    const allowed = [host.origin, ...(env.SUPERAGENT_ALLOWED_ORIGINS || '').split(',').filter(Boolean).map(s => origin(s.trim()).origin)];
    if (!allowed.includes(supplied)) fail(403, '请求来源无效');
  }
}

export function registerAuth(app: FastifyInstance, env: NodeJS.ProcessEnv) {
  const secret = env.SUPERAGENT_SESSION_SECRET;
  if (secret !== undefined && Buffer.byteLength(secret) < 32) fail(503, '会话签名密钥至少需要 32 字节');
  const key = secret ?? randomBytes(32);
  const sign = (text: string) => createHmac('sha256', key).update(text).digest('hex');
  const cookieName = 'superagent_session';
  const cookie = (value: string, age: number) =>
    cookieName + '=' + value + '; HttpOnly; SameSite=Strict; Path=/api/v1; Max-Age=' + age;
  const identity = (u: Account, authentication: Principal['authentication']): Principal =>
    ({ user_id: u.user_id, role: u.role, authentication });
  const deny = () => fail(401, '需要有效的访问凭据');
  const get = (token: string, users: Account[]) => users.find(u => equal(u.token, token)) ?? deny();
  app.decorateRequest('principal');
  app.addHook('onRequest', async (req, rep) => {
    localRequest(req, env);
    const path = req.url.split('?')[0];
    if (!path.startsWith('/api/')) return;
    rep.header('Cache-Control', 'no-store');
    if (path === '/api/v1/auth/login' || path === '/api/v1/auth/logout') return;
    const users = configured(env);
    if (users.length === 0) {
      req.principal = { user_id: 'admin', role: 'admin', authentication: 'local' };
      return;
    }
    if (req.headers.authorization !== undefined) {
      if (!req.headers.authorization.startsWith('Bearer ')) deny();
      req.principal = identity(get(req.headers.authorization.slice(7), users), 'bearer');
      return;
    }
    const value = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
    const parts = (value ?? '').split('.');
    if (!value || value.length > 4096 || parts.length !== 2 || !equal(sign(parts[0]), parts[1])) deny();
    try {
      const claims = z.object({sub: z.string(), exp: z.number().int(), credential: z.string()})
        .parse(JSON.parse(Buffer.from(parts[0], 'base64url').toString()));
      if (claims.exp <= Date.now() / 1000) deny();
      const user = users.find(u => u.user_id === claims.sub && equal(claims.credential, sign(u.token)));
      req.principal = identity(user ?? deny(), 'session');
    } catch { deny(); }
  });
  app.get('/api/v1/auth/me', async req => req.principal);
  app.post('/api/v1/auth/login', async (req, reply) => {
    const {token} = z.strictObject({token:z.string().min(1).max(8192)}).parse(req.body);
    const user = get(token, configured(env));
    const claims = {sub:user.user_id, exp:Math.floor(Date.now()/1000)+3600, credential:sign(token), nonce:randomBytes(16).toString('hex')};
    const encoded = Buffer.from(JSON.stringify(claims)).toString('base64url');
    reply.header('Set-Cookie', cookie(encoded + '.' + sign(encoded), 3600));
    return identity(user, 'bearer');
  });
  app.post('/api/v1/auth/logout', async (_req, reply) => {
    reply.header('Set-Cookie', cookie('', 0));
    return { logged_out: true };
  });
}
