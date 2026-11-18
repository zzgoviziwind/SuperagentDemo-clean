"""Capture only reviewed source paths from a concurrently maintained worktree."""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import subprocess
import tempfile
import zipfile
from pathlib import Path

BASE = "7b7587d14399659d7951d3e195af863514fbf118"
EXTRA = """
.handoffs/2026-11-18-typescript-rewrite/PLAN.md
.handoffs/2026-11-18-typescript-rewrite/REVIEW-PROMPT.md
.handoffs/2026-11-18-superagent-release1/HANDOFF.md
docs/handoffs/T1-RELEASE1.md
docs/handoffs/T1-RELEASE1-WP1.md
docs/handoffs/T1-RELEASE1-WP2.md
apps/web/public/field-timeline.example.json
apps/web/src/FieldIntake.tsx
apps/web/src/FieldTranscript.tsx
apps/web/src/field-intake.css
apps/web/tests/visual/field-intake.pw.ts
requirements-field-media.txt
requirements-field-ocr.txt
superagent/api/context.py
superagent/api/field_intake.py
superagent/api/field_media.py
superagent/core/context.py
superagent/core/execution.py
superagent/core/field_intake.py
superagent/core/field_media.py
superagent/core/field_media_worker.py
superagent/core/field_ocr.py
superagent/core/field_organizer.py
superagent/core/field_timeline.py
tests/fixtures/field_media_live.py
tests/fixtures/field_media_sample.py
tests/fixtures/field_ocr_benchmark.py
tests/fixtures/field_organizer_live.py
tests/integration/test_context_ownership.py
tests/integration/test_delivery_isolation.py
tests/integration/test_execution_ownership.py
tests/integration/test_field_intake.py
tests/integration/test_field_media.py
docs/现场记录-OCR对照与真实归纳验收.md
docs/现场记录-时间轴导入验收.md
docs/现场记录-音视频后台处理与验收.md
docs/现场记录-首期开源复用调研.md
""".split()
ROOT = Path(__file__).resolve().parents[2]
MANIFEST = ROOT / "docs/rewrite/oracle.json"


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def freeze(source: Path):
    archive = subprocess.check_output(["git", "archive", "--format=zip", BASE], cwd=ROOT)
    with zipfile.ZipFile(io.BytesIO(archive)) as ref:
        baseline = {name: ref.read(name) for name in ref.namelist() if not name.endswith("/")}
    names = sorted(set(baseline) | set(EXTRA))
    snapshot = {name: (source / name).read_bytes() for name in names}
    files = {name: digest(data) for name, data in snapshot.items()}
    for name, expected in files.items():
        if digest((source / name).read_bytes()) != expected:
            raise ValueError(f"Source changed during capture: {name}")
    fingerprint = digest(json.dumps(files, sort_keys=True).encode())
    changed = [name for name in baseline if baseline[name].replace(b"\r\n", b"\n")
               != snapshot[name].replace(b"\r\n", b"\n")]
    record = {"commit": BASE, "fingerprint": fingerprint, "changed": sorted(changed),
              "untracked_inputs": EXTRA, "files": files}
    target = ROOT / ".rewrite-oracle"
    if target.exists():
        for name, expected in files.items():
            if digest((target / name).read_bytes()) != expected:
                raise ValueError(f"Existing snapshot differs: {name}")
    else:
        with tempfile.TemporaryDirectory(dir=ROOT) as temp:
            staged = Path(temp) / "oracle"
            for name, data in snapshot.items():
                path = staged / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
            staged.rename(target)
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    formatted = json.dumps(record, ensure_ascii=False, indent=2) + "\n"
    if MANIFEST.exists() and json.loads(MANIFEST.read_text("utf-8")) != record:
        raise ValueError("The source differs from the pinned fingerprint")
    MANIFEST.write_text(formatted, encoding="utf-8")
    print(f"{fingerprint}  {len(files)} files, {len(changed)} modified")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    freeze(parser.parse_args().source.resolve())
