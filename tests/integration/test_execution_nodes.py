import json
import time

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from superagent.core import db, execution_nodes as nodes


@pytest.fixture
def store(tmp_path, monkeypatch):
    engine = create_engine('sqlite:///' + str(tmp_path / 'nodes.db'))
    db.Base.metadata.create_all(engine)
    monkeypatch.setattr(db, 'Session', sessionmaker(engine, expire_on_commit=False))
    monkeypatch.setattr(db, 'engine', engine)
    monkeypatch.setenv('SUPERAGENT_EXECUTION_NODES', json.dumps([{'id': 'test', 'token_env': 'TEST_NODE_SECRET', 'roots': [str(tmp_path)], 'project_ids': [1]}]))
    monkeypatch.setenv('TEST_NODE_SECRET', 'isolated-test-credential')
    yield tmp_path
    engine.dispose()


def test_authentication_and_replay(store):
    stamp, nonce, body = str(time.time()), 'a' * 32, b'{}'
    digest = nodes.signature('isolated-test-credential', stamp, nonce, '/poll', body)
    nodes.authenticate('test', stamp, nonce, digest, '/poll', body)
    from sqlalchemy.exc import IntegrityError
    with pytest.raises(IntegrityError):
        nodes.authenticate('test', stamp, nonce, digest, '/poll', body)
    with pytest.raises(ValueError):
        nodes.authenticate('test', stamp, 'b' * 32, digest, '/poll', b'{"tampered":1}')
    with pytest.raises(ValueError):
        nodes.authenticate('test', str(time.time() - 1000), 'c' * 32, digest, '/poll', body)


def test_lease_not_replayed_and_late_result_rejected(store):
    operation_id = nodes.enqueue('test', 'session', 'start', {}, timeout=10)
    job = nodes.poll('test', 'boot-1')
    assert job['id'] == operation_id
    assert nodes.poll('test', 'boot-1') is None
    with db.Session.begin() as session:
        session.get(nodes.NodeOperation, operation_id).deadline = time.time() - 1
    with pytest.raises(ValueError):
        nodes.exchange('test', operation_id, job['lease'], {'value': 'late'})
    assert nodes.poll('test', 'boot-1') is None
    with db.Session() as session:
        assert session.get(nodes.NodeOperation, operation_id).status == 'unknown'


def test_daemon_restart_and_project_selection(store, monkeypatch):
    monkeypatch.setenv('SUPERAGENT_PROJECT_EXECUTION_NODES', '{"1":"test"}')
    with pytest.raises(ValueError):
        nodes.select_node(1)
    ident = nodes.enqueue('test', 'session', 'start', {})
    nodes.poll('test', 'first')
    assert nodes.select_node(1) == 'test'
    nodes.poll('test', 'second')
    with db.Session() as session:
        assert session.get(nodes.NodeOperation, ident).status == 'unknown'
    assert nodes.select_node(2) is None


def test_cross_node_event_and_lease_rejected(store):
    ident = nodes.enqueue('test', 'owned', 'start', {})
    job = nodes.poll('test', 'boot')
    with pytest.raises(ValueError):
        nodes.exchange('other', ident, job['lease'], {'value': None})
    with pytest.raises(ValueError):
        nodes.exchange('test', events=[{'session_id': 'unowned', 'sequence': 1, 'payload': {}}])
    nodes.exchange('test', ident, job['lease'], {'value': 'ok'}, [{'session_id': 'owned', 'sequence': 1, 'payload': {'method': 'test'}}])
    nodes.exchange('test', events=[{'session_id': 'owned', 'sequence': 1, 'payload': {'method': 'test'}}])
    with db.Session() as session:
        assert session.query(nodes.NodeEvent).count() == 1


def test_runtime_session_lease_cannot_be_revived(store):
    nodes.enqueue('test', 'runtime', 'start', {})
    assert nodes.active_sessions('test') == ['runtime']
    nodes.renew('runtime')
    with db.Session.begin() as session:
        session.get(nodes.NodeRuntimeSession, 'runtime').deadline = time.time() - 1
    with pytest.raises(ValueError):
        nodes.renew('runtime')
    assert nodes.active_sessions('test') == []
    nodes.initialize()
    with db.Session() as session:
        assert session.get(nodes.NodeRuntimeSession, 'runtime').status == 'unknown'
