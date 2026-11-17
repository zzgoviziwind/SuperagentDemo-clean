"""Durable event receipt and deterministic, fail-closed task routing."""

import re

from sqlalchemy import Integer, JSON, String, UniqueConstraint, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Mapped, mapped_column
from superagent.connectors.common import digest
from superagent.connectors.capabilities import SOURCES

from .db import Approval, Base, Event, Project, Session, Task, dump, now
from .subscriptions import EventTarget, fanout, authorized_task
from .semantic_routing import enqueue_if_enabled
from .message_policy import conversation_type, policy_allows, response_policy


QUESTION_REQUEST = re.compile(r"做好(?:了)?(?:没|吗)|完成(?:了)?(?:没|吗)|进度|进展|为什么|为何|怎么|如何|什么|哪些|哪个|多少|是否|能否|可否|是不是|行不行|有没有|要不要|能不能|可不可以|[吗么]\s*[？?]?\s*$", re.I)


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
    event._routing_evidence['blocked_reason'] = reason
    stage = "fast_filter" if reason in {"actor_unmapped_or_disabled", "project_binding_missing_ambiguous_or_disabled", "actor_not_authorized_for_project", "unsupported_event_type", "ambiguous_or_empty_request", "explicit_request_required", "conflicting_analysis_and_write_request"} else "subscription" if reason in {"ambiguous_issue_reference", "invalid_reply_reference", "reference_too_long", "reply_target_missing_or_ambiguous", "conflicting_task_references", "conflicting_issue_reference"} else "router"
    event._lifecycle_steps.append((stage, "blocked", reason, None))
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
    if write:
        return "repair"
    return "analysis" if QUESTION_REQUEST.search(content) else None


def ingest_event(payload, *, session_factory=None, actor_resolver=None, settings=None):
    """Acknowledge only after commit. A duplicate returns the original receipt."""
    factory = session_factory or Session
    resolver = actor_resolver or trusted_actor
    source = payload.get("source")
    external_id = payload.get("external_id")
    if source not in SOURCES or not isinstance(external_id, str) or not external_id or len(external_id) > 255:
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
                              content=payload.get("content", ""), data={k: v for k, v in payload.items() if k in {
                                  'source', 'external_id', 'event_type', 'actor_id', 'thread_id',
                                  'project_external_id', 'issue_id', 'content', 'occurred_at', 'attachments', 'metadata'}})
                session.add(event)
                session.flush()
                _route(session, event, resolver, settings=settings)
                session.flush()
                return {**dump(event), "duplicate": False}
        except IntegrityError:
            if attempt == 2:
                raise


def _route_impl(session, event, resolver, *, settings=None, semantic_decision=None, routing_method=None,
                project_assessment_only=False):
    data = event.data
    if event.source == 'dingtalk':
        from superagent.connectors.dingtalk import message_attachments
        attachments = message_attachments(event.content, data.get('attachments'))
        if attachments and not data.get('attachments'):
            event.data = data = {**data, 'attachments': attachments}
    evidence = event._routing_evidence = {
        'rule_set': 'ingestion-v4', 'checks': {}, 'validated_actor_user_id': None,
        'resolved_actor': None, 'effective_response_policy': None, 'policy_allowed': None,
        'conversation_type': None, 'project_candidates': None, 'project_matches': None,
        'default_project_match': None,
        'project_selection_source': None, 'selected_project_id': None,
        'authorization': {'status': 'not_evaluated'},
        'settings_provider': 'callback' if settings else 'database',
    }
    if event.source == 'dingtalk' and data.get('metadata', {}).get('self_authored') is True:
        from .message_context import attach_self_message
        attach_self_message(session, event)
        event._lifecycle_steps.append(('fast_filter', 'skipped', event.data['routing_status'], None))
        return
    from .event_triage import no_action_reason
    if reason := no_action_reason(event):
        evidence['blocked_reason'] = reason
        event.data = {**data, 'routing_status': 'ignored', 'routing_reason': reason}
        event._lifecycle_steps.append(('fast_filter', 'skipped', reason, None))
        return
    from .message_access import resolve_requester, choose_project
    actor, access, admission_error = resolve_requester(session, event, resolver, settings)
    if admission_error:
        evidence['blocked_reason'] = admission_error
        event.data = {**event.data, 'routing_status': 'ignored', 'routing_reason': admission_error}
        event._lifecycle_steps.append(('fast_filter', 'blocked', admission_error, None))
        return
    if actor:
        evidence['resolved_actor'] = {
            'user_id': actor.get('user_id'), 'role': actor.get('role'),
            'enabled': actor.get('enabled', True),
            'project_ids': list(actor.get('project_ids', [])),
            'permissions': list(actor.get('permissions', [])),
        }
    identity_allowed = bool(actor and actor.get('enabled', True))
    evidence['checks']['identity'] = {'rule': 'mapped_actor_enabled', 'allowed': identity_allowed}
    if not identity_allowed:
        return _pending(event, "actor_unmapped_or_disabled")
    evidence['validated_actor_user_id'] = actor.get('user_id')
    metadata = data.get('metadata') or {}
    policy = response_policy(session, settings) if event.source == 'dingtalk' else None
    evaluated_type = conversation_type(metadata) if event.source == 'dingtalk' else None
    evidence['conversation_type'] = evaluated_type
    direct = evaluated_type == 'direct'
    policy_allowed = policy_allows(policy, metadata, data.get('thread_id')) if policy else None
    evidence['effective_response_policy'] = dict(policy) if policy else None
    evidence['policy_allowed'] = policy_allowed
    evidence['checks']['response_policy'] = {'rule': 'dingtalk_response_scope',
        'status': 'evaluated' if policy else 'not_applicable', 'allowed': policy_allowed}
    if policy_allowed is False:
        evidence['blocked_reason'] = 'message_response_policy_off_or_scope'
        event.data = {**event.data, 'routing_status': 'ignored', 'routing_reason': 'message_response_policy_off_or_scope'}
        event._lifecycle_steps.append(('fast_filter', 'blocked', 'message_response_policy_off_or_scope', None))
        return
    external = str(data.get("project_external_id") or "")
    field = SOURCES[event.source].project_binding_field
    projects = [p for p in session.scalars(select(Project).where(Project.archived.is_(False)).with_for_update())
                if external and external in {str(value) for value in getattr(p, field)}]
    evidence['external_project_candidates'] = [{'id': p.id, 'name': p.name, 'enabled': p.enabled,
        'matched_field': field, 'matched_external_id': external} for p in projects]
    evidence['project_matches'] = evidence['external_project_candidates']
    evidence['project_selection_source'] = 'external_binding' if projects else 'none'
    evidence['default_project_fallback'] = {'attempted': False}
    if not projects and direct and policy['default_project_id'] is not None:
        fallback = session.get(Project, policy['default_project_id'])
        projects = [fallback] if fallback else []
        evidence['project_selection_source'] = 'configured_direct_default'
        evidence['default_project_fallback'] = {'attempted': True,
            'configured_project_id': policy['default_project_id'], 'found': fallback is not None}
        evidence['default_project_match'] = {'id': fallback.id, 'name': fallback.name,
            'enabled': fallback.enabled} if fallback else None
    clarification = False
    clarification_source = None
    request_content = event.content
    if access is not None and event.source == 'dingtalk':
        projects, selection = choose_project(session, event, actor, access)
        evidence['project_selection'] = selection
        evidence['project_selection_source'] = selection['method']
        if projects and selection['method'] == 'message_or_group_name':
            from .message_access import unanswered_project_question
            clarification_source = unanswered_project_question(session, event)
            if clarification_source:
                request_content = clarification_source.content + '\n用户补充项目归属\n' + event.content
                data = {**data, 'clarification_source_event_id': clarification_source.id}
                event.data = data
        if not projects and selection['method'] != 'ambiguous_names' and access.on_unmatched in {'ask', 'default'}:
            fallback = session.get(Project, access.default_project_id)
            projects = [fallback] if fallback and fallback.enabled and not fallback.archived else []
            clarification = access.on_unmatched == 'ask' and bool(projects)
            evidence['project_selection_source'] = 'clarification' if clarification else 'configured_default'
            if clarification:
                data = {**data, 'project_clarification': True,
                        'candidate_project_ids': selection.get('candidate_ids', actor.get('candidate_project_ids', []))}
                event.data = data
    evidence['project_candidates'] = [{'id': p.id, 'name': p.name, 'enabled': p.enabled} for p in projects]
    project_allowed = len(projects) == 1 and projects[0].enabled
    evidence['checks']['project_binding'] = {'rule': 'single_enabled_project', 'allowed': bool(project_allowed)}
    if not project_allowed:
        from .event_rules import blocks_processing
        if event.source == 'dingtalk' and blocks_processing(session, event, None, 'analysis'):
            return _pending(event, 'private_policy_hold')
        if (not semantic_decision and enqueue_if_enabled(session, event, None, actor, settings=settings)):
            event._lifecycle_steps.append(('fast_filter', 'passed', 'accepted_for_unassigned_project_assessment', None))
            if event.data.get('routing_status') == 'semantic_pending':
                event._lifecycle_steps.append(('slow_filter', 'pending', 'unassigned_project_assessment_queued', None))
            return
        return _pending(event, "project_binding_missing_ambiguous_or_disabled")
    if project_assessment_only:
        return _pending(event, 'project_available_for_routing_review')
    project = projects[0]
    evidence['selected_project_id'] = project.id
    allowed = {str(value) for value in actor.get("project_ids", [])}
    grant_checks = [
        {'rule': 'actor_role_admin_or_member', 'allowed': actor.get('role') in {'admin', 'member'}},
        {'rule': 'project_in_actor_grants', 'allowed': str(project.id) in allowed},
        {'rule': 'request_permission_required', 'allowed': 'request' in actor.get('permissions', [])},
    ]
    authorized = all(check['allowed'] for check in grant_checks)
    evidence['authorization'] = {'status': 'passed' if authorized else 'blocked', 'allowed': authorized,
        'project_id': project.id, 'rules': grant_checks}
    evidence['checks']['authorization'] = {'rule': 'project_request_authorization', 'allowed': authorized}
    if not authorized:
        return _pending(event, "actor_not_authorized_for_project")
    from .delivery import recognize_redmine_echo
    if recognize_redmine_echo(session, event, settings=settings):
        evidence['blocked_reason'] = event.data.get('routing_status', 'self_echo')
        evidence['checks']['delivery_echo'] = {'rule': 'confirmed_delivery_echo_filter', 'allowed': False}
        event._lifecycle_steps.append(("fast_filter", "blocked", event.data.get("routing_status", "self_echo"), {"reason": "delivery_echo"}))
        return
    evidence['checks']['delivery_echo'] = {'rule': 'confirmed_delivery_echo_filter', 'allowed': True}
    route_mention = (event.source == "dingtalk" and metadata.get("at_me") is True
                     and policy['group_messages'] == 'mentions')
    type_allowed = event.event_type in SOURCES[event.source].event_types
    evidence['checks']['event_type'] = {'rule': 'supported_source_event_type', 'allowed': type_allowed}
    if not type_allowed:
        return _pending(event, "unsupported_event_type")
    content_allowed = not (metadata.get('needs_confirmation') or metadata.get('uncertain_mentions') or not event.content.strip())
    evidence['checks']['message_content'] = {'rule': 'unambiguous_nonempty_message', 'allowed': content_allowed}
    if not content_allowed:
        return _pending(event, "ambiguous_or_empty_request")
    requested_kind = _requested_kind(request_content)
    evidence['checks']['request_kind'] = {'rule': 'no_conflicting_analysis_and_write',
        'allowed': requested_kind != 'conflict', 'requested_kind': requested_kind}
    if requested_kind == "conflict":
        return _pending(event, "conflicting_analysis_and_write_request")
    progress_question = direct and not re.search(r'请|帮我|麻烦|需要你', request_content) and bool(re.search(
        r'做好(?:了)?(?:没|吗)|完成(?:了)?(?:没|吗)|进度|进展|是否(?:已|完成)|做(?:完|到哪)'
        r'|(?:修复|修好|解决|上线|部署|发布|通过|换模型|好了)(?:了)?(?:没|吗|么)'
        r'|(?:修好|解决|上线|部署|发布)了(?:是|对)么|为什么.*(?:模型|接口|报错)', request_content))
    if progress_question:
        requested_kind = 'analysis'
    direct_reply = clarification or (direct and requested_kind != 'repair' and not progress_question and not re.search(r'只读|仅(?:做)?分析|只(?:做)?分析|分析|排查|检查', request_content))
    if direct_reply:
        requested_kind = 'reply'
    event._lifecycle_steps.append(("fast_filter", "passed", "identity_project_type_and_input_validated", None))
    from .event_rules import blocks_processing
    if blocks_processing(session, event, project.id, (semantic_decision or {}).get('kind') or requested_kind):
        return _pending(event, 'private_policy_hold')
    targets = [] if clarification else fanout(session, event, project, actor)
    if targets:
        if direct_reply:
            for target in targets:
                subscribed = session.get(Task, target.task_id)
                if subscribed.kind == 'reply' and subscribed.status == 'waiting_input' and subscribed.last_error == '收到订阅事件，请确认后继续':
                    subscribed.status, subscribed.last_error = 'queued', None
        event.data = {**event.data, 'routing_status': 'routed', 'actor': actor['user_id'],
                      'target_task_ids': [target.task_id for target in targets]}
        event._lifecycle_steps.extend([
            ('subscription', 'passed', 'explicit_subscriptions_fanout', {'task_ids': event.data['target_task_ids']}),
            ('router', 'passed', 'fanout_applied', None)])
        return
    issues = set(re.findall(r"(?<![\w])#(\d+)\b", request_content))
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
    direct_key = ('dingtalk:direct:' + digest({'profile': metadata.get('profile'),
                  'conversation': data.get('thread_id'), 'actor': data.get('actor_id')})) if direct_reply and not (issue_key or reply_key) else None
    key = issue_key or reply_key or direct_key or own_key
    keys = {value for value in (issue_key, own_key, reply_key, direct_key) if value}
    if any(len(value) > 255 for value in keys):
        return _pending(event, "reference_too_long")
    routes = {route.route_key: route for route in session.scalars(select(TaskRoute).where(
              TaskRoute.project_id == project.id, TaskRoute.route_key.in_(keys)).with_for_update())}
    candidates = {route.task_id for route in routes.values()}
    if reply_key and reply_key not in routes:
        # Older and manually linked receipts may not have a message alias.
        previous_ids = set(session.scalars(select(Event.task_id).join(Task, Task.id == Event.task_id).where(
            Task.project_id == project.id, Event.source == "dingtalk",
            Event.data["routing_status"].as_string().in_(("routed", "manually_linked")),
            Event.data["thread_id"].as_string() == data.get("thread_id"),
            Event.data["metadata"]["profile"].as_string() == metadata.get("profile", ""),
            Event.data["metadata"]["message_id"].as_string() == reply)))
        from .delivery import dingtalk_reply_targets
        previous_ids.update(dingtalk_reply_targets(session, event, reply, project.id))
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
    if task and blocks_processing(session, event, project.id, task.kind):
        return _pending(event, 'private_policy_hold')
    if task and issue_key:
        bound_issues = set(session.scalars(select(TaskRoute.route_key).where(TaskRoute.project_id == project.id,
                                          TaskRoute.task_id == task.id, TaskRoute.route_key.like("issue:%"))))
        if bound_issues - {issue_key}:
            return _pending(event, "conflicting_issue_reference")
    if task and reply and not issue_key and task.source_ref:
        key = task.source_ref
        keys.add(key)
    event._lifecycle_steps.append(("subscription", "passed", "existing_task_matched" if task else "no_existing_task", {"reference_types": [name for name, value in (("issue", issue_key), ("reply", reply_key)) if value], "candidate_task_ids": sorted(resolved), "selected_task_id": task.id if task else None}))
    from .governance import TaskOwner, task_owner
    if task and actor.get("role") != "admin":
        if task_owner(task.id, session) != actor.get("user_id"):
            return _pending(event, "task_owned_by_another_user")
    if task and task.outcome_unknown:
        return _pending(event, "target_outcome_unknown")
    if semantic_decision:
        if semantic_decision['action'] == 'dispatch':
            selected = session.get(Task, semantic_decision['task_id'])
            if (not authorized_task(session, selected, project, actor)
                    or selected.state_version != semantic_decision['state_version']
                    or (task and task.id != selected.id)):
                return _pending(event, 'semantic_target_stale_or_forbidden')
            task = selected
        elif semantic_decision['action'] != 'create':
            return _pending(event, 'semantic_confirmation_required')
        requested_kind = 'analysis' if progress_question and semantic_decision['kind'] == 'reply' else semantic_decision['kind']
        if blocks_processing(session, event, project.id, requested_kind):
            return _pending(event, 'private_policy_hold')
        if requested_kind == 'repair' and _requested_kind(event.content) != 'repair':
            return _pending(event, 'semantic_write_not_explicit')
        event._lifecycle_steps.append(('slow_filter', 'passed', 'model_decision_validated', semantic_decision))
    elif task is None or task.status in {'completed', 'cancelled'}:
        if not direct_reply and not clarification_source and enqueue_if_enabled(session, event, project, actor, settings=settings):
            event._lifecycle_steps.append(('slow_filter', 'pending', 'semantic_job_queued', None))
            return
    if (not semantic_decision and (not task or task.status in {"completed", "cancelled"}) and event.source == "dingtalk"
            and not route_mention
            and not direct_reply
            and not QUESTION_REQUEST.search(request_content)
            and not re.search(r"请|帮我|修复|实现|检查|分析|排查|调整|新增|继续|增加|优化|完成|\b(fix|implement|please|investigate|add)\b", request_content, re.I)):
        return _pending(event, "explicit_request_required")
    previous = task.id if task and task.status in {"completed", "cancelled"} else None
    requires_interrupt = bool(task and task.status in {"running", "waiting_approval"})
    created = task is None or bool(previous)
    if created:
        task = Task(project_id=project.id, title=event.content.strip().splitlines()[0][:300],
                    goal=request_content, source=event.source, source_ref=key, status="queued", owner_id=actor["user_id"],
                    kind=requested_kind or ("analysis" if route_mention else "repair"))
        if clarification:
            names = [p.name for p in session.scalars(select(Project).where(Project.id.in_(data['candidate_project_ids'])))]
            task.goal = '请向用户追问这条消息属于哪个项目，候选项目为' + '、'.join(names) + '。先确认项目归属。原始消息如下\n' + event.content
        session.add(task)
        session.flush()
        session.add(TaskOwner(task_id=task.id, user_id=actor["user_id"]))
    else:
        if direct_reply and task.kind == 'analysis' and reply_key:
            requested_kind = 'analysis'
        version = task.state_version
        values = dict(state_version=version + 1, updated_at=now(), revision=task.revision + 1,
                      control_version=task.control_version + 1, source_ref=issue_key or task.source_ref,
                      kind=requested_kind or task.kind)
        if task.status in {"running", "review_ready", "waiting_approval"}:
            values.update(status="waiting_input", last_error="收到新需求，已使旧版本结果与审批失效，请确认后继续")
            if direct_reply and task.kind == 'reply':
                # Scheduler's active map prevents a second run until the old
                # version exits and closes its client. Paused tasks stay paused.
                values.update(status='queued', last_error=None)
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
    event._lifecycle_steps.append(("router", "passed", "created_task" if created else "reused_task", {"task_id": task.id, "method": routing_method or ("semantic_model" if semantic_decision else "deterministic_rules")}))
    event.task_id = task.id
    if clarification_source:
        clarification_source.data = {**clarification_source.data, 'clarification_resolved_by': event.id}
    data = {key: value for key, value in data.items() if key != "routing_reason"}
    event.data = {**data, "routing_status": "routed", "original_event_type": data.get("event_type"), "actor": actor.get("user_id"),
                  "related_task_id": previous, "requires_interrupt": requires_interrupt,
                  **({'response_policy': policy} if policy else {})}
    session.add(EventTarget(event_id=event.id, task_id=task.id, message_event_id=event.id))
    if data.get("attachments"):
        session.flush()
        session.refresh(task)
        session.add(EventAttachmentJob(event_id=event.id, task_id=task.id, revision=task.revision,
                                       control_version=task.control_version))
        event.data = {**event.data, "attachments_status": "pending"}
        if task.status == "queued":
            task.status = "waiting_resource"
            task.last_error = "正在准备来源附件"


def _route(session, event, resolver, *, settings=None, semantic_decision=None, routing_method=None,
           project_assessment_only=False):
    from .lifecycle import record_attempt
    started = now()
    event._lifecycle_steps = [("trigger", "passed", "event_received", None)]
    _route_impl(session, event, resolver, settings=settings, semantic_decision=semantic_decision,
                routing_method=routing_method, project_assessment_only=project_assessment_only)
    record_attempt(event, started, event._lifecycle_steps)


def list_inbox(*, routing_status="pending_confirmation", after=0, limit=50, source="", q="", session_factory=None):
    if routing_status not in {"all", "pending_confirmation", "routed", "ignored", "dismissed", "manually_linked", "self_echo", "self_echo_candidate", "semantic_pending"} or after < 0 or not 1 <= limit <= 100:
        raise ValueError("收件箱筛选或分页参数无效")
    with (session_factory or Session)() as session:
        query = select(Event).where(Event.source.in_(["dingtalk", "redmine"]), Event.external_id.is_not(None), Event.id > after)
        if routing_status != "all":
            query = query.where(Event.data["routing_status"].as_string() == routing_status)
        if source:
            query = query.where(Event.source == source)
        if q:
            query = query.where(Event.content.contains(q, autoescape=True))
        rows = session.scalars(query.order_by(Event.id).limit(limit + 1)).all()
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
