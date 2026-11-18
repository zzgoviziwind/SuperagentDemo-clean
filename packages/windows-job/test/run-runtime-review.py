"""Run the unchanged independent suite in a disposable installed-package layout."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

PACKAGE = Path(__file__).resolve().parents[1]
ROOT = PACKAGE.parents[1]


def stage_file(source, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, target)
    if target.read_bytes() != source.read_bytes():
        raise ValueError(f"copy changed during staging: {source.name}")


with tempfile.TemporaryDirectory(prefix="job-review-", dir=PACKAGE) as scratch:
    stage = Path(scratch)
    installed = stage / "node_modules/@superagent/windows-job"
    for name in ["package.json", *json.loads((PACKAGE / "package.json").read_text("utf-8"))["files"]]:
        stage_file(PACKAGE / name, installed / name)
    runtime = ROOT / "packages/runtime"
    shutil.copytree(runtime, stage / "packages/runtime", ignore=shutil.ignore_patterns("node_modules"))
    review = ROOT / "tests/rewrite-runtime-review"
    for source in review.iterdir():
        if source.is_file() and source.suffix in (".py", ".mjs"):
            stage_file(source, stage / "tests/rewrite-runtime-review" / source.name)
    helper_hash = hashlib.sha256((installed / "bin/windows-job-x64.exe").read_bytes()).hexdigest()
    print(f"Installed Windows Job SHA-256: {helper_hash}", flush=True)
    result = subprocess.run([sys.executable, "-I", "-B", "tests/rewrite-runtime-review/candidate_checks.py",
                             *sys.argv[1:]], cwd=stage, timeout=180)
    sys.exit(result.returncode)
