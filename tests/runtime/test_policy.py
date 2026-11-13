import tempfile
import subprocess
import unittest
from pathlib import Path
from unittest.mock import AsyncMock
from superagent.runtime.codex import CodexAppServer
from superagent.runtime.workspace import validate_allowed_paths, validate_workspace_changes

class PolicyTest(unittest.TestCase):
    def test_paths_and_git_renames(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as tmp:
            root=Path(tmp).resolve()
            def git(*args): return subprocess.run(['git','-C',str(root),*args],check=True,capture_output=True,text=True,encoding="utf-8").stdout.strip()
            git('init'); git('config','user.email','test@example.invalid'); git('config','user.name','Test')
            (root/'allowed').mkdir(); (root/'other').mkdir()
            (root/'allowed'/'old.txt').write_text('content')
            git('add','.'); git('commit','-m','test（common）：建立路径校验基线'); base=git('rev-parse','HEAD')
            git('mv','allowed/old.txt','other/new.txt'); git('commit','-m','test（common）：调整路径验收样本')
            (root/'allowed'/'new.txt').write_text('new')
            with self.assertRaises(ValueError): validate_workspace_changes(root,base,['allowed'])
            self.assertEqual(set(validate_workspace_changes(root,base,['allowed','other'])), {'allowed/old.txt','other/new.txt','allowed/new.txt'})
            for bad in ('../other/x','/absolute','C:/test','allowed/../x','allowed\\x'):
                with self.assertRaises(ValueError): validate_allowed_paths(root,[bad],['.'])
            with self.assertRaises(ValueError): validate_allowed_paths(root,['allowed/new.txt'],[])

    def test_symlink_rejected(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as tmp:
            root=Path(tmp).resolve(); (root/'target').mkdir()
            try: (root/'link').symlink_to(root/'target', target_is_directory=True)
            except OSError: self.skipTest('symlink creation unavailable')
            with self.assertRaises(ValueError): validate_allowed_paths(root,['link/new'],['.'])

class AttachmentTest(unittest.IsolatedAsyncioTestCase):
    async def test_local_image_and_boundaries(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as tmp:
            root=Path(tmp).resolve(); image=root/'image.png'; image.write_bytes(b'\x89PNG\r\n\x1a\nexample')
            client=CodexAppServer('unused',str(root)); client._request=AsyncMock(return_value={'turn':{'id':'t'}})
            await client.start_turn('thread','inspect',model='gpt-6.1-sol',effort='high',image_paths=[str(image)],attachment_root=str(root))
            self.assertEqual(client._request.await_args.args[1]['model'], 'gpt-6.1-sol')
            self.assertEqual(client._request.await_args.args[1]['effort'], 'high')
            inputs=client._request.await_args.args[1]['input']
            self.assertEqual(inputs[1],{'type':'localImage','path':str(image)})
            image.write_bytes(b'not an image')
            with self.assertRaises(ValueError): await client.start_turn('thread','inspect',image_paths=[str(image)],attachment_root=str(root))
            with self.assertRaises(ValueError): await client.start_turn('thread','inspect',image_paths=[str(root.parent/'other.png')],attachment_root=str(root))
