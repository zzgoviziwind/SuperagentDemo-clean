"""Bound inputs for the frozen method/path inventory. All identifiers belong to replay_fixture."""
from dataclasses import dataclass
from pathlib import Path

FID = "10000000-0000-4000-8000-000000000001"
IDENTITY = {"source":"redmine","actor_id":"9","user_id":"admin","permissions":["request"],"project_ids":[1]}


@dataclass
class Case:
    path: str
    body: object = None
    effects: tuple = ()
    negative: object = None
    negative_path: str = ""
    permission_negative: bool = False
    boundary: str = ""


def write_cases(work, ids):
    repo = str(work/"含空格 项目")
    op = {"request_key":"fresh-operation","action":"create","project_id":1,"title":"桥接任务","content":"仅合成输入","kind":"reply"}
    msg = {"content":"追加合成说明","expected_state_version":1}
    ev = {"source":"redmine","external_id":"new-message","actor_id":"9","project_external_id":"7","issue_id":"42",
          "event_type":"issue.comment","content":"新合成消息","metadata":{"redmine_endpoint":"https://fixture.invalid"}}
    # Keys use the abbreviated frozen path. Values have concrete paths, valid bodies, required tables
    # and an invalid body or ID. A missing valid-state prerequisite is reported as such.
    specs = {}
    def add(key,path,body=None,tables="",negative=None,badpath="",guard=False,boundary=""):
        specs[key] = Case(path,body,tuple(tables.split()),negative,badpath,guard,boundary)
    add("POST /auth/login","/auth/login",{"token":"fixture-admin"},negative={"token":"invalid-synthetic"})
    add("POST /auth/logout","/auth/logout",{},boundary="cookie",negative="bad-origin")
    add("PATCH /settings","/settings",{"watchdog_interval_seconds":180},"governance_settings",{"scheduler_enabled":"yes"})
    add("POST /identities","/identities",dict(IDENTITY,actor_id="new-actor"),"governance_identities",{"actor_id":""})
    add("PATCH /identities","/identities",dict(IDENTITY,enabled=False),"governance_identities",{"source":"invalid"})
    add("DELETE /identities/{identity_id}","/identities/1",tables="governance_identities",badpath="/identities/999999")
    add("PATCH /budgets/{account_id}","/budgets/global",{"hard_limit_micros":765,"currency":"USD"},"governance_budget_accounts",{"hard_limit_micros":-1})
    add("POST /budget-reservations/{reservation_id}/reconcile","/budget-reservations/1/reconcile",{"actual_micros":15,"evidence":"合成收据"},"governance_budget_reservations governance_budget_accounts",{"actual_micros":-1})
    add("POST /projects","/projects",{"name":"新项目","repo_path":repo},"projects",{"name":"","repo_path":""})
    add("PATCH /projects/{ident}","/projects/2",{"name":"重命名项目"},"projects",{"allowed_paths":42})
    add("DELETE /projects/{ident}","/projects/2",tables="projects",badpath="/projects/999999")
    add("POST /project-workspace/select-directory","/project-workspace/select-directory",{"path":repo},negative={"path":repo+"/absent"},boundary="native-picker-fixture")
    add("POST /agents/local/connect","/agents/local/connect",{"agent_id":"codex","use_existing_login":True},negative={"agent_id":"invalid","use_existing_login":False},boundary="no-account")
    add("POST /tasks","/tasks",{"title":"合成请求","goal":"离线核对","project_id":1,"kind":"reply"},"tasks events",{"project_id":"invalid"})
    add("POST /tasks/{ident}/project","/tasks/10/project",{"project_id":2,"reason":"合成改绑","expected_state_version":1},"tasks events",{"project_id":2,"reason":"样本","expected_state_version":999})
    add("POST /tasks/{ident}/messages","/tasks/10/messages",msg,"events",dict(msg,expected_state_version=999))
    add("POST /tasks/{ident}/controls","/tasks/11/controls",{"action":"pause","expected_state_version":1},"tasks events",{"action":"bogus"})
    add("POST /tasks/{ident}/reconcile","/tasks/12/reconcile",{"outcome":"stopped","evidence":"已核验本机停止","expected_state_version":1},"tasks",{"outcome":"bogus","evidence":"","expected_state_version":1})
    add("POST /tasks/{ident}/acceptance","/tasks/13/acceptance",{"accepted":False,"revision":1,"comment":"补充验证"},"tasks events",{"accepted":False,"revision":22})
    add("POST /approvals/{ident}/decision","/approvals/1/decision",{"decision":"reject","action_hash":ids["tool_hash"]},negative={"decision":"reject","action_hash":"wrong"},boundary="historical-no-live-worker")
    add("POST /operations/daemon/poll","/operations/daemon/poll",{"boot_id":"replay-offline-boot-001"},"execution_nonces",{"boot_id":"x"})
    add("POST /operations/daemon/exchange","/operations/daemon/exchange",{"events":[]},"execution_nonces",{"events":[],"invalid_field":1})
    add("PATCH /operations/projects/{project_id}/execution-node","/operations/projects/2/execution-node",{"node_id":"sample-node"},"project_execution_nodes",{"node_id":"missing"})
    add("POST /operations/watchdog/tasks/{task_id}/run","/operations/watchdog/tasks/10/run",badpath="/operations/watchdog/tasks/999999/run",boundary="no-model")
    add("POST /operations/watchdog/{run_id}/messages","/operations/watchdog/sample-run/messages",{"content":"已核验","reconcile_unknown":True},"watchdog_runs events",{"content":""})
    add("PUT /event-rules","/event-rules",{"items":[{"name":"夜间静默","action":"quiet","project_id":1}]},"governance_settings",{"items":[{"action":"unknown"}]})
    add("POST /connectors/{name}/{action}","/connectors/dingtalk/stop",badpath="/connectors/invalid/stay",boundary="stop-disabled")
    add("POST /events","/events",ev,"events",{"source":"invalid"})
    add("POST /events/{event_id}/retry-routing","/events/100/retry-routing",badpath="/events/999999/retry-routing",boundary="routed-idempotent")
    add("POST /events/{event_id}/retry-attachments","/events/100/retry-attachments",tables="event_attachment_jobs",badpath="/events/999999/retry-attachments")
    add("POST /tasks/{task_id}/deliveries","/tasks/10/deliveries",{"event_id":100,"content":"合成渠道草稿"},"reply_drafts approvals",{"event_id":100,"content":""})
    add("POST /deliveries/{draft_id}/decision",f"/deliveries/{ids['draft']}/decision",{"decision":"approve","action_hash":ids["hash"]},"approvals",{"decision":"approve","action_hash":"wrong"})
    add("POST /deliveries/{draft_id}/publish","/deliveries/1/publish",badpath="/deliveries/999999/publish",boundary="existing-unknown-ledger")
    add("POST /deliveries/{draft_id}/reconcile","/deliveries/1/reconcile",{"outcome":"succeeded","evidence":"独立假收件单"},"delivery_records",{"outcome":"succeeded","evidence":""})
    add("POST /subscriptions","/subscriptions",{"project_id":1,"task_id":10,"source":"redmine","thread_id":"issue:77"},"worker_subscriptions",{"project_id":1})
    add("DELETE /subscriptions/{subscription_id}","/subscriptions/1",tables="worker_subscriptions",badpath="/subscriptions/999999")
    add("POST /event-groups/triage","/event-groups/triage",{"action":"close","event_ids":[101]},"events",{"action":"close","event_ids":[]})
    add("POST /event-groups/{ident}/rename","/event-groups/10/rename",{"title":"新合成标题","expected_state_version":1},"tasks events",{"title":"新标题","expected_state_version":999})
    add("POST /event-groups/{ident}/delegations","/event-groups/10/delegations",{"goal":"补充合成证据","request_key":"delegate-1","expected_state_version":1},"tasks events",{"goal":""})
    add("POST /event-groups/{ident}/events/{event_id}/resolution","/event-groups/10/events/100/resolution",{"status":"resolved","evidence":"合成验证","expected_state_version":1},"events tasks",{"status":"invalid"})
    add("POST /event-groups/{ident}/following/{subscription_id}","/event-groups/10/following/1",{"enabled":False,"expected_state_version":1},"worker_subscriptions",{"enabled":True,"expected_state_version":999})
    add("POST /event-groups/{ident}/sync-own-dingtalk","/event-groups/10/sync-own-dingtalk",guard=True,boundary="no-dingtalk-account")
    add("POST /decisions","/decisions",{"project_id":1,"task_id":10,"kind":"constraint","content":"合成约束"},"decisions",{"project_id":0})
    add("POST /decisions/{decision_id}/revoke","/decisions/1/revoke",{"reason":"合成撤销"},"decisions",{"reason":""})
    add("POST /routing/assessments","/routing/assessments",{"event_ids":[107,108]},negative={"event_ids":[107,107]},boundary="no-model")
    add("POST /routing/schedule","/routing/schedule",{"event_id":101},negative={"event_id":"invalid"})
    add("POST /routing/jobs/{event_id}/correction","/routing/jobs/103/correction",{"decision":{"action":"ignore","reason":"样本"},"evidence":"人工核验"},"event_routing_messages",{"evidence":""})
    add("POST /sessions/{ident}/messages","/sessions/worker:10/messages",msg,"events",dict(msg,expected_state_version=999))
    add("POST /sessions/{ident}/reconcile","/sessions/router:1/reconcile",{"evidence":"已停止","expected_state_version":1},"router_sessions",{"evidence":""})
    add("POST /sessions/{ident}/handoff","/sessions/worker:10/handoff",tables="events",badpath="/sessions/worker:999999/handoff")
    add("POST /sessions/{ident}/coordination","/sessions/worker:10/coordination",{"target_task_id":11,"event_id":100,"evidence":"合成请求","expected_state_version":1,"request_key":"request-b"},"events",{"evidence":""})
    add("POST /sessions/{ident}/coordination/{request_id}/apply","/sessions/worker:11/coordination/105/apply",tables="events",badpath="/sessions/worker:11/coordination/999999/apply")
    add("POST /conversation-providers/bridge/operations","/conversation-providers/bridge/operations",op,"conversation_bridge_operations tasks",dict(op,action="incorrect"))
    add("POST /conversation-providers/mcp","/conversation-providers/mcp",{"jsonrpc":"2.0","id":7,"method":"tools/list"},negative={"jsonrpc":"2.0","id":8,"method":"not_a_method"})
    add("DELETE /conversation-providers/mcp","/conversation-providers/mcp",guard=True,boundary="contract-405")
    add("POST /field-intake/records","/field-intake/records",{"project_id":1,"title":"合成现场记录","notes":"需求：登记样本"},"field_records field_candidates",{"project_id":1,"title":""})
    add("POST /field-intake/candidates/{ident}/decision","/field-intake/candidates/1/decision",{"action":"dismiss"},"field_candidates",{"action":"invalid"})
    add("POST /field-intake/analysis/{ident}/implement","/field-intake/analysis/14/implement",{"scope":"实施合成要求","acceptance_criteria":"比对样本","expected_state_version":1},"tasks events",{"scope":""})
    add("POST /field-intake/media-jobs","/field-intake/media-jobs","multipart-wav",negative={"title":""},boundary="optional-media-off")
    add("POST /field-intake/media-jobs/{ident}/retry","/field-intake/media-jobs/failed-media/retry",badpath="/field-intake/media-jobs/absent/retry",boundary="optional-media-off")
    return specs


def read_case(route):
    path = route.split(" ",1)[1]
    specific = {"/field-intake/records/{ident}":FID,"/sessions/{ident}":"worker:10",
                "/conversation-providers/bridge/sessions/{ident}":"worker:10",
                "/artifacts/{ident}":"1"}
    for part, value in specific.items():
        if path.startswith(part):
            path = path.replace("{ident}",value)
    for name,value in {"ident":"10","task_id":"10","event_id":"100","attempt_id":"sample-attempt","request_key":"existing-operation","segment_id":"s1","number":"1"}.items():
        path = path.replace("{"+name+"}",value)
    if path.endswith("dingtalk/groups"): path += "?q=fixture"
    if path.endswith("dingtalk/group"): path += "?chat_id=fixture-group"
    if path == "/sessions/worker:10/coordination": path = "/sessions/worker:11/coordination"
    return Case(path, boundary="contract-405" if path.endswith("/mcp") else "")
