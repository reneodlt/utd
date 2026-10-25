"""The MCP server mounted inside the UTD process, at /mcp.

The Docker image is one container behind whatever reverse proxy you use, so
serving MCP from the same daphne process means https://<your-host>/mcp works
with no new service, port or proxy route. The tools still go through the REST API: the
in-process client speaks ASGI straight to the Django application, so every
change takes the same path (views -> services -> audit -> broadcast) as a
curl from outside, just without a network hop.

Two things daphne needs that uvicorn would have done for us:

- the SDK's Starlette app starts its session manager in an ASGI lifespan,
  and daphne does not send lifespan events, so `MountedMCP` starts it on
  the first request instead;
- the SDK's DNS-rebinding protection is configured from Django's own
  ALLOWED_HOSTS / CSRF_TRUSTED_ORIGINS rather than its localhost defaults.

Settings (environment):
  UTD_PUBLIC_URL   the address people open, used for links in tool results
                   (default http://localhost:8000)
  UTD_ACTOR        the actor name history shows for MCP changes (default claude)
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from urllib.parse import urlsplit

import httpx
from django.conf import settings
from mcp.server.transport_security import TransportSecuritySettings

from utd_mcp import server as utd_mcp_server
from utd_mcp.client import DEFAULT_ACTOR, UTDClient

log = logging.getLogger("utd.mcp")

MCP_PATH = "/mcp"


def _api_host() -> str:
    """A Host header Django will accept for the in-process API calls."""
    for host in settings.ALLOWED_HOSTS:
        if host == "*":
            break
        if host:
            return host[1:] if host.startswith(".") else host
    return "localhost"


def _transport_security() -> TransportSecuritySettings:
    """Reject requests whose Host header is not one of ours (DNS rebinding),
    the way Django's ALLOWED_HOSTS does for the API. Off when Django's
    check is off too (DEBUG, or a wildcard)."""
    hosts = [h for h in settings.ALLOWED_HOSTS if h]
    if settings.DEBUG or not hosts or any(h == "*" or h.startswith(".") for h in hosts):
        if not settings.DEBUG:
            log.warning("UTD_ALLOWED_HOSTS has a wildcard; MCP DNS-rebinding protection is off")
        return TransportSecuritySettings(enable_dns_rebinding_protection=False)
    allowed_hosts = [h for host in hosts for h in (host, f"{host}:*")]
    origins = {f"{scheme}://{host}" for host in hosts for scheme in ("http", "https")}
    origins.update(settings.CSRF_TRUSTED_ORIGINS)
    return TransportSecuritySettings(allowed_hosts=allowed_hosts, allowed_origins=sorted(origins))


class MountedMCP:
    """ASGI app: the SDK's streamable-HTTP app with its session manager
    started lazily, since daphne has no lifespan protocol."""

    def __init__(self, django_app):
        public_url = os.environ.get("UTD_PUBLIC_URL", "http://localhost:8000")
        scheme = urlsplit(public_url).scheme or "http"
        utd_mcp_server.use_client(UTDClient(
            f"{scheme}://{_api_host()}",
            os.environ.get("UTD_ACTOR", DEFAULT_ACTOR),
            transport=httpx.ASGITransport(app=django_app),
            public_url=public_url,
        ))
        self.mcp = utd_mcp_server.mcp
        self.app = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._ready: asyncio.Event | None = None
        self._runner: asyncio.Task | None = None

    def _build(self):
        """A fresh Starlette app and session manager. The SDK allows one
        run() per session manager, so a new event loop gets a new pair."""
        return self.mcp.streamable_http_app(
            streamable_http_path=MCP_PATH,
            json_response=True,   # plain JSON replies: proxy-friendly, no SSE buffering concerns
            stateless_http=True,  # no per-client session to lose on a redeploy
            transport_security=_transport_security(),
            host="0.0.0.0",       # not loopback: do not add the SDK's localhost-only defaults
        )

    async def _run_session_manager(self, ready: asyncio.Event) -> None:
        async with self.mcp.session_manager.run():
            ready.set()
            await asyncio.Event().wait()  # until the process (or test loop) goes away

    async def _ensure_started(self) -> None:
        loop = asyncio.get_running_loop()
        if self._loop is not loop:
            # First request on this loop (daphne has one for the process's
            # lifetime; each Django async test has its own).
            self._loop = loop
            self.app = self._build()
            self._ready = asyncio.Event()
            self._runner = loop.create_task(self._run_session_manager(self._ready))
        assert self._ready is not None
        await self._ready.wait()

    async def __call__(self, scope, receive, send):
        await self._ensure_started()
        await self.app(scope, receive, send)


ABOUT = json.dumps({
    "name": "utd",
    "protocol": "Model Context Protocol",
    "transport": "streamable-http",
    "hint": "This is an MCP endpoint, not a web page. POST JSON-RPC here, or register it "
            "in Claude Code: claude mcp add --scope user --transport http utd <this url>",
}).encode()


async def _about(scope, receive, send):
    """A browser (or curl without a body) GETs /mcp: say what it is. The
    SDK would otherwise treat GET as a request to open an event stream and,
    in stateless mode, never answer."""
    body = b"" if scope["method"] == "HEAD" else ABOUT
    await send({"type": "http.response.start", "status": 200, "headers": [
        (b"content-type", b"application/json"),
        (b"content-length", str(len(body)).encode()),
        (b"cache-control", b"no-store"),
    ]})
    await send({"type": "http.response.body", "body": body})


def http_router(django_app):
    """The "http" protocol app: /mcp to the MCP server, everything else to Django."""
    mounted = MountedMCP(django_app)

    async def router(scope, receive, send):
        path = scope.get("path", "")
        if path == MCP_PATH or path.startswith(MCP_PATH + "/"):
            if scope.get("method") in ("GET", "HEAD"):
                return await _about(scope, receive, send)
            return await mounted(scope, receive, send)
        return await django_app(scope, receive, send)

    return router
