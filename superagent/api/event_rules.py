from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from superagent.api.connections import require_admin
from superagent.core.db import Session, Project
from superagent.core.governance import Setting
from superagent.core.event_rules import EventRule, rules

router = APIRouter(prefix='/api/v1/event-rules', dependencies=[Depends(require_admin)])
class RulesInput(BaseModel):
    items: list[EventRule] = Field(max_length=100)

@router.get('')
def get_rules():
    with Session() as session:
        return {'items': [r.model_dump() for r in rules(session)], 'timezone': 'Asia/Shanghai'}

@router.put('')
def save_rules(body: RulesInput):
    with Session.begin() as session:
        for rule in body.items:
            if rule.project_id and not session.get(Project, rule.project_id):
                raise HTTPException(422, '项目不存在')
        row = session.get(Setting, 'private_event_rules')
        if row is None:
            row = Setting(key='private_event_rules', value=[])
            session.add(row)
        row.value = [r.model_dump() for r in body.items]
        return {'items': row.value, 'timezone': 'Asia/Shanghai'}
