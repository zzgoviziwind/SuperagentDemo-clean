"""Evidence for read-only triage before there is a project workspace."""
from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from .db import Event, Project


def evidence_error(exc):
    import re
    from superagent.connectors.common import ConnectorError
    code = str(exc) if isinstance(exc, ConnectorError) else ''
    return code if re.fullmatch(r'dws_[a-z_]{1,80}', code) else type(exc).__name__


def context_for(session, event, actor):
    from .message_policy import conversation_type
    data = event.data
    meta = data.get('metadata') or {}
    if (event.source != 'dingtalk' or event.event_type != 'message.received'
            or conversation_type(meta) != 'direct' or not meta.get('profile')
            or not data.get('thread_id') or not data.get('actor_id')
            or meta.get('needs_confirmation') or meta.get('uncertain_mentions')
            or not event.content.strip() or actor.get('role') not in {'admin', 'member'}
            or 'request' not in actor.get('permissions', [])):
        return None
    projects = session.scalars(select(Project).where(
        Project.enabled.is_(True), Project.archived.is_(False),
        Project.id.in_(actor.get('project_ids', []))).order_by(Project.id)).all()
    since = (datetime.fromisoformat(event.created_at) - timedelta(days=7)).astimezone(timezone.utc).isoformat()
    rows = session.scalars(select(Event).where(
        Event.source == event.source, Event.external_id.is_not(None), Event.id < event.id,
        Event.created_at >= since,
        Event.data['thread_id'].as_string() == data['thread_id'],
        Event.data['metadata']['profile'].as_string() == meta['profile'],
        Event.data['metadata']['dws_event_type'].as_string() == 'user_im_message_receive_o2o_all',
    ).order_by(Event.id.desc()).limit(30)).all()
    from .message_context import describe_message
    history = [describe_message(row) for row in reversed(rows)
               if row.data.get('actor_id') == data['actor_id']
               or (row.data.get('metadata') or {}).get('self_authored') is True]
    return {
        'mode': 'unassigned_project', 'project_id': None, 'tasks': [], 'event_id': event.id,
        'content': event.content[:6000], 'conversation_type': 'direct',
        'candidates': [{'id': p.id, 'name': p.name} for p in projects],
        'history': [{k: row[k] for k in ('event_id', 'time', 'direction', 'content')} for row in history],
        'media_pending': bool(data.get('attachments')),
    }


async def supplement_history(event_data, context, config):
    """Use only the listener account and this exact private conversation."""
    from superagent.connectors.history import read_own_direct_messages
    from .connections import history_timezone
    import asyncio

    meta = event_data.get('metadata') or {}
    peer, conversation, anchor = (event_data.get('actor_id'), event_data.get('thread_id'),
                                  meta.get('message_id'))
    self_ids = set(config.get('self_ids') or [])
    if (config.get('enabled') is not True or config.get('profile') != meta.get('profile')
            or not self_ids or peer in self_ids or not all((peer, conversation, anchor))):
        return {**context, 'history_fetch': 'unavailable', 'history_error': 'source_scope_unavailable'}
    # Never expose messages sent after the event to this assessment.
    try:
        cutoff = datetime.fromisoformat(event_data['occurred_at'])
        if cutoff.tzinfo is None:
            raise ValueError('missing timezone')
        since = max(datetime.now(timezone.utc) - timedelta(days=6), cutoff - timedelta(hours=24))
        history = config.get('history') or {}
        rows = await asyncio.wait_for(read_own_direct_messages(
            config.get('executable', 'dws'), profile=meta['profile'], peer=peer, conversation=conversation,
            anchor_id=anchor, since=since.isoformat(), self_ids=self_ids,
            history_timezone=history_timezone(history.get('history_timezone')),
            sender_map=history.get('sender_map'), include_peer=True), timeout=35)
        prior = [{'time': row['create_time'], 'content': row['content'][:1200],
                  'direction': 'own_account' if row['sender_open_dingtalk_id'] in self_ids else 'received'}
                 for row in rows if datetime.fromisoformat(row['create_time']) < cutoff][-20:]
    except Exception as exc:
        return {**context, 'history_fetch': 'unavailable', 'history_error': evidence_error(exc)}
    return {**context, 'history_fetch': 'verified', 'source_history': prior}


async def fetch_images(event_data, event_id, config):
    """Resolve only the source receipt's media; return checked image paths to Codex."""
    import json
    import os
    from pathlib import Path
    from uuid import uuid4
    from superagent.connectors.dingtalk import DingTalkClient
    from .scheduler import load_attachments

    meta = event_data.get('metadata') or {}
    conversation, message = event_data.get('thread_id'), meta.get('message_id')
    if (config.get('enabled') is not True or config.get('profile') != meta.get('profile')
            or not conversation or not message):
        return [], None
    directory = Path(os.getenv('SUPERAGENT_ATTACHMENTS_ROOT', './data/attachments')).resolve()
    directory = directory / 'triage' / str(event_id) / uuid4().hex
    client = DingTalkClient(config.get('executable', 'dws'), profile=config['profile'])
    try:
        media = await client.download_message_resources(conversation, message, directory,
            timeout=30, max_bytes=10 * 1024 * 1024, max_total_bytes=20 * 1024 * 1024, max_files=4)
        if (media.get('complete') is not True or media.get('profile') != config['profile']
                or media.get('conversation_id') != conversation or media.get('message_id') != message):
            return [], None
        files = [item for item in media.get('attachments', [])
                 if item.get('content_type', '').startswith('image/')]
        if any(not Path(item['local_path']).resolve(strict=True).is_relative_to(directory) for item in files):
            return [], None
        images, _, root = load_attachments([json.dumps(item) for item in files])
        return images, root
    finally:
        await client.close()


class TriageEvidence:
    """The Agent can ask for evidence but cannot choose an account or destination."""
    def __init__(self, context, receipts, config):
        self.context, self.receipts, self.config = context, receipts, config
        self.calls = []
        self.attempted = set()
        self.thread_id = self.turn_id = None
        self.image_paths = {}
        self.attachment_root = None
        self.visual_inputs = []
        self.evidence_turn_id = None

    async def call(self, tool, arguments):
        import base64
        import hashlib
        import json
        from pathlib import Path

        ident = arguments.get('event_id') if isinstance(arguments, dict) else None
        valid = (tool == 'chat_evidence' and arguments == {} or
                 tool == 'source_image' and isinstance(arguments, dict)
                 and set(arguments) == {'event_id'} and type(ident) is int
                 and ident in self.receipts and self.receipts[ident].get('attachments'))
        if not valid or (tool, ident) in self.attempted or len(self.calls) >= 6:
            return {'success': False, 'contentItems': [
                {'type': 'inputText', 'text': '请求不在已授权范围内，或同一证据已取过。'}]}
        self.attempted.add((tool, ident))
        images = []
        if tool == 'chat_evidence':
            enriched = await supplement_history(self.receipts[self.context['event_id']], self.context, self.config)
            summary = {'status': enriched['history_fetch'], 'messages': enriched.get('source_history', [])}
            record = {'tool': tool, 'status': summary['status'], 'message_count': len(summary['messages'])}
            if enriched.get('history_error'):
                summary['error'] = record['error'] = enriched['history_error']
        else:
            error = None
            try:
                paths, root = await fetch_images(self.receipts[ident], ident, self.config)
            except Exception as exc:
                paths, root, error = [], None, evidence_error(exc)
            files = []
            accepted = []
            seen = set()
            for path in paths:
                data = Path(path).read_bytes()
                mime = ('png' if data.startswith(b'\x89PNG\r\n\x1a\n') else
                        'jpeg' if data.startswith(b'\xff\xd8\xff') else
                        'gif' if data.startswith((b'GIF87a', b'GIF89a')) else
                        'webp' if data.startswith(b'RIFF') and data[8:12] == b'WEBP' else None)
                if mime and 0 < len(data) <= 10 * 1024 * 1024:
                    digest = hashlib.sha256(data).hexdigest()
                    if digest in seen:
                        continue
                    seen.add(digest)
                    accepted.append(path)
                    files.append({'bytes': len(data), 'sha256': digest,
                                  'content_type': 'image/' + mime})
                    images.append({'type': 'inputImage', 'imageUrl':
                                   f'data:image/{mime};base64,' + base64.b64encode(data).decode('ascii')})
            summary = {'event_id': ident, 'status': 'verified' if images else 'unavailable', 'images': files}
            if accepted:
                self.image_paths[ident] = accepted
                self.attachment_root = root
            if not images:
                summary['error'] = error or 'no_verified_image'
            record = {'tool': tool, **summary}
        self.calls.append(record)
        return {'success': summary['status'] == 'verified', 'contentItems': [
            {'type': 'inputText', 'text': json.dumps(summary, ensure_ascii=False)}, *images]}


def validate_project_assessment(decision, context):
    fields = {'project_status', 'proposed_project_id', 'evidence_event_ids', 'reason', 'missing_context'}
    batch = context.get('comparison')
    if batch:
        fields |= {'relationship', 'relationship_reason'}
    if not isinstance(decision, dict) or set(decision) != fields:
        raise ValueError('项目研判字段无效')
    status, project = decision['project_status'], decision['proposed_project_id']
    if status not in ('suggested', 'needs_context', 'no_project'):
        raise ValueError('项目研判状态无效')
    for key, limit in (('reason', 2000), ('missing_context', 1000)):
        value = decision[key]
        if not isinstance(value, str) or len(value) > limit or (key == 'reason' and not value.strip()):
            raise ValueError('项目研判说明无效')
    ids = decision['evidence_event_ids']
    allowed = {context['event_id'], *(row['event_id'] for row in context['history']),
               *(row['event_id'] for row in (batch or []))}
    if not isinstance(ids, list) or len(ids) > 10 or any(type(i) is not int or i not in allowed for i in ids):
        raise ValueError('项目证据不在会话快照内')
    if status == 'suggested':
        if type(project) is not int or project not in {p['id'] for p in context['candidates']} or not ids:
            raise ValueError('建议项目或证据无效')
    elif project is not None:
        raise ValueError('当前状态不能指定项目')
    if status == 'needs_context' and not decision['missing_context'].strip():
        raise ValueError('请说明还缺什么上下文')
    if batch and (decision['relationship'] not in ('same_issue', 'different_issues', 'uncertain')
            or not isinstance(decision['relationship_reason'], str)
            or not 0 < len(decision['relationship_reason'].strip()) <= 2000):
        raise ValueError('消息关系研判无效')
    return decision
