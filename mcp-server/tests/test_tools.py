"""The MCP tools against a small in-memory stand-in for the UTD REST API.

The stand-in speaks the same routes and shapes as backend/boards/views.py
(the parts the tools use), so these tests pin the tools' name resolution,
output shaping and error handling without a Django process.
"""

from __future__ import annotations

import json
import re
import uuid

import httpx
import pytest

from utd_mcp import server
from utd_mcp.client import UTDClient
from mcp.server.mcpserver.exceptions import ToolError

BOARD = "11111111-1111-1111-1111-111111111111"
BACKLOG = "aaaaaaaa-0000-0000-0000-000000000001"
DOING = "aaaaaaaa-0000-0000-0000-000000000002"
DONE = "aaaaaaaa-0000-0000-0000-000000000003"
ALICE = "bbbbbbbb-0000-0000-0000-000000000001"
URGENT = "cccccccc-0000-0000-0000-000000000001"
T1 = "dddddddd-0000-0000-0000-000000000001"
T2 = "dddddddd-0000-0000-0000-000000000002"


class FakeUTD:
    def __init__(self):
        self.lanes = [
            {"id": BACKLOG, "board_id": BOARD, "name": "Backlog", "order": 0, "color": "#888",
             "wip_limit": None, "is_final": False},
            {"id": DOING, "board_id": BOARD, "name": "In progress", "order": 1, "color": "#88f",
             "wip_limit": 3, "is_final": False},
            {"id": DONE, "board_id": BOARD, "name": "Done", "order": 2, "color": "#8f8",
             "wip_limit": None, "is_final": True},
        ]
        self.boards = [{"id": BOARD, "name": "Ops", "slug": "ops", "parent_id": None,
                        "kind": "kanban", "open_count": 2}]
        self.owners = [{"id": ALICE, "name": "Alice", "code": "AL", "fg": "#000", "bg": "#fff",
                        "emoji": "", "contacts": [], "position": 0, "archived": False}]
        self.categories = [{"id": URGENT, "board_id": None, "name": "Urgent", "color": "#f00",
                            "position": 0, "value_type": "", "value_config": {}, "archived": False}]
        self.tasks = {
            T1: self._task(T1, "Rotate the Vault token", BACKLOG, due_date="2026-10-09",
                           owner_ids=[ALICE], category_ids=[URGENT]),
            T2: self._task(T2, "Write the runbook", DOING),
        }
        self.events: list[dict] = []
        self.comments: list[dict] = []
        self.requests: list[tuple[str, str, dict | None]] = []

    @staticmethod
    def _task(task_id, title, lane_id, **extra):
        task = {
            "id": task_id, "board_id": BOARD, "lane_id": lane_id, "parent_id": None,
            "title": title, "description": "", "position": 1.0, "metadata": {},
            "subtask_count": 0, "blocked_by": [], "links": [], "attachments": [],
            "owner_ids": [], "category_ids": [], "values": {}, "locations": {},
            "comment_count": 0, "estimates": {}, "due_date": None, "hide_subtasks": False,
            "owner_follows_next": False, "lane_entered_at": "2026-10-01T00:00:00Z",
            "archived_at": None, "deleted_at": None,
            "created_at": "2026-10-01T00:00:00Z", "updated_at": "2026-10-01T00:00:00Z",
        }
        task.update(extra)
        return task

    def handle(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else None
        path, method = request.url.path, request.method
        self.requests.append((method, path, body))
        m = re.fullmatch

        if path == "/api/boards/" and method == "GET":
            boards = [dict(b) for b in self.boards]
            if request.url.params.get("lanes"):
                for b in boards:
                    b["lanes"] = self.lanes
            return httpx.Response(200, json=boards)
        if path == "/api/boards/" and method == "POST":
            board = {"id": str(uuid.uuid4()), "name": body["name"], "slug": body["name"].lower(),
                     "parent_id": body.get("parent_id"), "kind": "kanban", "lanes": self.lanes}
            return httpx.Response(201, json=board)
        if m(rf"/api/boards/{BOARD}/snapshot/", path):
            return httpx.Response(200, json={
                "board": self.boards[0], "lanes": self.lanes,
                "tasks": [t for t in self.tasks.values() if t["archived_at"] is None],
                "owners": self.owners, "categories": self.categories, "family": [],
                "lane_map": {}, "lane_back": {}, "archived_values": {}, "used_owner_ids": [],
                "last_event_id": 0,
            })
        if m(rf"/api/boards/{BOARD}/categories/", path):
            return httpx.Response(200, json=self.categories)
        if path == "/api/owners/":
            return httpx.Response(200, json=self.owners)
        if m(rf"/api/boards/{BOARD}/tasks/", path) and method == "POST":
            if not body.get("title"):
                return httpx.Response(400, json={"detail": "title is required"})
            task = self._task(str(uuid.uuid4()), body["title"], body["lane_id"],
                              due_date=body.get("due_date"), parent_id=body.get("parent_id"),
                              category_ids=body.get("category_ids", []),
                              description=body.get("description", ""))
            self.tasks[task["id"]] = task
            self.events.append({"event": "created", "meta": body.get("meta")})
            return httpx.Response(201, json=task)
        if path == "/api/search/":
            q = request.url.params["q"].lower()
            return httpx.Response(200, json={
                "boards": [], "tasks": [t for t in self.tasks.values() if q in t["title"].lower()],
            })
        if path == "/api/agenda/":
            rows = []
            for t in self.tasks.values():
                if t["due_date"] and t["lane_id"] != DONE:
                    row = dict(t)
                    row["board"] = {"id": BOARD, "name": "Ops", "slug": "ops"}
                    row["lane"] = {"name": "Backlog", "color": "#888"}
                    row["done_lane_id"] = DONE
                    row["parent_title"] = None
                    rows.append(row)
            return httpx.Response(200, json={"today": "2026-10-07", "tasks": rows})

        task_match = m(r"/api/tasks/([0-9a-f-]+)/(\w*)/?", path)
        if task_match:
            task_id, action = task_match.group(1), task_match.group(2)
            task = self.tasks.get(task_id)
            if task is None:
                return httpx.Response(404, json={"detail": "No Task matches the given query."})
            if action == "" and method == "GET":
                return httpx.Response(200, json=task)
            if action == "" and method == "PATCH":
                for key in ("title", "description", "due_date", "owner_ids", "category_ids", "parent_id"):
                    if key in body:
                        task[key] = body[key]
                return httpx.Response(200, json=task)
            if action == "move":
                if task_id == T2 and body["to_lane_id"] == DONE:
                    return httpx.Response(400, json={"detail": "subtasks unfinished",
                                                     "code": "subtask_block",
                                                     "blocking_task_ids": [T1]})
                task["lane_id"] = body["to_lane_id"]
                self.events.append({"event": "moved", "meta": body.get("meta"), "index": body.get("index")})
                return httpx.Response(200, json=task)
            if action == "archive":
                task["archived_at"] = "2026-10-07T00:00:00Z"
                return httpx.Response(200, json=task)
            if action == "restore":
                task["archived_at"] = None
                return httpx.Response(200, json=task)
            if action == "comments" and method == "POST":
                comment = {"id": str(uuid.uuid4()), "task_id": task_id, "body": body["body"],
                           "about_id": None, "actor": body["meta"]["actor"],
                           "happened_at": "2026-10-07T10:00:00Z",
                           "created_at": "2026-10-07T10:00:00Z", "edited_at": None}
                self.comments.append(comment)
                return httpx.Response(201, json=comment)
            if action == "comments":
                return httpx.Response(200, json=[c for c in self.comments if c["task_id"] == task_id])
            if action == "events":
                return httpx.Response(200, json={
                    "count": 1, "next": None, "previous": None,
                    "results": [{"id": 1, "task_id": task_id, "event_type": "task.created",
                                 "actor": "rich", "source": "ui", "from_lane_id": None,
                                 "from_lane_name": None, "to_lane_id": BACKLOG,
                                 "to_lane_name": "Backlog", "payload": {}, "animation": "",
                                 "op_id": "", "caused_by": None,
                                 "created_at": "2026-10-01T00:00:00Z"}],
                    "related_tasks": {},
                })
            if action == "links":
                return httpx.Response(201, json={"id": str(uuid.uuid4()), "from_task_id": task_id,
                                                 "to_task_id": body["to_task_id"],
                                                 "link_type": body["link_type"], "metadata": {}})
        return httpx.Response(404, json={"detail": f"unhandled {method} {path}"})


@pytest.fixture
def fake(monkeypatch):
    fake = FakeUTD()
    client = UTDClient("http://utd.test", "test-bot", transport=httpx.MockTransport(fake.handle))
    monkeypatch.setattr(server, "_client", client)
    return fake


async def call(tool: str, **args):
    result = await server.mcp.call_tool(tool, args)
    assert not result.is_error, result.content
    return result.structured_content


async def call_error(tool: str, **args) -> str:
    """The message a client would see when the tool refuses."""
    with pytest.raises(ToolError) as info:
        await server.mcp.call_tool(tool, args)
    return str(info.value)


def _unwrap(structured):
    # Lists come back wrapped as {"result": [...]}; dicts come back as-is.
    return structured["result"] if set(structured) == {"result"} else structured


@pytest.mark.anyio
async def test_list_boards_summarises_lanes(fake):
    boards = _unwrap(await call("list_boards"))
    assert boards == [{
        "id": BOARD, "name": "Ops", "slug": "ops", "parent_id": None, "open_tasks": 2,
        "lanes": [
            {"id": BACKLOG, "name": "Backlog", "is_final": False},
            {"id": DOING, "name": "In progress", "is_final": False, "wip_limit": 3},
            {"id": DONE, "name": "Done", "is_final": True},
        ],
    }]


@pytest.mark.anyio
async def test_get_board_groups_tasks_by_lane_with_names(fake):
    board = await call("get_board", board="OPS")
    lanes = {l["name"]: l for l in board["lanes"]}
    assert lanes["Backlog"]["count"] == 1
    row = lanes["Backlog"]["tasks"][0]
    assert row["owners"] == ["Alice"] and row["categories"] == ["Urgent"]
    assert row["due_date"] == "2026-10-09"
    assert lanes["In progress"]["tasks"][0]["title"] == "Write the runbook"
    assert lanes["Done"]["tasks"] == []


@pytest.mark.anyio
async def test_get_board_lane_filter_and_unknown_board(fake):
    board = await call("get_board", board="ops", lane="in prog")
    assert [l["name"] for l in board["lanes"]] == ["In progress"]
    assert "Boards: Ops" in await call_error("get_board", board="Nope")


@pytest.mark.anyio
async def test_create_task_resolves_names_and_sends_actor(fake):
    created = await call("create_task", board="ops", title="  Ship it ", lane="backlog",
                         due_date="2026-10-10", owners=["alice"], categories=["urgent"],
                         animation="pulse")
    assert created["board"] == "Ops" and created["lane"] == "Backlog"
    assert created["url"] == "http://utd.test/#/b/ops"  # public_url defaults to base_url
    post = next(b for m, p, b in fake.requests if m == "POST" and p.endswith("/tasks/"))
    assert post["title"] == "Ship it"
    assert post["meta"] == {"actor": "test-bot", "animation": "pulse"}
    assert post["category_ids"] == [URGENT]
    patch = next(b for m, p, b in fake.requests if m == "PATCH")
    assert patch["owner_ids"] == [ALICE]
    assert fake.tasks[created["id"]]["owner_ids"] == [ALICE]


@pytest.mark.anyio
async def test_create_task_unknown_owner_is_a_clear_error(fake):
    message = await call_error("create_task", board="ops", title="x", owners=["Zed"])
    assert "No owner matches 'Zed'. Known: Alice" in message


@pytest.mark.anyio
async def test_move_and_complete(fake):
    moved = await call("move_task", task_id=T1, lane="in progress", index=0, animation="alarm")
    assert moved["lane"] == "In progress" and moved["is_final"] is False
    assert fake.events[-1] == {"event": "moved", "meta": {"actor": "test-bot", "animation": "alarm"},
                               "index": 0}
    done = await call("complete_task", task_id=T1)
    assert done["lane"] == "Done"
    assert fake.events[-1]["meta"]["animation"] == "celebrate"
    again = await call("complete_task", task_id=T1)
    assert again["note"] == "already done"


@pytest.mark.anyio
async def test_subtask_block_is_explained(fake):
    text = await call_error("complete_task", task_id=T2)
    assert "400" in text and "subtasks unfinished" in text and T1 in text


@pytest.mark.anyio
async def test_update_task_clears_and_sets(fake):
    updated = await call("update_task", task_id=T1, title="Rotate it", clear_due_date=True,
                         owners=[], detach_from_parent=True)
    assert updated["title"] == "Rotate it" and updated["due_date"] is None
    patch = fake.requests[-1][2]
    assert patch == {"meta": {"actor": "test-bot"}, "title": "Rotate it", "due_date": None,
                     "owner_ids": [], "parent_id": None}
    assert "Nothing to change" in await call_error("update_task", task_id=T1)


@pytest.mark.anyio
async def test_agenda_search_task_and_history(fake):
    agenda = await call("agenda", days=3)
    assert agenda["today"] == "2026-10-07"
    assert [t["title"] for t in agenda["tasks"]] == ["Rotate the Vault token"]
    assert agenda["tasks"][0]["owners"] == ["Alice"] and agenda["tasks"][0]["board"] == "Ops"

    found = await call("search", query="runbook")
    assert [t["id"] for t in found["tasks"]] == [T2]

    await call("add_comment", task_id=T1, body="Token rotated in Vault.")
    task = await call("get_task", task_id=T1)
    assert task["owners"] == ["Alice"] and task["categories"] == ["Urgent"]
    assert task["comments"][0]["body"] == "Token rotated in Vault." and task["comments"][0]["actor"] == "test-bot"

    history = await call("task_history", task_id=T1)
    assert history["events"] == [{"at": "2026-10-01T00:00:00Z", "event": "task.created",
                                  "actor": "rich", "source": "ui", "from": None, "to": "Backlog"}]


@pytest.mark.anyio
async def test_archive_restore_link_and_board(fake):
    assert (await call("archive_task", task_id=T2))["archived"] is True
    assert fake.tasks[T2]["archived_at"] is not None
    assert (await call("restore_task", task_id=T2))["restored"] is True
    link = await call("link_tasks", from_task_id=T1, to_task_id=T2, link_type="blocks")
    assert link["link_type"] == "blocks"
    board = await call("create_board", name="Home", parent="ops")
    assert board["name"] == "Home" and board["parent_id"] == BOARD


@pytest.mark.anyio
async def test_missing_task_and_unreachable_server(fake, monkeypatch):
    assert "404" in await call_error("get_task", task_id=str(uuid.uuid4()))

    def down(request):
        raise httpx.ConnectError("refused")
    monkeypatch.setattr(server, "_client",
                        UTDClient("http://utd.test", "x", transport=httpx.MockTransport(down)))
    assert "Could not reach UTD at http://utd.test" in await call_error("list_boards")


@pytest.mark.anyio
async def test_resources(fake):
    contents = await server.mcp.read_resource("utd://boards/ops")
    payload = json.loads(next(iter(contents)).content)
    assert payload["board"]["name"] == "Ops"
    listed = await server.mcp.list_resources()
    assert {str(r.uri) for r in listed} >= {"utd://boards", "utd://agenda"}
