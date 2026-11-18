"""Pinned dist, real Host crash after receipt, lease expiry, offline CLI, Python API, TS replay."""
import argparse
import hashlib
import http.client
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing, contextmanager
from datetime import datetime, timezone
from urllib.parse import urlsplit

HERE = Path(__file__).resolve().parent
PIN = "b3289b3be6299c3d9157b0b9f62f38901696cad4c708152542f3385788f9a8f3"


def rows(path, sql):
    with closing(sqlite3.connect(path.as_uri()+"?mode=ro",uri=True)) as db:
        return db.execute(sql).fetchall()


def state(db):
    ledger, = rows(db, "SELECT json_extract(result,'$.write_status'),claim_token IS NULL FROM delivery_records")
    attempt, = rows(db, "SELECT status FROM execution_attempts WHERE task_id=1")
    tool, = rows(db, "SELECT status FROM approvals WHERE json_extract(action,'$.method') IS NOT NULL")
    return [*ledger,attempt[0],tool[0]]


def receipts(work):
    files = list((work/"fake-channel-receipts").iterdir())
    assert len(files)==1 and files[0].suffix==".json", files
    return files[0].read_bytes()


def api(port,method,path,body=None):
    conn=http.client.HTTPConnection("127.0.0.1",port,timeout=12)
    try:
        conn.request(method,"/api/v1/"+path,None if body is None else json.dumps(body),
                     headers={"Authorization":"Bearer test-local","Content-Type":"application/json"} if body is not None
                     else {"Authorization":"Bearer test-local"})
        response=conn.getresponse()
        payload=json.loads(response.read())
        assert response.status==200,(path,response.status,payload)
        return payload
    finally:
        conn.close()


@contextmanager
def server(node,entry,work,env,crash):
    log=work/("initial.log" if crash else "restart.log")
    with log.open("wb") as output:
        process=subprocess.Popen([node,entry],cwd=work,env=env|{"SUPERAGENT_DRIVER":"fixture","SUPERAGENT_PORT":"0",
            "SUPERAGENT_FIXTURE_EXIT_AFTER_RECEIPT":"1" if crash else "0"},stdout=output,stderr=output)
        try:
            deadline=time.monotonic()+20
            while time.monotonic()<deadline:
                lines=log.read_text(encoding="utf-8",errors="replace").splitlines()
                ready=next((json.loads(s) for s in lines if s.startswith('{"implementation"')),None)
                if ready:
                    yield process,urlsplit(ready["address"]).port
                    return
                if process.poll() is not None:
                    raise RuntimeError(lines[-6:])
                time.sleep(.1)
            raise TimeoutError("Pinned Host did not start")
        finally:
            if process.poll() is None:
                process.terminate()
                process.wait(10)


def exercise(node,entry,work,case):
    direct=case.startswith("direct-")
    mode=case.removeprefix("direct-")
    work.mkdir()
    env={k:os.environ[k] for k in ("SystemRoot","SystemDrive","WINDIR","ComSpec","PATHEXT","PROCESSOR_ARCHITECTURE") if k in os.environ}
    env.update({k:str(work) for k in ("TEMP","TMP","HOME","USERPROFILE","LOCALAPPDATA","APPDATA","CODEX_HOME","SUPERAGENT_DATA_DIR")})
    env.update(PATH=os.pathsep.join([str(Path(shutil.which("git")).parent),str(node.parent),str(Path(os.environ["SystemRoot"])/"System32")]),
               SUPERAGENT_API_TOKEN="test-local",SUPERAGENT_REDMINE_CONFIG=json.dumps(
                   {"enabled":True,"base_url":"https://offline.invalid","project_ids":[5],"user_id":7}))
    db=work/"superagent.db"
    stamp=datetime.now(timezone.utc).isoformat()
    freeze=[str(node),str(entry),"--prepare-python-rollback"]
    prohibited=work/"side-effects.txt"
    prepare_env=env|{"NODE_OPTIONS":'--require="'+(HERE/"prepare-guard.cjs").as_posix()+'"',"REVIEW_SIDE_EFFECTS":str(prohibited)}
    with server(node,entry,work,env,True) as (host,port):
        with closing(sqlite3.connect(db)) as storage:
            storage.execute("""INSERT INTO projects(id,name,repo_path,repositories,base_branch,test_command,allowed_paths,dingtalk_chat_ids,
              redmine_project_ids,enabled,archived,created_at) VALUES(1,'sample',?,'[]','main','','["."]','[]','[5]',1,0,?)""",(str(work),stamp))
            storage.execute("""INSERT INTO tasks(id,title,kind,owner_id,outcome_unknown,goal,project_id,status,revision,state_version,
              control_version,source,acceptance_criteria,created_at,updated_at) VALUES(1,'sample','repair','admin',0,'sample',1,'queued',1,1,1,'web','',?,?)""",(stamp,stamp))
            storage.execute("""INSERT INTO events(task_id,source,event_type,content,data,created_at) VALUES(1,'redmine','issue.comment','sample',?,?)""",
                (json.dumps({"routing_status":"routed","issue_id":"33","metadata":{"redmine_endpoint":"https://offline.invalid"}}),stamp))
            event=storage.execute("SELECT last_insert_rowid()").fetchone()[0]
            storage.commit()
        draft=api(port,"POST","tasks/1/deliveries",{"event_id":event,"content":"offline"})
        assert draft["id"]==1
        api(port,"POST","deliveries/1/decision",{"decision":"approve","action_hash":draft["approval"]["action_hash"]})
        api(port,"PATCH","settings",{"scheduler_enabled":True,"external_delivery_enabled":True})
        deadline=time.monotonic()+24
        while rows(db,"SELECT status FROM tasks WHERE id=1") != [("waiting_approval",)]:
            if time.monotonic()>deadline:
                raise RuntimeError(rows(db,"SELECT status,last_error FROM tasks"))
            time.sleep(.1)
        active=subprocess.run(freeze,cwd=work,env=prepare_env,capture_output=True,timeout=10)
        assert active.returncode!=0 and "租约仍有效" in active.stderr.decode("utf-8","replace"),active.stderr
        assert not (work/"rollback-backups").exists()
        try:
            api(port,"POST","deliveries/1/publish")
        except (ConnectionError,http.client.RemoteDisconnected):
            pass
        assert host.wait(8)!=0
    pre=state(db)
    assert pre==["dispatching",0,"waiting_approval","pending"],pre
    ident=db.stat().st_ino
    saved=receipts(work)
    receipt=json.loads(saved)
    assert receipt["actionId"]=="reply-"+str(draft["approval"]["id"]) and receipt["content"]=="offline"
    expiry=rows(db,"SELECT expires_at FROM controller_leases WHERE id='controller'")[0][0]
    pause=max(0,datetime.fromisoformat(expiry).timestamp()-time.time()+.1)
    assert pause<=31,expiry
    time.sleep(pause)
    if direct:
        check=subprocess.run([sys.executable,"-IB","-X","utf8",str(HERE/"oracle.py"),mode,str(work)],
                             env=env,cwd=work,capture_output=True,timeout=30)
        assert check.returncode==0,check.stderr.decode("utf-8","replace")
        control=json.loads(check.stdout.decode("utf-8").strip().splitlines()[-1])
        assert control["ledger"]=="dispatching" and control["manual_reconciliation"]=="仅可对账结果未知的交付"
        with server(node,entry,work,env,False) as (_,port):
            replay=api(port,"POST","deliveries/1/publish")
            assert replay["write_status"]=="unknown" and receipts(work)==saved
        return {"negative_control":True,"before":pre,"python":control,"ts_replay":replay["write_status"],"receipt_files":1}
    done=subprocess.run(freeze,cwd=work,env=prepare_env,capture_output=True,timeout=20)
    assert done.returncode==0,done.stderr.decode("utf-8","replace")
    payload=json.loads(done.stdout)
    assert payload["prepared"] and Path(payload["database"]).samefile(db)
    assert payload["unknown_delivery_ids"]==[receipt["actionId"]] and payload["unknown_task_ids"]==[1]
    backup=Path(payload["backup"])
    assert backup.parent==(work/"rollback-backups") and rows(backup,"PRAGMA integrity_check")==[("ok",)]
    assert state(backup)==pre and state(db)==["unknown",1,"unknown","expired_on_restart"]
    assert not prohibited.exists()
    epoch,expires=rows(db,"SELECT epoch,expires_at FROM controller_leases WHERE id='controller'")[0]
    assert epoch==2 and datetime.fromisoformat(expires).timestamp()<=time.time()+.02
    python=subprocess.run([sys.executable,"-IB","-X","utf8",str(HERE/"oracle.py"),"prepared-"+mode,str(work),receipt["id"]],
                          env=env,cwd=work,capture_output=True,timeout=30)
    assert python.returncode==0,python.stderr.decode("utf-8","replace")
    recovered=json.loads(python.stdout.decode("utf-8").strip().splitlines()[-1])
    assert state(db)==["succeeded",1,"unknown","expired_on_restart"] and receipts(work)==saved
    with server(node,entry,work,env,False) as (_,port):
        replay=api(port,"POST","deliveries/1/publish")
        assert replay["write_status"]=="succeeded" and replay["reconciliation_evidence"]=="offline receipt "+receipt["id"]
        assert receipts(work)==saved and db.stat().st_ino==ident
        assert rows(db,"SELECT COUNT(*) FROM events WHERE event_type='delivery.reconciled'")==[(1,)]
    payload.update(database="<same>/superagent.db", backup="<same>/rollback-backups/"+backup.name)
    return {"active_refused":True,"real_crash":True,"lease_wait_seconds":round(pause,2),"before":pre,
            "prepare_json":payload,"prepare_epoch":epoch,"backup_before_recovery":True,"prohibited_calls":0,
            "python":recovered,"ts_replay":replay["write_status"],"same_file_id":str(ident),
            "reconciliation_events":1,"receipt_files":1,"receipt_sha256":hashlib.sha256(saved).hexdigest()}


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("node",type=Path)
    args=parser.parse_args()
    assert __debug__
    result={"main_sha256":PIN,"at_utc":datetime.now(timezone.utc).isoformat(),"cases":{}}
    with tempfile.TemporaryDirectory(prefix="p-",dir=HERE) as temp:
        folder=Path(temp)
        with zipfile.ZipFile(HERE/"prepare-candidate.zip") as package:
            assert set(package.namelist())=={"main.js","bin/windows-job-x64.exe","fixtures/environment.ts",
                                              "fixtures/fake-app-server.ts","fixtures/fake-channel-sender.ts"}
            assert hashlib.sha256(package.read("main.js")).hexdigest()==PIN
            result["dist_sha256"]={n:hashlib.sha256(package.read(n)).hexdigest() for n in package.namelist()}
            package.extractall(folder/"dist")
        with ThreadPoolExecutor(max_workers=4) as pool:
            cases={mode:pool.submit(exercise,args.node.resolve(),folder/"dist/main.js",folder/mode,mode)
                   for mode in ("default","stock","direct-default","direct-stock")}
            for mode,test in cases.items():
                try:
                    result["cases"][mode]={"pass":True,"observed":test.result()}
                except Exception as e:
                    import traceback
                    result["cases"][mode]={"pass":False,"error":traceback.format_exc().replace(temp,"<scratch>")}
                print(mode,result["cases"][mode],flush=True)
    (HERE/"prepared.json").write_text(json.dumps(result,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    return int(any(not case["pass"] for case in result["cases"].values()))


if __name__=="__main__":
    sys.exit(main())
