"""Classify recorded HTTP responses, business state changes and fixture limitations."""
from collections import Counter
from contextlib import closing
from datetime import datetime
import json
from pathlib import Path
import re
import shutil
import sqlite3

import stage0

UUID = re.compile(r"(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b")
TIMES = {"at","started_at","ended_at","created_at","updated_at","verified_at","claimed_at","finished_at","exported_at","triaged_at",
         "dispatching_at","revoked_at","reconciled_at","last_seen","heartbeat_at","expires_at","received_at","decided_at"}


def normalized(value,work,key="",ids=None):
    if ids is None:
        ids={}
    if isinstance(value,dict):
        return {k:normalized(value[k],work,k,ids) for k in sorted(value)}
    if isinstance(value,list):
        return [normalized(v,work,key,ids) for v in value]
    if isinstance(value,str):
        if key in TIMES:
            try:
                if datetime.fromisoformat(value).utcoffset() is not None:
                    return "<timestamp>"
            except ValueError:
                pass
        if value.startswith(("{","[")):
            try:
                return {"$serialized_json":normalized(json.loads(value),work,"",ids)}
            except ValueError:
                pass
        for src in (json.dumps(work,ensure_ascii=False)[1:-1],work,work.replace("\\","/")):
            value=value.replace(src,"<ROOT>")
        def token(match):
            ident=match[0]
            if ident=="10000000-0000-4000-8000-000000000001":
                return ident
            return ids.setdefault(ident,f"<generated UUID {len(ids)+1}>")
        return UUID.sub(token,value)
    return value


def differences(a,b,path="",limit=12):
    found=[]
    def walk(x,y,name):
        if len(found)>=limit: return
        if type(x) is not type(y):
            found.append(name+" (类型)")
        elif isinstance(x,dict):
            for k in sorted(x.keys()|y.keys()):
                if len(found)>=limit: break
                if k not in x or k not in y:
                    found.append(name+"/"+k+(" (仅 TS)" if k not in x else " (仅 Python)"))
                else: walk(x[k],y[k],name+"/"+k)
        elif isinstance(x,list):
            if len(x)!=len(y): found.append(name+" (条数)")
            for i,(left,right) in enumerate(zip(x,y)):
                walk(left,right,f"{name}/{i}")
        elif x!=y:
            found.append(name or "/")
    walk(a,b,path)
    return found


def missing(resp):
    body=resp["body"]
    return (resp["status"]==404 and isinstance(body,dict) and body.get("error")=="Not Found"
            and isinstance(body.get("message"),str) and body["message"].startswith("Route ") and "not found" in body["message"])


def useful_body(key,resp):
    body=resp["body"]
    if body in (None,[],{},""): return False
    if isinstance(body,dict) and "items" in body and body["items"]==[]:
        return False
    if key=="GET /events/stream": return "id:" in body and "data:" in body
    if key.endswith("/mcp") and isinstance(body,dict):
        return body.get("id")==7 and "result" in body
    if key in ("GET /field-intake/records/{ident}/media","GET /field-intake/records/{ident}/screenshots/{number}"):
        return body.get("byte_length",0)>0 and len(body.get("sha256",""))==64
    return True


def views(obs,work):
    resp=obs["response"]
    # Error detail is preserved in evidence, including its type. Free-form wording is separate
    # from the negative case's decision and verified absence of unintended writes.
    body = resp["body"]
    if resp["mime"]=="text/event-stream" and isinstance(body,str):
        # Compare the actual SSE frame including id and payload; JSON whitespace has no SSE semantics.
        body = [json.loads(line[6:]) if line.startswith("data: ") else line for line in body.splitlines()]
    return normalized({"status":resp["status"],"mime":resp["mime"],"headers":resp["headers"],"body":body,
                       "db":obs["db"],"files":obs["files"],"receipt_count":obs["receipts"]},work)


EXPECTED = {
    "DELETE /identities/{identity_id}":{"enabled":False},"DELETE /projects/{ident}":{"deleted":True},
    "DELETE /subscriptions/{subscription_id}":{"enabled":False},
    "PATCH /budgets/{account_id}":{"hard_limit_micros":765},"PATCH /identities":{"enabled":False},
    "PATCH /operations/projects/{project_id}/execution-node":{"node_id":"sample-node","project_id":2},
    "PATCH /projects/{ident}":{"name":"重命名项目"},"PATCH /settings":{"watchdog_interval_seconds":180},
    "POST /auth/login":{"user_id":"admin","role":"admin"},"POST /auth/logout":{"logged_out":True},
    "POST /budget-reservations/{reservation_id}/reconcile":{"actual_micros":15,"status":"settled"},
    "POST /conversation-providers/bridge/operations":{"duplicate":False},"POST /conversation-providers/mcp":{"id":7},
    "POST /decisions":{"content":"合成约束","status":"active"},"POST /decisions/{decision_id}/revoke":{"status":"revoked"},
    "POST /deliveries/{draft_id}/decision":{"status":"approved"},
    "POST /deliveries/{draft_id}/publish":{"write_status":"unknown"},
    "POST /deliveries/{draft_id}/reconcile":{"write_status":"succeeded","reconciliation_evidence":"独立假收件单"},
    "POST /event-groups/{ident}/delegations":{"event_type":"collaboration_requested"},
    "POST /event-groups/{ident}/events/{event_id}/resolution":{"id":100},
    "POST /event-groups/{ident}/following/{subscription_id}":{"enabled":False},
    "POST /event-groups/{ident}/rename":{"title":"新合成标题"},"POST /events":{"external_id":"new-message"},
    "POST /events/{event_id}/retry-routing":{"id":100,"duplicate":True},"POST /events/{event_id}/retry-attachments":{"id":100},
    "POST /field-intake/records":{"title":"合成现场记录","project_id":1},"POST /identities":{"actor_id":"new-actor"},
    "POST /operations/daemon/exchange":{"accepted":True},"POST /operations/daemon/poll":{"operation":None},
    "POST /operations/watchdog/{run_id}/messages":{"status":"reconciled","correction":"已核验"},
    "POST /projects":{"name":"新项目"},"POST /routing/jobs/{event_id}/correction":{"newly_applied":False},
    "POST /routing/schedule":{"routed_event_ids":[101]},"POST /sessions/{ident}/coordination":{"event_type":"coordination_request"},
    "POST /sessions/{ident}/handoff":{"task_id":10},"POST /sessions/{ident}/reconcile":{"outcome_unknown":False,"status":"idle"},
    "POST /subscriptions":{"thread_id":"issue:77","task_id":10},"POST /tasks":{"title":"合成请求","kind":"reply","owner_id":"admin"},
    "POST /tasks/{ident}/acceptance":{"status":"waiting_input"},"POST /tasks/{ident}/controls":{"status":"paused"},
    "POST /tasks/{ident}/project":{"project_id":2},"POST /tasks/{ident}/reconcile":{"outcome_unknown":False,"status":"paused"},
    "POST /tasks/{task_id}/deliveries":{"content":"合成渠道草稿","event_id":100},
    "GET /auth/me":{"role":"admin","user_id":"admin"},"GET /attempts/{attempt_id}/context":{"attempt_id":"sample-attempt"},
    "GET /sessions/{ident}/transcript":{"session_id":"worker:10"},"GET /field-intake/records/{ident}/transcript/{segment_id}":{"id":"s1"},
}


def predicates(key,body):
    return [f"{field} 应为 {expected}" for field,expected in EXPECTED.get(key,{}).items()
            if not isinstance(body,dict) or field not in body or body[field]!=expected]


def summarize_case(key,py,ts,pyroot,tsroot):
    pn,pp=py["observations"]
    tn,tp=ts["observations"]
    pr,tr=pp["response"],tp["response"]
    ps,ts_status=pr["status"],tr["status"]
    pneg,tneg=pn["response"],tn["response"]
    pview,tview=views(pp,pyroot),views(tp,tsroot)
    nleft,nright=views(pn,pyroot),views(tn,tsroot)
    # Match application status rather than implementation/version in /health.
    if key=="GET /health":
        pview["body"]={"status":pview["body"]["status"]}
        tview["body"]={"status":tview["body"]["status"]}
    fields = {k:differences(pview[k],tview[k],k) for k in pview}
    negative = {k:differences(nleft[k],nright[k],k) for k in nleft}
    fields = {k:v for k,v in fields.items() if v}
    negative = {k:v for k,v in negative.items() if v}
    required=set(py["required_tables"])
    absent={side:sorted(required-set(o["db"])) for side,o in [("python",pp),("ts",tp)]}
    failures = {side:predicates(key,res["body"]) if 200<=res["status"]<300 else []
                for side,res in [("python",pr),("ts",tr)]}
    observed = 200<=ts_status<300 and useful_body(key,tr) and not absent["ts"] and not failures["ts"]
    allowed_negative_side_effects={"execution_nonces"} if "/daemon/" in key else set()
    negative_writes = ((set(pn["db"])|set(tn["db"]))-allowed_negative_side_effects or pn["files"] or tn["files"])
    neg_ok = (key.startswith("GET ") or 400<=tneg["status"]<500 or
              (key.endswith("/mcp") and isinstance(tneg["body"],dict) and "error" in tneg["body"]))
    contract405 = (key.endswith("/mcp") and key.split()[0] in ("GET","DELETE") and
                   ps==ts_status==405 and pr["headers"].get("allow")==tr["headers"].get("allow")=="POST" and pr["body"]==tr["body"]=="")
    daemon = key in {"POST /operations/daemon/poll", "POST /operations/daemon/exchange"}
    delegated = daemon and ps == 200 and 400 <= pneg["status"] < 500 and not failures["python"] and not absent["python"]
    if delegated:
        for observation in (tn, tp):
            response = observation["response"]
            body = response["body"]
            delegated = delegated and (response["status"] == 503 and isinstance(body,dict)
                and body.get("execution_host") == "python" and "回切" in body.get("detail","")
                and not observation["db"] and not observation["files"] and observation["receipts"] == 0)
    if delegated: status="按约定由 Python 承载"
    elif missing(tr): status="TS 路由缺失"
    elif max(ps,ts_status,pneg["status"],tneg["status"])>=500: status="服务错误"
    elif ts_status in (401,403) and ps==ts_status: status="仅权限拒绝"
    elif ps!=ts_status or pneg["status"]!=tneg["status"] or negative_writes or not neg_ok: status="行为差异"
    elif contract405: status="协议拒绝通过"
    elif ps>=400: status="前置条件拒绝"
    elif failures["python"] or failures["ts"]: status="业务字段不符"
    elif absent["python"] or absent["ts"]: status="副作用不符"
    elif not observed or not useful_body(key,pr): status="业务证据不足"
    elif set(fields)=={"headers"}: status="业务抽查通过，响应头有差异"
    elif fields: status="字段或持久记录差异"
    else: status="业务抽查通过"
    return {"classification":status,"ts_business_observed":observed and not missing(tr),"python_status":ps,"ts_status":ts_status,
            "negative_status":[pneg["status"],tneg["status"]],"positive_differences":fields,"negative_differences":negative,
            "negative_unexpected_writes":bool(negative_writes),"required_tables_missing":absent,"business_assertions_failed":failures,
            "fixture_boundary":py["boundary"],"python_db_tables":sorted(pp["db"]),"ts_db_tables":sorted(tp["db"])}


def report(root,groups,out):
    out.mkdir(parents=True,exist_ok=True)
    rows,records={},{}
    for name,keys in groups.items():
        pair={side:json.loads((root/name/(side+".json")).read_text("utf-8")) for side in ("python","ts")}
        assert all(result["meta"]["integrity"]=="ok" for result in pair.values())
        for key in keys:
            rows[key]=summarize_case(key,pair["python"]["cases"][key],pair["ts"]["cases"][key],
                                     pair["python"]["work"],pair["ts"]["work"])
            records[key]={side:{"work":v["work"],"service":v["meta"],**v["cases"][key]} for side,v in pair.items()}
    assert len(rows)==119
    for name in ("run.json","burst-python.json","burst-ts.json"):
        shutil.copyfile(root/name,out/name)
    counts=Counter(row["classification"] for row in rows.values())
    stage0.save(out/"observations.json",records)
    stage0.save(out/"classification.json",{"counts":dict(counts),"routes":rows})
    attachments = {}
    for side, record in records["POST /events/{event_id}/retry-attachments"].items():
        file = Path(record["work"])/"superagent.db"
        with closing(sqlite3.connect(file.as_uri()+"?mode=ro", uri=True)) as db:
            job = db.execute("SELECT event_id,status,results FROM event_attachment_jobs WHERE event_id=100").fetchone()
            attachments[side] = {"file":str(file), "event_id":job[0], "status":job[1], "results":json.loads(job[2]),
                                 "integrity":db.execute("PRAGMA integrity_check").fetchone()[0]}
    stage0.save(out/"attachment-after-stop.json", attachments)
    text=["# 119 项双端 HTTP 回放","","固定源码和运行时见 [run.json](run.json)。每项在 Python 与 TS 两端都有实际 HTTP。每个写入口独占一份从同一底库复制的临时数据库，先送负例再送合法格式样本。两端共 60 个写方法、59 个读方法，每端各 238 次请求。读入口分别以匿名和合成管理员请求。","",
          "状态优先记录入口缺失、服务错误和行为差异。业务抽查通过要求合法响应有业务内容、预期持久表发生变化、两端的规范化结果与所观察的副作用一致。负例的错误文案及结构另列。协议规定的 405、依赖关闭、空结果单独标记。","",
          "保留原始输入、响应、负例、内容头、两侧数据库行变化及托管文件变化。对比时仅折叠临时根、明确时间字段、动态 UUID 的对应关系及健康接口的实现版本。控制器心跳表不计入业务变更。数据库 JSON 文本做结构化比较。首次 SSE 帧单独采样。固有默认值、权限改进和有意的审计增量由主控裁决。","",
          "|结果|方法与路径数|","|---|---:|"]
    text += [f"|{k}|{v}|" for k,v in counts.items()]
    text += ["","## 各方法与路径","","状态栏按 Python / TS 排列。差异列显示一个位置，[分类数据](classification.json)每类最多列 12 个位置，[逐请求记录](observations.json)保留采样响应和变更行原值。附件重试的停机后状态见[SQLite 回读](attachment-after-stop.json)。","","|方法与路径|合法输入|负例或匿名|独立分类|差异位置或前置条件|","|---|---|---|---|---|"]
    for k,r in sorted(rows.items()):
        diffs=r["positive_differences"]
        note=next((p for field in ("body","status","db","files","mime","headers") for p in diffs.get(field,[])),"") or r["fixture_boundary"] or "—"
        text.append(f"| `{k.replace(' /',' /api/v1/',1) if k!='GET /health' else k}` | {r['python_status']} / {r['ts_status']} | {' / '.join(map(str,r['negative_status']))} | {r['classification']} | {note} |")
    (out/"REPORT.md").write_text("\n".join(text)+"\n","utf-8")
    print("119/119",dict(counts),flush=True)
    return counts
