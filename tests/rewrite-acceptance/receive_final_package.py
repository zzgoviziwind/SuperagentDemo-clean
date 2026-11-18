"""Privately copy a supplied Windows release file and record its fingerprint without launching it."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import tempfile

HERE = Path(__file__).resolve().parent


def digest(file):
    with file.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def receive(path, expected=None, private_parent=HERE):
    if not path.is_absolute() or not path.is_file():
        raise ValueError("Expected an absolute path to the published package file")
    source = path.resolve(strict=True)
    fingerprint = digest(source)
    if expected is not None and fingerprint != expected.lower():
        raise ValueError(f"Published SHA-256 mismatch: observed {fingerprint}")
    run = Path(tempfile.mkdtemp(prefix="phase1-input-final-", dir=private_parent))
    (run/"package").mkdir()
    copy = run/"package"/source.name
    shutil.copyfile(source, copy)
    if digest(copy) != fingerprint:
        raise ValueError(f"Package changed during capture; incomplete copy at {copy}")
    receipt = {"source":str(source), "private_copy":str(copy), "sha256":fingerprint,
               "size":copy.stat().st_size, "compared_with_supplied_sha256":expected is not None}
    (run/"receipt.json").write_text(json.dumps(receipt, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
    return run


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("package", type=Path)
    parser.add_argument("--sha256", help="Expected digest of this EXE or ZIP, when supplied by the coordinator")
    args = parser.parse_args()
    print(receive(args.package, args.sha256)/"receipt.json")
