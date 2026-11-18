"""Administrator directory and local branch discovery."""
import os
import json
import subprocess
import sys
import threading
from ipaddress import ip_address
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from superagent.core.governance import authenticate_request, require_permission
from superagent.runtime.workspace import _git, _no_links


router = APIRouter(prefix='/api/v1/project-workspace')
_picker_lock = threading.Lock()

# Run Tk in a separate process so its UI always owns its main thread.
_PICK_DIRECTORY = '''
import json
import sys
import tkinter as tk
from tkinter import filedialog

root = tk.Tk()
root.withdraw()
root.attributes('-topmost', True)
try:
    selected = filedialog.askdirectory(
        parent=root, title='选择项目目录', initialdir=sys.argv[1], mustexist=True,
    )
    print(json.dumps({'path': selected or None}))
finally:
    root.destroy()
'''


class DirectorySelection(BaseModel):
    path: str = ''


def pick_directory(initial_path):
    result = subprocess.run(
        [sys.executable, '-c', _PICK_DIRECTORY, str(initial_path)],
        capture_output=True, text=True, timeout=180,
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
    if result.returncode:
        raise HTTPException(503, '无法打开系统文件夹选择窗口，请确认服务运行在当前 Windows 桌面会话中')
    return json.loads(result.stdout)['path']


@router.post('/select-directory')
def select_directory(body: DirectorySelection, request: Request,
                     principal=Depends(authenticate_request)):
    require_permission(principal, 'project.write')
    try:
        local = request.client is not None and ip_address(request.client.host).is_loopback
    except ValueError:
        local = False
    if os.name != 'nt' or not local:
        raise HTTPException(501, '系统文件夹选择需要从本机访问 Windows 服务，可使用网页目录浏览')
    if not _picker_lock.acquire(blocking=False):
        raise HTTPException(409, '文件夹选择窗口已打开，请先完成当前选择')
    try:
        initial = directory(body.path or os.getenv('SUPERAGENT_ALLOWED_REPO_ROOTS', '').split(os.pathsep)[0] or os.getcwd())
        selected = pick_directory(initial)
        return {'path': str(directory(selected)) if selected else None}
    except subprocess.TimeoutExpired:
        raise HTTPException(408, '选择目录已超时，请重新打开选择窗口') from None
    except (ValueError, OSError) as exc:
        raise HTTPException(422, str(exc)) from None
    finally:
        _picker_lock.release()


@router.get('/codex-projects')
def codex_projects(principal=Depends(authenticate_request)):
    require_permission(principal, 'project.write')
    state = Path(os.getenv('CODEX_HOME', str(Path.home() / '.codex'))) / '.codex-global-state.json'
    try:
        projects = json.loads(state.read_text(encoding='utf-8')).get('local-projects', {})
    except (OSError, ValueError):
        return {'items': [], 'reason': '本机 Codex 项目列表暂不可读取，可浏览目录选择'}
    items = []
    for ident, project in projects.items():
        for root in project.get('rootPaths', []):
            try:
                path = directory(root)
            except (OSError, ValueError):
                continue
            items.append({'id': ident, 'name': project.get('name', path.name), 'path': str(path)})
    return {'items': items}


def directory(value):
    path = Path(value).resolve(strict=True)
    roots = os.getenv('SUPERAGENT_ALLOWED_REPO_ROOTS', '')
    if roots and not any(path.is_relative_to(Path(root).resolve()) for root in roots.split(os.pathsep) if root):
        raise ValueError('目录超出已配置的项目范围')
    if not path.is_dir():
        raise ValueError('请选择目录')
    _no_links(Path(path.anchor), path.parts[1:])
    return path


def discover_repositories(root):
    repositories = []
    pending = [(root, 0)]
    skipped = {'node_modules', 'target', 'dist', 'build', '__pycache__', 'logs', 'output', 'data'}
    visited = 0
    complete = True
    while pending:
        parent, depth = pending.pop()
        try:
            children = sorted(parent.iterdir(), key=lambda item: item.name.casefold())
        except OSError:
            complete = False
            continue
        for child in children:
            visited += 1
            if visited > 2000:
                return repositories, False
            if child.name.startswith('.') or child.name in skipped or child.is_symlink() or child.is_junction():
                continue
            if not child.is_dir():
                continue
            if (child / '.git').exists():
                repositories.append({'name': child.relative_to(root).as_posix(), 'path': str(child)})
            elif depth < 1:
                pending.append((child, depth + 1))
    return repositories, complete


@router.get('')
def browse(path: str = '', principal=Depends(authenticate_request)):
    require_permission(principal, 'project.write')
    try:
        current = directory(path or os.getenv('SUPERAGENT_ALLOWED_REPO_ROOTS', '').split(os.pathsep)[0] or os.getcwd())
        folders = []
        for child in current.iterdir():
            if child.name.startswith('.') or child.is_symlink() or child.is_junction():
                continue
            if child.is_dir():
                folders.append({'name': child.name, 'path': str(child), 'repository': (child / '.git').exists()})
        branches = []
        current_branch = None
        warning = None
        if (current / '.git').exists():
            try:
                current_branch = _git(current, 'branch', '--show-current').strip()
                branches = _git(current, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/').splitlines()
            except (ValueError, subprocess.CalledProcessError):
                warning = '当前目录的 Git 信息暂不可读取，可继续选择目录和识别子仓库'
        repositories, complete = discover_repositories(current)
        parent = None
        try:
            if current.parent != current:
                parent = str(directory(str(current.parent)))
        except ValueError:
            pass
        return {'path': str(current), 'parent': parent, 'directories': sorted(folders, key=lambda x: x['name'].casefold()), 'branches': branches, 'current_branch': current_branch,
                'repositories': repositories, 'repositories_complete': complete, 'warning': warning}
    except (ValueError, OSError, subprocess.CalledProcessError) as exc:
        raise HTTPException(422, str(exc)) from None
