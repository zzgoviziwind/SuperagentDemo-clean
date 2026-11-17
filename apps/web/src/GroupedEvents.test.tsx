// @vitest-environment jsdom
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { GroupedEvents } from './GroupedEvents';
afterEach(()=>{cleanup();vi.unstubAllGlobals();});

it('opens an event with a multi-repository change record without losing the workbench', async () => {
 const group = {id:5,title:'多个仓库的修复事件',status:'review_ready',revision:2,state_version:3};
 const baseSha = {'frontend':'a'.repeat(40), 'backend':'b'.repeat(40)};
 vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('/index')
   ? {items:[{key:'group:5',group,messages:[]}],total:1,has_more:false}
   : {task:group,events:[],artifacts:[{id:22,kind:'changes',revision:2,
       content:JSON.stringify({base_sha:baseSha,diff:'+ fixed'})}]}))));
 render(<GroupedEvents onOpenTask={vi.fn()} onManage={vi.fn()}/>);
 fireEvent.click(await screen.findByRole('button', {name:/多个仓库的修复事件/}));
 fireEvent.click(await screen.findByText('本次处理的其他记录（1）'));
 fireEvent.click(screen.getByText(/系统 · 收集代码改动/));
 expect(screen.getByRole('heading', {name:'多个仓库的修复事件'})).toBeTruthy();
 expect(screen.getByText(baseSha.frontend).closest('li')?.textContent).toBe(`frontend：${baseSha.frontend}`);
 expect(screen.getByText(baseSha.backend).closest('li')?.textContent).toBe(`backend：${baseSha.backend}`);
 expect((screen.getByText('+ fixed').closest('details') as HTMLDetailsElement).open).toBe(true);
});

it('refreshes from the first page without losing filters, loaded rows, or an unsaved event name', async () => {
 const row = (id: number, title: string) => ({
   key: `group:${id}`, group: {id, title, status:'queued', state_version:1}, messages: [],
 });
 const later = row(31, '第二页事件');
 let first = row(1, '第一页旧名称');
 const requests = vi.fn(async (url: string) => {
   const params = new URL(url, 'http://localhost').searchParams;
   const offset = Number(params.get('offset'));
   const combined = Number(params.get('limit')) === 60;
   const result = url.includes('/index')
     ? {items: offset ? [later] : combined ? [first, later] : [first], total: 31, has_more: !offset && !combined}
     : {task: later.group, events: [], artifacts: []};
   return new Response(JSON.stringify(result));
 });
 vi.stubGlobal('fetch', requests);
 render(<GroupedEvents onOpenTask={vi.fn()} onManage={vi.fn()}/>);
 fireEvent.change(screen.getByLabelText('搜索事件或消息内容'), {target:{value:'事件'}});
 await screen.findByRole('button', {name:/第一页旧名称/});
 fireEvent.click(screen.getByRole('button', {name:'加载更多事件'}));
 fireEvent.click(await screen.findByRole('button', {name:/第二页事件/}));
 fireEvent.click(screen.getByRole('button', {name:'重命名'}));
 const draft = screen.getByLabelText('事件名称') as HTMLInputElement;
 fireEvent.change(draft, {target:{value:'还没保存的名称'}});
 first = row(1, '第一页已有更新');
 fireEvent.click(screen.getByRole('button', {name:'刷新事件'}));
 await screen.findByRole('button', {name:/第一页已有更新/});
 expect(screen.getByRole('button', {name:/第二页事件/}).getAttribute('aria-pressed')).toBe('true');
 expect(screen.getByRole('heading', {name:'第二页事件'})).toBeTruthy();
 expect(draft.value).toBe('还没保存的名称');
 expect(requests.mock.calls.filter(([url]) => url.includes('/index')).at(-1)?.[0]).toContain('offset=0');
 expect(requests.mock.calls.filter(([url]) => url.includes('/index')).at(-1)?.[0]).toContain('q=%E4%BA%8B%E4%BB%B6');
});

it('opens narrow details at the heading and restores the list focus and scroll position', async () => {
 const matchMedia = vi.fn(() => ({ matches: true }));
 const scrollTo = vi.fn();
 vi.stubGlobal('matchMedia', matchMedia);
 vi.stubGlobal('scrollTo', scrollTo);
 vi.stubGlobal('scrollY', 360);
 const group = {id:4,title:'窄屏事件',status:'queued',state_version:1};
 vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('/index')
   ? {items:[{key:'group:4',group,messages:[]}],total:1,has_more:false}
   : {task:group,events:[],artifacts:[]}))));
 const {container} = render(<GroupedEvents onOpenTask={vi.fn()} onManage={vi.fn()}/>);
 const option = await screen.findByRole('button', {name:/窄屏事件/});
 const workbench = container.querySelector('.grouped-event-workbench');
 fireEvent.click(option);
 expect(workbench?.getAttribute('data-view')).toBe('detail');
 expect(document.activeElement).toBe(screen.getByRole('heading', {name:'窄屏事件'}));
 fireEvent.click(screen.getByRole('button', {name:'返回事件列表'}));
 expect(workbench?.getAttribute('data-view')).toBe('list');
 expect(document.activeElement).toBe(option);
 expect(scrollTo).toHaveBeenCalledWith({top:360});
 await waitFor(() => expect(option.getAttribute('aria-pressed')).toBe('true'));
});
it('one event contains multiple messages and supports versioned rename',async()=>{
 const messages=[{id:1,source:'redmine',content:'第一条',created_at:'2026-11-15T00:00:00Z',data:{},processing:{status:'pending'}},{id:2,source:'redmine',content:'补充复现',created_at:'2026-11-15T01:00:00Z',data:{},processing:{status:'resolved',evidence:'已核验'}}];
 const group={id:4,title:'导出问题',status:'paused',processing_status:'paused',revision:1,state_version:2};
 const fetch=vi.fn(async(url:string,options?:any)=>new Response(JSON.stringify(url.includes('/index')?{items:[{key:'group:4',group,messages}],total:1,has_more:false}:url.includes('/rename')?{}:{event:messages[0],attempts:[],deliveries:[]})));
 vi.stubGlobal('fetch',fetch);
 render(<GroupedEvents onOpenTask={vi.fn()} onManage={vi.fn()}/>);
 fireEvent.click(await screen.findByRole('button',{name:/导出问题/}));
 expect(screen.getByText('消息 · 2 条消息')).toBeTruthy();
 expect(screen.queryByLabelText('事件处理进度图')).toBeNull();
 expect(screen.queryByText('完成条件：')).toBeNull();
 fireEvent.click(screen.getByText('重命名'));
 fireEvent.change(screen.getByLabelText('事件名称'),{target:{value:'新名称'}});
 fireEvent.click(screen.getByText('保存名称'));
 await screen.findByRole('status');
 const call=fetch.mock.calls.find(c=>String(c[0]).includes('/rename'));
 expect(JSON.parse(call![1].body)).toEqual({title:'新名称',expected_state_version:2});
});

import { deliveryLabel } from './GroupedEvents';
it('separates unsent drafts from successful and uncertain external writes',()=>{
 expect(deliveryLabel({draft:{approval_id:1}},[])).toBe('回复草稿 · 未发送');
 expect(deliveryLabel({draft:{approval_id:1}},[{id:1,status:'approved'}])).toBe('已批准，尚未发送');
 expect(deliveryLabel({record:{result:{write_status:'succeeded'}}},[])).toContain('已发送');
 expect(deliveryLabel({record:{result:{write_status:'unknown'}}},[])).toContain('不要重发');
});
it('restores exact event outside current list and reads full task artifacts',async()=>{
 const group={id:77,title:'跨页事件',status:'completed',revision:2};
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>new Response(JSON.stringify(url.includes('/index')?{items:[],total:0,has_more:false}:url==='/api/v1/event-groups/77'?{group,events:[]}:url==='/api/v1/tasks/77'?{task:group,artifacts:[{id:5,task_id:77,kind:'summary',revision:2,content:'当前版本真实报告'},{id:6,task_id:77,kind:'summary',revision:1,content:'历史报告'}],approvals:[]}:{event:{},attempts:[]}))));
 render(<GroupedEvents initialGroupId="77" onOpenTask={vi.fn()} onManage={vi.fn()}/>);
 expect(await screen.findByRole('heading',{name:'跨页事件'})).toBeTruthy();
 expect(await screen.findAllByText('当前版本真实报告')).toBeTruthy();
 expect(screen.getByText('历史目标的处理记录（1）')).toBeTruthy();
});



it('uses current execution status after cancellation',async()=>{
 const group={id:4,title:'已取消的事件',status:'review_ready',processing_status:'review_ready',revision:1,state_version:2};
 const messages=[{id:5,source:'web',content:'核实进展',data:{},created_at:'2026-11-15T13:00:00Z'}];
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>new Response(JSON.stringify(url.includes('/index')?{items:[{key:'group:4',group,messages}],total:1,has_more:false}:{task:group,events:[],artifacts:[]}))));
 render(<GroupedEvents currentTask={{...group,status:'cancelled',state_version:3}} onOpenTask={vi.fn()} onManage={vi.fn()}/>);
 fireEvent.click(await screen.findByRole('button',{name:/已取消的事件/}));
 expect(await screen.findByText('事件已关闭，原消息和处理记录已保留。需要继续时可使用恢复选项。')).toBeTruthy();
});

it('closes selected receipts, keeps filter counts, and can link a retained message', async () => {
 vi.stubGlobal('scrollTo',vi.fn());
 const messages = [
   {id: 7, source:'dingtalk', state:'triage', content:'测试体检号我们有吗', created_at:'2026-11-16T00:00:00Z', data:{routing_status:'pending_confirmation'}},
   {id: 8, source:'dingtalk', state:'triage', content:'线下还是线上处理', created_at:'2026-11-16T00:01:00Z', data:{routing_status:'pending_confirmation'}},
 ];
 const group = {id: 4, title:'体检项目', status:'paused', processing_status:'paused', revision:2, state_version:4};
 const nextMessage = {...messages[0],id:9,content:'下一条待研判'};
 let closed = false;
 let nextClosed = false;
 const fetch = vi.fn(async (url: string, options?: any) => {
   const current = closed ? messages.map(m=>({...m,state:'closed',triage_reason:'closed_manually'})) : messages;
   const params = new URL(url, 'http://localhost').searchParams;
   const filter = params.get('status');
   const state = closed ? 'closed' : 'triage';
   let output: unknown;
   if (url.includes('/index')) {
     const items = [
       {key:'message:7', state, event:{id:7,project_id:null,worker_id:null}, messages:current},
       {key:'message:9', state:nextClosed?'closed':'triage', event:{id:9}, messages:[{...nextMessage,state:nextClosed?'closed':'triage'}]},
     ].filter(item=>!filter || filter===item.state || (filter==='finished' && item.state==='closed'));
     const closedCount=Number(closed)+Number(nextClosed);
     output = {items,total:items.length,counts:{triage:2-closedCount,closed:closedCount},has_more:false};
   } else if (url.endsWith('/triage-options')) {
     output = {projects:[],groups:[{...group,state_version:3,project:'项目 A'}]};
   } else if (url.endsWith('/triage')) {
     const payload = JSON.parse(options.body);
     if(payload.action==='close') {
       if(payload.event_ids.includes(9)) nextClosed=true;
       else closed=true;
       output={messages: [...messages,nextMessage].filter(m=>payload.event_ids.includes(m.id))
         .map(m=>({...m,state:'closed',triage_reason:'closed_manually'}))};
     } else output={key:'group:4',group,state:'attention',messages:[current[0]]};
   } else if (url.includes('/trace')) {
     output = {event:{id:Number(url.split('/').at(-2))},attempts:[],deliveries:[]};
   } else output = {task:group,events:[],artifacts:[]};
   return new Response(JSON.stringify(output));
 });
 vi.stubGlobal('fetch',fetch);
 render(<GroupedEvents onOpenTask={vi.fn()} onManage={vi.fn()}/>);
 fireEvent.click(await screen.findByRole('button',{name:/待研判 2$/}));
 fireEvent.click(await screen.findByRole('button',{name:/测试体检号我们有吗/}));
 expect(screen.getByRole('heading',{name:'测试体检号我们有吗'})).toBeTruthy();
 expect(screen.getByText('事件 #7 已登记 · 暂未分派项目或 Worker。')).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'关闭，无需处理'}));
 expect(await screen.findByText('事件 #9 已登记 · 暂未分派项目或 Worker。')).toBeTruthy();
 expect(screen.queryByRole('button',{name:/测试体检号我们有吗/})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'关闭，无需处理'}));
 expect(await screen.findByText('暂无匹配事件。')).toBeTruthy();
 fireEvent.click(await screen.findByRole('button',{name:'已结束 2'}));
 fireEvent.click(await screen.findByRole('button',{name:/测试体检号我们有吗/}));
 expect(await screen.findByRole('heading',{name:'已关闭的消息'})).toBeTruthy();
 expect(screen.queryByRole('button',{name:'关闭，无需处理'})).toBeNull();
 expect(screen.queryByRole('button',{name:/^已关闭 \d+$/})).toBeNull();
 fireEvent.click(screen.getByRole('checkbox',{name:/线下还是线上处理/}));
 fireEvent.click(screen.getByRole('button',{name:'关联已有事件'}));
 fireEvent.change(await screen.findByLabelText('已有事件'),{target:{value:'4'}});
 fireEvent.click(screen.getByRole('button',{name:'确认关联'}));
 expect(await screen.findByRole('heading',{name:'体检项目'})).toBeTruthy();
 const mutations = fetch.mock.calls.filter(([url])=>url.endsWith('/triage')).map(([,config])=>JSON.parse(config.body));
 expect(mutations).toEqual([
   {action:'close',event_ids:[7,8]},
   {action:'close',event_ids:[9]},
   {action:'link',event_ids:[7],group_id:4,expected_state_version:3},
 ]);
});

it('batch closes only pending messages from the loaded selection and keeps a rejected selection', async () => {
 const receipt = (id: number, state='triage') => ({
   id,state,source:'dingtalk',content:`来源消息 ${id}`,data:{},
 });
 const first = {key:'message:1',state:'triage',messages:[receipt(1),receipt(2,'active'),receipt(3,'closed')]};
 const second = {key:'message:4',state:'triage',messages:[receipt(4)]};
 let reject = true;
 let closed = false;
 const fetch = vi.fn(async (url: string, options?: RequestInit) => {
   if(url.endsWith('/triage')) {
     if(reject) return Response.json({detail:'正在识别所选消息，请稍后刷新'},{status:409});
     const {event_ids}=JSON.parse(String(options?.body));
     closed=true;
     return Response.json({messages:event_ids.map((id:number)=>receipt(id,'closed'))});
   }
   return Response.json({items:closed?[]:[first,second],total:closed?0:3,counts:{triage:closed?0:3},has_more:!closed});
 });
 vi.stubGlobal('fetch',fetch);
 render(<GroupedEvents initialScope={{status:'triage',project:''}} onOpenTask={vi.fn()} onManage={vi.fn()}/>);
 const selectAll=await screen.findByRole<HTMLInputElement>('checkbox',{name:'全选已加载'});
 fireEvent.click(screen.getByRole('checkbox',{name:'选择事件：来源消息 1'}));
 expect(selectAll.indeterminate).toBe(true);
 fireEvent.click(selectAll);
 fireEvent.click(screen.getByRole('button',{name:'批量关闭（2）'}));
 expect(await screen.findByText(/批量关闭未全部完成/)).toBeTruthy();
 expect(selectAll.checked).toBe(true);
 reject=false;
 fireEvent.click(screen.getByRole('button',{name:'批量关闭（2）'}));
 expect(await screen.findByText(/已关闭 2 条消息/)).toBeTruthy();
 expect(screen.queryByRole('button',{name:/来源消息 1/})).toBeNull();
 const payloads=fetch.mock.calls.filter(([url])=>url.endsWith('/triage')).map(([,options])=>JSON.parse(String(options?.body)));
 expect(payloads).toEqual([{action:'close',event_ids:[1,4]},{action:'close',event_ids:[1,4]}]);
});
