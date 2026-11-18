"""Archive or restore the pinned behavioral reference independently of the other worktree."""
import argparse
import hashlib
import json
import tempfile
import zipfile
from pathlib import Path, PureWindowsPath

from freeze import MANIFEST, ROOT

SNAPSHOT = ROOT / ".rewrite-oracle"


def checked(name, payload, hashes):
    parts = PureWindowsPath(name)
    if parts.is_absolute() or parts.drive or ".." in parts.parts or "\\" in name:
        raise ValueError("Invalid input path")
    if hashlib.sha256(payload).hexdigest() != hashes[name]:
        raise ValueError("Input fingerprint differs: " + name)
    return payload


def archive(destination, hashes):
    with zipfile.ZipFile(destination, "x", compression=zipfile.ZIP_DEFLATED) as output:
        for name in sorted(hashes):
            item = zipfile.ZipInfo(name, date_time=(2026, 11, 18, 0, 0, 0))
            item.compress_type = zipfile.ZIP_DEFLATED
            output.writestr(item, checked(name, (SNAPSHOT / name).read_bytes(), hashes))


def restore(source, hashes):
    with zipfile.ZipFile(source) as bundle, tempfile.TemporaryDirectory(dir=ROOT) as tmp:
        if sorted(bundle.namelist()) != sorted(hashes):
            raise ValueError("Reference file list differs")
        staged = Path(tmp) / "oracle"
        for name in hashes:
            payload = checked(name, bundle.read(name), hashes)
            target = staged / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(payload)
        if SNAPSHOT.exists():
            for name in hashes:
                checked(name, (SNAPSHOT / name).read_bytes(), hashes)
        else:
            staged.rename(SNAPSHOT)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["archive", "restore"])
    parser.add_argument("file", type=Path)
    args = parser.parse_args()
    manifest = json.loads(MANIFEST.read_text("utf-8"))
    {"archive": archive, "restore": restore}[args.action](args.file, manifest["files"])
    print(manifest["fingerprint"])
