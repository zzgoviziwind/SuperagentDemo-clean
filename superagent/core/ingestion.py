"""Durable event receipt and deterministic, fail-closed task routing."""

import re

from sqlalchemy import Integer, JSON, String, UniqueConstraint, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Mapped, mapped_column
from superagent.connectors.common import digest

from .db import Approval, Base, Event, Project, Session, Task, dump, now


class TaskRoute(Base):
    __tablename__ = "task_routes"
    __table_args__ = (UniqueConstraint("project_id", "route_key"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(Integer)
    route_key: Mapped[str] = mapped_column(String(255))
    task_id: Mapped[int] = mapped_column(Integer)


class EventAttachmentJob(Base):
    __tablename__ = "event_attachment_jobs"
    event_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    task_id: Mapped[int] = mapped_column(Integer, index=True)
    revision: Mapped[int] = mapped_column(Integer)
    control_version: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(32), default="pending")
    results: Mapped[list] = mapped_column(JSON, default=list)


def trusted_actor(source, actor_id):
    from .governance import resolve_actor
    return resolve_actor(source, actor_id)


def _pending(event, reason):
    event.data = {**event.data, "routing_status": "pending_confirmation", "routing_reason": reason}


def _message_key(data, message_id):
    return "dingtalk:message:" + digest({"profile": data.get("metadata", {}).get("profile", ""),
                                         "conversation": data.get("thread_id") or data.get("project_external_id"),
                                         "message_id": message_id})


def _requested_kind(content):
    readonly = re.compile(
        r"仅(?:做)?分析|只(?:做)?分析|只读|分析即可|"
        r"(?:不要|不允许|禁止|不)(?:修改|改动|改写|调整)"
        r"(?:(?:任何)?(?:代码|文件)|(?=[，。,；;\s]|$))",
        re.I,
    )
    analysis = bool(readonly.search(content))
    write = bool(re.search(r"修复|修改|改动|改写|实现|新增|优化|调整|增加功能|\b(fix|implement|modify)\b", readonly.sub("", content), re.I))
    if analysis and write:
        return "conflict"
    if analysis:
        return "analysis"
    return "repair" if write else None


def ingest_event(payload, *, session_factory=None, actor_resolver=None, settings=None):
    """Acknowledge only after commit. A duplicate returns the original receipt."""
    factory = session_factory or Session
    resolver = actor_resolver or trusted_actor
    source = payload.get("source")
    external_id = payload.get("external_id")
    if source not in {"dingtalk", "redmine"} or not isinstance(external_id, str) or not external_id or len(external_id) > 255:
        raise ValueError("事件来源或外部标识无效")
    if not isinstance(payload.get("content", ""), str):
        raise ValueError("事件内容必须为文本")
    if not isinstance(payload.get("metadata", {}), dict):
        raise ValueError("事件元数据必须为对象")
    if not isinstance(payload.get("attachments", []), list):
        raise ValueError("事件附件必须为列表")
    # A concurrent duplicate/route insertion rolls back the entire receipt and task.
    for attempt in range(3):
        try:
            with factory.begin() as session:
                existing = session.scalar(select(Event).where(Event.source == source, Event.external_id == external_id))
                if existing:
                    return {**dump(existing), "duplicate": True}
                event = Event(source=source, external_id=external_id,
                              event_type=str(payload.get("event_type", "unknown")),
                              content=payload.get("content", ""), data=dict(payload))
                session.add(event)
                session.flush()
                _route(session, event, resolver, settings=settings)
                session.flush()
                return {**dump(event), "duplicate": False}
        except IntegrityError:
            if attempt == 2:
                raise


def _route(session, event, resolver, *, settings=None):
    data = event.data
    actor = resolver(event.source, str(data.get("actor_id", "")))
    if not actor or not actor.get("enabled", True):
        return _pending(event, "actor_unmapped_or_disabled")
    external = str(data.get("project_external_id") or "")
    field = "dingtalk_chat_ids" if event.source == "dingtalk" else "redmine_project_ids"
    projects = [p for p in session.scalars(select(Project).with_for_update())
                if external and external in {str(value) for value in getattr(p, field)}]
    if len(projects) != 1 or not projects[0].enabled:
        return _pending(event, "project_binding_missing_ambiguous_or_disabled")
    project = projects[0]
    allowed = {str(value) for value in actor.get("project_ids", [])}
    if (actor.get("role") not in {"admin", "member"} or str(project.id) not in allowed
            or "request" not in actor.get("permissions", [])):
        return _pending(event, "actor_not_authorized_for_project")
    from .delivery import recognize_redmine_echo
    if recognize_redmine_echo(session, event, settings=settings):
        return
    metadata = data.get("metadata") or {}
    expected_types = {"dingtalk": {"message.received"}, "redmine": {"issue.updated", "issue.comment", "issue.changed"}}
    if event.event_type not in expected_types[event.source]:
        return _pending(event, "unsupported_event_type")
    if metadata.get("needs_confirmation") or metadata.get("uncertain_mentions") or not event.content.strip():
        return _pending(event, "ambiguous_or_empty_request")
    if event.source == "dingtalk" and not re.search(r"请|帮我|修复|实现|检查|分析|排查|调整|新增|继续|增加|优化|完成|\b(fix|implement|please|investigate|add)\b", event.content, re.I):
        return _pending(event, "explicit_request_required")
    requested_kind = _requested_kind(event.content)
    if requested_kind == "conflict":
        return _pending(event, "conflicting_analysis_and_write_request")
    issues = set(re.findall(r"(?<![\w])#(\d+)\b", event.content))
    if data.get("issue_id"):
        issues.add(str(data["issue_id"]))
    if len(issues) > 1 or any(not value.isdigit() for value in issues):
        return _pending(event, "ambiguous_issue_reference")
    issue_key = "issue:" + next(iter(issues)) if issues else None
    own_key = (_message_key(data, metadata.get("message_id") or event.external_id) if event.source == "dingtalk"
               else "redmine:message:" + digest(event.external_id))
    reply = metadata.get("reply_to_message_id") if event.source == "dingtalk" else None
    if reply is not None and (not isinstance(reply, str) or not reply.strip() or reply == metadata.get("message_id")):
        return _pending(event, "invalid_reply_reference")
    reply_key = _message_key(data, reply) if reply else None
    key = issue_key or reply_key or own_key
    keys = {value for value in (issue_key, own_key, reply_key) if value}
    if any(len(value) > 255 for value in keys):
        return _pending(event, "reference_too_long")
    routes = {route.route_key: route for route in session.scalars(select(TaskRoute).where(
              TaskRoute.project_id == project.id, TaskRoute.route_key.in_(keys)).with_for_update())}
    candidates = {route.task_id for route in routes.values()}
    if reply_key and reply_key not in routes:
        # Databases created before message aliases still retain the exact source receipt.
        previous_ids = set(session.scalars(select(Event.task_id).join(Task, Task.id == Event.task_id).where(
            Task.project_id == project.id, Event.source == "dingtalk", Event.data["routing_status"].as_string() == "routed",
            Event.data["thread_id"].as_string() == data.get("thread_id"),
            Event.data["metadata"]["profile"].as_string() == metadata.get("profile", ""),
            Event.data["metadata"]["message_id"].as_string() == reply)))
        if len(previous_ids) != 1:
            return _pending(event, "reply_target_missing_or_ambiguous")
        candidates.update(previous_ids)
    # A terminal message reference follows its latest associated task.
    resolved = set()
    for task_id in candidates:
        target = session.get(Task, task_id)
        if target and target.status in {"completed", "cancelled"} and target.source_ref:
            latest = session.scalar(select(TaskRoute).where(TaskRoute.project_id == project.id, TaskRoute.route_key == target.source_ref))
            task_id = latest.task_id if latest else task_id
        resolved.add(task_id)
    if len(resolved) > 1:
        return _pending(event, "conflicting_task_references")
    task = session.get(Task, next(iter(resolved))) if resolved else None
    if task and issue_key:
        bound_issues = set(session.scalars(select(TaskRoute.route_key).where(TaskRoute.project_id == project.id,
                                          TaskRoute.task_id == task.id, TaskRoute.route_key.like("issue:%"))))
        if bound_issues - {issue_key}:
            return _pending(event, "conflicting_issue_reference")
    if task and reply and not issue_key and task.source_ref:
        key = task.source_ref
        keys.add(key)
    from .governance import TaskOwner, task_owner
    if task and actor.get("role") != "admin":
        if task_owner(task.id, session) != actor.get("user_id"):
            return _pending(event, "task_owned_by_another_user")
    previous = task.id if task and task.status in {"completed", "cancelled"} else None
    requires_interrupt = bool(task and task.status in {"running", "waiting_approval"})
    if task is None or previous:
        task = Task(project_id=project.id, title=event.content.strip().splitlines()[0][:300],
                    goal=event.content, source=event.source, source_ref=key, status="queued", owner_id=actor["user_id"],
                    kind=requested_kind or "repair")
        session.add(task)
        session.flush()
        session.add(TaskOwner(task_id=task.id, user_id=actor["user_id"]))
    else:
        version = task.state_version
        values = dict(state_version=version + 1, updated_at=now(), revision=task.revision + 1,
                      control_version=task.control_version + 1, source_ref=issue_key or task.source_ref,
                      kind=requested_kind or task.kind)
        if task.status in {"running", "review_ready", "waiting_approval"}:
            values.update(status="waiting_input", last_error="收到新需求，已使旧版本结果与审批失效，请确认后继续")
        result = session.execute(update(Task).where(Task.id == task.id, Task.state_version == version)
                                 .values(**values))
        if result.rowcount != 1:
            raise IntegrityError("task_version_conflict", {}, None)
        # Scheduler reads canonical message events when preparing the next turn.
        event.event_type = "message"
        session.execute(update(Approval).where(Approval.task_id == task.id, Approval.status == "pending").values(status="expired"))
    for alias in keys:
        route = routes.get(alias) or session.scalar(select(TaskRoute).where(TaskRoute.project_id == project.id, TaskRoute.route_key == alias))
        if route:
            route.task_id = task.id
        else:
            session.add(TaskRoute(project_id=project.id, route_key=alias, task_id=task.id))
    event.task_id = task.id
    data = {key: value for key, value in data.items() if key != "routing_reason"}
    event.data = {**data, "routing_status": "routed", "original_event_type": data.get("event_type"), "actor": actor.get("user_id"),
                  "related_task_id": previous, "requires_interrupt": requires_interrupt}
    if data.get("attachments"):
        session.flush()
        session.refresh(task)
        session.add(EventAttachmentJob(event_id=event.id, task_id=task.id, revision=task.revision,
                                       control_version=task.control_version))
        event.data = {**event.data, "attachments_status": "pending"}
        if task.status == "queued":
            task.status = "waiting_resource"
            task.last_error = "正在准备来源附件"


def list_inbox(*, routing_status="pending_confirmation", after=0, limit=50, session_factory=None):
    if routing_status not in {"pending_confirmation", "routed", "self_echo", "self_echo_candidate"} or after < 0 or not 1 <= limit <= 100:
        raise ValueError("收件箱筛选或分页参数无效")
    with (session_factory or Session)() as session:
        rows = session.scalars(select(Event).where(Event.source.in_(["dingtalk", "redmine"]), Event.id > after,
                              Event.data["routing_status"].as_string() == routing_status)
                               .order_by(Event.id).limit(limit + 1)).all()
        items = [dump(event) for event in rows[:limit]]
        return {"items": items, "has_more": len(rows) > limit, "next_after": items[-1]["id"] if items else after}


def retry_routing(event_id, *, actor="admin", session_factory=None, actor_resolver=None):
    factory = session_factory or Session
    for attempt in range(3):
        try:
            with factory.begin() as session:
                # This also serializes retries under SQLite, whose FOR UPDATE is ignored.
                session.execute(update(Event).where(Event.id == event_id).values(content=Event.content))
                event = session.get(Event, event_id)
                if event is None:
                    raise ValueError("事件不存在")
                if event.data.get("routing_status") == "routed":
                    return {**dump(event), "duplicate": True}
                if event.data.get("routing_status") != "pending_confirmation":
                    raise ValueError("事件不属于待确认收件箱")
                previous_reason = event.data.get("routing_reason")
                _route(session, event, actor_resolver or trusted_actor)
                from .governance import Audit
                session.add(Audit(actor=actor, action="event.retry_routing", resource=str(event.id),
                                  details={"previous_reason": previous_reason, "routing_status": event.data["routing_status"],
                                           "routing_reason": event.data.get("routing_reason"), "task_id": event.task_id}))
                session.flush()
                return {**dump(event), "duplicate": False}
        except IntegrityError:
            if attempt == 2:
                raise


def retry_attachments(event_id, *, actor="admin", session_factory=None):
    from .governance import Audit
    with (session_factory or Session).begin() as session:
        session.execute(update(EventAttachmentJob).where(EventAttachmentJob.event_id == event_id).values(status=EventAttachmentJob.status))
        job = session.get(EventAttachmentJob, event_id)
        if job is None or job.status != "failed":
            raise ValueError("附件任务不存在或当前状态不支持重试")
        event = session.get(Event, event_id)
        task = session.get(Task, job.task_id)
        if task.status in {"running", "waiting_approval", "completed", "cancelled"}:
            raise ValueError("请先确认任务状态后重试附件")
        job.status, job.revision, job.control_version = "pending", task.revision, task.control_version
        event.data = {**event.data, "attachments_status": "pending", "attachments_error": None}
        if task.status in {"queued", "waiting_input"}:
            task.status, task.last_error = "waiting_resource", "正在准备来源附件"
            task.state_version += 1
            task.updated_at = now()
        session.add(Audit(actor=actor, action="event.retry_attachments", resource=str(event_id), details={"task_id": task.id}))
        session.flush()
        return {**dump(event), "duplicate": False}
