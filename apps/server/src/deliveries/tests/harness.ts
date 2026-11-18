import assert from 'node:assert/strict';
import { fork } from 'node:child_process';


import { once } from 'node:events';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { before, after } from 'node:test';

import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { openStorage } from '../../../../../packages/storage/index.ts';
import { seed } from '../../../../../packages/storage/tests/helpers.ts';

const root=mkdtempSync(join(tmpdir(),'投递 HTTP-'));
const executable=join(root,'fixture.mjs'), require=createRequire(import.meta.url);
before(async()=>{
  mkdirSync(join(root,'bin'));
  copyFileSync('packages/windows-job/bin/windows-job-x64.exe',join(root,'bin','windows-job-x64.exe'));
  await build({entryPoints:[fileURLToPath(new URL('./fixture-host.ts',import.meta.url))],outfile:executable,
    alias:{'@superagent/windows-job':'./packages/windows-job/index.mjs'},
    platform:'node',target:'node24',format:'esm',bundle:true,plugins:[{name:'installed-dependencies',setup(b){
      b.onResolve({filter:/^(fastify|@fastify\/static|zod)$/},args=>({path:pathToFileURL(require.resolve(args.path)).href,external:true}));
    }}]});
  await build({entryPoints:['packages/runtime/fixtures/fake-app-server.ts'],outfile:join(root,'fixtures','fake-app-server.ts'),platform:'node',target:'node24',format:'esm',bundle:true});
  await build({entryPoints:['apps/server/src/deliveries/replies.ts'],outfile:join(root,'reply.mjs'),platform:'node',target:'node24',format:'esm',bundle:true,
    alias:{'@superagent/windows-job':'./packages/windows-job/index.mjs'}});
});
export async function decisionPreparer():Promise<typeof import('../replies.ts').prepareReplyDecision>{
  return (await import(pathToFileURL(join(root,'reply.mjs')).href)).prepareReplyDecision;
}
after(()=>rmSync(root,{recursive:true,force:true}));
export function input(name:string) {
  const dir=join(root,name);
  mkdirSync(dir);
  const s=openStorage(join(dir,'superagent.db')), task=seed(s);
  const event=Number(s.db.prepare(`INSERT INTO events(task_id,source,event_type,content,data,created_at) VALUES(?,'redmine','issue.comment','消息',?,?)`)
    .run(task,JSON.stringify({routing_status:'routed',actor_id:'7',issue_id:42,metadata:{redmine_endpoint:'https://fixture.invalid'}}),new Date().toISOString()).lastInsertRowid);
  s.close();
  return {dir,task,event};
}
export function host(dir:string,fixture=true,crash=false,options:NodeJS.ProcessEnv={}) {
  const env:NodeJS.ProcessEnv={};
  for(const key of ['SystemRoot','WINDIR','TEMP','TMP']) if(process.env[key]) env[key]=process.env[key];
  env.SUPERAGENT_USERS_JSON=JSON.stringify([['admin','admin'],['owner','member'],['viewer','viewer'],['other','member']]
    .map(([user_id,role])=>({user_id,role,token:'fixture-'+(user_id==='owner'?'member':user_id)})));
  if(fixture) env.SUPERAGENT_DRIVER='fixture';
  if(crash) env.SUPERAGENT_FIXTURE_EXIT_AFTER_RECEIPT='1';
  Object.assign(env,options);
  const execArgv=options.TEST_FEISHU_LOOPBACK?['--import',new URL('./feishu-loopback.mjs',import.meta.url).href]:[];
  const p=fork(executable,[dir],{env,silent:true,execArgv});
  let errors='';
  p.stderr!.on('data',part=>{errors+=String(part);});
  const exit=once(p,'exit');
  return {p,exit,async address() {
    return Promise.race([once(p,'message').then(([msg])=>String(msg.address)),exit.then(()=>{throw new Error('启动失败 '+errors);})]);
  },async stop() {
    if(p.exitCode!==null || p.signalCode!==null) return;
    p.send('stop');
    const timer=setTimeout(()=>p.kill(),3000);
    try {assert.equal((await exit)[0],0);} finally {clearTimeout(timer);}
  }};
}
export function client(address:string) {
  return async (path:string,method='GET',body?:unknown,status=200,role='admin')=>{
    const response=await fetch(address+'/api/v1'+path,{method,signal:AbortSignal.timeout(7000),
      headers:{authorization:'Bearer fixture-'+role,...(body===undefined?{}:{'content-type':'application/json'})},
      body:body===undefined?undefined:JSON.stringify(body)});
    const data=await response.json() as any;
    assert.equal(response.status,status,JSON.stringify(data));
    return data;
  };
}
