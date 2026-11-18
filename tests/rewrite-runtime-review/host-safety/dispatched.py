"""Distinguish a decision already sent to a worker from an unanswered worker request."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import zipfile

HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE))
from prepared import PIN, rows, state

node=Path(sys.argv[1]).resolve()
with tempfile.TemporaryDirectory(prefix="approval-",dir=HERE) as scratch:
    work=Path(scratch)
    env={k:os.environ[k] for k in ("SystemRoot","SystemDrive","WINDIR","ComSpec","PATH","PATHEXT") if k in os.environ}
    env.update({k:scratch for k in ("TEMP","TMP","HOME","USERPROFILE","LOCALAPPDATA","APPDATA","SUPERAGENT_DATA_DIR")})
    args=[node,HERE/"host.mjs"]
    subprocess.run([*args,"build",work],cwd=work,env=env,check=True,capture_output=True)
    crash=subprocess.run([*args,"crash",work],cwd=work,env=env,capture_output=True)
    assert crash.returncode==73,crash.stderr
    db=work/"superagent.db"
    before=state(db)
    assert before==["dispatching",0,"waiting_approval","dispatching"]
    assert rows(db,"SELECT content FROM events WHERE event_type='approval_decision'")==[("approve",)]
    with zipfile.ZipFile(HERE/"prepare-candidate.zip") as package:
        main=package.read("main.js")
        assert hashlib.sha256(main).hexdigest()==PIN
        (work/"main.js").write_bytes(main)
    env.update(NODE_OPTIONS='--require="'+(HERE/"prepare-guard.cjs").as_posix()+'"',REVIEW_SIDE_EFFECTS=str(work/"prohibited"))
    cli=subprocess.run([node,work/"main.js","--prepare-python-rollback"],cwd=work,env=env,capture_output=True,check=True)
    after=state(db)
    assert not (work/"prohibited").exists()
    result={"main_sha256":PIN,"before":before,"after":after,"decision_events":1,"ambiguous_response_events":
        rows(db,"SELECT COUNT(*) FROM events WHERE event_type='approval_response_unknown'")[0][0],
        "prepare_json_recovery":json.loads(cli.stdout)["recovery"],"pass":after==["unknown",1,"unknown","unknown"]}
    print(json.dumps(result))
    (HERE/"dispatched.json").write_text(json.dumps(result,indent=2)+"\n",encoding="utf-8")
    sys.exit(int(not result["pass"]))
