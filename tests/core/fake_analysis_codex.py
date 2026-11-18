"""Offline peer checks read-only threads and requires a real dynamic-tool result."""
import json
from pathlib import Path
import sys

sys.stdin.reconfigure(encoding='utf-8')
workspace=None
resumed=False
for line in sys.stdin:
    message=json.loads(line)
    method=message.get('method')
    if not method:
        if message.get('id')==2000:
            print(json.dumps({'id':2001,'method':'item/tool/call','params':{'threadId':'analysis-thread','turnId':'analysis-turn','callId':'call-1','tool':'list_files','arguments':{'path':'.'}}}),flush=True)
            continue
        if message.get('id')==2001:
            result=message.get('result',{})
            payload=json.loads(result.get('contentItems',[{}])[0].get('text','{}'))
            has_readme=any(x.get('path')=='README.md' for x in payload.get('files',[]))
            if result.get('success') and has_readme:
                print(json.dumps({'id':2002,'method':'item/tool/call','params':{'threadId':'analysis-thread','turnId':'analysis-turn','callId':'call-2','tool':'read_file','arguments':{'path':'README.md'}}}),flush=True)
                continue
        if message.get('id')==2002:
            result=message.get('result',{})
            payload=json.loads(result.get('contentItems',[{}])[0].get('text','{}'))
            has_evidence=any(x.get('text')=='baseline' and x.get('line')==1 for x in payload.get('lines',[]))
            summary={'status':'completed' if result.get('success') and has_evidence else 'blocked','summary':'README.md 第 1 行：baseline'}
            if '[channel-reply]' in prompt and 'channel_reply' in prompt and 'current_time' in prompt:
                summary['channel_reply'] = {'decision': 'send', 'reason': 'There is an unanswered question.',
                                            'reply': '已核实 README 第 1 行为 baseline。'}
            if '[collaborate]' in prompt and not resumed:
                summary['collaboration_requests'] = [{'goal': 'Read README.md and return line evidence'}]
            print(json.dumps({'method':'item/completed','params':{'threadId':'analysis-thread','turnId':'analysis-turn','item':{'type':'agentMessage','text':json.dumps(summary)}}}),flush=True)
            print(json.dumps({'method':'turn/completed','params':{'threadId':'analysis-thread','turn':{'id':'analysis-turn','status':'completed'}}}),flush=True)
        continue
    if 'id' not in message: continue
    params=message.get('params',{})
    if method in ('thread/start','thread/resume'):
        if params.get('sandbox')!='read-only':
            print(json.dumps({'id':message['id'],'error':{'message':'read-only sandbox required'}}),flush=True)
            continue
        if method=='thread/start':
            workspace=Path(params['cwd'])
            if {x.get('name') for x in params.get('dynamicTools',[])} != {'list_files','read_file','search_text'}:
                print(json.dumps({'id':message['id'],'error':{'message':'readonly tools missing'}}),flush=True)
                continue
        else: resumed=True
        result={'thread':{'id':'analysis-thread'}}
    elif method=='turn/start':
        prompt='\n'.join(x.get('text','') for x in params.get('input',[]))
        if '[model-override]' in prompt and (params.get('model'), params.get('effort')) != ('analysis-model', 'high'):
            print(json.dumps({'id':message['id'],'error':{'message':'analysis override missing from turn/start'}}),flush=True)
            continue
        if '项目配置的验证命令：' in prompt:
            print(json.dumps({'id':message['id'],'error':{'message':'analysis must not execute project tests'}}),flush=True)
            continue
        turn='analysis-turn'
        print(json.dumps({'id':message['id'],'result':{'turn':{'id':turn}}}),flush=True)
        if '[approval]' in prompt and not resumed:
            print(json.dumps({'id':1001,'method':'item/commandExecution/requestApproval','params':{'threadId':'analysis-thread','turnId':turn,'command':'danger','cwd':str(workspace)}}),flush=True)
            continue
        if '[denied]' in prompt:
            print(json.dumps({'id':2000,'method':'item/tool/call','params':{'threadId':'analysis-thread','turnId':turn,'callId':'denied-1','tool':'read_file','arguments':{'path':'.env'}}}),flush=True)
            continue
        if '[change]' in prompt:
            (workspace/'illicit.txt').write_text('modified',encoding='utf-8')
        print(json.dumps({'id':2001,'method':'item/tool/call','params':{'threadId':'analysis-thread','turnId':turn,'callId':'call-1','tool':'list_files','arguments':{'path':'.'}}}),flush=True)
        continue
    else: result={}
    print(json.dumps({'id':message['id'],'result':result}),flush=True)
