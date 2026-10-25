# utd-mcp

An [MCP](https://modelcontextprotocol.io) server that puts the UTD board in
front of Claude (Code, Desktop, claude.ai) and any other MCP client. It is a
client of the REST API, not of the database: every change it makes goes
through `boards/services.py` like any other integration, lands in the audit
trail under its own actor name, and animates on every open board.

```sh
make mcp-test                       # unit tests against an in-memory stand-in for the API
cd mcp-server && uv run utd-mcp     # stdio, against UTD_URL (default http://localhost:8000)
cd mcp-server && uv run utd-mcp --http --port 8787   # streamable HTTP at /mcp
```

Configuration is two environment variables:

| Variable    | Default                 | Meaning                                              |
|-------------|-------------------------|------------------------------------------------------|
| `UTD_URL`   | `http://localhost:8000` | The UTD instance to talk to                          |
| `UTD_ACTOR` | `claude`                | The name history shows for changes made through MCP |

## Two ways to run it

**Inside UTD.** `backend/utd/mcp_app.py` mounts this server at `/mcp` in
the daphne process, so every UTD instance already serves it, for example
`http://localhost:8000/mcp`. Streamable HTTP, JSON replies, stateless, and
**no auth**, the same as the rest of the API (see the README's security
notes). The tools call the API over ASGI in-process, so
nothing is configured beyond `UTD_PUBLIC_URL` (links in results) and
`UTD_ACTOR`.

**Standalone over stdio**, for clients that spawn a process and for
pointing one machine's Claude at any UTD: `uv run utd-mcp` here, with
`UTD_URL`.

## Claude Code

The repo's `.mcp.json` registers the stdio server for anyone who opens
this project in Claude Code, against the local dev backend. From any
directory, point Claude Code at a running instance over HTTP:

```sh
claude mcp add --scope user --transport http utd http://localhost:8000/mcp
```

claude.ai custom connectors need a publicly reachable HTTPS endpoint and
an OAuth layer, which UTD does not have today.

The stdio form, for a client that cannot speak HTTP:

```sh
claude mcp add --scope user utd \
  --env UTD_URL=http://localhost:8000 --env UTD_ACTOR=claude \
  -- uv run --directory /path/to/utd/mcp-server utd-mcp
```

Claude Desktop takes the same command/args/env in its
`claude_desktop_config.json` under `mcpServers`.

## Tools

Boards, lanes, owners and categories can be given by name instead of id
everywhere (case-insensitive; a unique prefix works for boards and lanes).

| Tool | Does |
|---|---|
| `list_boards` | every open board, its lanes and open-task count |
| `get_board board [lane]` | the board's lanes with their open tasks (sub-board tasks included), owners and categories by name |
| `search query` | boards by name, tasks by title/description/attachments/comments, across every board |
| `agenda [days]` | overdue and soon-due unfinished tasks on every board (the Today view) |
| `get_task task_id` | one task in full, plus its comment log |
| `task_history task_id [limit]` | the audit trail: who did what, when, from and to which lane, and why |
| `list_owners`, `list_categories board` | the catalogue |
| `create_task board title [lane description due_date parent_id owners categories animation]` | a task (lane defaults to the first) |
| `update_task task_id [...]` | change fields; `owners`/`categories` replace the list, `clear_due_date`, `detach_from_parent` |
| `move_task task_id lane [index animation]` | move within the board; refused if unfinished subtasks would end up left of it |
| `complete_task task_id [animation]` | move to the board's final lane (default animation: celebrate) |
| `archive_task`, `restore_task` | off the board and back, soft as everywhere in UTD |
| `add_comment task_id body` | an entry in the task's log |
| `link_tasks from to [link_type]` | `blocks`, `relates_to`, `similar_to`, `milestone_of`, `duplicates` |
| `create_board name [parent]` | a board with the default lanes |

Resources: `utd://boards`, `utd://boards/{slug}`, `utd://agenda`.

## Layout

- `utd_mcp/client.py`: the httpx wrapper. Non-2xx responses become
  `ToolError`s carrying the API's `detail`, so the model sees the real reason.
- `utd_mcp/server.py`: the `MCPServer`, tools, resources, entry point;
  `use_client()` is how the in-process mount points the tools at its own
  ASGI app.
- `../backend/utd/mcp_app.py`: the in-process mount (lazy session-manager
  start, since daphne has no ASGI lifespan; DNS-rebinding settings from
  Django's `ALLOWED_HOSTS`).
- `tests/test_tools.py`: the tools against a fake API speaking the routes
  in `backend/boards/views.py`; runs without Django.

Built on the official `mcp` Python SDK, v2 (`MCPServer`, formerly `FastMCP`).
