import subprocess
import os
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient

from superagent.api import project_workspace
from superagent.core.governance import Principal


@pytest.fixture
def native_picker(monkeypatch):
    monkeypatch.setattr(project_workspace, 'os', SimpleNamespace(
        name='nt', getenv=os.getenv, path=os.path, pathsep=os.pathsep, getcwd=os.getcwd,
    ))
    monkeypatch.delenv('SUPERAGENT_ALLOWED_REPO_ROOTS', raising=False)
    return Request({'type': 'http', 'client': ('127.0.0.1', 1234)})


@pytest.mark.parametrize('cancelled', [False, True])
def test_native_selection_and_cancel(tmp_path, monkeypatch, native_picker, cancelled):
    monkeypatch.setattr(project_workspace, 'pick_directory', lambda initial: None if cancelled else str(tmp_path))
    result = project_workspace.select_directory(
        project_workspace.DirectorySelection(path=str(tmp_path)), native_picker, Principal('admin', 'admin'),
    )
    assert result == {'path': None if cancelled else str(tmp_path.resolve())}


def test_native_selection_validates_selected_scope(tmp_path, monkeypatch, native_picker):
    allowed = tmp_path / 'allowed'
    allowed.mkdir()
    monkeypatch.setenv('SUPERAGENT_ALLOWED_REPO_ROOTS', str(allowed))
    monkeypatch.setattr(project_workspace, 'pick_directory', lambda initial: str(tmp_path))
    with pytest.raises(HTTPException) as exc:
        project_workspace.select_directory(
            project_workspace.DirectorySelection(path=str(allowed)), native_picker, Principal('admin', 'admin'),
        )
    assert exc.value.status_code == 422
    assert not project_workspace._picker_lock.locked()


def test_remote_request_cannot_open_server_dialog(native_picker):
    remote = Request({'type': 'http', 'client': ('192.168.1.2', 1234)})
    with pytest.raises(HTTPException) as exc:
        project_workspace.select_directory(
            project_workspace.DirectorySelection(), remote, Principal('admin', 'admin'),
        )
    assert exc.value.status_code == 501


def test_picker_timeout_releases_lock(tmp_path, monkeypatch, native_picker):
    def timeout(initial):
        raise subprocess.TimeoutExpired('picker', 180)
    monkeypatch.setattr(project_workspace, 'pick_directory', timeout)
    with pytest.raises(HTTPException) as exc:
        project_workspace.select_directory(
            project_workspace.DirectorySelection(path=str(tmp_path)), native_picker, Principal('admin', 'admin'),
        )
    assert exc.value.status_code == 408
    assert not project_workspace._picker_lock.locked()


def test_native_picker_http_entry(tmp_path, monkeypatch, native_picker):
    app = FastAPI()
    app.include_router(project_workspace.router)
    app.dependency_overrides[project_workspace.authenticate_request] = lambda: Principal('admin', 'admin')
    monkeypatch.setattr(project_workspace, 'pick_directory', lambda initial: str(tmp_path))
    with TestClient(app, client=('127.0.0.1', 1234)) as client:
        response = client.post('/api/v1/project-workspace/select-directory', json={'path': str(tmp_path)})
    assert response.status_code == 200
    assert response.json() == {'path': str(tmp_path.resolve())}


def test_broken_parent_git_keeps_nested_repositories_browsable(tmp_path, monkeypatch):
    (tmp_path / ".git").mkdir()
    nested = tmp_path / "interface" / "hjk"
    (nested / ".git").mkdir(parents=True)
    (tmp_path / "web" / ".git").mkdir(parents=True)
    monkeypatch.delenv("SUPERAGENT_ALLOWED_REPO_ROOTS", raising=False)

    def unavailable(*args):
        raise subprocess.CalledProcessError(128, ["git"])

    monkeypatch.setattr(project_workspace, "_git", unavailable)
    result = project_workspace.browse(str(tmp_path), Principal("admin", "admin"))
    assert result["warning"]
    assert result["branches"] == []
    assert {repo["name"] for repo in result["repositories"]} == {"interface/hjk", "web"}
    assert result["repositories_complete"]


def test_discovery_skips_dependencies_and_repository_contents(tmp_path):
    for path in ["node_modules/vendor", "backend", "backend/nested", "interface/service"]:
        (tmp_path / path / ".git").mkdir(parents=True)
    repositories, complete = project_workspace.discover_repositories(tmp_path)
    assert {repo["name"] for repo in repositories} == {"backend", "interface/service"}
    assert complete
