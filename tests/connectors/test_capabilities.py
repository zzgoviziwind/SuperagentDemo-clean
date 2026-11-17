import pytest
from superagent.connectors.capabilities import SOURCES, OfflineExampleAdapter


def test_capabilities_do_not_claim_external_state_sync():
    assert all(not source.update_status for source in SOURCES.values())
    assert SOURCES['dingtalk'].receive_mode == 'stream'
    assert SOURCES['redmine'].receive_mode == 'poll'


def test_offline_example_stable_identity_and_scope():
    adapter = OfflineExampleAdapter()
    raw = dict(id='1', actor='person', conversation='room', project='demo', text='请分析')
    event = adapter.normalize(raw)
    assert event['external_id'] == adapter.normalize(raw | {'text': '改正文'})['external_id']
    assert event['external_id'] != adapter.normalize(raw | {'conversation': 'other'})['external_id']
    assert event['source'] not in SOURCES  # no accidental production enablement
    assert adapter.check()['can_send'] is False
    with pytest.raises(ValueError):
        adapter.normalize(raw | {'actor': ''})
