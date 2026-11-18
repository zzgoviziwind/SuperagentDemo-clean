"""Replay the pinned legacy schema and frozen Python implementation twice on Windows."""
import argparse
from contextlib import closing
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import zipfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
ORACLE = ROOT / ".rewrite-oracle"
INPUT = json.loads((HERE / "input.json").read_text("utf-8"))


def canonical(obj):
    return json.dumps(obj, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def save(path, obj):
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
                    encoding="utf-8", newline="\n")


def verify_source():
    manifest = json.loads((ROOT / "docs/rewrite/oracle.json").read_text("utf-8-sig"))
    files = manifest["files"]
    assert manifest["commit"] == INPUT["baseline"]
    assert manifest["fingerprint"] == INPUT["oracle_fingerprint"]
    assert sha(canonical(files)) == INPUT["oracle_file_map_sha256"]
    for name, expected in files.items():
        if sha((ORACLE / name).read_bytes()) != expected:
            raise ValueError(f"Frozen file changed: {name}")
    actual = {p.relative_to(ORACLE).as_posix() for p in ORACLE.rglob("*") if p.is_file()}
    if actual != set(files):
        raise ValueError(f"Unexpected snapshot entries: {sorted(actual ^ set(files))}")
    return {"commit": manifest["commit"], "fingerprint": manifest["fingerprint"],
            "files_checked": len(files), "contract_sha256": files["docs/接口契约.md"],
            "input_sha256": sha((HERE / "input.json").read_bytes())}


def legacy_source(target):
    archive = subprocess.check_output(
        ["git", "archive", "--format=zip", INPUT["baseline"], "superagent"], cwd=ROOT)
    with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
        for name in bundle.namelist():
            if name.startswith("superagent/") and name.endswith(".py"):
                bundle.extract(name, target)


def worker(mode, source, work):
    # Only system runtime paths survive. Give application data and account discovery fresh roots.
    env = {k: os.environ[k] for k in ("SYSTEMROOT", "WINDIR", "SYSTEMDRIVE", "PROCESSOR_ARCHITECTURE")
           if k in os.environ}
    env.update({k: str(work) for k in ("TEMP", "TMP", "HOME", "USERPROFILE", "APPDATA",
                                        "LOCALAPPDATA", "CODEX_HOME", "XDG_CONFIG_HOME")})
    subprocess.run([sys.executable, "-IB", "-X", "utf8", str(HERE / "probe.py"), mode, str(source)],
                   cwd=work, env=env, timeout=90, check=True)
    return json.loads((work / (mode + ".json")).read_text("utf-8"))


def run_once(home, legacy):
    home.mkdir()
    initial = worker("legacy", legacy, home)
    shutil.copyfile(home / "legacy.db", home / "migrated.db")
    observed = worker("oracle", ORACLE, home)
    with closing(sqlite3.connect((home / "migrated.db").as_uri() + "?mode=ro", uri=True)) as connection:
        assert connection.execute("PRAGMA integrity_check").fetchall() == [("ok",)]
    return {"legacy": initial, "oracle": observed}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    outputs = parser.add_mutually_exclusive_group()
    outputs.add_argument("--record", action="store_true", help="explicitly refresh golden evidence")
    outputs.add_argument("--keep-sample", action="store_true", help="generate a verified phase 1 input directory")
    options = parser.parse_args()
    if not __debug__ or sys.version_info[:2] != (3, 12):
        parser.error("Use Python 3.12 with assertions enabled")
    source = verify_source()
    with tempfile.TemporaryDirectory(prefix="stage0-", dir=HERE) as tmp:
        root = Path(tmp)
        legacy = root / "baseline"
        legacy_source(legacy)
        rounds = [run_once(root / f"round-{i}", legacy) for i in (1, 2)]
        if rounds[0] != rounds[1]:
            raise ValueError("Independent rounds differ: " + difference(rounds[0], rounds[1]))
        assert verify_source() == source
        evidence = {"source": source, "round_sha256": [sha(canonical(r)) for r in rounds],
                    "sample": rounds[0]}
        destination = HERE / "stage0-evidence.json"
        if options.record:
            save(destination, evidence)
        else:
            expected = json.loads(destination.read_text("utf-8"))
            if evidence != expected:
                raise ValueError("Golden evidence differs: " + difference(expected, evidence))
        if options.keep_sample:
            # Generate in the final directory: the DB contains absolute attachment paths.
            fixture = Path(tempfile.mkdtemp(prefix="phase1-input-", dir=HERE))
            try:
                retained = run_once(fixture / "sample", legacy)
                assert retained == rounds[1], difference(retained, rounds[1])
            except BaseException:
                if fixture.resolve().parent == HERE:
                    shutil.rmtree(fixture)
                raise
            print("Phase 1 input:", fixture / "sample")
    print("PASS 2/2", evidence["round_sha256"][0])


def difference(left, right, path="$"):
    if type(left) is not type(right):
        return f"{path}: {type(left).__name__} != {type(right).__name__}"
    if isinstance(left, (dict, list)):
        a = set(left) if isinstance(left, dict) else set(range(len(left)))
        b = set(right) if isinstance(right, dict) else set(range(len(right)))
        if a != b:
            return f"{path}: different keys {a ^ b}"
        for key in sorted(a):
            if left[key] != right[key]:
                return difference(left[key], right[key], f"{path}/{key}")
    return f"{path}: {left!r} != {right!r}"


if __name__ == "__main__":
    main()
