"""Export uncapped field paths and paired normalized values for the field-difference category."""
import argparse
import json
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from replay_compare import views
from stage0 import sha

MISSING = object()


def walk(left, right, path=""):
    if isinstance(left, dict) and isinstance(right, dict):
        for key in sorted(left.keys() | right.keys()):
            token = key.replace("~","~0").replace("/","~1")
            yield from walk(left.get(key,MISSING), right.get(key,MISSING), path+"/"+token)
    elif isinstance(left, list) and isinstance(right, list):
        for index in range(max(len(left),len(right))):
            yield from walk(left[index] if index < len(left) else MISSING,
                            right[index] if index < len(right) else MISSING, path+"/"+str(index))
    elif type(left) != type(right) or left != right:
        row = {"path":path}
        if left is not MISSING:
            row["python"] = left
        if right is not MISSING:
            row["ts"] = right
        yield row


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    output = args.output.resolve()
    if not output.is_relative_to(HERE):
        parser.error("Output must be inside the acceptance directory")
    raw = (args.evidence/"observations.json").read_bytes()
    classified = (args.evidence/"classification.json").read_bytes()
    observations = json.loads(raw)
    routes = {}
    for key, row in json.loads(classified)["routes"].items():
        if row["classification"] != "字段或持久记录差异":
            continue
        pair = observations[key]
        positive = [views(pair[side]["observations"][1],pair[side]["work"]) for side in ("python","ts")]
        routes[key] = list(walk(*positive))
    pin = json.loads((args.evidence/"run.json").read_bytes())["pin"]
    report = {"entry_sha256":pin["files"]["main.js"], "dist_sha256":pin["dist_sha256"],
              "observations_sha256":sha(raw), "classification_sha256":sha(classified), "routes":routes}
    with output.open("x", encoding="utf-8", newline="\n") as dest:
        json.dump(report,dest,ensure_ascii=False,indent=2)
        dest.write("\n")
    print(len(routes),"routes,",sum(map(len,routes.values())),"field differences")


if __name__ == "__main__":
    main()
