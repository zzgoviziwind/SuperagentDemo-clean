"""Independent local clones with explicit baseline checks."""
import base64
import hashlib
import os
from pathlib import Path
import re
import subprocess


def _git(path, *args, limit=8 * 1024 * 1024):
    """Bound stdout while the process runs; do not return partial results."""
    if limit < 0:
        raise ValueError('output limit exceeded')
    process = subprocess.Popen(['git', '-C', str(path), *args], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    output = bytearray()
    try:
        while True:
            chunk = process.stdout.read(min(65536, limit + 1 - len(output)))
            if not chunk:
                break
            output.extend(chunk)
            if len(output) > limit:
                raise ValueError('git output size limit exceeded')
        code = process.wait()
        if code:
            raise subprocess.CalledProcessError(code, process.args)
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        process.stdout.close()
    return output.decode('utf-8', errors='strict')


def prepare_workspace(repo_path, base_branch, task_id, workspaces_root):
    repo = Path(repo_path).resolve(strict=True)
    root = Path(workspaces_root).resolve(strict=True)
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,63}', str(task_id)):
        raise ValueError('invalid task id')
    if repo == root or repo in root.parents or root in repo.parents:
        raise ValueError('workspace root and repository must be separate')
    if Path(_git(repo, 'rev-parse', '--show-toplevel').strip()).resolve() != repo:
        raise ValueError('repository path must be its root')
    if _git(repo, 'status', '--porcelain', '--untracked-files=all'):
        raise ValueError('source repository has uncommitted changes')
    if not base_branch or base_branch.startswith('-'):
        raise ValueError('invalid base branch')
    sha = _git(repo, 'rev-parse', '--verify', f'refs/heads/{base_branch}^{{commit}}').strip()
    target = root / str(task_id)
    if target.exists() or target.is_symlink():
        raise FileExistsError(str(target))
    branch = 'superagent/' + str(task_id)
    subprocess.run(['git', 'clone', '--no-hardlinks', '--no-checkout', '--', str(repo), str(target)], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    _git(target, 'switch', '-c', branch, sha)
    return {'path': str(target), 'base_sha': sha, 'branch': branch}


def _safe_name(name):
    parts = Path(name).parts
    forbidden = {'.git', '.env', '.aws', '.ssh', '.codex', '.agents'}
    for part in parts:
        lower = part.lower()
        if lower in forbidden or lower.startswith('.env.') or lower in {'credentials', 'id_rsa', 'id_ed25519'} or lower.endswith(('.pem', '.key', '.p12', '.pfx')):
            raise ValueError(f'potential secret path excluded: {name}')


def collect_changes(path, base_sha=None, max_file_bytes=1024 * 1024, max_total_bytes=8 * 1024 * 1024):
    repo = Path(path).resolve(strict=True)
    if Path(_git(repo, 'rev-parse', '--show-toplevel').strip()).resolve() != repo:
        raise ValueError('path must be repository root')
    if base_sha is None:
        base_sha = 'HEAD'
    if not re.fullmatch(r'[0-9a-fA-F]{40,64}|HEAD', base_sha):
        raise ValueError('base_sha must be a full commit hash')
    base = _git(repo, 'rev-parse', '--verify', base_sha + '^{commit}').strip()
    if not isinstance(max_total_bytes, int) or not isinstance(max_file_bytes, int) or max_total_bytes <= 0 or max_file_bytes <= 0:
        raise ValueError('size limits must be positive integers')
    names = changed_paths(repo, base)
    untracked = _git(repo, 'ls-files', '--others', '--exclude-standard', '-z', limit=max_total_bytes).split('\0')
    for name in names:
        _safe_name(name)
        _no_links(repo, _relative_parts(name))
    artifacts = []
    total = 0
    for name in untracked:
        if not name:
            continue
        candidate = repo / name
        _no_links(repo, _relative_parts(name))
        resolved = candidate.resolve(strict=True)
        if repo not in resolved.parents or not resolved.is_file():
            raise ValueError(f'unsafe file: {name}')
        size = resolved.stat().st_size
        total += size
        if size > max_file_bytes or total > max_total_bytes:
            raise ValueError(f'untracked artifact size limit exceeded: {name}')
        with resolved.open('rb') as stream:
            data = stream.read(max_file_bytes + 1)
        if len(data) != size:
            raise ValueError(f'file changed while collecting: {name}')
        encoded = base64.b64encode(data).decode('ascii')
        total += len(encoded) - size
        if total > max_total_bytes:
            raise ValueError('artifact output size limit exceeded')
        artifacts.append({'path': name, 'size': size, 'sha256': hashlib.sha256(data).hexdigest(), 'content_base64': encoded})
    outputs = {}
    for key, args in (('diff', ('diff', '--binary', base, '--')), ('stat', ('diff', '--stat', base, '--')), ('status', ('status', '--porcelain', '--untracked-files=all'))):
        outputs[key] = _git(repo, *args, limit=max_total_bytes - total)
        total += len(outputs[key].encode('utf-8'))
    return {'base_sha': base, **outputs, 'untracked_artifacts': artifacts}
# Path policies are validation gates, not OS sandbox restrictions.
def _relative_parts(value, *, allow_root=False):
    import ntpath
    if not isinstance(value, str) or not value or '\x00' in value or '\\' in value:
        raise ValueError('invalid relative path')
    if value == '.' and allow_root:
        return ()
    if value.startswith('/') or ntpath.splitdrive(value)[0]:
        raise ValueError('absolute or drive path rejected')
    parts = value.split('/')
    if any(part in ('', '.', '..') or ':' in part for part in parts):
        raise ValueError('invalid path component')
    return tuple(parts)


def _no_links(root, parts):
    import stat
    current = root
    for part in parts:
        current = current / part
        try:
            st = current.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(st.st_mode) or getattr(st, 'st_file_attributes', 0) & 0x400:
            raise ValueError(f'link or reparse point rejected: {current}')
    if parts:
        target = root.joinpath(*parts).resolve(strict=False)
        if root not in target.parents:
            raise ValueError('path escapes workspace')


def validate_allowed_paths(workspace_path, paths, allowed_paths):
    """Validate repo-relative paths, raising ValueError on any disallowed path.

    `allowed_paths` entries are repo-relative files/directories; '.' permits all.
    An empty list permits none. This does not prevent writes during execution.
    """
    root = Path(workspace_path).resolve(strict=True)
    if not root.is_dir():
        raise ValueError('workspace must be a directory')
    if not isinstance(allowed_paths, list):
        raise ValueError('allowed_paths must be a list')
    allowed = [_relative_parts(p, allow_root=True) for p in allowed_paths]
    for entry in allowed:
        _no_links(root, entry)
    normalized = []
    for path in paths:
        parts = _relative_parts(path)
        _no_links(root, parts)
        comparable = tuple(os.path.normcase(part) for part in parts)
        if not any(comparable[:len(a)] == tuple(os.path.normcase(x) for x in a) for a in allowed):
            raise ValueError(f'path outside allowed_paths: {path}')
        normalized.append('/'.join(parts))
    return normalized


def changed_paths(workspace_path, base_sha):
    """Return all tracked old/new paths and untracked paths against a commit."""
    repo = Path(workspace_path).resolve(strict=True)
    if Path(_git(repo, 'rev-parse', '--show-toplevel').strip()).resolve() != repo:
        raise ValueError('path must be repository root')
    if not isinstance(base_sha, str) or not re.fullmatch(r'[0-9a-fA-F]{40,64}', base_sha):
        raise ValueError('base_sha must be a full commit hash')
    _git(repo, 'rev-parse', '--verify', base_sha + '^{commit}')
    def raw(*args):
        return _git(repo, *args).split('\x00')
    tokens = raw('diff', '--name-status', '-z', '--find-renames', base_sha, '--')
    result = []
    index = 0
    while index < len(tokens) and tokens[index]:
        status = tokens[index]; index += 1
        count = 2 if status[0] in ('R', 'C') else 1
        if index + count > len(tokens) or not all(tokens[index:index + count]):
            raise ValueError('malformed git diff output')
        result.extend(tokens[index:index + count]); index += count
    result.extend(name for name in raw('ls-files', '--others', '--exclude-standard', '-z') if name)
    return list(dict.fromkeys(result))


def validate_workspace_changes(workspace_path, base_sha, allowed_paths):
    return validate_allowed_paths(workspace_path, changed_paths(workspace_path, base_sha), allowed_paths)
