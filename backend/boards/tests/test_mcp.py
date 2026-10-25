"""The MCP server mounted at /mcp, driven through the real ASGI application
the way a client behind the proxy would: JSON-RPC over streamable HTTP,
with the tools calling back into this same process's API."""

import json

import httpx
from channels.db import database_sync_to_async
from django.test import TransactionTestCase, override_settings

from boards.models import Board, Lane, Task
from utd.asgi import application

HEADERS = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
}


class MCPMountTests(TransactionTestCase):
    """TransactionTestCase so the service layer's on_commit hooks fire."""

    @database_sync_to_async
    def _make_board(self):
        board = Board.objects.create(
            name="Ops", slug="ops",
            animation_catalogue={"enabled": ["pulse", "celebrate"], "default": "slide"},
        )
        backlog = Lane.objects.create(board=board, name="Backlog", order=0)
        Lane.objects.create(board=board, name="Done", order=1, is_final=True)
        return board, backlog

    @database_sync_to_async
    def _task_titles(self):
        return list(Task.objects.order_by("created_at").values_list("title", "lane__name"))

    async def _rpc(self, client, method, params=None, id=1):
        response = await client.post("/mcp", headers=HEADERS, json={
            "jsonrpc": "2.0", "id": id, "method": method, "params": params or {},
        })
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    async def test_initialize_lists_tools_and_calls_them(self):
        board, backlog = await self._make_board()
        transport = httpx.ASGITransport(app=application)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            init = await self._rpc(client, "initialize", {
                "protocolVersion": "2025-06-18", "capabilities": {},
                "clientInfo": {"name": "test", "version": "0"},
            })
            self.assertEqual(init["result"]["serverInfo"]["name"], "utd")
            self.assertIn("swim-lane", init["result"]["instructions"])

            tools = await self._rpc(client, "tools/list", id=2)
            names = {t["name"] for t in tools["result"]["tools"]}
            self.assertTrue({"list_boards", "create_task", "complete_task"} <= names)

            listed = await self._rpc(client, "tools/call",
                                     {"name": "list_boards", "arguments": {}}, id=3)
            boards = listed["result"]["structuredContent"]["result"]
            self.assertEqual({b["name"] for b in boards}, {"Inbox", "Ops"})
            ops = next(b for b in boards if b["name"] == "Ops")
            self.assertEqual([l["name"] for l in ops["lanes"]], ["Backlog", "Done"])

            created = await self._rpc(client, "tools/call", {
                "name": "create_task",
                "arguments": {"board": "ops", "title": "Rotate the token", "animation": "pulse"},
            }, id=4)
            result = created["result"]
            self.assertFalse(result.get("isError"), result)
            self.assertEqual(result["structuredContent"]["lane"], "Backlog")
            self.assertEqual(result["structuredContent"]["url"], "http://localhost:8000/#/b/ops")
            task_id = result["structuredContent"]["id"]

            done = await self._rpc(client, "tools/call",
                                   {"name": "complete_task", "arguments": {"task_id": task_id}}, id=5)
            self.assertEqual(done["result"]["structuredContent"]["lane"], "Done")

            history = await self._rpc(client, "tools/call",
                                      {"name": "task_history", "arguments": {"task_id": task_id}}, id=6)
            events = history["result"]["structuredContent"]["events"]
            self.assertEqual([e["event"] for e in events], ["task.moved", "task.created"])
            self.assertEqual({e["actor"] for e in events}, {"claude"})
            self.assertEqual({e["source"] for e in events}, {"api"})

        self.assertEqual(await self._task_titles(), [("Rotate the token", "Done")])

    async def test_tool_errors_reach_the_client_as_results(self):
        await self._make_board()
        transport = httpx.ASGITransport(app=application)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            reply = await self._rpc(client, "tools/call",
                                    {"name": "get_board", "arguments": {"board": "nope"}})
            self.assertTrue(reply["result"]["isError"])
            self.assertIn("No board matches 'nope'", reply["result"]["content"][0]["text"])

    async def test_other_paths_still_reach_django(self):
        transport = httpx.ASGITransport(app=application)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            response = await client.get("/api/boards/")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(json.loads(response.text)[0]["name"], "Inbox")
            response = await client.get("/mcpx")
            self.assertEqual(response.status_code, 404)

    async def test_browser_get_is_answered_not_hung(self):
        transport = httpx.ASGITransport(app=application)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            response = await client.get("/mcp")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["transport"], "streamable-http")
            self.assertIn("claude mcp add", response.json()["hint"])
            response = await client.head("/mcp")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.content, b"")

    @override_settings(DEBUG=False, ALLOWED_HOSTS=["board.example.com", "board.example.lan"],
                       CSRF_TRUSTED_ORIGINS=["https://board.example.com"])
    async def test_configured_hosts_only(self):
        from utd.mcp_app import _api_host, _transport_security
        security = _transport_security()
        self.assertTrue(security.enable_dns_rebinding_protection)
        self.assertEqual(security.allowed_hosts,
                         ["board.example.com", "board.example.com:*",
                          "board.example.lan", "board.example.lan:*"])
        self.assertIn("https://board.example.com", security.allowed_origins)
        self.assertEqual(_api_host(), "board.example.com")
