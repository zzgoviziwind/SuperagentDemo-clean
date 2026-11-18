import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registerAuth } from './auth.js';

const apps: ReturnType<typeof Fastify>[] = [];
const setup = (env: NodeJS.ProcessEnv) => {
  const app = Fastify();
  apps.push(app);
  registerAuth(app, env);
  return app;
};
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
describe('browser authentication', () => {
  it('keeps local administration behind a loopback Host and same-origin browser requests', async () => {
    const app = setup({});
    expect((await app.inject('/api/v1/auth/me')).json().role).toBe('admin');
    const blocked = await app.inject({url:'/api/v1/auth/me',headers:{host:'example.invalid'}});
    expect(blocked.statusCode).toBe(403);
    expect((await app.inject({url:'/api/v1/auth/me',headers:{origin:'http://localhost:9123'}})).statusCode).toBe(403);
  });
  it('binds cookie identity to the current token and role', async () => {
    const env = {SUPERAGENT_USERS_JSON:JSON.stringify([{user_id:'reader', role:'viewer', token:'fixture'}])};
    const app = setup(env);
    expect((await app.inject('/api/v1/auth/me')).statusCode).toBe(401);
    const login = await app.inject({url:'/api/v1/auth/login',method:'POST',payload:{token:'fixture'}});
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    expect(login.headers['set-cookie']).toContain('HttpOnly');
    expect((await app.inject({url:'/api/v1/auth/me',headers:{cookie}})).json()).toEqual({user_id:'reader',role:'viewer',authentication:'session'});
    env.SUPERAGENT_USERS_JSON = JSON.stringify([{user_id:'reader', role:'viewer', token:'replacement'}]);
    expect((await app.inject({url:'/api/v1/auth/me',headers:{cookie}})).statusCode).toBe(401);
  });
  it('rejects invalid identity configuration', async () => {
    expect((await setup({SUPERAGENT_USERS_JSON:'[]'}).inject('/api/v1/auth/me')).statusCode).toBe(503);
  });
});
