"""Local pinning and archive tests. The candidate files are inert text."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import stage0
import replay_bundle as bundle
import replay119


class CandidateTests(unittest.TestCase):
    def setUp(self):
        private = tempfile.TemporaryDirectory(dir=HERE, prefix="phase1-run-pin-test-")
        self.addCleanup(private.cleanup)
        self.home = Path(private.name)
        self.source = self.home/"candidate"
        self.source.mkdir()
        (self.source/"main.js").write_bytes(b"inert entry")
        (self.source/"fixtures").mkdir()
        (self.source/"fixtures/data").write_bytes(b"one")
        self.entry = stage0.sha(b"inert entry")

    def snapshot(self, name, entry=None, manifest=None):
        work = self.home/name
        work.mkdir()
        return bundle.capture(work, self.source, entry or self.entry, manifest)

    def test_copy_hashes_all_files_and_isolates_source(self):
        pin = self.snapshot("first", self.entry.upper())
        (self.source/"fixtures/data").write_bytes(b"two")
        second = self.snapshot("second")
        self.assertEqual(pin.files["main.js"], second.files["main.js"])
        self.assertNotEqual(pin.digest, second.digest)
        self.assertEqual(b"one", (pin.directory/"fixtures/data").read_bytes())
        self.assertEqual(pin, bundle.restore(pin.work))

    def test_wrong_entry_set_or_modified_copy_rejected(self):
        with self.assertRaises(ValueError):
            self.snapshot("bad-entry", "f"*64)
        with self.assertRaises(ValueError):
            self.snapshot("bad-set", manifest="f"*64)
        pin = self.snapshot("modified")
        (pin.directory/"fixtures/data").write_bytes(b"changed")
        with self.assertRaises(ValueError):
            bundle.restore(pin.work)

    def test_two_runs_and_competing_publishers_preserve_evidence(self):
        one = self.snapshot("first")
        two = self.snapshot("second")
        archive = self.home/"evidence"
        def write(pin, value):
            try:
                with bundle.publish(pin, "serial", archive) as staging:
                    (staging/"sample").write_text(value)
                return value
            except FileExistsError:
                return None
        with ThreadPoolExecutor(max_workers=2) as pool:
            winners = list(pool.map(lambda value: write(one, value), ["first","second"]))
        values = [v for v in winners if v]
        self.assertEqual(1, len(values))
        self.assertEqual("another", write(two, "another"))
        saved = archive/self.entry/one.work.name/"serial/sample"
        self.assertEqual(values[0], saved.read_text())
        self.assertIsNone(write(one, "overwrite"))
        self.assertEqual(values[0], saved.read_text())

    def test_failed_publish_preserves_retry(self):
        pin = self.snapshot("failed")
        archive = self.home/"evidence"
        with self.assertRaises(RuntimeError):
            with bundle.publish(pin, "serial", archive) as staging:
                self.assertEqual([], list(archive.rglob("*.lock")))
                (staging/"partial").touch()
                raise RuntimeError("fixture failure")
        with bundle.publish(pin, "serial", archive) as staging:
            (staging/"complete").touch()
        self.assertEqual(["complete"], [p.name for p in (archive/self.entry/"failed/serial").iterdir()])
        self.assertEqual([], list(archive.rglob("*.lock")))


class HistoricalArchiveTests(unittest.TestCase):
    def test_serial_entry_reclassifies_saved_http_into_new_archive(self):
        legacy = HERE/"phase1-run-119-ewsg5_sb"
        if not (legacy/"run.json").exists():
            self.skipTest("The optional B328 private sample is not present")
        historic = HERE/"evidence/http119-b3289b3be629"
        before = bundle.file_hashes(historic)
        with tempfile.TemporaryDirectory(dir=HERE, prefix="phase1-run-pin-test-") as temp:
            archive = Path(temp)
            publish = bundle.publish
            args = ["replay119", "--resume", str(legacy), "--node", "unused", "--fail-on-diff"]
            with patch.object(sys,"argv",args), patch.object(bundle,"publish",lambda pin,phase: publish(pin,phase,archive)), \
                 patch.object(replay119,"run_group",side_effect=AssertionError("unexpected HTTP replay")), \
                 patch.object(replay119,"burst",side_effect=AssertionError("unexpected HTTP burst")):
                with self.assertRaisesRegex(SystemExit,"待裁决差异"):
                    replay119.main()
                # A strict failure still publishes all evidence once. A retry must preserve those bytes.
                report, = archive.rglob("classification.json")
                self.assertEqual(before["classification.json"], stage0.sha(report.read_bytes()))
                with self.assertRaises(FileExistsError):
                    replay119.main()
        self.assertEqual(before,bundle.file_hashes(historic))


if __name__ == "__main__":
    unittest.main()
