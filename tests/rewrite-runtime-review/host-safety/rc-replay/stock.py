"""Read the prepared file through frozen stock Python after its real recovery segment."""
import json
import os
from pathlib import Path
import platform
import sys
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
work = Path(sys.argv[1]).resolve()
assert HERE in work.parents
path = work / "superagent.db"
source = HERE.parents[3] / ".rewrite-oracle"
os.environ.update(SUPERAGENT_STATE_ROOT=str(work), SUPERAGENT_DATABASE_URL="sqlite:///"+path.as_posix(),
                  SUPERAGENT_SERVICE_MODE="preview")
assert "SUPERAGENT_EXECUTION_MODE" not in os.environ and "SUPERAGENT_LEDGER_MODE" not in os.environ
if os.name == "nt":
    # Avoid CPython's fallback 'ver' subprocess when obtaining platform details.
    version = ".".join(map(str, sys.getwindowsversion().platform_version))
    with patch.object(platform, "_syscmd_ver", return_value=("Windows", "", version)):
        platform.uname()

def offline(event, args):
    if event in {"socket.connect","socket.getaddrinfo","socket.bind","subprocess.Popen","os.system","os.startfile"}:
        raise RuntimeError("Unexpected external operation: "+event)

sys.addaudithook(offline)
sys.path.insert(0,str(source))
from superagent import main
from superagent.core import db
from superagent.core.conversation_providers import BridgeOperation

assert Path(main.__file__).resolve() == source/"superagent/main.py"
assert Path(db.engine.url.database).resolve().samefile(path)

class Recovered(Exception):
    pass

async def stop_before_services():
    raise Recovered()

with patch.object(main.operations,"start",stop_before_services):
    startup = main.lifespan(main.app).__aenter__()
    try:
        startup.send(None)
    except Recovered:
        pass
    else:
        raise AssertionError("Stock startup suspended before the recovery checkpoint")
    finally:
        startup.close()

with db.Session() as s:
    tool = next(a for a in s.query(db.Approval) if "method" in a.action)
    bridge = s.query(BridgeOperation).filter_by(actor_id="admin",request_key="recovery-sample").one()
    print(json.dumps({"approval":tool.status,"bridge":bridge.status,"attempt":s.query(db.ExecutionAttempt).one().status,
                      "task_unknown":bool(s.get(db.Task,1).outcome_unknown),"read_file_id":str(path.stat().st_ino)}))
