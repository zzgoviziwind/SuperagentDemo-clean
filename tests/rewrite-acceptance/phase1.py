"""Run the integrated TS entry, crash after a fake receipt, reconcile in Chromium, then reopen in Python."""
import argparse
from contextlib import closing, contextmanager
from datetime import datetime, timezone
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

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import stage0

ROOT = stage0.ROOT
ENTRY = ROOT / "apps/server/dist/main.js"
HTTP_OBSERVATIONS = []
HTTP_SERVICE = {}
USERS = [{"role":r,"user_id":u,"token":"fixture-"+u} for u,r in
         [("admin","admin"),("alice","member"),("bob","member"),("viewer","viewer")]]


def wait_for(fn, seconds=18):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        result = fn()
        if result:
            return result
        time.sleep(.12)
    raise TimeoutError(getattr(fn, "__name__", "wait"))


def net(port, path, method="GET", body=None, user="admin", allowed=(200,)):
    with closing(http.client.HTTPConnection("127.0.0.1", port, timeout=8)) as c:
        c.request(method, path, None if body is None else json.dumps(body).encode(),
                  {"Authorization":"Bearer fixture-"+user, "Content-Type":"application/json"} if body is not None
                  else {"Authorization":"Bearer fixture-"+user})
        res = c.getresponse()
        data = json.loads(res.read())
        HTTP_OBSERVATIONS.append({"service":HTTP_SERVICE.get(port,"python"), "method":method, "path":path,
                                  "role":user, "status":res.status, "body_sha256":stage0.sha(stage0.canonical(data))})
        assert res.status in allowed, (method,path,res.status,data)
        return res.status,data


def env_for(work):
    env = {k:os.environ[k] for k in ("SYSTEMROOT","WINDIR","SYSTEMDRIVE","PROCESSOR_ARCHITECTURE",
           "PROGRAMFILES","PROGRAMFILES(X86)","PROGRAMDATA","COMSPEC") if k in os.environ}
    env.update({k:str(work) for k in ("TEMP","TMP","HOME","USERPROFILE","APPDATA","LOCALAPPDATA","CODEX_HOME")})
    return env


@contextmanager
def process(cmd, work, env, label):
    log = work / (label + ".log")
    with log.open("wb") as output:
        proc = subprocess.Popen(cmd, cwd=work, env=env, stdout=output, stderr=subprocess.STDOUT,
                                creationflags=getattr(subprocess,"CREATE_NO_WINDOW",0))
        try:
            yield proc,log
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait(8)


@contextmanager
def host(node, work, report, crash, extra_env=None):
    tag = "crash-host" if crash else "restarted-host"
    # The integration bundle handles SIGTERM. Supply a graceful shutdown trigger on Windows.
    stop = work / "stop-host"
    stop.unlink(missing_ok=True)
    preload = work / "stop-hook.cjs"
    preload.write_text("setInterval(()=>{if(require('node:fs').existsSync('stop-host'))process.emit('SIGTERM')},100).unref();","utf-8")
    env = env_for(work) | {"SUPERAGENT_DATA_DIR":str(work),"SUPERAGENT_DRIVER":"fixture",
        "SUPERAGENT_WEB_DIST":str(work/"web"),"SUPERAGENT_PORT":"0","SUPERAGENT_SERVICE_MODE":"preview",
        "SUPERAGENT_ALLOWED_REPO_ROOTS":str(work),"SUPERAGENT_USERS_JSON":json.dumps(USERS)}
    if crash:
        env["SUPERAGENT_FIXTURE_EXIT_AFTER_RECEIPT"] = "1"
    git = shutil.which("git")
    assert git, "The synthetic repair workspace requires a local Git executable"
    env["PATH"] = str(Path(git).parent)
    if extra_env:
        env.update(extra_env)
    entry = work/"host-dist"/"main.js"
    assert stage0.sha(entry.read_bytes()) == report["entry_sha256"], "Integrated bundle changed during replay"
    with process([node,"--require",str(preload),str(entry)],work,env,tag) as (proc,log):
        def address():
            lines = log.read_text("utf-8",errors="replace").splitlines()
            for line in lines:
                if line.startswith('{"implementation":"typescript","address":'):
                    endpoint = json.loads(line)["address"]
                    assert endpoint.startswith("http://127.0.0.1:")
                    return int(endpoint.rsplit(":",1)[1])
            if proc.poll() is not None:
                raise RuntimeError((tag,proc.returncode,lines[-10:]))
        port = wait_for(address)
        HTTP_SERVICE[port] = "ts"
        health = net(port,"/health")[1]
        assert health["implementation"] == "typescript"
        report[tag] = {"pid":proc.pid,"port":port,"health":health,"exit_after_receipt":crash}
        try:
            yield port,proc
        finally:
            if proc.poll() is None:
                stop.touch()
                proc.wait(12)
            report[tag]["returncode"] = proc.returncode


def visibility(port, task_id, artifact_id):
    results = {}
    for user, ids in [("admin",{1,task_id}),("alice",{1}),("bob",{task_id}),("viewer",set())]:
        def get(path, codes=(200,)):
            return net(port,"/api/v1"+path,user=user,allowed=codes)
        rows = get("/tasks")[1]
        assert {r["id"] for r in rows} == ids, (user,"list")
        assert {r["id"] for r in get("/tasks?project_id=1")[1]} == ids
        overview = get("/overview")[1]
        expected_counts = {status:sum(t["status"]==status for t in rows) for status in {r["status"] for r in rows}}
        assert overview["counts"] == expected_counts
        assert {r["id"] for r in overview["active_tasks"]} == {r["id"] for r in rows if r["status"] not in ("completed","cancelled")}
        pending = {a["id"] for task in ids for a in get(f"/tasks/{task}")[1]["approvals"] if a["status"]=="pending"}
        assert {a["id"] for a in overview["pending_approvals"]} == pending
        assert all(a["task_id"] in ids for a in overview["pending_approvals"])
        if user in ("admin","bob"):
            assert pending
        outcomes = {}
        for task, artifact in [(1,1),(task_id,artifact_id)]:
            paths = [f"/tasks/{task}",f"/tasks/{task}/export"]
            if artifact:
                paths.extend([f"/artifacts/{artifact}",f"/artifacts/{artifact}/download"])
            for path in paths:
                code,body = get(path,(200,) if task in ids else (403,404))
                if code == 200:
                    assert body.get("task", body).get("task_id", body.get("task",body).get("id")) == task
                else:
                    assert set(body) == {"detail"}
                outcomes[path] = code
        results[user] = {"task_ids":sorted(ids),"counts":expected_counts,"pending_approval_ids":sorted(pending),
                         "detail_checks":outcomes}
    return results


def file_receipt(work):
    files = list((work / "fake-channel-receipts").glob("*"))
    assert len(files) == 1 and files[0].suffix == ".json", files
    return json.loads(files[0].read_text("utf-8"))


def sqlite_read(work, query, parameters=()):
    with closing(sqlite3.connect((work/"superagent.db").as_uri()+"?mode=ro",uri=True)) as c:
        return c.execute(query,parameters).fetchall()


def repair_approval(call, work, report, node):
    project_root = work/"含空格 项目"
    assert project_root.is_dir() and not (project_root/".git").exists()
    git = [shutil.which("git"), "-C", str(project_root)]
    env = env_for(work) | {"GIT_CONFIG_NOSYSTEM":"1", "GIT_CONFIG_GLOBAL":os.devnull}
    subprocess.run([*git,"init","-q","-b","main"],env=env,check=True)
    (project_root/"fixture-value.txt").write_bytes(b"before\n")
    subprocess.run([*git,"add","--","fixture-value.txt"],env=env,check=True)
    subprocess.run([*git,"-c","user.name=fixture","-c","user.email=fixture@localhost",
                    "commit","-qm","test（common）：创建合成修复样本"],env=env,check=True)
    check = r"""require('node:assert/strict').equal(require('node:fs').readFileSync('fixture-value.txt','utf8'),'after\n')"""
    project = call("/projects/1","PATCH",{"allowed_paths":["."],"test_command":json.dumps([node,"-e",check])})
    assert project["allowed_paths"] == ["."]
    task = call("/tasks","POST",{"kind":"repair","title":"离线修复审批","goal":"修复合成文本",
                                "project_id":1,"acceptance_criteria":"本轮差异和命令退出码"},"bob")
    path = f"/tasks/{task['id']}"
    call("/settings","PATCH",{"scheduler_enabled":True})
    def until(status):
        def observed():
            detail = call(path,user="bob")
            current = detail["task"]["status"]
            if current in ("failed","waiting_resource"):
                report["repair_failure"] = detail["task"]
                raise AssertionError(("repair",detail["task"]))
            return detail if current == status else None
        return wait_for(observed,50)
    pending, = until("waiting_approval")["approvals"]
    assert pending["status"] == "pending" and pending["action_hash"]
    route = f"/approvals/{pending['id']}/decision"
    decision = {"decision":"approve","action_hash":pending["action_hash"]}
    call(route,"POST",dict(decision,action_hash="wrong-fixture-hash"),"bob",(409,))
    assert call(path,user="bob")["approvals"][0]["status"] == "pending"
    approved = call(route,"POST",decision,"bob")
    assert approved["status"] == "approved"
    detail = until("review_ready")
    call(route,"POST",decision,"bob",(409,))
    artifacts = {a["kind"]:a for a in detail["artifacts"]}
    assert set(artifacts) == {"summary","verification","changes"}
    attempt = artifacts["verification"]["attempt_id"]
    assert attempt and all(a["attempt_id"] == attempt and a["revision"] == task["revision"] for a in artifacts.values())
    proof = json.loads(artifacts["verification"]["content"])
    changes = json.loads(artifacts["changes"]["content"])
    assert (proof["host_checked"] and proof["repair_verified"] and proof["evidence_source"] == "offline-codex-fixture"
            and proof["test"]["source"] == "host-command" and proof["test"]["exit_code"] == 0)
    assert (proof["thread_id"],proof["turn_id"]) == (detail["task"]["codex_thread_id"],detail["task"]["codex_turn_id"])
    assert all((proof["thread_id"],proof["turn_id"],artifacts["summary"]["content"]))
    if "repositories" in changes:
        repo, = changes["repositories"]
        assert repo["path"] == "." and not repo["untracked"]
        changes = repo["snapshot"]
    assert changes["changed"] == ["fixture-value.txt"] and not changes["untracked"] and changes["diff"]
    cwd = Path(proof["test"]["cwd"]).resolve()
    assert cwd.is_relative_to((work/"worker-workspaces").resolve())
    assert (cwd/"fixture-value.txt").read_bytes() == b"after\n"
    current = {"accepted":True,"revision":task["revision"]}
    call(path+"/acceptance","POST",dict(current,revision=task["revision"]+1),"bob",(409,))
    assert call(path+"/acceptance","POST",current,"bob")["status"] == "completed"
    call("/settings","PATCH",{"scheduler_enabled":False})
    report["repair"] = {"id":task["id"],"approval_id":pending["id"],"approval_status":approved["status"],
                        "attempt_id":attempt,"proof":proof,"changed":changes["changed"],"status":"completed",
                        "artifacts":artifact_manifest(artifacts.values())}


def artifact_manifest(rows):
    return {str(a["id"]):{"kind":a["kind"],"attempt_id":a["attempt_id"],"revision":a["revision"],
                          "content_sha256":stage0.sha(a["content"].encode("utf-8"))} for a in rows}


def automatic_draft(call, work, task, source_id, summary, report):
    """Wait read-only while the task is review_ready and the reply collector is active."""
    def persisted():
        rows = call(f"/tasks/{task['id']}/deliveries", user="bob")
        if not rows:
            return None
        draft, = rows
        assert (draft["event_id"], draft["task_id"], draft["content"]) == (source_id, task["id"], summary["content"])
        return draft

    draft = wait_for(persisted, 30)
    approval, = [a for a in call(f"/tasks/{task['id']}",user="bob")["approvals"] if a["id"] == draft["approval_id"]]
    assert approval["status"] == "pending" and approval["action_hash"]
    assert (approval["revision"], approval["control_version"]) == (summary["revision"], task["control_version"])
    assert summary["revision"] == task["revision"]
    audit = draft_events(work, task["id"])
    decision, = [data for kind,data in audit if kind == "reply_decision"]
    created, = [data for kind,data in audit if kind == "reply_draft_created"]
    for data in (decision, created):
        assert (data["source_event_id"], data["draft_id"]) == (source_id, draft["id"])
    assert (decision["revision"], decision["control_version"], decision["attempt_id"]) == (
        task["revision"], task["control_version"], summary["attempt_id"])
    report["draft_origin"] = {"creator":"runtime","draft":draft,"events":audit}
    return {**draft, "approval":approval}


def draft_events(work, task):
    rows = sqlite_read(work, """SELECT event_type,data FROM events WHERE task_id=? AND source='runtime'
        AND event_type IN ('reply_decision','reply_draft_created') ORDER BY id""", (task,))
    return [(kind,json.loads(data)) for kind,data in rows]


def exercise(args, work, report, packaged_web=None):
    node,deps = str(args.node.resolve()), str(args.web_deps.resolve())
    browser = [node,str(HERE/"browser.mjs")]
    env = env_for(work)
    shutil.copytree(args.dist,work/"host-dist")
    report["dist_sha256"] = {p.relative_to(work/"host-dist").as_posix():stage0.sha(p.read_bytes())
                             for p in (work/"host-dist").rglob("*") if p.is_file()}
    assert report["dist_sha256"]["main.js"] == report["entry_sha256"]
    report["dist_set_sha256"] = stage0.sha(stage0.canonical(report["dist_sha256"]))
    if args.expect_dist_sha256:
        assert report["dist_set_sha256"] == args.expect_dist_sha256, "The candidate files do not match the pinned dist"
    if args.diagnose_missing_peer:
        peer = work/"host-dist/fixtures/environment.ts"
        if not peer.exists():
            shutil.copyfile(ROOT/"packages/runtime/fixtures/environment.ts",peer)
            report["diagnostic_fixture_added"] = {"fixtures/environment.ts":stage0.sha(peer.read_bytes())}
    report["node"] = subprocess.check_output([node,"--version"],text=True).strip()
    assert report["node"].startswith("v24.")
    if packaged_web is None:
        subprocess.run([*browser,"build",str(work),deps],env=env,cwd=work,check=True,timeout=60)
    else:
        shutil.copytree(packaged_web,work/"web")
    report["web_dist_sha256"] = {p.relative_to(work/"web").as_posix():stage0.sha(p.read_bytes())
                                 for p in (work/"web").rglob("*") if p.is_file()}
    with tempfile.TemporaryDirectory(prefix="stage0-source-", dir=HERE) as tmp:
        stage0.legacy_source(Path(tmp))
        stage0.worker("legacy", Path(tmp), work)
    shutil.copyfile(work/"legacy.db",work/"superagent.db")
    with closing(sqlite3.connect(work/"superagent.db")) as db:
        db.execute("UPDATE tasks SET owner_id='local-admin' WHERE id=1")
        db.execute("UPDATE governance_task_owners SET user_id='alice' WHERE task_id=1")
        db.commit()
    endpoint = lambda path: "/api/v1"+path
    with host(node,work,report,True) as (port,proc):
        def call(path,method="GET",body=None,user="admin",allowed=(200,)):
            return net(port,endpoint(path),method,body,user,allowed)[1]
        config = {"scheduler_enabled":False, "external_delivery_enabled":True,
                  "connectors.dingtalk":{"enabled":True,"profile":"test","self_ids":["fixture-self"],
                                        "executable":[sys.executable,"-IB",str(HERE/"replay_dws.py")]},
                  "dingtalk_response_policy":{"delivery":"approved_send","direct_messages":"reply",
                                              "group_messages":"off","default_project_id":1}}
        call("/settings","PATCH",config)
        call("/identities","POST",{"user_id":"bob","source":"dingtalk","actor_id":"fixture-actor",
                                   "permissions":["request"],"project_ids":[1]})
        message = {"source":"dingtalk","external_id":"crash-001","event_type":"message.received",
                   "thread_id":"fixture-thread","actor_id":"fixture-actor","content":"离线重启验收，请回复收到",
                   "metadata":{"dws_event_type":"user_im_message_receive_o2o_all","profile":"test","message_id":"crash-001"}}
        event = call("/events","POST",message)
        task = event["task_id"]
        assert task and event["data"]["routing_status"] == "routed",event
        replay = call("/events","POST",message)
        assert replay["duplicate"] and replay["id"] == event["id"] and replay["task_id"] == task
        task_path = f"/tasks/{task}"
        def ready():
            row = call(task_path)
            if row["task"]["status"] in ("waiting_resource","failed"):
                report["worker_failure"] = {key:row["task"].get(key) for key in
                    ("id","status","last_error","outcome_unknown","codex_thread_id","codex_turn_id")}
                raise AssertionError(("worker",row["task"]))
            return row if row["task"]["status"] == "review_ready" else None
        proof = summary = None
        reply_text = "离线人工草稿，核对收到"
        if not args.manual_draft:
            call("/settings","PATCH",{"scheduler_enabled":True})
            result = wait_for(ready)
            proof = next(a for a in result["artifacts"] if a["kind"] == "verification")
            summary = next(a for a in result["artifacts"] if a["kind"] == "summary")
            proof_data = json.loads(proof["content"])
            assert proof_data["host_checked"] and proof_data["evidence_source"] == "offline-codex-fixture"
            assert proof_data["tool_less"] and proof_data["thread_id"] and proof_data["turn_id"]
            assert (proof_data["thread_id"],proof_data["turn_id"]) == (result["task"]["codex_thread_id"],result["task"]["codex_turn_id"])
            assert proof["attempt_id"] and proof["attempt_id"] == summary["attempt_id"]
            draft = automatic_draft(call,work,result["task"],event["id"],summary,report)
            call("/settings","PATCH",{"scheduler_enabled":False})
            report["worker"] = {"task_id":task,"event_id":event["id"],"status":result["task"]["status"],
                                "attempt_id":proof["attempt_id"],"proof":proof_data,"artifacts":artifact_manifest([summary,proof])}
            reply_text = summary["content"]
        else:
            assert call(task_path+"/deliveries",user="bob") == []
            draft = call(task_path+"/deliveries","POST",{"event_id":event["id"],"content":reply_text},"bob")
            assert not draft_events(work,task)
            report["draft_origin"] = {"creator":"bob","draft_id":draft["id"],"event_id":draft["event_id"]}
        report["visibility"] = visibility(port,task,summary["id"] if summary else None)
        # Check that related execution content also obeys the agreed workbench read policy.
        report["delivery_visibility"] = {}
        for user in ("admin","bob","alice","viewer"):
            code, visible = net(port,endpoint(task_path+"/deliveries"),user=user,allowed=(200,403,404))
            count = len(visible) if isinstance(visible,list) else 0
            if code == 200 and user in ("admin","bob"):
                assert [row["id"] for row in visible] == [draft["id"]] and visible[0]["content"] == reply_text
            report["delivery_visibility"][user] = {"status":code,"rows":count,
                 "meets_visibility_rule": (code == 200 and count == 1) if user in ("admin","bob") else count == 0}
        if not args.manual_draft:
            repair_approval(call,work,report,node)
        dpath = f"/deliveries/{draft['id']}"
        decision = {"decision":"approve","action_hash":draft["approval"]["action_hash"]}
        assert call(dpath+"/decision","POST",decision,"bob")["status"] == "approved"
        try:
            call(dpath+"/publish","POST",user="bob")
        except (ConnectionError,http.client.RemoteDisconnected):
            pass
        else:
            raise AssertionError("Expected Host exit after receipt")
        assert proc.wait(10) != 0
    receipt = file_receipt(work)
    assert receipt["content"] == reply_text and receipt["actionHash"] == decision["action_hash"]
    assert receipt["target"] == {"source":"dingtalk","threadId":"fixture-thread","messageId":"crash-001"}
    assert receipt["actionId"] == "reply-"+str(draft["approval_id"])
    status_sql = "SELECT json_extract(result,'$.write_status') FROM delivery_records WHERE action_id=?"
    def ledger():
        return sqlite_read(work,status_sql,(receipt["actionId"],))[0][0]
    assert ledger() == "dispatching"
    expiry,epoch = sqlite_read(work,"SELECT expires_at,epoch FROM controller_leases")[0]
    delay = max(0,(datetime.fromisoformat(expiry)-datetime.now(timezone.utc)).total_seconds())
    assert 0 < delay < 35
    report["crash"] = {"receipt":receipt,"before_restart":"dispatching","lease_epoch":epoch,
                       "expires_at":expiry,"wait_seconds":round(delay,3)}
    stage0.save(work/"checkpoint.json",report)
    print(f"Crash verified. Waiting {delay:.1f}s for the persisted lease.",flush=True)
    time.sleep(delay+.2)
    ui_error = None
    with host(node,work,report,False) as (port,proc):
        assert ledger() == "unknown"
        assert sqlite_read(work,"SELECT epoch FROM controller_leases") == [(epoch+1,)]
        def post(path,body=None):
            return net(port,endpoint(path),"POST",body)[1]
        assert post(dpath+"/publish")["write_status"] == "unknown" and file_receipt(work)==receipt
        evidence = "独立假渠道回执 "+receipt["id"]
        try:
            subprocess.run([*browser,"reconcile",str(work),deps,f"http://127.0.0.1:{port}",str(task),evidence,
                            str(args.browser_exe.resolve()) if args.browser_exe else ""],
                           cwd=work,env=env,check=True,timeout=65)
            assert ledger() == "succeeded"
            report["browser_reconciled"] = True
        except (subprocess.SubprocessError,AssertionError) as exc:
            ui_error = str(exc)
            report["browser_reconciled"] = False
            if ledger() == "unknown":
                post(dpath+"/reconcile",{"outcome":"succeeded","evidence":evidence})
        final = post(dpath+"/publish")
        assert final["write_status"]=="succeeded" and final["reconciliation_evidence"]==evidence
        assert file_receipt(work) == receipt
        if summary:
            # Acceptance advances control_version. Finish delivery under the draft's original approval first.
            _, accepted = net(port,endpoint(task_path+"/acceptance"),"POST",
                              {"accepted":True,"revision":summary["revision"]},"bob")
            assert accepted["status"] == "completed"
            report["worker"]["status"] = accepted["status"]
        net(port,endpoint("/settings"),"PATCH",{"external_delivery_enabled":False,
              "dingtalk_enabled":False,"connectors.dingtalk":{"enabled":False},"scheduler_enabled":False})
        report["recovered"] = {"before_reconcile":"unknown","after_reconcile":final,"receipt_count":1}
    rollback(work,report,task,draft,receipt,proof,summary,final)
    if ui_error:
        raise RuntimeError("Browser incomplete: " + ui_error)


def rollback(work,report,task,draft,receipt,proof,summary,final):
    database = work/"superagent.db"
    fingerprint = database.stat()
    (work/"stop").unlink(missing_ok=True)
    env = env_for(work) | {"SUPERAGENT_STATE_ROOT":str(work/"state"),"SUPERAGENT_SERVICE_MODE":"preview",
          "SUPERAGENT_FEISHU_ENABLED":"0","SUPERAGENT_API_TOKEN":"fixture-admin",
          "SUPERAGENT_ATTACHMENTS_ROOT":str(work/"attachments"),"SUPERAGENT_DATABASE_URL":"sqlite:///"+database.as_posix()}
    with process([sys.executable,"-IB","-X","utf8",str(HERE/"uvicorn_restart.py"),"--serve"],
                 work,env,"python-rollback") as (proc,log):
        def healthy():
            if proc.poll() is not None:
                raise RuntimeError(log.read_text("utf-8",errors="replace")[-1500:])
            try:
                port = int((work/"port").read_text("ascii"))
                return port if net(port,"/health")[1]["version"]=="0.1.0" else None
            except (FileNotFoundError,ConnectionError,ValueError):
                return None
        port = wait_for(healthy,30)
        HTTP_SERVICE[port] = "python"
        def get(path):
            return net(port,"/api/v1"+path)[1]
        assert not any(c["enabled"] for c in get("/connectors"))
        saved = get(f"/tasks/{task}/export")
        expected_status = "completed" if summary else "queued"
        assert saved["task"]["status"] == expected_status
        for artifact in ([summary,proof] if summary else []):
            match = next(a for a in saved["artifacts"] if a["id"]==artifact["id"])
            assert match["content"] == artifact["content"] and match["attempt_id"] == artifact["attempt_id"]
        only_draft, = get(f"/tasks/{task}/deliveries")
        assert only_draft["id"] == draft["id"] and only_draft["delivery"] == final
        verified = {}
        if summary:
            for key,subject in [("worker",task),("repair",report["repair"]["id"])]:
                reopened = get(f"/tasks/{subject}/export")
                assert reopened["task"]["status"] == "completed"
                verified[key] = artifact_manifest(reopened["artifacts"])
                assert verified[key] == report[key]["artifacts"]
                if key == "repair":
                    assert [(a["id"],a["status"]) for a in reopened["approvals"]] == [(report[key]["approval_id"],"approved")]
        replay = net(port,f"/api/v1/deliveries/{draft['id']}/publish","POST",{})[1]
        assert replay == final and file_receipt(work)==receipt
        old = get("/artifacts/1")
        manifest = json.loads(old["content"])
        assert hashlib.sha256(Path(manifest["local_path"]).read_bytes()).hexdigest()==manifest["sha256"]
        (work/"stop").touch()
        assert proc.wait(16)==0
    assert database.stat().st_ino == fingerprint.st_ino
    assert sqlite_read(work,"PRAGMA integrity_check")==[("ok",)]
    report["python_rollback"] = {"port":port,"same_file_id":str(fingerprint.st_ino),
       "task":task,"status":expected_status,"receipt_count":1,"ledger":"succeeded","integrity":"ok","artifacts":verified}


def run(args, root, packaged_web=None):
    HTTP_OBSERVATIONS.clear()
    HTTP_SERVICE.clear()
    print("Evidence:",root,flush=True)
    report={"source":stage0.verify_source(),"entry_sha256":stage0.sha((args.dist/"main.js").read_bytes()),"manual_draft":args.manual_draft}
    try:
        exercise(args,root,report,packaged_web)
        task = report["python_rollback"]["task"]
        writes = [row for row in HTTP_OBSERVATIONS if row["method"] == "POST" and row["path"] == f"/api/v1/tasks/{task}/deliveries"]
        assert [row["role"] for row in writes] == (["bob"] if args.manual_draft else [])
        if args.manual_draft:
            assert not draft_events(root,task)
        report["draft_create_posts"] = writes
        report["crash_ui_rollback_passed"]=True
        report["candidate_signoff"]=False  # This focused test does not exercise all Phase 1 gates.
    finally:
        stage0.save(root/"result.json",report)
        stage0.save(root/"http.json",HTTP_OBSERVATIONS)
    print("PASS real TS crash, UI reconciliation and Python rollback")
    failed_roles = [role for role, result in report["delivery_visibility"].items()
                    if not result["meets_visibility_rule"]]
    if failed_roles:
        raise SystemExit("FAIL related delivery visibility for " + ", ".join(failed_roles))


if __name__ == "__main__":
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--node",type=Path,required=True)
    p.add_argument("--dist",type=Path,default=ENTRY.parent)
    p.add_argument("--expect-dist-sha256",help="require this complete distribution file-map digest")
    p.add_argument("--web-deps",type=Path,required=True)
    p.add_argument("--manual-draft",action="store_true",help="exercise delivery independently of Worker execution")
    p.add_argument("--browser-exe",type=Path,help="installed Chromium executable; default is Edge")
    p.add_argument("--diagnose-missing-peer",action="store_true",help="diagnostic only: complete a missing fixture import in the private copy")
    run(p.parse_args(), Path(tempfile.mkdtemp(dir=HERE,prefix="phase1-run-")))
