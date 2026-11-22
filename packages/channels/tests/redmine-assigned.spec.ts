import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { openStorage } from '../../storage/index.ts';
import { CursorStore } from '../common.ts';
import type { Incoming } from '../common.ts';
import { Redmine, RedminePoller } from '../redmine.ts';

test('Redmine 跨项目监听仅接收当前账号的指派', {timeout:10000}, async () => {
  const storage=openStorage(':memory:');
  const query: URLSearchParams[]=[];
  const server=createServer((req,res)=>{
    const url=new URL(req.url!,'http://127.0.0.1');
    if(url.pathname==='/users/current.json') {
      res.end(JSON.stringify({user:{id:158}}));
    } else if(url.pathname==='/issues.json') {
      query.push(url.searchParams);
      res.end(JSON.stringify({offset:0,total_count:3,issues:[{id:1},{id:2},{id:3}]}));
    } else {
      const issueId=Number(url.pathname.split('/').at(-1)?.split('.')[0]);
      res.end(JSON.stringify({issue:{id:issueId,project:{id:275+issueId},
        assigned_to:{id:issueId===3?161:158},updated_on:'2026-11-19T01:25:36Z'}}));
    }
  });
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  try {
    const {port}=server.address() as {port:number};
    const client=new Redmine({base_url:'http://127.0.0.1:'+port,user_id:158,project_ids:[],
      all_assigned_projects:true,initial_since:'2026-11-19T01:25:00Z'},'fake-key');
    const received:Incoming[]=[];
    const poller=new RedminePoller(client,new CursorStore(storage.db),async event=>{received.push(event);});
    await poller.pollOnce(AbortSignal.timeout(5000));
    assert.equal(query.length,1);
    assert.equal(query[0].get('assigned_to_id'),'158');
    assert.equal(query[0].has('project_id'),false);
    assert.equal(query[0].get('updated_on'),'>=2026-11-19T01:25:00Z');
    assert.deepEqual(received.map(event=>event.project_external_id),['276','277']);
  } finally {
    server.close();
    storage.db.close();
  }
});
