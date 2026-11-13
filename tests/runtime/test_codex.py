import asyncio
import sys
import tempfile
from unittest.mock import patch
import unittest
from pathlib import Path
from superagent.runtime.codex import CodexAppServer, UnknownOutcome

FAKE = str(Path(__file__).with_name('fake_server.py').resolve())

class ProtocolTest(unittest.IsolatedAsyncioTestCase):
    async def test_roundtrip_and_late_response(self):
        temp = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.addCleanup(temp.cleanup)
        env = patch.dict('os.environ', {'SUPERAGENT_CODEX_HOME': str(Path(temp.name).resolve())})
        env.start()
        self.addCleanup(env.stop)
        client = CodexAppServer([sys.executable, FAKE], '.', {'timeout': 3})
        await client.start()
        self.assertEqual((await client.start_thread('.'))['id'], 'thread')
        self.assertEqual((await client.start_turn('thread', 'hello'))['id'], 'turn')
        event = await asyncio.wait_for(client.queue.get(), 1)
        self.assertEqual(event['id'], 99)
        await client.respond_approval(99, 'reject')
        client.timeout = .1
        with self.assertRaises(UnknownOutcome):
            await client.steer_turn('thread', 'turn', 'later')
        event = await asyncio.wait_for(client.queue.get(), 2)
        self.assertEqual(event['method'], 'runtime/late_response')
        client.timeout = 3
        await client.interrupt_turn('thread', 'turn')
        await client.close()
