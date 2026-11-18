import { Readable } from 'node:stream';
import { setTimeout as wait } from 'node:timers/promises';
import type { FastifyInstance } from 'fastify';
import type { Fields, Principal, Task, WorkbenchStore } from './store.ts';
import { fields, integer, principalOf } from './store.ts';

interface EventNotice extends Fields {
  id: number;
  task_id: number | null;
  event_type: string;
  created_at: string;
}

async function* notices(store: WorkbenchStore, principal: Principal, after: number, signal: AbortSignal) {
  let cursor = after;
  while (!signal.aborted) {
    let sent = false;
    if (principal.role === 'admin' || principal.role === 'member') {
      const visible = principal.role === 'member'
        ? new Set(store.rows<Task>('tasks').filter(task => store.allowedWorker(task, principal)).map(task => task.id))
        : undefined;
      let rows: EventNotice[];
      do {
        rows = store.db.prepare(`SELECT id, task_id, event_type, created_at FROM events
          WHERE id > ? ORDER BY id LIMIT 100`).all(cursor) as EventNotice[];
        for (const row of rows) {
          if (signal.aborted) return;
          cursor = row.id;
          if (visible && (row.task_id === null || !visible.has(row.task_id))) continue;
          sent = true;
          yield `id: ${row.id}\ndata: ${JSON.stringify(row)}\n\n`;
        }
      } while (!signal.aborted && rows.length === 100);
    }
    if (!sent) yield ': heartbeat\n\n';
    try {
      await wait(2000, undefined, { signal });
    } catch (error) {
      if (signal.aborted) return;
      throw error;
    }
  }
}

export function registerEventStream(app: FastifyInstance, store: WorkbenchStore): void {
  app.get('/api/v1/events/stream', (request, reply) => {
    const principal = principalOf(request);
    const after = Math.max(0, integer(fields(request.query).after ?? request.headers['last-event-id'] ?? 0, 'after'));
    const lifetime = new AbortController();
    const stop = () => lifetime.abort();
    // Reconnect through authentication periodically so a long-lived client cannot retain an expired session.
    const expiration = setTimeout(stop, 30_000).unref();
    const stream = Readable.from(notices(store, principal, after, lifetime.signal));
    reply.raw.once('close', stop);
    stream.once('close', () => {
      stop();
      reply.raw.off('close', stop);
      clearTimeout(expiration);
    });
    return reply.type('text/event-stream; charset=utf-8').header('Cache-Control', 'no-store')
      .header('X-Accel-Buffering', 'no').send(stream);
  });
}
