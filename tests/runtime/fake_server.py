import json, sys, time
for line in sys.stdin:
    m = json.loads(line)
    method = m.get('method')
    if method == 'initialized': continue
    if method == 'turn/start':
        print(json.dumps({'id': 99, 'method': 'item/commandExecution/requestApproval', 'params': {}}), flush=True)
        result = {'turn': {'id': 'turn'}}
    elif method == 'thread/start' or method == 'thread/resume': result = {'thread': {'id': 'thread'}}
    elif method == 'turn/steer':
        time.sleep(.2)
        result = {}
    elif method == 'turn/interrupt': result = {}
    elif method == 'initialize': result = {}
    elif method is None: continue
    else: result = {}
    print(json.dumps({'id': m['id'], 'result': result}), flush=True)
