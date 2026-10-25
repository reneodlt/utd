import json

from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncJsonWebsocketConsumer
from django.utils import timezone

from .events import SHARED_GROUP, board_group
from .models import Board, Lane, Source, Task


class BoardConsumer(AsyncJsonWebsocketConsumer):
    """One connection per open board. Joins the board's channel group and
    forwards every broadcast envelope verbatim. Also accepts a small set of
    inbound commands so pure-websocket scripts can drive the board, though
    the frontend mutates via REST."""

    async def connect(self):
        self.board_id = self.scope["url_route"]["kwargs"]["board_id"]
        exists, last_event_id = await self._board_state(self.board_id)
        if not exists:
            await self.close(code=4404)
            return
        await self.channel_layer.group_add(board_group(self.board_id), self.channel_name)
        await self.channel_layer.group_add(SHARED_GROUP, self.channel_name)
        await self.accept()
        await self.send_json({
            "type": "sync.hello",
            "board_id": str(self.board_id),
            "last_event_id": last_event_id,
            "ts": timezone.now().isoformat(),
        })

    async def disconnect(self, code):
        if hasattr(self, "board_id"):
            await self.channel_layer.group_discard(
                board_group(self.board_id), self.channel_name
            )
            await self.channel_layer.group_discard(SHARED_GROUP, self.channel_name)

    async def receive_json(self, content, **kwargs):
        msg_type = content.get("type")
        if msg_type == "ping":
            await self.send_json({"type": "pong", "ts": timezone.now().isoformat()})
        elif msg_type == "task.move":
            await self._handle_move(content)
        else:
            await self._error(f"unknown message type: {msg_type}", content)

    async def receive(self, text_data=None, bytes_data=None, **kwargs):
        try:
            await super().receive(text_data=text_data, bytes_data=bytes_data, **kwargs)
        except json.JSONDecodeError:
            await self.send_json({"type": "error", "detail": "invalid JSON", "meta": {}})

    async def _handle_move(self, content):
        meta = content.get("meta") or {}
        try:
            await self._move_task(
                task_id=content.get("task_id"),
                to_lane_id=content.get("to_lane_id"),
                index=content.get("index"),
                actor=str(meta.get("actor") or "anonymous")[:200],
                animation=str(meta.get("animation") or "")[:50],
                op_id=str(meta.get("op_id") or "")[:64],
            )
        except Exception as exc:  # surfaced to the caller, connection stays up
            from .services import SubtaskBlockedError

            extra = {}
            if isinstance(exc, SubtaskBlockedError):
                extra = {
                    "code": "subtask_block",
                    "blocking_task_ids": [str(t.pk) for t in exc.blockers],
                }
            await self._error(str(exc), content, **extra)

    async def _error(self, detail, content, **extra):
        meta = content.get("meta") or {}
        await self.send_json({
            "type": "error",
            "detail": detail,
            "meta": {"op_id": meta.get("op_id", "")},
            **extra,
        })

    # Group handler: services broadcast {"type": "board.event", "message": envelope}
    async def board_event(self, event):
        await self.send_json(event["message"])

    @database_sync_to_async
    def _board_state(self, board_id):
        board = Board.objects.filter(pk=board_id).first()
        if board is None:
            return False, 0
        from .family import family_ids
        from .models import TaskEvent
        last = (
            TaskEvent.objects.filter(board_id__in=family_ids(board)).order_by("-id")
            .values_list("id", flat=True).first()
        )
        return True, last or 0

    @database_sync_to_async
    def _move_task(self, *, task_id, to_lane_id, index, actor, animation, op_id):
        from . import services

        task = Task.objects.get(pk=task_id, board_id=self.board_id,
                                archived_at__isnull=True)
        lane = Lane.objects.get(pk=to_lane_id, board_id=self.board_id, archived_at__isnull=True)
        if index is not None and not isinstance(index, int):
            raise services.ServiceError("index must be an integer")
        services.move_task(
            task, lane, index,
            actor=actor, source=Source.API, animation=animation, op_id=op_id,
        )
