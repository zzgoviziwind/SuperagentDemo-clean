"""Authenticated client bridge reusing canonical session and task operations."""
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, model_validator
from fastapi.responses import JSONResponse, Response

from superagent.api import sessions
from superagent.core import conversation_providers as providers
from superagent.core import governance as gov

router = APIRouter(prefix='/api/v1/conversation-providers', tags=['conversation-providers'])


def bridge_principal(request: Request):
    authorization = request.headers.get('authorization', '')
    if not authorization.startswith('Bearer '):
        raise HTTPException(401, '桥接需要配置平台 Bearer 访问令牌')
    principal = gov.authenticate_token(authorization[7:])
    current = getattr(request.state, 'principal', None)
    if current and (current.user_id, current.role) != (principal.user_id, principal.role):
        raise HTTPException(409, '桥接身份与当前请求身份冲突')
    request.state.principal = principal
    return principal


@router.get('')
def provider_status(request: Request):
    gov.require_permission(request.state.principal, 'read')
    return providers.capabilities()


@router.get('/bridge/status')
def bridge_status(principal=Depends(bridge_principal)):
    return {**providers.capabilities(), 'authenticated': True, 'principal': principal.to_dict()}


@router.get('/bridge/sessions')
def bridge_sessions(request: Request, project_id: int | None = None,
                    principal=Depends(bridge_principal)):
    return sessions.list_sessions(request, project_id)


@router.get('/bridge/sessions/{ident}')
def bridge_read(ident: str, request: Request, after: int = 0, limit: int = 100,
                principal=Depends(bridge_principal)):
    if after < 0 or not 1 <= limit <= 200:
        raise HTTPException(422, '游标或分页大小无效')
    detail = sessions.session_detail(ident, request)
    # Canonical history may gain legacy artifacts whose order is not append-only.
    # Hash binds positional cursors to one immutable history snapshot.
    import hashlib
    import json
    snapshot = hashlib.sha256(json.dumps(detail['messages'], sort_keys=True,
                                         ensure_ascii=False).encode()).hexdigest()
    messages = detail['messages'][after:after + limit]
    return {'session': detail['session'], 'messages': messages, 'snapshot': snapshot,
            'next_after': after + len(messages), 'has_more': after + len(messages) < len(detail['messages'])}


class OperationIn(BaseModel):
    model_config = ConfigDict(extra='forbid')
    request_key: str = Field(min_length=1, max_length=128, pattern=r'^[A-Za-z0-9_.-]+$')
    action: Literal['create', 'message', 'control']
    session_id: str | None = None
    project_id: int | None = Field(default=None, gt=0)
    title: str | None = Field(default=None, min_length=1, max_length=300)
    content: str | None = Field(default=None, min_length=1, max_length=20000)
    kind: Literal['analysis', 'repair', 'reply'] = 'analysis'
    change_goal: bool = False
    expected_state_version: int | None = Field(default=None, ge=1)
    control: Literal['start', 'pause', 'resume', 'cancel', 'retry'] | None = None

    @model_validator(mode='after')
    def validate_action(self):
        if self.action == 'create':
            if not self.project_id or not self.title or not self.content:
                raise ValueError('创建会话需要 project_id、title、content')
        else:
            if not self.session_id or self.expected_state_version is None:
                raise ValueError('消息和控制需要 session_id 及 expected_state_version')
            if self.action == 'message' and not self.content:
                raise ValueError('消息内容不能为空')
            if self.action == 'control' and not self.control:
                raise ValueError('控制动作不能为空')
        return self


@router.get('/bridge/operations/{request_key}')
def bridge_receipt(request_key: str, principal=Depends(bridge_principal)):
    receipt = providers.operation_receipt(principal.user_id, request_key)
    if receipt['result']:
        from types import SimpleNamespace
        request = SimpleNamespace(state=SimpleNamespace(principal=principal))
        sessions.session_detail(receipt['result']['session_id'], request)
    return receipt


@router.post('/bridge/operations')
async def bridge_operation(body: OperationIn, request: Request,
                           principal=Depends(bridge_principal)):
    from superagent import main
    if body.action == 'create':
        gov.require_permission(principal, 'task.create')
    else:
        detail = sessions.session_detail(body.session_id, request)
        if body.action == 'control' and detail['session']['kind'] != 'worker':
            raise HTTPException(422, '任务控制仅适用于 Worker 会话')
        if principal.role == 'viewer':
            raise HTTPException(403, '当前身份无权写入会话')
    operation_id, previous = providers.reserve_operation(
        principal.user_id, body.request_key, body.model_dump())
    if previous is not None:
        # Revalidate visibility even if the owner or role changed since the first call.
        sessions.session_detail(previous['session_id'], request)
        return {**previous, 'duplicate': True}
    try:
        if body.action == 'create':
            task = main.create_task(main.TaskIn(title=body.title, goal=body.content,
                                               project_id=body.project_id, kind=body.kind), request)
            result = {'session_id': f"worker:{task['id']}", 'result': task}
        elif body.action == 'message':
            result = {'session_id': body.session_id, 'result': await sessions.post_message(
                body.session_id, sessions.MessageIn(content=body.content, change_goal=body.change_goal,
                    expected_state_version=body.expected_state_version), request)}
        else:
            _, task_id = sessions.parse_id(body.session_id)
            result = {'session_id': body.session_id, 'result': await main.control(
                task_id, main.ControlIn(action=body.control,
                    expected_state_version=body.expected_state_version), request)}
        providers.finish_operation(operation_id, result=result)
        return {**result, 'duplicate': False}
    except BaseException:
        # The canonical operation and receipt are separate transactions. A crash
        # between them is deliberately protected from automatic retries.
        providers.finish_operation(operation_id, error='执行未完整确认，请核验会话与任务状态')
        raise


@router.post('/mcp')
async def mcp_http(request: Request, principal=Depends(bridge_principal)):
    """Stateless Streamable HTTP MCP, JSON responses, bearer authenticated.

    A public ChatGPT Web installation additionally needs an OAuth deployment.
    This endpoint is usable with bearer-capable desktop/API MCP clients today.
    """
    from superagent.runtime.chatgpt_bridge import TOOLS, dispatch
    gov.check_origin(request)
    raw = await request.body()
    if len(raw) > 1_000_000:
        raise HTTPException(413, 'MCP 请求过大')
    import json
    try:
        message = json.loads(raw)
    except (ValueError, UnicodeError):
        return JSONResponse({'jsonrpc': '2.0', 'id': None,
                             'error': {'code': -32700, 'message': 'JSON 解析失败'}})
    protocol = request.headers.get('mcp-protocol-version')
    if protocol and protocol not in {'2024-11-05', '2025-03-26', '2025-06-18'}:
        raise HTTPException(400, 'MCP 协议版本不支持')
    if not isinstance(message, dict) or message.get('method') != 'tools/call':
        response = dispatch(message, None)
        return Response(status_code=202) if response is None else JSONResponse(response)
    ident = message.get('id')
    if message.get('jsonrpc') != '2.0' or 'id' not in message:
        return JSONResponse({'jsonrpc': '2.0', 'id': ident,
                             'error': {'code': -32600, 'message': '无效 JSON-RPC 请求'}})
    params = message.get('params', {})
    try:
        if not isinstance(params, dict):
            raise ValueError('工具参数无效')
        name, arguments = params.get('name'), params.get('arguments', {})
        schemas = {item['name']: item['inputSchema'] for item in TOOLS}
        if name not in schemas or not isinstance(arguments, dict):
            raise ValueError('工具不存在或参数无效')
        schema = schemas[name]
        if set(arguments) - set(schema['properties']) or set(schema.get('required', [])) - set(arguments):
            raise ValueError('工具参数缺失或含未知字段')
        if name == 'superagent_status':
            value = bridge_status(principal)
        elif name == 'superagent_sessions':
            value = bridge_sessions(request, arguments.get('project_id'), principal)
        elif name == 'superagent_read':
            value = bridge_read(arguments['session_id'], request, arguments.get('after', 0),
                                arguments.get('limit', 100), principal)
        elif name == 'superagent_receipt':
            value = bridge_receipt(arguments['request_key'], principal)
        else:
            value = await bridge_operation(OperationIn.model_validate(arguments), request, principal)
        result = {'content': [{'type': 'text', 'text': json.dumps(value, ensure_ascii=False)}], 'isError': False}
    except (ValueError, TypeError, HTTPException) as exc:
        status = exc.status_code if isinstance(exc, HTTPException) else 422
        result = {'content': [{'type': 'text', 'text': f'工具调用未确认（{status}），请检查参数、权限与操作回执。'}],
                  'isError': True}
    return JSONResponse({'jsonrpc': '2.0', 'id': ident, 'result': result})


@router.api_route('/mcp', methods=['GET', 'DELETE'])
def mcp_no_stream(principal=Depends(bridge_principal)):
    return Response(status_code=405, headers={'Allow': 'POST'})
