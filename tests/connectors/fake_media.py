"""Writes only offline fixtures into the supplied isolated working directory."""

import base64
import json
from pathlib import Path
import subprocess
import sys
import time

mode = sys.argv[1]
output = Path("downloads")
output.mkdir()
png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=")
path = output / "screenshot.png"
path.write_bytes(png)
if mode == "signature":
    path.write_bytes(b"invalid")
if mode == "unlisted":
    (output / "extra.png").write_bytes(png)
if mode == "oversize":
    path.write_bytes(b"x" * 10000)
if mode == "count":
    for index in range(10):
        (output / f"extra{index}.png").write_bytes(png)
if mode == "hardlink":
    import os
    os.link(path, output / "second.png")
if mode == "child":
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    Path(sys.argv[2]).write_text(str(child.pid))
if mode == "timeout":
    time.sleep(60)
if mode == "flood":
    print("x" * (2 * 1024 * 1024), flush=True)
    time.sleep(60)
item = {"resourceType": "mediaId", "resourceId": "fake-resource", "messageId": "m1",
        "localPath": "downloads/screenshot.png", "sizeBytes": path.stat().st_size}
if mode == "traversal":
    item["localPath"] = "../outside.png"
if mode == "size":
    item["sizeBytes"] += 1
if mode == "message":
    item["messageId"] = "other"
ledger = {"ok": True, "partial": False, "requestedCount": 1, "downloadedCount": 1,
          "failedCount": 0, "failures": [], "downloads": [item]}
if mode == "partial":
    ledger.update(ok=False, partial=True, failedCount=1)
print(json.dumps({"data": {"complete": True, "hasMore": False, "failures": [],
                           "messages": [{"messageId": "m1", "conversationId": "chat1"}],
                           "resourceDownloads": ledger}}), flush=True)
