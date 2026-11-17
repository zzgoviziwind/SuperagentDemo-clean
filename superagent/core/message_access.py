"""Administrator-configured requester admission and evidence-based project selection."""
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import select

from .db import Event, Project, Task
from .governance import Setting


class PersonRule(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    actor_id: str = Field(min_length=1, max_length=255)
    name: str = Field(default='', max_length=100)
    reply: bool = True
    project_ids: list[int] = Field(default_factory=list, max_length=100)


class ProjectHint(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    project_id: int = Field(gt=0)
    keywords: list[str] = Field(default_factory=list, max_length=30)


class MessageAccess(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    mode: Literal['mapped', 'all', 'selected', 'off'] = 'mapped'
    owner_user_id: str = Field(default='admin', min_length=1, max_length=200)
    project_ids: list[int] = Field(default_factory=list, max_length=100)
    people: list[PersonRule] = Field(default_factory=list, max_length=500)
    project_hints: list[ProjectHint] = Field(default_factory=list, max_length=100)
    group_names: dict[str, str] = Field(default_factory=dict, max_length=100)
    on_unmatched: Literal['pending', 'ask', 'default'] = 'pending'
    default_project_id: int | None = Field(default=None, gt=0)

    @field_validator('project_ids')
    @classmethod
    def project_ids_valid(cls, values):
        if any(type(value) is not int or value <= 0 for value in values) or len(set(values)) != len(values):
            raise ValueError('候选项目必须是不重复的有效项目')
        return values


def access_config(session, settings=None):
    row = session.get(Setting, 'dingtalk_request_access')
    value = settings('dingtalk_request_access', None) if settings else row.value if row else None
    return MessageAccess.model_validate(value) if value is not None else None


def resolve_requester(session, event, resolver, settings=None):
    actor_id = str(event.data.get('actor_id', ''))
    config = access_config(session, settings) if event.source == 'dingtalk' else None
    if config is None:
        return resolver(event.source, actor_id), config, None
    rule = next((person for person in config.people if person.actor_id == actor_id), None)
    if config.mode == 'off' or (rule and not rule.reply) or (config.mode == 'selected' and rule is None):
        return None, config, 'sender_reply_disabled'
    if config.mode == 'mapped':
        return resolver(event.source, actor_id), config, None
    projects = rule.project_ids if rule and rule.project_ids else config.project_ids
    grants = set(projects)
    if config.default_project_id:
        grants.add(config.default_project_id)
    return {'user_id': config.owner_user_id, 'role': 'member', 'enabled': True,
            'project_ids': sorted(grants), 'permissions': ['request'],
            'candidate_project_ids': projects, 'admission': config.mode}, config, None


def choose_project(session, event, actor, config):
    """Return candidates and recorded reasons. Ambiguous evidence remains unresolved."""
    candidates = list(session.scalars(select(Project).where(
        Project.enabled.is_(True), Project.archived.is_(False),
        Project.id.in_(actor.get('candidate_project_ids', actor.get('project_ids', []))))))
    metadata = event.data.get('metadata') or {}
    policy_row = session.get(Setting, 'dingtalk_response_policy')
    policy_names = policy_row.value.get('group_names', {}) if policy_row and policy_row.value else {}
    context = '\n'.join(str(value or '') for value in (
        metadata.get('conversation_title'), metadata.get('chat_name'),
        config.group_names.get(str(event.data.get('thread_id', ''))),
        policy_names.get(str(event.data.get('thread_id', ''))))).casefold()
    hints = {hint.project_id: hint.keywords for hint in config.project_hints}
    named = [project for project in candidates if any(
        word.strip() and word.strip().casefold() in event.content.casefold()
        for word in [project.name, *hints.get(project.id, [])])]
    if not named:
        named = [project for project in candidates if any(
            word.strip() and word.strip().casefold() in context
            for word in [project.name, *hints.get(project.id, [])])]
    if len(named) == 1:
        return named, {'method': 'message_or_group_name', 'project_id': named[0].id}
    if len(named) > 1:
        return [], {'method': 'ambiguous_names', 'candidate_ids': [p.id for p in named]}
    bound = [project for project in candidates if str(event.data.get('thread_id')) in project.dingtalk_chat_ids]
    if len(bound) == 1:
        return bound, {'method': 'group_binding', 'project_id': bound[0].id}
    # An explicit fallback avoids letting an unrelated earlier private topic pin
    # every new request from the same sender. A verified quote still uses history.
    if config.on_unmatched == 'default' and config.default_project_id and not metadata.get('reply_to_message_id'):
        return [], {'method': 'configured_default_fallback', 'candidate_ids': [p.id for p in candidates]}
    # Use only this sender's already-routed events in the same account and conversation.
    previous = session.scalars(select(Event).where(
        Event.source == 'dingtalk', Event.id < event.id, Event.task_id.is_not(None),
        Event.data['actor_id'].as_string() == str(event.data.get('actor_id', '')),
        Event.data['thread_id'].as_string() == str(event.data.get('thread_id', '')),
        Event.data['metadata']['profile'].as_string() == str(metadata.get('profile', '')),
        Event.data['routing_status'].as_string() == 'routed').order_by(Event.id.desc()).limit(20)).all()
    task_ids = [item.task_id for item in previous if not item.data.get('project_clarification')]
    project_ids = set(session.scalars(select(Task.project_id).where(Task.id.in_(task_ids))))
    historical = [project for project in candidates if project.id in project_ids]
    if len(historical) == 1:
        return historical, {'method': 'conversation_history', 'project_id': historical[0].id}
    if len(candidates) == 1 and not previous:
        return candidates, {'method': 'sender_single_project', 'project_id': candidates[0].id}
    return [], {'method': 'unmatched', 'candidate_ids': [p.id for p in candidates]}


def unanswered_project_question(session, event):
    metadata = event.data.get('metadata') or {}
    return session.scalar(select(Event).where(
        Event.source == 'dingtalk', Event.id < event.id,
        Event.data['project_clarification'].as_boolean().is_(True),
        Event.data['clarification_resolved_by'].as_integer().is_(None),
        Event.data['actor_id'].as_string() == str(event.data.get('actor_id', '')),
        Event.data['thread_id'].as_string() == str(event.data.get('thread_id', '')),
        Event.data['metadata']['profile'].as_string() == str(metadata.get('profile', '')),
    ).order_by(Event.id.desc()).limit(1))
