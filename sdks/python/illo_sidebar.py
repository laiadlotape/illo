"""illo_sidebar — minimal Python client for the illo-sidebar daemon.

Stdlib-only (urllib, json). Targets the v0.2 protocol documented at
docs/protocol.md. Errors are swallowed by default so a flaky daemon can
never break the calling agent — pass raise_on_error=True to override.

Example:
    from illo_sidebar import IlloSidebar
    client = IlloSidebar(port=7821, agent_id="my-agent", agent_kind="langgraph")
    client.ask("Approve deploy?", options=["yes", "no"], urgency="urgent")
    client.notify("Long-running task done", urgency="low")
    client.heartbeat()
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any, Iterable, Optional


class IlloSidebar:
    def __init__(
        self,
        port: int = 7821,
        agent_id: str = "generic",
        agent_kind: str = "generic",
        session_id: Optional[str] = None,
        host: str = "127.0.0.1",
        timeout: float = 2.0,
        raise_on_error: bool = False,
    ) -> None:
        env_port = os.environ.get("ILLO_SIDEBAR_PORT")
        self.port = int(env_port) if env_port else int(port)
        self.host = host
        self.agent_id = agent_id
        self.agent_kind = agent_kind
        self.session_id = session_id
        self.timeout = timeout
        self.raise_on_error = raise_on_error

    # ---- public API ---------------------------------------------------

    def ask(
        self,
        question: str,
        options: Optional[Iterable[str]] = None,
        urgency: str = "normal",
        transcript: Optional[str] = None,
        title: Optional[str] = None,
        snippet: Optional[str] = None,
        payload: Optional[dict] = None,
        quick_reply_enabled: bool = True,
        cwd: Optional[str] = None,
        project_name: Optional[str] = None,
        git_branch: Optional[str] = None,
        git_worktree: Optional[str] = None,
    ) -> Optional[dict]:
        opts = [{"label": o} for o in (options or [])]
        return self._post_event(
            {
                "kind": "ask_user",
                "tool_input": {"questions": [{"question": question, "options": opts}]},
                "title": title,
                "snippet": snippet,
                "urgency": urgency,
                "transcript_snapshot": transcript,
                "quick_reply_enabled": quick_reply_enabled,
                "payload": payload,
                "cwd": cwd,
                "project_name": project_name,
                "git_branch": git_branch,
                "git_worktree": git_worktree,
            }
        )

    def notify(
        self,
        message: str,
        urgency: str = "normal",
        subkind: Optional[str] = None,
        transcript: Optional[str] = None,
        payload: Optional[dict] = None,
        cwd: Optional[str] = None,
        project_name: Optional[str] = None,
        git_branch: Optional[str] = None,
        git_worktree: Optional[str] = None,
    ) -> Optional[dict]:
        return self._post_event(
            {
                "kind": "notification",
                "message": message,
                "subkind": subkind,
                "urgency": urgency,
                "transcript_snapshot": transcript,
                "payload": payload,
                "cwd": cwd,
                "project_name": project_name,
                "git_branch": git_branch,
                "git_worktree": git_worktree,
            }
        )

    def custom(self, **kwargs: Any) -> Optional[dict]:
        evt = {"kind": "custom", **kwargs}
        return self._post_event(evt)

    def heartbeat(self) -> None:
        self._post_event({"kind": "heartbeat"})

    # ---- internals ----------------------------------------------------

    def _post_event(self, body: dict) -> Optional[dict]:
        body = {k: v for k, v in body.items() if v is not None}
        body.setdefault("agent_id", self.agent_id)
        body.setdefault("agent_kind", self.agent_kind)
        if self.session_id and "session_id" not in body:
            body["session_id"] = self.session_id
        return self._request("POST", "/event", body)

    def _request(self, method: str, path: str, body: Optional[dict]) -> Optional[dict]:
        url = f"http://{self.host}:{self.port}{path}"
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(
            url, data=data, method=method,
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read().decode("utf-8")
                return json.loads(raw) if raw else None
        except (urllib.error.URLError, ValueError, OSError):
            if self.raise_on_error:
                raise
            return None
