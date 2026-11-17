"""Protocol peer that fails unless it receives a local image input."""
import json
from pathlib import Path
import sys
sys.stdin.reconfigure(encoding='utf-8')
for line in sys.stdin:
    request=json.loads(line)
    method=request.get('method')
    if 'id' not in request or not method: continue
    result={}
    if method=='thread/start': result={'thread':{'id':'image-thread'}}
    elif method=='turn/start':
        images=[item for item in request['params']['input'] if item.get('type')=='localImage']
        if len(images)!=1 or not Path(images[0]['path']).is_file():
            print(json.dumps({'id':request['id'],'error':{'message':'image missing'}}),flush=True)
            continue
        result={'turn':{'id':'image-turn'}}
    print(json.dumps({'id':request['id'],'result':result}),flush=True)
