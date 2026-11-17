"""Offline database + workspace snapshots. Never starts workers or external connectors."""
import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
from urllib.parse import parse_qs, unquote, urlsplit


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def postgres_environment(url):
    parsed = urlsplit(url.replace("postgresql+psycopg:", "postgresql:", 1))
    if parsed.scheme != "postgresql" or not parsed.hostname or not parsed.path.strip("/"):
        raise ValueError("Expected PostgreSQL URL")
    environment = os.environ | {
        "PGHOST": parsed.hostname, "PGPORT": str(parsed.port or 5432),
        "PGUSER": unquote(parsed.username or ""), "PGPASSWORD": unquote(parsed.password or ""),
        "PGDATABASE": unquote(parsed.path.lstrip("/")),
    }
    parameters = parse_qs(parsed.query)
    for option in ("sslmode", "sslrootcert", "sslcert", "sslkey", "connect_timeout"):
        if option in parameters:
            environment["PG" + option.upper()] = parameters[option][-1]
    return environment


def sqlite_path(url):
    if not url.startswith("sqlite:///"):
        raise ValueError("Expected file-backed sqlite:/// URL")
    return Path(url.removeprefix("sqlite:///")).resolve(strict=True)


def copy_tree(source, destination):
    # Reject links so the snapshot never captures arbitrary files outside the data root.
    for path in source.rglob("*"):
        if path.is_symlink() or (hasattr(path, "is_junction") and path.is_junction()):
            raise ValueError(f"Linked path cannot be snapshotted: {path}")
    shutil.copytree(source, destination)


def backup(destination, data_root, database_url):
    data_root = data_root.resolve(strict=True)
    destination = destination.resolve()
    if destination == data_root or data_root in destination.parents or destination in data_root.parents:
        raise ValueError("Backup and data directories must be separate")
    destination.mkdir(parents=True, exist_ok=False)
    # .incomplete remains on any failure, and restore refuses it.
    marker = destination / ".incomplete"
    marker.touch()
    copy_tree(data_root, destination / "data")
    if database_url.startswith("sqlite:"):
        source = sqlite_path(database_url)
        with closing(sqlite3.connect(source.as_uri() + "?mode=ro", uri=True)) as connection:
            with closing(sqlite3.connect(destination / "database.sqlite")) as target:
                connection.backup(target)
                if target.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                    raise ValueError("SQLite integrity check failed")
        database = "sqlite"
    else:
        subprocess.run(["pg_dump", "--format=custom", "--file", str(destination / "database.dump")],
            env=postgres_environment(database_url), check=True)
        database = "postgresql"
    hashes = {path.relative_to(destination).as_posix(): digest(path)
        for path in destination.rglob("*") if path.is_file() and path != marker}
    (destination / "manifest.json").write_text(json.dumps({"version": 1, "database": database,
        "files": hashes, "reconciliation_required": True}, ensure_ascii=False, indent=2), encoding="utf-8")
    marker.unlink()


def restore(snapshot, destination):
    snapshot = snapshot.resolve(strict=True)
    if (snapshot / ".incomplete").exists():
        raise ValueError("Incomplete snapshot")
    manifest = json.loads((snapshot / "manifest.json").read_text(encoding="utf-8"))
    if manifest["version"] != 1:
        raise ValueError("Unsupported snapshot version")
    actual_files = {path.relative_to(snapshot).as_posix() for path in snapshot.rglob("*")
        if path.is_file() and path != snapshot / "manifest.json"}
    if actual_files != set(manifest["files"]):
        raise ValueError("Snapshot inventory differs from manifest")
    for relative, expected in manifest["files"].items():
        path = (snapshot / relative).resolve(strict=True)
        if not path.is_relative_to(snapshot) or digest(path) != expected:
            raise ValueError(f"Snapshot integrity failure: {relative}")
    destination = destination.resolve()
    if destination.exists():
        raise FileExistsError("Restore target must be a new directory")
    if destination.is_relative_to(snapshot):
        raise ValueError("Restore target must be outside snapshot")
    destination.mkdir(parents=True)
    copy_tree(snapshot / "data", destination / "data")
    database_file = "database.sqlite" if manifest["database"] == "sqlite" else "database.dump"
    shutil.copy2(snapshot / database_file, destination / database_file)
    (destination / "RECONCILIATION_REQUIRED.txt").write_text(
        "Keep Codex and connectors disabled. Check unknown runs, approvals and external actions before resuming.\n"
        "For PostgreSQL restore database.dump to a NEW empty database using pg_restore --single-transaction.\n",
        encoding="utf-8")
    # Restoration deliberately produces files only. Operator selects a new database and reconciles first.


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["backup", "restore"])
    parser.add_argument("--destination", type=Path, required=True)
    parser.add_argument("--data-root", type=Path)
    parser.add_argument("--snapshot", type=Path)
    parser.add_argument("--services-stopped", action="store_true", required=True,
        help="Confirm API, workers, connectors and external processes have stopped")
    args = parser.parse_args()
    if args.action == "backup":
        if args.data_root is None:
            parser.error("backup requires --data-root")
        backup(args.destination, args.data_root, os.environ["SUPERAGENT_DATABASE_URL"])
    else:
        if args.snapshot is None:
            parser.error("restore requires --snapshot")
        restore(args.snapshot, args.destination)


if __name__ == "__main__":
    main()
