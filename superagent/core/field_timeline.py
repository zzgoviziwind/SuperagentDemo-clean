"""Versioned interchange format for already processed field material."""
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

Timestamp = Annotated[int, Field(ge=0, le=86_400_000)]
Coordinate = Annotated[int, Field(ge=0)]


def matching_segments(timestamp, transcript):
    """Return overlaps or equally near segments within five seconds."""
    if not transcript:
        return []
    distances = [max(segment['start_ms'] - timestamp, timestamp - segment['end_ms'], 0) for segment in transcript]
    closest = min(distances)
    return [row for row, distance in zip(transcript, distances) if distance == closest and distance <= 5000]


class ImportRow(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True, str_strip_whitespace=True)


class TranscriptSegment(ImportRow):
    start_ms: Timestamp
    end_ms: Timestamp
    speaker: str = Field(default='', max_length=80)
    text: str = Field(min_length=1, max_length=2000)

    @model_validator(mode='after')
    def check_interval(self):
        if self.end_ms <= self.start_ms:
            raise ValueError('转写结束时间须晚于开始时间')
        return self


class ImportedOCR(ImportRow):
    text: str = Field(min_length=1, max_length=500)
    box: list[Coordinate] | None = Field(default=None, min_length=4, max_length=4)
    confidence: float | None = Field(default=None, ge=0, le=1)

    @model_validator(mode='after')
    def check_box(self):
        if self.box and (self.box[2] <= self.box[0] or self.box[3] <= self.box[1]):
            raise ValueError('OCR 矩形的右下角须位于左上角之后')
        return self


class Keyframe(ImportRow):
    filename: str = Field(min_length=1, max_length=180)
    at_ms: Timestamp
    ocr: list[ImportedOCR] = Field(max_length=40)


class TimelineImport(ImportRow):
    version: Literal[1]
    transcript: list[TranscriptSegment] = Field(min_length=1, max_length=300)
    keyframes: list[Keyframe] = Field(default_factory=list, max_length=5)

    @model_validator(mode='after')
    def check_sources(self):
        if sum(len(segment.text) for segment in self.transcript) > 30_000:
            raise ValueError('转写正文合计最多 30,000 字，请按主题拆分交流记录')
        names = [frame.filename.casefold() for frame in self.keyframes]
        if len(set(names)) != len(names):
            raise ValueError('关键截图文件名不能重复')
        return self

    def segments(self):
        ordered = sorted(self.transcript, key=lambda segment: (segment.start_ms, segment.end_ms))
        return [dict(id=f'T{index}', **segment.model_dump()) for index, segment in enumerate(ordered, 1)]
