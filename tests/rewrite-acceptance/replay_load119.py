"""Four simultaneous clients per method/path, with one fresh database for each write route."""
import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
from contextlib import closing

HERE = Path(__file__).resolve().parent
sys.path.insert(0,str(HERE))
import replay119 as base
import replay_bundle
from replay_cases import write_cases, read_case
import stage0

# These operations explicitly bind repeats to a stable source/request key.
KEYED = {
    "POST /events":("events","external_id","new-message"),
    "POST /event-groups/{ident}/delegations":("events","external_id","10:delegate-1"),
    "POST /conversation-providers/bridge/operations":("conversation_bridge_operations","request_key","fresh-operation"),
    "POST /field-intake/analysis/{ident}/implement":("events","external_id","implementation:14:1"),
    "POST /sessions/{ident}/coordination":("events","event_type","coordination_request"),
}


def exercise(port,work,key,case):
    method=key.split()[0]
    path=case.path
    if path=="/project-workspace":
        path+="?path="+str(work/"含空格 项目")
    before=base.table_image(work)
    files=base.managed_files(work)
    barrier=threading.Barrier(4,timeout=10)
    def client(_):
        barrier.wait()
        try:
            res=base.request_http(port,method,path,case.body,"admin",work)
        except (OSError,TimeoutError) as e:
            return {"status":0,"error":type(e).__name__}
        body=res["body"]
        values={k:body[k] for k in ("id","task_id","event_id","duplicate","status","write_status","detail","message")
                if isinstance(body,dict) and k in body and not isinstance(body[k],(list,dict))}
        return {**res,"body_sha256":stage0.sha(stage0.canonical(body)),"selected":values}
    started=time.perf_counter()
    with ThreadPoolExecutor(max_workers=4) as clients:
        replies=list(clients.map(client,range(4)))
    elapsed=round((time.perf_counter()-started)*1000,2)
    changes=base.delta(before,base.table_image(work))
    keyed=None
    if key in KEYED:
        table,column,value=KEYED[key]
        with closing(sqlite3.connect((work/"superagent.db").as_uri()+"?mode=ro",uri=True)) as db:
            if key.endswith("/coordination"):
                count=db.execute("SELECT COUNT(*) FROM events WHERE event_type=? AND json_extract(data,'$.request_key')=?",
                                 (value,"request-b")).fetchone()[0]
            else:
                count=db.execute(f"SELECT COUNT(*) FROM {table} WHERE {column}=?",(value,)).fetchone()[0]
        keyed={"table":table,"key":value,"row_count":count,"expected_on_success":1,
               "observed_success":any(200<=r["status"]<300 for r in replies)}
    return {"replies":replies,"elapsed_ms":elapsed,"db":changes,"files":base.file_changes(files,base.managed_files(work)),
            "keyed":keyed,"receipt_files":len(list((work/"fake-channel-receipts").glob("*.json")))}


def conflict(port,work,node):
    # Start a second ordinary controller against this isolated root while the first lease is live.
    env=base.environment(work)|{"SUPERAGENT_DATA_DIR":str(work),"SUPERAGENT_PORT":"0","SUPERAGENT_DRIVER":"fixture"}
    with closing(sqlite3.connect((work/"superagent.db").as_uri()+"?mode=ro",uri=True)) as db:
        owner=db.execute("SELECT owner,epoch FROM controller_leases").fetchone()
    proc=subprocess.Popen([node,str(work/"host-dist/main.js")],cwd=work,env=env,stdout=subprocess.PIPE,
                          stderr=subprocess.STDOUT,creationflags=getattr(subprocess,"CREATE_NO_WINDOW",0))
    try:
        log=proc.communicate(timeout=5)[0].decode("utf-8",errors="replace")
        refused=proc.returncode!=0
    except subprocess.TimeoutExpired:
        proc.kill()
        log=proc.communicate(timeout=5)[0].decode("utf-8",errors="replace")
        refused=False
    with closing(sqlite3.connect((work/"superagent.db").as_uri()+"?mode=ro",uri=True)) as db:
        after=db.execute("SELECT owner,epoch FROM controller_leases").fetchone()
    health=base.request_http(port,"GET","/health",None,"admin",work)["status"]
    return {"refused":refused,"second_exit":proc.returncode,"same_owner_and_epoch":owner==after,
            "epoch":after[1],"first_health":health,"diagnostic":log[-1600:]}


def group(root,seed,node,name,keys,side,bundle):
    dest=root/name
    dest.mkdir(exist_ok=True)
    work=Path(tempfile.mkdtemp(dir=dest,prefix="repeat-"))/side
    base.clone(seed,work)
    cases=write_cases(work,base.read(seed/"seed-ids.json"))
    meta={"entry_sha256":bundle.files["main.js"]} if side=="ts" else {}
    results={}
    with base.service(side,work,node,meta,bundle) as port:
        for key in keys:
            case=read_case(key) if key.startswith("GET ") else cases[key]
            results[key]=exercise(port,work,key,case)
        if name=="reads" and side=="ts":
            meta["other_controller"]=conflict(port,work,node)
        meta["integrity"]=base.sqlite_check(work)
    stage0.save(dest/(side+".json"),{"meta":meta,"cases":results})


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node",type=Path,required=True)
    parser.add_argument("--seed-run",type=Path,required=True)
    args=parser.parse_args()
    bundle = replay_bundle.load_run(args.seed_run)
    with replay_bundle.publish(bundle,"load") as output:
        run_load(args,bundle,output)


def run_load(args,bundle,output):
    seedrun=bundle.work
    seed=seedrun/"seed"
    root=Path(tempfile.mkdtemp(dir=HERE,prefix="phase1-run-119-load-"))
    print("Load run:",root,flush=True)
    routes=[k.replace("/api/v1","",1) for k in base.plans()[0]]
    groups={"reads":[k for k in routes if k.startswith("GET ")]}
    groups.update({f"write-{i:02d}":[k] for i,k in enumerate(sorted(set(routes)-set(groups["reads"])),1)})
    with ThreadPoolExecutor(max_workers=3) as pool:
        all_runs=[pool.submit(group,root,seed,args.node,n,keys,side,bundle) for n,keys in groups.items() for side in ("python","ts")]
        for i,f in enumerate(as_completed(all_runs),1):
            f.result()
            if i%30==0:print(i,"service runs finished",flush=True)
    rows={}
    owners={}
    for keygroup,keys in groups.items():
        pair={side:base.read(root/keygroup/(side+".json")) for side in ("python","ts")}
        assert all(r["meta"]["integrity"]=="ok" for r in pair.values())
        if keygroup=="reads":owners=pair["ts"]["meta"]["other_controller"]
        for k in keys:rows[k]={s:v["cases"][k] for s,v in pair.items()}
    assert len(rows)==119
    metrics={}
    for side in ("python","ts"):
        replies=[r for pair in rows.values() for r in pair[side]["replies"]]
        lat=sorted(r["milliseconds"] for r in replies if "milliseconds" in r)
        assert len(replies)==476
        metrics[side]={"responses":len(replies),"statuses":dict(Counter(r["status"] for r in replies)),
                       "p50_ms":lat[(len(lat)-1)//2],"p95_ms":lat[(len(lat)*95+99)//100-1],"max_ms":lat[-1],
                       "receipts":sum(pair[side]["receipt_files"] for pair in rows.values())}
    stage0.save(output/"load119.json",{"dist_sha256":bundle.digest,"seed_sha256":base.read(seedrun/"run.json")["seed_sha256"],
                "clients_per_route":4,"metrics":metrics,"live_controller_check":owners,"routes":rows})
    print(metrics,"lease",owners["refused"],flush=True)


if __name__=="__main__":
    main()
