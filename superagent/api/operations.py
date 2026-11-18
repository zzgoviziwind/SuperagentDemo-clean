"""Administrator operations and separately authenticated outbound daemon protocol."""
import json
import time
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from superagent.core import db, execution_nodes as nodes
from superagent.core import governance as gov
from superagent.core.watchdog import WatchdogService, WatchdogRun
from superagent.core.scheduler import scheduler
from superagent.runtime.codex import UnknownOutcome

router = APIRouter(prefix='/api/v1/operations', tags=['operations'])


def admin(principal=Depends(gov.authenticate_request)):
    gov.require_permission(principal, 'settings.write')
    return principal


class OperationsService:
    def __init__(self, worker=scheduler, model=None):
        self.watchdog = WatchdogService(worker, model)

    async def start(self):
        nodes.initialize()
        await self.watchdog.start()

    async def close(self):
        await self.watchdog.close()


operations = OperationsService()


@router.get('/tasks/{task_id}/attempts')
def list_attempts(task_id: int, principal=Depends(gov.authenticate_request)):
    with db.Session() as session:
        if session.get(db.Task, task_id) is None:
            raise HTTPException(404, '任务不存在')
        gov.require_permission(principal, 'task.control', gov.task_owner(task_id, session))
        attempts = session.scalars(select(db.ExecutionAttempt).where(
            db.ExecutionAttempt.task_id == task_id).order_by(db.ExecutionAttempt.attempt_no))
        return {'items': [db.dump(attempt) for attempt in attempts]}


@router.get('/nodes', dependencies=[Depends(admin)])
def list_nodes():
    with db.Session() as session:
        states = {node.id: node for node in session.scalars(select(nodes.ExecutionNode))}
        bindings = [db.dump(row) for row in session.scalars(select(nodes.ProjectNodeBinding))]
    return {'items': [{'id': key, 'project_ids': config.get('project_ids', []), 'roots': config['roots'],
                       'online': key in states and states[key].seen > time.time() - 30,
                       'last_seen': datetime.fromtimestamp(states[key].seen, timezone.utc).isoformat() if key in states else None,
                       'shared_workspace_required': True} for key, config in nodes.definitions().items()],
            'bindings': bindings}


class BindingIn(BaseModel):
    model_config = ConfigDict(extra='forbid')
    node_id: str | None = Field(default=None, max_length=100)


@router.patch('/projects/{project_id}/execution-node')
async def bind(project_id: int, body: BindingIn, principal=Depends(admin)):
    if body.node_id is not None:
        config = nodes.definitions().get(body.node_id)
        if not config or project_id not in config.get('project_ids', []):
            raise HTTPException(422, '节点未授权执行此项目')
    with db.Session.begin() as session:
        if session.get(db.Project, project_id) is None:
            raise HTTPException(404, '项目不存在')
        busy = session.scalars(select(db.Task.id).where(db.Task.project_id == project_id,
                               db.Task.status.in_(['running', 'waiting_approval']))).first()
        if busy:
            raise HTTPException(409, '项目执行中，停止后再切换执行设备')
        # Codex thread identity belongs to its original node. Existing workspaces must
        # be explicitly cleared/reconciled before changing their execution host.
        existing = session.scalars(select(db.Task.id).where(db.Task.project_id == project_id,
                                   db.Task.codex_thread_id.is_not(None),
                                   db.Task.status.notin_(['completed', 'cancelled']))).first()
        if existing:
            raise HTTPException(409, '项目存在已绑定执行会话，请先结束这些任务')
        row = session.get(nodes.ProjectNodeBinding, project_id)
        if row is None:
            row = nodes.ProjectNodeBinding(project_id=project_id)
            session.add(row)
        row.node_id = body.node_id
        gov.audit_action(session, principal, 'execution_node.bind', project_id, {'source': body.node_id or 'local'})
    return {'project_id': project_id, 'node_id': body.node_id}


async def authenticated_body(request):
    raw = await request.body()
    if len(raw) > 2 * 1024 * 1024:
        raise HTTPException(413, '节点请求过大')
    try:
        node_id = request.headers['X-Node-Id']
        config = nodes.authenticate(node_id, request.headers['X-Node-Time'], request.headers['X-Node-Nonce'],
                                    request.headers['X-Node-Signature'], request.url.path, raw)
        body = json.loads(raw)
        if not isinstance(body, dict):
            raise ValueError()
        return node_id, config, body
    except (ValueError, KeyError, TypeError, IntegrityError):
        raise HTTPException(401, '节点认证失败或请求重放') from None


@router.post('/daemon/poll')
async def daemon_poll(request: Request):
    node_id, config, body = await authenticated_body(request)
    if set(body) != {'boot_id'} or not isinstance(body['boot_id'], str) or not 16 <= len(body['boot_id']) <= 100:
        raise HTTPException(422, '启动标识无效')
    operation = nodes.poll(node_id, body['boot_id'])
    if operation and operation['method'] == 'start':
        from pathlib import Path
        payload = operation['payload']
        path = Path(payload['cwd']).resolve()
        if payload.get('project_id') not in config.get('project_ids', []) or not any(path == Path(root).resolve() or Path(root).resolve() in path.parents for root in config['roots']):
            nodes.exchange(node_id, operation['id'], operation['lease'], {'error': 'project or path denied'})
            raise HTTPException(403, '节点项目或工作区未授权')
    return {'operation': operation, 'active_sessions': nodes.active_sessions(node_id)}


@router.post('/daemon/exchange')
async def daemon_exchange(request: Request):
    node_id, _, body = await authenticated_body(request)
    if set(body) - {'operation_id', 'lease', 'result', 'events'} or len(body.get('events', [])) > 100:
        raise HTTPException(422, '节点结果格式无效')
    try:
        if body.get('operation_id') and not isinstance(body.get('result'), dict):
            raise ValueError()
        nodes.exchange(node_id, **body)
    except (ValueError, KeyError, TypeError, IntegrityError):
        raise HTTPException(409, '节点结果或租约无效，需人工核验') from None
    return {'accepted': True}


@router.get('/watchdog', dependencies=[Depends(admin)])
def watchdog_runs(task_id: int | None = None):
    with db.Session() as session:
        query = select(WatchdogRun).order_by(WatchdogRun.created_at.desc()).limit(100)
        if task_id is not None:
            query = select(WatchdogRun).where(WatchdogRun.task_id == task_id).order_by(WatchdogRun.created_at.desc()).limit(100)
        settings = gov.settings_snapshot()
        return {'items': [db.dump(row) for row in session.scalars(query)],
                'enabled': settings.get('watchdog_enabled', False),
                'interval_seconds': settings.get('watchdog_interval_seconds', 60)}


@router.post('/watchdog/tasks/{task_id}/run', dependencies=[Depends(admin)])
async def watchdog_review(task_id: int):
    try:
        return {'run_id': await operations.watchdog.review(task_id)}
    except (TimeoutError, UnknownOutcome) as exc:
        run_id = getattr(exc, 'run_id', None)
        reason = '巡检等待超时，结果未知' if isinstance(exc, TimeoutError) or getattr(exc, 'timed_out', False) else '巡检结果未知'
        record = f'巡检记录 {run_id}' if run_id else '该任务的巡检记录'
        raise HTTPException(409, f'{reason}。请查看{record}（/api/v1/operations/watchdog?task_id={task_id}），核验后再继续。') from None
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from None


class CorrectionIn(BaseModel):
    model_config = ConfigDict(extra='forbid')
    content: str = Field(min_length=1, max_length=10000)
    reconcile_unknown: bool = False


@router.post('/watchdog/{run_id}/messages')
def watchdog_correction(run_id: str, body: CorrectionIn, principal=Depends(admin)):
    with db.Session.begin() as session:
        row = session.get(WatchdogRun, run_id)
        if row is None:
            raise HTTPException(404, '巡检记录不存在')
        if row.task_id in operations.watchdog.active or row.status == 'running':
            raise HTTPException(409, '巡检仍在运行')
        if not body.content.strip():
            raise HTTPException(422, '请填写纠正说明或核验证据')
        row.correction = body.content.strip()
        if body.reconcile_unknown and row.status == 'unknown':
            row.status = 'reconciled'
        session.add(db.Event(task_id=row.task_id, source='watchdog', event_type='watchdog_correction', content=row.correction, data={'run_id': run_id, 'actor': principal.user_id}))
        return db.dump(row)
