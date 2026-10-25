"""A thin HTTP client for the UTD REST API.

Everything the MCP server does goes through the public API rather than the
Django ORM, so it works against the dev server and the production instance
alike, every change lands in the audit trail as an API actor, and every
open board animates the change over websockets just like any other
integration would.
"""

from __future__ import annotations

import os
from typing import Any

import httpx
from mcp.server.mcpserver.exceptions import ToolError

DEFAULT_URL = "http://localhost:8000"
DEFAULT_ACTOR = "claude"


class UTDClient:
    def __init__(self, base_url: str, actor: str, *, transport: httpx.AsyncBaseTransport | None = None,
                 public_url: str | None = None):
        """`base_url` is where API requests go; `public_url` is the address
        people open in a browser, for links in tool results. They differ
        when the server runs inside the UTD process (see backend/utd/mcp_app.py)."""
        self.base_url = base_url.rstrip("/")
        self.public_url = (public_url or base_url).rstrip("/")
        self.actor = actor
        self._http = httpx.AsyncClient(base_url=self.base_url, timeout=30.0, transport=transport)

    def meta(self, animation: str | None = None) -> dict[str, str]:
        """The "meta" object UTD's mutating endpoints accept: who is acting
        and, optionally, which named animation announces the change."""
        meta = {"actor": self.actor}
        if animation:
            meta["animation"] = animation
        return meta

    async def request(self, method: str, path: str, *, json: Any = None,
                      params: dict[str, Any] | None = None) -> Any:
        try:
            response = await self._http.request(method, path, json=json, params=params)
        except httpx.HTTPError as exc:
            raise ToolError(f"Could not reach UTD at {self.base_url}: {exc}") from exc
        if response.status_code >= 400:
            raise ToolError(_describe_error(response))
        if response.status_code == 204 or not response.content:
            return None
        return response.json()

    async def get(self, path: str, **params: Any) -> Any:
        return await self.request("GET", path, params={k: v for k, v in params.items() if v is not None})

    async def post(self, path: str, body: dict[str, Any] | None = None) -> Any:
        return await self.request("POST", path, json=body or {})

    async def patch(self, path: str, body: dict[str, Any]) -> Any:
        return await self.request("PATCH", path, json=body)

    async def delete(self, path: str) -> Any:
        return await self.request("DELETE", path)

    async def aclose(self) -> None:
        await self._http.aclose()


def _describe_error(response: httpx.Response) -> str:
    try:
        payload = response.json()
    except ValueError:
        payload = None
    if isinstance(payload, dict):
        detail = payload.get("detail") or payload
        extra = ""
        if payload.get("code") == "subtask_block":
            extra = f" (blocked by subtasks: {', '.join(payload.get('blocking_task_ids', []))})"
        return f"UTD said {response.status_code}: {detail}{extra}"
    return f"UTD said {response.status_code} for {response.request.method} {response.request.url.path}"


def client_from_env() -> UTDClient:
    return UTDClient(
        os.environ.get("UTD_URL", DEFAULT_URL),
        os.environ.get("UTD_ACTOR", DEFAULT_ACTOR),
    )
