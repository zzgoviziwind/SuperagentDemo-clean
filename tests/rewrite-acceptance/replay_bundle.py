"""Pin the entire dist before launching it and publish each phase once per run."""
from contextlib import contextmanager
from dataclasses import dataclass
import json
from pathlib import Path
import re
import shutil
import tempfile

import stage0

HERE = stage0.HERE
ARCHIVE = HERE/"evidence/candidates"


def read(path):
    return json.loads(path.read_text("utf-8"))


def file_hashes(directory):
    return {path.relative_to(directory).as_posix(): stage0.sha(path.read_bytes())
            for path in directory.rglob("*") if path.is_file()}


def expected_hash(actual, expected, label):
    if not isinstance(expected, str) or not re.fullmatch("[a-fA-F0-9]{64}", expected) or actual != expected.lower():
        raise ValueError(f"{label} SHA-256 mismatch: expected {expected}, observed {actual}")


@dataclass
class Bundle:
    work: Path
    directory: Path
    files: dict
    digest: str

    def pin(self):
        return {"private_dist":self.directory.relative_to(HERE).as_posix(), "files":self.files, "dist_sha256":self.digest}

    def archive(self, root=ARCHIVE):
        return root/self.files["main.js"]/self.work.name


def capture(work, source, entry_sha, dist_sha=None):
    source = source.resolve(strict=True)
    if work.resolve().is_relative_to(source):
        raise ValueError("The dist directory must not contain the run workspace")
    files = file_hashes(source)
    expected_hash(files.get("main.js"), entry_sha, "main.js")
    digest = stage0.sha(stage0.canonical(files))
    if dist_sha is not None:
        expected_hash(digest, dist_sha, "dist")
    target = work/"dist"
    shutil.copytree(source, target)
    if file_hashes(target) != files:
        raise ValueError("dist changed during capture")
    result = Bundle(work, target, files, digest)
    stage0.save(work/"candidate.json", result.pin())
    return result


def restore(work):
    candidate = work/"candidate.json"
    if candidate.is_file():
        pin = read(candidate)
        target = work/"dist"
    else:
        # Only the published legacy fingerprint may reference the historic private snapshot.
        pin = read(work/"run.json")["pin"]
        if pin != read(HERE/"evidence/replay-dist.json"):
            raise ValueError("Missing private candidate manifest")
        target = HERE/pin["private_dist"]
    files = file_hashes(target)
    digest = stage0.sha(stage0.canonical(files))
    if files != pin["files"] or digest != pin["dist_sha256"]:
        raise ValueError("The private snapshot does not match its manifest")
    return Bundle(work, target, files, digest)


def load_run(path):
    work = path.resolve(strict=True)
    if work.parent != HERE or not work.name.startswith("phase1-run-119-"):
        raise ValueError("Expected a local 119 run workspace")
    bundle = restore(work)
    meta = read(work/"run.json")
    if meta["pin"] != bundle.pin() or meta["source"] != stage0.verify_source():
        raise ValueError("Run provenance mismatch")
    expected_hash(stage0.sha((work/"seed/superagent.db").read_bytes()), meta["seed_sha256"], "seed")
    return bundle


@contextmanager
def publish(bundle, phase, archive=ARCHIVE):
    if phase not in {"serial", "load", "recovery", "postcheck"}:
        raise ValueError("Unknown phase")
    folder = bundle.archive(archive)
    folder.mkdir(parents=True, exist_ok=True)
    target = folder/phase
    # Locks belong to the private run workspace; the OS releases them on process exit.
    import msvcrt
    with (bundle.work/(phase+".lock")).open("a+b") as handle:
        handle.seek(0)
        try:
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        except PermissionError as error:
            raise FileExistsError(f"Phase in progress: {target}") from error
        if target.exists():
            raise FileExistsError(f"Evidence already published: {target}")
        stage = Path(tempfile.mkdtemp(prefix=phase+"-output-", dir=bundle.work))
        yield stage
        stage.rename(target)
