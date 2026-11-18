"""Redmine REST adapter with acknowledged, inclusive incremental polling."""

import asyncio
import json
import os
import re
import threading
from http.client import HTTPException
from datetime import datetime, timedelta, timezone
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit, urljoin, unquote
from urllib.request import Request, build_opener, HTTPRedirectHandler

from .common import (ConnectorError, WriteOutcomeUnknown, digest, execute_write, preview,
                     resolve, timestamp, utc_now)
from .attachments import DEFAULT_MIME_TYPES, output_directory, save_response, validate_filename


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _issue_semantics(issue):
    return {"subject": issue.get("subject") or "", "description": issue.get("description") or "",
            "assigned_to_id": str((issue.get("assigned_to") or {}).get("id") or ""),
            "project_id": str(issue["project"]["id"])}


def restore_issue_checkpoint(event, *, base_url, issue_id, project_ids, user_id):
    """Reconstruct only provable semantics from a durably consumed source event.

    The owning service supplies the latest persisted issue.updated event.data.
    Unknown historical assignment is left unresolved so real changes still emit.
    """
    if not isinstance(event, dict) or event.get("source") != "redmine":
        return None
    kind = event.get("original_event_type", event.get("event_type"))
    metadata = event.get("metadata") or {}
    project_id = str(event.get("project_external_id", ""))
    if (kind != "issue.updated" or str(event.get("issue_id")) != str(issue_id) or
            project_id not in {str(value) for value in project_ids} or not isinstance(metadata, dict) or
            metadata.get("redmine_endpoint") != base_url.rstrip("/") or
            str(metadata.get("external_user_id")) != str(user_id)):
        return None
    content = event.get("content")
    if not isinstance(content, str) or "\n" not in content:
        return None
    if "assigned_to_id" in metadata:
        if type(metadata["assigned_to_id"]) not in {str, int}:
            return None
        assigned = str(metadata["assigned_to_id"])
    elif metadata.get("assigned_to_me") is True:
        assigned = str(user_id)
    else:
        return None
    if ((assigned and not re.fullmatch(r"[0-9]+", assigned)) or
            (type(metadata.get("assigned_to_me")) is bool and
             metadata["assigned_to_me"] != (assigned == str(user_id)))):
        return None
    subject, _, description = content.partition("\n")
    fingerprint = digest({"subject": subject, "description": description,
                          "assigned_to_id": assigned, "project_id": project_id})
    if metadata.get("issue_fingerprint", fingerprint) != fingerprint:
        return None
    prefix = f"{base_url.rstrip('/')}:issue:{issue_id}:"
    external_id = event.get("external_id", "")
    if not isinstance(external_id, str) or not external_id.startswith(prefix):
        return None
    suffix = external_id[len(prefix):]
    sequence = 1
    if suffix.startswith("snapshot:"):
        match = re.fullmatch(r"snapshot:([1-9][0-9]*):([0-9a-f]{64})", suffix)
        if not match or match[2] != fingerprint:
            return None
        sequence = int(match[1])
    else:
        try:
            timestamp(suffix)
        except (TypeError, ValueError):
            return None
    if metadata.get("issue_snapshot_sequence", sequence) != sequence:
        return None
    return {"fingerprint": fingerprint, "sequence": sequence, "assigned_to_id": assigned}


class RedmineClient:
    def __init__(self, base_url, api_key=None, *, timeout=30, page_size=100,
                 transport=None):
        parts = urlsplit(base_url)
        if parts.scheme not in {"http", "https"} or not parts.netloc or parts.username or parts.query or parts.fragment:
            raise ValueError("Redmine URL must be an HTTP(S) service root without credentials")
        self.base_url = base_url.rstrip("/")
        self._api_key = api_key or os.environ.get("HLZJ_REDMINE_API_KEY", "")
        if not self._api_key:
            raise ValueError("Redmine API key is required through local configuration")
        if not 1 <= page_size <= 100 or timeout <= 0:
            raise ValueError("Invalid page size or timeout")
        self.timeout = timeout
        self.page_size = page_size
        self._transport = transport or self._http
        self._closed = False

    async def _http(self, method, path, params, body):
        def send():
            url = self.base_url + path
            if params:
                url += "?" + urlencode(params)
            request = Request(url, data=None if body is None else json.dumps(body).encode(),
                              method=method, headers={"X-Redmine-API-Key": self._api_key,
                                                      "Content-Type": "application/json"})
            try:
                with build_opener(_NoRedirect).open(request, timeout=self.timeout) as response:
                    raw = response.read()
                    return response.status, json.loads(raw) if raw else {}
            except HTTPError as error:
                return error.code, {}
        try:
            return await asyncio.to_thread(send)
        except (URLError, OSError, ValueError):
            if method != "GET":
                raise WriteOutcomeUnknown("redmine_write_outcome_unknown") from None
            raise ConnectorError("redmine_transport_failure") from None

    async def _request(self, method, path, params=None, body=None):
        if self._closed:
            raise ConnectorError("redmine_client_closed")
        try:
            status, data = await self._transport(method, path, params or {}, body)
        except (TimeoutError, OSError):
            if method != "GET":
                raise WriteOutcomeUnknown("redmine_write_outcome_unknown") from None
            raise ConnectorError("redmine_transport_failure") from None
        if status >= 500 and method != "GET":
            raise WriteOutcomeUnknown("redmine_write_outcome_unknown")
        if not 200 <= status < 300:
            raise ConnectorError({401: "redmine_unauthorized", 403: "redmine_forbidden",
                                  404: "redmine_not_found_or_invisible", 422: "redmine_validation_failed"}
                                 .get(status, f"redmine_http_{status}"))
        return data

    async def list_updated_issues(self, updated_since, project_id=None):
        # Stable IDs keep updates from moving already scanned rows across offsets.
        params = {"status_id": "*", "sort": "id:asc", "limit": self.page_size}
        if updated_since:
            # Redmine's timestamp filter accepts whole-second UTC Z values.
            # Floor the boundary so fractional-second updates are replayed.
            since = datetime.fromisoformat(timestamp(updated_since).replace("Z", "+00:00"))
            params["updated_on"] = ">=" + since.isoformat(timespec="seconds").replace("+00:00", "Z")
        if project_id is not None:
            params.update(project_id=int(project_id), subproject_id="!*")
        offset = 0
        issues = {}
        while True:
            page = await self._request("GET", "/issues.json", {**params, "offset": offset})
            rows = page.get("issues")
            total = page.get("total_count")
            if not isinstance(rows, list) or not isinstance(total, int) or page.get("offset", offset) != offset:
                raise ConnectorError("redmine_invalid_pagination")
            for issue in rows:
                issues[str(issue["id"])] = issue
            offset += len(rows)
            if offset >= total:
                return list(issues.values())
            if not rows:
                raise ConnectorError("redmine_incomplete_pagination")

    async def get_issue(self, issue_id):
        data = await self._request("GET", f"/issues/{int(issue_id)}.json",
                                   {"include": "journals,attachments"})
        issue = data.get("issue")
        if not isinstance(issue, dict):
            raise ConnectorError("redmine_invalid_issue")
        return issue

    async def download_attachment(self, attachment, output_dir, *, max_bytes=20 * 1024 * 1024,
                                  mime_types=DEFAULT_MIME_TYPES):
        """Download only a caller-authorized attachment from this Redmine origin."""
        if self._closed:
            raise ConnectorError("redmine_client_closed")
        if not isinstance(max_bytes, int) or max_bytes <= 0:
            raise ValueError("max_bytes must be positive")
        filename = validate_filename(attachment.get("filename"))
        attachment_id = int(attachment["id"])
        if attachment_id <= 0:
            raise ValueError("Attachment ID must be positive")
        url = urljoin(self.base_url + "/", attachment["content_url"])
        base, resource = urlsplit(self.base_url), urlsplit(url)
        def origin(parts):
            return parts.scheme.lower(), parts.hostname, parts.port or (443 if parts.scheme == "https" else 80)
        if (origin(resource) != origin(base) or resource.username is not None or
                resource.password is not None or resource.fragment):
            raise ConnectorError("attachment_untrusted_origin")
        segments = unquote(resource.path).split("/")
        if any(segment in {".", ".."} or "\\" in segment for segment in segments):
            raise ConnectorError("attachment_unsafe_url")
        # Bind credentials to the expected attachment route, including subpath installs.
        expected_route = base.path.rstrip("/") + "/attachments/download/" + str(attachment_id)
        if resource.path != expected_route and not resource.path.startswith(expected_route + "/"):
            raise ConnectorError("attachment_url_id_mismatch")
        size = attachment.get("filesize")
        if size is not None:
            size = int(size)
            if size < 0 or size > max_bytes:
                raise ConnectorError("attachment_size_limit")
        directory = output_directory(output_dir)
        if (directory / filename).exists() or (directory / filename).is_symlink():
            raise ConnectorError("attachment_file_exists")
        cancelled = threading.Event()
        def download():
            request = Request(url, headers={"X-Redmine-API-Key": self._api_key,
                                             "Accept-Encoding": "identity"})
            try:
                with build_opener(_NoRedirect).open(request, timeout=self.timeout) as response:
                    result = save_response(response, filename=filename, output_dir=directory,
                                           max_bytes=max_bytes, mime_types=frozenset(mime_types),
                                           expected_size=size, expected_mime=attachment.get("content_type"),
                                           cancelled=cancelled)
                    return {**result, "attachment_id": attachment_id, "source": "redmine"}
            except HTTPError as error:
                raise ConnectorError(f"attachment_http_{error.code}") from None
            except (URLError, OSError, HTTPException):
                raise ConnectorError("attachment_transport_failure") from None
        worker = asyncio.create_task(asyncio.to_thread(download))
        try:
            return await asyncio.shield(worker)
        except asyncio.CancelledError:
            cancelled.set()
            await asyncio.gather(worker, return_exceptions=True)
            raise

    async def add_comment(self, issue_id, content, *, authorization=None, ledger=None):
        if not content.strip():
            raise ValueError("Comment cannot be empty")
        plan = preview("redmine", "comment", {"base_url": self.base_url, "issue_id": int(issue_id)},
                       {"content": content})
        async def write():
            await self._request("PUT", f"/issues/{int(issue_id)}.json", body={"issue": {"notes": content}})
            return {"write_status": "succeeded", "verification": "not_performed"}
        return await execute_write(plan, authorization, ledger, write)

    async def assign_issue(self, issue_id, assignee_id, *, authorization=None, ledger=None):
        plan = preview("redmine", "assign", {"base_url": self.base_url, "issue_id": int(issue_id)},
                       {"assignee_id": int(assignee_id)})
        async def write():
            await self._request("PUT", f"/issues/{int(issue_id)}.json",
                                body={"issue": {"assigned_to_id": int(assignee_id)}})
            return {"write_status": "succeeded", "verification": "not_performed"}
        return await execute_write(plan, authorization, ledger, write)

    async def close(self):
        self._closed = True


class RedminePoller:
    def __init__(self, client, emit, state_store, project_ids, user_id, *,
                 account_map=None, project_map=None, initial_since=None, overlap_seconds=120,
                 clock=utc_now, load_snapshot=None):
        if not project_ids or user_id is None or overlap_seconds < 0:
            raise ValueError("Explicit project and account IDs are required")
        self.client, self.emit, self.state = client, emit, state_store
        self.projects = sorted({int(value) for value in project_ids})
        self.user_id = str(user_id)
        # Explicit @login aliases -> external user ID lists. Display names remain ambiguous.
        self.account_map = account_map or {}
        self.project_map = {str(key): value for key, value in (project_map or {}).items()}
        self.initial_since = timestamp(initial_since) if initial_since else None
        self.overlap = overlap_seconds
        self.clock = clock
        # Optional sync/async callback supplied by the persistence-owning service.
        # It returns the latest committed issue.updated payload, never live data.
        self.load_snapshot = load_snapshot
        self.key = "redmine:" + client.base_url + ":" + ",".join(map(str, self.projects)) + ":" + self.user_id
        self.pending_key = self.key + ":pending_initial_issue"
        self._lock = asyncio.Lock()

    def _mentions(self, text):
        tokens = re.findall(r"(?<![\w@])@([\w.\-]+)", text)
        definite, uncertain = [], []
        for token in tokens:
            users = self.account_map.get(token, [])
            users = [str(value) for value in users]
            if users == [self.user_id]:
                definite.append(token)
            elif not users or self.user_id in users:
                uncertain.append(token)
        return definite, uncertain

    def _events(self, issue, since, *, previously_assigned=False):
        issue_id, project_id = str(issue["id"]), str(issue["project"]["id"])
        if int(project_id) not in self.projects:
            raise ConnectorError("redmine_project_scope_mismatch")
        semantics = _issue_semantics(issue)
        assigned = semantics["assigned_to_id"] == self.user_id
        base = {"source": "redmine", "thread_id": issue_id, "project_external_id": project_id,
                "issue_id": issue_id, "attachments": issue.get("attachments", [])}
        metadata = {"assigned_to_me": assigned, "project_id": self.project_map.get(project_id),
                    "assigned_to_id": semantics["assigned_to_id"],
                    "redmine_endpoint": self.client.base_url,
                    "external_user_id": self.user_id}
        status = issue.get("status")
        if isinstance(status, dict) and type(status.get("is_closed")) is bool:
            metadata["issue_is_closed"] = status["is_closed"]
        definite, uncertain = self._mentions(semantics["description"])
        if assigned or previously_assigned or definite or uncertain:
            yield {**base, "external_id": f"{self.client.base_url}:issue:{issue_id}:{timestamp(issue['updated_on'])}",
                   "event_type": "issue.updated", "actor_id": str(issue.get("author", {}).get("id", "")),
                   "content": semantics["subject"] + "\n" + semantics["description"],
                   "occurred_at": timestamp(issue["updated_on"]),
                   "metadata": {**metadata, "mentions": definite, "uncertain_mentions": uncertain,
                                "needs_confirmation": bool(uncertain and not assigned and not definite)}}
        for journal in issue.get("journals", []):
            occurred = timestamp(journal["created_on"])
            # Redmine can edit old journal notes without exposing an edit timestamp.
            # Revisit visible journals and let the durable event key deduplicate them.
            notes = journal.get("notes") or ""
            definite, uncertain = self._mentions(notes)
            changes = journal.get("details", [])
            assignment = any(item.get("name") == "assigned_to_id" and
                             self.user_id in {str(item.get("new_value")), str(item.get("old_value"))}
                             for item in changes)
            if not (assigned or assignment or definite or uncertain):
                continue
            added_ids = {str(item.get("name")) for item in changes if item.get("property") == "attachment"}
            revision = digest({"notes": notes, "details": changes})
            yield {**base, "external_id": f"{self.client.base_url}:issue:{issue_id}:journal:{journal['id']}:{revision}",
                   "event_type": "issue.comment" if notes.strip() else "issue.changed",
                   "actor_id": str(journal.get("user", {}).get("id", "")),
                   "content": notes, "occurred_at": occurred,
                   "attachments": [item for item in base["attachments"] if str(item["id"]) in added_ids],
                   "metadata": {**metadata, "journal_id": str(journal["id"]),
                                "journal_revision": revision, "details": changes, "mentions": definite,
                                "uncertain_mentions": uncertain,
                                "needs_confirmation": bool(uncertain and not assigned and not assignment and not definite)}}

    async def _consume_issue(self, issue, since, *, replaying=False):
        issue_key = f"{self.key}:issue:{issue['id']}:semantics"
        previous = await resolve(self.state.get(issue_key))
        previous = previous if isinstance(previous, dict) else {}
        missing_checkpoint = not previous.get("fingerprint")
        if missing_checkpoint and self.load_snapshot:
            historical = await resolve(self.load_snapshot(base_url=self.client.base_url,
                                        issue_id=str(issue["id"]), project_ids=self.projects,
                                        user_id=self.user_id))
            previous = restore_issue_checkpoint(historical, base_url=self.client.base_url,
                            issue_id=issue["id"], project_ids=self.projects, user_id=self.user_id) or previous
        semantics = _issue_semantics(issue)
        fingerprint = digest(semantics)
        changed = previous.get("fingerprint") != fingerprint
        first_snapshot = not previous.get("fingerprint")
        sequence = int(previous.get("sequence", 0)) + int(changed)
        events = list(self._events(issue, since, previously_assigned=previous.get("assigned_to_id") == self.user_id))
        initial_delivery = first_snapshot and any(event["event_type"] == "issue.updated" for event in events)
        if initial_delivery and not replaying:
            # Reserve the raw initial source snapshot, not a confirmed fingerprint.
            # Its legacy timestamp ID stays stable through failed-batch recovery.
            await resolve(self.state.set(self.pending_key, issue))
        count = 0
        for event in events:
            if event["event_type"] == "issue.updated":
                if not changed:
                    continue
                if not first_snapshot:
                    # Sequence distinguishes A -> B -> A at one server timestamp.
                    event["external_id"] = f"{self.client.base_url}:issue:{issue['id']}:snapshot:{sequence}:{fingerprint}"
                event["metadata"]["issue_fingerprint"] = fingerprint
                event["metadata"]["issue_snapshot_sequence"] = sequence
            # emit must durably consume/dedupe before returning.
            await self.emit(event)
            count += 1
        # Every related journal must also succeed before confirming semantics.
        if changed or missing_checkpoint:
            await resolve(self.state.set(issue_key, {"fingerprint": fingerprint, "sequence": sequence,
                                                    "assigned_to_id": semantics["assigned_to_id"]}))
        if initial_delivery or replaying:
            await resolve(self.state.set(self.pending_key, None))
        return count

    async def poll_once(self):
        async with self._lock:
            cursor = await resolve(self.state.get(self.key))
            boundary = timestamp(self.clock())
            since = self.initial_since
            if cursor:
                parsed = datetime.fromisoformat(cursor.replace("Z", "+00:00"))
                since = timestamp(parsed - timedelta(seconds=self.overlap))
            count = 0
            pending = await resolve(self.state.get(self.pending_key))
            if pending:
                count += await self._consume_issue(pending, since, replaying=True)
            for project in self.projects:
                for summary in await self.client.list_updated_issues(since, project):
                    issue = await self.client.get_issue(summary["id"])
                    count += await self._consume_issue(issue, since)
            await resolve(self.state.set(self.key, max(cursor or boundary, boundary)))
            return {"emitted": count, "cursor": boundary}
