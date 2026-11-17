import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from superagent.api import connections as api
from superagent.connectors import history
from superagent.connectors.common import ConnectorError


@pytest.fixture
def client(monkeypatch):
    app = FastAPI()
    app.include_router(api.router)
    app.dependency_overrides[api.require_read] = lambda: None
    app.dependency_overrides[api.require_admin] = lambda: None
    monkeypatch.setattr(api.manager, 'config', lambda _: {'executable': ['dws'], 'profile': 'offline'})
    with TestClient(app) as value:
        yield value


def test_named_groups_and_partial_pagination_are_preserved(client, monkeypatch):
    calls = []
    async def read(argv, **kwargs):
        calls.append(argv)
        return {'chats': [{'openConversationId': 'cid-one', 'name': '医院研发群'}],
                'complete': False, 'hasMore': True, 'stopReason': 'page_limit'}
    monkeypatch.setattr(history, 'run_read_json', read)
    result = client.get('/api/v1/connectors/dingtalk/groups', params={'q': '医院'}).json()
    assert result['items'] == [{'id': 'cid-one', 'name': '医院研发群'}]
    assert result['complete'] is False and result['has_more'] is True
    assert result['stop_reason'] == 'page_limit'
    assert calls[0][:5] == ['dws', '--profile', 'offline', 'chat', '+chat-search']
    assert '--page-all' not in calls[0]
    assert '--page-limit' not in calls[0]
    assert calls[0][calls[0].index('--limit') + 1] == '20'


def test_search_passes_continuation_cursor(client, monkeypatch):
    calls = []
    async def read(argv, **kwargs):
        calls.append(argv)
        return {'chats': [], 'complete': False, 'hasMore': True, 'nextCursor': 'next-20'}
    monkeypatch.setattr(history, 'run_read_json', read)
    result = client.get('/api/v1/connectors/dingtalk/groups', params={'q': '医院', 'cursor': 'page-2'}).json()
    assert calls[0][-2:] == ['--cursor', 'page-2']
    assert result['next_cursor'] == 'next-20'
    assert result['has_more'] is True


def test_lookup_failure_is_visible_and_empty_query_is_rejected(client, monkeypatch):
    async def fail(*args, **kwargs):
        raise ConnectorError('dws_history_query_failed')
    monkeypatch.setattr(history, 'run_read_json', fail)
    assert client.get('/api/v1/connectors/dingtalk/groups?q=').status_code == 422
    failed = client.get('/api/v1/connectors/dingtalk/groups?q=医院')
    assert failed.status_code == 503
    assert '查询暂不可用' in failed.json()['detail']


def test_original_group_name_is_read_by_exact_id(client, monkeypatch):
    calls = []
    async def read(argv, **kwargs):
        calls.append(argv)
        return {'success': True, 'result': {'conversationInfo': {
            'openConversationId': 'cid-one', 'title': '钉钉群原名', 'singleChat': False}}}
    monkeypatch.setattr(history, 'run_read_json', read)
    response = client.get('/api/v1/connectors/dingtalk/group', params={'chat_id': 'cid-one'})
    assert response.status_code == 200
    assert response.json() == {'id': 'cid-one', 'name': '钉钉群原名'}
    assert calls[0] == ['dws', '--profile', 'offline', 'chat', '+conversation-info',
                        '--group', 'cid-one', '--format', 'json']


@pytest.mark.parametrize('info', [
    {'openConversationId': 'another-group', 'title': '其他群', 'singleChat': False},
    {'openConversationId': 'cid-one', 'title': '私聊', 'singleChat': True},
    {'openConversationId': 'cid-one', 'title': '', 'singleChat': False},
])
def test_invalid_original_group_name_is_not_used(client, monkeypatch, info):
    async def read(argv, **kwargs):
        return {'result': {'conversationInfo': info}}
    monkeypatch.setattr(history, 'run_read_json', read)
    assert client.get('/api/v1/connectors/dingtalk/group?chat_id=cid-one').status_code == 502
