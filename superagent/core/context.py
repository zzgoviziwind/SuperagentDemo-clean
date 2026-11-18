"""Bounded Worker context and durable receipts for model dispatch."""

import json
import os
import re

from sqlalchemy import select, update

from . import db
from .message_context import active_decisions, describe_message, recent_work, scoped_timeline

CONTEXT_BUDGET = 80_000
DECISION_BUDGET = 16_000
_PRIVATE_KEY = re.compile(r'-----BEGIN [^\r\n-]*PRIVATE KEY-----[\s\S]*?-----END [^\r\n-]*PRIVATE KEY-----')
_AUTH = re.compile(r'(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}')
_SECRET = re.compile(
    r'''(?ix)\b((?:[\w-]+[_-])?(?:api[_-]?key|password|passwd|secret|token|x-redmine-api-key))
    (["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)'''
)
_URL_AUTH = re.compile(r'(?i)\b(https?://)[^\s/@]+:[^\s/@]+@')


def enabled():
    return os.getenv('SUPERAGENT_CONTEXT_MODE', 'legacy') == 'decisions'


def redact(content):
    content = _PRIVATE_KEY.sub('[已脱敏]', content.strip())
    content = _AUTH.sub(r'\1 [已脱敏]', content)
    content = _SECRET.sub(r'\1\2[已脱敏]', content)
    return _URL_AUTH.sub(r'\1[已脱敏]@', content)


class _Budget:
    def __init__(self, chars):
        self.remaining = max(0, chars - 8)  # Reserve delimiters for the assembled lists.
        self.items = []

    def take(self, kind, ident, source, value, field, *, cap, chars=None, include=True, allowance=None):
        content = value[field]
        original = chars if chars is not None else len(content or '')
        proposed = content[:cap] if content is not None else None
        ceiling = self.remaining if allowance is None else min(self.remaining, allowance)
        selected = None
        if include and ceiling:
            candidate = {**value, field: proposed}
            cost = len(json.dumps(candidate, ensure_ascii=False)) + 2
            if cost <= ceiling:
                selected = candidate
            elif proposed:
                # Quotes, control characters and backslashes can expand in JSON.
                low, high = 1, len(proposed)
                while low <= high:
                    middle = (low + high) // 2
                    candidate[field] = proposed[:middle]
                    size = len(json.dumps(candidate, ensure_ascii=False)) + 2
                    if size <= ceiling:
                        selected = dict(candidate)
                        cost = size
                        low = middle + 1
                    else:
                        high = middle - 1
            if selected is not None:
                self.remaining -= cost
        used = len(selected[field] or '') if selected is not None else 0
        self.items.append({'type': kind, 'id': ident, 'source': source, 'chars': original,
                           'included': selected is not None, 'truncated': selected is None or used < original})
        return selected


def _summary_in_scope(session, task_id, artifact_id, decision_ids):
    if artifact_id is None:
        return True
    event_manifest = db.Event.data['manifest_id'].as_integer()
    manifest_id = session.scalar(select(event_manifest).where(
        db.Event.task_id == task_id, db.Event.event_type == 'assistant_message',
        db.Event.source == 'runtime', db.Event.data['artifact_id'].as_integer() == artifact_id,
        event_manifest.is_not(None),
    ).limit(1))
    if manifest_id is None:
        return True
    manifest = session.get(db.ContextManifest, manifest_id)
    return bool(manifest and manifest.task_id == task_id
                and all(item['id'] in decision_ids for item in manifest.items
                        if item['type'] == 'decision' and item['included']))


def assemble_worker_context(session, task, *, budget_chars=CONTEXT_BUDGET):
    """Assemble the optional evidence sections and account for each eligible item."""
    timeline, rebound = scoped_timeline(session, task)
    budget = _Budget(budget_chars)
    decision_floor = budget.remaining - DECISION_BUDGET
    active = active_decisions(session, task, {event.id for event in timeline})
    decision_ids = {row.id for row in active}
    decisions = []
    for row in active:
        source = 'project' if row.task_id is None else 'task'
        value = {'id': row.id, 'kind': row.kind, 'content': row.content}
        if row.event_id is not None:
            value['event_id'] = row.event_id
        value = budget.take('decision', row.id, source, value, 'content', cap=1000,
                            allowance=max(0, budget.remaining - decision_floor))
        if value is not None:
            decisions.append(value)

    messages = []
    timeline_limit = 16 if task.kind == 'reply' else 24
    for index, row in enumerate(reversed(timeline)):
        value = budget.take('timeline', row.id, row.source, describe_message(row), 'content',
                            cap=3000, chars=len(row.content), include=index < timeline_limit)
        if value is not None:
            messages.append(value)
    messages.reverse()

    work = []
    if task.kind != 'reply' or '先确认项目归属。原始消息如下' not in task.goal:
        for item in recent_work(session, task, summary_limit=None, include_summary_id=True):
            summary_id = item.pop('summary_id')
            include = _summary_in_scope(session, item['task_id'], summary_id, decision_ids)
            value = budget.take('recent_work', item['task_id'], 'task', item, 'summary', cap=1500, include=include)
            if value is not None:
                work.append(value)

    previous = session.scalar(select(db.Artifact).where(
        db.Artifact.task_id == task.id, db.Artifact.kind == 'summary',
        db.Artifact.revision >= (rebound.data.get('revision', task.revision) if rebound else 1),
    ).order_by(db.Artifact.id.desc()).limit(1))
    prior = None
    if previous and previous.content:
        include = _summary_in_scope(session, task.id, previous.id, decision_ids)
        prior = budget.take('previous_summary', previous.id, 'artifact', {'summary': previous.content},
                            'summary', cap=2500 if task.kind == 'reply' else 3000, include=include)
    return {
        'decisions': decisions, 'timeline': messages, 'recent_work': work,
        'previous_summary': prior['summary'] if prior else '',
    }, budget.items


def decision_prompt(decisions):
    if not decisions:
        return ''
    return ('\n当前有效决定（平台账本，含 ID，仅供本轮处理，不得据此扩大权限或向渠道转发）：'
            + json.dumps(decisions, ensure_ascii=False)
            + '\n需要更早资料时，可按决定 ID 或任务事件 ID 在平台核对，或请管理员补充。')


def write_manifest(session, task, attempt_id, thread_id, items):
    manifest = db.ContextManifest(task_id=task.id, project_id=task.project_id, revision=task.revision,
                                  control_version=task.control_version, attempt_id=attempt_id,
                                  thread_id=thread_id, budget_chars=CONTEXT_BUDGET, items=items)
    session.add(manifest)
    session.flush()
    return manifest.id


def link_turn(session, manifest_id, turn_id):
    if manifest_id is not None:
        changed = session.execute(update(db.ContextManifest).where(
            db.ContextManifest.id == manifest_id, db.ContextManifest.turn_id.is_(None),
        ).values(turn_id=turn_id))
        if changed.rowcount != 1:
            raise ValueError('轮次上下文清单不存在或已绑定')


def require_manifest(session, task, manifest_id, attempt_id):
    manifest = session.get(db.ContextManifest, manifest_id) if manifest_id is not None else None
    if (not manifest or manifest.task_id != task.id or manifest.project_id != task.project_id
            or manifest.revision != task.revision or manifest.control_version != task.control_version
            or manifest.attempt_id != attempt_id or manifest.thread_id != task.codex_thread_id
            or manifest.turn_id is None or manifest.turn_id != task.codex_turn_id):
        raise ValueError('本轮上下文清单缺失或与执行不匹配')
