"""Multipart upload and authorized byte-range playback for field media jobs."""
from pathlib import Path
from uuid import uuid4

import anyio
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, ValidationError
from sqlalchemy import select, update
from starlette.datastructures import UploadFile

from superagent.api.event_groups import require_triage_admin
from superagent.api.field_intake import IMAGE_LIMIT, project_for
from superagent.connectors.attachments import output_directory, validate_content, validate_filename
from superagent.connectors.common import ConnectorError
from superagent.core import db
from superagent.core.field_media import (FieldMediaJob, MEDIA_LIMIT, MEDIA_TYPES, field_media_root,
                                         image_entry, media_ready, source_path)
from superagent.core.field_timeline import Timestamp

router = APIRouter(prefix='/api/v1/field-intake', tags=['field-media'])
IMAGE_SUFFIX = {'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp'}


class UploadDetails(BaseModel):
    project_id: int
    title: str = Field(min_length=1, max_length=200)
    screenshot_times: list[Timestamp] = Field(default_factory=list, max_length=5)


def job_view(job):
    return {key: getattr(job, key) for key in ('id', 'title', 'state', 'phase', 'error', 'created_at')}


def looks_like_media(suffix, prefix):
    if suffix in {'.mp4', '.m4a'}:
        return prefix[4:8] == b'ftyp'
    if suffix == '.webm':
        return prefix.startswith(b'\x1a\x45\xdf\xa3')
    if suffix == '.wav':
        return prefix.startswith(b'RIFF') and prefix[8:12] == b'WAVE'
    return prefix.startswith(b'ID3') or len(prefix) >= 2 and prefix[0] == 255 and prefix[1] & 224 == 224


@router.get('/media-jobs')
def jobs(request: Request):
    require_triage_admin(request)
    with db.Session() as session:
        rows = session.scalars(select(FieldMediaJob).order_by(FieldMediaJob.created_at.desc()).limit(30))
        return {'ready': media_ready(), 'jobs': [job_view(row) for row in rows]}


@router.post('/media-jobs', status_code=202)
async def upload(request: Request):
    require_triage_admin(request)
    if not media_ready():
        raise HTTPException(409, '请先配置后台语音识别模型和真实整理模式')
    try:
        length = int(request.headers.get('content-length', '0'))
    except ValueError:
        raise HTTPException(400, '上传请求大小无效') from None
    if length <= 0:
        raise HTTPException(411, '上传须提供请求大小')
    if length > MEDIA_LIMIT + 5 * IMAGE_LIMIT + 65536:
        raise HTTPException(413, '音视频或截图超过上传大小限制')
    ident = str(uuid4())
    files = []
    published = False
    try:
        async with request.form(max_files=6, max_fields=1, max_part_size=8192) as form:
            details = UploadDetails.model_validate_json(form.get('details'))
            media = form.get('media')
            screenshots = form.getlist('screenshots')
            if not isinstance(media, UploadFile) or len(screenshots) != len(details.screenshot_times) or not details.title.strip():
                raise HTTPException(422, '请提供标题、一个音视频文件以及每张截图的时间点')
            filename = validate_filename(media.filename)
            suffix = Path(filename).suffix.lower()
            if suffix not in MEDIA_TYPES or not looks_like_media(suffix, await media.read(32)):
                raise HTTPException(422, '音视频格式无效，请使用 MP4、WebM、WAV、MP3 或 M4A')
            if not media.size or media.size > MEDIA_LIMIT:
                raise HTTPException(413, '音视频最大 150 MB')
            with db.Session() as session:
                project_for(session, details.project_id)
            root = output_directory(field_media_root() / ident)
            source = root / ('source' + suffix)
            await media.seek(0)
            async with await anyio.open_file(source, 'xb') as output:
                files.append(source)
                while data := await media.read(1024 * 1024):
                    await output.write(data)
            entries = []
            for index, (image, timestamp) in enumerate(zip(screenshots, details.screenshot_times, strict=True), 1):
                if not isinstance(image, UploadFile) or image.content_type not in IMAGE_SUFFIX or not image.size or image.size > IMAGE_LIMIT:
                    raise HTTPException(422, '截图格式或大小无效，每张最多 2 MB')
                name = validate_filename(image.filename)
                data = await image.read(IMAGE_LIMIT + 1)
                validate_content(data, image.content_type)
                path = root / (f'uploaded-{index}' + IMAGE_SUFFIX[image.content_type])
                with path.open('xb') as output:
                    files.append(path)
                    output.write(data)
                entries.append(image_entry(path, timestamp, image.content_type, name))
            with db.Session.begin() as session:
                project_for(session, details.project_id)
                job = FieldMediaJob(id=ident, project_id=details.project_id, title=details.title.strip(),
                    owner_id=request.state.principal.user_id, screenshots=entries,
                    media={'filename': filename, 'suffix': suffix, 'size': media.size, 'content_type': MEDIA_TYPES[suffix]})
                session.add(job)
                session.flush()
                result = job_view(job)
            published = True
        return result
    except BaseException as error:
        if not published:
            for file in files:
                file.unlink(missing_ok=True)
            if files:
                files[0].parent.rmdir()
        if isinstance(error, (ValidationError, ConnectorError)):
            raise HTTPException(422, '上传信息、文件名或截图格式不符合要求') from None
        raise


@router.post('/media-jobs/{ident}/retry', status_code=202)
def retry(ident: str, request: Request):
    require_triage_admin(request)
    if not media_ready():
        raise HTTPException(409, '后台处理尚未配置')
    with db.Session.begin() as session:
        changed = session.execute(update(FieldMediaJob).where(FieldMediaJob.id == ident, FieldMediaJob.state == 'failed')
            .values(state='queued', phase='queued', attempt=None, deadline=None, error=None))
        if changed.rowcount != 1:
            raise HTTPException(409, '仅可重试已失败的任务')
        return job_view(session.get(FieldMediaJob, ident))


@router.get('/records/{ident}/media')
def original(ident: str, request: Request):
    require_triage_admin(request)
    with db.Session() as session:
        job = session.get(FieldMediaJob, ident)
        if not job or job.state != 'ready':
            raise HTTPException(404, '原音视频不可用')
        try:
            path = source_path(job)
        except (OSError, ValueError):
            raise HTTPException(404, '原音视频不可用') from None
        return FileResponse(path, media_type=job.media['content_type'], filename=job.media['filename'],
                            content_disposition_type='inline',
                            headers={'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff'})
