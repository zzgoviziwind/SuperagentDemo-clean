import { useId, useState } from 'react';
import { Modal } from './Modal';
import { request } from './api';

type Range = { start_ms: number; end_ms: number };
type Segment = Range & { id: string; speaker: string; text: string };

export function fieldTime(milliseconds: number) {
  const seconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  const pad = (value: number) => String(value).padStart(2, '0');
  const hours = Math.floor(minutes / 60);
  const fraction = milliseconds % 1000;
  return `${hours ? `${pad(hours)}:` : ''}${pad(minutes % 60)}:${pad(seconds % 60)}${fraction ? `.${String(fraction).padStart(3, '0')}` : ''}`;
}

export function FieldTranscript({ recordId, segmentId, start_ms, end_ms, media }: Range & {
  recordId: string; segmentId: string; media?: { video: boolean } | null;
}) {
  const [open, setOpen] = useState(false);
  const [segment, setSegment] = useState<Segment>();
  const [error, setError] = useState('');
  const [playerError, setPlayerError] = useState(false);
  const title = useId();
  const time = `${fieldTime(start_ms)}–${fieldTime(end_ms)}`;
  const Player = media?.video ? 'video' : 'audio';
  const start = start_ms / 1000;
  const end = end_ms / 1000;
  const source = `/api/v1/field-intake/records/${encodeURIComponent(recordId)}/media`;

  function show() {
    setOpen(true);
    setError('');
    setPlayerError(false);
    setSegment(undefined);
    void request<Segment>(`/field-intake/records/${encodeURIComponent(recordId)}/transcript/${encodeURIComponent(segmentId)}`)
      .then(setSegment).catch(e => setError(e.message));
  }

  return <>
    <button type="button" className="field-time-button" onClick={show}>查看转写 {time}</button>
    {open && <Modal className="action-confirm-dialog field-transcript-dialog" labelledBy={title} onClose={() => setOpen(false)}>
      <h2 id={title}>{media ? '原音视频片段' : '原始转写片段'}</h2>
      <p>{time}{segment?.speaker ? ` · ${segment.speaker}` : ''}</p>
      {media && <>
        <Player className="field-media-player" aria-label={`原文件片段 ${time}`} src={source}
          controls playsInline preload="metadata"
          onError={() => setPlayerError(true)}
          onLoadedMetadata={event => { event.currentTarget.currentTime = start; }}
          onPlay={event => { const player = event.currentTarget; if (player.currentTime >= end || player.currentTime < start) player.currentTime = start; }}
          onTimeUpdate={event => { const player = event.currentTarget; if (!player.paused && player.currentTime >= end) player.pause(); }} />
        <a href={source} target="_blank" rel="noreferrer">打开完整原文件</a>
        {playerError && <p role="alert">浏览器无法播放此文件格式。</p>}
      </>}
      {segment ? <blockquote>{segment.text}</blockquote>
        : error ? <p role="alert">{error}</p> : <p role="status">正在载入转写…</p>}
      <button type="button" data-dialog-autofocus onClick={() => setOpen(false)}>关闭</button>
    </Modal>}
  </>;
}
