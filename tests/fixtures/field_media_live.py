"""Opt-in speech, frame, vision and playback acceptance with fictional material."""
import argparse
import json
import os
from pathlib import Path
import sys
from time import monotonic, sleep
from uuid import uuid4


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('video', type=Path)
    parser.add_argument('screenshot', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    state = args.output.resolve()
    state.mkdir(parents=True, exist_ok=False)
    token = str(uuid4())
    os.environ.update(SUPERAGENT_DATABASE_URL='sqlite:///' + (state / 'isolated.db').as_posix(),
        SUPERAGENT_ATTACHMENTS_ROOT=str(state / 'attachments'), SUPERAGENT_SERVICE_MODE='preview',
        SUPERAGENT_FIELD_ORGANIZER='codex', SUPERAGENT_API_TOKEN=token)
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    from fastapi.testclient import TestClient
    from superagent.core import db, local_agents
    from superagent.main import app

    db.init_db()
    executable = local_agents.discover_executable()
    assert executable
    with db.Session.begin() as session:
        session.add(local_agents.LocalAgentSelection(agent_id='codex', executable=executable,
            home=str(local_agents.existing_home()), auth_type='chatgpt', actor_id='acceptance'))
        session.add(db.Project(id=1, name='虚构音视频项目', repo_path=str(state)))

    with TestClient(app, headers={'Authorization': f'Bearer {token}'}) as client:
        upload = client.post('/api/v1/field-intake/media-jobs', data={'details': json.dumps({
            'project_id': 1, 'title': '虚构交流录屏', 'screenshot_times': [19000],
        })}, files=[('media', ('meeting.mp4', args.video.read_bytes(), 'video/mp4')),
                   ('screenshots', ('export.png', args.screenshot.read_bytes(), 'image/png'))])
        assert upload.status_code == 202, upload.text
        ident = upload.json()['id']
        prefix = '/api/v1/field-intake/records/' + ident
        until = monotonic() + 220
        while monotonic() < until:
            job = next(row for row in client.get('/api/v1/field-intake/media-jobs').json()['jobs'] if row['id'] == ident)
            if job['state'] in {'ready', 'failed'}:
                break
            sleep(1)
        assert job['state'] == 'ready', job
        record = client.get(prefix).json()
        (state / 'record.json').write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding='utf8')
        assert record['media']['video'] is True
        assert sorted(item['draft']['kind'] for item in record['candidates']) == ['bug', 'requirement'], record
        assert len(record['screenshots']) == 2, record
        assert record['screenshots'][0]['at_ms'] == 19000
        assert client.get(prefix + '/screenshots/1').content == args.screenshot.read_bytes()
        generated_frame = client.get(prefix + '/screenshots/2')
        assert generated_frame.is_success and generated_frame.content.startswith(b'\xff\xd8\xff')
        for item in record['candidates']:
            assert item['draft']['screenshots'], item
            segment = next(ref for ref in item['draft']['evidence'] if 'start_ms' in ref)
            assert client.get(prefix + '/transcript/' + segment['id']).json() == segment
        portion = client.get(prefix + '/media', headers={'Range': 'bytes=24-55'})
        assert portion.status_code == 206 and portion.content == args.video.read_bytes()[24:56]
        assert client.get('/api/v1/event-groups/index?source=field').json()['total'] == 0
        item = record['candidates'][0]
        accepted = client.post(f'/api/v1/field-intake/candidates/{item["id"]}/decision', json={
            'action': 'create', **{key: item['draft'][key] for key in ('kind', 'title', 'detail')},
        })
        assert accepted.is_success, accepted.text
        group = client.get('/api/v1/event-groups/index?source=field').json()['items'][0]
        assert group['group']['kind'] == 'analysis' and group['messages'][0]['data']['field_media'] == record['media']
        attempt = client.post(f'/api/v1/field-intake/analysis/{group["group"]["id"]}/implement', json={
            'expected_state_version': 1, 'scope': '测试', 'acceptance_criteria': '测试通过',
        })
        assert attempt.status_code == 409
    print(json.dumps([{'title': row['draft']['title'], 'evidence': [ref['id'] for ref in row['draft']['evidence']]}
                      for row in record['candidates']], ensure_ascii=False))


if __name__ == '__main__':
    main()
