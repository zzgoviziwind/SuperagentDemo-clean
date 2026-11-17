"""Bounded attachment validation and atomic, non-overwriting publication."""

import hashlib
import codecs
import os
from pathlib import Path, PureWindowsPath
import tempfile

from .common import ConnectorError


DEFAULT_MIME_TYPES = frozenset({"image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain"})
EXTENSIONS = {"image/png": {".png"}, "image/jpeg": {".jpg", ".jpeg"},
              "image/gif": {".gif"}, "image/webp": {".webp"},
              "application/pdf": {".pdf"}, "text/plain": {".txt", ".log"}}


def validate_filename(filename):
    if not isinstance(filename, str) or not filename or len(filename) > 180:
        raise ConnectorError("attachment_invalid_filename")
    if any(ord(char) < 32 or char in '/\\:<>"|?*' for char in filename) or filename.endswith((".", " ")):
        raise ConnectorError("attachment_unsafe_filename")
    if PureWindowsPath(filename).name != filename or filename in {".", ".."}:
        raise ConnectorError("attachment_unsafe_filename")
    stem = filename.split(".", 1)[0].rstrip(" .").upper()
    reserved = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}
    if stem in reserved:
        raise ConnectorError("attachment_unsafe_filename")
    return filename


def output_directory(output_dir):
    if ".." in Path(output_dir).parts:
        raise ConnectorError("attachment_output_traversal")
    directory = Path(output_dir).absolute()
    for parent in (directory, *directory.parents):
        if parent.is_symlink() or parent.is_junction():
            raise ConnectorError("attachment_output_symlink")
    directory.mkdir(parents=True, exist_ok=True)
    return directory.resolve(strict=True)


def validate_content(prefix, mime_type):
    matches = {"image/png": prefix.startswith(b"\x89PNG\r\n\x1a\n"),
               "image/jpeg": prefix.startswith(b"\xff\xd8\xff"),
               "image/gif": prefix.startswith((b"GIF87a", b"GIF89a")),
               "image/webp": prefix.startswith(b"RIFF") and prefix[8:12] == b"WEBP",
               "application/pdf": prefix.startswith(b"%PDF-")}
    if mime_type == "text/plain":
        try:
            text = codecs.getincrementaldecoder("utf-8-sig")().decode(prefix, final=False)
            matches[mime_type] = "\x00" not in text and not text.lstrip().lower().startswith(("<html", "<!doctype", "<svg", "<script"))
        except UnicodeDecodeError:
            matches[mime_type] = False
    if not matches.get(mime_type):
        raise ConnectorError("attachment_content_type_mismatch")


def save_response(response, *, filename, output_dir, max_bytes, mime_types, expected_size=None,
                  expected_mime=None, cancelled=None):
    directory = output_directory(output_dir)
    filename = validate_filename(filename)
    target = directory / filename
    if target.exists() or target.is_symlink():
        raise ConnectorError("attachment_file_exists")
    mime_type = response.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
    if mime_type not in mime_types or mime_type not in EXTENSIONS or Path(filename).suffix.lower() not in EXTENSIONS[mime_type]:
        raise ConnectorError("attachment_mime_not_allowed")
    if expected_mime and expected_mime.split(";", 1)[0].strip().lower() != mime_type:
        raise ConnectorError("attachment_content_type_mismatch")
    try:
        declared = response.headers.get("Content-Length")
        declared = int(declared) if declared is not None else None
    except ValueError:
        raise ConnectorError("attachment_invalid_length") from None
    for length in (declared, expected_size):
        if length is not None and (length < 0 or length > max_bytes):
            raise ConnectorError("attachment_size_limit")
    descriptor, temporary = tempfile.mkstemp(prefix=".attachment-", suffix=".part", dir=directory)
    total, prefix, content_hash = 0, bytearray(), hashlib.sha256()
    try:
        with os.fdopen(descriptor, "wb") as output:
            while True:
                if cancelled and cancelled.is_set():
                    raise ConnectorError("attachment_cancelled")
                chunk = response.read(min(65536, max_bytes - total + 1))
                if not chunk:
                    break
                total += len(chunk)
                if total > max_bytes:
                    raise ConnectorError("attachment_size_limit")
                if len(prefix) < 4096:
                    prefix.extend(chunk[:4096 - len(prefix)])
                output.write(chunk)
                content_hash.update(chunk)
            if total == 0 or any(length is not None and length != total for length in (declared, expected_size)):
                raise ConnectorError("attachment_incomplete")
            validate_content(bytes(prefix), mime_type)
            output.flush()
            os.fsync(output.fileno())
        if cancelled and cancelled.is_set():
            raise ConnectorError("attachment_cancelled")
        # Hard-link publication is atomic and fails if the destination exists.
        os.link(temporary, target)
        return {"local_path": str(target), "filename": filename, "size": total,
                "content_type": mime_type, "sha256": content_hash.hexdigest()}
    except FileExistsError:
        raise ConnectorError("attachment_file_exists") from None
    finally:
        Path(temporary).unlink(missing_ok=True)
