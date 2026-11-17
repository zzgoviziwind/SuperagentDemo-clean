"""Public, credential-free source capabilities used by ingestion.

This registry is deliberately not a dynamic plugin loader. Registering a source
does not grant identities, enable a connection, or authorize an external write.
"""
from dataclasses import dataclass
from typing import Mapping, Any, Protocol


@dataclass(frozen=True)
class SourceCapabilities:
    source: str
    project_binding_field: str
    event_types: frozenset[str]
    receive_mode: str
    reply: bool = False
    update_status: bool = False


SOURCES = {
    'dingtalk': SourceCapabilities('dingtalk', 'dingtalk_chat_ids',
        frozenset({'message.received'}), 'stream', reply=True),
    'redmine': SourceCapabilities('redmine', 'redmine_project_ids',
        frozenset({'issue.updated', 'issue.comment', 'issue.changed'}), 'poll', reply=True),
}


class SourceAdapter(Protocol):
    """Boundary for future adapters; core still owns grants and write ledger.

    check must be read-only and return redacted diagnostics. normalize must
    derive stable IDs from trusted platform metadata, not message instructions.
    Writes must use AuthorizedAction and ActionLedger in common.py separately.
    """
    def check(self) -> Mapping[str, Any]: ...
    def normalize(self, raw: Mapping[str, Any]) -> dict: ...


class OfflineExampleAdapter:
    """No network, no writes; contract example, NOT a production source."""
    def check(self):
        return {'status': 'offline_example', 'can_send': False}

    def normalize(self, raw):
        required = ('id', 'actor', 'conversation', 'project', 'text')
        if any(not isinstance(raw.get(key), str) or not raw[key].strip() for key in required):
            raise ValueError('示例事件字段缺失或无效')
        from .common import digest
        return {'source': 'offline_example',
                'external_id': digest({'conversation': raw['conversation'], 'id': raw['id']}),
                'actor_id': raw['actor'], 'thread_id': raw['conversation'],
                'project_external_id': raw['project'], 'event_type': 'message.received',
                'content': raw['text'], 'attachments': [], 'metadata': {'demo': True}}
