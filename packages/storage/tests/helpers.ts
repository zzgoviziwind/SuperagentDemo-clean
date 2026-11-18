import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { openStorage } from '../index.ts';
import type { Storage } from '../index.ts';

export function seed(s: Storage, kind = 'repair') {
  const now = '2026-11-18T00:00:00.000000+00:00';
  const project = s.db.prepare(`INSERT INTO projects(name,repo_path,repositories,reference_access,reference_dirs,base_branch,test_command,
    allowed_paths,dingtalk_chat_ids,redmine_project_ids,enabled,archived,created_at)
    VALUES('中文项目','合成 目录','[]','workspace','[]','main','','["."]','[]','[]',1,0,?)`).run(now);
  return Number(s.db.prepare(`INSERT INTO tasks(title,kind,owner_id,outcome_unknown,goal,project_id,status,revision,state_version,control_version,
    source,acceptance_criteria,created_at,updated_at) VALUES('合成任务',?,'owner',0,'验收',?,'queued',1,1,1,'web','',?,?)`)
    .run(kind,project.lastInsertRowid,now,now).lastInsertRowid);
}
export function fixture(t: TestContext, kind = 'repair') {
  const dir = mkdtempSync(join(tmpdir(), '存储 验收-'));
  const path = join(dir,'业务.sqlite');
  let time = Date.UTC(2026,10,18);
  const clock = () => time;
  const s = openStorage(path,{clock});
  t.after(() => { s.close(); rmSync(dir,{recursive:true,force:true}); });
  const lease = s.startController('ctrl').lease;
  const task = seed(s,kind);
  return { s, lease, task, dir, path, clock, tick(ms: number) { time += ms; } };
}
export const turn = { threadId:'线程-1', turnId:'轮次-1' };
export const request = { ...turn, method:'item/commandExecution/requestApproval' as const,
  requestId:7, params:{command:'合成动作', threadId:turn.threadId, turnId:turn.turnId} };
export const allow = () => ({allowed:true, senderActorId:'合成账户'});
export function live(f: ReturnType<typeof fixture>) {
  const id = f.s.claimTask(f.lease,f.task)!.id;
  f.s.beginAttempt(f.lease,id);
  f.s.recordWorkspace(f.lease,id,'合成 目录',{'.':'abc'});
  f.s.recordThread(f.lease,id,turn.threadId);
  f.s.prepareTurn(f.lease,id,[{type:'decision',id:17,included:true}]);
  f.s.bindTurn(f.lease,id,turn);
  return id;
}
export function draftFor(s: Storage, task: number) {
  const event = s.db.prepare(`INSERT INTO events(task_id,source,event_type,content,data,created_at)
    VALUES(?,'redmine','issue.comment','合成来信',?,'2026-11-18T00:00:00+00:00')`)
    .run(task,JSON.stringify({routing_status:'routed',issue_id:'123',metadata:{redmine_endpoint:'https://fixture.invalid'}}));
  return s.createDraft(task, Number(event.lastInsertRowid), '中文回复');
}
