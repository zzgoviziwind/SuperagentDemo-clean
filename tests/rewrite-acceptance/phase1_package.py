"""Run independent Phase 1 rounds with the Node, server dependencies and UI from one Windows ZIP."""
import argparse
from contextlib import closing
import gzip
import json
from pathlib import Path, PurePosixPath
import shutil
import sqlite3
import sys
import tempfile
import zipfile

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import phase1
sys.path.insert(0, str(HERE.parent/"rewrite-runtime-review/host-safety/rc-replay"))
import candidate


def extract_web(package, root, manifest_sha):
    prefix = "apps/web/dist/"
    files = {}
    with zipfile.ZipFile(package) as archive:
        manifest = archive.read("release.json")
        assert candidate.sha(manifest) == manifest_sha
        for row in json.loads(manifest.decode("utf-8-sig"))["files"]:
            if not row["path"].startswith(prefix):
                continue
            name = row["path"][len(prefix):]
            path = PurePosixPath(name)
            if path.is_absolute() or ".." in path.parts or ":" in name or "\\" in name or name in files:
                raise ValueError(f"Invalid packaged web path: {name}")
            target = root/path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(archive.read("payload/"+row["path"]))
            files[name] = row["sha256"].lower()
    assert "index.html" in files and candidate.tree(root) == files
    return files


def preserve(work, dest):
    for name in ("http.json","result.json","browser.json","01-unknown.png","02-after-reload.png","ui-failure.png","ui-failure.txt"):
        if (work/name).is_file():
            shutil.copyfile(work/name,dest/name)
    db = work/"superagent.db"
    if db.exists():
        backup = work/"audit-snapshot.sqlite"
        with closing(sqlite3.connect(db.as_uri()+"?mode=ro",uri=True)) as source, closing(sqlite3.connect(backup)) as snapshot:
            source.backup(snapshot)
        with backup.open("rb") as source, gzip.open(dest/"synthetic.sqlite.gz","wb") as output:
            shutil.copyfileobj(source,output)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package", type=Path, required=True)
    parser.add_argument("--expect-zip", required=True)
    parser.add_argument("--rounds", type=int, default=2)
    parser.add_argument("--web-deps", type=Path, default=phase1.ROOT/"apps/web/node_modules")
    parser.add_argument("--browser-exe", type=Path)
    parser.add_argument("--manual-draft", action="store_true")
    args = parser.parse_args()
    if args.rounds < 1:
        parser.error("--rounds must be positive")
    evidence = Path(tempfile.mkdtemp(prefix="phase1-package-", dir=HERE/"evidence"))
    print("Evidence:", evidence, flush=True)
    with tempfile.TemporaryDirectory(prefix="phase1-input-package-",dir=HERE) as tmp:
        root = Path(tmp)
        args.dist,args.node,info = candidate.materialize(args.package,root,None,args.expect_zip)
        web = root/"web"
        info["web_files"] = extract_web(args.package,web,info["manifest_sha256"])
        phase1.stage0.save(evidence/"package.json",info)
        args.expect_dist_sha256 = info["dist_sha256"]
        args.diagnose_missing_peer = False
        for number in range(1,args.rounds+1):
            dest = evidence/f"round-{number}"
            dest.mkdir()
            with tempfile.TemporaryDirectory(prefix="phase1-run-",dir=args.dist.parent) as scratch:
                work = Path(scratch)
                try:
                    phase1.run(args,work,web)
                    assert candidate.tree(work/"web") == info["web_files"]
                finally:
                    preserve(work,dest)


if __name__ == "__main__":
    main()
