"""Verify the coverage and provenance of saved evidence without starting a service."""
from collections import Counter
import argparse
import json
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import stage0
import replay_bundle


def read(path):
    return json.loads(path.read_text("utf-8"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, help="Archive for one candidate run, as printed by replay119.")
    parser.add_argument("--entry-sha256", help="Independently supplied expected main.js SHA-256.")
    args = parser.parse_args()
    if args.evidence:
        archive = args.evidence.resolve(strict=True)
        if archive.parent.parent != replay_bundle.ARCHIVE:
            parser.error("Expected evidence/candidates/<entry-sha>/<run>")
        folder, load_dir, recovery_dir = (archive/name for name in ("serial","load","recovery"))
        pin = read(folder/"run.json")["pin"]
        replay_bundle.expected_hash(pin["files"]["main.js"], archive.parent.name, "archive")
    else:
        pin = read(HERE/"evidence/replay-dist.json")
        folder = HERE/"evidence"/("http119-" + pin["files"]["main.js"][:12])
        load_dir = recovery_dir = folder
    if args.entry_sha256:
        replay_bundle.expected_hash(pin["files"]["main.js"],args.entry_sha256,"main.js")
    run = read(folder/"run.json")
    assert run["pin"] == pin and run["source"] == stage0.verify_source()
    assert stage0.sha(stage0.canonical(pin["files"])) == pin["dist_sha256"]
    canonical = read(HERE/"stage0-evidence.json")["sample"]["oracle"]["routes"]
    expected = {r.replace("/api/v1", "", 1) for r in canonical}
    single = read(folder/"observations.json")
    classification = read(folder/"classification.json")
    load = read(load_dir/"load119.json")
    assert set(single) == set(load["routes"]) == set(classification["routes"]) == expected
    assert len(expected) == 119 and sum(k.startswith("GET ") for k in expected) == 59
    assert dict(Counter(r["classification"] for r in classification["routes"].values())) == classification["counts"]
    assert load["dist_sha256"] == pin["dist_sha256"] and load["seed_sha256"] == run["seed_sha256"]
    for side in ("python", "ts"):
        codes = Counter()
        for key in sorted(expected):
            case = single[key][side]
            obs = case["observations"]
            assert case["service"]["integrity"] == "ok"
            if side == "ts":
                assert case["service"]["entry_sha256"] == pin["files"]["main.js"]
            assert [item["label"] for item in obs] == ["anonymous" if key.startswith("GET ") else "negative", "positive"]
            assert all(item["response"]["status"] >= 100 and item["receipts"] == 0 for item in obs)
            assert all("db" in item and "files" in item for item in obs)
            concurrent = load["routes"][key][side]
            assert concurrent["receipt_files"] == 0 and len(concurrent["replies"]) == 4
            for res in concurrent["replies"]:
                assert res["status"] >= 100 and res["milliseconds"] >= 0
                if "body" in res:
                    assert res["body_sha256"] == stage0.sha(stage0.canonical(res["body"]))
                codes[str(res["status"])] += 1
        assert codes == load["metrics"][side]["statuses"]
        burst = read(folder/("burst-" + side + ".json"))
        assert burst["passed"] and burst["duplicates"] == 11 and burst["changed_tables"]["tasks"] == 1
        assert burst["external_receipts"] == 0 and burst["integrity"] == "ok"
        if "observations" in burst:
            assert Counter(item["route"] for item in burst["observations"]) == {
                "POST /events":12, "GET /tasks":12, "GET /overview":12}
            assert all(item["response"]["status"] == 200 and "body" in item["response"] for item in burst["observations"])
    recovery = read(recovery_dir/"recovery.json")
    if args.evidence:
        assert recovery["dist_sha256"] == pin["dist_sha256"] and recovery["seed_sha256"] == run["seed_sha256"]
    assert recovery["entry_sha256"] == pin["files"]["main.js"]
    assert recovery["rollback"]["frozen"] == (recovery["rollback"]["states"] == recovery["rollback"]["expected"])
    assert recovery["timer"]["manual_run_calls"] == 0 and recovery["python_readback"]["integrity"] == "ok"
    jobs = read(folder/"attachment-after-stop.json")
    assert set(jobs) == {"python", "ts"} and all(job["event_id"] == 100 and job["integrity"] == "ok" for job in jobs.values())
    if args.evidence and (archive/"postcheck").is_dir():
        post = read(archive/"postcheck/postcheck.json")
        assert post["entry_sha256"] == pin["files"]["main.js"] and post["dist_sha256"] == pin["dist_sha256"]
        assert post["residual"]["cli_exit"] != 0 and post["residual"]["bridge_state"] == "pending"
        assert post["residual"]["success_output"] is False and post["repaired"]["cli_exit"] == 0
        assert post["repaired"]["bridge_state"] == "unknown" and post["ts_db_changes"] == {} and post["receipts"] == 0
        for name in ("poll","exchange"):
            assert post["ts"][name]["status"] == 503 and post["ts"][name]["body"]["execution_host"] == "python"
            assert post["python"][name]["status"] == 200
        assert post["python"]["exchange"]["body"]["accepted"] and len(post["python_db_changes"]["execution_nonces"]) == 2
    print("119 paired routes; 476 serial + 952 concurrent + 72 mixed HTTP responses verified.")
    print("Rollback marked frozen:", recovery["rollback"]["frozen"])


if __name__ == "__main__":
    main()
