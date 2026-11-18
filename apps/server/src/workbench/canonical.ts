import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Fields } from './store.ts';
import { fail, fields } from './store.ts';

function requestIdentity(request: FastifyRequest) {
  const headers: Record<string, string> = {};
  for (const name of ['host', 'origin', 'authorization', 'cookie']) {
    const value = request.headers[name];
    if (typeof value === 'string') headers[name] = value;
  }
  return { headers, remoteAddress: request.ip };
}

/** Reuse canonical control handlers and their execution fences without a network hop. */
export async function callCanonical(
  app: FastifyInstance, request: FastifyRequest, pattern: string, url: string, payload: Fields,
): Promise<Fields> {
  if (!app.hasRoute({ method: 'POST', url: pattern })) fail(409, '当前运行模块未接入此操作');
  const response = await app.inject({ method: 'POST', url, payload, ...requestIdentity(request) });
  const body = fields(response.json());
  if (response.statusCode >= 400) {
    const status = response.statusCode < 500 ? response.statusCode : 409;
    fail(status, typeof body.detail === 'string' && response.statusCode < 500 ? body.detail : '操作结果未确认');
  }
  return body;
}
