"""Synthetic scene, current-version checks and the two human decisions."""
from base64 import b64decode, b64encode
import json
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from superagent.api import field_intake as api, event_groups
from superagent.core import db, governance as gov
from superagent.core.field_organizer import OrganizerError, evidence_index, validated_drafts
from superagent.core.field_timeline import TimelineImport
from superagent.core.scheduler import load_attachments


PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5+1ZYAAAAASUVORK5CYII='


@pytest.fixture
def state(tmp_path, monkeypatch):
    engine = create_engine('sqlite:///' + (tmp_path / 'field.db').as_posix())
    sessions = sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(db, 'Session', sessions)
    monkeypatch.setattr(event_groups, 'Session', sessions)
    monkeypatch.setenv('SUPERAGENT_ATTACHMENTS_ROOT', str(tmp_path / 'attachments'))
    monkeypatch.setenv('SUPERAGENT_FIELD_ORGANIZER', 'sample')
    monkeypatch.setenv('SUPERAGENT_API_TOKEN', 'synthetic-field-test')
    db.Base.metadata.create_all(engine)
    principal = gov.authenticate_token('synthetic-field-test')
    request = SimpleNamespace(state=SimpleNamespace(principal=principal))
    with sessions.begin() as session:
        session.add_all([
            db.Project(id=1, name='模拟项目', repo_path=str(tmp_path)),
            db.Project(id=2, name='其他项目', repo_path=str(tmp_path)),
            db.Task(id=1, project_id=1, title='已有评估', goal='查看导出字段', kind='analysis', status='paused'),
            db.Task(id=2, project_id=1, title='已有修复', goal='修改报告', kind='repair'),
            db.Task(id=3, project_id=2, title='其他评估', goal='查看模板', kind='analysis'),
        ])
    yield sessions, request
    engine.dispose()


def create_sample(request):
    return api.create_record(api.RecordInput(
        project_id=1, title='模拟现场', notes='Bug：报告缺少一项。[截图1]\n需求：新增审核时间列。\n疑问：是否只影响预览？',
        screenshots=[api.ImageInput(filename='模拟预览.png', mime='image/png', base64=PNG)],
    ), request)


def test_review_creates_and_links_readonly_before_implementation(state):
    sessions, request = state
    record = create_sample(request)
    first, second, third = record['candidates']
    assert [item['draft']['kind'] for item in (first, second, third)] == ['bug', 'requirement', 'question']
    assert first['draft']['screenshots'] == [1]
    assert api.get_screenshot(record['id'], 1, request).body == b64decode(PNG)
    assert api.get_record(record['id'], request)['screenshots'] == [{'id': 1, 'filename': '模拟预览.png'}]
    assert not event_groups.event_index(request, source='field')['items']

    create = api.DecisionInput(action='create', title='报告预览漏项', detail='核对报告字段', kind='bug')
    reviewed = api.decide_candidate(first['id'], create, request)
    assert api.decide_candidate(first['id'], create, request) == reviewed
    ident = reviewed['decision']['task_id']

    options = api.link_targets(record['id'], request)
    assert {option['id'] for option in options} == {1, ident}
    for invalid_id, version in [(1, 99), (2, 1), (3, 1)]:
        with pytest.raises(HTTPException, match='409'):
            api.decide_candidate(second['id'], api.DecisionInput(action='link', task_id=invalid_id,
                expected_state_version=version, title='新增审核时间列', detail='评估导出字段'), request)
    linked = api.decide_candidate(second['id'], api.DecisionInput(action='link', task_id=1,
            expected_state_version=1, title='新增审核时间列', detail='评估导出字段'), request)
    assert linked['decision']['task_id'] == 1
    assert api.decide_candidate(third['id'], api.DecisionInput(action='dismiss'), request)['decision']['event_id'] is None
    index = event_groups.event_index(request, source='field')['items']
    assert {group['group']['id'] for group in index} == {1, ident}
    assert all(group['group']['kind'] == 'analysis' for group in index)
    assert {group['messages'][0]['data']['candidate_id'] for group in index} == {first['id'], second['id']}

    approve = api.ImplementationInput(expected_state_version=2, scope='修正报告预览字段', acceptance_criteria='模拟样本显示该项')
    with pytest.raises(HTTPException, match='409'):
        api.implement(ident, approve, request)
    with sessions.begin() as session:
        task = session.get(db.Task, ident)
        assert task.kind == 'analysis' and task.status == 'queued'
        artifact = session.scalar(select(db.Artifact).where(db.Artifact.task_id == ident))
        assert len(load_attachments([artifact.content])[0]) == 1
        # Seed the isolated scheduler outcome. No actual code or business data is changed.
        task.status, task.state_version = 'review_ready', 2
        session.add(db.Artifact(task_id=ident, revision=1, kind='summary', content='模拟分析：预览映射漏了该字段。'))
        session.add(db.Artifact(task_id=ident, revision=1, kind='verification', content=json.dumps({
            'has_changes': False, 'analysis_read_evidence': {'evidence_calls': 1},
        })))
    with pytest.raises(HTTPException, match='409'):
        api.implement(ident, approve.model_copy(update={'expected_state_version': 1}), request)
    approved = api.implement(ident, approve, request)
    assert api.implement(ident, approve, request) == approved
    with sessions() as session:
        repair = session.get(db.Task, approved['task_id'])
        assert repair.project_id == 1 and repair.kind == 'repair' and repair.status == 'queued'
        assert repair.goal == approve.scope and repair.acceptance_criteria == approve.acceptance_criteria
        assert len(api.field_images(session, repair)) == 1
        assert session.get(db.Task, ident).kind == 'analysis'


def test_invalid_image_cannot_create_record(state):
    _, request = state
    with pytest.raises(HTTPException, match='422'):
        api.create_record(api.RecordInput(project_id=1, title='错误样本', screenshots=[api.ImageInput(
            filename='not-image.png', mime='image/png', base64=b64encode(b'not an image').decode(),
        )]), request)
    assert api.records(request) == []


def test_evidence_is_resolved_from_source_and_invalid_ids_are_rejected():
    sources = evidence_index('报告内容待核实。\n\n导出要审核时间。', [
        [{'text': '科室小结：暂无内容', 'box': [15, 20, 300, 32], 'confidence': 0.98}],
    ])
    item = dict(kind='bug', title='报告预览少一项', detail='对照页面检查', evidence_ids=['N1', 'S1:1', 'S1:1'])
    draft, = validated_drafts(json.dumps({'items': [item]}), sources)
    assert list(sources) == ['N1', 'N3', 'S1:1']
    assert draft['screenshots'] == [1]
    assert draft['evidence'] == [sources['N1'], sources['S1:1']]
    for ids in (['N2'], ['S2:1'], [], ['N1', 'S9:1']):
        with pytest.raises(OrganizerError):
            validated_drafts(json.dumps({'items': [{**item, 'evidence_ids': ids}]}), sources)


def test_ocr_failure_does_not_create_record_or_fallback_to_rules(state, monkeypatch):
    sessions, request = state
    monkeypatch.setenv('SUPERAGENT_FIELD_ORGANIZER', 'codex')

    def failed(paths):
        assert paths[0].is_file()
        raise OrganizerError('截图识别失败')

    monkeypatch.setattr(api, 'local_ocr', failed)
    with pytest.raises(HTTPException, match='503'):
        create_sample(request)
    assert api.records(request) == []
    with sessions() as session:
        assert session.scalars(select(db.Event)).all() == []


def test_timeline_import_keeps_canonical_time_and_original_image(state, monkeypatch):
    _, request = state
    monkeypatch.setenv('SUPERAGENT_FIELD_ORGANIZER', 'codex')
    payload = {'version': 1, 'transcript': [
        {'start_ms': 3000, 'end_ms': 5000, 'speaker': '演示人', 'text': '预览仍为空'},
        {'start_ms': 0, 'end_ms': 2000, 'text': '报告字段已录入'},
    ], 'keyframes': [{'filename': 'demo.png', 'at_ms': 4000, 'ocr': [{'text': '暂无内容'}]}]}
    item = {'kind': 'bug', 'title': '预览缺项', 'detail': '核对同一报告', 'evidence_ids': ['T2', 'S1:1']}

    async def organize(ident, evidence, actor):
        assert evidence['T1']['start_ms'] == 0
        assert evidence['T2']['end_ms'] == 5000 and evidence['S1:1']['at_ms'] == 4000
        with pytest.raises(OrganizerError, match='缺少对应的转写'):
            validated_drafts(json.dumps({'items': [{**item, 'evidence_ids': ['S1:1']}]}), evidence)
        return validated_drafts(json.dumps({'items': [item]}), evidence)

    def unexpected_ocr(paths):
        pytest.fail('Imported OCR must be used directly')

    monkeypatch.setattr(api, 'model_organize', organize)
    monkeypatch.setattr(api, 'local_ocr', unexpected_ocr)
    with pytest.raises(ValidationError, match='须晚于'):
        TimelineImport.model_validate({**payload, 'transcript': [{'start_ms': 5000, 'end_ms': 4000, 'text': '无效'}]})
    timeline = TimelineImport.model_validate(payload)
    body = api.RecordInput(project_id=1, title='虚构交流', timeline=timeline)
    with pytest.raises(HTTPException, match='一一对应'):
        api.create_record(body, request)
    image = api.ImageInput(filename='demo.png', mime='image/png', base64=PNG)
    record = api.create_record(body.model_copy(update={'screenshots': [image]}), request)
    assert record['timeline_imported'] and record['screenshots'][0]['at_ms'] == 4000
    candidate, = record['candidates']
    segment = api.get_segment(record['id'], 'T2', request)
    assert segment == candidate['draft']['evidence'][0]
    assert api.get_screenshot(record['id'], 1, request).body == b64decode(PNG)
    assert not event_groups.event_index(request, source='field')['items']
    approval = api.DecisionInput(action='create', kind='bug', title='预览缺项', detail='核对同一报告')
    receipt = api.decide_candidate(candidate['id'], approval, request)
    group, = event_groups.event_index(request, source='field')['items']
    assert group['group']['kind'] == 'analysis'
    assert group['messages'][0]['data']['field_evidence'][0] == segment
    assert group['messages'][0]['data']['screenshots'][0]['at_ms'] == 4000
    with pytest.raises(HTTPException, match='409'):
        api.implement(receipt['decision']['task_id'], api.ImplementationInput(
            expected_state_version=1, scope='验证', acceptance_criteria='证据完整'), request)
