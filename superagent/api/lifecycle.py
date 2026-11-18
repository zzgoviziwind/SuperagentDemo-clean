"""Read-only architecture and event evidence endpoints."""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select, func
from superagent.api.connections import require_admin
from superagent.core.db import Session, Event, Task, Project, Artifact, dump
from superagent.core.ingestion import TaskRoute
from superagent.core.subscriptions import WorkerSubscription, EventTarget
from superagent.core.semantic_routing import SemanticRoutingJob
from superagent.core.delivery import ReplyDraft, DeliveryRecord
from superagent.core.watchdog import WatchdogRun

router = APIRouter(prefix="/api/v1", dependencies=[Depends(require_admin)])

@router.get("/architecture")
def architecture():
    with Session() as session:
        return {"stages": [{"stage": name, "capability": capability} for name, capability in [
            ("trigger", "事件持久接收"), ("fast_filter", "确定性身份、项目和请求规则"),
            ("slow_filter", "可配置 Codex 结构化判定与持久队列"), ("subscription", "多对多线程订阅及历史引用匹配"),
            ("router", "订阅 FastPath 与模型 SlowPath，确定性权限及版本校验后应用"), ("worker", "任务调度"),
            ("delivery", "草稿与审批"), ("session_db", "任务、事件与会话持久化"), ("execution", "本机 Codex 与共享卷 daemon 执行"), ("watchdog", "独立模型巡检、持久会话与证据、版本校验控制及人工纠正")]],
            "counts": {"events": session.scalar(select(func.count()).select_from(Event).where(Event.source.in_(["dingtalk", "redmine"]), Event.external_id.is_not(None))),
                       "subscriptions": session.scalar(select(func.count()).select_from(TaskRoute)) + session.scalar(select(func.count()).select_from(WorkerSubscription).where(WorkerSubscription.enabled == True))},
            "subscription_scope": "显式多对多线程订阅与历史单任务引用兼容", "router_note": "语义路由默认关闭；启用后模型判定经权限与版本校验应用；对话 Router 独立配置"}

@router.get("/subscriptions")
def subscriptions():
    with Session() as session:
        rows = session.execute(select(TaskRoute, Task, Project)
                               .outerjoin(Task, Task.id == TaskRoute.task_id)
                               .outerjoin(Project, Project.id == TaskRoute.project_id)
                               .order_by(TaskRoute.id)).all()
        explicit = session.execute(select(WorkerSubscription, Task, Project)
            .outerjoin(Task, Task.id == WorkerSubscription.task_id)
            .outerjoin(Project, Project.id == WorkerSubscription.project_id)
            .order_by(WorkerSubscription.id)).all()
        def reference_kind(key):
            if key.startswith("issue:"):
                return "issue"
            if key.startswith("dingtalk:message:"):
                return "dingtalk_message"
            if key.startswith("redmine:message:"):
                return "redmine_message"
            return "unknown"
        return {"items": [{**dump(route), "task_title": task.title if task else None,
                           "task_status": task.status if task else None,
                           "project_name": project.name if project else None,
                           "reference_kind": reference_kind(route.route_key)}
                          for route, task, project in rows] + [
                              {**dump(route), 'subscription_type': 'explicit',
                               'route_key': route.thread_id, 'reference_kind': 'thread',
                               'task_title': task.title if task else None,
                               'task_status': task.status if task else None,
                               'project_name': project.name if project else None}
                              for route, task, project in explicit],
                "scope": "显式多对多线程订阅与历史单任务引用兼容"}

@router.get("/events/{event_id}/trace")
def trace(event_id: int):
    with Session() as session:
        event = session.get(Event, event_id)
        if not event:
            raise HTTPException(404, "事件不存在")
        task = session.get(Task, event.task_id) if event.task_id else None
        routes = list(session.scalars(select(TaskRoute).where(TaskRoute.task_id == event.task_id))) if event.task_id else []
        drafts = list(session.scalars(select(ReplyDraft).where(ReplyDraft.event_id == event.id)))
        deliveries = []
        for draft in drafts:
            record = session.get(DeliveryRecord, f"reply-{draft.approval_id}")
            deliveries.append({"draft": dump(draft), "record": dump(record) if record else None})
        targets = list(session.scalars(select(EventTarget).where(EventTarget.event_id == event.id)))
        target_subscriptions = [dump(row) for target in targets if target.subscription_id
                                and (row := session.get(WorkerSubscription, target.subscription_id))]
        semantic = session.get(SemanticRoutingJob, event.id)
        attempts = event.data.get("_lifecycle", [])
        # These are current task-level observations, not proof that this particular
        # source message caused every later execution or recovery event.
        task_events = list(session.scalars(select(Event).where(
            Event.task_id == event.task_id, Event.id != event.id,
            ((Event.source == "runtime") | (Event.event_type.in_([
                "control", "execution_reconciled", "approval_response_unknown",
                "steer_unconfirmed", "delivery.reconciled", "watchdog_review", "watchdog_correction"])))
        ).order_by(Event.id.desc()).limit(101))) if task else []
        truncated = len(task_events) > 100
        task_events = list(reversed(task_events[:100]))
        def summary(row):
            return {"id": row.id, "source": row.source, "event_type": row.event_type,
                    "created_at": row.created_at, "content": row.content[:500], "data": row.data}
        watchdog_types = {"execution_reconciled", "disconnected", "protocol_error", "run_error",
                          "unscoped_runtime_event", "external_interrupt_failed", "steer_unconfirmed",
                          "approval_response_unknown", "delivery.reconciled", "watchdog_review", "watchdog_correction"}
        watchdog_events = [summary(row) for row in task_events if row.event_type in watchdog_types]
        artifacts = list(session.scalars(select(Artifact).where(Artifact.task_id == task.id)
                                       .order_by(Artifact.id.desc()).limit(100))) if task else []
        execution = {"state": task.status if task else None,
                     "thread_id": task.codex_thread_id if task else None,
                     "turn_id": task.codex_turn_id if task else None,
                     "workspace": task.workspace_path if task else None,
                     "events": [summary(row) for row in task_events], "events_truncated": truncated,
                     "artifacts": [{"id": row.id, "kind": row.kind, "revision": row.revision,
                                    "created_at": row.created_at} for row in reversed(artifacts)],
                     "scope": "当前关联任务的事件，不能证明均由此来源事件触发"}
        live_stages = {
            "worker": {"state": task.status if task else "unlinked", "evidence_event_ids": [row.id for row in task_events if row.source == "runtime"]},
            "delivery": {"draft_count": len(deliveries), "record_count": sum(item["record"] is not None for item in deliveries)},
            "watchdog": {"outcome_unknown": task.outcome_unknown if task else None,
                         "last_error": task.last_error if task else None, "events": watchdog_events,
                         "runs": _watchdog_runs(session, task.id) if task else [],
                         "note": "当前任务的巡检与恢复观察，包含其他来源事件相关记录"}}
        target_observations = []
        for target in targets:
            target_task = session.get(Task, target.task_id)
            if not target_task:
                continue
            observed = list(session.scalars(select(Event).where(Event.task_id == target.task_id,
                Event.source == 'runtime').order_by(Event.id.desc()).limit(100)))
            target_observations.append({
                'task_id': target.task_id, 'message_event_id': target.message_event_id,
                'execution': {'state': target_task.status, 'thread_id': target_task.codex_thread_id,
                              'turn_id': target_task.codex_turn_id, 'workspace': target_task.workspace_path,
                              'events': [summary(row) for row in reversed(observed)]},
                'watchdog': {'outcome_unknown': target_task.outcome_unknown,
                             'last_error': target_task.last_error, 'runs': _watchdog_runs(session, target.task_id)},
                'scope': '当前目标任务观察，包含其他来源事件相关记录'})
        if target_observations and task is None:
            live_stages['worker']['state'] = 'fanout'
            live_stages['worker']['target_task_ids'] = [row['task_id'] for row in target_observations]
            execution['scope'] = '多个目标的当前执行状态见 target_observations'
        worker_ids = set(row.task_id for row in targets)
        if event.task_id:
            worker_ids.add(event.task_id)
        from superagent.core.lifecycle import source_context, architecture_flow
        related_ids = set(session.scalars(select(EventTarget.event_id).where(EventTarget.task_id.in_(worker_ids)))) if worker_ids else set()
        related = list(session.scalars(select(Event).where((Event.id.in_(related_ids)) | ((Event.task_id.in_(worker_ids)) & Event.external_id.is_not(None))).order_by(Event.id))) if worker_ids else []
        return {"source_context": source_context(event), "architecture_flow": architecture_flow(attempts),
                "related_events": [{"id": row.id, "task_id": row.task_id, **source_context(row)} for row in related],
                "router_lifecycle": {"event": "每个需模型判定的事件独立线程，人工复核续用原线程", "project": "项目讨论持久线程；不会自动定期开新或压缩；压缩以真实 Codex 记录为准"},
                "routing_session_id": f'semantic:{event.id}' if semantic else None,
                "routing_mode": 'agent' if semantic and semantic.turn_id else 'pending' if semantic and semantic.status in {'queued', 'running'} else 'unknown' if semantic and semantic.status == 'unknown' else 'rules',
                "ai_invoked": bool(semantic and semantic.turn_id),
                "worker_session_ids": [f'worker:{task_id}' for task_id in sorted(worker_ids)],
                "target_observations": target_observations, "event": dump(event), "targets": [dump(row) for row in targets], "target_tasks": [dump(t) for row in targets if (t := session.get(Task, row.task_id))], "target_subscriptions": target_subscriptions, "semantic_routing": dump(semantic) if semantic else None, "attempts": attempts, "subscriptions": [dump(r) for r in routes],
                "task": dump(task) if task else None, "deliveries": deliveries, "execution": execution,
                "live_stages": live_stages, "legacy": not bool(attempts)}


def _watchdog_runs(session, task_id):
    return [dump(row) for row in session.scalars(select(WatchdogRun).where(WatchdogRun.task_id == task_id)
            .order_by(WatchdogRun.created_at.desc()).limit(50))]
