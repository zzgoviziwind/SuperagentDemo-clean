"""Authenticated intake, evidence-backed drafts and the two review gates."""
import asyncio
import base64
import binascii
import hashlib
import json
import os
from pathlib import Path
from typing import Literal
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import select, update

from superagent.api.event_groups import owned, require_triage_admin, version
from superagent.connectors.attachments import output_directory, validate_content, validate_filename
from superagent.connectors.common import ConnectorError
from superagent.core import db, governance as gov
from superagent.core.db import Approval, Artifact, Event, Project, Task, dump
from superagent.core.field_intake import FieldCandidate, FieldRecord, FieldTimeline, organize_sample
from superagent.core.field_organizer import OrganizerError, evidence_index, local_ocr, model_organize, organizer_mode
from superagent.core.field_timeline import TimelineImport
from superagent.core.field_media import FieldMediaJob
from superagent.core.scheduler import load_attachments

router = APIRouter(prefix='/api/v1/field-intake', tags=['field-intake'])
IMAGE_LIMIT = 2 * 1024 * 1024
LINKABLE = {'queued', 'paused', 'waiting_input', 'review_ready', 'failed'}
FIELD_SOURCE = 'field'


class ImageInput(BaseModel):
    filename: str
    mime: Literal['image/png', 'image/jpeg', 'image/webp']
    base64: str = Field(max_length=4 * ((IMAGE_LIMIT + 2) // 3))


class RecordInput(BaseModel):
    project_id: int
    title: str = Field(min_length=1, max_length=200)
    notes: str = Field(default='', max_length=10000)
    screenshots: list[ImageInput] = Field(default_factory=list, max_length=5)
    timeline: TimelineImport | None = None


class DecisionInput(BaseModel):
    action: Literal['create', 'link', 'dismiss']
    title: str = Field(default='', max_length=200)
    detail: str = Field(default='', max_length=2500)
    kind: Literal['bug', 'requirement', 'question'] = 'question'
    task_id: int | None = None
    expected_state_version: int | None = None


class ImplementationInput(BaseModel):
    expected_state_version: int
    scope: str = Field(min_length=1, max_length=4000)
    acceptance_criteria: str = Field(min_length=1, max_length=4000)


def project_for(session, ident):
    project = session.get(Project, ident)
    if not project or project.archived or not project.enabled:
        raise HTTPException(422, '请选择可用项目')
    return project


def image_view(image, number):
    return {'id': number, 'filename': image['filename'], **({'at_ms': image['at_ms']} if 'at_ms' in image else {})}


def playback_info(session, ident):
    job = session.get(FieldMediaJob, ident)
    if job and job.state == 'ready':
        return {key: job.media[key] for key in ('video', 'duration_ms')}
    return None


def record_view(session, row):
    candidates = [dump(item) for item in session.scalars(select(FieldCandidate)
                  .where(FieldCandidate.record_id == row.id).order_by(FieldCandidate.id))]
    return {**dump(row), 'organizer': candidates[0]['draft'].get('organizer', 'offline_sample'),
            'timeline_imported': session.get(FieldTimeline, row.id) is not None,
            'media': playback_info(session, row.id),
            'screenshots': [image_view(image, index) for index, image in enumerate(row.screenshots, 1)],
            'candidates': candidates}


@router.get('/organizer')
def get_organizer(request: Request):
    require_triage_admin(request)
    return {'mode': organizer_mode()}


@router.get('/records')
def records(request: Request):
    require_triage_admin(request)
    with db.Session() as session:
        rows = session.scalars(select(FieldRecord).order_by(FieldRecord.created_at.desc()).limit(50))
        return [dict(id=row.id, title=row.title, project_id=row.project_id, created_at=row.created_at) for row in rows]


@router.post('/records')
def create_record(body: RecordInput, request: Request):
    require_triage_admin(request)
    notes = body.notes.strip()
    if not body.title.strip() or not (notes or body.screenshots or body.timeline):
        raise HTTPException(422, '请填写标题并提供现场笔记、截图或带时间的转写')
    mode = organizer_mode()
    frames = {frame.filename.casefold(): frame for frame in body.timeline.keyframes} if body.timeline else {}
    transcript = body.timeline.segments() if body.timeline else []
    if body.timeline:
        if mode == 'offline_sample':
            raise HTTPException(409, '请使用已连接 Codex 的整理模式导入时间轴')
        submitted = [image.filename.casefold() for image in body.screenshots]
        if len(set(submitted)) != len(submitted) or set(submitted) != set(frames):
            raise HTTPException(422, '上传截图须与导入文件中的关键截图文件名一一对应')
    with db.Session() as session:
        project_for(session, body.project_id)
    decoded = []
    for image in body.screenshots:
        try:
            validate_filename(image.filename)
            data = base64.b64decode(image.base64, validate=True)
            if len(data) > IMAGE_LIMIT:
                raise ValueError('截图超限')
            validate_content(data, image.mime)
        except (ConnectorError, ValueError, binascii.Error):
            raise HTTPException(422, '截图名称、格式或大小无效') from None
        decoded.append((image, data))
    ident = str(uuid4())
    paths = []
    try:
        entries = []
        if decoded:
            root = output_directory(Path(os.getenv('SUPERAGENT_ATTACHMENTS_ROOT', './data/attachments')) / 'field' / ident)
            for index, (image, data) in enumerate(decoded, 1):
                suffix = {'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp'}[image.mime]
                path = root / f'{index}.{suffix}'
                with path.open('xb') as file:
                    paths.append(path)
                    file.write(data)
                entries.append(dict(filename=image.filename, local_path=str(path), size=len(data),
                                    content_type=image.mime, sha256=hashlib.sha256(data).hexdigest()))
        if mode == 'offline_sample':
            drafts = organize_sample(notes, len(entries))
        else:
            if body.timeline:
                for entry in entries:
                    frame = frames[entry['filename'].casefold()]
                    entry.update(at_ms=frame.at_ms, ocr=[line.model_dump(exclude_none=True) for line in frame.ocr])
                evidence = evidence_index(notes, [entry['ocr'] for entry in entries], transcript,
                                          [entry['at_ms'] for entry in entries])
            else:
                evidence = evidence_index(notes, local_ocr(paths))
            if not evidence:
                raise HTTPException(422, '截图未识别出文字，请补充可描述问题的现场笔记')
            try:
                drafts = asyncio.run(model_organize(ident, evidence, request.state.principal.user_id))
            except ValueError as error:
                raise HTTPException(409, str(error)) from None
        if not drafts or len(drafts) > 50:
            raise HTTPException(422, '材料未能整理出 1 至 50 条可核对事项，请补充或缩减材料')
        with db.Session.begin() as session:
            project_for(session, body.project_id)
            row = FieldRecord(id=ident, project_id=body.project_id, title=body.title.strip(), notes=notes,
                              screenshots=entries, owner_id=request.state.principal.user_id)
            session.add(row)
            if transcript:
                session.add(FieldTimeline(record_id=ident, transcript=transcript))
            session.add_all(FieldCandidate(record_id=ident, draft=draft) for draft in drafts)
            session.flush()
            return record_view(session, row)
    except Exception as error:
        for path in paths:
            path.unlink(missing_ok=True)
        if paths:
            paths[0].parent.rmdir()
        if isinstance(error, OrganizerError):
            raise HTTPException(503, str(error)) from None
        raise


@router.get('/records/{ident}')
def get_record(ident: str, request: Request):
    require_triage_admin(request)
    with db.Session() as session:
        row = session.get(FieldRecord, ident)
        if not row:
            raise HTTPException(404, '现场记录不存在')
        return record_view(session, row)


@router.get('/records/{ident}/screenshots/{number}')
def get_screenshot(ident: str, number: int, request: Request):
    require_triage_admin(request)
    with db.Session() as session:
        row = session.get(FieldRecord, ident)
        if not row or not 1 <= number <= len(row.screenshots):
            raise HTTPException(404, '截图不存在')
        image = row.screenshots[number - 1]
        try:
            paths, _, _ = load_attachments([json.dumps(image)])
            data = Path(paths[0]).read_bytes()
            if hashlib.sha256(data).hexdigest() != image['sha256']:
                raise ValueError('截图校验失败')
        except (OSError, ValueError):
            raise HTTPException(404, '截图不可用') from None
        return Response(data, media_type=image['content_type'],
                        headers={'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff'})


@router.get('/records/{ident}/transcript/{segment_id}')
def get_segment(ident: str, segment_id: str, request: Request):
    require_triage_admin(request)
    with db.Session() as session:
        timeline = session.get(FieldTimeline, ident)
        segment = next((row for row in timeline.transcript if row['id'] == segment_id), None) if timeline else None
        if segment is None:
            raise HTTPException(404, '转写片段不存在')
        return segment


@router.get('/records/{ident}/targets')
def link_targets(ident: str, request: Request):
    require_triage_admin(request)
    with db.Session() as session:
        row = session.get(FieldRecord, ident)
        if not row:
            raise HTTPException(404, '现场记录不存在')
        items = session.scalars(select(Task).where(Task.project_id == row.project_id, Task.kind == 'analysis',
                    Task.status.in_(LINKABLE), Task.outcome_unknown.is_(False)).order_by(Task.id.desc()).limit(100))
        return [dict(id=task.id, title=task.title, state_version=task.state_version) for task in items]


def add_field_images(session, task, images):
    existing = set(field_images(session, task))
    channel_images = list(session.scalars(select(Artifact.id).where(Artifact.task_id == task.id,
                          Artifact.revision == task.revision, Artifact.kind == 'source_attachment')))
    images = set(images) - existing
    if len(images | existing) + len(channel_images) > 10:
        raise HTTPException(409, '当前事件附件超限，请创建新的只读事件')
    session.add_all(Artifact(task_id=task.id, revision=task.revision, kind='field_attachment', content=image)
                    for image in sorted(images))


def field_images(session, task):
    return list(session.scalars(select(Artifact.content).where(Artifact.task_id == task.id,
                Artifact.kind == 'field_attachment')))


def verified_summary(session, task):
    def latest(kind):
        return session.scalar(select(Artifact).where(Artifact.task_id == task.id,
                              Artifact.revision == task.revision, Artifact.kind == kind)
                              .order_by(Artifact.id.desc()).limit(1))

    evidence, summary = latest('verification'), latest('summary')
    if not evidence or not summary or not summary.content.strip() or evidence.attempt_id != summary.attempt_id:
        return None
    try:
        proof = json.loads(evidence.content)
        read_calls = proof['analysis_read_evidence']['evidence_calls']
        return summary if proof['has_changes'] is False and type(read_calls) is int and read_calls > 0 else None
    except (ValueError, KeyError, TypeError):
        return None


@router.post('/candidates/{ident}/decision')
def decide_candidate(ident: int, body: DecisionInput, request: Request):
    require_triage_admin(request)
    principal = request.state.principal
    payload = body.model_dump()
    with db.Session.begin() as session:
        # First statement takes the write lock on SQLite and locks the row on PostgreSQL.
        session.execute(update(FieldCandidate).where(FieldCandidate.id == ident).values(draft=FieldCandidate.draft))
        item = session.get(FieldCandidate, ident)
        if not item:
            raise HTTPException(404, '候选事项不存在')
        if item.decision:
            if item.decision['request'] != payload:
                raise HTTPException(409, '候选事项已审核')
            return dump(item)
        task = None
        event_id = None
        if body.action != 'dismiss':
            gov.require_permission(principal, 'task.create')
            row = session.get(FieldRecord, item.record_id)
            project_for(session, row.project_id)
            if not body.title.strip() or not body.detail.strip():
                raise HTTPException(422, '请填写事项标题和内容')
            content = f'{body.title.strip()}\n{body.detail.strip()}'
            quote = item.draft.get('quote')
            if quote:
                content += f'\n现场笔记第 {item.draft["note_line"]} 行：{quote}'
            evidence = item.draft.get('evidence', [])
            if evidence:
                content += '\n现场证据：' + '\n'.join(f'{ref["id"]} {ref["text"][:150]}' for ref in evidence)
            images = [json.dumps(row.screenshots[i - 1], ensure_ascii=False) for i in item.draft['screenshots']]
            if body.action == 'create':
                goal = '只读排查疑似问题并给出可核对的线索' if body.kind == 'bug' else '只读评估可行性并列出待澄清事项'
                task = Task(project_id=row.project_id, owner_id=principal.user_id, title=body.title.strip(),
                            kind='analysis', goal=goal + '。\n' + content, source=FIELD_SOURCE)
                session.add(task)
                session.flush()
                gov.assign_task_owner(task.id, principal.user_id, actor=principal.user_id, session=session)
            else:
                task = owned(session, body.task_id, request)
                if (task.project_id != row.project_id or task.kind != 'analysis' or task.status not in LINKABLE
                        or body.expected_state_version is None):
                    raise HTTPException(409, '请关联同项目可补充的只读事件')
                version(session, task, body.expected_state_version)
                prior_attachments = list(session.scalars(select(Artifact.content).where(Artifact.task_id == task.id,
                    Artifact.revision == task.revision, Artifact.kind == 'source_attachment')))
                task.revision += 1
                task.control_version += 1
                session.add_all(Artifact(task_id=task.id, revision=task.revision, kind='source_attachment', content=entry)
                                for entry in prior_attachments)
                session.execute(update(Approval).where(Approval.task_id == task.id, Approval.status == 'pending')
                                .values(status='expired'))
                if task.status != 'paused':
                    task.status, task.last_error = 'queued', None
            add_field_images(session, task, images)
            receipt = Event(task_id=task.id, source=FIELD_SOURCE, external_id=f'candidate:{ident}',
                            event_type='message.received', content=content,
                            data=dict(actor_id=principal.user_id, routing_status='manually_linked',
                                      field_record_id=row.id, candidate_id=ident, field_kind=body.kind,
                                      field_evidence=evidence,
                                      field_media=playback_info(session, row.id),
                                      screenshots=[image_view(row.screenshots[i - 1], i)
                                                   for i in item.draft['screenshots']]))
            session.add(receipt)
            session.flush()
            event_id = receipt.id
        item.decision = dict(request=payload, actor=principal.user_id, event_id=event_id,
                             task_id=task.id if task else None, decided_at=db.now())
        gov.audit_action(session, principal, f'field.candidate.{body.action}', ident,
                         {'task_id': item.decision['task_id'], 'source': FIELD_SOURCE, 'decision': body.action})
        return dump(item)


@router.post('/analysis/{ident}/implement')
def implement(ident: int, body: ImplementationInput, request: Request):
    require_triage_admin(request)
    principal = request.state.principal
    gov.require_permission(principal, 'task.create')
    with db.Session.begin() as session:
        # Serialize against changes to the approved analysis and other approval clicks.
        session.execute(update(Task).where(Task.id == ident).values(state_version=Task.state_version))
        parent = owned(session, ident, request)
        ext = f'implementation:{ident}:{parent.revision}'
        existing = session.scalar(select(Event).where(Event.source == FIELD_SOURCE, Event.external_id == ext))
        if existing:
            if existing.data['request'] != body.model_dump():
                raise HTTPException(409, '此版本已批准实施')
            return {'task_id': existing.task_id}
        has_field_input = session.scalar(select(Event.id).where(Event.task_id == ident, Event.source == FIELD_SOURCE,
                                         Event.event_type == 'message.received').limit(1))
        summary = verified_summary(session, parent)
        if (parent.kind != 'analysis' or parent.status not in {'review_ready', 'completed'} or not has_field_input
                or not summary or not summary.content.strip() or not body.scope.strip() or not body.acceptance_criteria.strip()):
            raise HTTPException(409, '请先取得当前版本的分析结果，再填写实施范围与验收条件')
        project_for(session, parent.project_id)
        version(session, parent, body.expected_state_version)
        task = Task(project_id=parent.project_id, owner_id=principal.user_id, kind='repair', source=FIELD_SOURCE,
                    title=f'实施：{parent.title}'[:300], goal=body.scope.strip(),
                    acceptance_criteria=body.acceptance_criteria.strip())
        session.add(task)
        session.flush()
        gov.assign_task_owner(task.id, principal.user_id, actor=principal.user_id, session=session)
        add_field_images(session, task, field_images(session, parent))
        session.add(Event(task_id=task.id, source=FIELD_SOURCE, external_id=ext, event_type='implementation.approved',
                          content=f'分析事件 #{ident} · 版本 {parent.revision}\n{summary.content}',
                          data=dict(request=body.model_dump(), analysis_task_id=ident, summary_id=summary.id,
                                    actor_id=principal.user_id)))
        gov.audit_action(session, principal, 'field.implementation.approve', ident,
                         {'task_id': task.id, 'revision': parent.revision, 'source': FIELD_SOURCE})
        return {'task_id': task.id}
