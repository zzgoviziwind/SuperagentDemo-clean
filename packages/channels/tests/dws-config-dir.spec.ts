import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, parse } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { client, host, input } from '../../../apps/server/src/deliveries/tests/harness.ts';
import { verifyDws } from '../dingtalk.ts';

const script=fileURLToPath(new URL('./fake-dws.mjs',import.meta.url));
const policy={direct_messages:'off',group_messages:'off',delivery:'draft',default_project_id:null};

for(const mode of ['selected','unselected','disabled']){
  test('DWS_CONFIG_DIR '+mode+' 经本机 Host 和假 DWS 核对',async()=>{
    const {dir}=input(mode);
    const home=join(dir,'安装私有 HOME'),selected=join(dir,'操作员 所选目录'),log=join(dir,'calls');
    mkdirSync(home);mkdirSync(selected);
    const h=host(dir,false,false,{HOME:home,USERPROFILE:home,SUPERAGENT_API_TOKEN:'fixture-host-only',
      DWS_TEST_HOST_ONLY:'fixture-host-only',...(mode==='unselected'?{}:{DWS_CONFIG_DIR:selected})});
    try{
      const call=client(await h.address());
      await call('/settings','PATCH',{'connectors.dingtalk':{enabled:mode!=='disabled',profile:'offline-profile',
        self_ids:['operator'],executable:[process.execPath,script,log]},dingtalk_response_policy:policy});
      await call('/connectors/dingtalk/group?chat_id=offline-env-probe','GET',undefined,mode==='disabled'?409:200);
    }finally{await h.stop();}
    if(mode==='disabled'){
      assert.equal(existsSync(log),false);
      assert.equal(existsSync(log+'.env'),false);
    }else{
      assert.deepEqual(JSON.parse(readFileSync(log+'.env','utf8')),{configDir:mode==='selected'?selected:null,
        home,hasHostToken:false,hasSiblingVariable:false});
      const args=JSON.parse(readFileSync(log,'utf8').trim());
      assert.deepEqual(args,['--profile','offline-profile','chat','+conversation-info','--group','offline-env-probe','--format','json']);
    }
  });
}

test('无效 DWS_CONFIG_DIR 在启动 DWS 前直接拒绝',async()=>{
  const {dir}=input('invalid'),file=join(dir,'ordinary-file'),log=join(dir,'calls');
  writeFileSync(file,'test');
  const cfg={profile:'offline-profile',self_ids:['operator'],executable:[process.execPath,script,log],cwd:dir};
  const invalid=['relative',join(dir,'missing'),file];
  if(process.platform==='win32') invalid.push(dir.slice(parse(dir).root.length-1), '\\\\localhost\\synthetic');
  for(const selected of invalid){
    await assert.rejects(verifyDws(cfg,{DWS_CONFIG_DIR:selected},AbortSignal.timeout(3000)),{message:'dws_config_dir_invalid'});
  }
  assert.equal(existsSync(log),false);
});
