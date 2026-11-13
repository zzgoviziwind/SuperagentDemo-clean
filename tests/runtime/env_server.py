import json, os, sys
from pathlib import Path
for line in sys.stdin:
    msg = json.loads(line)
    if msg.get('method') == 'initialized': continue
    if 'id' not in msg: continue
    if msg.get('method') == 'env/check':
        result = {'api_token_present': 'SUPERAGENT_API_TOKEN' in os.environ,
                  'users_present': 'SUPERAGENT_USERS_JSON' in os.environ,
                  'redmine_present': 'REDMINE_API_KEY' in os.environ,
                  'database_present': 'DATABASE_URL' in os.environ,
                  'api_key_present': os.environ.get('OPENAI_API_KEY') == 'fake-openai-key',
                  'codex_home': os.environ.get('CODEX_HOME'), 'argv': sys.argv[1:]}
    elif msg.get('method') == 'thread/start':
        (Path(os.environ['CODEX_HOME']) / 'fake-thread').write_text('saved', encoding='utf-8')
        result = {'thread': {'id': 'saved'}}
    elif msg.get('method') == 'thread/resume':
        result = {'thread': {'id': 'saved' if (Path(os.environ['CODEX_HOME']) / 'fake-thread').exists() else 'missing'}}
    else: result = {}
    print(json.dumps({'id': msg['id'], 'result': result}), flush=True)
