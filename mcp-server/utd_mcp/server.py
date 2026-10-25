"""UTD's MCP server: the task board as tools and resources for Claude and
any other MCP client.

Run over stdio (the default, what Claude Code and Claude Desktop spawn):

    uv run utd-mcp

or as a streamable-HTTP endpoint other machines can reach:

    uv run utd-mcp --http --port 8787        # serves /mcp

Configuration is two environment variables: UTD_URL (the UTD instance,
default http://localhost:8000) and UTD_ACTOR (the name history shows for
changes made here, default "claude").
"""

from __future__ import annotations

import argparse
import json
import logging
from typing import Any

from mcp.server import MCPServer
from mcp.server.mcpserver.exceptions import ToolError

from .client import UTDClient, client_from_env

log = logging.getLogger("utd_mcp")

INSTRUCTIONS = """\
UTD is a live swim-lane task board. Each board has ordered lanes; a lane with
is_final=true means "done" (tasks there stop blocking others and count as
finished). Tasks can have subtasks (parent_id), owners (people, shared across
boards), categories (labels, some carrying a number or a location), a due
date, attachments and a comment log. Every change you make is audited under
the actor name this server was configured with and animates on every open
board, so changes are visible to people immediately.

Boards, lanes, owners and categories can be given by name instead of id in
every tool. Start with list_boards or agenda to orient yourself; use
get_board for what is on a board, search to find a task by words, get_task
and task_history for one task's details and story.
"""

mcp = MCPServer(
    "utd",
    title="UTD task board",
    instructions=INSTRUCTIONS,
    version="0.1.0",
)

_client: UTDClient | None = None


def get_client() -> UTDClient:
    global _client
    if _client is None:
        _client = client_from_env()
    return _client


def use_client(client: UTDClient) -> None:
    """Point every tool at this client (the UTD process mounting the server
    in-process uses it to talk to its own ASGI app; tests use it too)."""
    global _client
    _client = client


# --- resolving names -------------------------------------------------------


def _norm(text: Any) -> str:
    return " ".join(str(text or "").split()).casefold()


async def _boards_with_lanes() -> list[dict[str, Any]]:
    return await get_client().get("/api/boards/", lanes=1)


async def resolve_board(board: str) -> dict[str, Any]:
    """A board by id, slug or name (case-insensitive); lanes included."""
    boards = await _boards_with_lanes()
    wanted = _norm(board)
    for key in ("id", "slug", "name"):
        for b in boards:
            if _norm(b.get(key)) == wanted:
                return b
    starts = [b for b in boards if _norm(b["name"]).startswith(wanted)]
    if len(starts) == 1:
        return starts[0]
    names = ", ".join(sorted(b["name"] for b in boards)) or "(no boards yet)"
    raise ToolError(f"No board matches {board!r}. Boards: {names}")


def resolve_lane(lanes: list[dict], lane: str) -> dict[str, Any]:
    wanted = _norm(lane)
    for key in ("id", "name"):
        for item in lanes:
            if _norm(item.get(key)) == wanted:
                return item
    starts = [item for item in lanes if _norm(item["name"]).startswith(wanted)]
    if len(starts) == 1:
        return starts[0]
    names = ", ".join(item["name"] for item in lanes)
    raise ToolError(f"No lane matches {lane!r}. Lanes: {names}")


def final_lane(lanes: list[dict]) -> dict[str, Any]:
    finals = [item for item in lanes if item.get("is_final")]
    if not finals:
        raise ToolError("This board has no lane marked as final (done), so there is nowhere to "
                        "complete a task into. Use move_task with an explicit lane.")
    return finals[-1]


def _resolve_many(items: list[dict], wanted: list[str], *, what: str,
                  keys: tuple[str, ...]) -> list[str]:
    """ids for a list of names/codes/ids, erroring on anything unknown."""
    ids: list[str] = []
    for want in wanted:
        norm = _norm(want)
        match = next((i for key in keys for i in items if _norm(i.get(key)) == norm), None)
        if match is None:
            known = ", ".join(sorted(i["name"] for i in items if not i.get("archived")))
            raise ToolError(f"No {what} matches {want!r}. Known: {known or '(none)'}")
        ids.append(str(match["id"]))
    return ids


async def resolve_owner_ids(owners: list[str]) -> list[str]:
    all_owners = await get_client().get("/api/owners/")
    return _resolve_many(all_owners, owners, what="owner", keys=("id", "code", "name"))


async def resolve_category_ids(board_id: str, categories: list[str]) -> list[str]:
    visible = await get_client().get(f"/api/boards/{board_id}/categories/")
    return _resolve_many(visible, categories, what="category", keys=("id", "name"))


# --- shaping output --------------------------------------------------------


def _task_row(task: dict, *, owners: dict[str, dict], categories: dict[str, dict],
              lanes: dict[str, dict] | None = None, boards: dict[str, dict] | None = None) -> dict[str, Any]:
    """The compact view of a task used in lists: enough to decide and act,
    without the full record."""
    row = {
        "id": task["id"],
        "title": task["title"],
    }
    if lanes is not None and task.get("lane_id") in lanes:
        row["lane"] = lanes[task["lane_id"]]["name"]
    if boards is not None and task.get("board_id") in boards:
        row["board"] = boards[task["board_id"]]["name"]
    if task.get("due_date"):
        row["due_date"] = task["due_date"]
    if task.get("parent_id"):
        row["parent_id"] = task["parent_id"]
    if task.get("subtask_count"):
        row["subtasks"] = task["subtask_count"]
    if task.get("blocked_by"):
        row["blocked_by"] = task["blocked_by"]
    names = [owners[i]["name"] for i in task.get("owner_ids", []) if i in owners]
    if names:
        row["owners"] = names
    labels = [categories[i]["name"] for i in task.get("category_ids", []) if i in categories]
    if labels:
        row["categories"] = labels
    if task.get("values"):
        row["values"] = {categories[k]["name"] if k in categories else k: v
                         for k, v in task["values"].items()}
    if task.get("comment_count"):
        row["comments"] = task["comment_count"]
    if task.get("attachments"):
        row["attachments"] = [
            {"kind": a["kind"], "label": a.get("label") or "", "data": a.get("data")}
            for a in task["attachments"]
        ]
    if task.get("description"):
        text = task["description"]
        row["description"] = text if len(text) <= 160 else text[:157] + "..."
    return row


def _by_id(items: list[dict]) -> dict[str, dict]:
    return {str(i["id"]): i for i in items}


def _board_summary(board: dict) -> dict[str, Any]:
    return {
        "id": board["id"],
        "name": board["name"],
        "slug": board.get("slug"),
        "parent_id": board.get("parent_id"),
        # Only the Inbox reports how much is waiting in it.
        **({"open_tasks": board["open_count"]} if board.get("open_count") is not None else {}),
        "lanes": [
            {"id": l["id"], "name": l["name"], "is_final": l.get("is_final", False),
             **({"wip_limit": l["wip_limit"]} if l.get("wip_limit") else {})}
            for l in board.get("lanes", [])
        ],
    }


# --- reading ---------------------------------------------------------------


@mcp.tool()
async def list_boards() -> list[dict[str, Any]]:
    """Every open board with its lanes and open-task count. Boards nest:
    a board with a parent_id is a sub-board whose tasks also show on the
    parent."""
    return [_board_summary(b) for b in await _boards_with_lanes()]


@mcp.tool()
async def get_board(board: str, lane: str | None = None) -> dict[str, Any]:
    """What is on a board right now: its lanes (in order) and the open tasks
    in each, including tasks from its sub-boards. `board` is a name, slug
    or id; `lane` narrows the result to one lane."""
    found = await resolve_board(board)
    snap = await get_client().get(f"/api/boards/{found['id']}/snapshot/")
    owners = _by_id(snap["owners"])
    categories = _by_id(snap["categories"])
    boards = _by_id(snap["family"])
    lanes = snap["lanes"]
    if lane:
        lanes = [resolve_lane(lanes, lane)]
    lane_map: dict[str, str] = snap.get("lane_map", {})  # sub-board lane id -> our lane id
    columns = []
    for item in lanes:
        tasks = [
            t for t in snap["tasks"]
            if lane_map.get(t["lane_id"], t["lane_id"]) == item["id"]
        ]
        columns.append({
            "id": item["id"],
            "name": item["name"],
            "is_final": item.get("is_final", False),
            **({"wip_limit": item["wip_limit"]} if item.get("wip_limit") else {}),
            "count": len(tasks),
            "tasks": [_task_row(t, owners=owners, categories=categories,
                                boards=boards if t["board_id"] != found["id"] else None)
                      for t in tasks],
        })
    return {
        "board": {"id": found["id"], "name": found["name"], "slug": found.get("slug")},
        "sub_boards": [{"id": b["id"], "name": b["name"]} for b in snap["family"]],
        "lanes": columns,
        "owners": [{"id": o["id"], "name": o["name"], "code": o["code"]}
                   for o in snap["owners"] if not o.get("archived")],
        "categories": [{"id": c["id"], "name": c["name"],
                        **({"value_type": c["value_type"]} if c.get("value_type") else {})}
                       for c in snap["categories"] if not c.get("archived")],
    }


@mcp.tool()
async def search(query: str) -> dict[str, Any]:
    """Find boards by name and tasks by words in their title, description,
    attachments or comments, across every board. Open tasks come first;
    archived ones are included and say so."""
    if len(query.strip()) < 2:
        raise ToolError("Give at least two characters to search for.")
    return await get_client().get("/api/search/", q=query)


@mcp.tool()
async def agenda(days: int = 7) -> dict[str, Any]:
    """Unfinished tasks on every board that are overdue or due within
    `days` days (0 = just today), soonest first. The Today view."""
    data = await get_client().get("/api/agenda/", days=max(0, min(days, 60)))
    owners = _by_id(await get_client().get("/api/owners/"))
    rows = []
    for t in data["tasks"]:
        row = _task_row(t, owners=owners, categories={})
        row["board"] = t["board"]["name"]
        row["lane"] = t["lane"]["name"]
        row["due_date"] = t["due_date"]
        if t.get("parent_title"):
            row["parent"] = t["parent_title"]
        rows.append(row)
    return {"today": data["today"], "tasks": rows}


@mcp.tool()
async def get_task(task_id: str) -> dict[str, Any]:
    """One task in full: every field, its links, attachments, owners and
    categories by name, and its comment log."""
    c = get_client()
    task = await c.get(f"/api/tasks/{task_id}/")
    owners = _by_id(await c.get("/api/owners/"))
    categories = _by_id(await c.get(f"/api/boards/{task['board_id']}/categories/"))
    comments = await c.get(f"/api/tasks/{task_id}/comments/")
    task["owners"] = [owners[i]["name"] for i in task.get("owner_ids", []) if i in owners]
    task["categories"] = [categories[i]["name"] for i in task.get("category_ids", []) if i in categories]
    task["comments"] = [
        {"id": x["id"], "body": x["body"], "actor": x["actor"], "happened_at": x["happened_at"]}
        for x in comments
    ]
    return task


@mcp.tool()
async def task_history(task_id: str, limit: int = 50) -> dict[str, Any]:
    """A task's audit trail, newest first: who did what, when, from which
    lane to which, and what set an automated change off."""
    data = await get_client().get(f"/api/tasks/{task_id}/events/", limit=max(1, min(limit, 200)),
                                  include="subtasks")
    events = []
    for e in data["results"]:
        row = {"at": e["created_at"], "event": e["event_type"], "actor": e["actor"],
               "source": e["source"]}
        if e.get("task_id") != task_id:
            row["task_id"] = e["task_id"]
        if e.get("from_lane_name") or e.get("to_lane_name"):
            row["from"] = e.get("from_lane_name")
            row["to"] = e.get("to_lane_name")
        if e.get("payload"):
            row["payload"] = e["payload"]
        if e.get("caused_by"):
            cause = e["caused_by"]
            row["because"] = f"{cause['actor']} {cause['event_type']}" + (
                f" to {cause['to_lane_name']}" if cause.get("to_lane_name") else "")
        events.append(row)
    return {"count": data["count"], "events": events, "related_tasks": data.get("related_tasks", {})}


@mcp.tool()
async def list_owners() -> list[dict[str, Any]]:
    """The people who can own tasks (shared by every board): name, short
    code and contacts."""
    return [
        {"id": o["id"], "name": o["name"], "code": o["code"], "emoji": o.get("emoji") or None,
         "contacts": o.get("contacts") or []}
        for o in await get_client().get("/api/owners/") if not o.get("archived")
    ]


@mcp.tool()
async def list_categories(board: str) -> list[dict[str, Any]]:
    """The categories (labels) a board's tasks can carry: shared ones plus
    the board's own. Some categories hold a number (value_type) or a
    place (location) per task."""
    found = await resolve_board(board)
    return [
        {"id": c["id"], "name": c["name"], "color": c.get("color"),
         "shared": c.get("board_id") is None,
         **({"value_type": c["value_type"]} if c.get("value_type") else {})}
        for c in await get_client().get(f"/api/boards/{found['id']}/categories/")
        if not c.get("archived")
    ]


# --- writing ---------------------------------------------------------------


@mcp.tool()
async def create_task(
    board: str,
    title: str,
    lane: str | None = None,
    description: str = "",
    due_date: str | None = None,
    parent_id: str | None = None,
    owners: list[str] | None = None,
    categories: list[str] | None = None,
    animation: str | None = None,
) -> dict[str, Any]:
    """Add a task to a board. `lane` defaults to the board's first lane;
    `due_date` is YYYY-MM-DD; `parent_id` makes it a subtask; `owners` and
    `categories` take names, codes or ids. `animation` (e.g. "pulse",
    "celebrate", "alarm") announces the arrival on open boards."""
    found = await resolve_board(board)
    lanes = found["lanes"]
    target = resolve_lane(lanes, lane) if lane else lanes[0]
    body: dict[str, Any] = {
        "lane_id": target["id"],
        "title": title.strip(),
        "description": description,
        "meta": get_client().meta(animation),
    }
    if due_date:
        body["due_date"] = due_date
    if parent_id:
        body["parent_id"] = parent_id
    if categories:
        body["category_ids"] = await resolve_category_ids(found["id"], categories)
    task = await get_client().post(f"/api/boards/{found['id']}/tasks/", body)
    if owners:
        task = await get_client().patch(
            f"/api/tasks/{task['id']}/",
            {"owner_ids": await resolve_owner_ids(owners), "meta": get_client().meta()},
        )
    return {"id": task["id"], "title": task["title"], "board": found["name"],
            "lane": target["name"], "due_date": task.get("due_date"),
            "url": f"{get_client().public_url}/#/b/{found.get('slug')}"}


@mcp.tool()
async def update_task(
    task_id: str,
    title: str | None = None,
    description: str | None = None,
    due_date: str | None = None,
    clear_due_date: bool = False,
    owners: list[str] | None = None,
    categories: list[str] | None = None,
    parent_id: str | None = None,
    detach_from_parent: bool = False,
) -> dict[str, Any]:
    """Change a task's fields. Only what you pass changes. `owners` and
    `categories` replace the whole list (pass [] to clear). `due_date` is
    YYYY-MM-DD; `clear_due_date` removes it. `detach_from_parent` turns a
    subtask back into a top-level task."""
    c = get_client()
    body: dict[str, Any] = {"meta": c.meta()}
    if title is not None:
        body["title"] = title.strip()
    if description is not None:
        body["description"] = description
    if clear_due_date:
        body["due_date"] = None
    elif due_date is not None:
        body["due_date"] = due_date
    if owners is not None:
        body["owner_ids"] = await resolve_owner_ids(owners) if owners else []
    if categories is not None:
        if categories:
            task = await c.get(f"/api/tasks/{task_id}/")
            body["category_ids"] = await resolve_category_ids(task["board_id"], categories)
        else:
            body["category_ids"] = []
    if detach_from_parent:
        body["parent_id"] = None
    elif parent_id is not None:
        body["parent_id"] = parent_id
    if len(body) == 1:
        raise ToolError("Nothing to change: pass at least one field.")
    task = await c.patch(f"/api/tasks/{task_id}/", body)
    return {"id": task["id"], "title": task["title"], "due_date": task.get("due_date"),
            "parent_id": task.get("parent_id"), "owner_ids": task.get("owner_ids"),
            "category_ids": task.get("category_ids")}


async def _task_and_lanes(task_id: str) -> tuple[dict, dict, list[dict]]:
    task = await get_client().get(f"/api/tasks/{task_id}/")
    boards = await _boards_with_lanes()
    board = next((b for b in boards if b["id"] == task["board_id"]), None)
    if board is None:
        raise ToolError("That task's board is archived; restore the board first.")
    return task, board, board["lanes"]


@mcp.tool()
async def move_task(task_id: str, lane: str, index: int | None = None,
                    animation: str | None = None) -> dict[str, Any]:
    """Move a task to another lane on its board (by lane name or id).
    `index` is the position within the lane, 0 = top; omit it to land at
    the bottom. Refused if the task has unfinished subtasks and the move
    would put it right of them."""
    task, board, lanes = await _task_and_lanes(task_id)
    target = resolve_lane(lanes, lane)
    body = {"to_lane_id": target["id"], "meta": get_client().meta(animation)}
    if index is not None:
        body["index"] = index
    moved = await get_client().post(f"/api/tasks/{task_id}/move/", body)
    return {"id": moved["id"], "title": moved["title"], "board": board["name"],
            "lane": target["name"], "is_final": bool(target.get("is_final"))}


@mcp.tool()
async def complete_task(task_id: str, animation: str | None = "celebrate") -> dict[str, Any]:
    """Mark a task done by moving it to its board's final lane."""
    task, board, lanes = await _task_and_lanes(task_id)
    target = final_lane(lanes)
    if task["lane_id"] == target["id"]:
        return {"id": task["id"], "title": task["title"], "lane": target["name"],
                "note": "already done"}
    moved = await get_client().post(
        f"/api/tasks/{task_id}/move/",
        {"to_lane_id": target["id"], "meta": get_client().meta(animation)},
    )
    return {"id": moved["id"], "title": moved["title"], "board": board["name"],
            "lane": target["name"]}


@mcp.tool()
async def archive_task(task_id: str) -> dict[str, Any]:
    """Take a task off the board (soft: it keeps its history and can be
    restored)."""
    task = await get_client().get(f"/api/tasks/{task_id}/")
    await get_client().post(f"/api/tasks/{task_id}/archive/", {"meta": get_client().meta()})
    return {"id": task_id, "title": task["title"], "archived": True}


@mcp.tool()
async def restore_task(task_id: str) -> dict[str, Any]:
    """Bring an archived or binned task back onto its board, in the lane it
    left from."""
    task = await get_client().post(f"/api/tasks/{task_id}/restore/", {"meta": get_client().meta()})
    return {"id": task["id"], "title": task["title"], "lane_id": task["lane_id"], "restored": True}


@mcp.tool()
async def add_comment(task_id: str, body: str) -> dict[str, Any]:
    """Add an entry to a task's log (a comment, a note on what happened)."""
    if not body.strip():
        raise ToolError("The comment is empty.")
    comment = await get_client().post(
        f"/api/tasks/{task_id}/comments/", {"body": body, "meta": get_client().meta()},
    )
    return {"id": comment["id"], "task_id": task_id, "actor": comment["actor"],
            "happened_at": comment["happened_at"]}


@mcp.tool()
async def link_tasks(from_task_id: str, to_task_id: str, link_type: str = "relates_to") -> dict[str, Any]:
    """Connect two tasks. link_type: "blocks" (from blocks to, until from is
    done), "relates_to", "similar_to", "milestone_of", "duplicates"."""
    link = await get_client().post(
        f"/api/tasks/{from_task_id}/links/",
        {"to_task_id": to_task_id, "link_type": link_type, "meta": get_client().meta()},
    )
    return link


@mcp.tool()
async def create_board(name: str, parent: str | None = None) -> dict[str, Any]:
    """A new board with the default kanban lanes (Backlog, In progress,
    Review, Done). `parent` (name, slug or id) makes it a sub-board."""
    body: dict[str, Any] = {"name": name.strip()}
    if parent:
        body["parent_id"] = (await resolve_board(parent))["id"]
    board = await get_client().post("/api/boards/", body)
    return _board_summary(board)


# --- resources ------------------------------------------------------------


@mcp.resource("utd://boards", mime_type="application/json",
              description="Every open board with its lanes.")
async def boards_resource() -> str:
    return json.dumps(await list_boards(), indent=1)


@mcp.resource("utd://boards/{board}", mime_type="application/json",
              description="A board's lanes and open tasks, by slug, name or id.")
async def board_resource(board: str) -> str:
    return json.dumps(await get_board(board), indent=1)


@mcp.resource("utd://agenda", mime_type="application/json",
              description="Tasks overdue or due in the next 7 days, across every board.")
async def agenda_resource() -> str:
    return json.dumps(await agenda(), indent=1)


# --- entry point ----------------------------------------------------------


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="utd-mcp", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--http", action="store_true",
                        help="serve streamable HTTP at /mcp instead of stdio")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8787)
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    client = get_client()
    log.info("UTD at %s, acting as %r", client.base_url, client.actor)
    if args.http:
        mcp.run(transport="streamable-http", host=args.host, port=args.port, stateless_http=True)
    else:
        mcp.run()


if __name__ == "__main__":
    main()
