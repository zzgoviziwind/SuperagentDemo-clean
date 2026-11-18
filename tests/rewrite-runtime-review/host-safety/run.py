"""Independent offline runner. Run with the project Python and pass a Node 24 executable."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import zlib
from datetime import datetime, timezone

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
NODE = Path(sys.argv[1]).resolve()


def sample_repository(path, env):
    """Materialize a fixed Git baseline without touching the worktree index or refs."""
    path.mkdir(parents=True)
    def git(*args):
        subprocess.run([shutil.which("git"),*args],cwd=path,env=env,check=True,capture_output=True)
    git("init","-q","--template=","-b","main")
    def obj(kind, data):
        content = kind + b" " + str(len(data)).encode() + b"\0" + data
        key = hashlib.sha1(content).hexdigest()
        target = path/".git/objects"/key[:2]/key[2:]
        target.parent.mkdir(exist_ok=True)
        target.write_bytes(zlib.compress(content))
        return key
    blob = obj(b"blob",b"before\n")
    tree = obj(b"tree",b"100644 fixture-value.txt\0" + bytes.fromhex(blob))
    author = b"Review <test@invalid> 1700000000 +0000"
    commit = obj(b"commit",b"tree "+tree.encode()+b"\nauthor "+author+b"\ncommitter "+author+b"\n\nfixture\n")
    (path/".git/refs/heads/main").write_text(commit+"\n",encoding="ascii")
    (path/"fixture-value.txt").write_bytes(b"before\n")
    git("read-tree","HEAD")


def observe(work):
    from contextlib import closing
    with closing(sqlite3.connect((work / "superagent.db").as_uri() + "?mode=ro", uri=True)) as db:
        assert db.execute("PRAGMA integrity_check").fetchone() == ("ok",)
        result = db.execute("""SELECT t.status,t.outcome_unknown,a.status,p.status,
            json_extract(d.result,'$.write_status') FROM tasks t JOIN execution_attempts a ON a.task_id=t.id
            JOIN approvals p ON p.task_id=t.id CROSS JOIN delivery_records d WHERE json_extract(p.action,'$.method') IS NOT NULL""").fetchall()
    assert len(result) == 1
    return list(result[0])


def run():
    assert __debug__ and NODE.is_file()
    evidence = {"at_utc": datetime.now(timezone.utc).isoformat(), "python": sys.version.split()[0], "checks": {}}
    checks = evidence["checks"]
    with tempfile.TemporaryDirectory(prefix="run-", dir=HERE) as scratch:
        work = Path(scratch)
        env = {k: os.environ[k] for k in ("SystemRoot","SystemDrive","WINDIR","ComSpec","PATHEXT",
               "PROCESSOR_ARCHITECTURE") if k in os.environ}
        env["PATH"] = os.pathsep.join([str(Path(shutil.which("git")).parent),str(NODE.parent),
                                       str(Path(os.environ["SystemRoot"]) / "System32")])
        env.update({k: scratch for k in ("TEMP","TMP","HOME","USERPROFILE","LOCALAPPDATA","APPDATA","CODEX_HOME")})
        env.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL="NUL")

        def invoke(args, target=work, expected=0):
            proc = subprocess.run([*map(str,args),str(target)],cwd=ROOT,env=env,capture_output=True,
                                  encoding="utf-8",errors="replace",timeout=100)
            if proc.returncode != expected:
                raise RuntimeError((proc.stderr or proc.stdout)[-2600:].replace(scratch,"<scratch>"))
            if proc.stdout.strip():
                return json.loads(proc.stdout.strip().splitlines()[-1])

        def ts(mode, target=work, expected=0):
            return invoke([NODE,HERE/"host.mjs",mode], target, expected)

        def python(mode,target,expected=0):
            return invoke([sys.executable,"-IB","-X","utf8",HERE/"oracle.py",mode], target,expected)

        evidence["build"] = ts("build")
        def check(name, fn):
            try:
                result = fn()
                checks[name] = {"pass":True, "observed":result}
            except Exception as error:
                checks[name] = {"pass":False, "error":str(error)}
            print(name, json.dumps(checks[name],ensure_ascii=False),flush=True)

        for mode in ["project","failed-command"]:
            sample_repository(work/mode/"source",env)
        for mode in ["attachments","channel-files","cursor","positive","project","failed-command","report-only"]:
            check(mode,lambda:ts(mode))
        for case in ["ts-python-v2-ts","ts-python-default-ts","ts-python-stock-ts","python-v2-ts"]:
            def cross():
                target = work / case
                target.mkdir()
                shutil.copyfile(work/"host.mjs", target/"host.mjs")
                if case.startswith("ts-"):
                    ts("crash",target,73)
                else:
                    python("crash",target,73)
                receipt = (target/"receipt.txt").read_bytes()
                before = observe(target)
                assert before == ["waiting_approval",0,"waiting_approval","dispatching","dispatching"], before
                details = {"crash_exit":73,"durable_before":before}
                if case.startswith("ts-"):
                    details["python"] = python(case.split("-")[2],target)
                details["ts"] = ts("takeover",target)
                assert (target/"receipt.txt").read_bytes() == receipt
                details["receipt_lines"] = len(receipt.splitlines())
                details["durable_after"] = observe(target)
                return details
            check(case,cross)
    oracle = [".rewrite-oracle/superagent/core/"+n+".py" for n in ("db","delivery","execution")]
    evidence["oracle_inputs"] = {f:hashlib.sha256((ROOT/f).read_bytes()).hexdigest() for f in oracle}
    evidence["oracle_commit"] = json.loads((ROOT/"docs/rewrite/oracle.json").read_text("utf-8-sig"))["commit"]
    for case in ("ts-python-default-ts","ts-python-stock-ts","ts-python-v2-ts"):
        row = checks[case]
        if row["pass"]:
            observed = row["observed"]["python"]
            row["pass"] = (observed["task"], observed["unknown"], observed["attempt"], observed["approval"],
                           observed["ledger"], observed["token_cleared"]) == (
                               "waiting_resource", True, "unknown", "expired_on_restart", "unknown", True)
            print(case, "final acceptance:", row["pass"])
    (HERE/"results.json").write_text(json.dumps(evidence,indent=2,ensure_ascii=False)+"\n",encoding="utf-8")
    return int(any(not row["pass"] for row in checks.values()))


if __name__ == "__main__":
    sys.exit(run())
