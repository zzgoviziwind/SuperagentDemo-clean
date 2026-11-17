"""Opt-in private reminders for decisions that block a live Worker."""
import asyncio
import json
import logging
import os
import re
from dataclasses import dataclass
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from sqlalchemy import String, case, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Mapped, mapped_column

from superagent.core.db import Approval, Base, Project, Task
from superagent.core.governance import TaskOwner

log = logging.getLogger(__name__)
COMMAND = 'item/commandExecution/requestApproval'
WRITE = 'item/fileChange/requestApproval'


class FeishuDecisionNotice(Base):
    __tablename__ = 'feishu_decision_notices'
    approval_id: Mapped[int] = mapped_column(primary_key=True)
    # A persisted sending row after an interruption is deliberately not retried.
    status: Mapped[str] = mapped_column(String(16))
    message_id: Mapped[str | None] = mapped_column(String(160))


@dataclass(frozen=True, repr=False)
class Config:
    app_id: str
    secret: str
    recipient: str
    owner: str
    workbench: str

    @classmethod
    def load(cls):
        if (os.getenv('SUPERAGENT_SERVICE_MODE') == 'preview'
                or os.getenv('SUPERAGENT_FEISHU_ENABLED') != '1'):
            return None
        values = [os.getenv('SUPERAGENT_FEISHU_' + key, '').strip() for key in
                  ('APP_ID', 'APP_SECRET', 'OPEN_ID', 'OWNER_ID', 'WORKBENCH_URL')]
        try:
            address = urlsplit(values[-1])
            valid = (all(values) and re.fullmatch(r'ou_[A-Za-z0-9_-]+', values[2])
                     and address.scheme == 'https' and address.hostname
                     and address.username is None and not address.query and not address.fragment)
        except ValueError:
            valid = False
        if not valid:
            log.error('Feishu decision reminders disabled: incomplete or invalid configuration')
            return None
        return cls(*values)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _post(url, body, token=None):
    headers = {'Content-Type': 'application/json; charset=utf-8'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    request = Request(url, json.dumps(body, ensure_ascii=False).encode(), headers)
    with build_opener(NoRedirect()).open(request, timeout=8) as response:
        return json.loads(response.read(65536))


def _token(config):
    result = _post('https://accounts.feishu.cn/oauth/v3/token', {
        'grant_type': 'client_credentials', 'client_id': config.app_id,
        'client_secret': config.secret, 'scope': 'im:message:send_as_bot',
    })
    token = result.get('access_token')
    if not isinstance(token, str) or not token:
        raise ValueError('Feishu did not issue an access token')
    return token


def _send(config, token, task_id, approval_id, method):
    action = '运行命令' if method == COMMAND else '修改文件'
    url = f'{config.workbench.rstrip("/")}/?task={task_id}&approval={approval_id}'
    content = {'zh_cn': {'title': f'SuperAgent：任务 #{task_id} 需要你决策',
                         'content': [[{'tag': 'text', 'text': f'执行已暂停，等待你决定是否允许{action}。请核对操作范围；范围不符时请选择拒绝。'}],
                                     [{'tag': 'a', 'text': '打开工作台审核', 'href': url}]]}}
    return _post('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id', {
        'receive_id': config.recipient, 'msg_type': 'post',
        'content': json.dumps(content, ensure_ascii=False),
    }, token)


def _pending(config):
    owner = case((Task.owner_id == 'local-admin', func.coalesce(TaskOwner.user_id, Task.owner_id)),
                 else_=Task.owner_id)
    return (select(Approval).join(Task, Task.id == Approval.task_id)
            .join(Project, Project.id == Task.project_id)
            .outerjoin(TaskOwner, TaskOwner.task_id == Task.id)
            .outerjoin(FeishuDecisionNotice, FeishuDecisionNotice.approval_id == Approval.id)
            .where(FeishuDecisionNotice.approval_id.is_(None), Approval.status == 'pending',
                   Approval.revision == Task.revision, Approval.control_version == Task.control_version,
                   Approval.action['method'].as_string().in_((COMMAND, WRITE)),
                   owner == config.owner, Task.kind == 'repair',
                   Task.status == 'waiting_approval', Task.outcome_unknown.is_(False),
                   Project.enabled.is_(True), Project.archived.is_(False)))


async def notify_pending(sessions, scheduler, config, *, get_token=_token, send=_send):
    live_ids = tuple(scheduler.clients)
    if not live_ids:
        return
    pending = _pending(config).where(Task.id.in_(live_ids))
    with sessions() as session:
        candidates = [(a.id, a.task_id) for a in session.scalars(pending.order_by(Approval.id).limit(20))]
    if not candidates:
        return
    token = await asyncio.to_thread(get_token, config)
    for approval_id, task_id in candidates:
        async with scheduler.lock(task_id):
            if task_id not in scheduler.clients:
                continue
            try:
                with sessions.begin() as session:
                    approval = session.scalar(pending.where(Approval.id == approval_id))
                    if not approval:
                        continue
                    method = approval.action['method']
                    session.add(FeishuDecisionNotice(approval_id=approval_id, status='sending'))
            except IntegrityError:
                continue
        status, message_id = 'unknown', None
        try:
            result = await asyncio.to_thread(send, config, token, task_id, approval_id, method)
            if result.get('code') == 0:
                message_id = result.get('data', {}).get('message_id')
                if isinstance(message_id, str) and message_id:
                    status = 'sent'
            elif isinstance(result.get('code'), int):
                status = 'failed'
        except Exception:
            # Network/response failure can happen after Feishu accepted the message.
            pass
        with sessions.begin() as session:
            row = session.get(FeishuDecisionNotice, approval_id)
            row.status = status
            row.message_id = message_id if status == 'sent' else None
        if status != 'sent':
            log.warning('Feishu decision reminder %s for approval %s', status, approval_id)


async def run(sessions, scheduler, config):
    while True:
        try:
            await notify_pending(sessions, scheduler, config)
        except Exception as exc:
            # Avoid logging request bodies, credentials or platform responses.
            log.warning('Feishu decision reminder scan failed: %s', type(exc).__name__)
        await asyncio.sleep(10)
