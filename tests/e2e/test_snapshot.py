import json
from contextlib import closing
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class SnapshotAcceptance(unittest.TestCase):
    def setUp(self):
        scratch = ROOT / "tests/e2e/.tmp"
        scratch.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=scratch)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.data = self.root / "state"
        self.data.mkdir()
        (self.data / "artifact.txt").write_text("immutable evidence", encoding="utf-8")
        self.database = self.data / "control.db"
        with closing(sqlite3.connect(self.database)) as connection:
            connection.execute("CREATE TABLE actions (id INTEGER PRIMARY KEY, state TEXT)")
            connection.execute("INSERT INTO actions VALUES (1, 'unknown')")
            connection.commit()
        self.snapshot = self.root / "snapshot"
        self.environment = os.environ | {"SUPERAGENT_DATABASE_URL": "sqlite:///" + self.database.as_posix()}

    def invoke(self, *arguments, expected=0):
        result = subprocess.run([sys.executable, str(ROOT / "deploy/snapshot.py"), *arguments],
            env=self.environment, capture_output=True, text=True, encoding="utf-8", errors="replace")
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)

    def backup(self):
        self.invoke("backup", "--destination", str(self.snapshot), "--data-root", str(self.data), "--services-stopped")

    def test_round_trip_preserves_unknown_actions_and_artifacts(self):
        self.backup()
        destination = self.root / "restore"
        self.invoke("restore", "--snapshot", str(self.snapshot), "--destination", str(destination), "--services-stopped")
        self.assertEqual((destination / "data/artifact.txt").read_text(), "immutable evidence")
        with closing(sqlite3.connect(destination / "database.sqlite")) as connection:
            self.assertEqual(connection.execute("SELECT state FROM actions").fetchone(), ("unknown",))
        self.assertTrue((destination / "RECONCILIATION_REQUIRED.txt").exists())
        self.assertTrue(json.loads((self.snapshot / "manifest.json").read_text())["reconciliation_required"])

    def test_tampering_fails_before_restore_directory_is_created(self):
        self.backup()
        (self.snapshot / "data/artifact.txt").write_text("changed")
        destination = self.root / "restore"
        self.invoke("restore", "--snapshot", str(self.snapshot), "--destination", str(destination), "--services-stopped", expected=1)
        self.assertFalse(destination.exists())

    def test_existing_destination_is_never_overwritten(self):
        self.backup()
        destination = self.root / "restore"
        destination.mkdir()
        (destination / "keep.txt").write_text("keep")
        self.invoke("restore", "--snapshot", str(self.snapshot), "--destination", str(destination), "--services-stopped", expected=1)
        self.assertEqual((destination / "keep.txt").read_text(), "keep")

    def test_unlisted_file_is_rejected(self):
        self.backup()
        (self.snapshot / "data/unlisted.txt").write_text("unexpected content")
        destination = self.root / "restore"
        self.invoke("restore", "--snapshot", str(self.snapshot), "--destination", str(destination), "--services-stopped", expected=1)
        self.assertFalse(destination.exists())

    def test_backup_inside_data_root_is_rejected(self):
        self.invoke("backup", "--destination", str(self.data / "nested"), "--data-root", str(self.data), "--services-stopped", expected=1)


if __name__ == "__main__":
    unittest.main()
