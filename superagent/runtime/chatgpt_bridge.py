"""Local MCP STDIO bridge. Run with python -m superagent.runtime.chatgpt_bridge.

Only platform credentials from the environment are used. No ChatGPT browser
credentials, private endpoints, or account session storage are accessed.
"""
import json
import os
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from superagent.api.conversation_providers import OperationIn

MAX_MESSAGE_BYTES = 1_000_000


def object_schema(properties, required=()):
    return {'type': 'object', 'properties': properties, 'required': list(required),
            'additionalProperties': False}


def tool(name, description, schema, read_only=True):
    return {'name': name, 'description': description, 'inputSchema': schema,
            'annotations': {'readOnlyHint': read_only, 'destructiveHint': not read_only,
                            'idempotentHint': True, 'openWorldHint': False}}


TOOLS = [
    tool('superagent_status', '读取平台会话能力、接入限制和当前鉴权身份。', object_schema({})),
    tool('superagent_sessions', '列出当前身份可访问的本地会话及项目编号。',
         object_schema({'project_id': {'type': 'integer', 'minimum': 1}})),
    tool('superagent_read', '读取平台会话消息。后续分页 snapshot 变化时从 after=0 重读并按消息 ID 去重。',
         object_schema({'session_id': {'type': 'string'}, 'after': {'type': 'integer', 'minimum': 0},
                        'limit': {'type': 'integer', 'minimum': 1, 'maximum': 200}}, ['session_id'])),
    tool('superagent_operation',
         '用户要求操作平台时创建 Worker、补充会话或控制任务。先读取当前 state_version。'
         '每个意图使用唯一 request_key，网络失败仅使用原键查询或重试，结果未知须核验。'
         '这里只传递明确提供的正文，不自动上传完整 ChatGPT 历史。',
         OperationIn.model_json_schema(), read_only=False),
    tool('superagent_receipt', '读取当前身份的一次写操作回执，核验 completed、pending 或 unknown。',
         object_schema({'request_key': {'type': 'string', 'minLength': 1, 'maxLength': 128}}, ['request_key'])),
]


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class BridgeClient:
    def __init__(self, base_url=None, token=None):
        self.base_url = (base_url or os.getenv('SUPERAGENT_BRIDGE_URL', 'http://127.0.0.1:8765')).rstrip('/')
        self.token = token if token is not None else os.getenv('SUPERAGENT_BRIDGE_TOKEN', '')
        parsed = urlsplit(self.base_url)
        if (parsed.scheme not in {'http', 'https'} or not parsed.hostname or parsed.username
                or parsed.password or parsed.path or parsed.query or parsed.fragment):
            raise ValueError('桥接 URL 必须为平台源地址')
        if parsed.scheme == 'http' and parsed.hostname not in {'localhost', '127.0.0.1', '::1'}:
            raise ValueError('远程平台地址需要 HTTPS')
        if not self.token or '\n' in self.token or '\r' in self.token:
            raise ValueError('请通过环境变量配置有效的平台桥接令牌')
        self.opener = build_opener(NoRedirect())

    def request(self, path, body=None):
        data = None if body is None else json.dumps(body, ensure_ascii=False).encode()
        request = Request(self.base_url + '/api/v1/conversation-providers/bridge/' + path,
                          data=data, headers={'Authorization': 'Bearer ' + self.token,
                                              'Content-Type': 'application/json'})
        try:
            with self.opener.open(request, timeout=30) as response:
                raw = response.read(MAX_MESSAGE_BYTES + 1)
                if len(raw) > MAX_MESSAGE_BYTES:
                    raise ValueError('返回内容过大，请缩小分页')
                return json.loads(raw)
        except HTTPError as exc:
            # Never echo server error pages, URLs, headers, or credentials.
            raise ValueError(f'平台返回 HTTP {exc.code}，请检查权限、版本及操作回执') from None
        except (URLError, TimeoutError, OSError):
            raise ValueError('平台连接未确认，写操作请使用原 request_key 核验回执') from None

    def call(self, name, arguments):
        if not isinstance(arguments, dict):
            raise ValueError('工具参数必须为对象')
        schemas = {item['name']: item['inputSchema'] for item in TOOLS}
        if name not in schemas:
            raise ValueError('工具不存在')
        schema = schemas[name]
        if set(arguments) - set(schema['properties']) or set(schema.get('required', [])) - set(arguments):
            raise ValueError('工具参数缺失或含未知字段')
        if name == 'superagent_status':
            return self.request('status')
        if name == 'superagent_sessions':
            return self.request('sessions?' + urlencode(arguments))
        if name == 'superagent_read':
            params = {key: value for key, value in arguments.items() if key != 'session_id'}
            return self.request('sessions/' + quote(str(arguments['session_id']), safe='') + '?' + urlencode(params))
        if name == 'superagent_receipt':
            return self.request('operations/' + quote(str(arguments['request_key']), safe=''))
        body = OperationIn.model_validate(arguments)
        return self.request('operations', body.model_dump())


def dispatch(message, client):
    if not isinstance(message, dict) or message.get('jsonrpc') != '2.0':
        return {'jsonrpc': '2.0', 'id': None, 'error': {'code': -32600, 'message': '无效 JSON-RPC 请求'}}
    if 'id' not in message:
        return None
    ident = message['id']
    method = message.get('method')
    params = message.get('params', {})
    response = {'jsonrpc': '2.0', 'id': ident}
    if not isinstance(params, dict):
        return {**response, 'error': {'code': -32602, 'message': '参数必须为对象'}}
    if method == 'initialize':
        requested = params.get('protocolVersion')
        version = requested if requested in {'2024-11-05', '2025-03-26', '2025-06-18'} else '2025-06-18'
        result = {'protocolVersion': version, 'capabilities': {'tools': {}},
                  'serverInfo': {'name': 'superagent-local-bridge', 'version': '1.0.0'},
                  'instructions': '仅在用户明确要求时操作 SuperAgent。先读取会话版本，再提交写入。'
                  '写操作保留 request_key，超时先查询回执。ChatGPT 项目聊天的创建和自动历史同步尚未接通。'}
    elif method == 'ping':
        result = {}
    elif method == 'tools/list':
        result = {'tools': TOOLS}
    elif method == 'tools/call':
        try:
            value = client.call(params.get('name'), params.get('arguments', {}))
            result = {'content': [{'type': 'text', 'text': json.dumps(value, ensure_ascii=False)}],
                      'isError': False}
        except Exception:
            # Validation errors can contain the submitted input. Keep errors generic.
            result = {'content': [{'type': 'text', 'text': '工具调用未确认，请检查参数、平台权限与操作回执。'}],
                      'isError': True}
    else:
        return {**response, 'error': {'code': -32601, 'message': '方法不存在'}}
    return {**response, 'result': result}


def serve(client, source, sink):
    while True:
        line = source.readline(MAX_MESSAGE_BYTES + 1)
        if not line:
            return
        if len(line) > MAX_MESSAGE_BYTES:
            raise ValueError('MCP 请求超出大小限制')
        try:
            message = json.loads(line)
            response = dispatch(message, client)
        except (ValueError, TypeError):
            response = {'jsonrpc': '2.0', 'id': None,
                        'error': {'code': -32700, 'message': 'JSON 解析失败'}}
        if response is not None:
            sink.write(json.dumps(response, ensure_ascii=False) + '\n')
            sink.flush()


def main():
    try:
        # Python on Windows otherwise uses the console codepage for redirected IO.
        sys.stdin.reconfigure(encoding='utf-8')
        sys.stdout.reconfigure(encoding='utf-8')
        serve(BridgeClient(), sys.stdin, sys.stdout)
    except Exception:
        print('SuperAgent 桥接停止，请检查平台地址、环境变量与协议输入。', file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == '__main__':
    main()
