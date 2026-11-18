import asyncio
import time

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from superagent.core import db, field_media
from superagent.core.field_intake import FieldCandidate, FieldRecord, FieldTimeline
from superagent.core.field_organizer import frame_context


@pytest.fixture
def state(tmp_path, monkeypatch):
    engine = create_engine('sqlite:///' + (tmp_path / 'media.db').as_posix())
    sessions = sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(db, 'Session', sessions)
    monkeypatch.setenv('SUPERAGENT_ATTACHMENTS_ROOT', str(tmp_path / 'attachments'))
    monkeypatch.setenv('SUPERAGENT_FIELD_WHISPER_MODEL', str(tmp_path / 'whisper'))
    db.Base.metadata.create_all(engine)
    job_id = 'field-media-test'
    root = field_media.field_media_root() / job_id
    root.mkdir(parents=True)
    (root / 'source.wav').write_bytes(b'source')
    with sessions.begin() as session:
        session.add(db.Project(id=1, name='模拟项目', repo_path=str(tmp_path)))
        session.add(field_media.FieldMediaJob(id=job_id, project_id=1, title='模拟音频', owner_id='admin',
            media={'suffix': '.wav', 'size': 6, 'filename': 'source.wav', 'content_type': 'audio/wav'}, screenshots=[]))
    yield sessions, job_id
    engine.dispose()


def test_background_audio_job_stops_at_candidate_review(state, monkeypatch):
    sessions, ident = state

    async def decode(action, source, directory, *moments):
        assert action == 'transcribe' and source.name == 'source.wav'
        return {'video': False, 'duration_ms': 6000, 'segments': [{'start_ms': 1000, 'end_ms': 5000, 'text': '测试需求'}]}

    async def organize(request_key, evidence, actor):
        assert request_key.endswith('-speech')
        return [{'kind': 'requirement', 'title': '测试', 'detail': '模拟整理', 'evidence': [evidence['T1']], 'screenshots': []}]

    monkeypatch.setattr(field_media, 'media_command', decode)
    monkeypatch.setattr(field_media, 'model_organize', organize)
    claim = field_media.claim()
    assert claim[0] == ident and field_media.claim() is None
    asyncio.run(field_media.process(*claim))
    with sessions() as session:
        job = session.get(field_media.FieldMediaJob, ident)
        assert job.state == 'ready' and job.media['video'] is False
        assert session.get(FieldTimeline, ident).transcript[0]['start_ms'] == 1000
        assert session.get(FieldRecord, ident).screenshots == []
        assert session.scalar(select(FieldCandidate)).decision is None
        assert not session.scalars(select(db.Task)).all()


def test_expired_attempt_cannot_publish_or_retry_automatically(state):
    sessions, ident = state
    _, token = field_media.claim()
    with sessions.begin() as session:
        session.get(field_media.FieldMediaJob, ident).deadline = time.time() - 1
    assert field_media.claim() is None
    field_media.persist(ident, token, [], [], [], 6000, False)
    with sessions() as session:
        assert session.get(field_media.FieldMediaJob, ident).state == 'failed'
        assert session.get(FieldRecord, ident) is None


def test_screenshot_alignment_preserves_ambiguous_time_and_avoids_redundant_frames():
    transcript = [{'id': 'T1', 'start_ms': 1000, 'end_ms': 5000},
                  {'id': 'T2', 'start_ms': 5000, 'end_ms': 10000},
                  {'id': 'T3', 'start_ms': 18000, 'end_ms': 23000}]
    assert frame_context(5000, transcript)['candidate_segments'] == ['T1', 'T2']
    assert frame_context(29000, transcript)['candidate_segments'] == []
    drafts = [{'evidence': [row]} for row in transcript]
    assert field_media.frame_moments(drafts, [{'at_ms': 5000}], transcript) == [20500]
