import asyncio
import json
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock
from superagent.runtime.codex import CodexAppServer, CodexError

class DynamicToolTest(unittest.IsolatedAsyncioTestCase):
    async def test_specs_start_and_resume_protocol(self):
        client=CodexAppServer('unused','.')
        client._request=AsyncMock(return_value={'thread':{'id':'t'}})
        await client.start_thread('.',read_only=True)
        params=client._request.await_args.args[1]
        self.assertEqual([tool['name'] for tool in params['dynamicTools']],['list_files','read_file','search_text'])
        self.assertTrue(all(tool['type']=='function' and tool['inputSchema']['additionalProperties'] is False for tool in params['dynamicTools']))
        read_schema = params['dynamicTools'][1]['inputSchema']
        self.assertEqual(read_schema['required'], ['path'])
        self.assertEqual(read_schema['properties']['start_line'], {'type': 'integer', 'minimum': 1})
        self.assertEqual(read_schema['properties']['max_lines'], {'type': 'integer', 'minimum': 1, 'maximum': 200})
        await client.start_thread('.')
        self.assertNotIn('dynamicTools',client._request.await_args.args[1])
        await client.resume_thread('t',read_only=True)
        self.assertNotIn('dynamicTools',client._request.await_args.args[1])
        self.assertIn('t',client.readonly_threads)

    async def test_request_and_text_response(self):
        client=CodexAppServer('unused','.')
        client.readonly_threads.add('thread'); client.active_turns.add(('thread','turn'))
        stream=asyncio.StreamReader()
        event={'id':77,'method':'item/tool/call','params':{'threadId':'thread','turnId':'turn','callId':'call','tool':'read_file','arguments':{'path':'a.txt'},'namespace':None}}
        stream.feed_data((json.dumps(event)+'\n').encode()); stream.feed_eof()
        client.process=SimpleNamespace(stdout=stream,returncode=0)
        await client._read()
        self.assertEqual(await client.queue.get(),event)
        client._send=AsyncMock()
        with self.assertRaises(ValueError): await client.respond_tool(77,{'success':True,'contentItems':[{'type':'inputImage','imageUrl':'x'}]})
        with self.assertRaises(ValueError): await client.respond_tool(77,{'success':True,'contentItems':[{'type':'inputText','text':'x'*(1024*1024+1)}]})
        result={'success':True,'contentItems':[{'type':'inputText','text':'safe'}]}
        await client.respond_tool(77,result)
        client._send.assert_awaited_once_with({'id':77,'result':result})
        with self.assertRaises(CodexError): await client.respond_tool(77,result)

    async def test_repair_or_wrong_turn_rejected(self):
        client=CodexAppServer('unused','.')
        client._send=AsyncMock()
        client.pending_tools[1]={'threadId':'t','turnId':'other','tool':'read_file'}
        client.readonly_threads.add('t'); client.active_turns.add(('t','turn'))
        with self.assertRaises(CodexError): await client.respond_tool(1,{'success':False,'contentItems':[]})
        client.active_turns.add(('t','other')); client.readonly_threads.clear()
        with self.assertRaises(CodexError): await client.respond_tool(1,{'success':False,'contentItems':[]})
