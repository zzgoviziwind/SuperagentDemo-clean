"""Provider capabilities and durable inbound bridge operation receipts."""
import hashlib
import json

from fastapi import HTTPException
from sqlalchemy import JSON, String, Text, UniqueConstraint, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Mapped, mapped_column

from superagent.core import db


class BridgeOperation(db.Base):
    __tablename__ = 'conversation_bridge_operations'
    __table_args__ = (UniqueConstraint('actor_id', 'request_key'),)
    id: Mapped[int] = mapped_column(primary_key=True)
    actor_id: Mapped[str] = mapped_column(String(200))
    request_key: Mapped[str] = mapped_column(String(128))
    payload_hash: Mapped[str] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(24), default='pending')
    result: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[str] = mapped_column(String(40), default=db.now)
    updated_at: Mapped[str] = mapped_column(String(40), default=db.now)


def capabilities():
    return {'items': [
        {'id': 'codex_local', 'status': 'available', 'source_application': 'codex',
         'capabilities': ['list', 'create', 'continue', 'read', 'control'],
         'session_id_format': 'worker:{task_id}|router:{project_id}',
         'external_project_id': None, 'external_conversation_id': None, 'external_url': None,
         'execution_readiness': '执行前仍需配置并验证本机 Codex 运行时'},
        {'id': 'chatgpt_project', 'status': 'blocked', 'source_application': 'chatgpt',
         'capabilities': [], 'external_project_id': None, 'external_conversation_id': None,
         'external_url': None,
         'reason': '已查阅官方资料尚未提供独立进程创建指定 ChatGPT 项目聊天及同步历史的公共调用契约',
         'documentation_url': 'https://developers.openai.com/api/reference/resources/conversations/methods/create'},
        {'id': 'chatgpt_mcp_bridge', 'status': 'requires_client_connection',
         'source_application': 'chatgpt', 'transports': ['stdio', 'streamable_http'],
         'mcp_endpoint': '/api/v1/conversation-providers/mcp',
         'authentication': 'platform_bearer', 'web_installation_status': 'requires_https_and_oauth',
         'capabilities': ['list', 'create', 'continue', 'read', 'control'],
         'automatic_history_sync': False,
         'reason': '支持本地 MCP 的桌面客户端可使用 STDIO 或 Bearer HTTP；ChatGPT Web 安装仍需 HTTPS 与 OAuth 接入部署',
         'documentation_url': 'https://learn.chatgpt.com/docs/extend/mcp'},
    ]}


def operation_receipt(actor_id, request_key):
    with db.Session() as session:
        row = session.scalar(select(BridgeOperation).where(
            BridgeOperation.actor_id == actor_id, BridgeOperation.request_key == request_key))
        if row is None:
            raise HTTPException(404, '操作不存在')
        return db.dump(row)


def reserve_operation(actor_id, request_key, payload):
    digest = hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False,
                                       separators=(',', ':')).encode()).hexdigest()
    try:
        with db.Session.begin() as session:
            row = BridgeOperation(actor_id=actor_id, request_key=request_key, payload_hash=digest)
            session.add(row)
            session.flush()
            return row.id, None
    except IntegrityError:
        previous = operation_receipt(actor_id, request_key)
        if previous['payload_hash'] != digest:
            raise HTTPException(409, '幂等键已用于不同内容') from None
        if previous['status'] != 'completed':
            raise HTTPException(409, '操作进行中或结果未知，请读取操作及会话状态核验，禁止自动重放') from None
        return previous['id'], previous['result']


def finish_operation(operation_id, result=None, error=None):
    with db.Session.begin() as session:
        row = session.get(BridgeOperation, operation_id)
        row.status = 'unknown' if error else 'completed'
        row.result = result
        row.last_error = error
        row.updated_at = db.now()
