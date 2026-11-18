import os
from datetime import datetime, timezone
from sqlalchemy import create_engine, String, Integer, Text, JSON, Index, UniqueConstraint, text
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker


def now():
    return datetime.now(timezone.utc).isoformat()

class Base(DeclarativeBase): pass

class Project(Base):
    __tablename__ = 'projects'
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    repo_path: Mapped[str] = mapped_column(Text)
    repositories: Mapped[list] = mapped_column(JSON, default=list)
    reference_access: Mapped[str] = mapped_column(String(16), default='workspace', server_default='workspace')
    reference_dirs: Mapped[list] = mapped_column(JSON, default=list, server_default='[]')
    base_branch: Mapped[str] = mapped_column(String(200), default='main')
    test_command: Mapped[str] = mapped_column(Text, default='')
    allowed_paths: Mapped[list] = mapped_column(JSON, default=list)
    dingtalk_chat_ids: Mapped[list] = mapped_column(JSON, default=list)
    redmine_project_ids: Mapped[list] = mapped_column(JSON, default=list)
    enabled: Mapped[bool] = mapped_column(default=True)
    archived: Mapped[bool] = mapped_column(default=False, server_default='false')
    created_at: Mapped[str] = mapped_column(String(40), default=now)

class Task(Base):
    __tablename__ = 'tasks'
    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(300))
    kind: Mapped[str] = mapped_column(String(16), default='repair', server_default='repair')
    owner_id: Mapped[str] = mapped_column(String(200), default='local-admin', server_default='local-admin')
    outcome_unknown: Mapped[bool] = mapped_column(default=False, server_default='false')
    goal: Mapped[str] = mapped_column(Text)
    project_id: Mapped[int] = mapped_column(Integer, index=True)
    status: Mapped[str] = mapped_column(String(32), default='queued', index=True)
    revision: Mapped[int] = mapped_column(default=1)
    state_version: Mapped[int] = mapped_column(default=1)
    control_version: Mapped[int] = mapped_column(default=1)
    source: Mapped[str] = mapped_column(String(32), default='web')
    source_ref: Mapped[str | None] = mapped_column(Text, nullable=True)
    acceptance_criteria: Mapped[str] = mapped_column(Text, default='')
    created_at: Mapped[str] = mapped_column(String(40), default=now)
    updated_at: Mapped[str] = mapped_column(String(40), default=now)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    codex_thread_id: Mapped[str | None] = mapped_column(String(200), nullable=True)
    codex_turn_id: Mapped[str | None] = mapped_column(String(200), nullable=True)
    workspace_path: Mapped[str | None] = mapped_column(Text, nullable=True)

class Event(Base):
    __tablename__ = 'events'
    __table_args__ = (UniqueConstraint('source', 'external_id'),)
    id: Mapped[int] = mapped_column(primary_key=True)
    task_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    source: Mapped[str] = mapped_column(String(40))
    external_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    event_type: Mapped[str] = mapped_column(String(80))
    content: Mapped[str] = mapped_column(Text, default='')
    data: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[str] = mapped_column(String(40), default=now)

class Artifact(Base):
    __tablename__ = 'artifacts'
    id: Mapped[int] = mapped_column(primary_key=True)
    task_id: Mapped[int] = mapped_column(Integer, index=True)
    revision: Mapped[int] = mapped_column(Integer)
    kind: Mapped[str] = mapped_column(String(80))
    content: Mapped[str] = mapped_column(Text)
    created_at: Mapped[str] = mapped_column(String(40), default=now)
    attempt_id: Mapped[str | None] = mapped_column(String(36), nullable=True)

ACTIVE_ATTEMPT_STATUSES = ('claimed', 'running', 'waiting_approval')
_active_attempt = text("status IN ('claimed', 'running', 'waiting_approval')")

class ExecutionAttempt(Base):
    __tablename__ = 'execution_attempts'
    __table_args__ = (
        UniqueConstraint('task_id', 'attempt_no'),
        Index('ix_execution_attempts_task_status', 'task_id', 'status'),
        Index('uq_execution_attempts_active_task', 'task_id', unique=True,
              sqlite_where=_active_attempt, postgresql_where=_active_attempt),
    )
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    task_id: Mapped[int] = mapped_column(Integer)
    attempt_no: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(32))
    phase: Mapped[str] = mapped_column(String(32))
    owner: Mapped[str] = mapped_column(String(36))
    revision: Mapped[int] = mapped_column(Integer)
    control_version: Mapped[int] = mapped_column(Integer)
    thread_id: Mapped[str | None] = mapped_column(String(200))
    turn_id: Mapped[str | None] = mapped_column(String(200))
    manifest_id: Mapped[int | None] = mapped_column(Integer)
    workspace_path: Mapped[str | None] = mapped_column(Text)
    base_sha: Mapped[str | dict | None] = mapped_column(JSON(none_as_null=True))
    started_at: Mapped[str | None] = mapped_column(String(40))
    updated_at: Mapped[str] = mapped_column(String(40), default=now)
    ended_at: Mapped[str | None] = mapped_column(String(40))
    last_error: Mapped[str | None] = mapped_column(Text)

class ControllerLease(Base):
    __tablename__ = 'controller_leases'
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    owner: Mapped[str] = mapped_column(String(36))
    epoch: Mapped[int] = mapped_column(Integer)
    heartbeat_at: Mapped[str] = mapped_column(String(40))
    expires_at: Mapped[str] = mapped_column(String(40))

class Decision(Base):
    __tablename__ = 'decisions'
    __table_args__ = (Index('ix_decisions_scope_status', 'project_id', 'task_id', 'status'),)
    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(Integer)
    task_id: Mapped[int | None] = mapped_column(Integer)
    event_id: Mapped[int | None] = mapped_column(Integer)
    kind: Mapped[str] = mapped_column(String(20))
    content: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(20), default='active')
    superseded_by: Mapped[int | None] = mapped_column(Integer)
    revision: Mapped[int | None] = mapped_column(Integer)
    actor: Mapped[str] = mapped_column(String(200))
    created_at: Mapped[str] = mapped_column(String(40), default=now)
    revoked_at: Mapped[str | None] = mapped_column(String(40))
    revoked_by: Mapped[str | None] = mapped_column(String(200))
    revocation_reason: Mapped[str | None] = mapped_column(Text)

class ContextManifest(Base):
    __tablename__ = 'context_manifests'
    id: Mapped[int] = mapped_column(primary_key=True)
    attempt_id: Mapped[str | None] = mapped_column(String(36), index=True)
    task_id: Mapped[int] = mapped_column(Integer, index=True)
    project_id: Mapped[int] = mapped_column(Integer)
    revision: Mapped[int] = mapped_column(Integer)
    control_version: Mapped[int] = mapped_column(Integer)
    thread_id: Mapped[str] = mapped_column(String(200))
    turn_id: Mapped[str | None] = mapped_column(String(200))
    budget_chars: Mapped[int] = mapped_column(Integer)
    items: Mapped[list] = mapped_column(JSON)
    created_at: Mapped[str] = mapped_column(String(40), default=now)

class Approval(Base):
    __tablename__ = 'approvals'
    id: Mapped[int] = mapped_column(primary_key=True)
    task_id: Mapped[int] = mapped_column(Integer, index=True)
    revision: Mapped[int] = mapped_column(Integer)
    control_version: Mapped[int] = mapped_column(Integer)
    action_hash: Mapped[str] = mapped_column(String(64))
    action: Mapped[dict] = mapped_column(JSON)
    status: Mapped[str] = mapped_column(String(32), default='pending')
    created_at: Mapped[str] = mapped_column(String(40), default=now)

url = os.getenv('SUPERAGENT_DATABASE_URL', 'sqlite:///./superagent.db')
engine = create_engine(url, connect_args={'check_same_thread': False} if url.startswith('sqlite') else {})
Session = sessionmaker(engine, expire_on_commit=False)

def init_db():
    from sqlalchemy import inspect, text
    Base.metadata.create_all(engine)
    # Non-destructive compatibility upgrade for databases created by the initial prototype.
    project_columns = {c['name'] for c in inspect(engine).get_columns('projects')}
    with engine.begin() as conn:
        if 'archived' not in project_columns:
            conn.execute(text("ALTER TABLE projects ADD COLUMN archived BOOLEAN NOT NULL DEFAULT false"))
        if 'reference_access' not in project_columns:
            conn.execute(text("ALTER TABLE projects ADD COLUMN reference_access VARCHAR(16) NOT NULL DEFAULT 'workspace'"))
        if 'reference_dirs' not in project_columns:
            conn.execute(text("ALTER TABLE projects ADD COLUMN reference_dirs JSON NOT NULL DEFAULT '[]'"))
        if 'repositories' not in project_columns:
            conn.execute(text("ALTER TABLE projects ADD COLUMN repositories JSON NOT NULL DEFAULT '[]'"))
    columns = {c['name'] for c in inspect(engine).get_columns('tasks')}
    with engine.begin() as conn:
        if 'kind' not in columns:
            conn.execute(text("ALTER TABLE tasks ADD COLUMN kind VARCHAR(16) NOT NULL DEFAULT 'repair'"))
        if 'owner_id' not in columns:
            conn.execute(text("ALTER TABLE tasks ADD COLUMN owner_id VARCHAR(200) NOT NULL DEFAULT 'local-admin'"))
        if 'outcome_unknown' not in columns:
            conn.execute(text("ALTER TABLE tasks ADD COLUMN outcome_unknown BOOLEAN NOT NULL DEFAULT false"))
    with engine.begin() as conn:
        artifacts = {c['name'] for c in inspect(conn).get_columns('artifacts')}
        if 'attempt_id' not in artifacts:
            conn.execute(text("ALTER TABLE artifacts ADD COLUMN attempt_id VARCHAR(36)"))
        attempts = {c['name'] for c in inspect(conn).get_columns('execution_attempts')}
        if 'manifest_id' not in attempts:
            conn.execute(text("ALTER TABLE execution_attempts ADD COLUMN manifest_id INTEGER"))
        if inspect(conn).has_table('delivery_records'):
            delivery = {c['name'] for c in inspect(conn).get_columns('delivery_records')}
            if 'claim_token' not in delivery:
                conn.execute(text("ALTER TABLE delivery_records ADD COLUMN claim_token VARCHAR(36)"))

def dump(obj):
    return {c.name: getattr(obj, c.name) for c in obj.__table__.columns}
