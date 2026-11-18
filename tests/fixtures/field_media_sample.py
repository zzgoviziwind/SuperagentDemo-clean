"""Mux generated speech and fictional UI screens into a reproducible test video."""
from pathlib import Path
import sys
from wave import open as wave_open

import av
from PIL import Image


def main(directory, images):
    files = [directory / f'speech-{index}.wav' for index in range(2)]
    pcm, lengths = [], []
    for path in files:
        with wave_open(str(path), 'rb') as source:
            assert source.getnchannels() == 1 and source.getsampwidth() == 2
            sample_rate = source.getframerate()
            lengths.append(source.getnframes() / sample_rate)
            pcm.append(source.readframes(source.getnframes()))

    with av.open(str(directory / 'meeting.mp4'), 'w') as output:
        video = output.add_stream('libx264', rate=4)
        video.width, video.height, video.pix_fmt = 650, 240, 'yuv420p'
        audio = output.add_stream('aac', rate=sample_rate)
        audio.layout = 'mono'
        panels = [Image.open(images / path).convert('RGB') for path in ('preview.png', 'export.png')]
        for index in range(round((sum(lengths) + 2) * 4)):
            panel = panels[int(index >= round((lengths[0] + 1) * 4))]
            frame = av.VideoFrame.from_image(panel)
            for packet in video.encode(frame):
                output.mux(packet)
        for packet in video.encode(None):
            output.mux(packet)
        data = pcm[0] + b'\x00\x00' * sample_rate + pcm[1]
        for offset in range(0, len(data), 4096):
            block = data[offset:offset + 4096]
            frame = av.AudioFrame(format='s16', layout='mono', samples=len(block) // 2)
            frame.sample_rate = sample_rate
            frame.planes[0].update(block)
            for packet in audio.encode(frame):
                output.mux(packet)
        for packet in audio.encode(None):
            output.mux(packet)
    print(lengths)


if __name__ == '__main__':
    main(*map(Path, sys.argv[1:]))
