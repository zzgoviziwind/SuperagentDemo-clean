import type { FastifyInstance } from 'fastify';

export interface SessionBinding {
  kind: 'worker' | 'router' | 'semantic';
  id: number;
}

export interface DingTalkHistoryBinding {
  profile: string;
  peer: string;
  conversation: string;
  anchorId: string;
  since: string;
  until: string;
  selfIds: readonly string[];
  historyTimezone?: string;
  senderMap?: Readonly<Record<string, unknown>>;
}

export interface DingTalkHistoryPage {
  complete: boolean;
  conversationId: string;
  messages: readonly {
    conversationId: string;
    messageId: string;
    senderId: string;
    senderName?: string;
    occurredAt: string;
    text: string;
  }[];
}

export interface SemanticDecision {
  action: 'create' | 'dispatch' | 'ignore' | 'confirm';
  kind: 'analysis' | 'repair' | 'reply';
  task_id: number | null;
  state_version: number | null;
  reason: string;
}

export interface WorkbenchRuntime {
  readThread?(binding: SessionBinding & { threadId: string; includeTurns: true }, signal: AbortSignal): Promise<unknown>;
  readOwnDingTalk?(binding: DingTalkHistoryBinding, signal: AbortSignal): Promise<DingTalkHistoryPage>;
  wakeProjectRouter?(projectId: number): void;
  projectRouterAvailable?(): boolean;
  resolveRole?(user: string): 'admin' | 'member' | 'viewer' | undefined;
  hasStoppedSession?(binding: SessionBinding): Promise<boolean>;
  scheduleSemantic?(eventId: number | undefined, actor: string): Promise<{ checked: number; routed_event_ids: number[] }>;
  applySemanticCorrection?(eventId: number, decision: SemanticDecision, evidence: string, actor: string):
    Promise<{ newly_applied: boolean }>;
  runWatchdog?(taskId: number): Promise<string>;
  hasStoppedWatchdog?(taskId: number): Promise<boolean>;
}

export function codexThreadReader(request: (binding: SessionBinding, method: 'thread/read',
  params: { threadId: string; includeTurns: true }, signal: AbortSignal) => Promise<unknown>): NonNullable<WorkbenchRuntime['readThread']> {
  return ({ kind, id, threadId, includeTurns }, signal) =>
    request({ kind, id }, 'thread/read', { threadId, includeTurns }, signal);
}

const runtimes = new WeakMap<FastifyInstance, WorkbenchRuntime>();

export function configureWorkbenchRuntime(app: FastifyInstance, runtime: WorkbenchRuntime): void {
  runtimes.set(app, runtime);
}

export function workbenchRuntime(app: FastifyInstance): WorkbenchRuntime | undefined {
  return runtimes.get(app);
}
