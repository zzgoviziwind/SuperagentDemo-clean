"""Read-only synthetic DWS process for group lookup and bounded direct-message history."""
import json
from pathlib import Path
import sys

args = sys.argv[1:]
assert "--profile" in args and args[args.index("--profile")+1] == "test"
if "+chat-search" in args:
    result={"complete":True,"hasMore":False,"chats":[{"openConversationId":"fixture-group","name":"合成群"}]}
elif "+conversation-info" in args:
    result={"conversationInfo":{"openConversationId":"fixture-group","singleChat":False,"title":"合成群"}}
elif "+chat-messages" in args:
    result={"complete":True,"hasMore":False,"conversationId":"fixture-thread",
            "messages":[{"conversationId":"fixture-thread","messageId":"sample-dm-106","senderId":"fixture-peer"}]}
else:
    raise SystemExit("Unsupported offline read")
print(json.dumps({"data":result}))
