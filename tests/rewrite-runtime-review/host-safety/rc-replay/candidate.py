"""Copy the input for one run and fingerprint the exact files that will execute."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import shutil
import zipfile


def sha(data):
    return hashlib.sha256(data).hexdigest()


def file_sha(path):
    with path.open("rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


def tree(path):
    return {p.relative_to(path).as_posix(): file_sha(p) for p in sorted(path.rglob("*")) if p.is_file()}


def canonical_digest(files):
    return sha(json.dumps(files, separators=(",", ":"), sort_keys=True, ensure_ascii=False).encode())


def materialize(source, work, local_node, expected_zip):
    source = source.resolve(strict=True)
    server = work / "server"
    dist = server / "dist"
    dist.mkdir(parents=True)
    node = local_node
    info = {"source": str(source), "dependency_source": "workspace", "manifest_version": None}
    if source.is_dir():
        if expected_zip:
            raise ValueError("ZIP digest supplied for a directory")
        original = tree(source)
        shutil.copytree(source, dist, dirs_exist_ok=True)
        if tree(dist) != original or tree(source) != original:
            raise ValueError("dist changed during capture")
    else:
        # Hash and read the same opened archive. Do not extract UI, installer scripts or business data.
        with source.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
            if expected_zip and digest != expected_zip.lower():
                raise ValueError("ZIP fingerprint mismatch")
            info["zip_sha256"] = digest
            stream.seek(0)
            with zipfile.ZipFile(stream) as archive:
                full = "payload/apps/server/dist/main.js" in archive.namelist()
                prefix = "payload/apps/server/" if full else ""
                manifest = {}
                if full:
                    release = json.loads(archive.read("release.json").decode("utf-8-sig"))
                    manifest = {"payload/" + f["path"]: f["sha256"].lower() for f in release["files"]}
                    info.update(manifest_version=release["version"], dependency_source="package", manifest_sha256=sha(archive.read("release.json")))
                    node = work / "node.exe"
                elif "main.js" not in archive.namelist():
                    raise ValueError("expected release ZIP or ZIP with main.js at dist root")
                seen = set()
                for member in archive.infolist():
                    name = member.filename
                    if member.is_dir():
                        continue
                    part = PurePosixPath(name)
                    if part.is_absolute() or ".." in part.parts or "\\" in name or ":" in name:
                        raise ValueError("invalid archive member")
                    if not full:
                        target = dist / part
                    elif name == "payload/runtime/node.exe":
                        target = node
                    elif name.startswith((prefix+"dist/", prefix+"node_modules/")) or name == prefix+"package.json":
                        target = server / part.relative_to(prefix)
                    else:
                        continue
                    if target in seen:
                        raise ValueError("duplicate archive member")
                    seen.add(target)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with archive.open(member) as src, target.open("xb") as dst:
                        shutil.copyfileobj(src, dst)
                    if full and file_sha(target) != manifest.get(name):
                        raise ValueError("release manifest mismatch: " + name)
                if full:
                    required = {name for name in manifest if name.startswith((prefix+"dist/", prefix+"node_modules/"))
                                or name in (prefix+"package.json","payload/runtime/node.exe")}
                    if not required.issubset(archive.namelist()):
                        raise ValueError("release missing declared runtime files")
    files = tree(dist)
    if "main.js" not in files or node is None or not node.is_file():
        raise ValueError("main.js or Node executable missing; pass --node for standalone dist")
    info.update(files=files, dist_sha256=canonical_digest(files), main_sha256=files["main.js"], node_sha256=file_sha(node))
    return dist, node, info
