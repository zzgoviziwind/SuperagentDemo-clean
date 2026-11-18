"""Isolated local media decoding and speech recognition."""
import argparse
import contextlib
import json
from pathlib import Path
import sys

DURATION_LIMIT_MS = 45 * 60 * 1000
FORMATS = {'.mp4': 'mov', '.m4a': 'mov', '.webm': 'matroska', '.wav': 'wav', '.mp3': 'mp3'}


def open_media(path):
    import av

    return av.open(path, format=FORMATS[Path(path.name).suffix],
                   options={'protocol_whitelist': 'file,pipe', 'enable_drefs': '0', 'use_absolute_path': '0'})


def phrases(segment):
    if not segment.words:
        yield segment.start, segment.end, segment.text
        return
    group = []
    for word in segment.words:
        group.append(word)
        if word.word.rstrip().endswith(('。', '！', '？', '；', '.', '!', '?', ';')):
            yield group[0].start, group[-1].end, ''.join(item.word for item in group)
            group.clear()
    if group:
        yield group[0].start, group[-1].end, ''.join(item.word for item in group)


def transcribe(source, model_dir):
    import av
    import numpy as np
    from faster_whisper import WhisperModel

    with source.open('rb') as file, open_media(file) as media:
        duration_ms = round(media.duration / 1000) if media.duration else 0
        if not 0 < duration_ms <= DURATION_LIMIT_MS or not media.streams.audio:
            raise ValueError('需要含语音轨且时长不超过 45 分钟的文件')
        audio = media.streams.audio[0]
        video = bool(media.streams.video) and source.suffix in {'.mp4', '.webm'}
        origin = (media.start_time or 0) / 1_000_000
        resampler = av.AudioResampler(format='s16', layout='mono', rate=16000)
        # Place decoded samples back on the playback clock, preserving initial offsets and gaps.
        samples = np.zeros(duration_ms * 16 + 16000, dtype=np.int16)
        cursor = 0

        def add(frame):
            nonlocal cursor
            data = frame.to_ndarray().reshape(-1)
            start = round((float(frame.pts * frame.time_base) - origin) * 16000) if frame.pts is not None else cursor
            begin, end = max(0, start), min(len(samples), start + len(data))
            if end > begin:
                samples[begin:end] = data[begin - start:end - start]
            cursor = end

        for frame in media.decode(audio):
            for converted in resampler.resample(frame):
                add(converted)
        for converted in resampler.resample(None):
            add(converted)

    recognizer = WhisperModel(str(model_dir), device='cpu', compute_type='int8', cpu_threads=4, local_files_only=True)
    result, _ = recognizer.transcribe(samples[:duration_ms * 16].astype(np.float32) / 32768,
                                      beam_size=3, vad_filter=True, condition_on_previous_text=False, word_timestamps=True)
    segments = []
    for segment in result:
        for begin, finish, raw in phrases(segment):
            start, end = max(0, round(begin * 1000)), min(duration_ms, round(finish * 1000))
            text = raw.strip()
            if text and end > start:
                segments.append({'start_ms': start, 'end_ms': end, 'text': text})
    return {'duration_ms': duration_ms, 'video': video, 'segments': segments}


def frames(source, moments, output):
    rendered = []
    with source.open('rb') as file, open_media(file) as media:
        stream = media.streams.video[0]
        if stream.width * stream.height > 9_000_000:
            raise ValueError('录屏画面超过 900 万像素')
        origin = (media.start_time or 0) / 1_000_000
        for index, moment in enumerate(moments, 1):
            target = origin + moment / 1000
            media.seek(round(target * 1_000_000), backward=True)
            for frame in media.decode(stream):
                if frame.time is None or frame.time < target:
                    continue
                filename = f'frame-{index}.jpg'
                frame.to_image().save(output / filename, 'JPEG', quality=88)
                rendered.append({'filename': filename, 'at_ms': max(0, round((frame.time - origin) * 1000))})
                break
    return rendered


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['transcribe', 'frames'])
    parser.add_argument('source', type=Path)
    parser.add_argument('directory', type=Path)
    parser.add_argument('moments', nargs='*', type=int)
    args = parser.parse_args()
    with contextlib.redirect_stdout(sys.stderr):
        result = (transcribe(args.source, args.directory) if args.action == 'transcribe' else
                  frames(args.source, args.moments, args.directory))
    print(json.dumps(result, ensure_ascii=True))


if __name__ == '__main__':
    main()
