"""Exports contain stored evidence and never dereference attachment paths."""
import json

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from superagent import main
from superagent.core import db


def test_exports_preserve_evidence_without_reading_paths(monkeypatch):
    engine = create_engine('sqlite://', poolclass=StaticPool)
    sessions = sessionmaker(engine, expire_on_commit=False)
    db.Base.metadata.create_all(engine)
    monkeypatch.setattr(main, 'Session', sessions)
    try:
        with sessions.begin() as session:
            project = db.Project(name='export', repo_path='unused')
            session.add(project)
            session.flush()
            task = db.Task(title='export', goal='review evidence', project_id=project.id, status='paused')
            session.add(task)
            session.flush()
            artifact = db.Artifact(task_id=task.id, revision=1, kind='source_attachment',
                                   content=json.dumps({'local_path': '/never/read/this/file'}))
            session.add(artifact)
            session.flush()
            task_id, artifact_id = task.id, artifact.id
        downloaded = main.download_artifact(artifact_id)
        assert downloaded.headers['content-disposition'] == f'attachment; filename="artifact-{artifact_id}.json"'
        assert downloaded.headers['cache-control'] == 'no-store'
        assert json.loads(downloaded.body)['content'] == json.dumps({'local_path': '/never/read/this/file'})
        exported = main.export_task(task_id)
        snapshot = json.loads(exported.body)
        assert snapshot['format_version'] == 1
        assert snapshot['task']['status'] == 'paused'
        assert snapshot['artifacts'][0]['id'] == artifact_id
        assert snapshot['approvals'] == []
    finally:
        engine.dispose()
