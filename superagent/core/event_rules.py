"""Private deterministic controls. Never include rule content in prompts or replies."""
from datetime import datetime, timedelta, timezone
from typing import Literal
from pydantic import BaseModel, Field, model_validator
from .governance import Setting

class EventRule(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    enabled: bool = True
    project_id: int | None = Field(default=None, gt=0)
    source: Literal['dingtalk', 'redmine'] | None = None
    chat_id: str | None = Field(default=None, max_length=255)
    actor_id: str | None = Field(default=None, max_length=255)
    kind: Literal['reply', 'analysis', 'repair'] | None = None
    action: Literal['pause', 'quiet', 'review', 'reply_quiet']
    start_hour: int = Field(default=20, ge=0, le=23)
    end_hour: int = Field(default=8, ge=0, le=23)

    @model_validator(mode='after')
    def check(self):
        if self.chat_id and self.source != 'dingtalk':
            raise ValueError('群聊规则请选择钉钉来源')
        if self.action in {'quiet', 'reply_quiet'} and self.start_hour == self.end_hour:
            raise ValueError('静默开始与结束时间不能相同')
        return self

def rules(session):
    row = session.get(Setting, 'private_event_rules')
    return [EventRule.model_validate(item) for item in (row.value if row else [])]

def evaluate(session, event, project_id, kind=None, at=None):
    instant = at or datetime.now(timezone.utc)
    hour = instant.astimezone(timezone(timedelta(hours=8))).hour
    result = set()
    for rule in rules(session):
        if not rule.enabled or (rule.project_id and rule.project_id != project_id):
            continue
        if rule.source and rule.source != event.source:
            continue
        if rule.chat_id and rule.chat_id != str(event.data.get('thread_id', '')):
            continue
        if rule.actor_id and rule.actor_id != str(event.data.get('actor_id', '')):
            continue
        if rule.kind and kind != rule.kind:
            continue
        if rule.action in {'quiet', 'reply_quiet'}:
            active = (rule.start_hour <= hour < rule.end_hour if rule.start_hour < rule.end_hour
                      else hour >= rule.start_hour or hour < rule.end_hour)
            if not active:
                continue
        result.add(rule.action)
    return result

def blocks_processing(session, event, project_id, kind=None):
    return bool(evaluate(session, event, project_id, kind) & {'pause', 'quiet'})
