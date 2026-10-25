"""Websocket envelope construction and broadcast.

Every mutation broadcast goes through broadcast_event(), scheduled by the
service layer via transaction.on_commit so clients never receive events for
rows that aren't yet visible.
"""

from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer

from .models import Task, TaskEvent
from .serializers import serialize_task


def board_group(board_id) -> str:
    return f"board_{board_id}"


# Things shared across boards (owners, shared categories): every board
# connection joins this group too.
SHARED_GROUP = "shared"


def build_envelope(event: TaskEvent, task: Task, extra_meta: dict | None = None) -> dict:
    meta = {
        "actor": event.actor,
        "source": event.source,
        "animation": event.animation,
        "op_id": event.op_id,
        "event_id": event.id,
        "ts": event.created_at.isoformat(),
    }
    if extra_meta:
        meta.update(extra_meta)
    return {
        "type": event.event_type,
        "board_id": str(event.board_id),
        "task": serialize_task(task),
        "meta": meta,
    }


def broadcast(board_id, message: dict) -> None:
    """To the board's group and every ancestor board's: parents show their
    descendants' tasks, so they need their events too."""
    from .family import ancestor_ids

    channel_layer = get_channel_layer()
    if channel_layer is None:
        return
    for target in [board_id, *ancestor_ids(board_id)]:
        _send(channel_layer, target, message)


def _send(channel_layer, board_id, message: dict) -> None:
    # Channels routes group messages by "type" with dots mapped to
    # underscores; wrap the client envelope so one consumer handler
    # ("board.event") forwards everything verbatim.
    async_to_sync(channel_layer.group_send)(
        board_group(board_id), {"type": "board.event", "message": message}
    )


def broadcast_event(event: TaskEvent, task: Task, extra_meta: dict | None = None,
                    also_boards=()) -> None:
    """To the task's board (and its ancestors), plus `also_boards` — e.g.
    the board a task just moved off, so it drops the card. Clients ignore
    an event id they've already seen."""
    envelope = build_envelope(event, task, extra_meta)
    broadcast(event.board_id, envelope)
    for board_id in also_boards:
        broadcast(board_id, envelope)


def broadcast_rebalance(board_id, lane_id, positions: dict[str, float]) -> None:
    broadcast(
        board_id,
        {
            "type": "lane.rebalanced",
            "board_id": str(board_id),
            "lane_id": str(lane_id),
            "positions": positions,
        },
    )


def broadcast_owners() -> None:
    """The full owner list, after any change to it (it is small)."""
    from .serializers import serialize_owners

    channel_layer = get_channel_layer()
    if channel_layer is None:
        return
    async_to_sync(channel_layer.group_send)(
        SHARED_GROUP,
        {"type": "board.event",
         "message": {"type": "owners.changed", "owners": serialize_owners()}},
    )


def broadcast_category(category) -> None:
    """One category, after it changes. It goes to every board; clients keep
    it only if it's shared or theirs (a scope change can move it out)."""
    from .serializers import CategorySerializer

    channel_layer = get_channel_layer()
    if channel_layer is None:
        return
    async_to_sync(channel_layer.group_send)(
        SHARED_GROUP,
        {"type": "board.event",
         "message": {"type": "category.changed",
                     "category": CategorySerializer(category).data}},
    )


def broadcast_boards_changed() -> None:
    """The board list or tree changed (create, rename, archive, re-parent):
    every client refetches the list and its board's family."""
    channel_layer = get_channel_layer()
    if channel_layer is None:
        return
    async_to_sync(channel_layer.group_send)(
        SHARED_GROUP, {"type": "board.event", "message": {"type": "boards.changed"}},
    )
