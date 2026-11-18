"""Offline paired HTTP replay. Every write case starts real services on independent copies of one seed."""
import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import closing, contextmanager
import hashlib
import hmac
import http.client
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
from urllib.parse import quote
from uuid import uuid4

HERE = Path(__file__).resolve().parent
sys.path.insert(0,str(HERE))
import phase1
import replay_bundle
import stage0
from replay_cases import FID, read_case, write_cases
from route_matrix import plans

PY_FIXTURE = HERE/"replay_fixture.py"


def environment(work):
    env = phase1.env_for(work)
    env.update(SUPERAGENT_DATABASE_URL="sqlite:///"+(work/"superagent.db").as_posix(),
               SUPERAGENT_USERS_JSON=json.dumps(phase1.USERS),SUPERAGENT_SERVICE_MODE="preview",
               SUPERAGENT_ATTACHMENTS_ROOT=str(work/"attachments"),SUPERAGENT_STATE_ROOT=str(work/"state"),
               SUPERAGENT_WORKSPACES_ROOT=str(work/"workspaces"),SUPERAGENT_ALLOWED_REPO_ROOTS=str(work),
               SUPERAGENT_FEISHU_ENABLED="0",SUPERAGENT_REPLAY_PROJECT=str(work/"含空格 项目"),
               SUPERAGENT_EXECUTION_NODES=json.dumps([{"id":"sample-node","roots":[str(work)],"project_ids":[2],"token_env":"REPLAY_NODE_KEY"}]),
               REPLAY_NODE_KEY="synthetic-local-node-key")
    return env


def prepare(root):
    seed = root/"seed"
    seed.mkdir()
    old = root/"legacy-source"
    old.mkdir()
    stage0.legacy_source(old)
    stage0.worker("legacy",old,seed)
    shutil.copyfile(seed/"legacy.db",seed/"superagent.db")
    subprocess.run([sys.executable,"-IB","-X","utf8",str(PY_FIXTURE),"seed"],cwd=seed,env=environment(seed),check=True)
    return seed


def clone(seed,work):
    work.mkdir(parents=True)
    for name in ("attachments","含空格 项目"):
        shutil.copytree(seed/name,work/name)
    shutil.copyfile(seed/"superagent.db",work/"superagent.db")
    config = (seed/".codex-global-state.json").read_text("utf-8")
    old, new = str(seed),str(work)
    a,b = [json.dumps(v,ensure_ascii=False)[1:-1] for v in (old,new)]
    (work/".codex-global-state.json").write_text(config.replace(a,b),"utf-8")
    with closing(sqlite3.connect(work/"superagent.db")) as db:
        for table,column in [("projects","repo_path"),("artifacts","content"),("field_records","screenshots")]:
            db.execute(f"UPDATE {table} SET {column}=replace(replace({column},?,?),?,?)",(a,b,old,new))
        db.commit()


@contextmanager
def service(side,work,node,meta,bundle):
    if side == "ts":
        shutil.copytree(bundle.directory,work/"host-dist")
        if replay_bundle.file_hashes(work/"host-dist") != bundle.files:
            raise ValueError("Service copy differs from pinned dist")
        (work/"web").mkdir()
        env = environment(work)
        env["NODE_OPTIONS"] = '--require "'+(HERE/"replay_picker.cjs").as_posix()+'"'
        with phase1.host(node,work,meta,False,env) as (port,proc):
            yield port
    else:
        with phase1.process([sys.executable,"-IB","-X","utf8",str(PY_FIXTURE),"serve"],work,environment(work),"uvicorn") as (proc,log):
            def ready():
                if proc.poll() is not None:
                    raise RuntimeError(log.read_text("utf-8",errors="replace")[-1400:])
                try:
                    port = int((work/"port").read_text("ascii"))
                    if phase1.net(port,"/health")[1]["status"] == "ok":
                        return port
                except (OSError,ValueError):
                    return None
            port = phase1.wait_for(ready,55)
            meta.update(pid=proc.pid,port=port)
            try:
                yield port
            finally:
                (work/"stop").touch()
                meta["exit"] = proc.wait(18)


def table_image(work):
    state = {}
    with closing(sqlite3.connect((work/"superagent.db").as_uri()+"?mode=ro",uri=True,timeout=8)) as db:
        db.row_factory = sqlite3.Row
        db.execute("BEGIN")
        for item in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"):
            name = item[0]
            if name.startswith("sqlite_") or name == "controller_leases":
                continue
            assert re.fullmatch(r"[a-zA-Z_0-9]+",name)
            state[name] = {row[0]:dict(row) for row in db.execute(f"SELECT rowid AS _rowid_,* FROM {name}")}
    return state


def delta(before,after):
    result = {}
    for table in sorted(before.keys() | after.keys()):
        old,new = before.get(table,{}),after.get(table,{})
        changes = []
        for rid in sorted(old.keys() | new.keys()):
            a,b = old.get(rid),new.get(rid)
            if a != b:
                fields = {k for k in (a or b) if k!="_rowid_" and (a or {}).get(k)!=(b or {}).get(k)}
                changes.append({"rowid":rid,"type":"insert" if a is None else "delete" if b is None else "update",
                                "before":{k:a[k] for k in sorted(fields)} if a else None,
                                "after":{k:b[k] for k in sorted(fields)} if b else None})
        if changes:
            result[table] = changes
    return result


def request_http(port, method, path, body, user, work, bad_origin=False):
    path = path if path=="/health" else "/api/v1"+path
    endpoint = quote(path,safe="/?:=&%")
    headers = {"Origin":f"http://127.0.0.1:{port}"}
    if bad_origin:
        headers["Origin"]="http://invalid.example"
    if user:
        headers["Authorization"]="Bearer fixture-"+user
    payload = None
    if body=="multipart-wav":
        sep = "replay-boundary-19"
        audio = (work/"attachments/field-media"/FID/"source.wav").read_bytes()
        payload = (f'--{sep}\r\nContent-Disposition: form-data; name="details"\r\n\r\n{{"project_id":1,"title":"audio"}}\r\n'
                   f'--{sep}\r\nContent-Disposition: form-data; name="media"; filename="sample.wav"\r\nContent-Type: audio/wav\r\n\r\n').encode()+audio+f"\r\n--{sep}--\r\n".encode()
        headers["Content-Type"]="multipart/form-data; boundary="+sep
    elif body is not None:
        payload = stage0.canonical(body)
        headers["Content-Type"]="application/json"
    if "/daemon/" in path and user:
        stamp,nonce = str(int(time.time())), uuid4().hex
        signed = b"\n".join([stamp.encode(),nonce.encode(),path.encode(),payload or b""])
        headers.update({"X-Node-Id":"sample-node","X-Node-Time":stamp,"X-Node-Nonce":nonce,
                        "X-Node-Signature":hmac.new(b"synthetic-local-node-key",signed,hashlib.sha256).hexdigest()})
    start = time.perf_counter()
    with closing(http.client.HTTPConnection("127.0.0.1",port,timeout=12)) as conn:
        conn.request(method,endpoint,payload,headers)
        response = conn.getresponse()
        typ = response.getheader("content-type","").split(";")[0]
        out_headers = {k:response.getheader(k) for k in ("allow","cache-control","content-disposition","x-content-type-options") if response.getheader(k)}
        if response.getheader("set-cookie"):
            cookie = response.getheader("set-cookie")
            out_headers["set-cookie"] = cookie.split("=",1)[0]+"=<synthetic>;"+cookie.partition(";")[2]
        if typ=="text/event-stream":
            value = response.readline(65536).decode()+response.readline(65536).decode()
        else:
            raw = response.read(4_000_001)
            assert len(raw)<=4_000_000
            if raw and "json" in typ:
                value = json.loads(raw)
            elif typ.startswith(("image/","audio/","video/")):
                value = {"byte_length":len(raw),"sha256":stage0.sha(raw)}
            else:
                value = raw.decode("utf-8",errors="replace")
        return {"status":response.status,"mime":typ,"headers":out_headers,"body":value,
                "milliseconds":round((time.perf_counter()-start)*1000,2)}


def observe(port,work,method,case,label):
    path,body,user = case.path,case.body,"admin"
    if label=="negative":
        path = case.negative_path or path
        body = None if case.negative_path or case.permission_negative else case.negative
        user = None if case.permission_negative else "admin"
    if label=="anonymous":
        user=None
    bad_origin = body=="bad-origin"
    if bad_origin:
        body={}
    if path=="/project-workspace":
        path += "?path="+str(work/"含空格 项目")
    files_before = managed_files(work)
    before = table_image(work)
    res = request_http(port,method,path,body,user,work,bad_origin)
    effects = delta(before,table_image(work))
    return {"label":label,"path":path,"user":user or "anonymous","input":{"token":"<synthetic>"} if path=="/auth/login" else body,
            "response":res,"db":effects,"files":file_changes(files_before,managed_files(work)),
            "receipts":len(list((work/"fake-channel-receipts").glob("*.json")))}


def managed_files(work):
    return {f.relative_to(work).as_posix():stage0.sha(f.read_bytes())
            for sub in ("attachments","fake-channel-receipts","worker-workspaces") for f in (work/sub).rglob("*") if f.is_file()}


def file_changes(before,after):
    return {p:{"before":before.get(p),"after":after.get(p)} for p in sorted(before.keys()|after.keys()) if before.get(p)!=after.get(p)}


def run_group(root,seed,node,name,keys,side,bundle):
    (root/name).mkdir(parents=True,exist_ok=True)
    attempt = Path(tempfile.mkdtemp(prefix="attempt-",dir=root/name))
    work = attempt/side
    clone(seed,work)
    writes = write_cases(work,read(seed/"seed-ids.json"))
    meta = {"entry_sha256":bundle.files["main.js"]} if side=="ts" else {}
    results = {}
    with service(side,work,node,meta,bundle) as port:
        for key in keys:
            method = key.split()[0]
            case = read_case(key) if method=="GET" else writes[key]
            labels = ("anonymous","positive") if method=="GET" else ("negative","positive")
            obs = [observe(port,work,method,case,label) for label in labels]
            results[key] = {"boundary":case.boundary,"required_tables":case.effects,"observations":obs}
        meta["integrity"] = sqlite_check(work)
    stage0.save(root/name/(side+".json"),{"meta":meta,"work":str(work),"cases":results})


def sqlite_check(work):
    with closing(sqlite3.connect((work/"superagent.db").as_uri()+"?mode=ro",uri=True)) as db:
        return db.execute("PRAGMA integrity_check").fetchone()[0]


def burst(root,seed,node,side,bundle):
    """A fixed six-client burst on this process only, with a unique synthetic event key."""
    parent = Path(tempfile.mkdtemp(dir=root,prefix="burst-"))
    work = parent/side
    clone(seed,work)
    meta = {"entry_sha256":bundle.files["main.js"]} if side=="ts" else {}
    body = dict(write_cases(work,read(seed/"seed-ids.json"))["POST /events"].body,external_id="burst-local-001")
    with service(side,work,node,meta,bundle) as port:
        before = table_image(work)
        def one(i):
            if i%3==0:
                return "POST /events",request_http(port,"POST","/events",body,"admin",work)
            path = "/tasks" if i%3==1 else "/overview"
            return "GET "+path,request_http(port,"GET",path,None,"admin",work)
        with ThreadPoolExecutor(max_workers=6) as clients:
            calls = list(clients.map(one,range(36)))
        latencies = sorted(r["milliseconds"] for _,r in calls)
        writes = [r["body"] for route,r in calls if route=="POST /events" and r["status"]==200]
        with closing(sqlite3.connect((work/"superagent.db").as_uri()+"?mode=ro",uri=True)) as db:
            originals = db.execute("SELECT id,task_id FROM events WHERE external_id=?",("burst-local-001",)).fetchall()
        changes = delta(before,table_image(work))
        result = {"clients":6,"calls":36,"read_calls":24,"duplicate_write_calls":12,
                  "write_input":body,"observations":[{"route":route,"response":r} for route,r in calls],
                  "statuses":dict(Counter(r["status"] for _,r in calls)),"p50_ms":latencies[17],"p95_ms":latencies[34],
                  "max_ms":latencies[-1],"originals":originals,"duplicates":sum(r.get("duplicate") is True for r in writes),
                  "ids":[[r.get("id"),r.get("task_id")] for r in writes],
                  "changed_tables":{t:len(rows) for t,rows in changes.items()},"integrity":sqlite_check(work),
                  "external_receipts":len(list((work/"fake-channel-receipts").glob("*.json")))}
        result["passed"] = (result["statuses"]=={200:36} and len(originals)==1 and originals[0][1] is not None
                            and {tuple(pair) for pair in result["ids"]}==set(originals) and result["duplicates"]==11
                            and len(changes.get("tasks",[]))==1 and result["integrity"]=="ok" and not result["external_receipts"])
    stage0.save(root/("burst-"+side+".json"),result)


def read(file):
    return json.loads(file.read_text("utf-8"))


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--node",type=Path,required=True)
    p.add_argument("--jobs",type=int,default=4,choices=range(1,9))
    p.add_argument("--resume",type=Path)
    p.add_argument("--dist",type=Path,help="Directory containing the candidate main.js and all its companion files.")
    p.add_argument("--entry-sha256",help="Expected 64-hex SHA-256 of main.js.")
    p.add_argument("--dist-sha256",help="Optional expected SHA-256 of the canonical relative-path/hash map.")
    p.add_argument("--prepare-only",action="store_true",help="Copy and verify dist and seed, then stop before HTTP.")
    p.add_argument("--fail-on-diff",action="store_true",help="Exit nonzero for unresolved contract differences.")
    args=p.parse_args()
    source = stage0.verify_source()
    if args.resume:
        if args.dist:
            p.error("--resume uses the saved private dist copy")
        bundle = replay_bundle.load_run(args.resume)
        if args.entry_sha256:
            replay_bundle.expected_hash(bundle.files["main.js"],args.entry_sha256,"main.js")
        if args.dist_sha256:
            replay_bundle.expected_hash(bundle.digest,args.dist_sha256,"dist")
    else:
        if bool(args.dist) != bool(args.entry_sha256) or (args.dist_sha256 and not args.dist):
            p.error("Provide --dist and --entry-sha256 together; --dist-sha256 additionally checks the set")
        if args.dist:
            dist, entry, digest = args.dist, args.entry_sha256, args.dist_sha256
        else:
            legacy = read(HERE/"evidence/replay-dist.json")
            dist, entry, digest = HERE/legacy["private_dist"], legacy["files"]["main.js"], legacy["dist_sha256"]
            if not dist.is_dir():
                dist = stage0.ROOT/"apps/server/dist"
        root=Path(tempfile.mkdtemp(dir=HERE,prefix="phase1-run-119-"))
        print("Run:",root,flush=True)
        bundle = replay_bundle.capture(root,dist,entry,digest)
        seed=prepare(root)
        stage0.save(root/"run.json",{"source":source,"pin":bundle.pin(),"node":subprocess.check_output([args.node,"--version"],text=True).strip(),
                    "seed_sha256":stage0.sha((seed/"superagent.db").read_bytes()),"python":sys.version})
    print("Evidence:",bundle.archive(),flush=True)
    if args.prepare_only:
        return
    with replay_bundle.publish(bundle,"serial") as output:
        counts = run_serial(args,bundle,output)
    accepted = {"业务抽查通过","业务抽查通过，响应头有差异","协议拒绝通过","前置条件拒绝","按约定由 Python 承载"}
    if args.fail_on_diff and any(label not in accepted for label in counts):
        raise SystemExit("存在待裁决差异，见 " + str(bundle.archive()/"serial/REPORT.md"))


def run_serial(args,bundle,output):
    root = bundle.work
    seed = root/"seed"
    routes = list(plans()[0])
    assert set(routes)==set(read(HERE/"stage0-evidence.json")["sample"]["oracle"]["routes"]) and len(routes)==119
    routes = [key.replace("/api/v1","",1) for key in routes]
    writes = sorted(key for key in routes if not key.startswith("GET "))
    assert set(writes)==set(write_cases(seed,read(seed/"seed-ids.json")))
    groups = {"reads":[key for key in routes if key.startswith("GET ")]}
    groups.update({f"write-{i:02d}":[key] for i,key in enumerate(writes,1)})
    futures = {}
    with ThreadPoolExecutor(max_workers=args.jobs) as pool:
        for group,keys in groups.items():
            for side in ("python","ts"):
                if not (root/group/(side+".json")).exists():
                    futures[pool.submit(run_group,root,seed,args.node,group,keys,side,bundle)] = (group,side)
        failures=[]
        for i,f in enumerate(as_completed(futures),1):
            try: f.result()
            except Exception as e:
                failures.append([*futures[f],repr(e)])
                print("FAILED",failures[-1],flush=True)
            if i%20==0: print(f"{i}/{len(futures)} service runs",flush=True)
    if futures:
        stage0.save(root/"failures.json",failures)
    if failures: raise SystemExit(f"{len(failures)} service runs incomplete in {root}")
    for side in ("python","ts"):
        if not (root/("burst-"+side+".json")).exists():
            burst(root,seed,args.node,side,bundle)
    from replay_compare import report
    return report(root,groups,output)


if __name__=="__main__":
    main()
