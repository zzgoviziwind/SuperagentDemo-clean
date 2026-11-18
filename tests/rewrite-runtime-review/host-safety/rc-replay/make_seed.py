"""Create the shared, synthetic pre-recovery SQLite seed once, without overwriting evidence."""
import argparse
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import zipfile
from contextlib import closing

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
COMMIT = "30bceacbf141cfb143bc0eab9d004761f23201ba"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("node", type=Path)
    parser.add_argument("--out", type=Path, default=HERE / "seed.sqlite.gz")
    args = parser.parse_args()
    target = args.out.resolve()
    if HERE not in target.parents or target.exists():
        parser.error("choose a new seed path under rc-replay")
    with tempfile.TemporaryDirectory(dir=HERE, prefix="s-") as tmp:
        work = Path(tmp)
        archive = subprocess.check_output(["git", "archive", "--format=zip", COMMIT, "packages/storage"], cwd=ROOT)
        with zipfile.ZipFile(io.BytesIO(archive)) as z:
            z.extractall(work)
        env = {k: os.environ[k] for k in ("SystemRoot", "SystemDrive", "WINDIR") if k in os.environ}
        env.update({k: tmp for k in ("TEMP", "TMP", "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA")})
        seed = subprocess.run([args.node.resolve(), HERE / "seed.mjs", work / "packages/storage", work],
                              cwd=work, env=env, capture_output=True, timeout=30)
        if seed.returncode != 73:
            raise RuntimeError(seed.stderr.decode("utf-8", "replace"))
        with closing(sqlite3.connect(work / "superagent.db")) as src, closing(sqlite3.connect(work / "portable.db")) as dst:
            src.backup(dst)
            assert dst.execute("PRAGMA integrity_check").fetchone() == ("ok",)
        raw = (work / "portable.db").read_bytes()
        with target.open("xb") as output:
            output.write(gzip.compress(raw, mtime=0))
        print(json.dumps({"seed_sha256": hashlib.sha256(raw).hexdigest(), "storage_commit": COMMIT}))


if __name__ == "__main__":
    main()
