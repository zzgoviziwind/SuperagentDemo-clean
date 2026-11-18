import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { request } from './api';
import { FieldTranscript, fieldTime } from './FieldTranscript';
import './field-intake.css';

type Action = 'create' | 'link' | 'dismiss';
type Evidence = { id: string; text: string; note_line?: number; screenshot?: number; at_ms?: number; start_ms?: number; end_ms?: number;
  nearby?: { id: string; start_ms: number; end_ms: number }[] };
type Draft = { title: string; detail: string; kind: string; quote?: string; note_line?: number; screenshots: number[]; evidence?: Evidence[] };
type Candidate = { id: number; draft: Draft; decision?: { task_id: number | null; request: { action: Action; title: string } } };
type RecordEntry = { id: string; title: string; project_id: number };
type OrganizerMode = 'offline_sample' | 'local_ocr_codex' | 'local_evidence';
type OrganizerStatus = { mode: OrganizerMode; timeline?: boolean; ocr?: boolean };
type FieldRecord = RecordEntry & { notes: string; organizer: OrganizerMode; timeline_imported?: boolean;
  screenshots: { id: number; filename: string; at_ms?: number }[]; candidates: Candidate[];
  media?: { video: boolean } | null };
type MediaJob = { id: string; title: string; state: 'queued' | 'running' | 'ready' | 'failed'; phase: string; error?: string };
type MediaStatus = { ready: boolean; reason?: string; jobs: MediaJob[] };
const phases: Record<string, string> = { queued: '等待处理', transcribing: '语音转写', organizing: '归纳事项',
  extracting: '按需抽帧', vision: '核对画面' };
type Target = { id: number; title: string; state_version: number };
type Project = { id: string | number; name: string; enabled: boolean };

const example = 'Bug：报告预览缺少科室小结，详情页能看到内容。[截图1]\n需求：导出清单新增审核时间列，待确认取值口径。';

function readFile(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('无法读取截图'));
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.readAsDataURL(file);
  });
}

function CandidateReview({ item, recordId, media, targets, busy, onDecision, onOpen }: {
  item: Candidate; targets: Target[]; busy: boolean;
  recordId: string;
  media?: FieldRecord['media'];
  onDecision: (payload: unknown) => void; onOpen: (id: number) => void;
}) {
  const [action, setAction] = useState<Action>('create');
  const draft = item.draft;
  if (item.decision) {
    const { task_id: id, request: decision } = item.decision;
    return <article className="field-candidate"><strong>{decision.title || draft.title}</strong>
      <span>{decision.action === 'dismiss' ? '已略过' : decision.action === 'link' ? '已关联只读事件' : '已创建只读事件'}</span>
      {id !== null && <button type="button" onClick={() => onOpen(id)}>查看事件 #{id}</button>}</article>;
  }
  const heading = `field-candidate-${item.id}`;
  return <form className="field-candidate" aria-labelledby={heading} onSubmit={event => {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const target = targets.find(row => row.id === Number(fields.get('target')));
    onDecision({ action, title: fields.get('title') ?? '', detail: fields.get('detail') ?? '',
      kind: fields.get('kind') ?? draft.kind, task_id: target?.id, expected_state_version: target?.state_version });
  }}>
    <fieldset disabled={busy}>
      <legend id={heading}>{draft.title}</legend>
      {draft.quote && <blockquote>笔记第 {draft.note_line} 行 · {draft.quote}</blockquote>}
      {!!draft.evidence?.length && <details className="field-candidate-evidence">
        <summary>证据（{draft.evidence.length} 条）</summary>
        {draft.evidence.map(ref => ref.start_ms !== undefined && ref.end_ms !== undefined
          ? <blockquote key={ref.id} className="field-transcript-evidence">
            <FieldTranscript recordId={recordId} segmentId={ref.id} start_ms={ref.start_ms} end_ms={ref.end_ms} media={media} />
            <span>{ref.text}</span>
          </blockquote> : <blockquote key={ref.id}>
          {ref.screenshot ? <a target="_blank" rel="noreferrer" href={`/api/v1/field-intake/records/${recordId}/screenshots/${ref.screenshot}`}>
            截图 {ref.screenshot}{ref.at_ms !== undefined && ` · ${fieldTime(ref.at_ms)}`}{ref.id.includes(':') && ` · 识别第 ${ref.id.split(':')[1]} 行`}
          </a> : <strong>笔记第 {ref.note_line} 行</strong>} · {ref.text}
          {!!ref.nearby && ref.nearby.length > 1 && <div className="field-frame-matches">多个相邻转写片段，请核对
            {ref.nearby.map(segment => <FieldTranscript key={segment.id} recordId={recordId} segmentId={segment.id}
              start_ms={segment.start_ms} end_ms={segment.end_ms} media={media} />)}
          </div>}
        </blockquote>)}
      </details>}
      <label>处理方式<select value={action} onChange={event => setAction(event.target.value as Action)}>
        <option value="create">新建只读事件</option><option value="link">关联已有只读事件</option><option value="dismiss">略过此事项</option>
      </select></label>
      {action !== 'dismiss' && <>
        <label>事项类型<select name="kind" defaultValue={draft.kind}>
          <option value="bug">疑似 Bug</option><option value="requirement">需求</option><option value="question">待澄清</option>
        </select></label>
        <label>标题<input name="title" required maxLength={200} defaultValue={draft.title} /></label>
        <label>内容<textarea name="detail" rows={draft.evidence ? 5 : 3} required maxLength={2500} defaultValue={draft.detail} /></label>
      </>}
      {action === 'link' && <label>同项目只读事件<select name="target" required defaultValue="">
        <option value="">{targets.length ? '选择事件' : '暂无可关联的只读事件'}</option>
        {targets.map(row => <option key={row.id} value={row.id}>#{row.id} · {row.title}</option>)}
      </select></label>}
      {!draft.evidence && draft.screenshots.length > 0 && <p>关联证据 · {draft.screenshots.map(id => `截图 ${id}`).join('、')}</p>}
      <button className="primary" disabled={action === 'link' && targets.length === 0}>
        {action === 'dismiss' ? '确认略过' : action === 'link' ? '确认并关联' : '确认并创建事件'}
      </button>
    </fieldset>
  </form>;
}

export function FieldIntake({ projects, onOpen }: { projects: Project[]; onOpen: (id: number) => void }) {
  const [history, setHistory] = useState<RecordEntry[]>([]);
  const [record, setRecord] = useState<FieldRecord>();
  const [targets, setTargets] = useState<Target[]>([]);
  const [notes, setNotes] = useState('');
  const [organizer, setOrganizer] = useState<OrganizerStatus>();
  const [files, setFiles] = useState<File[]>([]);
  const [manifest, setManifest] = useState<File>();
  const [mediaFile, setMediaFile] = useState<File>();
  const [mediaStatus, setMediaStatus] = useState<MediaStatus>();
  const [busy, setBusy] = useState(false);
  const [organizing, setOrganizing] = useState(false);
  const [error, setError] = useState('');
  const reviewHeading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    void request<RecordEntry[]>('/field-intake/records').then(setHistory).catch(e => setError(e.message));
    void request<OrganizerStatus>('/field-intake/organizer').then(setOrganizer).catch(e => setError(e.message));
  }, []);
  const mode = organizer?.mode;
  const ocrReady = organizer?.ocr === true;
  const supportsTimeline = organizer?.timeline === true || mode === 'local_ocr_codex' || mode === 'local_evidence';
  const samplePreview = mode === 'offline_sample' && !supportsTimeline;
  const mediaActive = mediaStatus?.jobs.some(job => ['queued', 'running'].includes(job.state));
  useEffect(() => {
    if (!supportsTimeline) return;
    let stopped = false;
    let timer: number;
    async function refreshJobs() {
      try {
        const incoming = await request<MediaStatus>('/field-intake/media-jobs');
        if (!stopped) setMediaStatus(incoming);
      } catch (e) { if (!stopped) setError(e instanceof Error ? e.message : '无法获取后台处理状态'); }
      finally { if (!stopped && mediaActive) timer = window.setTimeout(() => void refreshJobs(), 2500); }
    }
    void refreshJobs();
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [supportsTimeline, mediaActive]);
  const recordId = record?.id;
  useEffect(() => {
    if (recordId) reviewHeading.current?.focus();
  }, [recordId]);

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError('');
    try { await work(); }
    catch (e) { setError(e instanceof Error ? e.message : '操作失败'); }
    finally { setBusy(false); }
  }

  async function show(row: FieldRecord) {
    setTargets([]);
    setRecord(row);
    setTargets(await request<Target[]>(`/field-intake/records/${row.id}/targets`));
  }

  function organize(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setOrganizing(true);
    void run(async () => {
      if (files.length > 5 || files.some(file => file.size > 2 * 1024 * 1024)) {
        throw new Error('每条记录最多上传 5 张截图，每张不超过 2 MB。');
      }
      if (mediaFile) {
        if (mediaFile.size > 150 * 1024 * 1024) throw new Error('音视频最大 150 MB。');
        const form = new FormData();
        form.set('details', JSON.stringify({ project_id: Number(data.get('project')), title: data.get('title'),
          screenshot_times: files.map((_, index) => Math.round(Number(data.get(`time-${index}`)) * 1000)) }));
        form.set('media', mediaFile);
        files.forEach(file => form.append('screenshots', file));
        const job = await request<MediaJob>('/field-intake/media-jobs', form, 'POST', 300_000);
        setMediaStatus(current => ({ ready: true, jobs: [job, ...(current?.jobs.filter(row => row.id !== job.id) ?? [])] }));
        return;
      }
      const screenshots = await Promise.all(files.map(async file => ({
        filename: file.name, mime: file.type, base64: await readFile(file),
      })));
      let timeline: unknown;
      if (manifest) {
        if (manifest.size > 512 * 1024) throw new Error('时间轴文件须小于 512 KB。');
        try { timeline = JSON.parse(await manifest.text()); }
        catch { throw new Error('无法读取时间轴 JSON，请核对文件格式后重试。'); }
        if (!timeline || typeof timeline !== 'object' || Array.isArray(timeline)) throw new Error('请选择有效的时间轴 JSON。');
      }
      const row = await request<FieldRecord>('/field-intake/records', {
        project_id: Number(data.get('project')), title: data.get('title'), notes, screenshots, timeline,
      }, 'POST', 165_000);
      setHistory(current => [row, ...current]);
      await show(row);
    }).finally(() => setOrganizing(false));
  }

  function decide(row: FieldRecord, item: Candidate, payload: unknown) {
    void run(async () => {
      let updated: Candidate;
      try {
        updated = await request<Candidate>(`/field-intake/candidates/${item.id}/decision`, payload);
      } catch (error) {
        setTargets(await request<Target[]>(`/field-intake/records/${row.id}/targets`));
        throw error;
      }
      await show({ ...row, candidates: row.candidates.map(current => current.id === item.id ? updated : current) });
    });
  }

  return <div className="field-intake">
    {error && <p className="alert error" role="alert">{error}</p>}
    <div className="field-layout">
      <section aria-labelledby="field-record-heading">
        <h2 id="field-record-heading">录入现场材料</h2>
        <p className="muted">{samplePreview ? '独立预览按笔记逐行拆分，截图供人工核对。'
          : mode === 'offline_sample' ? '在本机逐行整理笔记，可导入时间轴，截图供人工核对。'
          : mode === 'local_ocr_codex'
            ? '可在本机识别截图，或导入已有转写和识别结果。提交给 Codex 整理的文字请先脱敏。'
            : mode === 'local_evidence'
              ? (ocrReady ? '在本机整理笔记、截图识别结果与时间轴。' : '在本机整理笔记与时间轴，截图供人工核对。')
              : '可录入现场笔记和截图。'}</p>
        <form onSubmit={organize} aria-labelledby="field-record-heading">
          <fieldset disabled={busy}>
            <legend className="field-sr-only">项目和材料</legend>
            <label>医院项目<select name="project" required defaultValue=""><option value="">选择项目</option>
              {projects.filter(project => project.enabled).map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select></label>
            <label>记录名称<input name="title" required maxLength={200} placeholder="例如，报告预览现场交流" /></label>
            {supportsTimeline && <label>音视频（选填）<input type="file" accept=".mp4,.webm,.wav,.mp3,.m4a" aria-describedby="field-media-help"
              disabled={!mediaStatus?.ready}
              onChange={event => { setMediaFile(event.target.files?.[0]); setManifest(undefined); }} /></label>}
            {supportsTimeline && <small id="field-media-help">{mediaStatus?.ready
              ? (mode === 'local_ocr_codex' ? '最大 150 MB、45 分钟。语音在本机转写，只将文字和少量截图交给 Codex。'
                : '最大 150 MB、45 分钟。语音在本机转写并生成待审核事项。')
              : mediaStatus ? (mediaStatus.reason ?? '后台语音识别模型尚未配置。') : '正在检查后台处理配置…'}</small>}
            {!mediaFile && <><label>现场笔记<textarea value={notes} onChange={event => setNotes(event.target.value)} rows={5} maxLength={10000}
              aria-describedby="field-note-help" /></label>
            <small id="field-note-help">{mode === 'offline_sample'
              ? '每行一件事。可用「Bug：」「需求：」开头，用 [截图1] 引用第一张截图。'
              : '按交流原样记录，写清看到的现象、确认的期望和待核实的疑问。'}</small></>}
            {!mediaFile && supportsTimeline && <>
              <label>时间轴文件（选填）<input type="file" accept=".json,application/json" aria-describedby="field-timeline-help"
                onChange={event => setManifest(event.target.files?.[0])} /></label>
              <small id="field-timeline-help">导入外部转写与截图识别结果，同时选择 JSON 中的同名截图。
                {' '}<a href="/field-timeline.example.json" download>下载 JSON 示例</a></small>
            </>}
            <label>截图<input type="file" multiple accept="image/png,image/jpeg,image/webp" aria-describedby="field-file-help"
              onChange={event => setFiles(Array.from(event.target.files ?? []))} /></label>
            <small id="field-file-help">PNG、JPEG 或 WebP，最多 5 张，每张不超过 2 MB。</small>
            {mediaFile && files.map((file, index) => <label key={`${index}:${file.name}`}>{file.name} · 距原文件开头秒数
              <input type="number" name={`time-${index}`} min={0} max={2700} step={0.001} required /></label>)}
            <div className="actions"><button className="primary">{mediaFile ? '提交后台处理' : '整理候选事项'}</button>
              {samplePreview && <button type="button" onClick={() => setNotes(example)}>填入模拟笔记</button>}</div>
          </fieldset>
        </form>
        {!!mediaStatus?.jobs.length && <section aria-label="后台处理">
          <h3>后台处理</h3>
          {mediaStatus.jobs.map(job => <article className="field-candidate" key={job.id}>
            <strong>{job.title}</strong><span>{job.state === 'ready' ? '待审核' : job.state === 'failed' ? job.error : phases[job.phase]}</span>
            {job.state === 'ready' && <button disabled={busy} onClick={() => void run(async () => {
              const row = await request<FieldRecord>(`/field-intake/records/${job.id}`);
              setHistory(current => [row, ...current.filter(item => item.id !== job.id)]);
              await show(row);
            })}>审核候选事项</button>}
            {job.state === 'failed' && mediaStatus.ready && <button disabled={busy} onClick={() => void run(async () => {
              const retried = await request<MediaJob>(`/field-intake/media-jobs/${job.id}/retry`, {});
              setMediaStatus(current => current && { ...current, jobs: current.jobs.map(item => item.id === job.id ? retried : item) });
            })}>重试处理</button>}
          </article>)}
        </section>}
        {!!history.length && <label>最近记录<select disabled={busy} value={record?.id ?? ''} onChange={event => {
          const id = event.target.value;
          if (id) void run(async () => show(await request<FieldRecord>(`/field-intake/records/${id}`)));
        }}><option value="">打开已保存记录</option>{history.map(row => <option key={row.id} value={row.id}>{row.title}</option>)}</select></label>}
      </section>
      <section aria-labelledby="field-review-heading">
        <h2 id="field-review-heading" ref={reviewHeading} tabIndex={-1}>审核候选事项</h2>
        {busy && <p role="status">{organizing && !samplePreview
          ? mediaFile ? '正在上传音视频…' : manifest ? '正在导入时间轴并整理候选事项…'
            : mode !== 'local_ocr_codex' && !ocrReady ? '正在整理候选事项…' : '正在识别截图并整理现场笔记…' : '正在处理…'}</p>}
        {!record ? <p className="muted">提交截图或笔记后，在这里逐条核对并分派。</p> : <>
          <p><strong>{record.title}</strong> · {record.candidates.filter(item => !item.decision).length} 条待审核
            {record.media ? ' · 音视频整理' : record.timeline_imported ? ' · 时间轴导入' : samplePreview && record.organizer === 'offline_sample' && ' · 模拟整理'}</p>
          {record.screenshots.map(image => <a className="field-evidence" key={image.id} target="_blank" rel="noreferrer"
            href={`/api/v1/field-intake/records/${record.id}/screenshots/${image.id}`}>截图 {image.id}{image.at_ms !== undefined && ` · ${fieldTime(image.at_ms)}`} · {image.filename}</a>)}
          {record.candidates.map(item => <CandidateReview key={item.id} item={item} recordId={record.id} media={record.media} targets={targets} busy={busy}
            onOpen={onOpen} onDecision={payload => decide(record, item, payload)} />)}
        </>}
      </section>
    </div>
  </div>;
}

export function FieldImplementation({ id, version, onOpen }: {
  id: string; version: number; onOpen: (id: number) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <details className="field-implementation"><summary>根据本轮分析批准实施</summary>
    <form aria-label="批准实施" onSubmit={event => {
      event.preventDefault();
      const fields = new FormData(event.currentTarget);
      setBusy(true);
      setError('');
      void request<{ task_id: number }>(`/field-intake/analysis/${id}/implement`, {
        expected_state_version: version, scope: fields.get('scope'), acceptance_criteria: fields.get('criteria'),
      }).then(result => onOpen(result.task_id)).catch(e => setError(e.message)).finally(() => setBusy(false));
    }}>
      <fieldset disabled={busy}>
        <legend className="field-sr-only">实施范围和验收</legend>
        <label>批准的改动范围<textarea name="scope" required maxLength={4000} rows={3} /></label>
        <label>验收条件<textarea name="criteria" required maxLength={4000} rows={3} /></label>
        <button className="primary">批准并创建实施任务</button>
      </fieldset>
      {error && <p role="alert">{error}</p>}
    </form>
  </details>;
}
