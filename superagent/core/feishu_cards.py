"""Private in-chat approvals backed by the existing Worker decision path."""
import asyncio
import json
import logging
import re
import threading
from pathlib import Path

from fastapi import HTTPException

from superagent.core import feishu_decisions as notices, governance as gov
from superagent.core.db import Approval, Task

log = logging.getLogger(__name__)
VERDICTS = {'approved': '已批准，任务可继续。', 'rejected': '已拒绝，执行助手已收到决定。',
            'expired': '审批已失效。', 'expired_after_dispatch': '审批版本已变化，请核对任务状态。',
            'unknown': '审批执行结果未知，请人工核对。'}


def _text(content):
    return {'tag': 'plain_text', 'content': content}


def card(task_id, approval_id, description, *, pending=False):
    elements = [{'tag': 'div', 'text': _text(description)}]
    if pending:
        for label, decision, style in [('批准', 'approve', 'primary'), ('拒绝', 'reject', 'default')]:
            elements.append({
                'tag': 'button', 'text': _text(label), 'type': style,
                'confirm': {'title': _text(f'确认{label}？'), 'text': _text(f'此决定将提交给任务 #{task_id}。')},
                'behaviors': [{'type': 'callback', 'value': {'approval_id': approval_id, 'decision': decision}}],
            })
    return {'schema': '2.0', 'config': {'update_multi': True},
            'header': {'title': _text(f'SuperAgent · 任务 #{task_id} · 审批 #{approval_id}')},
            'body': {'elements': elements}}


def _principal(owner):
    users = gov._configured_principals()
    if not users and owner == 'admin':
        return gov.Principal(owner, 'admin', 'feishu')
    for user in users:
        if user['user_id'] == owner and user['role'] in ('admin', 'member'):
            return gov.Principal(owner, user['role'], 'feishu')
    raise HTTPException(403, '绑定的工作台账号无权批准')


class CardApprovals:
    def __init__(self, sessions, scheduler, config, decide):
        self.sessions, self.scheduler, self.config, self.decide = sessions, scheduler, config, decide
        self.connected = threading.Event()
        self.stopping = threading.Event()
        self.pending = {}

    def start(self):
        try:
            _principal(self.config.owner)
        except HTTPException:
            log.error('Feishu cards disabled: configured owner cannot make decisions')
            return
        self.loop = asyncio.get_running_loop()
        self.thread = threading.Thread(target=self._listen, name='feishu-cards', daemon=True)
        self.thread.start()
        self.reminders = asyncio.create_task(notices.run(
            self.sessions, self.scheduler, self.config, send=self._send, ready=self.connected.is_set))

    async def close(self):
        self.stopping.set()
        if hasattr(self, 'reminders'):
            self.reminders.cancel()
            await asyncio.gather(self.reminders, return_exceptions=True)
            await asyncio.gather(*tuple(self.pending.values()), return_exceptions=True)
            await asyncio.to_thread(self.thread.join, 2)

    def _listen(self):
        try:
            from superagent.connectors.feishu_callback import listen
            listen(self.config, self.loop, self.receive, self.connected, self.stopping)
        except Exception as exc:
            log.error('Feishu card listener unavailable: %s', type(exc).__name__)
        finally:
            self.connected.clear()

    def _send(self, config, token, task_id, approval_id, method):
        if method == notices.COMMAND:
            description = '申请运行命令。权限范围：整个隔离工作区。'
        else:
            with self.sessions() as session:
                approval = session.get(Approval, approval_id)
                task = session.get(Task, task_id)
                root = Path(task.workspace_path).resolve()
                grant = Path(approval.action['params']['grantRoot']).resolve()
                scope = grant.relative_to(root).as_posix()
            description = f'申请修改文件。权限范围：{scope[:240]}'
        description += '\n确认操作范围后再批准；拿不准时请选择拒绝。'
        return notices._post('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id', {
            'receive_id': config.recipient, 'msg_type': 'interactive',
            'content': json.dumps(card(task_id, approval_id, description, pending=True), ensure_ascii=False),
        }, token)

    async def receive(self, app_id, operator_id, message_id, value):
        if (self.stopping.is_set() or app_id != self.config.app_id or operator_id != self.config.recipient
                or not isinstance(message_id, str) or not re.fullmatch(r'om_[A-Za-z0-9_-]{1,150}', message_id)
                or not isinstance(value, dict)):
            return 'error', '无法验证此审批操作。'
        aid, decision = value.get('approval_id'), value.get('decision')
        if type(aid) is not int or not 0 < aid < 2**63 or decision not in ('approve', 'reject'):
            return 'error', '无法识别此审批操作。'
        with self.sessions() as session:
            notice, approval = session.get(notices.FeishuDecisionNotice, aid), session.get(Approval, aid)
            if not notice or notice.status != 'sent' or notice.message_id != message_id or not approval:
                return 'error', '审批卡片未就绪或与审批记录不匹配。'
            task = session.get(Task, approval.task_id)
            if not task or gov.task_owner(task.id, session) != self.config.owner:
                return 'error', '任务负责人已变化，此卡片不能操作。'
            if approval.status in VERDICTS:
                return 'info', VERDICTS[approval.status]
            if aid in self.pending or approval.status == 'dispatching':
                return 'info', '此审批正在提交，请稍候。'
            if (approval.status != 'pending' or task.status != 'waiting_approval' or task.outcome_unknown
                    or approval.revision != task.revision or approval.control_version != task.control_version
                    or approval.action.get('method') not in (notices.COMMAND, notices.WRITE)):
                return 'error', '审批已失效或任务不再等待审批。'
            if task.id not in self.scheduler.clients:
                return 'error', '执行助手已离线，此审批无法提交。'
            try:
                principal = _principal(self.config.owner)
            except HTTPException:
                return 'error', '绑定的工作台账号无权操作。'
            if len(self.pending) >= 16:
                return 'error', '审批正在排队，请稍后再试。'
            self.pending[aid] = asyncio.create_task(self._process(
                task.id, aid, message_id, approval.action_hash, decision, principal))
        return 'info', '正在提交决定，请等卡片更新。'

    async def _process(self, task_id, aid, message_id, action_hash, decision, principal):
        try:
            try:
                result = await self.decide(aid, decision, action_hash, principal)
                description = VERDICTS.get(result['status'], '审批状态已变化，请人工核对。')
                pending = False
            except HTTPException as exc:
                with self.sessions() as session:
                    approval, task = session.get(Approval, aid), session.get(Task, task_id)
                    pending = bool(approval and task and approval.status == 'pending'
                                   and task.status == 'waiting_approval' and not task.outcome_unknown
                                   and approval.revision == task.revision
                                   and approval.control_version == task.control_version
                                   and gov.task_owner(task_id, session) == self.config.owner)
                description = str(exc.detail)
            await asyncio.to_thread(self._update, task_id, aid, message_id, description, pending)
        except Exception as exc:
            log.warning('Feishu approval %s status could not be updated: %s', aid, type(exc).__name__)
        finally:
            self.pending.pop(aid, None)

    def _update(self, task_id, aid, message_id, description, pending):
        result = notices._post(f'https://open.feishu.cn/open-apis/im/v1/messages/{message_id}', {
            'content': json.dumps(card(task_id, aid, description, pending=pending), ensure_ascii=False),
        }, notices._token(self.config), method='PATCH')
        if result.get('code') != 0:
            raise ValueError('Feishu card update rejected')
