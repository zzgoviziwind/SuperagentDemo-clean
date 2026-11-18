export const eventStates = {
  triage: "待研判",
  active: "处理中",
  review: "待人工处理",
  attention: "需关注",
  completed: "已完成",
  closed: "已关闭",
};
export type EventState = keyof typeof eventStates;
export const topologyNames = {
  filter: '两级过滤',
  router: '路由分派',
  worker: '事件执行',
  execution: '执行环境',
  delivery: '多信道交互',
  session_db: '会话存储',
} as const;
type TopologyStage = keyof typeof topologyNames;
export const eventBuckets = {
  triage: { label: '待研判', states: ['triage'], stages: ['filter'] },
  active: { label: '处理中', states: ['active'], stages: ['router', 'worker'] },
  needs_action: { label: '待处理', states: ['review', 'attention'], stages: ['worker', 'delivery'] },
  finished: { label: '已结束', states: ['completed', 'closed'], stages: ['session_db'] },
} as const satisfies Record<string, { label: string; states: readonly EventState[]; stages: readonly TopologyStage[] }>;
export type EventBucket = keyof typeof eventBuckets;
export type EventScope = { status: EventBucket | ""; project: string };
export const eventBucketStage = (key: EventBucket) => eventBuckets[key].stages.map(stage => topologyNames[stage]).join(' / ');
