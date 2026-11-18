from sqlalchemy import String, Text, Integer, JSON, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column
from superagent.core.db import Base, now

class RouterSession(Base):
    __tablename__ = 'router_sessions'
    project_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    codex_thread_id: Mapped[str | None] = mapped_column(String(200), nullable=True)
    codex_turn_id: Mapped[str | None] = mapped_column(String(200), nullable=True)
    status: Mapped[str] = mapped_column(String(32), default='idle')
    state_version: Mapped[int] = mapped_column(Integer, default=1)
    outcome_unknown: Mapped[bool] = mapped_column(default=False)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    updated_at: Mapped[str] = mapped_column(String(40), default=now)

class RouterMessage(Base):
    __tablename__ = 'router_messages'
    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(Integer, index=True)
    role: Mapped[str] = mapped_column(String(20))
    content: Mapped[str] = mapped_column(Text)
    data: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[str] = mapped_column(String(40), default=now)

class RoutingSession(Base):
    __tablename__ = 'event_routing_sessions'
    event_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    state_version: Mapped[int] = mapped_column(Integer, default=1)
    status: Mapped[str] = mapped_column(String(32), default='idle')
    outcome_unknown: Mapped[bool] = mapped_column(default=False)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    updated_at: Mapped[str] = mapped_column(String(40), default=now)


class RoutingMessage(Base):
    __tablename__ = 'event_routing_messages'
    __table_args__ = (UniqueConstraint('event_id', 'item_key'),)
    id: Mapped[int] = mapped_column(primary_key=True)
    event_id: Mapped[int] = mapped_column(Integer, index=True)
    role: Mapped[str] = mapped_column(String(20))
    content: Mapped[str] = mapped_column(Text)
    item_key: Mapped[str | None] = mapped_column(String(255), nullable=True)
    data: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[str] = mapped_column(String(40), default=now)
