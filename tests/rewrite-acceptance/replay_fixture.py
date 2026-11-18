"""Build synthetic state with the frozen ORM, or serve that state with the frozen application."""
import base64
import hashlib
import json
import os
from pathlib import Path
import sys
import wave

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import stage0

ROOT = Path.cwd().resolve()
assert HERE in ROOT.parents and ROOT.name in {"seed","python"}
assert Path(os.environ["SUPERAGENT_STATE_ROOT"]).parent == ROOT
sys.path.insert(0, str(stage0.ORACLE))


def seed():
    from superagent import main
    from superagent.core import db, governance as gov, delivery
    from superagent.core.field_intake import FieldRecord, FieldTimeline, FieldCandidate
    from superagent.core.field_media import FieldMediaJob
    from superagent.core.ingestion import EventAttachmentJob
    from superagent.core.semantic_routing import SemanticRoutingJob
    from superagent.core.sessions import RouterSession
    from superagent.core.subscriptions import WorkerSubscription, thread_key
    from superagent.core.watchdog import WatchdogRun
    from superagent.core.conversation_providers import BridgeOperation
    assert Path(main.__file__).resolve() == stage0.ORACLE/"superagent/main.py"
    db.init_db()
    repo = ROOT/"含空格 项目"
    (repo/"子目录").mkdir(exist_ok=True)
    (ROOT/".codex-global-state.json").write_text(json.dumps({"local-projects":{"offline":{"name":"样本","rootPaths":[str(repo)]}}}),"utf-8")
    img = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJXkAAAAASUVORK5CYII=")
    fid = "10000000-0000-4000-8000-000000000001"
    pic = ROOT/"attachments"/"field"/fid/"1.png"
    pic.parent.mkdir(parents=True)
    pic.write_bytes(img)
    wav = ROOT/"attachments"/"field-media"/fid/"source.wav"
    wav.parent.mkdir(parents=True)
    with wave.open(str(wav),"wb") as f:
        f.setparams((1,1,8000,0,"NONE","not compressed"))
        f.writeframes(bytes([128])*80)
    media = {"suffix":".wav","filename":"sample.wav","content_type":"audio/wav","size":wav.stat().st_size,
             "video":False,"duration_ms":10}
    event = dict(stage0.INPUT["event"],actor_id="9",project_external_id="7",routing_status="routed")
    with db.Session.begin() as s:
        s.add(db.Project(id=2,name="第二个项目",repo_path=str(repo),allowed_paths=["."]))
        for tid,status in [(10,"paused"),(11,"queued"),(12,"waiting_resource"),(13,"review_ready"),(14,"completed"),(15,"paused")]:
            s.add(db.Task(id=tid,title=f"合成任务{tid}",goal="离线演练",project_id=1,kind="analysis" if tid in (14,15) else "reply",
                          owner_id="bob" if tid==15 else "admin",status=status,outcome_unknown=tid==12))
            s.add(gov.TaskOwner(task_id=tid,user_id="bob" if tid==15 else "admin"))
        for eid,tid in [(100,10),(101,None),(102,None),(103,None),(104,14)]:
            data = dict(event,external_id=f"msg-{eid}",routing_status="routed" if tid else "pending_confirmation")
            s.add(db.Event(id=eid,task_id=tid,source="field" if eid==104 else "redmine",external_id=data["external_id"],
                           event_type="message.received" if eid==104 else "issue.comment",data=data,content=f"原件 {eid}"))
        s.add_all([db.Artifact(task_id=14,kind="summary",revision=1,content="合成分析摘要"),
                   db.Event(id=105,task_id=11,source="web",event_type="coordination_request",content="固定协调",data={"status":"pending","session_id":"worker:10","request_key":"request-a","request":{"event_id":100,"target_task_id":11,"expected_state_version":1,"evidence":"合成授权"}}),
                   BridgeOperation(id=1,actor_id="admin",request_key="existing-operation",payload_hash="0"*64,status="completed",result={"session_id":"worker:10","task_id":10}),
                   gov.Setting(key="connectors.redmine",value=dict(stage0.INPUT["redmine"],enabled=False)),
                   gov.Setting(key="connectors.dingtalk",value={"enabled":False,"profile":"test","self_ids":["fixture-self"],"executable":[sys.executable,"-IB",str(HERE/"replay_dws.py")]}),
                   gov.Setting(key="dingtalk_response_policy",value={"direct_messages":"reply","group_messages":"off","delivery":"draft","default_project_id":None}),
                   gov.Setting(key="private_event_rules",value=[{"name":"初始静默","action":"quiet","project_id":2}]),
                   db.Artifact(task_id=14,kind="verification",revision=1,content=json.dumps({"has_changes":False,"analysis_read_evidence":{"evidence_calls":1}})),
                   db.ExecutionAttempt(id="sample-attempt",task_id=10,manifest_id=1,attempt_no=1,phase="turn",owner="old",status="completed",revision=1,control_version=1,thread_id="thread-10",turn_id="turn-10"),
                   db.ContextManifest(id=1,task_id=10,project_id=1,attempt_id="sample-attempt",revision=1,control_version=1,thread_id="thread-10",turn_id="turn-10",budget_chars=100,items=[{"source":"fixture"}]),
                   db.Decision(id=1,project_id=1,task_id=10,kind="note",content="固定约束",actor="admin"),
                   EventAttachmentJob(event_id=100,task_id=10,revision=1,control_version=1,status="failed"),
                   WorkerSubscription(id=1,task_id=10,project_id=1,source="redmine",thread_id="issue:42",thread_key=thread_key("redmine","issue:42")),
                   SemanticRoutingJob(event_id=103,project_id=1,status="ignored",context={},decision={"action":"ignore","reason":"样本"}),
                   RouterSession(project_id=1,status="unknown",outcome_unknown=True),
                   WatchdogRun(id="sample-run",task_id=10,state_version=1,status="unknown"),
                   gov.BudgetAccount(id="global",hard_limit_micros=1000,reserved_micros=40),
                   gov.BudgetReservation(id=1,account_id="global",request_key="sample",task_id=10,estimate_micros=40,estimate_basis="样本",status="unknown"),
                   FieldRecord(id=fid,project_id=1,title="现场样本",notes="一段笔记",owner_id="admin",screenshots=[{"filename":"a.png","content_type":"image/png","size":len(img),"sha256":hashlib.sha256(img).hexdigest(),"local_path":str(pic)}]),
                   FieldTimeline(record_id=fid,transcript=[{"id":"s1","text":"合成片段","start_ms":0,"end_ms":10}]),
                   FieldCandidate(id=1,record_id=fid,draft={"kind":"question","title":"核对","detail":"核对","screenshots":[]}),
                   FieldMediaJob(id=fid,project_id=1,owner_id="admin",title="合成录音",media=media,screenshots=[],state="ready",phase="done"),
                   FieldMediaJob(id="failed-media",project_id=1,owner_id="admin",title="待重试",media=media,screenshots=[],state="failed",phase="failed")])
        for eid in (106,107,108):
            msgid=f"sample-dm-{eid}"
            data={"thread_id":"fixture-thread","actor_id":"fixture-peer","attachments":[],"occurred_at":db.now(),
                  "routing_status":"routed" if eid==106 else "pending_confirmation",
                  "metadata":{"dws_event_type":"user_im_message_receive_o2o_all","conversation_type":"direct",
                              "profile":"test","message_id":msgid}}
            s.add(db.Event(id=eid,source="dingtalk",task_id=10 if eid==106 else None,external_id=msgid,
                           event_type="message.received",content=f"合成私聊 {eid}",data=data))
        s.flush()
    gov.map_actor(source="redmine",actor_id="9",user_id="admin",permissions=["request"],project_ids=[1],actor="admin")
    gov.map_actor(source="dingtalk",actor_id="fixture-peer",user_id="admin",permissions=["request"],project_ids=[1],actor="admin")
    config = {"connectors.redmine":dict(stage0.INPUT["redmine"],enabled=True),"external_delivery_enabled":True}
    draft = delivery.create_draft(10,100,"固定待批草稿",settings=config.get)
    with db.Session() as s:
        tool_hash = s.get(db.Approval,1).action_hash
    stage0.save(ROOT/"seed-ids.json",{"draft":draft["id"],"hash":draft["approval"]["action_hash"],"tool_hash":tool_hash})


def serve():
    # Substitute only the native chooser and desktop-account discovery at the external boundary.
    # The HTTP parser, auth, services, transactions and lifespan are the frozen implementation.
    from superagent.api import project_workspace
    from superagent.core import local_agents
    project_workspace.pick_directory = lambda path: str(path)
    local_agents.discover_executable = lambda *args: None
    import uvicorn_restart
    uvicorn_restart.serve()


if __name__ == "__main__":
    {"seed":seed,"serve":serve}[sys.argv[1]]()
