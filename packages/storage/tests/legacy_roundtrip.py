"""Compare native migration with Python on two copies of the same nonempty baseline DB."""
import argparse
from contextlib import closing
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

PACKAGE = Path(__file__).resolve().parents[1]
ROOT = PACKAGE.parents[1]
BASE = "7b7587d14399659d7951d3e195af863514fbf118"


def tables(connection):
    return [name for (name,) in connection.execute("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")]


def run(root, node):
    old = root / "old"
    archive = subprocess.check_output(["git","archive","--format=zip",BASE,"superagent"],cwd=ROOT)
    with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
        bundle.extractall(old)
    source, native, oracle = [root / (name + ".db") for name in ("原库", "候选", "参照")]
    proc = [sys.executable, "-IB", str(Path(__file__).resolve())]
    subprocess.run([*proc, "--initialize", str(old), str(source), "seed"], check=True, cwd=root)
    for path in (native,oracle):
        shutil.copyfile(source,path)
    subprocess.run([*proc, "--initialize",str(ROOT / ".rewrite-oracle"),str(oracle),"upgrade"],check=True,cwd=root)
    script = "import {openStorage} from " + json.dumps((PACKAGE / "index.ts").as_uri()) + ";for(let i=0;i<2;i++)openStorage(process.argv[1]).close();"
    subprocess.run([node,"--input-type=module","-e",script,str(native)],check=True,cwd=root)
    with closing(sqlite3.connect(source)) as before, closing(sqlite3.connect(native)) as after, closing(sqlite3.connect(oracle)) as ref:
        for table in tables(before):
            cols = ",".join('"' + r[1] + '"' for r in before.execute(f"PRAGMA table_info({table})"))
            query = f"SELECT {cols} FROM {table} ORDER BY rowid"
            assert after.execute(query).fetchall() == before.execute(query).fetchall(), table
        ddl = "SELECT name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY name"
        assert after.execute(ddl).fetchall() == ref.execute(ddl).fetchall()
        assert after.execute("PRAGMA integrity_check").fetchone() == ("ok",)
        assert after.execute("SELECT attempt_id FROM artifacts").fetchone() == (None,)
        assert after.execute("SELECT claim_token FROM delivery_records").fetchone() == (None,)
        print(f"PASS {len(tables(before))} baseline tables, {len(tables(after))} migrated tables, all prior rows and complete SQLite DDL matched")


def initialize(source, database, mode):
    import importlib
    sys.dont_write_bytecode = True
    sys.path.insert(0,source)
    os.environ["SUPERAGENT_DATABASE_URL"] = "sqlite:///" + Path(database).as_posix()
    for path in sorted((Path(source) / "superagent").rglob("*.py")):
        if b"__tablename__ =" in path.read_bytes():
            importlib.import_module(".".join(path.relative_to(source).with_suffix("").parts))
    from superagent.core import db, delivery
    db.init_db()
    if mode == "seed":
        with db.Session.begin() as session:
            project = db.Project(name="测试项目",repo_path="离线 中文目录")
            session.add(project)
            session.flush()
            task = db.Task(project_id=project.id,title="旧任务",goal="旧目标",state_version=13)
            session.add(task)
            session.flush()
            e = db.Event(task_id=task.id,source="redmine",external_id="R1",event_type="issue.comment",content="旧来信")
            a = db.Approval(task_id=task.id,revision=1,control_version=1,action_hash="h",action={},status="approved")
            session.add_all([e,a,db.Artifact(task_id=task.id,revision=1,kind="report",content="历史证据")])
            session.flush()
            session.add(delivery.ReplyDraft(task_id=task.id,event_id=e.id,approval_id=a.id,content="旧草稿"))
            session.add(delivery.DeliveryRecord(action_id="reply-"+str(a.id),action_hash="h",result={"write_status":"unknown"}))


if __name__ == "__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("--node",default="node")
    parser.add_argument("--initialize",nargs=3)
    args=parser.parse_args()
    if args.initialize:
        initialize(*args.initialize)
    else:
        with tempfile.TemporaryDirectory(prefix="存储 旧库-") as temp:
            run(Path(temp),args.node)
