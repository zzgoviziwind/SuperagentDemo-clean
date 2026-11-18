"""Rebuild the 119-operation audit from frozen routes and independently recorded HTTP results."""
import argparse
from collections import Counter
import json
from pathlib import Path
import re
import sys
from urllib.parse import urlsplit

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import stage0


def read(path):
    return json.loads(path.read_text("utf-8-sig"))


def plans():
    cases, gates = {}, {}
    for line in (HERE / "route-cases.txt").read_text("utf-8").splitlines():
        if not line or line.startswith("#"):
            continue
        if line.startswith("["):
            group, gate = line[1:].split("] ", 1)
            assert group not in gates
            gates[group] = gate
            continue
        route, case = line.split(" | ", 1)
        method, path = route.split()
        key = method + " " + ("" if path == "/health" else "/api/v1") + path
        assert case and key not in cases, key
        cases[key] = {"group":group,"phase3_case":case,"phase4_case":gates[group]}
    return cases, gates


# These summaries describe assertions made in the two final, unmodified dist runs.
# A successful response alone cannot establish the other cases planned for a route.
RESULTS = {
    "GET /health":"两次 TS 启动成功，Python 回切成功",
    "POST /auth/login":"浏览器用合成管理员登录成功；非法令牌、Cookie 生命周期待测",
    "PATCH /settings":"调度与投递开关在实跑中生效；非法类型的 TS 分支待测",
    "POST /identities":"新建 bob 映射，合成钉钉私聊实际路由到 bob",
    "PATCH /projects/{ident}":"临时项目开放其自身根，修复审批生效；非法路径分支待测",
    "GET /tasks":"四身份、同项目筛选和旧 owner 回填符合预期",
    "POST /tasks":"成员创建 repair 并完成；其他种类及无效项目的直接创建待测",
    "GET /tasks/{ident}":"可见任务返回完整记录，非归属及 viewer 返回 404",
    "POST /tasks/{ident}/acceptance":"reply 与 repair 均验收完成，repair 旧 revision 为 409；analysis 待测",
    "POST /approvals/{ident}/decision":"真实修复工具审批先拒错 hash，正确决定获确认，重复决定拒绝；回执丢失的集成分支待测",
    "GET /artifacts/{ident}":"历史件和新 summary 均核对归属，跨归属返回 404",
    "GET /artifacts/{ident}/download":"历史件和新件的下载响应核对任务 ID；TS 下载头的差分待测",
    "GET /tasks/{ident}/export":"四身份读写范围及回切后五件产物相符；导出头差分待测",
    "GET /overview":"四身份计数、活动 ID、待批 ID 与可见任务一致",
    "POST /events":"合成私聊重复注入得到同一事件和任务；回声输入待测",
    "POST /tasks/{task_id}/deliveries":"由归属成员从本次 Worker 摘要建草稿并批准；错误来源绑定待测",
    "GET /tasks/{task_id}/deliveries":"四身份核对同一非空草稿，回切后读到同一账本",
    "POST /deliveries/{draft_id}/decision":"用当前 action_hash 批准成功；错 hash、过期和非归属决定待测",
    "POST /deliveries/{draft_id}/publish":"强杀后自然过租约，未知及成功重放均仅一份回执；关停与未批的 TS 分支待测",
    "POST /deliveries/{draft_id}/reconcile":"浏览器空证据按钮禁用、提交成功、刷新及回切保持；失败结果与后端拒绝空证据待测",
}


def collect():
    cases, gates = plans()
    golden = read(HERE/"stage0-evidence.json")
    source = stage0.verify_source()
    assert source == golden["source"]
    static = read(stage0.ROOT/"docs/rewrite/surface.json")["routes"]
    routes = golden["sample"]["oracle"]["routes"]
    assert len(routes) == len(set(routes)) == 119 and set(routes) == set(static)
    assert set(cases) == set(routes), (set(routes)-set(cases),set(cases)-set(routes))
    patterns = {}
    for key, row in cases.items():
        row.update(source=static[key], observations=[])
        method, path = key.split()
        parts = ["[^/]+" if part.startswith("{") else re.escape(part) for part in path.split("/")]
        patterns[key] = method, re.compile("/".join(parts))

    def record(side, method, url, code, ref, role=None):
        path = urlsplit(url).path
        key = method+" "+path
        if key not in cases:
            matched = [k for k,(m,rx) in patterns.items() if m == method and rx.fullmatch(path)]
            assert len(matched) == 1, (method,url,matched)
            key, = matched
        cases[key]["observations"].append({"side":side,"status":code,"evidence":ref,"role":role})

    for index, call in enumerate(golden["sample"]["oracle"]["http"]):
        record("Python ASGI",call["method"],call["path"],call["status"],
               f"stage0-evidence.json#/sample/oracle/http/{index}")
    uvicorn = read(HERE/"uvicorn-results.json")
    for profile, data in uvicorn["profiles"].items():
        assert len(data["boots"]) == 2
        for index, boot in enumerate(data["boots"]):
            assert boot["pid"] and boot["health"] and boot["old_delivery"] == "unknown"
            paths = [("GET","/health"),("GET","/api/v1/connectors"),("GET","/api/v1/tasks/1"),
                     ("GET","/api/v1/tasks/1/deliveries"),("GET","/api/v1/settings"),
                     ("GET" if index else "POST", "/api/v1/tasks/2" if index else "/api/v1/tasks")]
            for method, path in paths:
                record("Python Uvicorn",method,path,200,f"uvicorn-results.json#/profiles/{profile}/boots/{index}")
    pin = read(HERE/"evidence/final-dist.json")
    assert pin["dist_sha256"] == stage0.sha(stage0.canonical(pin["files"]))
    for name in ("phase1-final-1","phase1-final-2"):
        folder = HERE/"evidence"/name
        prefix = "evidence/"+name+"/"
        run = read(folder/"result.json")
        assert not run["manual_draft"] and run["crash_ui_rollback_passed"]
        assert run["dist_sha256"] == pin["files"]
        assert all(r["meets_visibility_rule"] for r in run["delivery_visibility"].values())
        assert run["repair"]["approval_status"] == "approved"
        assert run["python_rollback"]["artifacts"] == {k:run[k]["artifacts"] for k in ("worker","repair")}
        assert read(folder/"receipt.json") == run["crash"]["receipt"]
        for index, call in enumerate(read(folder/"http.json")):
            side = {"ts":"TS Host","python":"Python 回切"}[call["service"]]
            record(side,call["method"],call["path"],call["status"],prefix+f"http.json#/{index}",call["role"])
        ui = read(folder/"browser.json")
        assert not ui["pageErrors"]
        for index, (path, code) in enumerate(ui["writes"]):
            record("TS 浏览器","POST",path,code,prefix+f"browser.json#/writes/{index}","admin")
        for index, (path, code) in enumerate(ui["httpErrors"]):
            # These are the dashboard's initial reads before login. The browser recorder
            # only stores pathname/status; only these five known GETs can count here.
            assert code == 401 and path.rsplit("/",1)[-1] in {"tasks","projects","connectors","settings","me"}
            record("TS 登录前","GET",path,code,prefix+f"browser.json#/httpErrors/{index}","anonymous")

    counts = Counter()
    for key,row in cases.items():
        sides = {o["side"] for o in row["observations"]}
        functional = bool(sides & {"TS Host","TS 浏览器"})
        brief = key.replace("/api/v1","",1)
        assert functional == (brief in RESULTS), key
        row["final_ts"] = "业务抽查通过" if functional else ("仅匿名 401" if "TS 登录前" in sides else "未实测")
        row["tested_scope"] = RESULTS.get(brief,"待执行本行阶段 3 场景")
        counts[row["final_ts"]] += 1
        for side in sorted(sides):
            counts[side] += 1
        if any(side.startswith("Python") for side in sides):
            counts["Python 任一入口"] += 1
        if functional and any(side.startswith("Python") for side in sides):
            counts["两端有业务观测"] += 1
        row["phase4_status"] = "同库回切有 HTTP 证据；待安装复验" if "Python 回切" in sides else "待安装复验"
    return {"baseline":source,"dist_set_sha256":pin["dist_sha256"],"operation_count":len(cases),
            "counts":dict(counts),"groups":gates,"routes":cases}


def render(data):
    c = data["counts"]
    lines = ["# 阶段 3、4 方法与路径独立验收矩阵","",
             f"冻结 OpenAPI 与静态源码清单逐项相等，共 {data['operation_count']} 项。最终 dist 集合 SHA-256 为 `{data['dist_set_sha256']}`。",
             f"该包两轮实跑中，{c['业务抽查通过']} 项有业务断言通过，{c['仅匿名 401']} 项仅记录到登录前 401，{c['未实测']} 项尚无独立 TS HTTP 实测。Python 侧有 {c['Python 任一入口']} 项观测，其中 {c['两端有业务观测']} 项同时有 TS 业务观测。逐字段差分和干净环境安装均按下表继续验收。","",
             "Python 列汇总阶段 0 的 44 个 ASGI 请求、默认与 WP 生命周期以及本轮同库回切。TS 列只使用最终包的两轮证据。状态码列合并重复请求；角色、原始请求序号和证据位置见 [机器清单](route-matrix.json)。浏览器页面加载和源码中已有测试的存在均不计为该路由业务通过。","",
             "阶段 4 每组标题下给出包级复验条件，各行另列回切证据。安装包、干净用户环境、备份恢复需要单独实跑。旧 Python 全量读取按已确认的 TS 归属规则裁决。",""]
    for group, gate in data["groups"].items():
        lines.extend([f"## {group}","",f"阶段 4 复验要求：{gate}","",
                      "|冻结方法与路径|阶段 3 输入及判据|Python 状态码|最终 TS 状态码|已验证与待测范围|阶段 4 进度|",
                      "|---|---|---|---|---|---|"])
        for key,row in data["routes"].items():
            if row["group"] != group:
                continue
            def codes(prefix):
                return "/".join(map(str,sorted({o["status"] for o in row["observations"] if o["side"].startswith(prefix)}))) or "—"
            lines.append(f"| `{key}` | {row['phase3_case']} | {codes('Python')} | {codes('TS')} | {row['final_ts']}。{row['tested_scope']} | {row['phase4_status']} |")
        lines.append("")
    return "\n".join(lines)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check",action="store_true")
    args = parser.parse_args()
    matrix = collect()
    outputs = {"route-matrix.json":json.dumps(matrix,ensure_ascii=False,indent=2)+"\n","ROUTES-119.md":render(matrix)}
    for filename, content in outputs.items():
        path = HERE/filename
        if args.check:
            assert path.read_text("utf-8") == content, filename
        else:
            path.write_text(content, encoding="utf-8",newline="\n")
    print(json.dumps(matrix["counts"],ensure_ascii=False))
