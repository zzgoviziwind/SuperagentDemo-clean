"""Offline app-server that accepts a turn and intentionally stops producing progress."""
import json
import sys
for line in sys.stdin:
    request=json.loads(line)
    method=request.get('method')
    if 'id' not in request or not method: continue
    result={}
    if method=='thread/start': result={'thread':{'id':'idle-thread'}}
    elif method=='turn/start': result={'turn':{'id':'idle-turn'}}
    print(json.dumps({'id':request['id'],'result':result}),flush=True)
