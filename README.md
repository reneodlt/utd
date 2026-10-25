# UTD — Ultimate Todo

A live swim-lane task board that works alongside an AI agent. Drag-and-drop
kanban where every change, whether it comes from you, a script, an automation
rule or Claude Code, goes through one service layer, lands in an audit trail,
and is pushed to every open browser the moment it happens.

- **Backend**: Django 5 + DRF + Channels 4. SQLite (WAL) for development,
  Postgres when configured; in-memory channel layer by default, Redis for
  multi-process.
- **Frontend**: React 19 + TypeScript + Vite, dnd-kit, Motion, zustand.
- **Claude Code**: an MCP server ships in the repo (`mcp-server/`) and is
  mounted inside the app at `/mcp`.

## Why it's built for Claude Code

Claude Code is good at changing code and running commands. It is much less
good at showing you, across a project and across sessions, what it has picked
up, what is blocked on what, what it finished, and what is waiting for you.
UTD is that shared picture, and the agent can write to it as well as you.

- **Direct the agent through the board.** Put work in a lane. Claude Code reads
  it through the `utd` MCP server (`agenda`, `get_board`, `get_task`), picks it
  up, and moves the card as it goes (`move_task`, `add_comment`,
  `complete_task`).
- **Watch it work.** Each change animates on every open board: a pulse when a
  card moves, a celebration on completion, an alarm when something needs
  attention. The animation is set per change.
- **See who did what.** A card's history names the actor for every change:
  you, `claude` (or whatever `UTD_ACTOR` is set to), an automation rule, an
  API integration, or an automatic unblock when the task blocking this one
  finishes.
- **Step in with ordinary clicks.** To redirect the agent you move a card,
  leave a comment, or reassign it. Those changes are recorded as yours, so the
  history separates what you decided from what the agent did.
- **Give it structure.** Subtasks, typed links (`blocks`, `relates_to`,
  `duplicates`, …) and categories tell the agent what gates what. A blocker
  that reaches the final lane stops blocking on its own.

A workflow that works well: label the tasks you want the agent to take (a
category such as `ai`), keep them in an "Up Next" lane, and ask Claude Code to
work through that lane. Each card shows what it started, what it commented
and when it finished.

## Run it locally

You need Python 3.12+ with [uv](https://docs.astral.sh/uv/), and Node 22+.

```sh
make migrate && make seed && make dev
```

Open http://localhost:5173, ideally in two windows side by side to see live
sync. Django admin (board, lane and catalogue configuration) is at
http://localhost:8000/admin. Create a superuser with
`cd backend && uv run python manage.py createsuperuser`.

`make seed` is optional demo data. An empty database greets you with a
create-your-first-board screen. The header's board name is a menu (switch,
create, rename, archive), each board has a stable URL (`#/b/<slug>`), and the
◐ button switches between system, light, dark and true-black themes.

## Connect Claude Code

The repo's `.mcp.json` registers the `utd` server for Claude Code when you
open the project. It runs `mcp-server/` over stdio against
`http://localhost:8000`, so start the dev backend first. For any other
directory, point Claude Code at a running instance:

```sh
claude mcp add --scope user --transport http utd http://localhost:8000/mcp
```

The server exposes `list_boards`, `get_board`, `search`, `agenda`, `get_task`,
`task_history`, `create_task`, `update_task`, `move_task`, `complete_task`,
`archive_task`, `restore_task`, `add_comment`, `link_tasks`, `create_board`
and the owner and category catalogues. Boards, lanes, owners and categories
can be given by name. Details are in [`mcp-server/README.md`](mcp-server/README.md).

## Features

Click any card for its detail drawer: its full history in plain language, with
who did what and, for automated changes, which event set them off. Other
highlights:

- **Focus on this task** fades every card except that task, its parents and
  its subtasks at any depth, and lifts those above a divider. It is display
  only: the stored order is untouched. Esc leaves focus.
- **Subtasks** of any depth, with progress per card. A card's subtask list
  strikes through subtasks that reached the final lane. Collapsed, it becomes
  a progress bar with one segment per subtask, coloured by lane.
- **Lanes** are configurable per board: add, rename, recolour, reorder, set a
  WIP limit, and mark a lane *final*. Tasks in a final lane count as done:
  they stop blocking, finish their subtasks and count toward cycle time.
- **Blocking** is flow-aware. A blocker that reaches the final lane (or is
  archived) stops blocking, and the change is audited and broadcast.
- **Nested boards**: a parent board shows its own tasks plus those of its
  sub-boards, each labelled with its board. Lanes line up by name.
- **Automation rules** (Django admin) match audit events and react: inject an
  animation, add a checklist subtask, or move a task. Automation is audited
  under `rule:<name>` like everything else.
- **Attachments** are typed references on a task: web pages, GitHub PRs and
  issues, places on a map, phone numbers, emails, calendar entries, and
  files. Kinds are plugins (see Architecture). Photos and audio or video clips
  can be uploaded and play in place.
- **Owners** (name, short code, colours, optional emoji) are shared by every
  board. **Categories** label tasks, shared or per board.
- **Today** view: unfinished tasks due soon across every board, with a tick-off
  per board. Search across boards and tasks, undo for recent actions, quick
  add (one task per line, with links and contacts recognised), and a per-board
  iCalendar feed of deadlines.
- **Live sync**: every change reaches every open client over websockets, with
  an optional named animation.

## Deploying

The `Dockerfile` builds a single image: a Vite build of the frontend, served by
whitenoise alongside daphne, which handles HTTP and websockets. It runs
migrations on boot.

```sh
docker build -t utd .
docker run -p 8000:8000 \
  -e UTD_DEBUG=0 \
  -e UTD_SECRET_KEY="$(python3 -c 'import secrets; print(secrets.token_urlsafe(50))')" \
  -e UTD_ALLOWED_HOSTS=localhost,127.0.0.1 \
  -e UTD_DB_PATH=/data/db.sqlite3 \
  -e UTD_MEDIA_ROOT=/data/media \
  -v utd-data:/data \
  utd
```

Without a volume and `UTD_DB_PATH`, the SQLite database lives inside the
container and is lost when it is removed.

| Variable | Purpose |
|---|---|
| `UTD_DEBUG` | `1` (default) for development. Set `0` for anything else. |
| `UTD_SECRET_KEY`, `UTD_SECRET_KEY_FILE` | Django secret. Required when `UTD_DEBUG=0`. |
| `UTD_ALLOWED_HOSTS` | Comma-separated host names the site answers to. |
| `UTD_CSRF_TRUSTED_ORIGINS` | Comma-separated origins for admin and session POSTs, e.g. `https://board.example.com`. |
| `UTD_PG_HOST`, `UTD_PG_PORT`, `UTD_PG_NAME`, `UTD_PG_USER`, `UTD_PG_PASSWORD` (or `_FILE`) | Use Postgres when `UTD_PG_HOST` is set. |
| `UTD_DB_PATH` | Location of the SQLite file. |
| `UTD_MEDIA_ROOT` | Where uploaded photos and files are stored. |
| `REDIS_URL` | Redis channel layer for several app processes. |
| `UTD_PUBLIC_URL` | Base URL used for links in MCP tool results. |
| `UTD_ACTOR` | Name recorded in the audit trail for MCP changes (default `claude`). |

Any `UTD_*` secret also accepts a `_FILE` variant that names a file, which suits
Docker and Compose secrets.

## Security: read this before exposing it

UTD is a single-user or small-team tool and it is **not ready for the open
internet**.

- **There is no sign-in yet.** The web UI, the REST API, the websocket and the
  `/mcp` endpoint do not authenticate. Anyone who can reach the server can read
  and change the board. Run it on a trusted network or a VPN, or put an
  authenticating reverse proxy in front of it. Sign-in is on the roadmap.
- **The server fetches pasted links** to read their titles (quick add), and it
  will fetch internal addresses too. Only run UTD where that is acceptable.
- **The development `SECRET_KEY` is public** and used only when `UTD_DEBUG=1`.
  Production refuses to start without `UTD_SECRET_KEY`.
- **Uploads** are sniffed from their bytes and size-limited (25 MB per file,
  100 MB for video), but they are still user-supplied files. Serve the instance
  only to people you trust.

Please report security problems privately rather than in a public issue.

## Dogfooding and data

- **Keep real data out of the repo.** Set `UTD_DB_PATH` to a location outside
  the checkout, for example `~/.local/share/utd/db.sqlite3`. Without it the
  development database is `backend/db.sqlite3`, which is gitignored but easy to
  lose to `git clean -fdx`.
- **Backups**: `make backup` snapshots the live database with SQLite's online
  backup API (safe while the server runs), checks the copy's integrity, and
  keeps the 30 most recent in a `backups/` directory beside the database.
- **Nothing hard-deletes.** Archiving boards or tasks is a soft delete: rows and
  the audit trail survive, and things just leave the lists. Restore is one call.

## Roadmap (agreed, not built yet)

- **Recurring tasks**: "every Monday", "1st of the month", "3 days after done",
  with the next copy created when the current one is completed.
- **Sign-in**: django-allauth (local accounts first, then an OIDC provider),
  DRF personal tokens for scripts, and secret calendar feed URLs. History will
  then name real people.
- **Scheduled Postgres backups** for production deployments.

[`docs/MECHANISMS.md`](docs/MECHANISMS.md) holds the research catalogue behind
the roadmap: automation rules, classes of service, defer and snooze, and more.

## Architecture notes

- `backend/boards/services.py` is the **only** place tasks mutate. Every service
  call atomically applies the change, writes a `TaskEvent` audit row, and
  broadcasts the websocket envelope after commit. API views, the websocket
  consumer and the seed command all go through it.
- Tasks form a graph: `parent` (subtasks, arbitrary depth), typed `TaskLink`
  edges (`blocks`, `relates_to`, `similar_to`, `milestone_of`, `duplicates`),
  and `Attachment` rows: references a task carries. Kinds are plugins: the
  server registry in `backend/boards/attachments.py` validates each kind's
  data (`GET /api/attachment-kinds/` lists them), and a matching plugin in
  `frontend/src/attachments/` says how it looks, what pasted text it recognises
  and what opening it does. Adding a kind is one entry on each side, with no
  migration. `POST /api/tasks/<id>/attachments/` `{"kind", "data", "label"?}`;
  PATCH and DELETE on `.../attachments/<id>/` (soft delete).
- Owners are shared by every board and edited from the settings panel.
  `GET/POST /api/owners/`, `PATCH/DELETE /api/owners/<id>/` (soft delete). Set a
  task's owners with `PATCH /api/tasks/<id>/ {"owner_ids": [...]}` (audited).
  Owner edits broadcast `owners.changed` to every board.
- Tasks are open, archived, or deleted (the bin). All of these are reversible.
  `POST /api/tasks/<id>/delete/` and `.../restore/`;
  `POST /api/lanes/<id>/archive-all/`; list with
  `GET /api/boards/<id>/tasks/?state=archived|deleted`. A deleted task also has
  `archived_at` set, so "on the board" is always `archived_at is null`.
  `DELETE /api/tasks/<id>/` still archives.
- Categories label tasks, 0..n per task. A category is shared by every board
  (`board` empty) or belongs to one board. Names are unique (ignoring case)
  among what a board can see. `GET/POST /api/boards/<id>/categories/`,
  `PATCH/DELETE /api/categories/<id>/`; set with
  `PATCH /api/tasks/<id>/ {"category_ids": [...]}` (audited). Changes broadcast
  `category.changed`.
- Boards nest (`Board.parent`). Re-parent with
  `PATCH /api/boards/<id>/ {"parent_id": id|null}` (cycles refused); create
  inside with `POST /api/boards/ {"name", "parent_id"}`. Archiving a board lifts
  its children to its parent. Task events fan out to every ancestor board's
  group.
- Quick add (header; `n` to focus): one task per line. A line with a link or
  contact becomes a task of that kind with the attachment. `POST .../tasks/`
  accepts `"attachments": [{kind, data, label?}]`, created atomically with the
  task. `GET /api/link-title/?url=` returns a pasted link's title (GitHub's API
  for PRs, issues and repos; otherwise og:title or `<title>`; best effort).
- Search (`GET /api/search/?q=`), client-side undo, task links, and the Today
  view (`GET /api/agenda/?today=&days=`) with each board's done lane for tick-off.
- Photos and files: `POST /api/tasks/<id>/files/` (multipart `file`, many) and
  `POST /api/boards/<id>/file-task/` (a task from one file). Served from
  `GET /api/files/<attachment id>/` (`?thumb=1`, `?download=1`), stored under
  `UTD_MEDIA_ROOT`, with 640px JPEG thumbnails for images. Up to 25 MB each,
  except media: **audio** (ogg/opus, mp3, wav, flac, m4a/aac, webm) up to 20 MB
  and **video** (mp4, webm, mov) up to 100 MB. Audio and video are recognised
  from their bytes (magic numbers), never from the client's content type or
  the extension. With `ffprobe` on PATH an upload also gets `data.duration`,
  and with `ffmpeg` a video gets a poster frame; without them both are simply
  absent. `GET /api/files/<id>/` answers `Range: bytes=` requests, so `<audio>`
  and `<video>` can seek.
- Lanes: `GET/POST /api/boards/<id>/lanes/`,
  `POST /api/boards/<id>/lanes/order/ {"lane_ids"}`, `PATCH /api/lanes/<id>/`
  (renaming a lane that sub-boards share needs `"cascade": true`, else 409),
  `DELETE /api/lanes/<id>/?move_to=<lane>` (hides it; open tasks move).
- Ordering uses float midpoints, with automatic lane renumbering when gaps
  collapse (`lane.rebalanced` broadcast keeps clients consistent).
- Butler-style automation: `AutomationRule` rows match audit events and react.
  Automation goes through the service layer, so it is audited
  (`actor="rule:<name>"`) and broadcast.
- Blocking is flow-aware, as described under Features. Cards age visually the
  longer they sit in a working lane, and the header shows live flow metrics.
- The Django admin bypasses the service layer (no audit, no broadcast). Use it
  for board, lane and catalogue configuration, not day-to-day task edits.

## MCP server

[`mcp-server/`](mcp-server/README.md) is an
[MCP](https://modelcontextprotocol.io) server that puts the board in front of
Claude Code, Claude Desktop and any other MCP client. It is a client of the
REST API, not of the database, so every change it makes is audited under its
actor name (`UTD_ACTOR`, default `claude`) and animates on open boards like any
other integration.

It runs two ways. **In-process**: `backend/utd/mcp_app.py` mounts it at `/mcp`
inside the daphne process (streamable HTTP, JSON replies, stateless). The
tools call the API over ASGI in the same process. The SDK's DNS-rebinding check
uses `UTD_ALLOWED_HOSTS`, and `UTD_PUBLIC_URL` sets the links in tool results.
**Standalone**: `uv run utd-mcp` in `mcp-server/` speaks stdio, for Claude Code
and Claude Desktop, against `UTD_URL`.

## Curl cookbook

Everything the board does is available over HTTP, which is handy for scripts
and for watching what an integration does.

```sh
BOARD=$(curl -s localhost:8000/api/boards/ | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["id"])')
curl -s localhost:8000/api/boards/$BOARD/snapshot/ | python3 -m json.tool | less
```

Boards are API-manageable: create (default lanes plus a celebrate-on-done rule,
or pass your own `lanes`), rename and archive:

```sh
curl -s -X POST localhost:8000/api/boards/ \
  -H 'Content-Type: application/json' -d '{"name": "Ops"}'
curl -s -X PATCH localhost:8000/api/boards/$BOARD/ \
  -H 'Content-Type: application/json' -d '{"name": "Ops 2.0"}'
curl -s -X DELETE localhost:8000/api/boards/$BOARD/   # soft archive
```

Create a task with a celebration (watch the board):

```sh
curl -s -X POST localhost:8000/api/boards/$BOARD/tasks/ \
  -H 'Content-Type: application/json' \
  -d '{"lane_id": "<LANE>", "title": "Deploy v1.2, CI green",
       "meta": {"actor": "github-ci", "animation": "celebrate"}}'
```

Move a task with an alarm:

```sh
curl -s -X POST localhost:8000/api/tasks/<TASK>/move/ \
  -H 'Content-Type: application/json' \
  -d '{"to_lane_id": "<LANE>", "index": 0,
       "meta": {"actor": "pagerduty", "animation": "alarm"}}'
```

Task graph and audit:

```sh
curl -s -X POST localhost:8000/api/tasks/<A>/links/ \
  -H 'Content-Type: application/json' \
  -d '{"to_task_id": "<B>", "link_type": "blocks"}'         # A now blocks B
curl -s localhost:8000/api/tasks/<TASK>/events/              # audit trail
curl -s "localhost:8000/api/tasks/<TASK>/events/?include=subtasks"  # + subtask creation
curl -s localhost:8000/api/tasks/<TASK>/timeline/            # time per lane
curl -s "localhost:8000/api/boards/$BOARD/events/?since=0"   # board feed
curl -s localhost:8000/api/boards/$BOARD/analytics/          # cycle time, throughput, residency
```

Websocket, for scripts that skip REST:

```
ws://localhost:8000/ws/boards/<BOARD>/
→ {"type": "task.move", "task_id": "…", "to_lane_id": "…", "index": 0,
   "meta": {"actor": "script", "animation": "pulse"}}
```

## Tests

```sh
make test       # backend: services, REST API, websocket consumer, MCP mount
make mcp-test   # MCP server tools, against an in-memory fake of the API
```

## Contributing

Issues and pull requests are welcome. Run `make test` and `make mcp-test`
before opening a PR. Keep changes to task state going through
`backend/boards/services.py`, so they stay audited and broadcast.

## License

MIT. See [LICENSE](LICENSE).
