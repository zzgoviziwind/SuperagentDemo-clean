"""Offline server reports presence of test-only control-plane credentials."""

import json
import os
import sys

for line in sys.stdin:
    request = json.loads(line)
    if "id" not in request:
        continue
    result = {}
    if request.get("method") == "thread/start":
        result = {"thread": {"id": "offline", "control_credentials_inherited": {
            name: os.environ.get(name) == expected for name, expected in {
                "SUPERAGENT_API_TOKEN": "offline-admin-sentinel",
                "SUPERAGENT_USERS_JSON": "offline-users-sentinel",
                "HLZJ_REDMINE_API_KEY": "offline-redmine-sentinel",
            }.items()
        }}}
    print(json.dumps({"id": request["id"], "result": result}), flush=True)
