"""Execute the unmodified independent process-lifecycle suite within the assigned directory."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("nodes", nargs=2, type=Path)
    nodes = parser.parse_args().nodes
    installed = ROOT/"node_modules/@superagent/windows-job"
    if not installed.is_dir():
        installed = ROOT/"packages/windows-job"
    native = installed/"bin/windows-job-x64.exe"
    assert sha(native) == sha(ROOT/"packages/windows-job/bin/windows-job-x64.exe")
    assert sha(native) == "425cd705d1fb3b5e2d47aba00c50145a890a9f664861a0274f2682ac60efe1bc"
    expected_versions = ["v22.","v24."]
    results = []
    for node, wanted in zip(nodes, expected_versions, strict=True):
        version = subprocess.check_output([node,"--version"], text=True).strip()
        assert version.startswith(wanted)
        with tempfile.TemporaryDirectory(dir=HERE,prefix="stage0-native-") as temp:
            root = Path(temp)
            package = root/"node_modules/@superagent/windows-job"
            for name in ("package.json","index.mjs","index.d.ts","bin/windows-job-x64.exe"):
                target = package/name
                target.parent.mkdir(parents=True,exist_ok=True)
                shutil.copyfile(installed/name,target)
                assert sha(target) == sha(installed/name)
            for rel in ("tests/rewrite-runtime-review","packages/runtime"):
                source = ROOT/rel
                dest = root/rel
                for file in source.rglob("*"):
                    if (file.is_file() and not {"node_modules","__pycache__"}.intersection(file.relative_to(source).parts)
                            and file.suffix in {".py",".mjs",".cjs",".json",".ts"}):
                        target = dest/file.relative_to(source)
                        target.parent.mkdir(parents=True,exist_ok=True)
                        shutil.copyfile(file,target)
                        assert sha(file) == sha(target)
            script = Path("tests/rewrite-runtime-review/candidate_checks.py")
            env = {k:os.environ[k] for k in ("SYSTEMROOT","WINDIR","SYSTEMDRIVE","PROCESSOR_ARCHITECTURE")
                   if k in os.environ}
            env.update(REVIEW_NODE=str(node),TEMP=str(root),TMP=str(root),USERPROFILE=str(root),HOME=str(root))
            completed = subprocess.run([sys.executable,"-I","-B",str(script)],cwd=root,env=env,
                stdout=subprocess.PIPE,stderr=subprocess.STDOUT,encoding="utf-8",errors="replace",timeout=220)
            log = HERE/("runtime-"+version+".log")
            log.write_text(completed.stdout,"utf-8")
            mixed = {mode:bool(re.search("test_mixed_tree_"+mode+r"\b[^\n]*\.\.\. ok",completed.stdout))
                     for mode in ("normal","forced","owner_exit")}
            result = {"node":version,"exit":completed.returncode,"mixed":mixed,"log":log.name,
                      "suite_sha256":sha(root/script),"native_exe_sha256":sha(native),
                      "cleanup_error_mentions":completed.stdout.count("fixture cleanup incomplete"),
                      "failed_tests":len(re.findall(r"^(?:FAIL|ERROR): test_",completed.stdout,re.M))}
            results.append(result)
            print(json.dumps(result),flush=True)
    (HERE/"windows-runtime-results.json").write_text(json.dumps(results,indent=2),"utf-8")
    return int(any(r["exit"] or not all(r["mixed"].values()) for r in results))


if __name__ == "__main__":
    raise SystemExit(main())
