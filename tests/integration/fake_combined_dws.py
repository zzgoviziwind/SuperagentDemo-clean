"""Offline process fixture for simultaneous DWS scopes. Never invokes DWS."""
import json
import sys

args = sys.argv[1:]
kind = args[args.index('--kind') + 1]
if '--fail-kind' in args and args[args.index('--fail-kind') + 1] == kind:
    raise SystemExit(3)
event_type = {'all-direct': 'user_im_message_receive_o2o_all',
              'all-group': 'user_im_message_receive_group_all',
              'at-me': 'user_im_message_receive_at', 'group': 'user_im_message_receive_group'}[kind]
print('[event] ready event_key=' + event_type, file=sys.stderr, flush=True)
print(json.dumps({'type': event_type, 'event_id': kind, 'sender_open_dingtalk_id': 'trusted',
                  'conversation_id': 'direct-chat' if kind == 'all-direct' else 'group-chat',
                  'message_id': kind + '-message', 'content': '请检查本地示例',
                  'event_time': '2026-11-14T01:00:00Z'}), flush=True)
sys.stdin.read()
