import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { buildSync } from 'esbuild';

const [mode, temp] = process.argv.slice(2);
const root = resolve(import.meta.dirname, '../../..');
const output = join(temp, 'host.mjs');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const report = value => console.log(JSON.stringify(value));

if (mode === 'build') {
  const result = buildSync({ absWorkingDir: root, stdin: { resolveDir: root, contents: [
    "export {buildServer} from './apps/server/src/server.ts'",
    "export {openStorage} from './packages/storage/index.ts'",
    "export {CursorStore,Redmine,RedminePoller} from './packages/channels/index.ts'",
    "export {ingestChannelEvent} from './apps/server/src/deliveries/echo.ts'",
  ].join('\n') }, bundle: true, platform: 'node', target: 'node24', format: 'esm', metafile: true,
    external: ['fastify', '@fastify/static', 'zod'], outfile: output,
    alias: { '@superagent/windows-job': './packages/windows-job/index.mjs' } });
  cpSync(join(root, 'packages/runtime/fixtures'), join(temp, 'fixtures'), { recursive: true });
  mkdirSync(join(temp, 'bin'));
  const exe = 'packages/windows-job/bin/windows-job-x64.exe';
  cpSync(join(root, exe), join(temp, 'bin/windows-job-x64.exe'));
  const files = [...Object.keys(result.metafile.inputs).filter(f => !f.startsWith('<') && !f.startsWith('node_modules/')),
    exe, 'packages/runtime/fixtures/fake-app-server.ts'];
  report({ node: process.version, bundle: sha(readFileSync(output)), inputs: Object.fromEntries(
    [...new Set(files)].sort().map(f => [f, sha(readFileSync(join(root, f)))])) });
  process.exit(0);
}

const { buildServer, openStorage, CursorStore, Redmine, RedminePoller, ingestChannelEvent } = await import(pathToFileURL(output));
const folder = join(temp, mode);
mkdirSync(folder, { recursive: true });
const stamp = '2026-11-18T00:00:00.000000Z';
function seed(db, owner = 'owner') {
  db.prepare(`INSERT INTO projects(id,name,repo_path,repositories,base_branch,test_command,allowed_paths,dingtalk_chat_ids,
    redmine_project_ids,enabled,archived,created_at) VALUES(1,'sample',?,'[]','main','','["."]','[]','[]',1,0,?)`).run(folder,stamp);
  db.prepare(`INSERT INTO tasks(id,title,kind,owner_id,outcome_unknown,goal,project_id,status,revision,state_version,
    control_version,source,acceptance_criteria,created_at,updated_at) VALUES(1,'sample','repair',?,0,'sample',1,'queued',1,1,1,'web','',?,?)`).run(owner,stamp,stamp);
}
async function until(read, wanted) {
  const end = Date.now() + 20000;
  while (Date.now() < end) { if (wanted.includes(read())) return; await delay(35); }
  throw new Error('Expected ' + wanted.join('/') + ', saw ' + read());
}
async function hostTest() {
  const users = [['admin','admin'], ['owner','member'], ['peer','member'], ['reader','viewer']]
    .map(([user_id,role]) => ({ user_id, role, token: 'test-' + user_id }));
  const app = await buildServer({ SUPERAGENT_DATA_DIR: folder, SUPERAGENT_DRIVER: 'fixture',
    SUPERAGENT_USERS_JSON: JSON.stringify(users) });
  const db = new DatabaseSync(join(folder, 'superagent.db'));
  const call = (user, path, payload) => app.inject({ method: payload ? 'POST' : 'GET', url: '/api/v1/' + path,
    headers: { host: 'localhost', authorization: 'Bearer test-' + user }, payload });
  try {
    seed(db);
    if (mode === 'attachments') {
      const make = async byte => {
        const bytes = Buffer.from([137,80,78,71,13,10,26,10,byte]);
        const response = await call('admin', 'field-intake/records', { project_id: 1, title: 'synthetic',
          screenshots: [{ filename: 'fixture.png', mime: 'image/png', base64: bytes.toString('base64') }] });
        assert.equal(response.statusCode, 200, response.body);
        return response.json().id;
      };
      const id = await make(1), other = await make(2);
      const route = 'field-intake/records/' + id + '/screenshots/1';
      const original = JSON.parse(db.prepare('SELECT screenshots FROM field_records WHERE id=?').get(id).screenshots)[0];
      const sibling = JSON.parse(db.prepare('SELECT screenshots FROM field_records WHERE id=?').get(other).screenshots)[0];
      const valid = await call('admin', route);
      assert.equal(sha(valid.rawPayload), original.sha256);
      const wrongUser = await call('peer', route);
      assert.equal(wrongUser.statusCode, 403);
      const outside = join(folder, 'outside.png');
      writeFileSync(outside, readFileSync(sibling.local_path));
      const observations = {};
      const visibility = {};
      for (const user of ['admin','owner','peer','reader']) {
        visibility[user]=(await call(user,'tasks/1/deliveries')).statusCode;
      }
      assert.deepEqual(visibility,{admin:200,owner:200,peer:404,reader:404});
      for (const [label, metadata] of Object.entries({ other_record: sibling,
        outside_root: { ...sibling, local_path: outside }, wrong_digest: { ...original, sha256: sibling.sha256 },
        wrong_size: { ...original, size: original.size + 1 } })) {
        db.prepare('UPDATE field_records SET screenshots=? WHERE id=?').run(JSON.stringify([metadata]),id);
        const response = await call('admin',route);
        observations[label] = response.statusCode;
        assert.equal(response.statusCode,404,label);
        assert.notEqual(sha(response.rawPayload),sibling.sha256);
      }
      assert.equal(sha(readFileSync(outside)),sibling.sha256);
      return { valid:valid.statusCode, other_role:wrongUser.statusCode, denied:observations, draft_list_visibility:visibility };
    }
    const task = () => db.prepare('SELECT * FROM tasks WHERE id=1').get();
    const project = ['project','failed-command'].includes(mode);
    if (project) {
      const validator = mode === 'project'
        ? "require('node:assert/strict').equal(require('node:fs').readFileSync('fixture-value.txt','utf8'),'after\\n')"
        : "process.exitCode = 9";
      db.prepare('UPDATE projects SET repo_path=?, test_command=? WHERE id=1')
        .run(join(folder,'source'),JSON.stringify([process.execPath,'-e',validator]));
    }
    const state = () => task().status;
    const acceptance = { accepted: true, revision: 1 };
    db.prepare(`INSERT OR REPLACE INTO governance_settings(key,value,updated_at) VALUES('scheduler_enabled','true',?)`).run(stamp);
    await until(state,['waiting_approval','failed','waiting_resource']);
    assert.equal(state(),'waiting_approval', String(task().last_error));
    const row = db.prepare('SELECT * FROM approvals WHERE task_id=1').get();
    const path = 'approvals/' + row.id + '/decision';
    const choice = { decision: 'approve', action_hash: row.action_hash };
    const denied = [];
    for (const user of ['peer','reader']) denied.push((await call(user,path,choice)).statusCode);
    assert.deepEqual(denied,[403,403]);
    assert.equal(db.prepare('SELECT status FROM approvals WHERE id=?').get(row.id).status,'pending');
    const result = await Promise.all([call('owner',path,choice),call('owner',path,choice)]);
    const codes = result.map(r => r.statusCode).sort();
    assert.deepEqual(codes,[200,409]);
    await until(state,['review_ready','failed','waiting_resource']);
    const proofs = db.prepare("SELECT content FROM artifacts WHERE task_id=1 AND kind='verification'").all();
    const file = join(task().workspace_path,'fixture-value.txt');
    if (project) assert.equal(readFileSync(join(folder,'source/fixture-value.txt'),'utf8'),'before\n');
    if (mode === 'failed-command') {
      assert.equal(readFileSync(file,'utf8'),'after\n');
      assert.equal(proofs.length,0);
      const acceptanceStatus = (await call('owner','tasks/1/acceptance',acceptance)).statusCode;
      assert.equal(acceptanceStatus,409);
      return {workspace_changed:true,source_untouched:true,configured_exit:9,verification_rows:0,
        status:state(),acceptance:acceptanceStatus};
    }
    if (mode === 'report-only') {
      assert.equal(readFileSync(file,'utf8'),'before\n');
      assert.equal(proofs.length,0);
      const answer = await call('owner','tasks/1/acceptance',acceptance);
      assert.equal(answer.statusCode,409);
      assert.notEqual(state(),'review_ready');
      return { claims_received: readFileSync(join(folder,'peer-observation.txt'),'utf8'), decision:codes,
        status:state(), unknown:task().outcome_unknown, verification_rows:proofs.length, acceptance:answer.statusCode };
    }
    assert.equal(state(),'review_ready',String(task().last_error));
    assert.equal(proofs.length,1);
    const proof = JSON.parse(proofs[0].content);
    assert.equal(proof.repair_verified,true);
    if (project) assert.equal(proof.workspace_kind,'project');
    assert.equal(proof.thread_id,task().codex_thread_id);
    assert.equal(proof.turn_id,task().codex_turn_id);
    assert.deepEqual([proof.test.source,proof.test.exit_code,proof.test.cwd],['host-command',0,task().workspace_path]);
    const before = task().state_version;
    const original = readFileSync(file);
    writeFileSync(file,'changed after verification\n');
    const refused = await call('owner','tasks/1/acceptance',acceptance);
    assert.equal(refused.statusCode,409);
    assert.equal(task().state_version,before);
    assert.equal(state(),'review_ready');
    const eventCount = () => db.prepare("SELECT COUNT(*) n FROM events WHERE task_id=1 AND event_type='acceptance'").get().n;
    assert.equal(eventCount(),0);
    writeFileSync(file,original);
    const accepted = await call('owner','tasks/1/acceptance',acceptance);
    assert.equal(accepted.statusCode,200,accepted.body);
    assert.equal(eventCount(),1);
    assert.equal(state(),'completed');
    return { workspace:proof.workspace_kind, wrong_users:denied, concurrent:codes, verification_rows:proofs.length, independent_test:proof.test.source,
      changed_file:refused.statusCode, restored_file:accepted.statusCode, acceptance_events:eventCount() };
  } finally { await app.close(); db.close(); }
}
if (mode === 'report-only') {
  // Change only the disposable fake peer. It reports ordinary successful completion without a repair.
  const path = join(temp,'fixtures/fake-app-server.ts');
  const peer = readFileSync(path,'utf8');
  const op = "await writeFile(file, repairAfter, 'utf8');";
  assert.equal(peer.split(op).length,2,'fake peer changed; inspect test seam');
  writeFileSync(path,peer.replace(op,`await notify('item/completed', { ...binding, item: {
    type:'commandExecution', id:randomUUID(), command:'fake-test-command', status:'completed', exitCode:0, simulated:true } });
    await writeFile(${JSON.stringify(join(folder,'peer-observation.txt'))}, 'same-turn reported exit 0');`));
}

async function cursorTest() {
  const file = join(folder,'cursor.db');
  let store = openStorage(file);
  const count = () => store.db.prepare("SELECT COUNT(*) n FROM events WHERE source='redmine' AND external_id IS NOT NULL").get().n;
  const deliveries = [], since = [];
  const issue = n => ({id:n, project:{id:5}, assigned_to:{id:7}, updated_on:stamp, subject:'S'+n,
    description:'sample', journals:[{id:10+n,created_on:stamp,notes:'N'+n,details:[]}],attachments:[]});
  const client = {base:'https://offline.invalid',config:{project_ids:[5],user_id:7},verify:async()=>{},
    async *issues(project,watermark) { since.push(watermark); yield issue(1); yield issue(2); } };
  let interrupt = true;
  const emit = async event => {
    deliveries.push(event.external_id);
    if (interrupt && event.issue_id==='2' && event.event_type==='issue.comment') throw Error('synthetic interrupted emit');
    ingestChannelEvent(store.db,event,{});
  };
  const poller = () => new RedminePoller(client,new CursorStore(store.db),emit);
  const signal = new AbortController().signal;
  try {
    const first = poller();
    await assert.rejects(first.pollOnce(signal),/synthetic interrupted emit/);
    assert.equal(first.state.get(first.key),null);
    assert.equal(count(),3);
    store.close();
    store = openStorage(file);
    interrupt = false;
    const second = poller();
    await second.pollOnce(signal);
    assert.equal(count(),4);
    const boundary = second.state.get(second.key);
    assert.ok(boundary);
    await second.pollOnce(signal);
    assert.equal(count(),4);
    assert.equal(Date.parse(since.at(-1)),Date.parse(boundary)-120000);
    return { after_interruption:3, distinct_events:count(), raw_emits:deliveries.length,
      initial_watermark:null, final_watermark:boundary, overlap_seconds:120 };
  } finally { store.close(); }
}

async function channelFiles() {
  const base = 'https://redmine.invalid';
  const client = new Redmine({base_url:base,project_ids:[5],user_id:7},'test-only');
  let project = 5, contentUrl = base+'/attachments/download/13', received = 0;
  const bytes = Buffer.from('offline content');
  const manifest = () => ({issue:{id:33,project:{id:project},attachments:[{id:13,content_url:contentUrl,
    filename:'sample.txt',content_type:'text/plain',filesize:bytes.length}]}});
  const old = globalThis.fetch;
  globalThis.fetch = async url => {
    const path = new URL(url).pathname;
    assert.equal(new URL(url).origin,base);
    if (path==='/users/current.json') return Response.json({user:{id:7}});
    if (path==='/issues/33.json') return Response.json(manifest());
    assert.equal(path,'/attachments/download/13');
    received++;
    return new Response(bytes,{headers:{'content-type':'text/plain'}});
  };
  try {
    const fetchFile = (dir,ids) => client.attachments(33,ids,[5],dir,new AbortController().signal);
    const [saved] = await fetchFile(join(folder,'valid'),[13]);
    assert.equal(saved.sha256,sha(bytes));
    assert.equal(saved.local_path,join(folder,'valid','13','sample.txt'));
    const denied = join(folder,'denied');
    await assert.rejects(fetchFile(denied,[14]),/manifest_missing/);
    project=6;
    await assert.rejects(fetchFile(denied,[13]),/scope_mismatch/);
    project=5; contentUrl='https://other.invalid/attachments/download/13';
    await assert.rejects(fetchFile(denied,[13]),/url_mismatch/);
    assert.equal(received,1);
    assert.equal(existsSync(denied),false);
    assert.deepEqual(readdirSync(folder),['valid']);
    return {body_requests:received,accepted_sha256:saved.sha256,denied_before_body:['unlisted_id','other_project','other_origin'],denied_output_files:0};
  } finally { globalThis.fetch=old; }
}

if (mode === 'cursor') report(await cursorTest());
else if (mode === 'channel-files') report(await channelFiles());
else if (['positive','project','failed-command','report-only','attachments'].includes(mode)) report(await hostTest());
else if (['crash','takeover'].includes(mode)) {
  const dbPath = join(temp,'superagent.db');
  // A past test clock expires the crashed controller's durable lease. OS locks are real.
  const storage = openStorage(dbPath,{stateRoot:temp,clock:()=>Date.now()+(mode==='crash' ? -60000 : 60000)});
  const { db } = storage;
  const { lease } = storage.startController(mode);
  const policy = () => ({allowed:true,senderActorId:'sample'});
  if (mode === 'crash') {
    seed(db);
    const event = db.prepare("INSERT INTO events(task_id,source,event_type,content,data,created_at) VALUES(1,'redmine','issue.comment','sample',?,?)")
      .run(JSON.stringify({routing_status:'routed',issue_id:'33',metadata:{redmine_endpoint:'https://offline.invalid'}}),stamp);
    const draft = storage.createDraft(1,Number(event.lastInsertRowid),'sample');
    storage.decideDraft(draft.draftId,'approve',draft.actionHash);
    const claim = storage.claimDelivery(lease,draft.draftId,draft.actionHash,policy);
    storage.markDispatching(lease,claim,policy);
    const binding = {threadId:'t1',turnId:'v1'};
    const attempt = storage.claimTask(lease,1).id;
    storage.beginAttempt(lease,attempt);
    storage.recordWorkspace(lease,attempt,folder,{'.':'sample'});
    storage.recordThread(lease,attempt,binding.threadId);
    storage.prepareTurn(lease,attempt,[]);
    storage.bindTurn(lease,attempt,binding);
    const approval = storage.requestWorkerApproval(lease,attempt,{...binding,method:'item/commandExecution/requestApproval',
      requestId:1,params:{command:'sample',...binding}});
    storage.dispatchWorkerDecision(lease,attempt,approval.id,{actor:'owner',actionHash:approval.action_hash,decision:'approve',authorize:()=>true});
    writeFileSync(join(temp,'receipt.txt'),'one simulated write\n',{flag:'wx'});
    process.exit(73);
  }
  try {
    const task = db.prepare('SELECT status,outcome_unknown FROM tasks WHERE id=1').get();
    const attempt = db.prepare('SELECT status FROM execution_attempts WHERE task_id=1').get().status;
    const approval = db.prepare("SELECT status FROM approvals WHERE json_extract(action,'$.method') IS NOT NULL").get().status;
    const ledger = db.prepare('SELECT action_hash,result FROM delivery_records').get();
    const draft = db.prepare('SELECT id FROM reply_drafts').get();
    assert.deepEqual([task.status,task.outcome_unknown,attempt,approval,JSON.parse(ledger.result).write_status],
      ['waiting_resource',1,'unknown','unknown','unknown']);
    assert.equal(storage.claimTask(lease,1),null);
    assert.equal(storage.claimDelivery(lease,draft.id,ledger.action_hash,policy),null);
    report({ task:task.status,unknown:task.outcome_unknown,attempt,approval,ledger:'unknown',reclaim:false });
  } finally { storage.close(); }
} else throw Error('Unknown mode');
