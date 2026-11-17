"""Routing decisions persisted with the receipt."""
from .db import now, Project
from sqlalchemy import select
from sqlalchemy.orm import object_session

STAGES = ("trigger", "fast_filter", "slow_filter", "subscription", "router", "worker", "delivery", "watchdog")

def record_attempt(event, started, recorded):
    at = now()
    steps = []
    for stage in STAGES:
        matches = [(state, reason, detail) for name, state, reason, detail in recorded if name == stage]
        if not matches:
            if stage == "slow_filter":
                matches = [("skipped", "semantic_filter_disabled_or_fastpath", None)]
            elif stage in {"worker", "delivery", "watchdog"}:
                matches = [("unknown", "not_recorded_in_routing_attempt", None)]
            else:
                matches = [("skipped", "stage_not_reached", None)]
        for state, reason, detail in matches:
            if stage == 'fast_filter' and state in {'passed', 'blocked'}:
                detail = {**_input_evidence(event), **(detail or {})}
            elif stage == 'slow_filter':
                detail = {**(detail or {}), 'routing_session_id': f'semantic:{event.id}'
                          if reason in {'semantic_job_queued', 'model_decision_validated'} else None}
            steps.append(dict(stage=stage, status=state, reason=reason, detail=detail, at=at))
    data = event.data
    attempts = list(data.get("_lifecycle", []))
    attempts.append(dict(attempt=len(attempts)+1, started_at=started, steps=steps))
    event.data = {**data, "_lifecycle": attempts}


def _input_evidence(event):
    data = event.data
    metadata = data.get('metadata') or {}
    detail = {'evidence_scope': '本次路由事务中的输入与项目绑定快照',
              'input': {'source': event.source, 'event_type': data.get('event_type', event.event_type),
                        'actor_id': data.get('actor_id'), 'project_external_id': data.get('project_external_id'),
                        'thread_id': data.get('thread_id'), 'content_length': len(event.content),
                        'at_me': metadata.get('at_me'), 'conversation_type': metadata.get('conversation_type'),
                        'needs_confirmation': metadata.get('needs_confirmation'),
                        'uncertain_mentions': metadata.get('uncertain_mentions')},
              'validated_actor_user_id': data.get('actor')}
    session = object_session(event)
    if session:
        from .governance import Setting
        external = str(data.get('project_external_id') or '')
        field = 'dingtalk_chat_ids' if event.source == 'dingtalk' else 'redmine_project_ids'
        detail['project_matches'] = [{'id': p.id, 'name': p.name, 'enabled': p.enabled,
            'matched_field': field, 'matched_external_id': external} for p in session.scalars(select(Project))
            if external and external in {str(value) for value in getattr(p, field)}]
        detail['persisted_settings'] = {key: row.value if (row := session.get(Setting, key)) else False
            for key in ['dingtalk_route_all_mentions', 'semantic_routing_enabled']}
        if event.source == 'dingtalk':
            from .message_policy import response_policy, conversation_type
            policy = response_policy(session)
            detail['persisted_response_policy'] = policy
            detail['input']['conversation_type'] = conversation_type(metadata)
            if not detail['project_matches'] and conversation_type(metadata) == 'direct' and policy['default_project_id'] is not None:
                project = session.get(Project, policy['default_project_id'])
                detail['default_project_match'] = {'id': project.id, 'name': project.name, 'enabled': project.enabled} if project else None
    # Ingestion may attach exact evaluated policy inputs, including connector overrides.
    detail.update(getattr(event, '_routing_evidence', {}))
    return detail

def source_context(event):
    data = event.data or {}
    meta = data.get('metadata') or {}
    return {'source': event.source, 'conversation_name': meta.get('conversation_title') or meta.get('chat_name') or meta.get('conversation_name') or data.get('thread_id'),
            'actor_name': meta.get('sender_name') or meta.get('actor_name') or data.get('actor_id'),
            'thread_id': data.get('thread_id'), 'issue_id': data.get('issue_id'),
            'conversation_type': meta.get('conversation_type'), 'content': event.content}


def architecture_flow(attempts):
    # Display only recorded evidence; ordering in legacy attempts is a display order,
    # not an assertion that every branch was executed.
    return [{'attempt': attempt.get('attempt'), 'nodes': [
        {**step, 'architecture_node': step['stage'], 'evidence_scope': 'routing_attempt',
         'visited': step.get('status') in {'passed', 'blocked', 'pending'}}
        for step in attempt.get('steps', [])]} for attempt in attempts]
