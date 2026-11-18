import type { ReactNode } from 'react';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { request, statusNames } from './api';
import { draftState } from './DeliveriesPanel';
import { deliverySucceeded } from './EventNextStep';
import { EventExecutionProgress, hasVerificationError, type ProgressTarget } from './EventExecutionProgress';
import { reasonText } from './InboxPanel';
import { ProcessingResults } from './ProcessingResults';
import { ConversationContent } from './ConversationContent';
import { EventTriage, triageReason } from './EventTriage';
import { FieldTranscript, fieldTime } from './FieldTranscript';
import { eventBuckets, eventStates, type EventBucket, type EventState, type EventScope } from './eventState';
type Row = Record<string, any>;
const sourceName = (s:string) => ({dingtalk:'钉钉',redmine:'Redmine',web:'工作台',field:'现场'} as Row)[s] ?? s;

function FieldEvidence({ message }: { message: Row }) {
  const id = message.data?.field_record_id;
  if (message.source !== 'field' || !id) return null;
  return <>{(message.data.field_evidence ?? []).filter((ref: Row) => Number.isInteger(ref.start_ms) && Number.isInteger(ref.end_ms))
    .map((ref: Row) => <FieldTranscript key={ref.id} recordId={id} segmentId={ref.id} start_ms={ref.start_ms} end_ms={ref.end_ms}
      media={message.data.field_media} />)}
    {(message.data?.screenshots ?? []).map((image: { id: number; filename: string; at_ms?: number }) =>
    <a className="field-evidence" key={image.id} target="_blank" rel="noreferrer"
      href={`/api/v1/field-intake/records/${encodeURIComponent(id)}/screenshots/${image.id}`}>截图 {image.id}{image.at_ms !== undefined && ` · ${fieldTime(image.at_ms)}`} · {image.filename}</a>)}</>;
}
const groupStateName = (group: Row) => group.kind === 'reply' && group.processing_status === 'review_ready'
  ? group.reply_decision === 'skip' ? '无需回复' : '回复判断已完成'
  : stateName(group.processing_status);
function itemState(item: Row, task?: Row): EventState {
  if (task) {
    if (task.outcome_unknown || ['failed', 'paused', 'waiting_resource'].includes(task.status)) return 'attention';
    if (['queued', 'running'].includes(task.status)) return 'active';
    if (task.status === 'cancelled') return 'closed';
    if (task.status === 'review_ready' && ['reply_sent', 'reply_skipped'].includes(task.processing_status)) return 'completed';
    if (task.status === 'completed' && !task.pending_event_count) return 'completed';
    return 'review';
  }
  return item.state ?? (item.group ? itemState(item, item.group) : 'triage');
}
const stateName = (s:string) => statusNames[s] ?? ({needs_review:'来源待核验',reply_sent:'已回复',reply_skipped:'无需回复',pending_confirmation:'待确认',ignored:'已忽略',routed:'已分派',semantic_pending:'正在识别'} as Row)[s] ?? '待核对';
const pageSize = 30;
const narrowLayout = () => window.matchMedia?.('(max-width: 600px)').matches ?? false;
const isPendingReceipt = (item: Row) => !item.group && itemState(item)==='triage';
const pendingMessageIds = (item: Row): number[] => item.messages
  .filter((message: Row) => message.state==='triage').map((message: Row) => message.id);

const redmineAttributeChanges = new Map([
  ['status_id', '状态变更'], ['assigned_to_id', '指派变更'], ['priority_id', '优先级变更'],
  ['subject', '标题变更'], ['description', '描述变更'], ['tracker_id', '工单类型变更'],
  ['project_id', '所属项目变更'], ['fixed_version_id', '目标版本变更'],
  ['done_ratio', '进度变更'], ['start_date', '开始日期变更'], ['due_date', '截止日期变更'],
]);

const leadMessage = (messages: Row[]) => messages.find(message => message.state !== 'closed') ?? messages[0];

function redmineIssueId(message: Row) {
  if (message.source !== 'redmine') return '';
  const value = message.data?.issue_id;
  const id = typeof value === 'number' || typeof value === 'string' ? String(value) : '';
  return /^[1-9]\d*$/.test(id) ? id : '';
}

function redmineIssueHref(endpoint: unknown, issueId: string) {
  if (!issueId || typeof endpoint !== 'string') return undefined;
  try {
    const url = new URL(endpoint);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return undefined;
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/issues/${issueId}`;
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return undefined;
  }
}

const readableMessage = (value: unknown) => typeof value === 'string'
  ? value.replace(/\[图片消息\]\s*\(mediaId=[^)]*\)/gi, '').trim() : '';
const ownMessage = (m: Row) => m.data?.routing_status === 'self_context' || m.data?.metadata?.self_authored === true;
const messageAuthor = (m: Row) => m.data?.metadata?.sender_name ?? m.data?.actor_id ?? m.data?.actor ?? '发件人未知';
function messageSource(m?: Row) {
  if (!m) return '';
  if (m.source === 'redmine') return ['Redmine', redmineIssueId(m) && `工单 #${redmineIssueId(m)}`].filter(Boolean).join(' · ');
  if (m.source !== 'dingtalk') return sourceName(m.source);
  const meta = m.data?.metadata;
  if (meta?.conversation_type === 'direct') return ['钉钉私聊', meta?.sender_name].filter(Boolean).join(' · ');
  const name = meta?.conversation_title || meta?.chat_name || meta?.conversationTitle || meta?.conversation_name;
  return name ? `钉钉群 · ${name}` : meta?.conversation_type === 'group' ? '钉钉群 · 群名未记录' : '钉钉 · 会话名称未记录';
}

const detailTabs = ['processing', 'messages', 'reply'] as const;
type DetailTab = typeof detailTabs[number];

function eventCardTitle(group: Row | undefined, lead: Row | undefined, messages: Row[]): string {
  const saved = readableMessage(group?.title);
  if (saved && lead?.source === 'field') return saved;
  const sourceText = readableMessage(lead?.content);
  const original = sourceText.replace(/^(?:@[^\s@]+\s+)+/u, '') || sourceText;
  const rawFallback = !saved || sourceText.startsWith(saved);
  const title = rawFallback ? (original.length > 64 ? original.slice(0,63) + '…' : original) : saved;
  if (title) return title;
  if (lead?.source !== 'redmine') return lead?.source === 'dingtalk' && lead.content?.includes('[图片消息]') ? '钉钉图片消息' : '未命名事件';

  const issueId = redmineIssueId(lead);
  const changes = new Set<string>();
  for (const message of messages) {
    if (message !== lead && (!issueId || redmineIssueId(message) !== issueId || message.content?.trim())) continue;
    const details = message.data?.metadata?.details;
    if (!Array.isArray(details)) continue;
    for (const detail of details) {
      if (detail?.property === 'attr') changes.add(redmineAttributeChanges.get(detail.name) ?? '字段变更');
      else if (detail?.property === 'attachment') changes.add('附件变更');
      else if (detail?.property === 'cf') changes.add('自定义字段变更');
      else if (detail?.property === 'relation') changes.add('关联工单变更');
    }
  }
  return `Redmine${issueId ? ` #${issueId}` : ''} · ${[...changes].join('、') || '工单变更'}`;
}

export function GroupedEvents({
  initialEventId, initialGroupId, onSelectGroup, onRefreshTask, onOpenSession, onManage,
  operations, reply, replySnapshot, operationsId, currentTask: taskSnapshot, taskDetail, recovery, controls, supplement, endAction,
  initialScope, onScopeChange, projects = [], canManage = true, overview,
}: {
  initialEventId?: number;
  initialGroupId?: string;
  onSelectGroup?: (id: string | null) => void;
  onRefreshTask?: (id: string) => Promise<void>;
  onOpenTask: (id: string) => void;
  onOpenSession?: (id: string) => void;
  onManage: () => void;
  operations?: ReactNode;
  reply?: ReactNode;
  replySnapshot?: { taskId: string; drafts: Row[] | null };
  controls?: ReactNode;
  endAction?: ReactNode;
  supplement?: ReactNode;
  recovery?: ReactNode;
  operationsId?: string;
  currentTask?: Row;
  taskDetail?: Row | null;
  initialScope?: EventScope;
  onScopeChange?: (scope: EventScope) => void;
  projects?: Row[];
  canManage?: boolean;
  overview?: ReactNode;
}) {
  const [items,setItems]=useState<Row[]>([]),[selected,setSelected]=useState<Row|null>(null),[q,setQ]=useState(''),[more,setMore]=useState(false),[total,setTotal]=useState(0);
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[title,setTitle]=useState(''),[editing,setEditing]=useState(false),[busy,setBusy]=useState(false),[traces,setTraces]=useState<Row[]>([]);
  const [localExecution,setLocalExecution]=useState<Row|null>(null);
  const [listError,setListError]=useState('');
  const [detailError,setDetailError]=useState('');
  const [picked,setPicked]=useState<string[]>([]);
  const [batchNotice,setBatchNotice]=useState('');
  const [source,setSource]=useState('');
  const [status,setStatus]=useState<EventScope["status"]>(initialScope?.status ?? '');
  const [project,setProject]=useState(initialScope?.project ?? '');
  const [filtersOpen,setFiltersOpen]=useState(false);
  const filterCount=Number(!!source)+Number(!!project);
  const hasConditions=!!(q || source || status || project);
  const conditionSummary=[
    q && '关键词搜索',
    status && eventBuckets[status].label,
    source && sourceName(source),
    project && (projects.find(p=>String(p.id)===project)?.name ?? `项目 ${project}`),
  ].filter(Boolean).join(' · ');
  const searchRef=useRef<HTMLInputElement>(null);
  const filtersId=useId();
  const [loading,setLoading]=useState(true);
  const isEmptyResult=!items.length && !loading && !listError;
  const showReset=hasConditions && (items.length>0 || !!listError);
  const [opening,setOpening]=useState(false);
  const [view,setView]=useState<'list'|'detail'>('list');
  const viewRef=useRef<'list'|'detail'>('list');
  const [counts,setCounts]=useState<Partial<Record<EventState, number>>|null>(null);
  const allCount=counts ? Object.values(counts).reduce((sum,n)=>sum+n,0) : total;
  const generation=useRef(0), selection=useRef(0);
  const loadedEnd=useRef(0);
  const selectedItem=useRef<Row|null>(null);
  const previousCategory=useRef<{key:string; state:EventState}|null>(null);
  const listRef=useRef<HTMLDivElement>(null);
  const listHeading=useRef<HTMLHeadingElement>(null);
  const detailRef=useRef<HTMLElement>(null);
  const detailHeading=useRef<HTMLHeadingElement>(null);
  const detailId=useId();
  const [detailTab, setDetailTab] = useState<DetailTab>('processing');
  const progressJump = useRef<ProgressTarget | null>(null);
  const returnPosition=useRef({ page:0, list:0, key:'' });
  const pendingFocus=useRef<'list'|'detail'|null>(null);
  const parentOwnsTask=taskDetail!==undefined;
  const execution=parentOwnsTask ? taskDetail : localExecution;
  const currentTask=parentOwnsTask ? taskDetail?.task : taskSnapshot;
  const eligible=status==='triage' && canManage
    ? items.filter(item=>isPendingReceipt(item) && pendingMessageIds(item).length) : [];
  const pickedItems=eligible.filter(item=>picked.includes(item.key));

  function choose(item: Row | null) {
    if (selectedItem.current?.key !== item?.key) {
      setDetailTab('processing');
      progressJump.current = null;
    }
    selectedItem.current=item;
    setSelected(item);
  }

  function enterDetail(moveFocus: boolean, key = '') {
    const narrow=narrowLayout();
    if(viewRef.current==='list' || !narrow) {
      returnPosition.current={page:window.scrollY,list:listRef.current?.scrollTop ?? 0,key};
    } else if(key) {
      returnPosition.current.key=key;
    }
    detailRef.current?.scrollTo?.({top:0});
    if(moveFocus || narrow) pendingFocus.current='detail';
    viewRef.current='detail';
    setView('detail');
  }

  function returnToList() {
    if(opening) {
      selection.current++;
      setOpening(false);
    }
    if (!narrowLayout()) {
      selection.current++;
      choose(null);
      setEditing(false);
      setError('');
      setNotice('');
      setDetailError('');
      onSelectGroup?.(null);
    }
    pendingFocus.current='list';
    viewRef.current='list';
    setView('list');
  }

  function openOverview() {
    selection.current++;
    choose(null);
    setOpening(false);
    setEditing(false);
    setError('');
    setNotice('');
    setDetailError('');
    onSelectGroup?.(null);
    enterDetail(true);
  }

  useLayoutEffect(() => {
    const detailFocus = detailHeading.current ?? (!selected && !opening && overview ? detailRef.current : null);
    if(pendingFocus.current==='detail' && view==='detail' && detailFocus) {
      pendingFocus.current=null;
      detailFocus.focus();
    } else if(pendingFocus.current==='list' && view==='list') {
      pendingFocus.current=null;
      const {key,page,list}=returnPosition.current;
      const origin=Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('[data-event-key]') ?? [])
        .find(node=>node.dataset.eventKey===key);
      (origin ?? listHeading.current)?.focus({preventScroll:true});
      if(listRef.current) listRef.current.scrollTop=list;
      window.scrollTo({top:page});
    }
  },[view,selected?.key,opening,overview]);

  const load = useCallback(async (start=0, until=start+pageSize) => {
    const seq=++generation.current;
    setLoading(true);
    try {
      const byKey=new Map<string,Row>();
      let cursor=start;
      let data:Row;
      do {
        const limit=Math.min(90,until-cursor);
        const params=new URLSearchParams({q,offset:String(cursor),source,status});
        if (project) params.set('project_id',project);
        if(limit!==pageSize) params.set('limit',String(limit));
        data=await request<Row>(`/event-groups/index?${params}`);
        if(seq!==generation.current)return;
        if(!Array.isArray(data.items))throw new Error('事件列表接口返回异常，请确认后端已更新并刷新。');
        for(const item of data.items) byKey.set(item.key,item);
        cursor+=limit;
      } while(data.has_more && cursor<until);
      const rows=[...byKey.values()];
      setItems(previous => start ? [...new Map([...previous, ...rows].map(item=>[item.key,item])).values()] : rows);
      loadedEnd.current=cursor;
      setTotal(data.total);
      setCounts(data.counts ?? null);
      setMore(data.has_more);
      setListError('');
      return rows;
    }catch(e){if(seq===generation.current)setListError((e as Error).message);}
    finally{if(seq===generation.current)setLoading(false);}
  },[q,source,status,project]);

  useEffect(()=>{
    const timer=setTimeout(()=>{void load();},200);
    return()=>{clearTimeout(timer);generation.current++;};
  },[load]);

  useEffect(()=>()=>{selection.current++;},[]);

  async function readDetails(item: Row, seq: number, refreshTask = false) {
    const messages=item.messages.filter((m:Row)=>['dingtalk','redmine'].includes(m.source));
    const task=async()=>{
      if(!item.group) return;
      if(parentOwnsTask) {
        if(refreshTask) await onRefreshTask?.(String(item.group.id));
      } else {
        const result=await request<Row>(`/tasks/${item.group.id}`);
        if(seq===selection.current) setLocalExecution(result);
      }
    };
    const results=await Promise.allSettled([task(),...messages.map((m:Row)=>request<Row>(`/events/${m.id}/trace`))]);
    if(seq!==selection.current)return;
    const [taskResult,...messageResults]=results;
    setTraces(messageResults.flatMap(r=>r.status==='fulfilled'&&r.value?[r.value]:[]));
    setDetailError([
      taskResult.status==='rejected' ? '执行结果读取失败，请刷新重试。' : '',
      messageResults.some(r=>r.status==='rejected') ? '部分消息的处理依据读取失败，请刷新重试。' : '',
    ].filter(Boolean).join(' '));
  }

  async function open(item:Row, notifyParent = true, focus = false) {
    const seq=++selection.current;
    const changed=selectedItem.current?.key!==item.key;
    choose(item);
    setOpening(false);
    enterDetail(focus,item.key);
    if(changed) {
      setLocalExecution(null);
      setTitle(item.group?.title??'');
      setEditing(false);
      setTraces([]);
      setError('');
      setNotice('');
    }
    setDetailError('');
    if(notifyParent) onSelectGroup?.(item.group ? String(item.group.id) : null);
    await readDetails(item,seq);
  }

  useEffect(()=>{
    if(initialEventId && !selectedItem.current){
      const found=items.find(i=>i.messages.some((m:Row)=>m.id===initialEventId));
      if(found)void open(found);
    }
  },[items,initialEventId]);

  async function fetchGroup(id: string | number) {
    const data=await request<Row>(`/event-groups/${encodeURIComponent(id)}`);
    if(!data.group || String(data.group.id)!==String(id) || !Array.isArray(data.events)) {
      throw new Error('无法读取指定事件，请刷新后重试。');
    }
    return {key:`group:${id}`,group:data.group,messages:data.events.filter((e:Row)=>e.visible_message ?? e.requires_resolution)};
  }

  async function openGroup(id: string | number, notifyParent = false) {
    const seq=++selection.current;
    choose(null);
    setOpening(true);
    enterDetail(true);
    setDetailError('');
    try {
      const item=await fetchGroup(id);
      if(seq===selection.current) await open(item,notifyParent,true);
    } catch(e) {
      if(seq!==selection.current)return;
      setOpening(false);
      setDetailError((e as Error).message);
    }
  }

  async function refresh() {
    const item=selectedItem.current;
    const seq=item ? ++selection.current : selection.current;
    const rows=await load(0,Math.max(pageSize,loadedEnd.current));
    if(!item || seq!==selection.current) return;
    const updated=rows?.find(r=>r.key===item.key || (!item.group && !r.group &&
      r.messages.some((m:Row)=>item.messages.some((old:Row)=>old.id===m.id))));
    let latest=updated ?? item;
    if(!updated && item.group) {
      try {latest=await fetchGroup(item.group.id);}
      catch(e) {if(seq===selection.current)setDetailError((e as Error).message);return;}
    }
    if(seq!==selection.current)return;
    choose(latest);
    await readDetails(latest,seq,true);
  }
  async function closeMessages(ids: number[], batch: boolean) {
    setBusy(true);
    setError('');
    setNotice('');
    setBatchNotice('');
    const seq=selection.current;
    const current=selectedItem.current;
    const updates=new Map<number, Row>();
    let failure='';
    try {
      // The existing endpoint commits at most 100 messages per request.
      for(let offset=0;offset<ids.length;offset+=100) {
        const result=await request<Row>('/event-groups/triage',{action:'close',event_ids:ids.slice(offset,offset+100)});
        for(const message of result.messages) updates.set(message.id,message);
      }
    } catch(e) {
      failure=(e as Error).message;
    }

    function applyClose(item: Row) {
      if(item.group || !item.messages.some((m:Row)=>updates.has(m.id))) return item;
      const messages=item.messages.map((m:Row)=>updates.get(m.id) ?? m);
      const state=messages.some((m:Row)=>m.state==='triage')?'triage':messages.some((m:Row)=>m.state==='active')?'active':'closed';
      return {...item,messages,state};
    }
    try {
      if(updates.size) {
        const changed=items.map(applyClose);
        const remaining=changed.filter(item=>status!=='triage' || itemState(item)==='triage');
        setItems(remaining);
        const finished=new Set(items.filter((item,index)=>item!==changed[index] && !isPendingReceipt(changed[index])).map(item=>item.key));
        setPicked(previous=>previous.filter(key=>!finished.has(key)));
        const latest=current && applyClose(current);
        const selectedClosed=latest && latest!==current && latest.state!=='triage';
        if(seq===selection.current && latest!==current && !selectedClosed) {
          void open(latest!,false);
        }
        if(seq===selection.current && selectedClosed) {
          const index=items.findIndex(item=>item.key===current!.key);
          const next=changed.slice(index+1).find(isPendingReceipt) ?? changed.slice(0,Math.max(0,index)).reverse().find(isPendingReceipt);
          if(next) void open(next,false);
          else {
            returnToList();
            choose(null);
          }
        }
        const nextSeq=selection.current;
        const reload=load(0,Math.max(pageSize,loadedEnd.current));
        if(selectedClosed && !selectedItem.current && more) {
          const rows=await reload;
          const next=rows?.find(isPendingReceipt);
          if(next && nextSeq===selection.current) void open(next,false);
        }
      }
      if(batch) setBatchNotice([
        updates.size ? `已关闭 ${updates.size} 条消息，可在「已关闭」查看。` : '',
        failure ? `批量关闭未全部完成：${failure}` : '',
      ].filter(Boolean).join(' '));
      else if(failure) setError(failure);
    } finally {
      setBusy(false);
    }
  }

  async function triage(action: 'close'|'create'|'link', ids: number[], options: Row = {}) {
    if(action==='close') return closeMessages(ids,false);
    const seq=selection.current;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result=await request<Row>('/event-groups/triage',{action,event_ids:ids,...options});
      await load(0,Math.max(pageSize,loadedEnd.current));
      if(seq!==selection.current)return;
      if(result.group){
        await open(result);
        setNotice(action==='create'?'事件已创建，原消息已关联。':'原消息已关联到已有事件。');
      }
    }catch(e){setError((e as Error).message);}
    finally{setBusy(false);}
  }
  async function retry(id:number) {
    setBusy(true);
    setError('');
    try{
      const result=await request<Row>(`/events/${id}/retry-routing`,{});
      const taskId=result.task_id ?? result.data?.target_task_ids?.[0];
      await refresh();
      if(taskId)await openGroup(taskId,true);
      setNotice('已重新检查，请查看最新分派结果。');
    }catch(e){setError((e as Error).message);}
    finally{setBusy(false);}
  }
  async function rename() {
    if(!group || !selected) return;
    const key=selected.key;
    setBusy(true);
    setError('');
    try {
      await request(`/event-groups/${group.id}/rename`,{title,expected_state_version:group.state_version});
      if(selectedItem.current?.key!==key)return;
      setEditing(false);
      await refresh();
      if(selectedItem.current?.key===key) setNotice('事件名称已保存；处理目标和执行要求未改变。');
    } catch(e) {setError((e as Error).message);}
    finally {setBusy(false);}
  }
  const liveGroup = selected?.group && [execution?.task, currentTask]
    .filter(t => t && String(t.id) === String(selected.group.id) && t.state_version >= selected.group.state_version)
    .sort((a,b) => b!.state_version - a!.state_version)[0];
  const group=selected?.group ? {...selected.group, ...liveGroup} : undefined;
  const selectedMessages: Row[] = selected?.messages ?? [];
  const selectedLead = leadMessage(selectedMessages);
  const detailTitle = !group && selected?.state === 'closed' && selectedLead?.source !== 'redmine'
    ? '已关闭的消息' : group || selectedLead?.source === 'redmine' || selectedLead?.source === 'dingtalk'
    ? eventCardTitle(group, selectedLead, selectedMessages)
    : selected?.event ? '事件研判' : '消息研判';
  if (group) {
    group.processing_status = group.status === 'completed' && group.pending_event_count ? 'needs_review' : group.status;
    const detailEvents: Row[] | undefined = String(execution?.task?.id) === String(group.id)
      && execution?.task?.state_version === group.state_version ? execution?.events : undefined;
    if (group.kind === 'reply' && group.status === 'review_ready' && !group.outcome_unknown) {
      const current = detailEvents?.filter(e => e.source === 'runtime' && e.data?.revision === group.revision
        && e.data?.control_version === group.control_version);
      if (current?.some(e => e.event_type === 'reply_sent')) group.processing_status = 'reply_sent';
      else if (current?.reverse().find(e => e.event_type === 'reply_decision')?.data?.decision === 'skip') group.processing_status = 'reply_skipped';
      else if (!current && selected?.group && selected.group.state_version === group.state_version) group.processing_status = selected.group.processing_status;
    }
  }
  const selectedCategory = group ? itemState(selected!,group) : undefined;
  useEffect(()=>{
    if (!selected || !selectedCategory) { previousCategory.current=null; return; }
    const previous=previousCategory.current;
    previousCategory.current={key:selected.key,state:selectedCategory};
    if(previous && previous.key===selected.key && previous.state!==selectedCategory && loadedEnd.current){
      void load(0,loadedEnd.current);
    }
  },[selected?.key,selectedCategory,load]);
  const deliveries = [...new Map(traces.flatMap(t => t.deliveries ?? []).map(d => [d.draft?.id ?? d, d])).values()];
  const selectedExecution=execution && group && String(execution.task?.id)===String(group.id) ? execution : null;
  const ownsOperations = !!group && operationsId === String(group.id);
  function selectDetailTab(tab: DetailTab) {
    setDetailTab(tab);
    detailRef.current?.scrollTo?.({ top: 0 });
  }
  function jumpToProgressTarget(target: ProgressTarget) {
    const tab = target === 'messages' ? 'messages' : target === 'reply'
      || (target === 'approval' && !detailRef.current?.querySelector('[data-execution-approval]')) ? 'reply' : 'processing';
    if (tab === detailTab) focusProgressTarget(target);
    else {
      progressJump.current = target;
      selectDetailTab(tab);
    }
  }
  useLayoutEffect(() => {
    if (progressJump.current) {
      const target = progressJump.current;
      progressJump.current = null;
      focusProgressTarget(target);
    }
  }, [detailTab]);
  function focusProgressTarget(target: ProgressTarget) {
    const container = detailRef.current;
    const selectors: Record<ProgressTarget, string> = {
      supplement: '[data-event-supplement] > details',
      results: '.processing-results',
      verification: '[data-event-verification]',
      messages: '.group-timeline',
      reply: '.event-reply-section',
      approval: '.event-reply-section',
    };
    const destination = target === 'approval'
      ? container?.querySelector<HTMLElement>('[data-execution-approval]') ?? container?.querySelector<HTMLElement>(selectors.approval)
      : container?.querySelector<HTMLElement>(selectors[target]) ??
        (target === 'verification' ? container?.querySelector<HTMLElement>(selectors.results) : null);
    if (!destination) return;
    if (destination instanceof HTMLDetailsElement) destination.open = true;
    const focus = target === 'supplement' ? destination.querySelector('textarea') ?? destination
      : destination instanceof HTMLDetailsElement ? destination.querySelector('summary') ?? destination : destination;
    if (!focus.matches('textarea, summary, [tabindex]')) focus.tabIndex = -1;
    focus.focus({ preventScroll: true });
    destination.scrollIntoView?.({ block: 'start' });
  }
  const visibleMessages:Row[] = [...(selected?.messages ?? [])];
  const knownIds = new Set(visibleMessages.map(m=>m.id));
  for (const m of selectedExecution?.events ?? []) {
    const own = ownMessage(m);
    const supplement = m.source === 'web' && ['message', 'goal_changed', 'project_rebound'].includes(m.event_type);
    if (!knownIds.has(m.id) && (own || supplement)) {
      visibleMessages.push({...m, requires_resolution: false, processing: {status: 'pending'}});
      knownIds.add(m.id);
    }
  }
  visibleMessages.sort((a,b) => Date.parse(a.data?.occurred_at ?? a.created_at) - Date.parse(b.data?.occurred_at ?? b.created_at) || a.id-b.id);
  const ownMessages = visibleMessages.filter(m => m.source === 'dingtalk' && ownMessage(m));
  const snapshot = group && replySnapshot?.taskId === String(group.id) ? replySnapshot : undefined;
  const hasChat = visibleMessages.some(m => m.source === 'dingtalk');
  const hasChannel = visibleMessages.some(m => ['dingtalk', 'redmine'].includes(m.source));
  const replyCounts = new Map<string, number>();
  (snapshot?.drafts ?? []).forEach(d => {
    const approval = d.approval ?? selectedExecution?.approvals?.find((a: Row) => a.id === d.approval_id);
    const state = draftState(d, approval, group);
    replyCounts.set(state, (replyCounts.get(state) ?? 0) + 1);
  });
  const sentCount = replyCounts.get('已回复') ?? 0;
  const replyText = [
    ...['待审批', '已批准，待发送', '发送结果未知', '回复发送失败'].flatMap(state => replyCounts.has(state) ? [`${state} ${replyCounts.get(state)}`] : []),
    snapshot?.drafts === null ? '回复记录读取失败'
      : snapshot ? sentCount ? `渠道确认已回复 ${sentCount}` : '暂无渠道确认回复'
      : deliveries.some(deliverySucceeded) ? '有渠道确认回复' : group && reply ? '正在读取回复' : '暂无已确认回复',
    ownMessages.length ? `本账号发言 ${ownMessages.length}` : '',
  ].filter(Boolean).join(' · ');
  const allArtifacts:Row[]=selectedExecution?.artifacts??[];
  useEffect(()=>{
    if(initialGroupId && selectedItem.current?.key!==`group:${initialGroupId}`) {
      void openGroup(initialGroupId);
      if(loadedEnd.current) void load(0,loadedEnd.current);
    }
  },[initialGroupId]);
  async function syncOwnMessages(id: number) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await request<{added: number}>(`/event-groups/${id}/sync-own-dingtalk`, {});
      await refresh();
      if (String(selectedItem.current?.group?.id) === String(id)) {
        setNotice(result.added ? `已同步 ${result.added} 条本账号发言。` : '没有可新增到此事件的本账号发言。');
      }
    } catch (e) {
      if (String(selectedItem.current?.group?.id) === String(id)) setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function resolve(id: number, evidence: string, status: 'resolved'|'dismissed') {
    if(!group)return;
    setBusy(true);
    try{
      await request(`/event-groups/${group.id}/events/${id}/resolution`,{status,evidence,expected_state_version:group.state_version});
      await refresh();
      setNotice(status==='dismissed'?'已标记为无需处理。':'已记录核对结果。');
    }catch(e){setError((e as Error).message);}
    finally{setBusy(false);}
  }
  function changeFilter<T extends string>(setter:(value:T)=>void, value:T) {
    generation.current++;
    setter(value);
    loadedEnd.current=0;
    setLoading(true);
    setPicked([]);
    setBatchNotice('');
  }
  function chooseStatus(value: EventScope["status"]) {
    if (value===status) return;
    changeFilter(setStatus,value);
    onScopeChange?.({status:value,project});
  }
  function resetConditions() {
    changeFilter(setQ,'');
    setSource('');
    setStatus('');
    setProject('');
    onScopeChange?.({status:'',project:''});
    searchRef.current?.focus();
  }
  return (
    <div className="event-workbench grouped-event-workbench" data-view={view}>
      <section className="event-index">
        <div className="event-index-controls">
          <div className="section-heading"><h2 ref={listHeading} tabIndex={-1}>事件 <span className="count">{total}</span></h2><button disabled={loading||busy} onClick={()=>void refresh()}>刷新事件</button></div>
          {overview && <button className="event-overview-link" type="button" aria-controls={detailId} onClick={openOverview}>查看架构总览</button>}
          <div className="event-search-row">
            <input ref={searchRef} type="search" aria-label="搜索事件或消息内容" disabled={busy} value={q} onChange={e=>changeFilter(setQ,e.target.value)} placeholder="搜索事件或消息" />
            <button type="button" className="event-scope-toggle" aria-expanded={filtersOpen} aria-controls={filtersId} data-filtered={filterCount>0}
              onClick={()=>setFiltersOpen(open=>!open)}>筛选{filterCount ? `（${filterCount}）` : ''}</button>
          </div>
          <div className="event-applied-conditions" aria-label={hasConditions ? '当前筛选条件' : undefined}>
            <span title={conditionSummary || undefined}>{conditionSummary || '未应用筛选'}</span>
            <button type="button" data-concealed={!showReset} disabled={busy || !showReset} onClick={resetConditions}>重置条件</button>
          </div>
          <div id={filtersId} className="event-list-filters" hidden={!filtersOpen}>
            <label>来源<select disabled={busy} value={source} onChange={e=>changeFilter(setSource,e.target.value)}><option value="">全部来源</option><option value="dingtalk">钉钉</option><option value="redmine">Redmine</option><option value="web">工作台</option><option value="field">现场</option></select></label>
            {!!projects.length && <label>项目范围<select disabled={busy} value={project} onChange={e=>{
              changeFilter(setProject,e.target.value);
              onScopeChange?.({status,project:e.target.value});
            }}><option value="">全部项目</option>{projects.map(p=><option key={p.id} value={String(p.id)}>{p.name}</option>)}</select></label>}
          </div>
          <div className="event-status-filters" role="group" aria-label="按状态筛选事件">
            <button disabled={busy} aria-pressed={!status} onClick={()=>chooseStatus('')}>全部 <b>{allCount}</b></button>
            {(Object.keys(eventBuckets) as EventBucket[]).map(key => {
              const { label, states } = eventBuckets[key];
              return <button key={key} disabled={!counts||busy}
                aria-pressed={status===key} onClick={()=>chooseStatus(key)}>
                {label} <b>{counts ? states.reduce((sum,state) => sum + (counts[state] ?? 0), 0) : '—'}</b>
              </button>;
            })}
          </div>
          {!!eligible.length && <div className="event-batch-controls">
            <label><input type="checkbox" checked={pickedItems.length===eligible.length}
              ref={node=>{if(node) node.indeterminate=pickedItems.length>0 && pickedItems.length<eligible.length;}}
              disabled={busy||loading}
              onChange={e=>setPicked(e.target.checked ? eligible.map(item=>item.key) : [])} />全选已加载</label>
            <button type="button" disabled={busy||loading||!pickedItems.length}
              onClick={()=>void closeMessages([...new Set(pickedItems.flatMap(pendingMessageIds))],true)}>
              批量关闭（{pickedItems.length}）
            </button>
          </div>}
          {batchNotice && <p role="status">{batchNotice}</p>}
          {listError && <p role="alert">{listError}</p>}
        </div>
        <div className="event-list" ref={listRef} aria-busy={loading}>
          {items.map(item=>{
            const msgs:Row[]=item.messages;
            const last=msgs.at(-1);
            const lead=leadMessage(msgs);
            const live= String(item.group?.id) === String(currentTask?.id) && currentTask && currentTask.state_version >= item.group.state_version
              ? {...item.group, ...currentTask}
              : undefined;
            const state=itemState(item,live);
            const label=eventCardTitle(item.group,lead,msgs);
            const excerpt=readableMessage(last?.content);
            return <div className="event-list-row" key={item.key}>
              {status==='triage' && canManage && isPendingReceipt(item) && !!pendingMessageIds(item).length &&
                <input type="checkbox" aria-label={`选择事件：${label}`} checked={picked.includes(item.key)}
                  disabled={busy||loading} onChange={e=>{
                    const checked=e.target.checked;
                    setPicked(previous=>checked ? [...previous,item.key] : previous.filter(key=>key!==item.key));
                  }} />}
              <button className="event-choice" data-state={state} data-event-key={item.key} aria-controls={detailId} aria-pressed={selected?.key===item.key} disabled={busy} onClick={()=>void open(item)}>
              {lead?.source === "dingtalk" && <small className="event-origin">{messageSource(lead)}</small>}
              <div><strong>{label}</strong>
                <span className="badge event-state-badge" data-state={state}>{eventStates[state]}</span></div>
              {excerpt && <p className="event-card-excerpt">{excerpt}</p>}
              <small>{msgs.length} 条消息 · {[...new Set(msgs.map(m=>sourceName(m.source)))].join('、')} · {last?.created_at?new Date(last.created_at).toLocaleString('zh-CN'):''}</small>
              {item.group?.pending_event_count>0&&<small> · {item.group.pending_event_count} 条待核验</small>}
              </button>
            </div>;
          })}
          {!items.length && loading && <p role="status">正在读取事件…</p>}
          {isEmptyResult && <div className="event-list-empty">
            <p role="status">{hasConditions ? '暂无匹配事件。' : '暂无事件。'}</p>
            <p className="muted">{hasConditions ? '试试其他关键词，或重置搜索和筛选条件。' : '新收到的消息和提出的事件会出现在这里，可刷新查看。'}</p>
            {hasConditions && <button type="button" disabled={busy} onClick={resetConditions}>查看全部事件</button>}
          </div>}
          {more&&<button disabled={busy||loading} onClick={()=>void load(loadedEnd.current)}>加载更多事件</button>}
        </div>
      </section>
      <section className="event-detail" id={detailId} ref={detailRef} tabIndex={-1}>
      {view==='detail' && <button type="button" className="event-list-back" onClick={returnToList}>返回事件列表</button>}
      {error&&<p role="alert">{error}</p>}
      {notice&&<p role="status">{notice}</p>}
      {detailError&&<p role="alert">{detailError}</p>}
      {opening ? <p role="status">正在读取事件详情…</p> : !selected ? (
        detailError && initialGroupId ? <button onClick={()=>void openGroup(initialGroupId)}>重试读取事件</button> :
          !detailError && (overview ?? <p>选择一个事件，查看关联消息与处理依据。</p>)
      ) : <>
      {selectedLead && <p className="event-origin">{messageSource(selectedLead)}{group && <> · 事件 #{group.id}</>}</p>}
      <div className="section-heading"><h2 ref={detailHeading} tabIndex={-1}>{detailTitle}</h2>{group&&canManage&&<button onClick={()=>{
        if(!editing) setTitle(group.title ?? '');
        setEditing(!editing);
      }}>重命名</button>}</div>
      {editing&&<form onSubmit={e=>{e.preventDefault();void rename();}}><label>事件名称<input maxLength={300} value={title} onChange={e=>setTitle(e.target.value)} /></label><button disabled={busy||!title.trim()}>保存名称</button></form>}
      {selectedLead?.source === 'dingtalk' && <p className="event-source-preview">
        <strong>{messageAuthor(selectedLead)}</strong>：{readableMessage(selectedLead.content).slice(0,96) || '图片消息'}
      </p>}
      {hasChannel && <div className="event-reply-overview">
        <strong>回复状态</strong><span>{replyText}</span>
        <button type="button" onClick={() => {
          selectDetailTab('reply');
          detailRef.current?.querySelector<HTMLElement>(`[id="${detailId}-tab-reply"]`)?.focus({ preventScroll: true });
        }}>查看回复</button>
      </div>}
      <div className="event-detail-tabs" role="tablist" aria-label="事件详情">
        {detailTabs.map((tab, index) => <button key={tab} type="button" role="tab"
          id={`${detailId}-tab-${tab}`} aria-controls={`${detailId}-panel-${tab}`}
          aria-selected={detailTab === tab} tabIndex={detailTab === tab ? 0 : -1}
          onClick={() => selectDetailTab(tab)} onKeyDown={e => {
            const next = e.key === 'ArrowRight' ? (index + 1) % detailTabs.length
              : e.key === 'ArrowLeft' ? (index + detailTabs.length - 1) % detailTabs.length
              : e.key === 'Home' ? 0 : e.key === 'End' ? detailTabs.length - 1 : -1;
            if (next < 0) return;
            e.preventDefault();
            selectDetailTab(detailTabs[next]);
            (e.currentTarget.parentElement?.children[next] as HTMLElement)?.focus({ preventScroll: true });
          }}>{tab === 'processing' ? '处理记录' : tab === 'messages' ? `消息 (${visibleMessages.length})` :
            `渠道回复${replyCounts.has('待审批') ? ` · ${replyCounts.get('待审批')} 待审批` : ''}`}</button>)}
      </div>
      <div role="tabpanel" className="event-detail-panel" hidden={detailTab !== 'processing'} tabIndex={0}
        id={`${detailId}-panel-processing`} aria-labelledby={`${detailId}-tab-processing`}>
      {group?<section className="event-action-strip" aria-label="执行进度"><div className="section-heading"><span className="badge event-state-badge" data-state={itemState(selected,group)}>{group.status === 'cancelled' ? '已关闭' : hasVerificationError(group) ? '核验受阻' : groupStateName(group)}</span>{ownsOperations && endAction}</div>
        <EventExecutionProgress task={group} detail={selectedExecution} supplementAvailable={ownsOperations && !!supplement} operationsAvailable={ownsOperations && !!operations} jump={jumpToProgressTarget} />
        {ownsOperations && <>{controls}{recovery}</>}
        </section>
        :<EventTriage key={selected.key+':'+selected.messages.map((m:Row)=>m.id+'-'+m.state).join(',')} item={selected} busy={busy} onAction={triage} onRetry={id=>void retry(id)} onManage={onManage} onError={setError} />}
      {group && !canManage && <section><h3>当前目标</h3><ConversationContent content={group.goal} /></section>}
      {ownsOperations && supplement && <div data-event-supplement>{supplement}</div>}
      {group&&<ProcessingResults artifacts={allArtifacts} events={selectedExecution?.events ?? []} group={group} onOpenSession={onOpenSession} />}
      {ownsOperations && <div className="event-inline-operations">{operations}</div>}
      </div>
      <div role="tabpanel" className="event-detail-panel" hidden={detailTab !== 'messages'} tabIndex={0}
        id={`${detailId}-panel-messages`} aria-labelledby={`${detailId}-tab-messages`}>
      <section><div className="section-heading"><h3>消息 · {visibleMessages.length} 条消息</h3>
        {group && canManage && visibleMessages.some(m=>m.source==='dingtalk' && m.data?.metadata?.conversation_type==='direct' && !m.data?.metadata?.self_authored) &&
          <button disabled={busy} onClick={()=>void syncOwnMessages(group.id)}>同步我的钉钉消息</button>}
      </div>
        <ol className={`group-timeline${hasChat ? " event-chat" : ""}`}>{visibleMessages.map((m:Row)=>{
          const own=ownMessage(m);
          const local=m.source==='web' && ['message','goal_changed','project_rebound'].includes(m.event_type);
          const t=traces.find(t=>t.event.id===m.id);
          const resolution=m.processing?.status;
          const messageState=resolution==='dismissed'?'closed':resolution==='resolved'?'completed':m.state??'triage';
          const issueId=redmineIssueId(m);
          const issueHref=redmineIssueHref(m.data?.metadata?.redmine_endpoint, issueId);
          const chat = m.source === 'dingtalk';
          const time = new Date(m.data?.occurred_at ?? m.created_at).toLocaleString('zh-CN');
          if (hasChat && !chat && !issueId) return <li key={m.id} className="event-chat-secondary">
            <details><summary>{m.event_type === 'project_rebound' ? '项目调整' : local ? '补充给 Agent' : sourceName(m.source)} · {time}</summary>
              <ConversationContent content={m.content} />
              <FieldEvidence message={m} />
            </details>
          </li>;
          return <li key={m.id} className={chat ? `event-chat-message${own ? ' event-chat-own' : ''}` : 'event-chat-secondary'}>
            {chat ? <div className="event-chat-meta"><strong>{messageAuthor(m)}</strong><span>{own ? '本账号发言 · ' : ''}{time}</span></div> :
            <div><strong>{sourceName(m.source)}</strong>{issueId && <> · {issueHref
              ? <a className="redmine-issue-link" href={issueHref} target="_blank" rel="noopener noreferrer">工单 #{issueId}</a>
              : <span>工单 #{issueId}</span>}</>} · {m.data?.metadata?.sender_name??m.data?.actor_id??m.data?.actor??'人工输入'} · {new Date(m.data?.occurred_at ?? m.created_at).toLocaleString('zh-CN')}
              <span className="badge event-state-badge" data-state={messageState}>
                {own ? '本账号发言' : local ? (m.event_type === 'project_rebound' ? '项目调整' : '补充给 Agent') : (({resolved:'已解决',dismissed:'无需处理',pending:'待核验'} as Row)[resolution]??eventStates[messageState as EventState])}</span></div>}
            <div className={chat ? 'event-chat-bubble' : undefined}><ConversationContent content={chat && typeof m.content === 'string'
              ? m.content.replace(/\[图片消息\]\s*\(mediaId=[^)]*\)/gi, '[图片消息]') : m.content}/></div>
            <FieldEvidence message={m} />
            {chat && !own && <span className="badge event-state-badge" data-state={messageState}>
              {({resolved:'已解决',dismissed:'无需处理',pending:'待核验'} as Row)[resolution] ?? eventStates[messageState as EventState]}
            </span>}
            {m.processing?.evidence&&<p>处理依据：{m.processing.evidence}</p>}
            {!group && selected.messages.length>1 && <p className="muted">{triageReason(m.triage_reason ?? m.data?.routing_reason)}</p>}
            {!own && !local && group && group.status!=='cancelled' && canManage && resolution==='pending' && <button disabled={busy || group.outcome_unknown} onClick={()=>void resolve(m.id,'人工确认此消息无需处理。','dismissed')}>此消息无需处理</button>}
            {!own && !local && <details><summary>处理详情与核对</summary>
              {group&&group.status!=='cancelled'&&canManage&&<form onSubmit={e=>{
                e.preventDefault();
                const evidence=String(new FormData(e.currentTarget).get('evidence')??'');
                void resolve(m.id,evidence,'resolved');
              }}><label>核对依据<input name="evidence" required /></label><button disabled={busy || group.outcome_unknown}>确认已解决</button></form>}
              {m.data?.routing_status==='manually_linked'&&<p>{triageReason('linked_manually')}</p>}
              {!t?<p>暂无可读取的路由证据；人工输入通过任务入口接收。</p>:<>
                <p>{t.semantic_routing?'模型判断后经工程校验':'按工程规则、订阅或明确引用处理'}</p>
                {(t.attempts??[]).map((a:Row,i:number)=><div key={i}><strong>第 {i+1} 次处理</strong>{(a.steps??[]).filter((s:Row)=>['fast_filter','slow_filter','subscription','router'].includes(s.stage)).map((s:Row,j:number)=><p key={j}>{({fast_filter:'身份与策略',slow_filter:'语义判断',subscription:'关联匹配',router:'分派'} as Row)[s.stage]} · {({passed:'已通过',blocked:'未通过',pending:'等待判断',skipped:'未执行',unknown:'无记录'} as Row)[s.status]??s.status} <small>{s.reason}</small></p>)}</div>)}
                {t.semantic_routing?.decision&&<ConversationContent content={t.semantic_routing.decision}/>}
                {t.routing_session_id&&onOpenSession&&<button onClick={()=>onOpenSession(t.routing_session_id)}>打开分派会话</button>}
              </>}
            </details>}
          </li>;
        })}</ol>
      </section>
      </div>
      <div role="tabpanel" className="event-detail-panel" hidden={detailTab !== 'reply'} tabIndex={0}
        id={`${detailId}-panel-reply`} aria-labelledby={`${detailId}-tab-reply`}>
        {ownsOperations && reply ? <div className="event-inline-operations">{reply}</div> :
          <section className="event-reply-section"><h3>渠道回复</h3>
          {deliveries.length ? deliveries.map((d:Row,i:number)=><article className="artifact" key={d.draft?.id ?? i}>
            <strong>{deliveryLabel(d,selectedExecution?.approvals??[])}</strong><ConversationContent content={d.draft?.content}/>
          </article>) : <p className="muted">暂无可查看的平台回复记录。</p>}</section>}
        {!!ownMessages.length && <section className="event-own-messages"><h3>钉钉本账号发言</h3>
          <p className="muted">来自会话消息记录，可能包含手工发言。</p>
          {ownMessages.map(m => <article className="artifact" key={m.id}>
            <strong>{messageAuthor(m)}</strong> · {new Date(m.data?.occurred_at ?? m.created_at).toLocaleString('zh-CN')}
            <ConversationContent content={m.content}/>
          </article>)}
        </section>}
      </div>
    </>}</section></div>);
}

export function deliveryLabel(d:Row, approvals:Row[]){
 if(deliverySucceeded(d))return '已发送 · 渠道已确认';
 const result=d.record?.result?.write_status;
 if(result==='unknown')return '发送结果未知 · 先核对原渠道，不要重发';
 if(result==='failed')return '发送失败 · 查看失败原因后处理';
 const approval=approvals.find(a=>a.id===d.draft?.approval_id);
 if(approval?.status==='pending')return '待审批 · 未发送';
 if(approval?.status==='approved')return '已批准，尚未发送';
 if(approval?.status==='rejected')return '发送已拒绝';
 if(approval?.status?.startsWith('expired'))return '审批已失效 · 需按当前要求重新审阅';
 return '回复草稿 · 未发送';
}

