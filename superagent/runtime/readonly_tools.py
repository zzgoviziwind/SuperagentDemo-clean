"""Bounded read-only repository inspection for analysis-mode dynamic tools."""
import json
import os
from pathlib import Path
import stat
import time

MAX_OUTPUT_BYTES = 24_000
MAX_FILE_BYTES = 1_048_576
MAX_TOTAL_READ = 8_388_608
MAX_ENTRIES = 1000
MAX_DEPTH = 12
TIME_LIMIT_SECONDS = 2.0
_FORBIDDEN = {'.git', '.env', '.codex', '.agents', '.aws', '.ssh', 'credentials', 'id_rsa', 'id_ed25519', '.npmrc', '.netrc', '.pypirc', 'secrets.json', 'credentials.json'}
class AccessDenied(ValueError):
    """A security boundary was requested; later success cannot erase it."""

class NonText(ValueError):
    """A binary or non-UTF-8 file is intentionally not searched."""

_SUFFIXES = ('.pem', '.key', '.p12', '.pfx', '.jks', '.keystore', '.p8', '.kdbx')


def _sensitive(name):
    name=name.lower()
    return name in _FORBIDDEN or name.startswith('.env.') or name.endswith(_SUFFIXES)


def _parts(path):
    if not isinstance(path,str) or not path or len(path)>1024 or '\\' in path or '\x00' in path:
        raise AccessDenied('路径必须是仓库相对路径')
    if path=='.': return ()
    import ntpath
    if path.startswith('/') or ntpath.splitdrive(path)[0]: raise AccessDenied('不允许绝对路径')
    parts=path.split('/')
    if len(parts)>MAX_DEPTH or any(p in ('','.','..') or p.endswith(('.', ' ')) or ':' in p or _sensitive(p) for p in parts):
        raise AccessDenied('路径不允许访问')
    return tuple(parts)


def _is_link(info):
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info,'st_file_attributes',0) & 0x400)


def _resolve(root, path):
    parts=_parts(path)
    current=root
    for part in parts:
        current=current/part
        info=current.lstat()
        if _is_link(info): raise AccessDenied('不允许链接或重解析点')
    target=current.resolve(strict=True)
    if target != root and root not in target.parents: raise AccessDenied('路径越界')
    return target


def _text_file(path, budget):
    info=path.lstat()
    if _is_link(info) or not stat.S_ISREG(info.st_mode) or info.st_nlink>1: raise AccessDenied('不允许特殊文件或硬链接')
    if info.st_size > MAX_FILE_BYTES or info.st_size > budget: raise ValueError('文件超过读取限额')
    flags=os.O_RDONLY | getattr(os,'O_BINARY',0) | getattr(os,'O_NOFOLLOW',0)
    fd=os.open(path,flags)
    try:
        actual=os.fstat(fd)
        if not stat.S_ISREG(actual.st_mode) or actual.st_nlink>1 or (actual.st_dev,actual.st_ino)!=(info.st_dev,info.st_ino): raise AccessDenied('文件已变化')
        with os.fdopen(fd,'rb') as stream:
            fd=-1
            data=stream.read(min(MAX_FILE_BYTES,budget)+1)
    finally:
        if fd!=-1: os.close(fd)
    if len(data)>MAX_FILE_BYTES or len(data)>budget: raise ValueError('文件超过读取限额')
    if b'\x00' in data: raise NonText('二进制文件不可读取')
    try: return data.decode('utf-8-sig'),len(data)
    except UnicodeDecodeError: raise NonText('非 UTF-8 或二进制文件不可读取') from None


def _append(output, item):
    trial=output+[item]
    if len(json.dumps(trial,ensure_ascii=True).encode('ascii'))>MAX_OUTPUT_BYTES-1024: return False
    output.append(item)
    return True


def run_tool(workspace, name, arguments):
    """Return JSON-compatible output and file count; no shell or network access."""
    started=time.monotonic()
    root=Path(workspace).resolve(strict=True)
    if not root.is_dir(): raise ValueError('工作区不可用')
    if name not in ('list_files','read_file','search_text') or not isinstance(arguments,dict): raise ValueError('工具或参数无效')
    allowed={'list_files':{'path'},'read_file':{'path','start_line','max_lines'},'search_text':{'path','query'}}[name]
    if set(arguments)-allowed: raise ValueError('包含不支持的参数')
    rel=arguments.get('path','.')
    target=_resolve(root,rel)
    if name=='read_file':
        if rel=='.': raise ValueError('必须指定文件')
        start=arguments.get('start_line',1); count=arguments.get('max_lines',100)
        if type(start) is not int or start<1 or type(count) is not int or not 1<=count<=200: raise ValueError('行范围无效')
        content,size=_text_file(target,MAX_FILE_BYTES)
        lines=content.splitlines(); out=[]; truncated=False
        for n,line in enumerate(lines[start-1:start-1+count],start):
            shortened=len(line)>2000
            if not _append(out,{'line':n,'text':line[:2000],'line_truncated':shortened}): truncated=True; break
            truncated = truncated or shortened
        truncated=truncated or start-1+count<len(lines)
        return {'path':rel,'lines':out,'truncated':truncated,'total_lines':len(lines)},1
    query=arguments.get('query')
    if name=='search_text' and (not isinstance(query,str) or not 1<=len(query)<=256 or '\n' in query or '\r' in query): raise ValueError('搜索词无效')
    if name=='search_text' and target.is_file():
        content,_=_text_file(target,MAX_FILE_BYTES)
        out=[]; truncated=False
        for number,line in enumerate(content.splitlines(),1):
            if time.monotonic()-started>TIME_LIMIT_SECONDS:
                truncated=True; break
            if query in line:
                shortened=len(line)>2000
                if not _append(out,{'path':rel,'line':number,'text':line[:2000],'line_truncated':shortened}):
                    truncated=True; break
                truncated=truncated or shortened
        return {'matches':out,'truncated':truncated,'unreadable_files':0,'security_denials':0,'skipped_binary':0,'visited_entries':1},1
    if not target.is_dir(): raise ValueError('必须指定目录或安全文本文件')
    out=[]; visited=0; files=0; read_bytes=0; truncated=False; unreadable=0; denied=0; skipped_binary=0
    stack=[(target,rel,0)]
    while stack:
        directory,prefix,depth=stack.pop()
        if time.monotonic()-started > TIME_LIMIT_SECONDS: truncated=True; break
        try:
            with os.scandir(directory) as entries:
                for entry in entries:
                    visited+=1
                    if visited>MAX_ENTRIES or time.monotonic()-started>TIME_LIMIT_SECONDS:
                        truncated=True; break
                    if _sensitive(entry.name): continue
                    try:
                        info=entry.stat(follow_symlinks=False)
                        if _is_link(info): continue
                        relative=entry.name if prefix=='.' else prefix+'/'+entry.name
                        if stat.S_ISDIR(info.st_mode):
                            if depth<MAX_DEPTH-1: stack.append((Path(entry.path),relative,depth+1))
                            else: truncated=True
                            continue
                        if not stat.S_ISREG(info.st_mode) or info.st_nlink>1: continue
                        if name=='list_files':
                            files+=1
                            if not _append(out,{'path':relative,'size':info.st_size}): truncated=True; break
                        else:
                            if info.st_size>MAX_FILE_BYTES or read_bytes+info.st_size>MAX_TOTAL_READ:
                                truncated=True; continue
                            try: content,size=_text_file(Path(entry.path),MAX_TOTAL_READ-read_bytes)
                            except NonText:
                                skipped_binary+=1; continue
                            except AccessDenied:
                                denied+=1; truncated=True; continue
                            except OSError:
                                unreadable+=1; truncated=True; continue
                            except ValueError:
                                unreadable+=1; truncated=True; continue
                            files+=1; read_bytes+=size
                            for number,line in enumerate(content.splitlines(),1):
                                if query in line:
                                    shortened=len(line)>2000
                                    if not _append(out,{'path':relative,'line':number,'text':line[:2000],'line_truncated':shortened}): truncated=True; break
                                    truncated=truncated or shortened
                            if len(json.dumps(out,ensure_ascii=True))>MAX_OUTPUT_BYTES-2048: truncated=True; break
                    except OSError:
                        unreadable+=1; truncated=True; continue
                if visited>MAX_ENTRIES or time.monotonic()-started>TIME_LIMIT_SECONDS or len(json.dumps(out,ensure_ascii=True))>MAX_OUTPUT_BYTES-2048: break
        except OSError:
            unreadable+=1; truncated=True
    return {'files' if name=='list_files' else 'matches':out,'truncated':truncated,'unreadable_files':unreadable,'security_denials':denied,'skipped_binary':skipped_binary,'visited_entries':min(visited,MAX_ENTRIES)},files
