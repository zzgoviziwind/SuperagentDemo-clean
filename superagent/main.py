import asyncio
import os
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from superagent.core.db import Session, Project, Task, Event, Artifact, Approval, dump, init_db, now
from superagent.core.scheduler import scheduler
from superagent.core import governance as gov
from superagent.core.connections import manager
from superagent.api.governance import router as governance_router
from superagent.api.connections import router as connections_router

@asynccontextmanager
async def lifespan(app):
    init_db()
    # A previous process may have died mid-turn. Its outcome is unknown, never replay automatically.
    with Session.begin() as s:
        s.execute(update(Task).where(Task.status.in_(['running', 'waiting_approval'])).values(status='waiting_resource', outcome_unknown=True, last_error='服务重启，运行结果未知，请人工对账', updated_at=now(), state_version=Task.state_version + 1))
    await scheduler.start()
    await manager.start()
    try:
        yield
    finally:
        try:
            await manager.stop()
        finally:
            await scheduler.close()

app = FastAPI(lifespan=lifespan)

@app.middleware('http')
async def authenticate(request: Request, call_next):
    # Static assets and login must be reachable before a browser has a session.
    if request.url.path.startswith('/api/') and request.url.path not in ('/api/v1/auth/login', '/api/v1/auth/logout'):
        try:
            request.state.principal = gov.authenticate_request(request)
        except HTTPException as exc:
            return JSONResponse({'detail': exc.detail}, status_code=exc.status_code)
    return await call_next(request)

class ProjectIn(BaseModel):
    name: str
    repo_path: str
    base_branch: str = 'main'
    test_command: str = ''
    allowed_paths: list[str] = Field(default_factory=list)
    dingtalk_chat_ids: list[str] = Field(default_factory=list)
    redmine_project_ids: list[str] = Field(default_factory=list)
    enabled: bool = True
class TaskIn(BaseModel):
    kind: str = 'repair'
    title: str
    goal: str
    project_id: int
    acceptance_criteria: str = ''
    source: str = 'web'
class MessageIn(BaseModel):
    content: str
    change_goal: bool = False
    expected_state_version: int | None = None
class ControlIn(BaseModel):
    action: str
    expected_state_version: int | None = None
class AcceptanceIn(BaseModel):
    accepted: bool
    revision: int
    comment: str = ''
class DecisionIn(BaseModel):
    decision: str
    action_hash: str
class ReconciliationIn(BaseModel):
    outcome: str
    evidence: str = Field(min_length=1, max_length=10000)
    expected_state_version: int

def validate_project(values):
    from pathlib import Path
    from superagent.runtime.workspace import validate_allowed_paths
    path=values['repo_path']
    if not os.path.isabs(path) or not os.path.isdir(path):
        raise HTTPException(422, '项目目录必须是存在的绝对路径')
    resolved=Path(path).resolve(strict=True)
    roots=os.getenv('SUPERAGENT_ALLOWED_REPO_ROOTS', '')
    if roots:
        permitted=[Path(p).resolve(strict=True) for p in roots.split(os.pathsep) if p.strip()]
        if not any(resolved==p or p in resolved.parents for p in permitted):
            raise HTTPException(422, '项目目录不在管理员配置的仓库范围内')
    try:
        validate_allowed_paths(str(resolved), [], values['allowed_paths'])
    except (ValueError, OSError) as exc:
        raise HTTPException(422, '允许修改的路径配置无效') from exc
    if not values['name'].strip() or not values['base_branch'].strip() or values['base_branch'].startswith('-'):
        raise HTTPException(422, '项目名称或分支无效')
    values['repo_path']=str(resolved)
    return values

def get(s, cls, ident):
    obj = s.get(cls, ident)
    if obj is None: raise HTTPException(404, '记录不存在')
    return obj

def check_version(t, version):
    if version is not None and version != t.state_version: raise HTTPException(409, '状态已变化，请刷新')

def advance(s, t, values):
    version = t.state_version
    values.update(state_version=version+1, updated_at=now())
    result = s.execute(update(Task).where(Task.id==t.id, Task.state_version==version).values(**values))
    if result.rowcount != 1: raise HTTPException(409, '状态已变化，请刷新')
    s.refresh(t)

def record(s, task_id, kind, content='', data=None):
    e = Event(task_id=task_id, source='web', event_type=kind, content=content, data=data or {})
    s.add(e); s.flush(); return e

@app.get('/health')
def health(): return {'status':'ok','version':'0.1.0'}

@app.get('/api/v1/projects')
def projects():
    with Session() as s: return [dump(x) for x in s.scalars(select(Project)).all()]
@app.post('/api/v1/projects')
def create_project(body: ProjectIn, request: Request):
    gov.require_permission(request.state.principal, 'project.write')
    values=validate_project(body.model_dump())
    with Session.begin() as s:
        p=Project(**values); s.add(p); s.flush()
        gov.audit_action(s,request.state.principal,'project.create',p.id)
        return dump(p)
@app.patch('/api/v1/projects/{ident}')
def edit_project(ident: int, body: dict, request: Request):
    gov.require_permission(request.state.principal, 'project.write')
    allowed=set(ProjectIn.model_fields)
    if set(body)-allowed: raise HTTPException(422, '不支持的项目字段')
    with Session.begin() as s:
        p=get(s,Project,ident); values=validate_project(ProjectIn(**(dump(p)|body)).model_dump())
        for k,v in values.items(): setattr(p,k,v)
        s.flush()
        gov.audit_action(s,request.state.principal,'project.update',p.id)
        return dump(p)
@app.get('/api/v1/tasks')
def tasks(status: str | None=None, project_id: int | None=None):
    with Session() as s:
        q=select(Task).order_by(Task.id.desc())
        if status: q=q.where(Task.status==status)
        if project_id: q=q.where(Task.project_id==project_id)
        return [dump(x) for x in s.scalars(q).all()]
@app.post('/api/v1/tasks')
def create_task(body: TaskIn, request: Request):
    gov.require_permission(request.state.principal, 'task.create')
    if body.kind not in ('repair','analysis'): raise HTTPException(422,'任务类型无效')
    if body.source != 'web': raise HTTPException(403,'仅允许通过事件入口接收外部来源')
    if not body.title.strip() or not body.goal.strip(): raise HTTPException(422,'标题和目标不能为空')
    with Session.begin() as s:
        p=get(s,Project,body.project_id)
        if not p.enabled: raise HTTPException(409,'项目已禁用')
        t=Task(**body.model_dump(), owner_id=request.state.principal.user_id); s.add(t); s.flush()
        gov.assign_task_owner(t.id, request.state.principal.user_id, actor=request.state.principal.user_id, session=s)
        record(s,t.id,'created',body.goal); return dump(t)
@app.get('/api/v1/tasks/{ident}')
def task_detail(ident: int):
    with Session() as s:
        t=get(s,Task,ident)
        return {'task':dump(t), **{key:[dump(x) for x in s.scalars(select(cls).where(cls.task_id==ident)).all()] for key,cls in [('events',Event),('artifacts',Artifact),('approvals',Approval)]}}
@app.post('/api/v1/tasks/{ident}/messages')
async def message(ident: int, body: MessageIn, request: Request):
    if not body.content.strip(): raise HTTPException(422,'内容不能为空')
    interrupt = False
    async with scheduler.lock(ident):
        with Session.begin() as s:
            t=get(s,Task,ident); check_version(t,body.expected_state_version)
            gov.require_permission(request.state.principal, 'task.message', gov.task_owner(ident, s))
            if t.status in ('completed','cancelled'): raise HTTPException(409,'终态任务请另建任务')
            if t.outcome_unknown or t.last_error=='正在停止执行': raise HTTPException(409,'请先核验执行状态再补充任务')
            values={}
            if body.change_goal:
                interrupt=t.status in ('running','waiting_approval')
                values={'goal':body.content,'revision':t.revision+1,'control_version':t.control_version+1}
                if t.status in ('running','review_ready','waiting_approval'): values['status']='waiting_input'
                s.execute(update(Approval).where(Approval.task_id==ident,Approval.status=='pending').values(status='expired'))
            elif t.status=='review_ready':
                # Any new requirement invalidates the completed evidence, even when
                # the user adds context instead of replacing the original goal.
                values={'status':'waiting_input','revision':t.revision+1,'control_version':t.control_version+1,'last_error':'收到新补充，请继续执行后重新验收'}
                s.execute(update(Approval).where(Approval.task_id==ident,Approval.status=='pending').values(status='expired'))
            advance(s,t,values); e=record(s,ident,'goal_changed' if body.change_goal else 'message',body.content); result=dump(e)
            gov.audit_action(s,request.state.principal,'task.message',ident,{'revision':t.revision,'state_version':t.state_version})
    if interrupt: asyncio.create_task(scheduler.stop_run(ident, 'change_goal'))
    elif not body.change_goal:
        stop_after_failure=False
        async with scheduler.lock(ident):
            with Session() as s:
                t=s.get(Task,ident)
                live=t.status in ('running','waiting_approval')
                thread,turn=t.codex_thread_id,t.codex_turn_id
                client=scheduler.clients.get(ident)
            if live:
                try:
                    if not client or not thread or not turn: raise RuntimeError('当前运行尚未准备好接收消息')
                    await client.steer_turn(thread,turn,body.content)
                except Exception:
                    with Session.begin() as s:
                        t=s.get(Task,ident)
                        if t.status in ('running','waiting_approval'):
                            advance(s,t,{'status':'waiting_input','control_version':t.control_version+1,'last_error':'补充消息已保存，但未确认送达执行会话；请恢复任务'})
                            s.execute(update(Approval).where(Approval.task_id==ident,Approval.status=='pending').values(status='expired'))
                            record(s,ident,'steer_unconfirmed'); stop_after_failure=True
        if stop_after_failure: asyncio.create_task(scheduler.stop_run(ident,'change_goal'))
    return result
@app.post('/api/v1/tasks/{ident}/controls')
async def control(ident: int, body: ControlIn, request: Request):
    transitions={'start': {'queued':'queued'}, 'pause': {'queued':'paused','waiting_resource':'paused','waiting_input':'paused','waiting_approval':'waiting_resource','running':'waiting_resource'}, 'resume': {'paused':'queued','waiting_input':'queued'}, 'cancel': {'queued':'cancelled','paused':'cancelled','waiting_input':'cancelled','waiting_resource':'cancelled','waiting_approval':'waiting_resource','running':'waiting_resource','review_ready':'cancelled','failed':'cancelled'}, 'retry': {'failed':'queued'}}
    stop=False
    async with scheduler.lock(ident):
        with Session.begin() as s:
            t=get(s,Task,ident); check_version(t,body.expected_state_version)
            gov.require_permission(request.state.principal, 'task.control', gov.task_owner(ident, s))
            target=transitions.get(body.action,{}).get(t.status)
            if not target: raise HTTPException(409,'当前状态不支持此操作')
            stop=t.status in ('running','waiting_approval') and body.action in ('pause','cancel')
            if t.last_error == '正在停止执行': raise HTTPException(409,'停止执行尚未确认')
            if t.outcome_unknown: raise HTTPException(409,'运行结果未知，须先人工对账')
            if t.status == 'waiting_resource' and t.last_error and ('未知' in t.last_error or '对账' in t.last_error): raise HTTPException(409,'运行结果未知，须先人工对账，暂停也不会清除此状态')
            advance(s,t,{'status':target,'control_version':t.control_version+1,'last_error':'正在停止执行' if stop else None})
            s.execute(update(Approval).where(Approval.task_id==ident,Approval.status=='pending').values(status='expired'))
            record(s,ident,'control',body.action); result=dump(t)
            gov.audit_action(s,request.state.principal,'task.'+body.action,ident,{'status':t.status,'control_version':t.control_version})
    if stop: asyncio.create_task(scheduler.stop_run(ident,body.action))
    return result
@app.post('/api/v1/tasks/{ident}/reconcile')
async def reconcile_task(ident: int, body: ReconciliationIn, request: Request):
    if body.outcome not in ('stopped','abandoned') or not body.evidence.strip():
        raise HTTPException(422,'请提供已停止或放弃的核验结论及证据')
    async with scheduler.lock(ident):
        with Session.begin() as s:
            t=get(s,Task,ident)
            gov.require_permission(request.state.principal,'task.control',gov.task_owner(ident,s))
            check_version(t,body.expected_state_version)
            if not t.outcome_unknown:
                raise HTTPException(409,'此任务没有待对账的未知结果')
            if ident in scheduler.active or ident in scheduler.clients or ident in scheduler.tests:
                raise HTTPException(409,'本地执行尚未退出，不能确认已停止')
            advance(s,t,{'status':'paused' if body.outcome=='stopped' else 'cancelled', 'outcome_unknown':False,'last_error':None,'control_version':t.control_version+1,'revision':t.revision+1})
            s.execute(update(Approval).where(Approval.task_id==ident,Approval.status.in_(['pending','dispatching'])).values(status='expired'))
            record(s,ident,'execution_reconciled',body.evidence,{'outcome':body.outcome})
            gov.audit_action(s,request.state.principal,'task.reconcile',ident,{'status':t.status,'revision':t.revision})
            return dump(t)
@app.post('/api/v1/tasks/{ident}/acceptance')
def accept(ident: int, body: AcceptanceIn, request: Request):
    with Session.begin() as s:
        t=get(s,Task,ident)
        gov.require_permission(request.state.principal, 'task.accept', gov.task_owner(ident, s))
        if t.status!='review_ready' or t.revision!=body.revision: raise HTTPException(409,'版本已变化或任务尚未准备验收')
        if body.accepted and t.kind == 'analysis':
            import json
            from superagent.runtime.workspace import collect_changes
            evidence=s.scalars(select(Artifact).where(Artifact.task_id==ident,Artifact.revision==t.revision,Artifact.kind=='changes').order_by(Artifact.id.desc())).first()
            try:
                previous=json.loads(evidence.content) if evidence else {}
                current=collect_changes(t.workspace_path,previous['base_sha'])
                if current!=previous or current.get('diff') or current.get('status') or current.get('untracked_artifacts'):
                    raise ValueError('analysis changed workspace')
            except (ValueError,OSError,KeyError,TypeError):
                raise HTTPException(409,'只读分析的工作区存在变更或证据不足，无法验收') from None
        if body.accepted and t.kind == 'repair':
            import json
            from superagent.runtime.workspace import collect_changes, validate_workspace_changes
            evidence=s.scalars(select(Artifact).where(Artifact.task_id==ident,Artifact.revision==t.revision,Artifact.kind=='verification').order_by(Artifact.id.desc())).first()
            if not evidence or not json.loads(evidence.content).get('repair_verified'): raise HTTPException(409,'修复差异或测试验证不足，无法验收')
            changes=s.scalars(select(Artifact).where(Artifact.task_id==ident,Artifact.revision==t.revision,Artifact.kind=='changes').order_by(Artifact.id.desc())).first()
            try:
                previous=json.loads(changes.content) if changes else {}
                project=get(s,Project,t.project_id)
                validate_workspace_changes(t.workspace_path,previous['base_sha'],project.allowed_paths)
                current=collect_changes(t.workspace_path,previous['base_sha'])
                if current!=previous: raise ValueError('changed')
            except (ValueError, OSError, KeyError, TypeError):
                raise HTTPException(409,'工作区或允许范围已变化，请重新验证修复') from None
        advance(s,t,{'status':'completed' if body.accepted else 'waiting_input','control_version':t.control_version+1}); record(s,ident,'acceptance',body.comment,{'accepted':body.accepted,'revision':body.revision})
        gov.audit_action(s,request.state.principal,'task.acceptance',ident,{'status':t.status,'revision':t.revision})
        return dump(t)
@app.get('/api/v1/approvals')
def approvals():
    with Session() as s: return [dump(x) for x in s.scalars(select(Approval)).all()]
@app.post('/api/v1/approvals/{ident}/decision')
async def decide(ident: int, body: DecisionIn, request: Request):
    if body.decision not in ('approve','reject'): raise HTTPException(422,'无效决定')
    with Session() as s:
        a=get(s,Approval,ident); task_id=a.task_id
    async with scheduler.lock(task_id):
        with Session.begin() as s:
            a=get(s,Approval,ident); t=get(s,Task,a.task_id)
            gov.require_permission(request.state.principal, 'approval.decide', gov.task_owner(task_id, s))
            if a.action.get('method') not in ('item/fileChange/requestApproval','item/commandExecution/requestApproval'):
                raise HTTPException(409,'请从回复草稿处理这项外部发送审批')
            if a.status!='pending' or a.action_hash!=body.action_hash or a.revision!=t.revision or a.control_version!=t.control_version or t.status!='waiting_approval': raise HTTPException(409,'审批已过期或动作不匹配')
            if body.decision=='approve':
                if t.kind=='analysis': raise HTTPException(409,'只读分析不允许批准扩大执行权限，请拒绝该请求')
                from pathlib import Path
                from superagent.runtime.workspace import validate_allowed_paths
                p=get(s,Project,t.project_id)
                try:
                    if not p.enabled: raise ValueError('disabled')
                    validate_allowed_paths(t.workspace_path,[],p.allowed_paths)
                    if a.action['method']=='item/commandExecution/requestApproval':
                        if '.' not in p.allowed_paths: raise ValueError('command scope')
                    else:
                        grant=a.action.get('params',{}).get('grantRoot')
                        if not isinstance(grant,str) or not os.path.isabs(grant): raise ValueError('missing scope')
                        relative=Path(os.path.abspath(grant)).relative_to(Path(t.workspace_path).resolve()).as_posix()
                        if relative=='.':
                            if '.' not in p.allowed_paths: raise ValueError('root scope')
                        else: validate_allowed_paths(t.workspace_path,[relative],p.allowed_paths)
                except (ValueError,OSError,TypeError):
                    raise HTTPException(409,'项目已禁用或审批超出当前允许范围，请拒绝或重新发起') from None
            client=scheduler.clients.get(task_id)
            if not client: raise HTTPException(409,'执行会话不可用，请人工对账')
            a.status='dispatching'; request_id=a.action['request_id']
            approval_revision=a.revision; approval_control=a.control_version
            record(s,t.id,'approval_decision',body.decision,{'approval_id':ident})
            gov.audit_action(s,request.state.principal,'approval.decide',ident,{'approval_id':ident,'decision':body.decision,'revision':t.revision})
        try:
            await client.respond_approval(request_id,body.decision)
        except Exception:
            with Session.begin() as s:
                a=s.get(Approval,ident); t=s.get(Task,task_id); a.status='unknown'
                values={'outcome_unknown':True,'last_error':'审批响应结果未知，请人工对账'}
                if t.revision==approval_revision and t.control_version==approval_control and t.status=='waiting_approval':
                    values['status']='waiting_resource'
                advance(s,t,values)
                record(s,task_id,'approval_response_unknown',data={'approval_id':ident,'revision':approval_revision})
            raise HTTPException(503,'审批响应结果未知，请人工对账')
        with Session.begin() as s:
            a=s.get(Approval,ident); t=s.get(Task,task_id)
            stale=t.revision!=approval_revision or t.control_version!=approval_control or t.status!='waiting_approval' or a.status!='dispatching'
            if stale:
                a.status='expired_after_dispatch'
                record(s,task_id,'stale_approval_dispatched',body.decision,{'approval_id':ident,'revision':approval_revision})
            else:
                a.status='approved' if body.decision=='approve' else 'rejected'
                s.flush()
                remaining=any(x.action.get('method') in ('item/fileChange/requestApproval','item/commandExecution/requestApproval') for x in s.scalars(select(Approval).where(Approval.task_id==task_id, Approval.revision==t.revision, Approval.control_version==t.control_version, Approval.status=='pending')))
                advance(s,t,{'status':'waiting_approval' if remaining else 'running'})
            result=dump(a)
        if stale: raise HTTPException(409,'审批发送期间需求已变化，旧响应已归档，请核验新任务状态')
        return result
@app.get('/api/v1/artifacts/{ident}')
def artifact(ident: int):
    with Session() as s: return dump(get(s,Artifact,ident))
@app.get('/api/v1/artifacts/{ident}/download')
def download_artifact(ident: int):
    with Session() as s:
        value=dump(get(s,Artifact,ident))
    return JSONResponse(value,headers={'Content-Disposition':f'attachment; filename="artifact-{ident}.json"','Cache-Control':'no-store'})
@app.get('/api/v1/tasks/{ident}/export')
def export_task(ident: int):
    # Export only persisted evidence, never follow a user-supplied filesystem path.
    with Session() as s:
        task=get(s,Task,ident)
        result={'format_version':1,'exported_at':now(),'task':dump(task)}
        for key,cls in [('events',Event),('artifacts',Artifact),('approvals',Approval)]:
            result[key]=[dump(x) for x in s.scalars(select(cls).where(cls.task_id==ident).order_by(cls.id)).all()]
    return JSONResponse(result,headers={'Content-Disposition':f'attachment; filename="task-{ident}-evidence.json"','Cache-Control':'no-store'})
@app.get('/api/v1/overview')
def overview():
    with Session() as s:
        all_tasks=s.scalars(select(Task)).all(); pending=s.scalars(select(Approval).where(Approval.status=='pending')).all()
        counts={}
        for t in all_tasks: counts[t.status]=counts.get(t.status,0)+1
        return {'counts':counts,'active_tasks':[dump(t) for t in all_tasks if t.status not in ('completed','cancelled')], 'pending_approvals':[dump(a) for a in pending], 'connectors':manager.statuses()}
@app.get('/api/v1/events/stream')
async def stream(request: Request, after: int = 0):
    async def generate():
        import json
        cursor=max(0, after)
        while not await request.is_disconnected():
            gov.authenticate_request(request)
            with Session() as s:
                rows=s.scalars(select(Event).where(Event.id > cursor).order_by(Event.id).limit(100)).all()
                items=[{'id':e.id,'task_id':e.task_id,'event_type':e.event_type,'created_at':e.created_at} for e in rows]
            for item in items:
                cursor=item['id']
                yield f'id: {cursor}\ndata: {json.dumps(item)}\n\n'
            if not items: yield ': heartbeat\n\n'
            await asyncio.sleep(2)
    return StreamingResponse(generate(),media_type='text/event-stream')

app.include_router(governance_router)
app.include_router(connections_router)

# Serve the built workspace only when it exists; API routes always take precedence.
from pathlib import Path
from fastapi.staticfiles import StaticFiles
web_dist = Path(__file__).resolve().parent.parent / 'apps' / 'web' / 'dist'
if web_dist.is_dir():
    app.mount('/', StaticFiles(directory=web_dist, html=True), name='web')
