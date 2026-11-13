"""Offline NDJSON producer and reply executable for business-loop tests."""

import json
import sys
from datetime import datetime, timedelta
from pathlib import Path
import base64

if "event" in sys.argv:
    print("[event] ready fixture=true", file=sys.stderr, flush=True)
    event = {"type": "user_im_message_receive_at", "sender_open_dingtalk_id": "trusted",
             "conversation_id": "chat", "message_id": "subprocess-message",
             "content": "请修复 #42 的问题", "event_time": "2026-11-13T01:00:00Z"}
    print(json.dumps(event), flush=True)
    print(json.dumps(event), flush=True)
    sys.stdin.read()
elif "+search-msg" in sys.argv or "+chat-messages" in sys.argv:
    conversation = sys.argv[sys.argv.index("--group") + 1]
    start = datetime.fromisoformat(sys.argv[sys.argv.index("--start") + 1].replace("Z", "+00:00"))
    print(json.dumps({"data": {"complete": True, "hasMore": False, "conversationId": conversation,
                              "messages": [{"messageId": "historical-message", "senderId": "history-user",
                                            "conversationId": conversation, "text": "请检查 #42 的历史请求",
                                            "createTime": (start + timedelta(seconds=1)).isoformat()}]}}), flush=True)
elif "+messages-mget" in sys.argv:
    message_id = sys.argv[sys.argv.index("--msg-ids") + 1]
    path = Path("downloads/screenshot.png")
    path.parent.mkdir(exist_ok=True)
    path.write_bytes(base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ1cAAAAASUVORK5CYII="))
    print(json.dumps({"data": {"complete": True, "hasMore": False,
                              "messages": [{"messageId": message_id, "conversationId": "chat"}],
                              "resourceDownloads": {"ok": True, "partial": False, "failedCount": 0, "failures": [],
                                                    "requestedCount": 1, "downloadedCount": 1,
                                                    "downloads": [{"localPath": path.as_posix(), "sizeBytes": path.stat().st_size,
                                                                   "messageId": message_id, "resourceType": "mediaId", "resourceId": "offline-image"}]}}}), flush=True)
else:
    assert "chat" in sys.argv and "+messages-reply" in sys.argv
    print(json.dumps({"data": {"deliveryStatus": "sent", "messageId": "offline-reply"}}), flush=True)
