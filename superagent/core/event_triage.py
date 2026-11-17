"""User-facing inbox states and conservative source-message grouping."""
from collections import defaultdict
import re


def no_action_reason(event):
    data = event.data
    meta = data.get('metadata') or {}
    if event.source == 'redmine':
        if (event.event_type != 'issue.changed' or meta.get('issue_is_closed') is not True
                or not data.get('issue_id') or event.content.strip() or data.get('attachments')):
            return None
        details = meta.get('details')
        if not isinstance(details, list):
            return None
        # The status is the issue's current state when polled. Retain accompanying
        # status history, but don't send a closed issue's housekeeping to review.
        status_changed = False
        for detail in details:
            if not isinstance(detail, dict):
                return None
            if detail.get('property') == 'attr' and detail.get('name') == 'status_id':
                status_changed = True
            elif detail.get('property') != 'cf':
                return None
        return 'redmine_closed_status_notice' if status_changed else None
    if (event.source != 'dingtalk' or event.event_type != 'message.received'
            or data.get('issue_id') or meta.get('reply_to_message_id')
            or meta.get('quoted_message') or meta.get('forward_messages')
            or meta.get('needs_confirmation') or meta.get('uncertain_mentions')
            or data.get('attachments')):
        return None
    text = event.content.strip()
    if (meta.get('sender_name') == '考勤小助手'
            and re.match(r'(?:考勤小助手\s*)?请查收你的(?:上周|本周)考勤统计', text)):
        return 'attendance_notice'
    if not meta.get('at_me') and re.fullmatch(r'(?:好|好的|可以|收到|嗯|OK)[。！!\s]*', text, re.I):
        return 'acknowledgement_only'
    return None


def receipt_state(row):
    status = row.data.get('routing_status')
    if status in {'ignored', 'self_echo', 'dismissed'}:
        return 'closed'
    if status == 'semantic_pending':
        return 'active'
    if status in {None, 'pending_confirmation'} and no_action_reason(row):
        return 'closed'
    return 'triage'


def group_state(group):
    status = group['processing_status']
    if group.get('outcome_unknown') or status in {'paused', 'waiting_resource', 'failed'}:
        return 'attention'
    if status in {'queued', 'running'}:
        return 'active'
    if status in {'completed', 'reply_sent', 'reply_skipped'}:
        return 'completed'
    if status == 'cancelled':
        return 'closed'
    return 'review'


def receipt_bundles(rows):
    """Join unassigned messages only by a verified quote or the same Redmine issue."""
    buckets = defaultdict(list)
    by_id = {row.id: row for row in rows}
    message_ids = defaultdict(list)
    parents = {row.id: row.id for row in rows}

    def root(ident):
        while parents[ident] != ident:
            parents[ident] = parents[parents[ident]]
            ident = parents[ident]
        return ident

    def join(left, right):
        a, b = root(left), root(right)
        parents[max(a, b)] = min(a, b)

    def reference(row, field):
        meta = row.data.get('metadata') or {}
        profile, thread, message = meta.get('profile'), row.data.get('thread_id'), meta.get(field)
        if (row.source == 'dingtalk' and not meta.get('needs_confirmation')
                and all(isinstance(part, str) and part for part in (profile, thread, message))):
            return profile, thread, message

    issues = {}
    for row in rows:
        key = reference(row, 'message_id')
        if key:
            message_ids[key].append(row.id)
        endpoint = (row.data.get('metadata') or {}).get('redmine_endpoint')
        issue = str(row.data.get('issue_id') or '')
        if row.source == 'redmine' and isinstance(endpoint, str) and endpoint and issue.isdigit():
            join(row.id, issues.setdefault((endpoint, issue), row.id))
    siblings = {}
    for row in rows:
        key = reference(row, 'reply_to_message_id')
        if not key or key == reference(row, 'message_id'):
            continue
        anchors = message_ids.get(key, [])
        if len(anchors) == 1 and anchors[0] < row.id:
            join(row.id, anchors[0])
        elif not anchors:
            join(row.id, siblings.setdefault(key, row.id))
    for ident in sorted(by_id):
        buckets[root(ident)].append(by_id[ident])
    return list(buckets.values())
