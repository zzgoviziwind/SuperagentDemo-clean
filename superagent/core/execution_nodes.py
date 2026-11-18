"""Durable outbound daemon mailbox. A leased operation is never redelivered."""
import hashlib
import hmac
import json
import math
import os
import time
import uuid

from sqlalchemy import select, update, String, JSON, Float
from sqlalchemy.orm import Mapped, mapped_column

from . import db


class ExecutionNode(db.Base):
    __tablename__ = 'execution_nodes'
    id: Mapped[str] = mapped_column(String(100), primary_key=True)
    seen: Mapped[float] = mapped_column(Float, default=0)
    boot_id: Mapped[str] = mapped_column(String(100), default='')


class NodeNonce(db.Base):
    __tablename__ = 'execution_nonces'
    id: Mapped[str] = mapped_column(String(200), primary_key=True)
    expires: Mapped[float] = mapped_column(Float)


class ProjectNodeBinding(db.Base):
    __tablename__ = 'project_execution_nodes'
    project_id: Mapped[int] = mapped_column(primary_key=True)
    node_id: Mapped[str | None] = mapped_column(String(100), nullable=True)


class NodeRuntimeSession(db.Base):
    __tablename__ = 'execution_runtime_sessions'
    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    node_id: Mapped[str] = mapped_column(String(100), index=True)
    deadline: Mapped[float] = mapped_column(Float)
    status: Mapped[str] = mapped_column(String(20), default='active')


def renew(session_id):
    with db.Session.begin() as session:
        changed = session.execute(update(NodeRuntimeSession).where(NodeRuntimeSession.id == session_id,
                                  NodeRuntimeSession.status == 'active', NodeRuntimeSession.deadline > time.time())
                                  .values(deadline=time.time() + 30)).rowcount
    if changed != 1:
        raise ValueError('远端会话租约失效')


def active_sessions(node_id):
    with db.Session() as session:
        return list(session.scalars(select(NodeRuntimeSession.id).where(NodeRuntimeSession.node_id == node_id,
                                    NodeRuntimeSession.status == 'active', NodeRuntimeSession.deadline > time.time())))


class NodeOperation(db.Base):
    __tablename__ = 'execution_operations'
    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    node_id: Mapped[str] = mapped_column(String(100), index=True)
    session_id: Mapped[str] = mapped_column(String(40), index=True)
    method: Mapped[str] = mapped_column(String(60))
    payload: Mapped[dict] = mapped_column(JSON)
    status: Mapped[str] = mapped_column(String(20), default='queued', index=True)
    deadline: Mapped[float] = mapped_column(Float)
    lease: Mapped[str] = mapped_column(String(40), default='')
    result: Mapped[dict] = mapped_column(JSON, default=dict)


class NodeEvent(db.Base):
    __tablename__ = 'execution_events'
    id: Mapped[str] = mapped_column(String(100), primary_key=True)
    session_id: Mapped[str] = mapped_column(String(40), index=True)
    payload: Mapped[dict] = mapped_column(JSON)
    sequence: Mapped[int] = mapped_column(default=0)


METHODS = frozenset({'start', 'start_thread', 'resume_thread', 'start_turn', 'steer_turn',
                     'interrupt_turn', 'respond_approval', 'respond_tool', 'close'})


def definitions():
    nodes = json.loads(os.getenv('SUPERAGENT_EXECUTION_NODES', '[]'))
    if not isinstance(nodes, list):
        raise ValueError('执行节点配置必须为数组')
    result = {}
    for node in nodes:
        if (not isinstance(node, dict) or not isinstance(node.get('id'), str) or not 1 <= len(node['id']) <= 100
                or not isinstance(node.get('token_env'), str) or not node['token_env']
                or not isinstance(node.get('roots'), list) or not node['roots']
                or any(not isinstance(root, str) or not os.path.isabs(root) for root in node['roots'])
                or not isinstance(node.get('project_ids'), list)
                or any(type(project_id) is not int or project_id <= 0 for project_id in node['project_ids'])):
            raise ValueError('执行节点配置无效')
        if node['id'] in result:
            raise ValueError('执行节点编号重复')
        result[node['id']] = node
    return result


def select_node(project_id):
    mapping = json.loads(os.getenv('SUPERAGENT_PROJECT_EXECUTION_NODES', '{}'))
    if not isinstance(mapping, dict):
        raise ValueError('项目节点绑定配置必须为对象')
    node_id = mapping.get(str(project_id))
    with db.Session() as session:
        binding = session.get(ProjectNodeBinding, project_id)
        if binding is not None:
            node_id = binding.node_id
    if node_id is None:
        return None
    config = definitions().get(node_id)
    if config is None or project_id not in config.get('project_ids', []):
        raise ValueError('项目未获执行节点授权')
    with db.Session() as session:
        node = session.get(ExecutionNode, node_id)
        if node is None or node.seen < time.time() - 30:
            raise ValueError('指定执行节点离线')
    return node_id


def signature(token, timestamp, nonce, path, body):
    message = timestamp.encode() + b'\n' + nonce.encode() + b'\n' + path.encode() + b'\n' + body
    return hmac.new(token.encode(), message, hashlib.sha256).hexdigest()


def authenticate(node_id, timestamp, nonce, digest, path, body):
    config = definitions().get(node_id)
    token = os.getenv(config['token_env'], '') if config else ''
    stamp = float(timestamp)
    if not token or len(nonce) > 80 or len(nonce) < 16 or not math.isfinite(stamp) or abs(time.time() - stamp) > 60:
        raise ValueError('节点认证失败')
    if not hmac.compare_digest(signature(token, timestamp, nonce, path, body), digest):
        raise ValueError('节点认证失败')
    with db.Session.begin() as session:
        session.query(NodeNonce).filter(NodeNonce.expires < time.time()).delete()
        session.add(NodeNonce(id=node_id + ':' + nonce, expires=time.time() + 120))
    return config


def enqueue(node_id, session_id, method, payload, timeout=30):
    if method not in METHODS:
        raise ValueError('不支持的执行操作')
    operation_id = uuid.uuid4().hex
    with db.Session.begin() as session:
        if method == 'start':
            session.add(NodeRuntimeSession(id=session_id, node_id=node_id, deadline=time.time() + 30))
        session.add(NodeOperation(id=operation_id, node_id=node_id, session_id=session_id,
                                  method=method, payload=payload, deadline=time.time() + timeout))
    return operation_id


def expire():
    with db.Session.begin() as session:
        session.execute(update(NodeRuntimeSession).where(NodeRuntimeSession.status == 'active',
                        NodeRuntimeSession.deadline < time.time()).values(status='unknown'))
        session.execute(update(NodeOperation).where(NodeOperation.status.in_(['queued', 'leased']),
                        NodeOperation.deadline < time.time()).values(status='unknown', result={'error': 'lease expired'}))


def poll(node_id, boot_id):
    expire()
    with db.Session.begin() as session:
        node = session.get(ExecutionNode, node_id)
        if node is None:
            node = ExecutionNode(id=node_id)
            session.add(node)
        elif node.boot_id and node.boot_id != boot_id:
            session.execute(update(NodeRuntimeSession).where(NodeRuntimeSession.node_id == node_id).values(status='unknown'))
            session.execute(update(NodeOperation).where(NodeOperation.node_id == node_id,
                            NodeOperation.status == 'leased').values(status='unknown', result={'error': 'daemon restarted'}))
        node.seen, node.boot_id = time.time(), boot_id
        row = session.scalars(select(NodeOperation).where(NodeOperation.node_id == node_id,
                              NodeOperation.status == 'queued').order_by(NodeOperation.deadline).limit(1)).first()
        if row is None:
            return None
        lease = uuid.uuid4().hex
        changed = session.execute(update(NodeOperation).where(NodeOperation.id == row.id,
                                  NodeOperation.status == 'queued').values(status='leased', lease=lease)).rowcount
        if changed != 1:
            return None
        return {'id': row.id, 'session_id': row.session_id, 'method': row.method,
                'payload': row.payload, 'lease': lease, 'deadline': row.deadline}


def exchange(node_id, operation_id=None, lease=None, result=None, events=()):
    expire()
    with db.Session.begin() as session:
        if operation_id:
            row = session.get(NodeOperation, operation_id)
            if row is None or row.node_id != node_id or row.lease != lease or row.status != 'leased':
                raise ValueError('任务租约过期或无效，结果需人工核验')
            row.status = 'failed' if 'error' in result else 'done'
            row.result = result
            if row.method == 'close':
                runtime = session.get(NodeRuntimeSession, row.session_id)
                if runtime:
                    runtime.status = 'closed'
        for item in events:
            if (not isinstance(item, dict) or not isinstance(item.get('session_id'), str)
                    or not 1 <= len(item['session_id']) <= 40 or type(item.get('sequence')) is not int
                    or item['sequence'] <= 0 or not isinstance(item.get('payload'), dict)):
                raise ValueError('节点事件格式无效')
            # Session ownership must derive from a persisted authenticated operation.
            owned = session.scalars(select(NodeOperation.id).where(NodeOperation.node_id == node_id,
                                   NodeOperation.session_id == item['session_id']).limit(1)).first()
            if owned is None:
                raise ValueError('事件会话未授权')
            key = item['session_id'] + ':' + str(item['sequence'])
            previous = session.get(NodeEvent, key)
            if previous is None:
                session.add(NodeEvent(id=key, session_id=item['session_id'], sequence=item['sequence'], payload=item['payload']))
            elif previous.payload != item['payload']:
                raise ValueError('重复事件内容冲突')


def initialize():
    for table in (ExecutionNode.__table__, ProjectNodeBinding.__table__, NodeRuntimeSession.__table__, NodeNonce.__table__, NodeOperation.__table__, NodeEvent.__table__):
        table.create(db.engine, checkfirst=True)
    # A controller restart cannot assume an in-flight remote operation stopped.
    with db.Session.begin() as session:
        session.execute(update(NodeRuntimeSession).where(NodeRuntimeSession.status == 'active').values(status='unknown'))
        session.execute(update(NodeOperation).where(NodeOperation.status.in_(['queued', 'leased']))
                        .values(status='unknown', result={'error': 'controller restarted'}))
