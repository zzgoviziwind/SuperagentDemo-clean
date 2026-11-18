"""Run the actual Windows lifecycle against independently built synthetic releases."""
import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import zipfile
from contextlib import ExitStack

HERE = Path(__file__).resolve().parent
DEPLOY = HERE.parents[2] / "deploy/windows-ts"


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--build-node", type=Path)
    parser.add_argument("--web-modules", type=Path)
    parser.add_argument("--kits", type=Path)
    parser.add_argument("--ts-kits", type=Path)
    parser.add_argument("--handoff-kit",type=Path)
    parser.add_argument("--short-path",action="store_true")
    parser.add_argument("--drive-path",action="store_true")
    args = parser.parse_args()
    if not (args.handoff_kit or args.ts_kits or args.kits or (args.build_node and args.web_modules)):
        parser.error("supply --build-node and --web-modules, or --kits")
    shell = Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"
    with ExitStack() as stack:
        scratch = stack.enter_context(tempfile.TemporaryDirectory(prefix="install-", dir=HERE))
        if args.drive_path:
            # A temporary DOS name for this exact directory. Remove only our own mapping.
            subst = Path(os.environ["SystemRoot"])/"System32/subst.exe"
            for letter in "ZYXWVUTSRQP":
                drive = letter+":"
                if Path(drive+"/").exists():
                    continue
                if subprocess.run([subst,drive,scratch],capture_output=True).returncode == 0:
                    assert Path(drive+"/").samefile(scratch)
                    def unmap():
                        if Path(drive+"/").samefile(scratch_original):
                            subprocess.run([subst,drive,"/D"],check=True,capture_output=True)
                    scratch_original = scratch
                    stack.callback(unmap)
                    scratch = drive+"\\"
                    break
            else:
                raise RuntimeError("No free temporary drive for the review directory")
        if args.short_path:
            short = ctypes.create_unicode_buffer(1024)
            if not ctypes.windll.kernel32.GetShortPathNameW(scratch,short,len(short)):
                raise OSError("Cannot resolve the NTFS short spelling of this test directory")
            scratch = short.value
        env = {k: os.environ[k] for k in ("SystemRoot", "SystemDrive", "WINDIR", "ComSpec", "PATH",
               "PATHEXT", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "PROCESSOR_ARCHITECTURE")
               if k in os.environ}
        env.update({k: scratch for k in ("TEMP", "TMP", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA")})
        script = DEPLOY / ("Test-TSLifecycle.ps1" if args.ts_kits else "Test-Lifecycle.ps1")
        if args.handoff_kit:
            script = DEPLOY / "Test-InstalledServer.ps1"
        cmd = [str(shell), "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
               str(script), "-EvidenceDirectory", scratch]
        if args.handoff_kit:
            cmd += ["-Installer",str(args.handoff_kit.resolve())]
        elif args.ts_kits:
            for parameter, tag in [("-FirstInstaller","a"),("-UpgradeInstaller","b"),("-FailingInstaller","failed-start")]:
                cmd += [parameter, str((args.ts_kits / ("SuperAgent-stage4-ts-"+tag+"-win-x64.exe")).resolve())]
        elif args.kits:
            cmd += ["-PackageDirectory", str(args.kits.resolve())]
        else:
            cmd += ["-NodeDirectory", str(args.build_node.resolve().parent), "-NodeSha256", sha(args.build_node),
                    "-WebNodeModules", str(args.web_modules.resolve())]
        output = subprocess.run(cmd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        lines = output.stdout.decode("utf-8", errors="replace").splitlines()
        assertions = [line for line in lines if line.startswith("PASS ")]
        kits = (args.handoff_kit.parent if args.handoff_kit else None) or args.ts_kits or args.kits or next(Path(scratch).glob("superagent-test-*/packages"), Path(scratch))
        artifacts = {}
        for archive in sorted(kits.glob("*.zip")):
            with zipfile.ZipFile(archive) as kit:
                artifacts[archive.name] = {"zip": sha(archive), "exe": sha(archive.with_suffix(".exe")),
                    "manager": hashlib.sha256(kit.read("SuperAgent.ps1")).hexdigest(),
                    "fixture_server": hashlib.sha256(kit.read("payload/apps/server/dist/main.js")).hexdigest()}
        evidence = {"exit": output.returncode, "mode": "reuse" if args.kits else "fresh",
                    "assertions": assertions, "kits": artifacts, "test_script": sha(script),
                    "current_manager": sha(DEPLOY / "SuperAgent.ps1")}
        name = "installer-reuse.json" if args.kits else "installer-build.json"
        if args.ts_kits:
            name = "installer-ts-short.json" if args.short_path else "installer-ts.json"
            if args.drive_path:
                name = "installer-ts-drive.json"
            evidence["mode"] = "installed TS"
        if args.handoff_kit:
            name = "installer-handoff.json"
            evidence["mode"] = "handoff installer at long path"
        if output.returncode:
            evidence["diagnostic"] = "\n".join(lines[-20:]).replace(scratch,"<scratch>")
            if args.ts_kits:
                evidence["backend_stderr"] = {
                    p.parent.name: p.read_bytes()[-2400:].decode("utf-8",errors="replace").replace(scratch,"<scratch>")
                    for p in Path(scratch).glob("ts-life-*/Test */logs/*/stderr.log") if p.stat().st_size}
        if (HERE/name).exists() and args.drive_path:
            name = "installer-ts-drive-repeat.json"
        (HERE / name).write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(evidence, indent=2), flush=True)
        if output.returncode or len(assertions) != (3 if args.handoff_kit else 6 if args.ts_kits else 4):
            raise RuntimeError("\n".join(lines[-19:]))


if __name__ == "__main__":
    main()
