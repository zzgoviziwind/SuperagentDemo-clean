"""Conservative task evidence aggregation; a completed turn is not acceptance."""


def assess_outcome(*, task_kind, turn_status, events, changes=None,
                   verification=None, outcome=None):
    """Return a suggested control state; inputs must be independently collected.

    `verification` is a control-layer record: {status, evidence}; model text alone
    is not a verification record. `outcome` is a structured model report and is
    preserved, but never treated as proof that changes or tests exist.
    """
    if task_kind not in ('fix', 'analysis'):
        raise ValueError('task_kind must be fix or analysis')
    failures = []
    for position, event in enumerate(events):
        params = event.get('params') or {}
        item = params.get('item') or {}
        kind = item.get('type')
        if event.get('method') == 'error':
            failures.append({'kind': 'server_error', 'detail': params, 'position': position, 'thread_id': params.get('threadId'), 'turn_id': params.get('turnId')})
        if event.get('method') == 'item/completed' and kind in ('commandExecution', 'fileChange', 'mcpToolCall'):
            status = item.get('status')
            exit_code = item.get('exitCode')
            if status in ('failed', 'declined', 'cancelled', 'error') or (exit_code is not None and exit_code != 0):
                failures.append({'kind': kind, 'item_id': item.get('id'), 'status': status, 'exit_code': exit_code, 'item': item, 'position': position, 'thread_id': params.get('threadId'), 'turn_id': params.get('turnId')})
    evidence = (verification or {}).get('evidence') if isinstance(verification, dict) else None
    verified_ids = (evidence or {}).get('command_item_ids', []) if isinstance(evidence, dict) else []
    passed = isinstance(verification, dict) and verification.get('status') == 'passed' and bool(verified_ids)
    blocking = []
    for failure in failures:
        if failure['kind'] == 'server_error':
            detail = failure.get('detail') or {}
            error = detail.get('error') or {}
            info = error.get('codexErrorInfo')
            transport_errors = {'httpConnectionFailed', 'responseStreamConnectionFailed', 'responseStreamDisconnected'}
            known_transport_error = (isinstance(info, dict) and len(info) == 1
                                     and next(iter(info)) in transport_errors
                                     and isinstance(next(iter(info.values())), dict))
            can_recover = (detail.get('willRetry') is True and turn_status == 'completed'
                           and isinstance(verification, dict) and verification.get('status') == 'passed'
                           and bool(verification.get('evidence')) and failure.get('thread_id') and failure.get('turn_id')
                           and known_transport_error)
            recovered = False
            if can_recover:
                for later in events[failure['position'] + 1:]:
                    params = later.get('params') or {}
                    turn = params.get('turn') or {}
                    if (later.get('method') == 'turn/completed' and params.get('threadId') == failure['thread_id']
                            and turn.get('id') == failure['turn_id'] and turn.get('status') == 'completed'):
                        recovered = True
                        break
            failure['recovered'] = recovered
            if not recovered:
                blocking.append(failure)
            continue
        item = failure.get('item') or {}
        output = str(item.get('aggregatedOutput') or '').lower()
        policy_marker = any(marker in output for marker in ('blocked by policy', 'denied by policy', 'approval rejected', 'approval denied', 'rejected by policy', '自动审批拒绝', '策略阻止'))
        ordinary = (task_kind == 'fix' and passed and failure.get('kind') == 'commandExecution'
                    and failure.get('status') in ('failed', 'completed')
                    and isinstance(failure.get('exit_code'), int) and failure['exit_code'] != 0
                    and isinstance(item.get('command'), str) and bool(item['command'])
                    and isinstance(item.get('cwd'), str) and bool(item['cwd'])
                    and failure.get('thread_id') and failure.get('turn_id') and not policy_marker)
        recovered = False
        if ordinary:
            for later in events[failure['position'] + 1:]:
                params = later.get('params') or {}
                candidate = params.get('item') or {}
                if (later.get('method') == 'item/completed' and candidate.get('type') == 'commandExecution'
                        and candidate.get('id') in verified_ids and candidate.get('status') == 'completed'
                        and candidate.get('exitCode') == 0 and candidate.get('command') == item['command']
                        and candidate.get('cwd') == item['cwd'] and params.get('threadId') == failure['thread_id']
                        and params.get('turnId') == failure['turn_id']):
                    recovered = True
                    break
        failure['recovered'] = recovered
        if not recovered:
            blocking.append(failure)
    reasons = []
    if turn_status != 'completed':
        reasons.append('turn_not_completed')
    if blocking:
        reasons.append('tool_failure')
    if not isinstance(outcome, dict) or not outcome:
        reasons.append('structured_outcome_missing')
    elif outcome.get('status') not in ('completed', 'success'):
        reasons.append('model_reports_incomplete')
    if task_kind == 'fix':
        if not isinstance(changes, dict) or not (changes.get('diff') or changes.get('untracked_artifacts')):
            reasons.append('change_evidence_missing')
        if not isinstance(verification, dict) or verification.get('status') != 'passed' or not verification.get('evidence'):
            reasons.append('verification_missing_or_failed')
    else:
        if isinstance(changes, dict) and (changes.get('diff') or changes.get('untracked_artifacts') or changes.get('status')):
            reasons.append('analysis_workspace_changed')
        if not isinstance(verification, dict) or verification.get('status') != 'passed' or not verification.get('evidence'):
            reasons.append('analysis_evidence_missing')
    return {'suggested_status': 'waiting_input' if reasons else 'review_ready',
            'task_kind': task_kind, 'turn_status': turn_status,
            'tool_failures': failures, 'blocking_tool_failures': blocking, 'reasons': reasons,
            'outcome': outcome, 'verification': verification}
