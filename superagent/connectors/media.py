"""Isolated DWS media collection with monitored and validated acceptance budgets."""

import asyncio
import ctypes
from ctypes import wintypes
import json
import math
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import shutil
import signal
import stat
import tempfile
from types import SimpleNamespace

from .attachments import DEFAULT_MIME_TYPES, EXTENSIONS, output_directory, save_response, validate_filename
from .common import ConnectorError
from .history import require_complete


class _WindowsJob:
    """Own one job handle so descendants remain addressable after parent exit."""

    def __init__(self, pid):
        class BasicLimits(ctypes.Structure):
            _fields_ = [("process_time", ctypes.c_longlong), ("job_time", ctypes.c_longlong),
                        ("flags", wintypes.DWORD), ("minimum_working_set", ctypes.c_size_t),
                        ("maximum_working_set", ctypes.c_size_t), ("active_processes", wintypes.DWORD),
                        ("affinity", ctypes.c_size_t), ("priority", wintypes.DWORD), ("scheduling", wintypes.DWORD)]
        class IoCounters(ctypes.Structure):
            _fields_ = [(name, ctypes.c_ulonglong) for name in
                        ("read_operations", "write_operations", "other_operations", "read_bytes", "write_bytes", "other_bytes")]
        class ExtendedLimits(ctypes.Structure):
            _fields_ = [("basic", BasicLimits), ("io", IoCounters),
                        ("process_memory", ctypes.c_size_t), ("job_memory", ctypes.c_size_t),
                        ("peak_process_memory", ctypes.c_size_t), ("peak_job_memory", ctypes.c_size_t)]
        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        for name, arguments, result in [
            ("CreateJobObjectW", [ctypes.c_void_p, wintypes.LPCWSTR], wintypes.HANDLE),
            ("SetInformationJobObject", [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD], wintypes.BOOL),
            ("OpenProcess", [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD], wintypes.HANDLE),
            ("AssignProcessToJobObject", [wintypes.HANDLE, wintypes.HANDLE], wintypes.BOOL),
            ("TerminateJobObject", [wintypes.HANDLE, wintypes.UINT], wintypes.BOOL),
            ("CloseHandle", [wintypes.HANDLE], wintypes.BOOL),
        ]:
            function = getattr(self.kernel, name)
            function.argtypes, function.restype = arguments, result
        self.handle = self.kernel.CreateJobObjectW(None, None)
        process_handle = None
        try:
            limits = ExtendedLimits()
            limits.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            if not self.handle or not self.kernel.SetInformationJobObject(self.handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
                raise ConnectorError("dws_media_process_tree_unavailable")
            process_handle = self.kernel.OpenProcess(0x0101, False, pid)
            if not process_handle or not self.kernel.AssignProcessToJobObject(self.handle, process_handle):
                raise ConnectorError("dws_media_process_tree_unavailable")
            self._resume_main_thread(pid)
        except BaseException:
            self.close()
            raise
        finally:
            if process_handle:
                self.kernel.CloseHandle(process_handle)

    def _resume_main_thread(self, pid):
        # The process was created suspended, so its launcher cannot create a
        # descendant before assignment to our job.
        class ThreadEntry(ctypes.Structure):
            _fields_ = [("size", wintypes.DWORD), ("usage", wintypes.DWORD),
                        ("thread_id", wintypes.DWORD), ("process_id", wintypes.DWORD),
                        ("base_priority", wintypes.LONG), ("delta_priority", wintypes.LONG),
                        ("flags", wintypes.DWORD)]
        functions = [
            ("CreateToolhelp32Snapshot", [wintypes.DWORD, wintypes.DWORD], wintypes.HANDLE),
            ("Thread32First", [wintypes.HANDLE, ctypes.POINTER(ThreadEntry)], wintypes.BOOL),
            ("Thread32Next", [wintypes.HANDLE, ctypes.POINTER(ThreadEntry)], wintypes.BOOL),
            ("OpenThread", [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD], wintypes.HANDLE),
            ("ResumeThread", [wintypes.HANDLE], wintypes.DWORD),
        ]
        for name, arguments, result in functions:
            function = getattr(self.kernel, name)
            function.argtypes, function.restype = arguments, result
        snapshot = self.kernel.CreateToolhelp32Snapshot(4, 0)
        if snapshot == ctypes.c_void_p(-1).value:
            raise ConnectorError("dws_media_process_resume_failed")
        entry = ThreadEntry()
        entry.size = ctypes.sizeof(entry)
        try:
            present = self.kernel.Thread32First(snapshot, ctypes.byref(entry))
            while present:
                if entry.process_id == pid:
                    thread = self.kernel.OpenThread(2, False, entry.thread_id)
                    if not thread:
                        raise ConnectorError("dws_media_process_resume_failed")
                    try:
                        if self.kernel.ResumeThread(thread) == 0xFFFFFFFF:
                            raise ConnectorError("dws_media_process_resume_failed")
                        return
                    finally:
                        self.kernel.CloseHandle(thread)
                present = self.kernel.Thread32Next(snapshot, ctypes.byref(entry))
            raise ConnectorError("dws_media_process_resume_failed")
        finally:
            self.kernel.CloseHandle(snapshot)

    def close(self):
        if self.handle:
            self.kernel.TerminateJobObject(self.handle, 1)
            self.kernel.CloseHandle(self.handle)
            self.handle = None


def _inventory(root, max_files, max_total_bytes, max_file_bytes=None):
    files, total, directories = [], 0, [root]
    visited = 0
    while directories:
        directory = directories.pop()
        visited += 1
        if visited > max_files * 4 + 10:
            raise ConnectorError("dws_media_directory_limit")
        for path in directory.iterdir():
            try:
                info = path.lstat()
            except FileNotFoundError:
                continue  # CLI can atomically rename a partial file during a scan.
            if path.is_symlink() or path.is_junction():
                raise ConnectorError("dws_media_link_rejected")
            if stat.S_ISDIR(info.st_mode):
                directories.append(path)
                if len(directories) + visited > max_files * 4 + 10:
                    raise ConnectorError("dws_media_directory_limit")
            elif stat.S_ISREG(info.st_mode):
                files.append(path)
                total += info.st_size
                if len(files) > max_files or total > max_total_bytes or (max_file_bytes and info.st_size > max_file_bytes):
                    raise ConnectorError("dws_media_budget_exceeded")
            else:
                raise ConnectorError("dws_media_special_file_rejected")
    return files


async def _read_bounded(stream, maximum):
    result = bytearray()
    while chunk := await stream.read(65536):
        result.extend(chunk)
        if len(result) > maximum:
            raise ConnectorError("dws_media_output_limit")
    return bytes(result)


async def _terminate_unassigned(process):
    if os.name == "nt":
        if process.returncode is None:
            killer = await asyncio.create_subprocess_exec("taskkill.exe", "/PID", str(process.pid), "/T", "/F",
                                                           stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
                                                           creationflags=0x08000000)
            await killer.wait()
    else:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


async def _kill_unassigned(process):
    communication = asyncio.create_task(process.communicate())
    await _terminate_unassigned(process)
    await communication


async def _collect(argv, root, *, timeout, max_files, max_bytes, max_total_bytes, poll_interval):
    deadline = asyncio.get_running_loop().time() + timeout
    options = {"creationflags": 0x08000004} if os.name == "nt" else {"start_new_session": True}
    spawning = asyncio.create_task(asyncio.create_subprocess_exec(*argv, cwd=str(root), stdin=asyncio.subprocess.DEVNULL,
                                         stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, **options))
    try:
        process = await asyncio.shield(spawning)
    except asyncio.CancelledError:
        process = await spawning
        await _kill_unassigned(process)
        raise
    job, readers = None, []
    try:
        readers = [asyncio.create_task(_read_bounded(process.stdout, 1024 * 1024)),
                   asyncio.create_task(_read_bounded(process.stderr, 256 * 1024))]
        if os.name == "nt":
            job = _WindowsJob(process.pid)
        while process.returncode is None:
            _inventory(root, max_files, max_total_bytes, max_bytes)
            for reader in readers:
                if reader.done() and reader.exception():
                    raise reader.exception()
            if asyncio.get_running_loop().time() >= deadline:
                raise ConnectorError("dws_media_timeout")
            await asyncio.sleep(poll_interval)
        if process.returncode:
            raise ConnectorError("dws_media_query_failed")
        # Stop any descendants retaining a pipe or writing after the CLI exits.
        if job:
            job.close()
        elif os.name != "nt":
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        remaining = max(0.01, deadline - asyncio.get_running_loop().time())
        stdout, _ = await asyncio.wait_for(asyncio.gather(*readers), remaining)
        _inventory(root, max_files, max_total_bytes, max_bytes)
        try:
            return json.loads(stdout)
        except ValueError:
            raise ConnectorError("dws_media_invalid_json") from None
    finally:
        if job:
            job.close()
        else:
            await _terminate_unassigned(process)
        for reader in readers:
            reader.cancel()
        await asyncio.gather(*readers, return_exceptions=True)
        # A failed bounded reader can leave the subprocess transport paused.
        # Drain after terminating the tree so waiting for exit cannot deadlock.
        await process.communicate()


async def _remove_owned(directory):
    # Windows can briefly retain a killed descendant's working-directory handle.
    for attempt in range(20):
        try:
            shutil.rmtree(directory)
            return
        except PermissionError:
            if attempt == 19:
                raise
            await asyncio.sleep(0.05)


def _validate_ledger(result, root, conversation_id, message_id, max_files):
    data = require_complete(result)
    rows = data["messages"]
    if len(rows) != 1 or rows[0].get("messageId") != message_id or rows[0].get("conversationId") != conversation_id:
        raise ConnectorError("dws_message_scope_unverified")
    ledger = data.get("resourceDownloads")
    if (not isinstance(ledger, dict) or ledger.get("ok") is not True or ledger.get("partial") is not False or
            ledger.get("failedCount") != 0 or ledger.get("failures")):
        raise ConnectorError("dws_media_download_incomplete")
    downloads = ledger.get("downloads")
    if (not isinstance(downloads, list) or len(downloads) > max_files or
            ledger.get("requestedCount") != len(downloads) or ledger.get("downloadedCount") != len(downloads)):
        raise ConnectorError("dws_media_download_incomplete")
    found, validated = set(), []
    for item in downloads:
        relative = item.get("localPath")
        if (not isinstance(relative, str) or "\\" in relative or PureWindowsPath(relative).is_absolute() or
                PurePosixPath(relative).is_absolute() or ".." in PurePosixPath(relative).parts):
            raise ConnectorError("dws_media_unsafe_path")
        path = root / relative
        if (not path.is_relative_to(root / "downloads") or path.is_symlink() or path.is_junction() or
                path.resolve() != path.absolute() or not path.is_file() or path.stat().st_nlink != 1 or
                path.stat().st_size != item.get("sizeBytes") or item.get("messageId") != message_id or
                item.get("resourceType") not in {"mediaId", "fileId"} or not item.get("resourceId") or path in found):
            raise ConnectorError("dws_media_file_unverified")
        validate_filename(path.name)
        found.add(path)
        validated.append((path, item))
    if set(_inventory(root, max_files, 2**63 - 1)) != found:
        raise ConnectorError("dws_media_unlisted_files")
    return validated


async def download_message_resources(executable, profile, conversation_id, message_id, output_dir, *,
                                     max_bytes=20 * 1024 * 1024, max_total_bytes=40 * 1024 * 1024,
                                     max_files=10, timeout=60, mime_types=DEFAULT_MIME_TYPES,
                                     poll_interval=0.05):
    """Limit accepted artifacts. Temporary/network bytes can exceed polling budgets."""
    if (not conversation_id or not message_id or "," in message_id or
            any(type(value) is not int or value <= 0 for value in (max_bytes, max_total_bytes, max_files)) or
            any(not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0 for value in (timeout, poll_interval))):
        raise ValueError("Explicit message scope and positive budgets are required")
    directory = output_directory(output_dir)
    temporary = Path(tempfile.mkdtemp(prefix=".dws-media-", dir=directory))
    published = None
    try:
        argv = list(executable) + ["--profile", profile, "chat", "+messages-mget", "--msg-ids", message_id,
                                  "--no-reactions", "--no-threads", "--download-resources",
                                  "--output-dir", "downloads", "--format", "json"]
        result = await _collect(argv, temporary, timeout=timeout, max_files=max_files,
                                max_bytes=max_bytes, max_total_bytes=max_total_bytes, poll_interval=poll_interval)
        files = _validate_ledger(result, temporary, conversation_id, message_id, max_files)
        accepted = temporary / "accepted"
        accepted.mkdir()
        metadata = []
        for path, item in files:
            mime_type = next((mime for mime, extensions in EXTENSIONS.items() if path.suffix.lower() in extensions), None)
            with path.open("rb") as stream:
                response = SimpleNamespace(headers={"Content-Type": mime_type or "", "Content-Length": str(path.stat().st_size)},
                                           read=stream.read)
                saved = save_response(response, filename=path.name, output_dir=accepted,
                                      max_bytes=max_bytes, mime_types=mime_types, expected_size=item["sizeBytes"])
            metadata.append({**saved, "source": "dingtalk", "profile": profile, "message_id": message_id,
                             "conversation_id": conversation_id, "resource_id": item["resourceId"],
                             "resource_type": item["resourceType"]})
        if metadata:
            # The random name is reserved by this operation and removed only by it.
            published = Path(tempfile.mkdtemp(prefix="dingtalk-", dir=directory))
            for saved in metadata:
                target = published / saved["filename"]
                os.link(saved["local_path"], target)
                saved["local_path"] = str(target)
        return {"source": "dingtalk", "profile": profile, "conversation_id": conversation_id,
                "message_id": message_id, "complete": True, "attachments": metadata,
                "network_bytes_hard_limited": False}
    except BaseException:
        if published:
            await _remove_owned(published)
        raise
    finally:
        await _remove_owned(temporary)
