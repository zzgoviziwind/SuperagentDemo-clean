"""Opt-in connector lifecycle and database-backed incremental checkpoints."""

import asyncio
import json
import os
from pathlib import Path
from uuid import uuid4
from datetime import timedelta, timezone
from zoneinfo import ZoneInfo

from sqlalchemy import JSON, String, or_, select, update
from sqlalchemy.orm import Mapped, mapped_column

from .db import Artifact, Base, Event, Project, Session, Task, now
from .ingestion import EventAttachmentJob, ingest_event


def schedule_attachments(receipt, *, session_factory=None, settings=None, redmine_factory=None, owner=None):
    if receipt.get("duplicate") or receipt.get("data", {}).get("attachments_status") != "pending":
        return
    owner = owner or manager
    if owner.stopping:
        return
    task = asyncio.create_task(prepare_attachments(receipt["id"], session_factory=session_factory,
                              settings=settings, redmine_factory=redmine_factory))
    owner.track(task, owner._attachment_tasks)
    return task


async def prepare_attachments(event_id, *, session_factory=None, settings=None, redmine_factory=None):
    """Fetch fresh source manifests. Only bounded connector-produced files enter prompts."""
    factory, settings = session_factory or Session, settings or get_config
    with factory.begin() as session:
        claimed = session.execute(update(EventAttachmentJob).where(EventAttachmentJob.event_id == event_id,
                                  EventAttachmentJob.status == "pending").values(status="processing"))
        if not claimed.rowcount:
            return
        event = session.get(Event, event_id)
        job = session.get(EventAttachmentJob, event_id)
        data, source, task_id = dict(event.data), event.source, event.task_id
        revision, control_version = job.revision, job.control_version
        project = session.get(Project, session.get(Task, task_id).project_id)
        allowed_projects = {str(value) for value in project.redmine_project_ids}
    results, failure, client = [], None, None
    try:
        config = settings("connectors." + source, {})
        if config.get("enabled") is not True:
            raise ValueError("connector_disabled")
        root = Path(os.getenv("SUPERAGENT_ATTACHMENTS_ROOT", "./data/attachments")).resolve()
        directory = root / str(task_id) / str(event_id) / uuid4().hex
        if source == "redmine":
            from superagent.connectors.redmine import RedmineClient
            if data.get("metadata", {}).get("redmine_endpoint") != str(config.get("base_url", "")).rstrip("/"):
                raise ValueError("source_endpoint_mismatch")
            key = os.getenv(config.get("api_key_env", "HLZJ_REDMINE_API_KEY"))
            if not key:
                raise ValueError("credential_missing")
            client = (redmine_factory or RedmineClient)(config["base_url"], key)
            issue = await client.get_issue(int(data["issue_id"]))
            if str(issue.get("id")) != str(data["issue_id"]) or str(issue.get("project", {}).get("id")) not in allowed_projects:
                raise ValueError("attachment_issue_scope_mismatch")
            requested = {str(item["id"]) for item in data["attachments"] if isinstance(item, dict) and "id" in item}
            manifests = {str(item["id"]): item for item in issue.get("attachments", [])}
            if not requested or not requested.issubset(manifests) or len(requested) > 10:
                raise ValueError("attachment_manifest_missing_or_excessive")
            for attachment_id in sorted(requested):
                # Event-provided URLs and local paths are deliberately never consulted.
                result = await client.download_attachment(manifests[attachment_id], directory / attachment_id,
                           max_bytes=(10 if str(manifests[attachment_id].get("content_type", "")).startswith("image/") else 20) * 1024 * 1024)
                path = Path(result["local_path"]).resolve(strict=True)
                if not path.is_relative_to(directory.resolve()) or not path.is_file():
                    raise ValueError("attachment_output_outside_managed_directory")
                results.append({key: result[key] for key in ("local_path", "filename", "size", "content_type", "sha256")})
        else:
            from superagent.connectors.dingtalk import DingTalkClient
            if data.get("metadata", {}).get("profile") != config.get("profile"):
                raise ValueError("attachment_account_mismatch")
            client = DingTalkClient(config.get("executable", "dws"), profile=config["profile"])
            media = await client.download_message_resources(data["thread_id"], data.get("metadata", {}).get("message_id"), directory,
                         max_bytes=10 * 1024 * 1024, max_total_bytes=40 * 1024 * 1024, max_files=10)
            if (media.get("complete") is not True or media.get("profile") != config["profile"] or
                    media.get("conversation_id") != data["thread_id"] or media.get("message_id") != data.get("metadata", {}).get("message_id")):
                raise ValueError("attachment_scope_mismatch")
            files = media.get("attachments")
            if not isinstance(files, list) or not files or len(files) > 10:
                raise ValueError("attachment_manifest_missing_or_excessive")
            for result in files:
                path = Path(result["local_path"]).resolve(strict=True)
                if not path.is_relative_to(directory.resolve()) or not path.is_file():
                    raise ValueError("attachment_output_outside_managed_directory")
                results.append({key: result[key] for key in ("local_path", "filename", "size", "content_type", "sha256")})
    except asyncio.CancelledError:
        failure = "attachment_processing_interrupted"
        raise
    except Exception:
        failure = "附件获取或校验失败，请核验来源、权限及下载限制后重试"
    finally:
        if client:
            try:
                await client.close()
            except Exception:
                failure = "附件客户端关闭失败，请核验来源连接"
        with factory.begin() as session:
            job = session.get(EventAttachmentJob, event_id)
            event = session.get(Event, event_id)
            task = session.get(Task, task_id)
            if job.status != "processing":
                return
            job.status, job.results = ("failed" if failure else "completed"), results
            event.data = {**event.data, "attachments_status": job.status, "attachments_error": failure}
            current = task.revision == revision and task.control_version == control_version
            if not failure:
                for result in results:
                    session.add(Artifact(task_id=task_id, revision=revision, kind="source_attachment", content=json.dumps(result, ensure_ascii=False)))
                if current:
                    context = "来源附件已下载并完成大小、格式及路径校验。\n" + "\n".join(item["local_path"] for item in results)
                    session.add(Event(task_id=task_id, source="runtime", event_type="message", content=context,
                                      data={"source_event_id": event_id, "attachments": results}))
            session.execute(update(Task).where(Task.id == task_id, Task.revision == revision,
                            Task.control_version == control_version, Task.status == "waiting_resource",
                            Task.last_error == "正在准备来源附件").values(status="waiting_input" if failure else "queued",
                            last_error=failure, state_version=Task.state_version + 1, updated_at=now()))


def schedule_interruption(receipt, *, scheduler=None, session_factory=None, owner=None):
    """Dispatch after the durable receipt, without delaying connector acknowledgement."""
    if receipt.get("duplicate") or not receipt.get("data", {}).get("requires_interrupt"):
        return
    owner = owner or manager
    if owner.stopping:
        return
    if scheduler is None:
        from .scheduler import scheduler
    async def interrupt():
        try:
            await scheduler.stop_run(receipt["task_id"], "change_goal")
        except Exception:
            with (session_factory or Session).begin() as session:
                session.add(Event(task_id=receipt["task_id"], source="runtime", event_type="external_interrupt_failed",
                                  content="新需求已入库，中断旧执行失败，请人工核验执行状态", data={"event_id": receipt["id"]}))
    task = asyncio.create_task(interrupt())
    owner.track(task, owner._interrupts)
    return task


class ConnectorCursor(Base):
    __tablename__ = "connector_cursors"
    key: Mapped[str] = mapped_column(String(512), primary_key=True)
    value: Mapped[dict] = mapped_column(JSON)


class PersistentStateStore:
    def __init__(self, session_factory=None):
        self.sessions = session_factory or Session

    def get(self, key):
        with self.sessions() as session:
            row = session.get(ConnectorCursor, key)
            return row.value if row else None

    def load_snapshot(self, base_url, issue_id, project_ids, user_id):
        """Read the latest receipt from this exact endpoint, project scope and account."""
        projects = [str(value) for value in project_ids]
        if not projects:
            return None
        with self.sessions() as session:
            event = session.scalar(select(Event).where(
                Event.source == "redmine",
                Event.data["metadata"]["redmine_endpoint"].as_string() == base_url.rstrip("/"),
                Event.data["issue_id"].as_string().cast(String) == str(issue_id),
                Event.data["project_external_id"].as_string().cast(String).in_(projects),
                Event.data["metadata"]["external_user_id"].as_string().cast(String) == str(user_id),
                or_(Event.event_type == "issue.updated",
                    Event.data["original_event_type"].as_string() == "issue.updated",
                    Event.data["event_type"].as_string() == "issue.updated"),
            ).order_by(Event.id.desc()).limit(1))
            return dict(event.data) if event else None

    def set(self, key, value):
        from sqlalchemy.exc import IntegrityError
        for attempt in range(3):
            try:
                with self.sessions.begin() as session:
                    row = session.get(ConnectorCursor, key, with_for_update=True)
                    if row:
                        # Pollers may overlap. A checkpoint must never move backwards.
                        row.value = max(row.value, value) if isinstance(value, str) and isinstance(row.value, str) else value
                    else:
                        session.add(ConnectorCursor(key=key, value=value))
                return
            except IntegrityError:
                if attempt == 2:
                    raise


def get_config(key, default=None):
    from .governance import get_setting
    value = get_setting(key, None)
    if value is not None:
        return value
    if key in {"connectors.dingtalk", "connectors.redmine"}:
        name = key.split(".")[1]
        raw = os.getenv("SUPERAGENT_" + name.upper() + "_CONFIG")
        if raw:
            try:
                return validate_configuration(name, json.loads(raw))
            except (ValueError, TypeError):
                return {"configuration_error": True}
    return default


def validate_configuration(name, config):
    """Reusable by the governance settings validator. Secrets remain env references."""
    fields = {"dingtalk": {"enabled", "executable", "profile", "self_ids", "kind", "chat_id", "history"},
              "redmine": {"enabled", "base_url", "project_ids", "user_id", "api_key_env", "poll_seconds", "initial_since", "account_map"}}
    if name not in fields or not isinstance(config, dict) or set(config) - fields[name]:
        raise ValueError("连接器配置包含不支持的字段，凭据仅允许环境变量引用")
    if "enabled" in config and type(config["enabled"]) is not bool:
        raise ValueError("enabled 必须为布尔值")
    if name == "dingtalk":
        if "self_ids" in config and (not isinstance(config["self_ids"], list) or any(not isinstance(x, str) or not x for x in config["self_ids"])):
            raise ValueError("self_ids 必须是账号标识列表")
        if "kind" in config and config["kind"] not in {"at-me", "group"}:
            raise ValueError("监听范围无效")
        if "history" in config:
            history = config["history"]
            keys = {"chat_ids", "initial_since", "history_timezone", "sender_map", "page_limit", "timeout"}
            if not isinstance(history, dict) or set(history) - keys:
                raise ValueError("历史恢复配置字段无效")
            chats = history.get("chat_ids")
            if not isinstance(chats, list) or not chats or len(chats) > 100 or any(not isinstance(x, str) or not x for x in chats):
                raise ValueError("历史恢复必须指定会话范围")
            from superagent.connectors.common import timestamp
            timestamp(history.get("initial_since"))
            history_timezone(history.get("history_timezone"))
            if type(history.get("page_limit", 40)) is not int or not 1 <= history.get("page_limit", 40) <= 40:
                raise ValueError("历史查询分页预算无效")
            if type(history.get("timeout", 120)) not in {int, float} or not 1 <= history.get("timeout", 120) <= 300:
                raise ValueError("历史查询超时无效")
            mapping = history.get("sender_map", {})
            if not isinstance(mapping, dict) or len(mapping) > 1000 or any(not isinstance(k, str) or not isinstance(v, str) or not k or not v for k, v in mapping.items()):
                raise ValueError("历史账号映射无效")
            if config.get("kind", "at-me") == "group" and set(chats) != {config.get("chat_id")}:
                raise ValueError("群监听历史范围必须与监听群一致")
    else:
        if "project_ids" in config and (not isinstance(config["project_ids"], list) or any(type(x) is not int or x <= 0 for x in config["project_ids"])):
            raise ValueError("project_ids 必须是正整数列表")
        if "poll_seconds" in config and (type(config["poll_seconds"]) not in {int, float} or not 1 <= config["poll_seconds"] <= 86400):
            raise ValueError("轮询间隔必须介于 1 和 86400 秒")
    return config


def history_timezone(value):
    if not isinstance(value, str) or not value:
        raise ValueError("历史恢复需要明确时区")
    if value == "UTC":
        return timezone.utc
    if len(value) == 6 and value[0] in "+-" and value[3] == ":":
        try:
            hours, minutes = int(value[1:3]), int(value[4:6])
            if hours > 23 or minutes > 59:
                raise ValueError
            return timezone((1 if value[0] == "+" else -1) * timedelta(hours=hours, minutes=minutes))
        except ValueError:
            raise ValueError("历史时区偏移无效") from None
    try:
        return ZoneInfo(value)
    except (KeyError, ValueError):
        raise ValueError("历史时区不可用，请配置 UTC 或明确偏移如 +08:00") from None


class ConnectionManager:
    """One application instance owns the listeners. No import-time processes."""

    def __init__(self, *, settings=None, session_factory=None, emit=None,
                 redmine_factory=None, listener_factory=None):
        self.settings = settings or get_config
        self.sessions = session_factory or Session
        self.store = PersistentStateStore(self.sessions)
        self.emit = emit or self._emit
        self.redmine_factory = redmine_factory
        self.listener_factory = listener_factory
        self.instances = {}
        self.tasks = {}
        self.errors = {}
        self.seen = {}
        self.lock = asyncio.Lock()
        self.stopping = False
        self._attachment_tasks = set()
        self._interrupts = set()
        self._cancel_requested = set()
        self._stop_events = {}
        self._closing = {}
        self.shutdown_timeout = 35

    def track(self, task, collection):
        collection.add(task)
        def finished(completed):
            collection.discard(completed)
            self._cancel_requested.discard(completed)
            if not completed.cancelled() and completed.exception():
                self.errors["background"] = "后台任务退出异常，请核验事件与附件状态"
        task.add_done_callback(finished)

    async def _emit(self, event):
        if self.stopping:
            raise RuntimeError("连接器正在停止，事件等待来源重放")
        receipt = ingest_event(event, session_factory=self.sessions, settings=self.settings)
        schedule_interruption(receipt, session_factory=self.sessions, owner=self)
        schedule_attachments(receipt, session_factory=self.sessions, settings=self.settings, redmine_factory=self.redmine_factory, owner=self)
        self.seen[event["source"]] = now()
        return receipt

    def config(self, name):
        value = self.settings("connectors." + name, {})
        try:
            return validate_configuration(name, value)
        except (ValueError, TypeError):
            self.errors[name] = "连接器配置无效"
            return {}

    def configured(self, name):
        config = self.config(name)
        if name == "redmine":
            return bool(config.get("base_url") and config.get("project_ids") and config.get("user_id")
                        and os.getenv(config.get("api_key_env", "HLZJ_REDMINE_API_KEY")))
        return bool(config.get("profile") and config.get("self_ids") and config.get("executable"))

    def statuses(self):
        rows = []
        for name in ("dingtalk", "redmine"):
            enabled = self.config(name).get("enabled") is True
            instance = self.instances.get(name)
            running = name in self.tasks and not self.tasks[name].done()
            status = getattr(instance, "status", "running" if running else "stopped")
            closing = self._closing.get(name)
            if closing and not closing.done():
                status = "stop_failed" if "shutdown" in self.errors else "stopping"
            if name in self.errors:
                status = "failed"
            if getattr(instance, "last_error", None) == "dws_disconnected_replay_required":
                status = "waiting_recovery"
            if not enabled and not instance:
                status = "disabled"
            rows.append(dict(id=name, name=name, configured=self.configured(name), enabled=enabled,
                             status=status, last_error=self.errors.get(name) or (self.errors.get("shutdown") if closing and not closing.done() else None) or getattr(instance, "last_error", None),
                             last_seen=self.seen.get(name) or getattr(instance, "last_seen", None)))
        return rows

    async def start(self, name=None):
        async with self.lock:
            if any(not task.done() for task in self._closing.values()) or (self.stopping and (self._attachment_tasks or self._interrupts)):
                raise RuntimeError("前次后台资源尚未退出，请等待停止完成")
            self.stopping = False
            if name is None and not self._attachment_tasks:
                with self.sessions.begin() as session:
                    for job in session.scalars(select(EventAttachmentJob).where(EventAttachmentJob.status == "processing")):
                        job.status = "failed"
                        event = session.get(Event, job.event_id)
                        error = "服务重启，附件处理结果未知，请核验后明确重试"
                        event.data = {**event.data, "attachments_status": "failed", "attachments_error": error}
                        session.execute(update(Task).where(Task.id == job.task_id, Task.revision == job.revision,
                                        Task.control_version == job.control_version, Task.status == "waiting_resource",
                                        Task.last_error == "正在准备来源附件").values(status="waiting_input", last_error=error,
                                        state_version=Task.state_version + 1, updated_at=now()))
                    pending = list(session.scalars(select(EventAttachmentJob.event_id).where(EventAttachmentJob.status == "pending")))
                for event_id in pending:
                    schedule_attachments({"id": event_id, "data": {"attachments_status": "pending"}}, session_factory=self.sessions,
                                         settings=self.settings, redmine_factory=self.redmine_factory, owner=self)
            for connector in ([name] if name else ["dingtalk", "redmine"]):
                if connector not in {"dingtalk", "redmine"}:
                    raise ValueError("未知连接器")
                if self.config(connector).get("enabled") is not True:
                    if name:
                        raise ValueError("请先明确启用连接器配置")
                    continue
                if not self.configured(connector):
                    self.errors[connector] = "连接器配置不完整"
                    continue
                if connector in self.instances:
                    continue
                self.errors.pop(connector, None)
                try:
                    await self._start_one(connector)
                except Exception:
                    self.errors[connector] = "连接器启动失败，请检查配置与服务状态"
                    instance = self.instances.pop(connector, None)
                    if instance:
                        await (instance.stop() if connector == "dingtalk" else instance.close())
        return self.statuses()

    async def _start_one(self, name):
        config = self.config(name)
        if name == "dingtalk":
            from superagent.connectors.dingtalk import DingTalkHistoryReplay, DingTalkListener
            factory = self.listener_factory or DingTalkListener
            replay = None
            history = config.get("history")
            if history:
                with self.sessions() as session:
                    bindings = [p.dingtalk_chat_ids for p in session.scalars(select(Project).where(Project.enabled.is_(True)))]
                if any(sum(chat in chats for chats in bindings) != 1 for chat in history["chat_ids"]):
                    raise ValueError("历史查询会话必须具有唯一启用项目绑定")
                replay = DingTalkHistoryReplay(config["executable"], profile=config["profile"],
                         chat_ids=history["chat_ids"], initial_since=history["initial_since"],
                         history_timezone=history_timezone(history["history_timezone"]), kind=config.get("kind", "at-me"),
                         sender_map=history.get("sender_map"), page_limit=history.get("page_limit", 40), timeout=history.get("timeout", 120))
            listener = factory(config["executable"], self.emit, profile=config["profile"],
                               self_ids=config["self_ids"], kind=config.get("kind", "at-me"),
                               chat_id=config.get("chat_id"), state_store=self.store, replay=replay)
            if replay and not self.store.get(listener.key):
                self.store.set(listener.key, replay.initial_since)
            self.instances[name] = listener
            await listener.start()
        else:
            from superagent.connectors.redmine import RedmineClient, RedminePoller
            client = (self.redmine_factory or RedmineClient)(config["base_url"], os.environ[config.get("api_key_env", "HLZJ_REDMINE_API_KEY")])
            self.instances[name] = client
            poller = RedminePoller(client, self.emit, self.store, config["project_ids"], config["user_id"],
                                   account_map=config.get("account_map", {}), initial_since=config.get("initial_since"),
                                   load_snapshot=self.store.load_snapshot)
            self._stop_events[name] = asyncio.Event()
            self.tasks[name] = asyncio.create_task(self._poll(poller, max(1, float(config.get("poll_seconds", 30)))))

    async def _poll(self, poller, seconds):
        stop = self._stop_events["redmine"]
        while not stop.is_set():
            try:
                await poller.poll_once()
                self.seen["redmine"] = now()
                self.errors.pop("redmine", None)
            except asyncio.CancelledError:
                raise
            except Exception:
                self.errors["redmine"] = "轮询失败，已保留持久游标并等待重试"
            try:
                await asyncio.wait_for(stop.wait(), seconds)
            except TimeoutError:
                pass

    async def _stop_connector(self, name):
        if name in self._stop_events:
            self._stop_events[name].set()
        task = self.tasks.get(name)
        if task:
            # Preserve the poll coroutine's ownership of an in-flight HTTP thread.
            await asyncio.shield(task)
        instance = self.instances.get(name)
        if instance:
            await (instance.stop() if name == "dingtalk" else instance.close())
        self.tasks.pop(name, None)
        self.instances.pop(name, None)
        self.errors.pop(name, None)

    async def stop(self, name=None):
        async with self.lock:
            if name is None:
                self.stopping = True
            closing = []
            for connector in ([name] if name else list(self.instances)):
                task = self._closing.get(connector)
                if task is None or task.done():
                    task = asyncio.create_task(self._stop_connector(connector))
                    self._closing[connector] = task
                closing.append(task)
            if name is None:
                tasks = list(self._attachment_tasks | self._interrupts)
                for task in tasks:
                    if task not in self._cancel_requested:
                        self._cancel_requested.add(task)
                        task.cancel()
                closing.extend(tasks)
            if closing:
                done, pending = await asyncio.wait(closing, timeout=self.shutdown_timeout)
                for task in done:
                    if not task.cancelled() and task.exception():
                        self.errors["shutdown"] = "后台资源关闭失败，请核验来源连接"
                        raise RuntimeError(self.errors["shutdown"])
                if pending:
                    # Keep strong references and do not interrupt cleanup a second time.
                    self.errors["shutdown"] = "后台资源尚未退出，保留任务引用等待核验"
                    raise RuntimeError(self.errors["shutdown"])
                self.errors.pop("shutdown", None)
                self._closing = {key: task for key, task in self._closing.items() if not task.done()}
        return self.statuses()


manager = ConnectionManager()
