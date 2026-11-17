import { useEffect, useRef, useState } from 'react';
import { request } from './api';
import { ConversationContent } from './ConversationContent';

type Row = Record<string, any>;
export function MessageRecords({ onOpenEvent }: { onOpenEvent: (id: string) => void }) {
  const generation = useRef(0);
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<Row[]>([]), [selected, setSelected] = useState<Row | null>(null);
  const [source, setSource] = useState(''), [query, setQuery] = useState(''), [error, setError] = useState('');
  const [after, setAfter] = useState(0), [more, setMore] = useState(false), [trace, setTrace] = useState<Row | null>(null);
  const sourceName = (s: string) => ({ dingtalk: '钉钉', redmine: 'Redmine', web: '工作台' }[s] ?? s);
  async function load(append = false) {
    const current = ++generation.current;
    setLoading(true);
    try {
      const data = await request<Row>(`/events?routing_status=all&limit=50&after=${append ? after : 0}&source=${source}&q=${encodeURIComponent(query)}`);
      if (current !== generation.current) return;
      setItems(previous => append ? [...previous, ...data.items] : data.items);
      setAfter(data.next_after); setMore(data.has_more); setError('');
    } catch (e) { if (current === generation.current) setError((e as Error).message); }
    finally { if (current === generation.current) setLoading(false); }
  }
  useEffect(() => { const timer = setTimeout(() => void load(), 200); return () => clearTimeout(timer); }, [source, query]);
  useEffect(() => {
    setTrace(null);
    if (!selected) return;
    let live = true;
    void request<Row>(`/events/${selected.id}/trace`).then(data => { if (live) setTrace(data); }).catch(e => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [selected]);
  const tasks = trace?.target_tasks?.length ? trace.target_tasks : trace?.task ? [trace.task] : [];
  return <div className="event-workbench message-records">
    <section className="event-index"><h2>消息记录</h2><label>消息来源<select value={source} onChange={e => setSource(e.target.value)}><option value="">全部来源</option><option value="dingtalk">钉钉</option><option value="redmine">Redmine</option></select></label><label>搜索消息<input value={query} onChange={e => setQuery(e.target.value)} /></label>{error && <p role="alert">{error}</p>}
      {items.map(m => <button className="event-choice" key={m.id} aria-pressed={selected?.id === m.id} onClick={() => setSelected(m)}><strong>{sourceName(m.source)} · {m.data?.metadata?.sender_name ?? m.data?.actor_id}</strong><p className="event-card-excerpt">{m.content}</p><small>{new Date(m.created_at).toLocaleString('zh-CN')}</small></button>)}
      {more && <button disabled={loading} onClick={() => void load(true)}>加载更多消息</button>}
    </section>
    <section className="event-detail">{!selected ? <p>选择消息查看相关消息和对应事件。</p> : <><h2>消息内容</h2><ConversationContent content={selected.content} /><h3>对应事件</h3>{tasks.map((t: Row) => <article className="linked-record" key={t.id}><strong>{t.title}</strong><button onClick={() => onOpenEvent(String(t.id))}>进入对应事件</button></article>)}{trace && !tasks.length && <p>此消息尚未关联事件。</p>}<h3>相关消息</h3>{(trace?.related_events ?? []).filter((m: Row) => m.id !== selected.id).map((m: Row) => <article className="linked-record" key={m.id}><small>{m.actor_name ?? m.actor_id} · {m.created_at && new Date(m.created_at).toLocaleString('zh-CN')}</small><ConversationContent content={m.content} /></article>)}</>}</section>
  </div>;
}
