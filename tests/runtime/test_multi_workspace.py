import subprocess

import pytest

from superagent.runtime.workspace import prepare_project_workspace, collect_changes, validate_workspace_changes


def test_multiple_repository_branches_and_validation(tmp_path):
    source = tmp_path / 'project'
    source.mkdir()
    workspaces = tmp_path / 'workspaces'
    workspaces.mkdir()
    repositories = []
    for name, branch in [('frontend', '前端集成'), ('backend', '德阳市人民'), ('api', '接口')]:
        repo = source / name
        repo.mkdir()
        def git(*args):
            subprocess.run(['git', '-C', str(repo), *args], check=True, capture_output=True)
        git('init', '-b', branch)
        git('config', 'user.email', 'test@example.invalid')
        git('config', 'user.name', 'Test')
        (repo / 'file.txt').write_text('base')
        git('add', '.')
        git('commit', '-m', 'test（common）：建立仓库基线')
        repositories.append({'path': name, 'base_branch': branch})
    result = prepare_project_workspace(source, 'main', 'one', workspaces, repositories)
    target = workspaces / 'one'
    clean = collect_changes(target, result['base_sha'])
    from superagent.runtime.outcome import assess_outcome
    verified = assess_outcome(task_kind='analysis', turn_status='completed', events=[], changes=clean,
                              verification={'status': 'passed', 'evidence': {'readonly_tool_calls': 3}},
                              outcome={'status': 'completed'})
    assert verified['suggested_status'] == 'review_ready'
    assert clean['diff'] == clean['stat'] == clean['status'] == ''
    (target / 'backend' / 'file.txt').write_text('changed')
    validate_workspace_changes(target, result['base_sha'], ['backend'])
    changes = collect_changes(target, result['base_sha'])
    assert 'changed' in changes['diff']
    assert changes['status'].splitlines()[0] == 'backend'
    assert 'frontend' not in changes['status'] and 'api' not in changes['status']
    assert len(changes['repositories']) == 3
    with pytest.raises(ValueError):
        validate_workspace_changes(target, result['base_sha'], ['frontend'])
    (target / 'outside.txt').write_text('unexpected')
    with pytest.raises(ValueError):
        validate_workspace_changes(target, result['base_sha'], ['.'])
    live_file = source / 'frontend' / 'file.txt'
    live_file.write_text('unsaved')
    readonly = prepare_project_workspace(source, 'main', 'readonly', workspaces, repositories, committed_analysis=True)
    assert (workspaces / 'readonly' / 'frontend' / 'file.txt').read_text() == 'base'
    assert live_file.read_text() == 'unsaved'
    assert readonly['base_sha'] == result['base_sha']

