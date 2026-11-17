from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import select
from superagent.core.db import Session, Project, Task, Event, Artifact, dump
from superagent.core.sessions import RouterSession, RouterMessage, RoutingSession, RoutingMessage
from superagent.core import governance as gov
from superagent.core.semantic_routing import SemanticRoutingJob, semantic_routing_service
from superagent.core.subscriptions import EventTarget

router = APIRouter(prefix='/api/v1/sessions', tags=['sessions'])

class ReconcileIn(BaseModel):
    evidence: str = Field(min_length=1, max_length=10000)
    expected_state_version: int

class MessageIn(BaseModel):
    content: str = Field(min_length=1, max_length=100000)
    change_goal: bool = False
    expected_state_version: int | None = None

def parse_id(ident):
    try:
        kind, raw = ident.split(':', 1)
        number = int(raw)
        if kind not in ('worker', 'router', 'semantic') or number <= 0: raise ValueError()
        return kind, number
    except ValueError:
        raise HTTPException(404, '会话不存在')

def allowed_worker(s, t, principal):
    return principal.role == 'admin' or (principal.role == 'member' and gov.task_owner(t.id, s) == principal.user_id)

def worker(t):
    return {'id':f'worker:{t.id}', 'kind':'worker', 'task_kind':t.kind, 'project_id':t.project_id, 'task_id':t.id, 'title':t.title, 'status':t.status, 'codex_thread_id':t.codex_thread_id, 'state_version':t.state_version, 'mode':'codex'}

def route(p, rs):
    return {'id':f'router:{p.id}', 'kind':'router', 'project_id':p.id, 'task_id':None, 'title':p.name, 'status':rs.status if rs else 'idle', 'codex_thread_id':rs.codex_thread_id if rs else None, 'state_version':rs.state_version if rs else 1, 'outcome_unknown':rs.outcome_unknown if rs else False, 'last_error':rs.last_error if rs else None, 'mode':'agent' if gov.settings_snapshot().get('router_agent_enabled', False) else 'rules'}


def semantic_session(s, job):
    row = s.get(RoutingSession, job.event_id)
    event = s.get(Event, job.event_id)
    task_ids = set(s.scalars(select(EventTarget.task_id).where(EventTarget.event_id == job.event_id)))
    if event and event.task_id:
        task_ids.add(event.task_id)
    return {'id': f'semantic:{job.event_id}', 'kind': 'routing', 'project_id': job.project_id or None,
            'task_id': None, 'event_id': job.event_id, 'title': event.content[:100] if event else f'事件 {job.event_id}',
            'status': row.status if row else job.status, 'routing_status': job.status,
            'codex_thread_id': job.thread_id, 'codex_turn_id': job.turn_id,
            'state_version': row.state_version if row else 1,
            'outcome_unknown': bool((row and row.outcome_unknown) or job.status == 'unknown'),
            'last_error': row.last_error if row and row.last_error else job.error,
            'mode': 'agent' if job.turn_id else 'pending' if job.status in {'queued', 'running'} else 'unknown' if job.status == 'unknown' else 'rules',
            'ai_invoked': bool(job.turn_id),
            'worker_session_ids': [f'worker:{ident}' for ident in sorted(task_ids)]}


def semantic_messages(s, job):
    messages = [dump(m) for m in s.scalars(select(RoutingMessage).where(
        RoutingMessage.event_id == job.event_id).order_by(RoutingMessage.id))]
    if not any(m['data'].get('source') == 'model_context' for m in messages):
        import json
        messages.insert(0, {'id': f'legacy-input:{job.event_id}', 'role': 'user',
            'content': json.dumps(job.context, ensure_ascii=False), 'created_at': job.created_at,
            'data': {'historical_snapshot': True, 'source': 'model_context'}})
    if job.output and not any(m['role'] == 'assistant' and m['content'] == job.output for m in messages):
        messages.append({'id': f'legacy-output:{job.event_id}', 'role': 'assistant', 'content': job.output,
            'created_at': job.updated_at, 'data': {'historical_snapshot': True, 'source': 'saved_model_output'}})
    return messages

@router.get('')
def list_sessions(request: Request, project_id: int | None = None):
    principal=request.state.principal
    with Session() as s:
        tq=select(Task).order_by(Task.id.desc())
        pq=select(Project).order_by(Project.id)
        if project_id is not None:
            tq=tq.where(Task.project_id==project_id); pq=pq.where(Project.id==project_id)
        result=[worker(t) for t in s.scalars(tq).all() if allowed_worker(s,t,principal)]
        if principal.role == 'admin':
            result += [route(p,s.get(RouterSession,p.id)) for p in s.scalars(pq).all()]
            jq = select(SemanticRoutingJob).order_by(SemanticRoutingJob.event_id.desc())
            if project_id is not None:
                jq = jq.where(SemanticRoutingJob.project_id == project_id)
            result += [semantic_session(s, job) for job in s.scalars(jq)]
        return result

@router.get('/{ident}')
def session_detail(ident: str, request: Request):
    kind, number=parse_id(ident)
    with Session() as s:
        if kind == 'semantic':
            job = s.get(SemanticRoutingJob, number)
            if request.state.principal.role != 'admin' or not job:
                raise HTTPException(404, '会话不存在')
            return {'session': semantic_session(s, job), 'messages': semantic_messages(s, job),
                    'transcript': {'complete': False, 'source': 'persisted_visible_messages',
                                   'reason': '平台保存的可见消息，完整模型项目记录请读取 transcript 接口'}}
        if kind == 'router':
            if request.state.principal.role != 'admin': raise HTTPException(404, '会话不存在')
            p=s.get(Project,number)
            if not p: raise HTTPException(404, '会话不存在')
            messages=[dump(m) for m in s.scalars(select(RouterMessage).where(RouterMessage.project_id==number).order_by(RouterMessage.id)).all()]
            return {'session':route(p,s.get(RouterSession,number)), 'messages':messages,
                    'transcript': {'complete': False, 'source': 'persisted_visible_messages',
                                   'reason': '平台可见消息记录，完整模型记录需读取 transcript'}}
        t=s.get(Task,number)
        if not t or not allowed_worker(s,t,request.state.principal): raise HTTPException(404, '会话不存在')
        events=s.scalars(select(Event).where(Event.task_id==number).order_by(Event.id)).all()
        from superagent.core.subscriptions import EventTarget
        delivered_ids = set(s.scalars(select(EventTarget.message_event_id).where(EventTarget.task_id == number)))
        def source_message(event):
            status = (event.data or {}).get('routing_status')
            return event.source in ('dingtalk', 'redmine') and (
                status in ('routed', 'self_context', 'manually_linked') or (status == 'delivered' and event.id in delivered_ids))
        visible=[e for e in events if (e.source == 'coordination' and e.event_type == 'collaboration_result') or (e.source == 'web' and e.event_type in ('created','message','goal_changed','project_rebound')) or (e.source == 'runtime' and e.event_type == 'assistant_message') or source_message(e)]
        from superagent.core.message_context import describe_message, message_time
        messages=[{'id':f'event:{e.id}','role':'assistant' if e.source=='runtime' and e.event_type=='assistant_message' else 'user',
                   'content':e.content,'created_at':message_time(e),
                   'data': {k: v for k, v in describe_message(e).items() if k in {'sender','source','direction'}}}
                  for e in visible if e.content]
        linked={e.data.get('artifact_id') for e in visible if e.source == 'runtime' and e.event_type == 'assistant_message' and isinstance(e.data,dict)}
        messages += [{'id':f'artifact:{a.id}','role':'assistant','content':a.content,'created_at':a.created_at} for a in s.scalars(select(Artifact).where(Artifact.task_id==number,Artifact.kind=='summary')).all() if a.id not in linked]
        if not any((e.source == 'web' and e.event_type == 'created') or source_message(e) for e in visible):
            messages.append({'id':f'goal:{t.id}','role':'user','content':t.goal,'created_at':t.created_at})
        from superagent.connectors.common import timestamp
        messages.sort(key=lambda x:(timestamp(x['created_at']), x['id']))
        return {'session':worker(t),'messages':messages,
                'transcript': {'complete': False, 'source': 'persisted_visible_messages',
                               'reason': '历史可能只有任务摘要，完整可见记录需读取 transcript'}}

@router.post('/{ident}/messages')
async def post_message(ident: str, body: MessageIn, request: Request):
    kind, number=parse_id(ident)
    if not body.content.strip(): raise HTTPException(422, '内容不能为空')
    if kind == 'semantic':
        if request.state.principal.role != 'admin':
            raise HTTPException(404, '会话不存在')
        try:
            return semantic_routing_service.enqueue_review(number, body.content, body.expected_state_version,
                actor=request.state.principal.user_id)
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from None
    if kind == 'worker':
        with Session() as s:
            t=s.get(Task,number)
            if not t or not allowed_worker(s,t,request.state.principal): raise HTTPException(404, '会话不存在')
        from superagent.main import message, MessageIn as TaskMessageIn
        return await message(number,TaskMessageIn(**body.model_dump()),request)
    if request.state.principal.role != 'admin': raise HTTPException(404, '会话不存在')
    if len(body.content) > 20000: raise HTTPException(422, '内容过长')
    with Session() as s:
        if not s.get(Project,number): raise HTTPException(404, '会话不存在')
    from superagent.core.router_agent import router_agent
    return await router_agent.enqueue(number, body.content, body.expected_state_version, actor=request.state.principal.user_id)

@router.post('/{ident}/reconcile')
async def reconcile(ident: str, body: ReconcileIn, request: Request):
    kind, number = parse_id(ident)
    if kind == 'semantic' and request.state.principal.role == 'admin':
        try:
            return await semantic_routing_service.reconcile(number, body.evidence, body.expected_state_version,
                actor=request.state.principal.user_id)
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from None
    if kind != 'router' or request.state.principal.role != 'admin':
        raise HTTPException(404, '会话不存在')
    from superagent.core.router_agent import router_agent
    return await router_agent.reconcile(number, body.evidence, body.expected_state_version, actor=request.state.principal.user_id)


@router.get('/{ident}/transcript')
async def session_transcript(ident: str, request: Request):
    from superagent.core.scheduler import scheduler, executable
    from superagent.core.router_agent import router_agent
    from superagent.runtime.codex import CodexAppServer
    from pathlib import Path
    import os
    kind, number = parse_id(ident)
    detail = session_detail(ident, request)
    thread_id = detail['session'].get('codex_thread_id')
    fallback = {'session_id': ident, 'thread_id': thread_id, 'source': 'persisted_visible_messages',
                'complete': False, 'items': detail['messages'],
                'reason': '历史仅有平台保存消息，未取得完整 Codex 可见记录'}
    if not thread_id:
        fallback['reason'] = '尚无真实 Codex 线程，当前显示平台记录'
        return fallback
    client = None
    owned = False
    try:
        if kind == 'semantic':
            client = semantic_routing_service.clients.get(number)
        elif kind == 'worker':
            client = scheduler.clients.get(number)
        else:
            client = router_agent.clients.get(number)
        if client is not None:
            try:
                raw = await client.read_thread(thread_id, include_turns=True)
            except Exception:
                # The execution owner may close its client immediately after completion.
                # Leave that client under its owner's control and retry through a reader.
                client = None
        if client is None:
            with Session() as session:
                if kind == 'worker':
                    from superagent.core.execution_nodes import ProjectNodeBinding
                    task = session.get(Task, number)
                    binding = session.get(ProjectNodeBinding, task.project_id)
                    if binding and binding.node_id:
                        fallback['reason'] = '远端会话当前无可用读取连接，保留平台历史'
                        return fallback
            root = Path(os.getenv('SUPERAGENT_ROUTER_ROOT', './data/router-workspaces')).resolve() / 'transcript-reader'
            root.mkdir(parents=True, exist_ok=True)
            from superagent.core.local_agents import client_options
            client = CodexAppServer(executable(), str(root), **client_options())
            owned = True
            await client.start()
            raw = await client.read_thread(thread_id, include_turns=True)
        thread = raw.get('thread', raw)
        if thread.get('id') != thread_id or not isinstance(thread.get('turns'), list):
            raise ValueError('Codex 返回记录与平台会话不匹配')
        items = []
        for turn in thread['turns']:
            for item in turn.get('items', []):
                if item.get('type') in {'userMessage', 'agentMessage', 'commandExecution', 'fileChange',
                        'mcpToolCall', 'dynamicToolCall', 'webSearch', 'imageView', 'enteredReviewMode',
                        'exitedReviewMode', 'contextCompaction', 'error'}:
                    items.append({'turn_id': turn.get('id'), **item})
        return {'session_id': ident, 'thread_id': thread_id, 'source': 'codex_thread',
                'complete': True, 'items': items, 'reason': None}
    except Exception as exc:
        fallback['reason'] = '模型会话读取暂不可用（' + type(exc).__name__ + '），平台历史可能不完整'
        return fallback
    finally:
        if owned and client:
            try:
                await client.close()
            except Exception as exc:
                import logging
                logging.getLogger(__name__).error('会话只读连接清理失败（%s）', type(exc).__name__)

@router.post('/{ident}/handoff')
async def handoff_material(ident: str, request: Request):
    """Only expose continuation material once execution has actually stopped."""
    from superagent.core.scheduler import scheduler
    kind, number = parse_id(ident)
    if kind != 'worker':
        raise HTTPException(422, '请从事件的执行任务接管')
    async with scheduler.lock(number):
        with Session.begin() as s:
            t = s.get(Task, number)
            if not t or not allowed_worker(s, t, request.state.principal):
                raise HTTPException(404, '任务不存在')
            if (t.status not in {'paused', 'failed', 'review_ready', 'completed', 'cancelled'}
                    or t.outcome_unknown or number in scheduler.active
                    or number in scheduler.clients or number in scheduler.tests):
                raise HTTPException(409, '请先暂停任务并等待执行退出；未知结果须先核验')
            from superagent.core.execution_nodes import ProjectNodeBinding
            from superagent.core.db import Approval
            from sqlalchemy import update
            binding = s.get(ProjectNodeBinding, t.project_id)
            if binding and binding.node_id:
                raise HTTPException(409, '远端执行任务需先在执行设备核验并接管，暂不提供本机接管')
            if t.status not in {'completed', 'cancelled'}:
                t.status = 'paused'
                t.state_version += 1
                t.control_version += 1
                s.execute(update(Approval).where(Approval.task_id == number,
                    Approval.status == 'pending').values(status='expired'))
            s.add(Event(task_id=number, source='web', event_type='manual_handoff', content='已准备人工接管材料'))
            project = s.get(Project, t.project_id)
            summary = s.scalars(select(Artifact).where(Artifact.task_id == number,
                Artifact.kind == 'summary').order_by(Artifact.id.desc())).first()
            text = '\n'.join([
                f'继续事件任务 #{t.id}：{t.title}', f'目标：{t.goal}',
                f'验收要求：{t.acceptance_criteria}',
                f'工作目录：{t.workspace_path or (project.repo_path if project else "尚未创建")}',
                f'原 Codex 会话：{t.codex_thread_id or "尚未创建"}',
                f'当前状态：{t.status}；任务版本：{t.state_version}',
                f'最近交付摘要：{summary.content if summary else "暂无"}',
                '先核对现有修改与执行证据，再继续。不要自动对外回复、提交、部署或修改业务数据库。',
                '平台任务需保持暂停；人工操作结果不会自动同步回平台，请返回事件补充验收证据。'])
            return {'task_id': number, 'thread_id': t.codex_thread_id,
                    'workspace_path': t.workspace_path, 'content': text}

class CoordinationIn(BaseModel):
    target_task_id: int
    event_id: int | None = None
    source_reference: str = Field(default='', max_length=1000)
    evidence: str = Field(min_length=1, max_length=10000)
    expected_state_version: int
    request_key: str = Field(min_length=1, max_length=120)


@router.post('/{ident}/coordination')
def request_coordination(ident: str, body: CoordinationIn, request: Request):
    detail = session_detail(ident, request)
    with Session.begin() as s:
        target = s.get(Task, body.target_task_id)
        if not target or not allowed_worker(s, target, request.state.principal):
            raise HTTPException(404, '目标任务不存在')
        if target.project_id != detail['session']['project_id']:
            raise HTTPException(409, '不允许跨项目关联')
        for old in s.scalars(select(Event).where(Event.task_id == target.id, Event.event_type == 'coordination_request')):
            if old.data.get('request_key') == body.request_key:
                if old.data.get('request') != body.model_dump():
                    raise HTTPException(409, '请求键已用于其他内容')
                return dump(old)
        if target.state_version != body.expected_state_version:
            raise HTTPException(409, '目标任务版本已变化')
        if body.event_id is None and not body.source_reference.strip():
            raise HTTPException(422, '请提供待获取来源的明确编号或引用')
        if body.event_id is not None and not s.get(Event, body.event_id):
            raise HTTPException(404, '来源事件不存在')
        row = Event(task_id=target.id, source='web', event_type='coordination_request', content=body.evidence,
            data={'request_key': body.request_key, 'request': body.model_dump(), 'session_id': ident,
                  'actor': request.state.principal.user_id, 'status': 'pending' if body.event_id else 'awaiting_source'})
        s.add(row); s.flush()
        return dump(row)


@router.get('/{ident}/coordination')
def list_coordination(ident: str, request: Request):
    detail = session_detail(ident, request)
    with Session() as s:
        ids = select(Task.id).where(Task.project_id == detail['session']['project_id'])
        if detail['session']['kind'] == 'worker':
            ids = ids.where(Task.id == detail['session']['task_id'])
        return [dump(row) for row in s.scalars(select(Event).where(Event.task_id.in_(ids), Event.event_type == 'coordination_request').order_by(Event.id))]


@router.post('/{ident}/coordination/{request_id}/apply')
async def apply_coordination(ident: str, request_id: int, request: Request):
    if request.state.principal.role != 'admin':
        raise HTTPException(403, '仅管理员可应用调配')
    detail = session_detail(ident, request)
    from superagent.core.scheduler import scheduler
    from superagent.core.ingestion import trusted_actor
    from superagent.core.subscriptions import authorized_task, deliver_target
    with Session() as s:
        row = s.get(Event, request_id)
        if not row or row.event_type != 'coordination_request':
            raise HTTPException(404, '申请不存在')
        task_id = row.task_id
    async with scheduler.lock(task_id):
        with Session.begin() as s:
            row = s.get(Event, request_id)
            target = s.get(Task, task_id)
            if target.project_id != detail['session']['project_id']:
                raise HTTPException(409, '不允许跨项目调配')
            if row.data['status'] == 'applied':
                return dump(row)
            body = row.data['request']
            event = s.get(Event, body['event_id']) if body['event_id'] else None
            if not event:
                raise HTTPException(409, '来源尚未获取，不能应用')
            actor = trusted_actor(event.source, str(event.data.get('actor_id', '')))
            project = s.get(Project, target.project_id)
            if not authorized_task(s, target, project, actor):
                raise HTTPException(403, '来源身份无权访问目标任务')
            external = str(event.data.get('project_external_id') or '')
            bindings = project.dingtalk_chat_ids if event.source == 'dingtalk' else project.redmine_project_ids
            if external not in {str(value) for value in bindings}:
                raise HTTPException(409, '来源未绑定目标项目')
            if target.state_version != body['expected_state_version']:
                raise HTTPException(409, '目标任务版本已变化，请重新申请')
            if target.status in {'running', 'waiting_approval'} or task_id in scheduler.active or task_id in scheduler.clients:
                raise HTTPException(409, '请先暂停目标 Worker 并等待执行退出')
            linked = set(s.scalars(select(EventTarget.task_id).where(EventTarget.event_id == event.id)))
            if event.task_id: linked.add(event.task_id)
            for old_id in linked - {task_id}:
                old_task = s.get(Task, old_id)
                if not old_task or old_task.project_id != target.project_id:
                    raise HTTPException(409, '事件已有跨项目关联，不能追加')
            if task_id not in linked:
                deliver_target(s, event, target, actor)
            row.data = {**row.data, 'status': 'applied', 'applied_by': request.state.principal.user_id,
                        'retained_task_ids': sorted(linked - {task_id}),
                        'effect': '追加事件关联；保留原任务及其执行证据，不停止或迁移原 Worker'}
            return dump(row)
