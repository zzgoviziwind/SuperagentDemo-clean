from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, ConfigDict, StrictBool

from superagent.api.connections import require_admin
from superagent.core import local_agents

router = APIRouter(prefix='/api/v1/agents/local', tags=['local-agents'], dependencies=[Depends(require_admin)])


class ConnectIn(BaseModel):
    model_config = ConfigDict(extra='forbid')
    agent_id: str
    use_existing_login: StrictBool


@router.get('')
async def local_agent_status():
    return await local_agents.agent_status()


@router.post('/connect')
async def local_agent_connect(body: ConnectIn, principal=Depends(require_admin)):
    return await local_agents.connect_agent(body.agent_id, use_existing_login=body.use_existing_login,
                                            actor=principal.user_id)
