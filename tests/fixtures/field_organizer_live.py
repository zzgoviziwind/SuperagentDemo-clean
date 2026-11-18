"""Opt-in acceptance using only the fictional screenshots and a connected Codex login."""
import argparse
import base64
import json
import os
from pathlib import Path
import sys
from uuid import uuid4


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('samples', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--timeline', action='store_true', help='Import prepared OCR and timed transcript instead of running OCR')
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
    if not executable:
        raise RuntimeError('Local Codex executable unavailable')
    with db.Session.begin() as session:
        session.add(local_agents.LocalAgentSelection(agent_id='codex', executable=executable,
                    home=str(local_agents.existing_home()), auth_type='chatgpt', actor_id='acceptance'))
        session.add(db.Project(id=1, name='虚构医院现场验收', repo_path=str(state)))
    payload = {
            'project_id': 1, 'title': '虚构医院现场交流',
            'notes': (args.samples / 'notes.txt').read_text(encoding='utf8'),
            'screenshots': [{'filename': f'{name}.png', 'mime': 'image/png',
                             'base64': base64.b64encode((args.samples / f'{name}.png').read_bytes()).decode('ascii')}
                            for name in ('preview', 'detail', 'export', 'sync')],
    }
    if args.timeline:
        frames = json.loads((args.samples / 'paddle.json').read_text(encoding='utf8'))['images']
        lines = payload.pop('notes').splitlines()
        timeline = {'version': 1, 'transcript': [
            {'start_ms': start, 'end_ms': end, 'speaker': '演示人员', 'text': text}
            for (start, end), text in zip(((8000, 17000), (18200, 32000), (35000, 48000), (51000, 61000)), lines, strict=True)
        ], 'keyframes': [{'filename': f'{frame["name"]}.png', 'at_ms': moment, 'ocr': frame['lines']}
                         for moment, frame in zip((11800, 14000, 25100, 39000), frames, strict=True)]}
        (state / 'timeline.json').write_text(json.dumps(timeline, ensure_ascii=False, indent=2), encoding='utf8')
        payload['timeline'] = timeline
    with TestClient(app, headers={'Authorization': f'Bearer {token}'}) as client:
        result = client.post('/api/v1/field-intake/records', json=payload)
        assert result.is_success, f'{result.status_code}: {result.text}'
        record = result.json()
        (state / 'candidates.json').write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding='utf8')
        drafts = [candidate['draft'] for candidate in record['candidates']]
        assert record['organizer'] == 'local_ocr_codex' and len(drafts) == 3, drafts
        assert sorted(draft['kind'] for draft in drafts) == ['bug', 'bug', 'requirement'], drafts
        assert sorted(draft['screenshots'] for draft in drafts) == [[1, 2], [3], [4]], drafts
        key = 'start_ms' if args.timeline else 'note_line'
        assert all(any(key in ref for ref in draft['evidence']) for draft in drafts), drafts
        if args.timeline:
            assert record['timeline_imported']
            for draft in drafts:
                for ref in draft['evidence']:
                    if 'start_ms' in ref:
                        segment = client.get(f'/api/v1/field-intake/records/{record["id"]}/transcript/{ref["id"]}')
                        assert segment.is_success and segment.json() == ref
                    if 'screenshot' in ref:
                        image = record['screenshots'][ref['screenshot'] - 1]
                        assert image['at_ms'] == ref['at_ms']
                        original = client.get(f'/api/v1/field-intake/records/{record["id"]}/screenshots/{ref["screenshot"]}')
                        assert original.is_success and original.content == (args.samples / image['filename']).read_bytes()
        assert client.get('/api/v1/event-groups/index?source=field').json()['total'] == 0
        item = record['candidates'][0]
        approved = client.post(f'/api/v1/field-intake/candidates/{item["id"]}/decision', json={
            'action': 'create', **{key: item['draft'][key] for key in ('kind', 'title', 'detail')},
        })
        assert approved.is_success, approved.text
        groups = client.get('/api/v1/event-groups/index?source=field').json()['items']
        assert len(groups) == 1 and groups[0]['group']['kind'] == 'analysis'
        assert groups[0]['messages'][0]['data']['field_evidence'] == item['draft']['evidence']
        group = groups[0]['group']
        early = client.post(f'/api/v1/field-intake/analysis/{group["id"]}/implement', json={
            'expected_state_version': group['state_version'], 'scope': '模拟验证', 'acceptance_criteria': '通过测试',
        })
        assert early.status_code == 409
    print(json.dumps([{'title': row['title'], 'screenshots': row['screenshots'],
                       'evidence_ids': [ref['id'] for ref in row['evidence']]} for row in drafts], ensure_ascii=False))


if __name__ == '__main__':
    main()
