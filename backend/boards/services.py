"""The mutation choke point.

Every task mutation — from DRF views, the websocket consumer, management
commands, or future integrations — goes through these functions, which
guarantee that each change (a) is applied atomically, (b) writes an
immutable TaskEvent audit row, and (c) broadcasts to the board's websocket
group after commit. Never mutate Task/TaskLink/Attachment rows directly.
"""

import re
from collections import defaultdict
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import timedelta

from django.db import transaction
from django.db.models import Max
from django.utils import timezone
from django.utils.text import slugify

from . import attachments, events, measures
from .models import (
    POSITION_GAP,
    REBALANCE_THRESHOLD,
    Attachment,
    AutomationRule,
    Board,
    Category,
    Lane,
    Owner,
    Source,
    Task,
    TaskEvent,
    TaskLink,
    TaskComment,
    TaskValue,
)

RULE_ACTOR_PREFIX = "rule:"

# The event currently causing follow-on events (rule actions, unblock
# ripples); _record stamps it on everything written while it is set.
_cause: ContextVar[TaskEvent | None] = ContextVar("cause", default=None)


@contextmanager
def _caused_by(event: TaskEvent):
    token = _cause.set(event)
    try:
        yield
    finally:
        _cause.reset(token)


class ServiceError(ValueError):
    """Domain-rule violation (cycle, cross-board move, bad lane...)."""


class SubtaskBlockedError(ServiceError):
    """A parent task may never sit to the right of its subtasks."""

    def __init__(self, blockers):
        self.blockers = blockers
        super().__init__(
            "task cannot move right of its subtasks: "
            + ", ".join(str(t.pk) for t in blockers)
        )


def _active_tasks(lane: Lane):
    return lane.tasks.filter(archived_at__isnull=True).order_by("position")


def _clean_animation(board: Board, animation: str) -> str:
    """Unknown animation names are dropped, never rejected — external
    callers must not break on cosmetics."""
    return animation if animation in board.enabled_animations() else ""


def _position_for_index(lane: Lane, index: int | None, *, exclude: Task | None = None):
    """Compute a float position landing at `index` in the lane's active
    order (append if None), and whether the gap collapsed and the lane
    needs renumbering."""
    tasks = list(_active_tasks(lane))
    if exclude is not None:
        tasks = [t for t in tasks if t.pk != exclude.pk]
    if index is None:
        index = len(tasks)
    index = max(0, min(index, len(tasks)))

    if not tasks:
        return POSITION_GAP, False
    if index == 0:
        return tasks[0].position - POSITION_GAP, False
    if index == len(tasks):
        return tasks[-1].position + POSITION_GAP, False
    before, after = tasks[index - 1].position, tasks[index].position
    position = (before + after) / 2
    return position, (after - before) < REBALANCE_THRESHOLD


def _rebalance_lane(lane: Lane) -> dict[str, float]:
    positions = {}
    for i, task in enumerate(_active_tasks(lane)):
        task.position = (i + 1) * POSITION_GAP
        task.save(update_fields=["position", "updated_at"])
        positions[str(task.pk)] = task.position
    return positions


def _record(task, event_type, *, actor, source, animation="", op_id="",
            from_lane=None, to_lane=None, payload=None, extra_meta=None,
            also_boards=()) -> TaskEvent:
    event = TaskEvent.objects.create(
        board=task.board,
        task=task,
        event_type=event_type,
        actor=actor or "anonymous",
        source=source,
        animation=animation,
        op_id=op_id,
        from_lane=from_lane,
        to_lane=to_lane,
        payload=payload or {},
        caused_by=_cause.get(),
    )
    # Broadcast is registered before rules run so cause precedes effect on
    # the wire; the envelope is built at commit time, so a rule's
    # set_animation override still lands in this event's broadcast.
    transaction.on_commit(lambda: events.broadcast_event(event, task, extra_meta, also_boards))
    _apply_rules(event, task)
    if task.parent_id:
        with _caused_by(event):
            _follow_next_owner(task.parent)
    return event


def _apply_rules(event: TaskEvent, task: Task) -> None:
    """Board automations (see automation.py)."""
    from . import automation
    automation.apply_rules(event, task)


DEFAULT_LANES = [
    {"name": "Backlog", "color": "#6b7280"},
    {"name": "In Progress", "color": "#3b82f6", "wip_limit": 3},
    {"name": "Review", "color": "#f59e0b"},
    {"name": "Done", "color": "#22c55e", "is_final": True},
]

DEFAULT_ANIMATION_CATALOGUE = {
    "enabled": ["slide", "pulse", "celebrate", "alarm"],
    "default": "slide",
}


def _unique_slug(name: str) -> str:
    base = slugify(name)[:40] or "board"
    slug, n = base, 2
    while Board.objects.filter(slug=slug).exists():
        slug = f"{base}-{n}"
        n += 1
    return slug


def create_board(name: str, *, lanes: list[dict] | None = None,
                 parent: Board | None = None) -> Board:
    """Create a board ready for real work: lanes (defaults to a standard
    kanban flow), the full animation catalogue, and a celebrate-on-done
    automation rule. The last lane is always the "done" lane — blocking and
    cycle-time both key off it."""
    name = name.strip()
    if not name:
        raise ServiceError("board name is required")
    lane_specs = lanes if lanes else DEFAULT_LANES
    if not isinstance(lane_specs, list) or not all(
        isinstance(spec, dict) and (spec.get("name") or "").strip()
        for spec in lane_specs
    ):
        raise ServiceError("lanes must be a list of {name, color?, wip_limit?}")
    with transaction.atomic():
        board = Board.objects.create(
            name=name,
            slug=_unique_slug(name),
            parent=parent,
            animation_catalogue=dict(DEFAULT_ANIMATION_CATALOGUE),
        )
        transaction.on_commit(events.broadcast_boards_changed)
        # No lane marked final? The last one is the done lane.
        any_final = any(spec.get("is_final") for spec in lane_specs)
        for order, spec in enumerate(lane_specs):
            wip = spec.get("wip_limit")
            if wip is not None and (not isinstance(wip, int) or wip < 0):
                raise ServiceError("wip_limit must be a non-negative integer")
            lane = Lane.objects.create(
                board=board,
                name=spec["name"].strip()[:100],
                order=order,
                color=str(spec.get("color") or "#6b7280")[:7],
                wip_limit=wip,
                is_final=bool(spec.get("is_final")) if any_final
                else order == len(lane_specs) - 1,
            )
        AutomationRule.objects.create(
            board=board,
            name="celebrate-done",
            trigger={"when": "moved", "final": True},
            actions=[{"type": "set_animation", "name": "celebrate"}],
        )
        _sync_up(board)
    return board


def rename_board(board: Board, name: str) -> Board:
    name = name.strip()
    if not name:
        raise ServiceError("board name is required")
    board.name = name
    board.save(update_fields=["name", "updated_at"])
    transaction.on_commit(events.broadcast_boards_changed)
    return board


def hours_per_day(board: Board) -> float:
    """A board's working day for time figures: its own setting, else the
    nearest ancestor's, else the default."""
    seen = set()
    while board is not None and board.pk not in seen:
        seen.add(board.pk)
        hours = (board.metadata or {}).get("hours_per_day")
        if hours:
            return float(hours)
        board = board.parent
    return measures.DEFAULT_HOURS_PER_DAY


def set_hours_per_day(board: Board, raw) -> Board:
    """None = inherit from the parent board again."""
    metadata = dict(board.metadata or {})
    if raw is None or raw == "":
        metadata.pop("hours_per_day", None)
    else:
        try:
            metadata["hours_per_day"] = measures.clean_hours_per_day(raw)
        except measures.MeasureError as exc:
            raise ServiceError(str(exc)) from None
    board.metadata = metadata
    board.save(update_fields=["metadata", "updated_at"])
    transaction.on_commit(events.broadcast_boards_changed)
    return board


def archive_board(board: Board) -> Board:
    """Soft delete. Its child boards move up to its parent, so the tree
    never hides live boards under an archived one."""
    if board.archived_at is None:
        with transaction.atomic():
            board.archived_at = timezone.now()
            board.save(update_fields=["archived_at", "updated_at"])
            board.children.filter(archived_at__isnull=True).update(parent=board.parent)
            transaction.on_commit(events.broadcast_boards_changed)
    return board


def set_board_parent(board: Board, parent: Board | None) -> Board:
    """Re-parent a board (None = top level). Refuses cycles and archived
    parents."""
    if board.kind == "inbox" or (parent is not None and parent.kind == "inbox"):
        raise ServiceError("the inbox stays on its own")
    if parent is not None:
        if parent.pk == board.pk:
            raise ServiceError("a board can't be its own parent")
        if parent.archived_at is not None:
            raise ServiceError("that board is archived")
        from .family import ancestor_ids
        if board.pk in ancestor_ids(parent.pk):
            raise ServiceError("a board can't go inside one of its own sub-boards")
    new_parent_id = parent.pk if parent else None
    if board.parent_id == new_parent_id:
        return board
    with transaction.atomic():
        board.parent = parent
        board.save(update_fields=["parent", "updated_at"])
        _sync_up(board)  # its new ancestors take on its lanes
        transaction.on_commit(events.broadcast_boards_changed)
    return board


def create_task(board: Board, lane: Lane, title: str, *, description="", parent=None,
                metadata=None, index=None, due_date=None, actor="anonymous", source=Source.API,
                animation="", op_id="") -> Task:
    if lane.board_id != board.pk:
        raise ServiceError("lane does not belong to this board")
    if lane.archived_at is not None:
        raise ServiceError("that lane has been removed")
    if parent is not None and parent.board_id != board.pk:
        raise ServiceError("parent task belongs to a different board")
    with transaction.atomic():
        position, needs_rebalance = _position_for_index(lane, index)
        task = Task.objects.create(
            board=board,
            lane=lane,
            parent=parent,
            title=title,
            description=description,
            metadata=metadata or {},
            position=position,
            lane_entered_at=timezone.now(),
            due_date=_clean_due_date(due_date),
        )
        animation = _clean_animation(board, animation)
        _record(
            task, TaskEvent.EventType.CREATED,
            actor=actor, source=source, animation=animation, op_id=op_id,
            to_lane=lane,
            payload={"title": title, "position": position,
                     "parent_id": str(parent.pk) if parent else None},
        )
        if needs_rebalance:
            _schedule_rebalance(lane)
    return task


def move_task(task: Task, to_lane: Lane, index: int | None, *, actor="anonymous",
              source=Source.API, animation="", op_id="") -> Task:
    if to_lane.board_id != task.board_id:
        raise ServiceError("cannot move task to a lane on another board")
    if task.archived_at is not None:
        raise ServiceError("cannot move an archived task")
    if to_lane.archived_at is not None:
        raise ServiceError("that lane has been removed")
    blockers = list(
        task.subtasks.filter(archived_at__isnull=True, lane__order__lt=to_lane.order)
    )
    if blockers:
        raise SubtaskBlockedError(blockers)
    with transaction.atomic():
        from_lane = task.lane
        position, needs_rebalance = _position_for_index(to_lane, index, exclude=task)
        task.position = position
        lane_changed = from_lane.pk != to_lane.pk
        if lane_changed:
            task.lane = to_lane
            task.lane_entered_at = timezone.now()
            task.save(update_fields=["lane", "position", "lane_entered_at", "updated_at"])
        else:
            task.save(update_fields=["position", "updated_at"])
        moved = _record(
            task, TaskEvent.EventType.MOVED,
            actor=actor, source=source,
            animation=_clean_animation(task.board, animation), op_id=op_id,
            from_lane=from_lane, to_lane=to_lane,
            payload={"position": position},
            extra_meta={"from_lane_id": str(from_lane.pk), "to_lane_id": str(to_lane.pk)},
        )
        if lane_changed:
            was_resolved = from_lane.is_final
            now_resolved = to_lane.is_final
            if was_resolved != now_resolved:
                with _caused_by(moved):
                    _ripple_block_state(task, became_resolved=now_resolved, actor=actor)
        if needs_rebalance:
            _schedule_rebalance(to_lane)
    return task


MUTABLE_FIELDS = {"title", "description", "metadata", "due_date", "hide_subtasks",
                  "owner_follows_next"}
BOOLEAN_FIELDS = {"hide_subtasks", "owner_follows_next"}


def _clean_due_date(value):
    """ISO date string (or a datetime's date part), or empty for none."""
    from datetime import date
    if value in (None, ""):
        return None
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        raise ServiceError("due_date must be a date like 2026-10-01") from None


def _jsonable(value):
    return value.isoformat() if hasattr(value, "isoformat") else value


def update_task(task: Task, changes: dict, *, parent=..., owners=..., categories=...,
                values=..., actor="anonymous", source=Source.API, animation="",
                op_id="") -> Task:
    """`owners` / `categories`, when given, are the task's complete new lists.
    `values` is {category: figure or None to clear}, for just the categories
    named; each must be one of the task's and take a figure."""
    unknown = set(changes) - MUTABLE_FIELDS
    if unknown:
        raise ServiceError(f"cannot update fields: {', '.join(sorted(unknown))}")
    with transaction.atomic():
        changed = []
        # Before/after values, so the card history can say what changed and
        # not just which field.
        diff = {}
        if "due_date" in changes:
            changes = {**changes, "due_date": _clean_due_date(changes["due_date"])}
        for field in BOOLEAN_FIELDS & set(changes):
            if not isinstance(changes[field], bool):
                raise ServiceError(f"{field} must be true or false")
        for field, value in changes.items():
            old = getattr(task, field)
            if old != value:
                setattr(task, field, value)
                changed.append(field)
                diff[field] = {"from": _jsonable(old), "to": _jsonable(value)}
        old_parent_task = task.parent if parent is not ... else None
        if parent is not ...:
            _validate_parent(task, parent)
            old_parent = str(task.parent_id) if task.parent_id else None
            new_parent = str(parent.pk) if parent else None
            task.parent = parent
            if old_parent != new_parent:
                changed.append("parent")
                diff["parent"] = {"from": old_parent, "to": new_parent}
        if owners is not ...:
            archived = [o for o in owners if o.archived_at is not None]
            if archived:
                raise ServiceError(f"owner is archived: {archived[0].name}")
            old_ids = sorted(str(pk) for pk in task.owners.values_list("pk", flat=True))
            new_ids = sorted({str(o.pk) for o in owners})
            if old_ids != new_ids:
                task.owners.set(owners)
                changed.append("owners")
                diff["owners"] = {"from": old_ids, "to": new_ids}
                # Owners chosen by hand for a parent: they own the process,
                # so stop following the next subtask.
                if (task.owner_follows_next and "owner_follows_next" not in changes
                        and task.subtasks.filter(archived_at__isnull=True).exists()):
                    task.owner_follows_next = False
                    changed.append("owner_follows_next")
                    diff["owner_follows_next"] = {"from": True, "to": False}
        if categories is not ...:
            for c in categories:
                if c.archived_at is not None:
                    raise ServiceError(f"category is archived: {c.name}")
                if c.board_id is not None and c.board_id != task.board_id:
                    raise ServiceError(f"category belongs to another board: {c.name}")
            old_ids = sorted(str(pk) for pk in task.categories.values_list("pk", flat=True))
            new_ids = sorted({str(c.pk) for c in categories})
            if old_ids != new_ids:
                task.categories.set(categories)
                changed.append("categories")
                diff["categories"] = {"from": old_ids, "to": new_ids}
        if values is not ...:
            value_diff = _set_values(task, values)
            if value_diff:
                changed.append("values")
                diff["values"] = value_diff
        if not changed:
            return task
        task.save(update_fields=[
            f for f in changed if f not in ("owners", "categories", "values")] + ["updated_at"])
        updated = _record(
            task, TaskEvent.EventType.UPDATED,
            actor=actor, source=source,
            animation=_clean_animation(task.board, animation), op_id=op_id,
            payload={"changed_fields": changed, "changes": diff},
            extra_meta={"changed_fields": changed},
        )
        with _caused_by(updated):
            if "owner_follows_next" in changed and task.owner_follows_next:
                _follow_next_owner(task)
            if "parent" in changed and old_parent_task is not None:
                _follow_next_owner(old_parent_task)
    return task


def _amount_text(amount) -> str | None:
    return None if amount is None else format(amount.normalize(), "f")


def _set_values(task: Task, values: dict) -> dict:
    """Write a task's figures; returns {category_id: {from, to, ...}} for
    what changed. Clearing a figure removes its row (the audit keeps it).

    Changing a figure once the task is done (final lane, or archived) keeps
    the figure as it stood as the estimate, and the new one is the actual;
    setting it back to the estimate drops the split again."""
    on_task = set(task.categories.values_list("pk", flat=True))
    existing = {v.category_id: v for v in task.values.all()}
    done = task.archived_at is not None or task.lane.is_final
    diff = {}
    for category, raw in values.items():
        if category.pk not in on_task:
            raise ServiceError(f"the task isn't in {category.name}")
        if not category.value_type:
            raise ServiceError(f"{category.name} doesn't take a figure")
        row = existing.get(category.pk)
        current = row is not None and row.value_type == category.value_type
        if category.value_type == measures.LOCATION:
            change = _set_location(task, category, row if current else None, raw)
            if change:
                diff[str(category.pk)] = change
            continue
        old = row.amount if current else None
        old_estimate = row.estimate if current else None
        if raw is None or raw == "":
            new = None
        else:
            try:
                new = measures.clean_amount(category.value_type, raw, category.value_config)
            except measures.MeasureError as exc:
                raise ServiceError(f"{category.name}: {exc}") from None
        if old == new:
            continue
        estimate = None
        if new is None:
            row.delete()
        else:
            estimate = old_estimate
            if done and estimate is None and old is not None:
                estimate = old
            if estimate is not None and estimate == new:
                estimate = None
            if row:
                row.amount, row.value_type, row.estimate = new, category.value_type, estimate
                row.save(update_fields=["amount", "value_type", "estimate", "updated_at"])
            else:
                TaskValue.objects.create(task=task, category=category,
                                         value_type=category.value_type, amount=new)
        change = {
            "name": category.name, "type": category.value_type,
            "from": _amount_text(old), "to": _amount_text(new),
        }
        if estimate is not None:
            change["estimate"] = _amount_text(estimate)
        diff[str(category.pk)] = change
    return diff


# ---------- a parent's owners follow its next-up subtask ----------

AUTO_OWNER_ACTOR = "auto"
_following: ContextVar[int] = ContextVar("following", default=0)


def next_subtask(parent: Task) -> Task | None:
    """The subtask to tackle next: ready (not done, nothing unfinished
    blocking it), in the furthest-along lane, then highest in that lane —
    the same pick as the app's ★ Next."""
    ready = [
        t for t in parent.subtasks.filter(archived_at__isnull=True).select_related("lane")
        if not t.lane.is_final and not _active_blockers(t)
    ]
    ready.sort(key=lambda t: (-t.lane.order, t.position))
    return ready[0] if ready else None


def _follow_next_owner(parent: Task) -> None:
    """If the parent follows its next subtask, take that subtask's owners.
    An unowned next subtask, or none left, leaves the owners as they are.
    The change is audited (actor "auto") and ripples up to grandparents."""
    depth = _following.get()
    if depth > 20 or parent.archived_at is not None:
        return
    parent.refresh_from_db(fields=["owner_follows_next", "archived_at"])
    if not parent.owner_follows_next or parent.archived_at is not None:
        return
    nxt = next_subtask(parent)
    if nxt is None:
        return
    owners = [o for o in nxt.owners.all() if o.archived_at is None]
    if not owners:
        return
    old_ids = sorted(str(pk) for pk in parent.owners.values_list("pk", flat=True))
    new_ids = sorted(str(o.pk) for o in owners)
    if old_ids == new_ids:
        return
    token = _following.set(depth + 1)
    try:
        parent.owners.set(owners)
        parent.save(update_fields=["updated_at"])
        _record(
            parent, TaskEvent.EventType.UPDATED,
            actor=AUTO_OWNER_ACTOR, source=Source.SYSTEM,
            payload={"changed_fields": ["owners"],
                     "changes": {"owners": {"from": old_ids, "to": new_ids}},
                     "owners_from_subtask": str(nxt.pk)},
            extra_meta={"changed_fields": ["owners"]},
        )
    finally:
        _following.reset(token)


# ---------- moving between boards ----------

def _lane_like(board: Board, lane: Lane) -> Lane:
    """The lane on `board` with `lane`'s name, else its first lane."""
    lanes = list(_active_lanes(board))
    if not lanes:
        raise ServiceError(f"{board.name} has no lanes")
    key = _lane_key(lane.name)
    return next((l for l in lanes if _lane_key(l.name) == key), lanes[0])


def _descendants(task: Task) -> list[Task]:
    """Every subtask below it, archived ones too (they travel with it)."""
    out, frontier = [], [task]
    while frontier:
        children = list(Task.objects.filter(parent__in=frontier))
        out.extend(children)
        frontier = children
    return out


def move_to_board(task: Task, board: Board, lane: Lane | None = None, *, index=None,
                  actor="anonymous", source=Source.API, animation="", op_id="") -> Task:
    """Move a task to another board, into `lane` (default: the lane there
    with the same name, else the first). Its subtasks go with it, into
    their own same-named lanes; a subtask moved on its own leaves its parent
    and becomes a top-level task. Links are kept. Categories that belong to
    the old board come off (their figures stay, hidden)."""
    if task.archived_at is not None:
        raise ServiceError("restore the task before moving it")
    if board.archived_at is not None:
        raise ServiceError("that board is archived")
    if lane is not None and (lane.board_id != board.pk or lane.archived_at is not None):
        raise ServiceError("that lane isn't on the board")
    if board.pk == task.board_id:
        if lane is None:
            return task
        return move_task(task, lane, index, actor=actor, source=source,
                         animation=animation, op_id=op_id)
    from_board = task.board
    family = [task, *_descendants(task)]
    with transaction.atomic():
        old_parent = task.parent
        if old_parent is not None:
            task.parent = None
            task.save(update_fields=["parent", "updated_at"])
        for member in family:
            member.refresh_from_db()
            from_lane = member.lane
            target = lane if (member.pk == task.pk and lane is not None) else _lane_like(board, from_lane)
            position, needs_rebalance = _position_for_index(
                target, index if member.pk == task.pk else None, exclude=member)
            member.board = board
            member.lane = target
            member.position = position
            member.lane_entered_at = timezone.now()
            member.save(update_fields=["board", "lane", "position", "lane_entered_at", "updated_at"])
            # Board-only categories don't travel.
            stay = [c for c in member.categories.all() if c.board_id in (None, board.pk)]
            if len(stay) != member.categories.count():
                member.categories.set(stay)
            _record(
                member, TaskEvent.EventType.MOVED,
                actor=actor, source=source,
                animation=_clean_animation(board, animation) if member.pk == task.pk else "",
                op_id=op_id if member.pk == task.pk else "",
                from_lane=from_lane, to_lane=target,
                payload={"position": position, "from_board": from_board.name,
                         "to_board": board.name, "from_board_id": str(from_board.pk),
                         "to_board_id": str(board.pk),
                         **({"left_parent": str(old_parent.pk)}
                            if member.pk == task.pk and old_parent else {})},
                extra_meta={"from_lane_id": str(from_lane.pk), "to_lane_id": str(target.pk),
                            "from_board_id": str(from_board.pk)},
                also_boards=(from_board.pk,),
            )
            if needs_rebalance:
                _schedule_rebalance(target)
        if old_parent is not None:
            _follow_next_owner(old_parent)
    task.refresh_from_db()
    return task


# ---------- the inbox ----------

def inbox_board() -> Board:
    """The one inbox, made on first use: a board with a single lane where
    quick notes wait to be given a board."""
    board = Board.objects.filter(kind="inbox", archived_at__isnull=True).first()
    if board:
        return board
    with transaction.atomic():
        slug = "inbox"
        n = 2
        while Board.objects.filter(slug=slug).exists():
            slug = f"inbox-{n}"
            n += 1
        board = Board.objects.create(name="Inbox", slug=slug, kind="inbox")
        Lane.objects.create(board=board, name="Inbox", order=0, color="#94a3b8")
    return board


def _set_location(task: Task, category: Category, row, raw) -> dict | None:
    """A location category's place ({lat, lng, label}); None clears it."""
    old = row.data if row else None
    if raw is None or raw == "":
        new = None
    else:
        try:
            new = measures.clean_location(raw)
        except measures.MeasureError as exc:
            raise ServiceError(f"{category.name}: {exc}") from None
    if old == new:
        return None
    if new is None:
        row.delete()
    elif row:
        row.data = new
        row.save(update_fields=["data", "updated_at"])
    else:
        TaskValue.objects.filter(task=task, category=category).delete()  # an old other-type row
        TaskValue.objects.create(task=task, category=category, value_type=measures.LOCATION,
                                 amount=0, data=new)
    label = lambda d: None if d is None else (d.get("label") or f"{d['lat']}, {d['lng']}")
    return {"name": category.name, "type": measures.LOCATION, "from": label(old), "to": label(new)}


# ---------- log entries ----------

COMMENT_MAX = 10_000


def _comment_payload(comment: TaskComment) -> dict:
    return {"id": str(comment.pk), "body": comment.body[:300],
            "about": str(comment.about_id) if comment.about_id else None,
            "happened_at": comment.happened_at.isoformat() if comment.happened_at else None}


CLOCK_SKEW = timedelta(minutes=5)


def _clean_happened_at(raw):
    """An ISO 8601 moment (any offset; naive = server time) that isn't in
    the future. None means "now"."""
    if raw in (None, ""):
        return None
    from datetime import datetime as _dt
    try:
        when = _dt.fromisoformat(str(raw).replace("Z", "+00:00"))
    except ValueError:
        raise ServiceError("that isn’t a date and time") from None
    if timezone.is_naive(when):
        when = timezone.make_aware(when)
    if when > timezone.now() + CLOCK_SKEW:
        raise ServiceError("a log entry can’t be in the future")
    return when


def _clean_about(about):
    if about is not None and about.archived_at is not None:
        raise ServiceError(f"{about.name} has been removed")
    return about


def add_comment(task: Task, body: str, *, about=None, happened_at=None, actor="anonymous",
                source=Source.API, op_id="") -> TaskComment:
    body = (body or "").strip()
    if not body:
        raise ServiceError("write something first")
    if len(body) > COMMENT_MAX:
        raise ServiceError("that entry is too long")
    when = _clean_happened_at(happened_at)
    with transaction.atomic():
        comment = TaskComment.objects.create(task=task, body=body, about=_clean_about(about),
                                             actor=actor or "anonymous",
                                             **({"happened_at": when} if when else {}))
        _record(task, TaskEvent.EventType.UPDATED, actor=actor, source=source, op_id=op_id,
                payload={"comment": _comment_payload(comment), "action": "added"},
                extra_meta={"changed_fields": ["comments"]})
    return comment


def edit_comment(comment: TaskComment, *, body=..., about=..., happened_at=..., actor="anonymous",
                 source=Source.API, op_id="") -> TaskComment:
    before = _comment_payload(comment)
    changed = []
    if happened_at is not ...:
        when = _clean_happened_at(happened_at) or comment.created_at
        if when != comment.happened_at:
            comment.happened_at = when
            changed.append("happened_at")
    if body is not ...:
        body = (body or "").strip()
        if not body:
            raise ServiceError("an entry can’t be empty (remove it instead)")
        if len(body) > COMMENT_MAX:
            raise ServiceError("that entry is too long")
        if body != comment.body:
            comment.body = body
            changed.append("body")
    if about is not ...:
        if (about.pk if about else None) != comment.about_id:
            comment.about = _clean_about(about)
            changed.append("about")
    if not changed:
        return comment
    with transaction.atomic():
        comment.edited_at = timezone.now()
        comment.save(update_fields=changed + ["edited_at"])
        _record(comment.task, TaskEvent.EventType.UPDATED, actor=actor, source=source, op_id=op_id,
                payload={"comment": _comment_payload(comment), "action": "edited", "before": before},
                extra_meta={"changed_fields": ["comments"]})
    return comment


def delete_comment(comment: TaskComment, *, restore=False, actor="anonymous",
                   source=Source.API, op_id="") -> TaskComment:
    """Soft delete (restore=True brings it back)."""
    if (comment.deleted_at is None) != restore:
        with transaction.atomic():
            comment.deleted_at = None if restore else timezone.now()
            comment.save(update_fields=["deleted_at"])
            _record(comment.task, TaskEvent.EventType.UPDATED, actor=actor, source=source,
                    op_id=op_id,
                    payload={"comment": _comment_payload(comment),
                             "action": "restored" if restore else "removed"},
                    extra_meta={"changed_fields": ["comments"]})
    return comment


def used_owner_ids(board_ids) -> list[str]:
    """Owners of any task on these boards (not binned), most recently
    active first: the board's shortlist in owner pickers."""
    from django.db.models import Max as _Max
    rows = (
        Task.owners.through.objects
        .filter(task__board_id__in=board_ids, task__deleted_at__isnull=True,
                owner__archived_at__isnull=True)
        .values("owner_id")
        .annotate(last=_Max("task__updated_at"))
        .order_by("-last")
    )
    return [str(r["owner_id"]) for r in rows]


def archive_task(task: Task, *, actor="anonymous", source=Source.API,
                 animation="", op_id="") -> Task:
    if task.archived_at is not None:
        return task
    with transaction.atomic():
        was_resolved = _is_resolved(task)
        task.archived_at = timezone.now()
        task.save(update_fields=["archived_at", "updated_at"])
        archived = _record(
            task, TaskEvent.EventType.ARCHIVED,
            actor=actor, source=source,
            animation=_clean_animation(task.board, animation), op_id=op_id,
            from_lane=task.lane,
        )
        if not was_resolved:
            with _caused_by(archived):
                _ripple_block_state(task, became_resolved=True, actor=actor)
    return task


def delete_task(task: Task, *, actor="anonymous", source=Source.API,
                animation="", op_id="") -> Task:
    """Soft delete: into the bin, restorable. From the board it behaves like
    archiving (blocks lift, it leaves the lane); from the archive it just
    moves to the bin."""
    if task.deleted_at is not None:
        return task
    with transaction.atomic():
        was_open = task.archived_at is None
        was_resolved = _is_resolved(task)
        now = timezone.now()
        if was_open:
            task.archived_at = now
        task.deleted_at = now
        task.save(update_fields=["archived_at", "deleted_at", "updated_at"])
        deleted = _record(
            task, TaskEvent.EventType.DELETED,
            actor=actor, source=source,
            animation=_clean_animation(task.board, animation), op_id=op_id,
            from_lane=task.lane,
            payload={"from": "board" if was_open else "archive"},
        )
        if was_open and not was_resolved:
            with _caused_by(deleted):
                _ripple_block_state(task, became_resolved=True, actor=actor)
    return task


def restore_task(task: Task, *, actor="anonymous", source=Source.API,
                 animation="", op_id="") -> Task:
    """Back onto the board, at the bottom of the lane it left from."""
    if task.archived_at is None:
        return task
    with transaction.atomic():
        was = "bin" if task.deleted_at is not None else "archive"
        if task.lane.archived_at is not None:
            # Its lane was removed while it was away: the board's first lane.
            task.lane = _active_lanes(task.board).first()
            task.lane_entered_at = timezone.now()
        position, needs_rebalance = _position_for_index(task.lane, None, exclude=task)
        task.archived_at = None
        task.deleted_at = None
        task.position = position
        task.save(update_fields=["archived_at", "deleted_at", "position", "lane",
                                 "lane_entered_at", "updated_at"])
        restored = _record(
            task, TaskEvent.EventType.RESTORED,
            actor=actor, source=source,
            animation=_clean_animation(task.board, animation), op_id=op_id,
            to_lane=task.lane,
            payload={"from": was},
        )
        if not _is_resolved(task):
            with _caused_by(restored):
                _ripple_block_state(task, became_resolved=False, actor=actor)
        if needs_rebalance:
            _schedule_rebalance(task.lane)
    return task


def archive_lane(lane: Lane, *, actor="anonymous", source=Source.API,
                 op_id="") -> list[Task]:
    """Archive every task the lane shows — its own and those of descendant
    boards mapped onto it (the "clear Done" sweep). Each task gets its own
    audit row; all share the caller's op_id."""
    from .family import lanes_shown_in
    tasks = list(
        Task.objects.filter(lane_id__in=lanes_shown_in(lane), archived_at__isnull=True)
        .order_by("position")
    )
    with transaction.atomic():
        for task in tasks:
            archive_task(task, actor=actor, source=source, op_id=op_id)
    return tasks


def _blocks_path(start, goal) -> bool:
    """Is `goal` reachable from `start` by following "blocks" links?"""
    seen, frontier = set(), {start}
    while frontier:
        if goal in frontier:
            return True
        seen |= frontier
        frontier = set(
            TaskLink.objects.filter(link_type=TaskLink.LinkType.BLOCKS, from_task_id__in=frontier)
            .values_list("to_task_id", flat=True)
        ) - seen
    return False


def link_tasks(from_task: Task, to_task: Task, link_type: str, *, actor="anonymous",
               source=Source.API, animation="", op_id="") -> TaskLink:
    if from_task.pk == to_task.pk:
        raise ServiceError("a task cannot link to itself")
    if from_task.board_id != to_task.board_id:
        raise ServiceError("cross-board links are not supported yet")
    if link_type not in TaskLink.LinkType.values:
        raise ServiceError(f"unknown link type: {link_type}")
    if link_type == TaskLink.LinkType.BLOCKS and _blocks_path(to_task.pk, from_task.pk):
        raise ServiceError(
            f"“{to_task.title}” already comes before “{from_task.title}”, so that would make a loop"
        )
    with transaction.atomic():
        link, created = TaskLink.objects.get_or_create(
            from_task=from_task, to_task=to_task, link_type=link_type
        )
        if created:
            payload = {"link_id": str(link.pk), "link_type": link_type,
                       "from_task_id": str(from_task.pk), "to_task_id": str(to_task.pk)}
            animation = _clean_animation(from_task.board, animation)
            # Both endpoints' cards change (e.g. blocked badges) — emit an
            # audit row and broadcast for each.
            for task in (from_task, to_task):
                _record(
                    task, TaskEvent.EventType.LINKED,
                    actor=actor, source=source, animation=animation, op_id=op_id,
                    payload=payload,
                )
    return link


def unlink_tasks(link: TaskLink, *, actor="anonymous", source=Source.API,
                 animation="", op_id="") -> None:
    with transaction.atomic():
        payload = {"link_id": str(link.pk), "link_type": link.link_type,
                   "from_task_id": str(link.from_task_id),
                   "to_task_id": str(link.to_task_id)}
        from_task, to_task = link.from_task, link.to_task
        link.delete()
        animation = _clean_animation(from_task.board, animation)
        for task in (from_task, to_task):
            _record(
                task, TaskEvent.EventType.UNLINKED,
                actor=actor, source=source, animation=animation, op_id=op_id,
                payload=payload,
            )


def _attachment_payload(attachment: Attachment, action: str) -> dict:
    return {"attachment": {"id": str(attachment.pk), "kind": attachment.kind,
                           "label": attachment.label, "data": attachment.data},
            "action": action}


def add_attachment(task: Task, kind: str, data, *, label="", actor="anonymous",
                   source=Source.API, animation="", op_id="") -> Attachment:
    if kind == "file":
        raise ServiceError("upload files with POST /api/tasks/<id>/files/")
    try:
        cleaned = attachments.clean(kind, data)
    except attachments.AttachmentError as exc:
        raise ServiceError(str(exc)) from None
    with transaction.atomic():
        last = task.attachments.filter(archived_at__isnull=True).aggregate(
            Max("position"))["position__max"]
        attachment = Attachment.objects.create(
            task=task, kind=kind, label=str(label or "")[:200], data=cleaned,
            position=(last or 0) + POSITION_GAP,
        )
        _record(
            task, TaskEvent.EventType.UPDATED,
            actor=actor, source=source,
            animation=_clean_animation(task.board, animation), op_id=op_id,
            payload=_attachment_payload(attachment, "added"),
            extra_meta={"changed_fields": ["attachments"]},
        )
    return attachment


def add_file(task: Task, uploaded, *, label="", actor="anonymous", source=Source.API,
             animation="", op_id="") -> Attachment:
    """A photo or file on a task (kind "file"): stored, thumbnailed if an
    image, and recorded like any attachment."""
    from . import uploads
    try:
        data, raw = uploads.describe(uploaded)
        data = attachments.clean("file", data)
    except (uploads.UploadError, attachments.AttachmentError) as exc:
        raise ServiceError(str(exc)) from None
    with transaction.atomic():
        last = task.attachments.filter(archived_at__isnull=True).aggregate(
            Max("position"))["position__max"]
        attachment = Attachment(task=task, kind="file", label=str(label or "")[:200], data=data,
                                position=(last or 0) + POSITION_GAP)
        uploads.store(attachment, raw)
        _record(
            task, TaskEvent.EventType.UPDATED,
            actor=actor, source=source,
            animation=_clean_animation(task.board, animation), op_id=op_id,
            payload=_attachment_payload(attachment, "added"),
            extra_meta={"changed_fields": ["attachments"]},
        )
    return attachment


def update_attachment(attachment: Attachment, *, data=None, label=None,
                      actor="anonymous", source=Source.API, animation="",
                      op_id="") -> Attachment:
    """Replace the data and/or label; the kind is fixed once attached."""
    before = {"label": attachment.label, "data": attachment.data}
    if data is not None:
        try:
            attachment.data = attachments.clean(attachment.kind, data)
        except attachments.AttachmentError as exc:
            raise ServiceError(str(exc)) from None
    if label is not None:
        attachment.label = str(label)[:200]
    after = {"label": attachment.label, "data": attachment.data}
    if after == before:
        return attachment
    with transaction.atomic():
        attachment.save(update_fields=["data", "label", "updated_at"])
        payload = _attachment_payload(attachment, "edited")
        payload["before"] = before
        _record(
            attachment.task, TaskEvent.EventType.UPDATED,
            actor=actor, source=source,
            animation=_clean_animation(attachment.task.board, animation), op_id=op_id,
            payload=payload,
            extra_meta={"changed_fields": ["attachments"]},
        )
    return attachment


def remove_attachment(attachment: Attachment, *, actor="anonymous", source=Source.API,
                      animation="", op_id="") -> None:
    """Soft delete: the row stays for the audit trail."""
    if attachment.archived_at is not None:
        return
    with transaction.atomic():
        attachment.archived_at = timezone.now()
        attachment.save(update_fields=["archived_at", "updated_at"])
        _record(
            attachment.task, TaskEvent.EventType.UPDATED,
            actor=actor, source=source,
            animation=_clean_animation(attachment.task.board, animation), op_id=op_id,
            payload=_attachment_payload(attachment, "removed"),
            extra_meta={"changed_fields": ["attachments"]},
        )


def _is_resolved(task: Task) -> bool:
    """Resolved = archived or sitting in a final ("done") lane. Resolved
    blockers stop blocking."""
    return task.archived_at is not None or task.lane.is_final


def _active_blockers(task: Task, *, exclude: Task | None = None):
    return [
        link.from_task
        for link in task.links_in.filter(
            link_type=TaskLink.LinkType.BLOCKS
        ).select_related("from_task__lane")
        if not _is_resolved(link.from_task)
        and (exclude is None or link.from_task.pk != exclude.pk)
    ]


def _ripple_block_state(blocker: Task, *, became_resolved: bool, actor: str) -> None:
    """When a blocker crosses the board's final lane (either direction) or is
    archived, every task whose blocked state flips gets an audited, broadcast
    task.updated — so blocked badges update live and the unblock announces
    itself (pulse on unblock, alarm on re-block)."""
    links = blocker.links_out.filter(
        link_type=TaskLink.LinkType.BLOCKS
    ).select_related("to_task__lane", "to_task__board")
    for link in links:
        blocked = link.to_task
        if blocked.archived_at is not None:
            continue
        if _active_blockers(blocked, exclude=blocker):
            continue  # other live blockers — this task's state didn't flip
        key = "unblocked_by" if became_resolved else "reblocked_by"
        _record(
            blocked, TaskEvent.EventType.UPDATED,
            actor=actor, source=Source.SYSTEM,
            animation=_clean_animation(
                blocked.board, "pulse" if became_resolved else "alarm"
            ),
            payload={key: str(blocker.pk)},
            extra_meta={"changed_fields": ["blocked_by"], "unblocked": became_resolved},
        )


def _validate_parent(task: Task, parent: Task | None) -> None:
    if parent is None:
        return
    if parent.pk == task.pk:
        raise ServiceError("a task cannot be its own parent")
    if parent.board_id != task.board_id:
        raise ServiceError("parent task belongs to a different board")
    if any(ancestor.pk == task.pk for ancestor in parent.ancestors()):
        raise ServiceError("cannot create a subtask cycle")


def _schedule_rebalance(lane: Lane) -> None:
    positions = _rebalance_lane(lane)
    board_id = lane.board_id
    lane_id = lane.pk
    transaction.on_commit(
        lambda: events.broadcast_rebalance(board_id, lane_id, positions)
    )


def compute_analytics(board: Board) -> dict:
    """Flow metrics reconstructed from the audit trail: cycle time (create →
    first arrival in the final lane), throughput, and per-lane residency.
    Consecutive same-lane moves (reorders) are collapsed so they don't split
    residency spans."""
    lanes = list(board.lanes.all())
    final_ids = {lane.pk for lane in lanes if lane.is_final}
    now = timezone.now()

    events = board.events.filter(
        event_type__in=[TaskEvent.EventType.CREATED, TaskEvent.EventType.MOVED]
    ).order_by("task_id", "id").values("task_id", "to_lane_id", "created_at")

    arrivals = defaultdict(list)  # task_id -> [(lane_id, ts)] lane changes only
    for event in events:
        history = arrivals[event["task_id"]]
        if not history or history[-1][0] != event["to_lane_id"]:
            history.append((event["to_lane_id"], event["created_at"]))

    residency = defaultdict(list)  # lane_id -> completed span seconds
    cycle_times, completions = [], []
    for history in arrivals.values():
        done_at = None
        for (lane_id, entered), nxt in zip(history, history[1:] + [None]):
            if nxt is not None and lane_id is not None:
                residency[lane_id].append((nxt[1] - entered).total_seconds())
            if done_at is None and lane_id in final_ids:
                done_at = entered
        if done_at is not None:
            cycle_times.append((done_at - history[0][1]).total_seconds())
            completions.append(done_at)

    def percentile(values: list[float], p: float) -> float | None:
        if not values:
            return None
        return sorted(values)[round(p * (len(values) - 1))]

    def average(values: list[float]) -> float | None:
        return sum(values) / len(values) if values else None

    active_by_lane = defaultdict(int)
    for task in board.tasks.filter(archived_at__isnull=True).values("lane_id"):
        active_by_lane[task["lane_id"]] += 1

    return {
        "board_id": str(board.pk),
        "generated_at": now.isoformat(),
        "cycle_time": {
            "completed": len(cycle_times),
            "p50_seconds": percentile(cycle_times, 0.5),
            "p85_seconds": percentile(cycle_times, 0.85),
            "avg_seconds": average(cycle_times),
        },
        "throughput": {
            "last_7d": sum(1 for ts in completions if ts >= now - timedelta(days=7)),
            "last_30d": sum(1 for ts in completions if ts >= now - timedelta(days=30)),
        },
        "lanes": [
            {
                "lane_id": str(lane.pk),
                "name": lane.name,
                "active_tasks": active_by_lane[lane.pk],
                "avg_residency_seconds": average(residency[lane.pk]),
                "completed_spans": len(residency[lane.pk]),
            }
            for lane in lanes
        ],
    }


def compute_timeline(task: Task) -> list[dict]:
    """Reconstruct per-lane residency spans from the audit trail."""
    moves = list(
        task.events.filter(
            event_type__in=[TaskEvent.EventType.CREATED, TaskEvent.EventType.MOVED]
        ).order_by("id").select_related("to_lane")
    )
    spans = []
    for event, nxt in zip(moves, moves[1:] + [None]):
        entered = event.created_at
        left = nxt.created_at if nxt else (task.archived_at or None)
        end = left or timezone.now()
        spans.append({
            "lane_id": str(event.to_lane_id) if event.to_lane_id else None,
            "lane_name": event.to_lane.name if event.to_lane else None,
            "entered_at": entered.isoformat(),
            "left_at": left.isoformat() if left else None,
            "seconds": (end - entered).total_seconds(),
        })
    return spans


# ---------- owners (shared across boards) ----------

_COLOUR = re.compile(r"^#[0-9a-fA-F]{6}$")


def _clean_owner_fields(fields: dict) -> dict:
    cleaned = {}
    if "contacts" in fields:
        cleaned["contacts"] = _clean_contacts(fields["contacts"])
    for key in ("name", "code", "fg", "bg", "emoji"):
        if key not in fields:
            continue
        value = str(fields[key] or "").strip()
        if key == "name" and not value:
            raise ServiceError("name is required")
        if key == "name" and len(value) > 100:
            raise ServiceError("name is longer than 100 characters")
        if key == "code" and not 1 <= len(value) <= 5:
            raise ServiceError("code must be 1 to 5 characters")
        if key in ("fg", "bg") and not _COLOUR.match(value):
            raise ServiceError(f"{key} must be a colour like #1a2b3c")
        if key == "emoji" and len(value) > 16:
            raise ServiceError("emoji is too long")
        cleaned[key] = value.lower() if key in ("fg", "bg") else value
    return cleaned


CONTACT_KINDS = ("phone", "email", "link", "place")


def _clean_contacts(contacts) -> list[dict]:
    """An owner's ways to reach them: phone, email, website, address."""
    if not isinstance(contacts, list) or len(contacts) > 20:
        raise ServiceError("contacts must be a list of up to 20")
    out = []
    for c in contacts:
        kind = isinstance(c, dict) and c.get("kind")
        if kind not in CONTACT_KINDS:
            raise ServiceError("a contact is a phone, email, website or address")
        try:
            data = attachments.clean(kind, c.get("data") or {})
        except attachments.AttachmentError as exc:
            raise ServiceError(str(exc)) from None
        label = str(c.get("label") or "").strip()[:60]
        out.append({"kind": kind, "data": data, **({"label": label} if label else {})})
    return out


def create_owner(fields: dict) -> Owner:
    cleaned = _clean_owner_fields(fields)
    for required in ("name", "code"):
        if required not in cleaned:
            raise ServiceError(f"{required} is required")
    last = Owner.objects.aggregate(Max("position"))["position__max"]
    with transaction.atomic():
        owner = Owner.objects.create(position=(last or 0) + POSITION_GAP, **cleaned)
        transaction.on_commit(events.broadcast_owners)
    return owner


def update_owner(owner: Owner, fields: dict) -> Owner:
    cleaned = _clean_owner_fields(fields)
    changed = [k for k, v in cleaned.items() if getattr(owner, k) != v]
    if not changed:
        return owner
    with transaction.atomic():
        for key in changed:
            setattr(owner, key, cleaned[key])
        owner.save(update_fields=changed + ["updated_at"])
        transaction.on_commit(events.broadcast_owners)
    return owner


def archive_owner(owner: Owner) -> Owner:
    """Soft delete. Tasks keep the link (so history reads right); clients
    stop showing archived owners on cards and in pickers."""
    if owner.archived_at is not None:
        return owner
    with transaction.atomic():
        owner.archived_at = timezone.now()
        owner.save(update_fields=["archived_at", "updated_at"])
        transaction.on_commit(events.broadcast_owners)
    return owner


# ---------- categories (shared, or one board's) ----------

def _visible_categories(board_id):
    """Active categories a board can see: its own plus the shared ones.
    board_id None = the shared scope itself (every board sees it)."""
    from django.db.models import Q
    q = Q(board__isnull=True) if board_id is None else Q(board__isnull=True) | Q(board_id=board_id)
    return Category.objects.filter(q, archived_at__isnull=True)


def _check_category_name(name: str, board_id, *, exclude=None) -> str:
    name = (name or "").strip()
    if not name:
        raise ServiceError("name is required")
    if len(name) > 60:
        raise ServiceError("name is longer than 60 characters")
    clash = _visible_categories(board_id).filter(name__iexact=name)
    if board_id is None:
        # A shared name must not clash with any board's own category either.
        clash = Category.objects.filter(archived_at__isnull=True, name__iexact=name)
    if exclude is not None:
        clash = clash.exclude(pk=exclude.pk)
    if clash.exists():
        raise ServiceError(f"there's already a category called {clash.first().name}")
    return name


def _check_colour(value) -> str:
    value = str(value or "").strip()
    if not _COLOUR.match(value):
        raise ServiceError("color must be a colour like #1a2b3c")
    return value.lower()


def _check_value_type(value_type, config) -> tuple[str, dict]:
    try:
        return measures.clean_type(value_type, config or {})
    except measures.MeasureError as exc:
        raise ServiceError(str(exc)) from None


def create_category(name: str, *, board: Board | None, color="#6366f1",
                    value_type="", value_config=None) -> Category:
    name = _check_category_name(name, board.pk if board else None)
    value_type, value_config = _check_value_type(value_type, value_config)
    last = Category.objects.aggregate(Max("position"))["position__max"]
    with transaction.atomic():
        category = Category.objects.create(
            board=board, name=name, color=_check_colour(color),
            position=(last or 0) + POSITION_GAP,
            value_type=value_type, value_config=value_config,
        )
        transaction.on_commit(lambda: events.broadcast_category(category))
    return category


def update_category(category: Category, fields: dict) -> Category:
    """Rename, recolour, or change scope ("board_id": null to share it; a
    board id to make it that board's own — refused while other boards'
    tasks use it)."""
    changed = []
    board_id = category.board_id
    if "board_id" in fields:
        new_board = fields["board_id"]
        new_board_id = None if new_board in (None, "") else new_board
        if str(new_board_id) != str(board_id):
            if new_board_id is not None:
                board = Board.objects.filter(pk=new_board_id).first()
                if board is None:
                    raise ServiceError("unknown board")
                elsewhere = category.tasks.exclude(board=board).exists()
                if elsewhere:
                    raise ServiceError(
                        "other boards' tasks use this category; it has to stay shared")
                new_board_id = board.pk
            board_id = new_board_id
            category.board_id = board_id
            changed.append("board")
    if "name" in fields or "board" in changed:
        name = _check_category_name(fields.get("name", category.name), board_id,
                                    exclude=category)
        if name != category.name:
            category.name = name
            changed.append("name")
    if "color" in fields:
        color = _check_colour(fields["color"])
        if color != category.color:
            category.color = color
            changed.append("color")
    if "value_type" in fields or "value_config" in fields:
        value_type, value_config = _check_value_type(
            fields.get("value_type", category.value_type),
            fields.get("value_config", category.value_config),
        )
        if value_type != category.value_type:
            category.value_type = value_type
            changed.append("value_type")
        if value_config != category.value_config:
            category.value_config = value_config
            changed.append("value_config")
    if not changed:
        return category
    with transaction.atomic():
        category.save(update_fields=changed + ["updated_at"])
        transaction.on_commit(lambda: events.broadcast_category(category))
    return category


def archive_category(category: Category) -> Category:
    """Soft delete: tasks keep the link for history; clients hide it."""
    if category.archived_at is not None:
        return category
    with transaction.atomic():
        category.archived_at = timezone.now()
        category.save(update_fields=["archived_at", "updated_at"])
        transaction.on_commit(lambda: events.broadcast_category(category))
    return category


# ---------- lanes (configurable per board; parents hold the superset) ----------

def _active_lanes(board: Board):
    return board.lanes.filter(archived_at__isnull=True).order_by("order")


def _lane_key(name: str) -> str:
    return name.strip().lower()


def _renumber(lanes) -> None:
    for i, lane in enumerate(lanes):
        if lane.order != i:
            lane.order = i
            lane.save(update_fields=["order"])


def _lanes_changed(board: Board) -> None:
    """Board (and, via fan-out, its ancestors) re-hydrate their lanes."""
    transaction.on_commit(lambda: events.broadcast(
        board.pk, {"type": "lanes.changed", "board_id": str(board.pk)}))


def _check_lane_fields(fields: dict) -> dict:
    cleaned = {}
    if "name" in fields:
        name = str(fields["name"] or "").strip()
        if not name:
            raise ServiceError("lane name is required")
        cleaned["name"] = name[:100]
    if "color" in fields:
        cleaned["color"] = _check_colour(fields["color"])
    if "wip_limit" in fields:
        wip = fields["wip_limit"]
        if wip in (None, ""):
            cleaned["wip_limit"] = None
        elif isinstance(wip, int) and not isinstance(wip, bool) and wip >= 0:
            cleaned["wip_limit"] = wip
        else:
            raise ServiceError("wip_limit must be a non-negative whole number")
    if "is_final" in fields:
        cleaned["is_final"] = bool(fields["is_final"])
    return cleaned


def _sync_up(board: Board) -> None:
    """Parents hold the superset of their sub-boards' lanes: give every
    ancestor any lane (by name) this board has and it lacks. A new lane goes
    after the nearest lane that precedes it here and exists there (else
    before the nearest following one, else at the end) — except final lanes,
    which go after the parent's last final lane — carrying its colour and
    final flag."""
    child = board
    parent = board.parent
    seen = {board.pk}
    while parent is not None and parent.pk not in seen and parent.archived_at is None:
        seen.add(parent.pk)
        theirs = list(_active_lanes(parent))
        names = {_lane_key(l.name) for l in theirs}
        mine = list(_active_lanes(child))
        added = False
        for i, lane in enumerate(mine):
            if _lane_key(lane.name) in names:
                continue
            by_key = {_lane_key(l.name): l for l in theirs}
            before = next((by_key[_lane_key(m.name)] for m in reversed(mine[:i])
                           if _lane_key(m.name) in by_key), None)
            after = next((by_key[_lane_key(m.name)] for m in mine[i + 1:]
                          if _lane_key(m.name) in by_key), None)
            finals = [j for j, l in enumerate(theirs) if l.is_final]
            if lane.is_final:
                # done-type lanes gather at the end, after the parent's own
                at = finals[-1] + 1 if finals else len(theirs)
            else:
                at = (theirs.index(before) + 1 if before is not None
                      else theirs.index(after) if after is not None else len(theirs))
            new = Lane.objects.create(board=parent, name=lane.name, color=lane.color,
                                      is_final=lane.is_final, order=len(theirs))
            theirs.insert(at, new)
            names.add(_lane_key(lane.name))
            added = True
        if added:
            _renumber(theirs)
            _lanes_changed(parent)
        child, parent = parent, parent.parent


def sync_family_lanes() -> None:
    """Bring every board family into the superset shape (deepest first)."""
    from .family import ancestor_ids
    boards = sorted(Board.objects.filter(archived_at__isnull=True),
                    key=lambda b: -len(ancestor_ids(b.pk)))
    with transaction.atomic():
        for board in boards:
            _sync_up(board)


def _descendant_boards_with_lane(lane: Lane) -> list[Board]:
    from .family import descendants
    key = _lane_key(lane.name)
    return [b for b in descendants(lane.board)
            if any(_lane_key(l.name) == key for l in _active_lanes(b))]


def create_lane(board: Board, fields: dict, *, index: int | None = None) -> Lane:
    cleaned = _check_lane_fields({"color": "#6b7280", **fields})
    if "name" not in cleaned:
        raise ServiceError("lane name is required")
    lanes = list(_active_lanes(board))
    if any(_lane_key(l.name) == _lane_key(cleaned["name"]) for l in lanes):
        raise ServiceError(f"there's already a lane called {cleaned['name']}")
    with transaction.atomic():
        lane = Lane.objects.create(board=board, order=len(lanes), **cleaned)
        at = len(lanes) if index is None else max(0, min(int(index), len(lanes)))
        lanes.insert(at, lane)
        _renumber(lanes)
        _sync_up(board)
        _lanes_changed(board)
    return lane


class LaneUsedBelowError(ServiceError):
    """The lane also exists on sub-boards (by name)."""

    def __init__(self, message, boards):
        self.boards = boards
        super().__init__(message)


def update_lane(lane: Lane, fields: dict, *, cascade: bool = False) -> Lane:
    """Rename / recolour / WIP limit / final flag. Renaming a lane that
    sub-boards also have needs `cascade` (it renames theirs too), or the
    parent would stop holding their lane."""
    cleaned = _check_lane_fields(fields)
    board = lane.board
    renaming = "name" in cleaned and cleaned["name"] != lane.name
    below = []
    if renaming:
        key = _lane_key(cleaned["name"])
        if key != _lane_key(lane.name) and any(
                _lane_key(l.name) == key for l in _active_lanes(board).exclude(pk=lane.pk)):
            raise ServiceError(f"there's already a lane called {cleaned['name']}")
        below = _descendant_boards_with_lane(lane)
        if below and not cascade:
            raise LaneUsedBelowError(
                f"{', '.join(b.name for b in below)} also "
                f"{'have' if len(below) > 1 else 'has'} this lane", below)
    with transaction.atomic():
        old_key = _lane_key(lane.name)
        for key, value in cleaned.items():
            setattr(lane, key, value)
        lane.save()
        for sub in below:
            for other in _active_lanes(sub):
                if _lane_key(other.name) == old_key:
                    other.name = cleaned["name"]
                    other.save(update_fields=["name"])
                    _lanes_changed(sub)
        _sync_up(board)
        _lanes_changed(board)
    return lane


def reorder_lanes(board: Board, lane_ids: list) -> list[Lane]:
    lanes = list(_active_lanes(board))
    by_id = {str(l.pk): l for l in lanes}
    if sorted(map(str, lane_ids)) != sorted(by_id):
        raise ServiceError("lane_ids must list each of the board's lanes once")
    ordered = [by_id[str(i)] for i in lane_ids]
    with transaction.atomic():
        _renumber(ordered)
        _lanes_changed(board)
    return ordered


def remove_lane(lane: Lane, *, move_to: Lane | None = None, actor="anonymous",
                source=Source.API) -> None:
    """Hide a lane. Its open tasks move to `move_to` first (required when it
    has any). Refused while sub-boards still have the lane, or if it's the
    board's last lane."""
    board = lane.board
    if lane.archived_at is not None:
        return
    lanes = list(_active_lanes(board))
    if len(lanes) <= 1:
        raise ServiceError("a board needs at least one lane")
    below = _descendant_boards_with_lane(lane)
    if below:
        raise LaneUsedBelowError(
            f"{', '.join(b.name for b in below)} still "
            f"{'have' if len(below) > 1 else 'has'} this lane; remove it there first", below)
    open_tasks = list(_active_tasks(lane))
    if open_tasks:
        if move_to is None:
            raise ServiceError(f"{len(open_tasks)} open task{'s' if len(open_tasks) != 1 else ''} "
                               "here: choose a lane to move them to")
        if move_to.board_id != board.pk or move_to.archived_at is not None or move_to.pk == lane.pk:
            raise ServiceError("move them to another lane on this board")
    with transaction.atomic():
        for task in open_tasks:
            move_task(task, move_to, None, actor=actor, source=source)
        lane.archived_at = timezone.now()
        lane.save(update_fields=["archived_at"])
        _renumber([l for l in lanes if l.pk != lane.pk])
        _lanes_changed(board)


def reorder_categories(category_ids: list) -> None:
    """Priority order, highest first: the top category a card has sets its
    colour in "colour by category". Positions are global, so each board's
    visible list (shared + its own) keeps this relative order."""
    ids = [str(i) for i in category_ids]
    categories = {str(c.pk): c for c in Category.objects.filter(pk__in=ids)}
    if len(categories) != len(set(ids)):
        raise ServiceError("unknown category id")
    with transaction.atomic():
        for i, cid in enumerate(ids):
            category = categories[cid]
            position = (i + 1) * POSITION_GAP
            if category.position != position:
                category.position = position
                category.save(update_fields=["position", "updated_at"])
                transaction.on_commit(lambda c=category: events.broadcast_category(c))
