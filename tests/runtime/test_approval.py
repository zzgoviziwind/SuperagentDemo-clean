import asyncio
import json
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock
from superagent.runtime.codex import CodexAppServer, CodexError

class ApprovalTest(unittest.IsolatedAsyncioTestCase):
    async def test_real_request_choices_and_no_policy_amendment(self):
        client=CodexAppServer('unused','.')
        stream=asyncio.StreamReader()
        request={'id':123,'method':'item/commandExecution/requestApproval','params':{'availableDecisions':['accept',{'acceptWithExecpolicyAmendment':{'execpolicy_amendment':['foo']}},'cancel']}}
        stream.feed_data((json.dumps(request)+'\n').encode()); stream.feed_eof()
        client.process=SimpleNamespace(stdout=stream,returncode=0)
        await client._read()
        self.assertEqual((await client.queue.get())['id'],123)
        client._send=AsyncMock()
        await client.respond_approval(123,'reject')
        client._send.assert_awaited_once_with({'id':123,'result':{'decision':'cancel'}})
        self.assertNotIn(123, client.approvals)

    async def test_choices_restricted_and_missing_options_schema_compatible(self):
        client=CodexAppServer('unused','.')
        client._send=AsyncMock()
        method='item/fileChange/requestApproval'
        client.approvals[1]={'method':method,'availableDecisions':['acceptForSession',{'acceptWithExecpolicyAmendment':{}}]}
        with self.assertRaises(CodexError): await client.respond_approval(1,'approve')
        with self.assertRaises(CodexError): await client.respond_approval(1,'reject')
        self.assertIn(1,client.approvals)
        client._send.assert_not_awaited()
        client.approvals[2]={'method':method,'availableDecisions':['decline','cancel']}
        await client.respond_approval(2,'reject')
        self.assertEqual(client._send.await_args.args[0]['result']['decision'],'decline')
        client.approvals[3]={'method':method,'availableDecisions':None}
        await client.respond_approval(3,'approve')
        self.assertEqual(client._send.await_args.args[0]['result']['decision'],'accept')
