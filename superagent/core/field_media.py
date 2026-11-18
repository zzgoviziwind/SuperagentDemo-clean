"""Durable, bounded field media jobs. Results stop at the candidate review gate."""
import asyncio
from contextlib import suppress
import hashlib
import json
import logging
import os
from pathlib import Path
import subprocess
import sys
from time import time
from uuid import uuid4

from pydantic import ValidationError
from sqlalchemy import JSON, String, select, update
from sqlalchemy.orm import Mapped, mapped_column

from superagent.connectors.attachments import output_directory
from superagent.runtime.workspace import _no_links
from . import db
from .field_intake import FieldCandidate, FieldRecord, FieldTimeline
from .field_organizer import OrganizerError, evidence_index, frame_context, model_organize, organizer_mode
from .field_timeline import TimelineImport, matching_segments

MEDIA_TYPES = {'.mp4': 'video/mp4', '.webm': 'video/webm', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4'}
MEDIA_LIMIT = 150 * 1024 * 1024
FRAME_LIMIT = 5


class FieldMediaJob(db.Base):
    __tablename__ = 'field_media_jobs'
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    project_id: Mapped[int]
    title: Mapped[str] = mapped_column(String(200))
    owner_id: Mapped[str] = mapped_column(String(200))
    state: Mapped[str] = mapped_column(String(20), index=True, default='queued')
    phase: Mapped[str] = mapped_column(String(20), default='queued')
    attempt: Mapped[str | None] = mapped_column(String(36))
    deadline: Mapped[float | None]
    error: Mapped[str | None] = mapped_column(String(500))
    media: Mapped[dict] = mapped_column(JSON)
    screenshots: Mapped[list] = mapped_column(JSON)
    created_at: Mapped[str] = mapped_column(String(40), default=db.now)


def field_media_root():
    return Path(os.getenv('SUPERAGENT_ATTACHMENTS_ROOT', './data/attachments')).resolve() / 'field-media'


def media_ready():
    models = os.getenv('SUPERAGENT_FIELD_WHISPER_MODEL')
    return organizer_mode() != 'offline_sample' and bool(models and all(
        (Path(models) / name).is_file() for name in ('model.bin', 'config.json', 'tokenizer.json')))


def source_path(job):
    root = field_media_root()
    relative = Path(job.id) / ('source' + job.media['suffix'])
    _no_links(root, relative.parts)
    path = root / relative
    if not path.is_file() or path.stat().st_size != job.media['size']:
        raise OSError('找不到完整原文件')
    return path


def image_entry(path, timestamp, content_type, filename=None):
    if path.stat().st_size > 10 * 1024 * 1024:
        raise OrganizerError('关键截图超出大小限制')
    data = path.read_bytes()
    return {'filename': filename or path.name, 'local_path': str(path), 'size': len(data),
            'content_type': content_type, 'sha256': hashlib.sha256(data).hexdigest(), 'at_ms': timestamp}


def claim():
    token = str(uuid4())
    with db.Session.begin() as session:
        session.execute(update(FieldMediaJob).where(FieldMediaJob.state == 'running', FieldMediaJob.deadline < time())
                        .values(state='failed', error='处理进程已中断，请人工重试', deadline=None))
        ident = session.scalar(select(FieldMediaJob.id).where(FieldMediaJob.state == 'queued')
                               .order_by(FieldMediaJob.created_at, FieldMediaJob.id).limit(1))
        if not ident:
            return None
        changed = session.execute(update(FieldMediaJob).where(FieldMediaJob.id == ident, FieldMediaJob.state == 'queued')
                                  .values(state='running', phase='transcribing', attempt=token, deadline=time() + 1200))
        return (ident, token) if changed.rowcount == 1 else None


def change(ident, token, **fields):
    with db.Session.begin() as session:
        session.execute(update(FieldMediaJob).where(FieldMediaJob.id == ident, FieldMediaJob.attempt == token,
                                                    FieldMediaJob.state == 'running').values(**fields))


async def media_command(action, source, directory, *moments):
    python = os.getenv('SUPERAGENT_FIELD_MEDIA_PYTHON', sys.executable)
    worker = Path(__file__).with_name('field_media_worker.py')
    environment = {key: os.environ[key] for key in ('PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE') if key in os.environ}
    process = await asyncio.create_subprocess_exec(python, str(worker), action, str(source), str(directory), *map(str, moments),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL, env=environment,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    try:
        stdout, _ = await asyncio.wait_for(process.communicate(), timeout=900 if action == 'transcribe' else 90)
        if process.returncode != 0:
            label = '语音转写' if action == 'transcribe' else '录屏抽帧'
            raise OrganizerError(f'{label}失败，请检查文件格式、时长和本地模型配置')
        return json.loads(stdout)
    finally:
        if process.returncode is None:
            with suppress(ProcessLookupError):
                process.kill()
            await process.wait()


def frame_moments(drafts, uploaded, transcript):
    moments = []
    covered = {ref['id'] for image in uploaded for ref in matching_segments(image['at_ms'], transcript)}
    for draft in drafts:
        if len(moments) + len(uploaded) >= FRAME_LIMIT:
            break
        timed = [ref for ref in draft['evidence'] if 'start_ms' in ref]
        if not timed or covered.intersection(ref['id'] for ref in timed):
            continue
        ref = timed[0]
        moments.append((ref['start_ms'] + ref['end_ms']) // 2)
        covered.add(ref['id'])
    return moments


def persist(ident, token, transcript, images, drafts, duration, video):
    with db.Session.begin() as session:
        locked = session.execute(update(FieldMediaJob).where(FieldMediaJob.id == ident,
            FieldMediaJob.attempt == token, FieldMediaJob.state == 'running').values(state='ready', phase='ready', deadline=None))
        if locked.rowcount != 1:
            return
        job = session.get(FieldMediaJob, ident)
        project = session.get(db.Project, job.project_id)
        if not project or not project.enabled or project.archived:
            raise OrganizerError('项目已停用，无法保存候选事项')
        content_type = 'audio/mp4' if not video and job.media['suffix'] == '.mp4' else job.media['content_type']
        job.media = {**job.media, 'duration_ms': duration, 'video': video, 'content_type': content_type}
        session.add(FieldRecord(id=ident, project_id=job.project_id, title=job.title, notes='',
                                screenshots=images, owner_id=job.owner_id))
        session.add(FieldTimeline(record_id=ident, transcript=transcript))
        session.add_all(FieldCandidate(record_id=ident, draft=draft) for draft in drafts)


async def process(ident, token):
    try:
        with db.Session() as session:
            job = session.get(FieldMediaJob, ident)
            source, images, actor = source_path(job), list(job.screenshots), job.owner_id
        recognizer = Path(os.environ['SUPERAGENT_FIELD_WHISPER_MODEL']).resolve()
        speech = await media_command('transcribe', source, recognizer)
        if not speech['segments']:
            raise OrganizerError('未识别到语音，请检查原文件中的声音')
        try:
            transcript = TimelineImport.model_validate({'version': 1, 'transcript': speech['segments']}).segments()
        except ValidationError:
            raise OrganizerError('转写超过 300 个片段或 30,000 字，或时间段无效，请将原文件分段后重试') from None
        if any(image['at_ms'] > speech['duration_ms'] for image in images):
            raise OrganizerError('有截图时间超出原音视频时长')
        change(ident, token, phase='organizing')
        evidence = evidence_index('', [], transcript)
        preliminary = await model_organize(f'{ident}-{token}-speech', evidence, actor)
        if not preliminary:
            raise OrganizerError('语音中没有可以整理成候选事项的内容')
        moments = frame_moments(preliminary, images, transcript) if speech['video'] else []
        if moments:
            change(ident, token, phase='extracting')
            directory = output_directory(source.parent / token)
            frames = await media_command('frames', source, directory, *moments)
            images.extend(image_entry(directory / frame['filename'], frame['at_ms'], 'image/jpeg') for frame in frames)
        drafts = preliminary
        if images:
            change(ident, token, phase='vision')
            for index, image in enumerate(images, 1):
                frame_id = f'S{index}'
                evidence[frame_id] = {'id': frame_id, 'screenshot': index, **frame_context(image['at_ms'], transcript),
                    'text': '与该编号对应的原图，请核对其内容'}
            drafts = await model_organize(f'{ident}-{token}-vision', evidence, actor,
                images=[entry['local_path'] for entry in images], image_root=str(source.parent),
                previous=[{'title': item['title'], 'kind': item['kind'], 'detail': item['detail'],
                           'evidence_ids': [ref['id'] for ref in item['evidence']]} for item in preliminary])
            if not drafts:
                raise OrganizerError('画面核对没有返回可审核事项')
        persist(ident, token, transcript, images, drafts, speech['duration_ms'], speech['video'])
    except asyncio.CancelledError:
        change(ident, token, state='failed', error='服务停止，处理已中断，请人工重试', deadline=None)
        raise
    except OrganizerError as error:
        change(ident, token, state='failed', error=str(error), deadline=None)
    except Exception as error:
        logging.getLogger(__name__).warning('现场媒体任务 %s 失败：%s', ident, type(error).__name__)
        change(ident, token, state='failed', error='音视频处理失败，请检查本机模型配置，必要时将长材料分段', deadline=None)


async def media_loop():
    while True:
        try:
            claimed = claim() if media_ready() else None
            if claimed:
                await process(*claimed)
        except Exception:
            logging.getLogger(__name__).exception('现场媒体队列轮询失败')
        await asyncio.sleep(2)
