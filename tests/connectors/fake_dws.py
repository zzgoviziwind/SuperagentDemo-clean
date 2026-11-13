"""Offline subprocess protocol fixture. Never invokes DWS."""

import json
import sys

mode = sys.argv[1]
if mode == "exit":
    sys.exit(1)
if mode == "nonretryable":
    print(json.dumps({"error": {"retryable": False}}), file=sys.stderr, flush=True)
    sys.exit(1)
print("[event] ready event_key=user_im_message_receive_at bus_pid=1 subscribe_id=fake", file=sys.stderr, flush=True)
print(json.dumps({"type": "user_im_message_receive_at", "event_id": "e1",
                  "sender_open_dingtalk_id": "other", "conversation_id": "chat1",
                  "message_id": "m1", "content": "fake", "event_time": 1794531600000}), flush=True)
if mode == "normal":
    sys.stdin.read()
