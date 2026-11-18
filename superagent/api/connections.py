"""Administrative connector, receipt and delivery endpoints."""

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import select

from superagent.core.connections import manager, schedule_attachments, schedule_interruption
from superagent.core.db import Session, dump
from superagent.core.delivery import (DeliveryRecord, ReplyDraft, create_draft, decide_draft,
                                      publish_draft, reconcile_delivery)
from superagent.core.ingestion import ingest_event, list_inbox, retry_attachments, retry_routing
from superagent.core.governance import authenticate_request, require_permission, task_owner


def require_read(request: Request):
    principal = authenticate_request(request)
    require_permission(principal, "connector.read")


def require_admin(request: Request):
    principal = authenticate_request(request)
    require_permission(principal, "settings.write")
    return principal


def require_delivery_owner(request: Request):
    principal = authenticate_request(request)
    task_id = request.path_params.get("task_id")
    with Session() as session:
        if task_id is None:
            draft = session.get(ReplyDraft, int(request.path_params["draft_id"]))
            if draft is None:
                raise HTTPException(404, "草稿不存在")
            task_id = draft.task_id
        require_permission(principal, "task.approve", task_owner(int(task_id), session))


router = APIRouter(prefix="/api/v1", dependencies=[Depends(require_read)])


class DraftIn(BaseModel):
    event_id: int
    content: str = Field(min_length=1)


class DecisionIn(BaseModel):
    decision: str
    action_hash: str


class ReconcileIn(BaseModel):
    outcome: str
    evidence: str = Field(min_length=1)


@router.get("/connectors")
def connectors():
    return manager.statuses()


@router.get('/connectors/dingtalk/groups', dependencies=[Depends(require_admin)])
async def find_dingtalk_groups(q: str = '', cursor: str = Query(default='', max_length=2000)):
    from superagent.connectors.history import run_read_json
    from superagent.connectors.common import ConnectorError
    if not q.strip() or len(q) > 100:
        raise HTTPException(422, '请输入群名称，最多 100 字')
    config = manager.config('dingtalk')
    if not config.get('profile') or not config.get('executable'):
        raise HTTPException(409, '请先配置钉钉组织和本地程序')
    command = config['executable']
    argv = [command] if isinstance(command, str) else list(command)
    args = argv + ['--profile', config['profile'], 'chat', '+chat-search',
                   '--query', q.strip(), '--limit', '20', '--format', 'json']
    if cursor:
        args += ['--cursor', cursor]
    try:
        result = await run_read_json(args, timeout=25)
    except (ConnectorError, TimeoutError):
        raise HTTPException(503, '钉钉群名称查询暂不可用，请检查网络后重试。已配置群可填写名称备注。') from None
    data = result.get('data', result.get('result', result))
    if not isinstance(data, dict) or not isinstance(data.get('chats'), list):
        raise HTTPException(502, '钉钉群搜索结果格式无法识别')
    items = [{'id': row['openConversationId'], 'name': row.get('name') or '群名称未提供'}
             for row in data['chats'] if isinstance(row, dict) and isinstance(row.get('openConversationId'), str)]
    next_cursor = data.get('nextCursor')
    return {'items': items, 'complete': data.get('complete') is True and data.get('hasMore') is False,
            'has_more': data.get('hasMore'), 'stop_reason': data.get('stopReason'),
            'next_cursor': str(next_cursor) if next_cursor is not None else None}


@router.get('/connectors/dingtalk/group', dependencies=[Depends(require_admin)])
async def dingtalk_group(chat_id: str = Query(min_length=1, max_length=2000)):
    from superagent.connectors.history import run_read_json
    from superagent.connectors.common import ConnectorError
    config = manager.config('dingtalk')
    if not config.get('profile') or not config.get('executable'):
        raise HTTPException(409, '请先配置钉钉组织和本地程序')
    command = config['executable']
    argv = [command] if isinstance(command, str) else list(command)
    try:
        result = await run_read_json(argv + ['--profile', config['profile'], 'chat', '+conversation-info',
                                           '--group', chat_id, '--format', 'json'], timeout=25)
    except (ConnectorError, TimeoutError):
        raise HTTPException(503, '钉钉群原名暂不可用，请稍后重试') from None
    data = result.get('data', result.get('result', result))
    info = data.get('conversationInfo') if isinstance(data, dict) else None
    if (not isinstance(info, dict) or info.get('openConversationId') != chat_id
            or info.get('singleChat') is not False or not isinstance(info.get('title'), str)
            or not info['title'].strip()):
        raise HTTPException(502, '钉钉群资料未返回有效的群原名')
    return {'id': chat_id, 'name': info['title'].strip()}


@router.post("/connectors/{name}/{action}", dependencies=[Depends(require_admin)])
async def control_connector(name: str, action: str):
    if name not in {"dingtalk", "redmine"} or action not in {"start", "stop"}:
        raise HTTPException(422, "连接器或控制动作无效")
    try:
        return await (manager.start(name) if action == "start" else manager.stop(name))
    except (ValueError, RuntimeError) as error:
        raise HTTPException(409, str(error)) from None


@router.post("/events", dependencies=[Depends(require_admin)])
async def receive_event(body: dict):
    try:
        receipt = ingest_event(body)
        schedule_interruption(receipt)
        schedule_attachments(receipt)
        return receipt
    except ValueError as error:
        raise HTTPException(422, str(error)) from None


@router.get("/events", dependencies=[Depends(require_admin)])
def inbox(routing_status: str = "pending_confirmation", after: int = 0, limit: int = 50, source: str = "", q: str = ""):
    try:
        return list_inbox(routing_status=routing_status, after=after, limit=limit, source=source, q=q)
    except ValueError as error:
        raise HTTPException(422, str(error)) from None


@router.post("/events/{event_id}/retry-routing")
async def reroute_event(event_id: int, principal=Depends(require_admin)):
    try:
        receipt = retry_routing(event_id, actor=principal.user_id)
        schedule_interruption(receipt)
        schedule_attachments(receipt)
        return receipt
    except ValueError as error:
        raise HTTPException(409, str(error)) from None


@router.post("/events/{event_id}/retry-attachments")
async def retry_event_attachments(event_id: int, principal=Depends(require_admin)):
    try:
        receipt = retry_attachments(event_id, actor=principal.user_id)
        schedule_attachments(receipt)
        return receipt
    except ValueError as error:
        raise HTTPException(409, str(error)) from None


@router.post("/tasks/{task_id}/deliveries", dependencies=[Depends(require_delivery_owner)])
def draft_reply(task_id: int, body: DraftIn):
    try:
        return create_draft(task_id, body.event_id, body.content)
    except ValueError as error:
        raise HTTPException(409, str(error)) from None


@router.get("/tasks/{task_id}/deliveries")
def drafts(task_id: int):
    with Session() as session:
        results = []
        for draft in session.scalars(select(ReplyDraft).where(ReplyDraft.task_id == task_id)):
            record = session.get(DeliveryRecord, "reply-" + str(draft.approval_id))
            results.append({**dump(draft), "delivery": record.result if record else None})
        return results


@router.post("/deliveries/{draft_id}/decision", dependencies=[Depends(require_delivery_owner)])
def approve_reply(draft_id: int, body: DecisionIn):
    try:
        return decide_draft(draft_id, body.decision, body.action_hash)
    except ValueError as error:
        raise HTTPException(409, str(error)) from None


@router.post("/deliveries/{draft_id}/publish", dependencies=[Depends(require_delivery_owner)])
async def send_reply(draft_id: int):
    try:
        return await publish_draft(draft_id)
    except (ValueError, PermissionError) as error:
        raise HTTPException(409, str(error)) from None


@router.post("/deliveries/{draft_id}/reconcile", dependencies=[Depends(require_delivery_owner)])
def reconcile_reply(draft_id: int, body: ReconcileIn):
    try:
        return reconcile_delivery(draft_id, body.outcome, body.evidence)
    except ValueError as error:
        raise HTTPException(409, str(error)) from None
