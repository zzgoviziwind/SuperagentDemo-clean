"""Persist field notes, screenshots and the individual review decisions."""
import re

from sqlalchemy import JSON, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base, now


class FieldRecord(Base):
    __tablename__ = 'field_records'
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    project_id: Mapped[int] = mapped_column(index=True)
    title: Mapped[str] = mapped_column(String(200))
    notes: Mapped[str] = mapped_column(Text)
    screenshots: Mapped[list] = mapped_column(JSON)
    owner_id: Mapped[str] = mapped_column(String(200))
    created_at: Mapped[str] = mapped_column(String(40), default=now)


class FieldCandidate(Base):
    __tablename__ = 'field_candidates'
    id: Mapped[int] = mapped_column(primary_key=True)
    record_id: Mapped[str] = mapped_column(String(36), index=True)
    draft: Mapped[dict] = mapped_column(JSON)
    decision: Mapped[dict | None] = mapped_column(JSON, nullable=True)


class FieldTimeline(Base):
    __tablename__ = 'field_timelines'
    record_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    transcript: Mapped[list] = mapped_column(JSON)


def organize_sample(notes, screenshot_count):
    """Offline trial organizer. Keeps original lines and explicit image references."""
    drafts, used = [], set()
    for number, line in enumerate(notes.splitlines(), 1):
        match = re.fullmatch(r'\s*(?:[-*]\s*)?(?:(Bug|缺陷|需求|疑问)\s*[:：]\s*)?(.+?)\s*', line, re.I)
        if not match or not line.strip():
            continue
        label, body = match.groups()
        images = sorted({int(i) for i in re.findall(r'\[截图([1-5])\]', body) if int(i) <= screenshot_count})
        used.update(images)
        detail = re.sub(r'\[截图[1-5]\]', '', body).strip() or '请核对所附截图。'
        kind = 'requirement' if label == '需求' else 'bug' if label and label.lower() in {'bug', '缺陷'} else 'question'
        drafts.append(dict(kind=kind, title=detail[:200], detail=detail[:2500], note_line=number,
                           quote=line, screenshots=images))
    for image in range(1, screenshot_count + 1):
        if image not in used:
            drafts.append(dict(kind='question', title=f'核对截图 {image}', detail='请填写截图中的现象和期望。',
                               note_line=None, quote='', screenshots=[image]))
    return drafts
