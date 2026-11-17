import json
import os
from pathlib import Path
import pytest
from superagent.runtime.readonly_tools import MAX_OUTPUT_BYTES, run_tool


def test_read_search_and_sensitive_paths(tmp_path):
    (tmp_path/'src').mkdir()
    (tmp_path/'src'/'main.py').write_text('first\nneedle here\nlast\n',encoding='utf-8')
    (tmp_path/'.env').write_text('secret',encoding='utf-8')
    (tmp_path/'.git').mkdir()
    (tmp_path/'.git'/'config').write_text('secret',encoding='utf-8')
    (tmp_path/'binary').write_bytes(b'abc\x00needle')
    listing,count=run_tool(tmp_path,'list_files',{'path':'.'})
    assert count==2 and all('.env' not in f['path'] and '.git' not in f['path'] for f in listing['files'])
    content,count=run_tool(tmp_path,'read_file',{'path':'src/main.py'})
    assert count==1 and content['lines'][1]=={'line':2,'text':'needle here','line_truncated':False}
    found,_=run_tool(tmp_path,'search_text',{'path':'.','query':'needle'})
    assert [(x['path'],x['line']) for x in found['matches']]==[('src/main.py',2)]
    for path in ('../outside',str(tmp_path/'src'/'main.py'),'.env','.git/config','src/../.env','src\\main.py','src. '):
        with pytest.raises((ValueError,OSError)): run_tool(tmp_path,'read_file',{'path':path})
    with pytest.raises(ValueError): run_tool(tmp_path,'read_file',{'path':'binary'})


def test_symlinks_and_hardlinks_are_not_followed(tmp_path):
    source=tmp_path/'private'; source.write_text('secret',encoding='utf-8')
    hard=tmp_path/'hard'
    try: os.link(source,hard)
    except OSError: pytest.skip('hard links unavailable')
    with pytest.raises(ValueError): run_tool(tmp_path,'read_file',{'path':'hard'})
    link=tmp_path/'link'
    try: link.symlink_to(source)
    except OSError: return
    with pytest.raises(ValueError): run_tool(tmp_path,'read_file',{'path':'link'})


def test_search_and_read_output_are_bounded(tmp_path):
    (tmp_path/'large.txt').write_text(('needle '+('中'*1200)+'\n')*200,encoding='utf-8')
    for name,args in [('search_text',{'path':'.','query':'needle'}),('read_file',{'path':'large.txt','max_lines':200})]:
        result,_=run_tool(tmp_path,name,args)
        assert result['truncated'] is True
        assert len(json.dumps(result,ensure_ascii=True).encode('ascii')) < MAX_OUTPUT_BYTES


def test_search_reports_unreadable_without_misclassifying_binary(tmp_path, monkeypatch):
    from superagent.runtime import readonly_tools
    (tmp_path/'locked.txt').write_text('needle',encoding='utf-8')
    (tmp_path/'binary').write_bytes(b'\x00binary')
    real=readonly_tools._text_file
    def denied(path, budget):
        if Path(path).name=='locked.txt': raise PermissionError('simulated')
        return real(path,budget)
    monkeypatch.setattr(readonly_tools,'_text_file',denied)
    result,_=readonly_tools.run_tool(tmp_path,'search_text',{'path':'.','query':'needle'})
    assert result['matches']==[]
    assert result['unreadable_files']==1 and result['skipped_binary']==1 and result['truncated'] is True


def test_search_single_file_and_reject_sensitive_or_binary(tmp_path):
    (tmp_path/'src').mkdir()
    (tmp_path/'src'/'one.py').write_text('other\nneedle first\nneedle second\n',encoding='utf-8')
    (tmp_path/'.env').write_text('needle secret',encoding='utf-8')
    (tmp_path/'blob').write_bytes(b'needle\x00secret')
    found,count=run_tool(tmp_path,'search_text',{'path':'src/one.py','query':'needle'})
    assert count==1 and [(x['path'],x['line']) for x in found['matches']]==[('src/one.py',2),('src/one.py',3)]
    assert found['truncated'] is False and found['unreadable_files']==0
    for path in ('.env','../outside',str(tmp_path/'src'/'one.py'),'blob'):
        with pytest.raises((ValueError,OSError)): run_tool(tmp_path,'search_text',{'path':path,'query':'needle'})


def test_single_file_search_limits_output_and_rejects_hardlink(tmp_path):
    source=tmp_path/'long.txt'
    source.write_text(('needle '+('中'*1200)+'\n')*200,encoding='utf-8')
    result,count=run_tool(tmp_path,'search_text',{'path':'long.txt','query':'needle'})
    assert count==1 and result['truncated']
    assert len(json.dumps(result,ensure_ascii=True).encode('ascii'))<MAX_OUTPUT_BYTES
    link=tmp_path/'linked'
    try: os.link(source,link)
    except OSError: return
    with pytest.raises(ValueError): run_tool(tmp_path,'search_text',{'path':'linked','query':'needle'})
