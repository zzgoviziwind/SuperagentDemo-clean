import asyncio
import hashlib
import json
from pathlib import Path
import sys

import pytest
from superagent.core.scheduler import load_attachments
from superagent.runtime.codex import CodexAppServer

ROOT=Path(__file__).resolve().parents[2]


def test_managed_image_reaches_codex_protocol(tmp_path, monkeypatch):
    root=tmp_path/'attachments'
    root.mkdir()
    image=root/'scan.png'
    data=b'\x89PNG\r\n\x1a\nfixture-content'
    image.write_bytes(data)
    monkeypatch.setenv('SUPERAGENT_ATTACHMENTS_ROOT',str(root))
    artifact=json.dumps({'local_path':str(image),'filename':'scan.png','size':len(data),'content_type':'image/png','sha256':hashlib.sha256(data).hexdigest()})
    images, text, trusted_root=load_attachments([artifact])
    async def exchange():
        client=CodexAppServer([sys.executable,str(ROOT/'tests/core/fake_image_codex.py')],str(tmp_path))
        await client.start()
        try:
            thread=await client.start_thread(str(tmp_path))
            turn=await client.start_turn(thread['id'],text,image_paths=images,attachment_root=trusted_root)
            assert turn['id']=='image-turn'
        finally:
            await client.close()
    asyncio.run(exchange())
    image.write_bytes(data+b'changed')
    with pytest.raises(ValueError): load_attachments([artifact])
