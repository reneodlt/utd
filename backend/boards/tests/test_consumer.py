from channels.db import database_sync_to_async
from channels.testing import WebsocketCommunicator
from django.test import TransactionTestCase

from boards import services
from boards.models import Board, Lane, Task
from utd.asgi import application


class ConsumerTests(TransactionTestCase):
    """TransactionTestCase so transaction.on_commit broadcast hooks fire."""

    async def _connect(self, board_id):
        communicator = WebsocketCommunicator(application, f"/ws/boards/{board_id}/")
        connected, _ = await communicator.connect()
        assert connected
        hello = await communicator.receive_json_from()
        assert hello["type"] == "sync.hello"
        return communicator

    @database_sync_to_async
    def _make_board(self):
        board = Board.objects.create(
            name="B", slug="b",
            animation_catalogue={"enabled": ["pulse"], "default": "slide"},
        )
        backlog = Lane.objects.create(board=board, name="Backlog", order=0)
        doing = Lane.objects.create(board=board, name="Doing", order=1)
        return board, backlog, doing

    async def test_rejects_unknown_board(self):
        communicator = WebsocketCommunicator(
            application, "/ws/boards/00000000-0000-0000-0000-000000000000/"
        )
        connected, code = await communicator.connect()
        self.assertFalse(connected)

    async def test_service_mutation_broadcasts(self):
        board, backlog, doing = await self._make_board()
        communicator = await self._connect(board.pk)
        try:
            task = await database_sync_to_async(services.create_task)(
                board, backlog, "hello", actor="test", animation="pulse"
            )
            message = await communicator.receive_json_from()
            self.assertEqual(message["type"], "task.created")
            self.assertEqual(message["task"]["title"], "hello")
            self.assertEqual(message["meta"]["actor"], "test")
            self.assertEqual(message["meta"]["animation"], "pulse")

            await database_sync_to_async(services.move_task)(
                task, doing, 0, actor="test", op_id="op-1"
            )
            message = await communicator.receive_json_from()
            self.assertEqual(message["type"], "task.moved")
            self.assertEqual(message["meta"]["op_id"], "op-1")
            self.assertEqual(message["meta"]["from_lane_id"], str(backlog.pk))
            self.assertEqual(message["meta"]["to_lane_id"], str(doing.pk))
        finally:
            await communicator.disconnect()

    async def test_inbound_move_via_websocket(self):
        board, backlog, doing = await self._make_board()
        task = await database_sync_to_async(services.create_task)(
            board, backlog, "t"
        )
        communicator = await self._connect(board.pk)
        try:
            await communicator.send_json_to({
                "type": "task.move",
                "task_id": str(task.pk),
                "to_lane_id": str(doing.pk),
                "index": 0,
                "meta": {"op_id": "ws-op", "actor": "script"},
            })
            message = await communicator.receive_json_from()
            self.assertEqual(message["type"], "task.moved")
            self.assertEqual(message["meta"]["op_id"], "ws-op")
            lane_id = await database_sync_to_async(
                lambda: Task.objects.get(pk=task.pk).lane_id
            )()
            self.assertEqual(lane_id, doing.pk)
        finally:
            await communicator.disconnect()

    async def test_ping_pong_and_unknown_type(self):
        board, *_ = await self._make_board()
        communicator = await self._connect(board.pk)
        try:
            await communicator.send_json_to({"type": "ping"})
            self.assertEqual((await communicator.receive_json_from())["type"], "pong")
            await communicator.send_json_to({"type": "nonsense"})
            self.assertEqual((await communicator.receive_json_from())["type"], "error")
        finally:
            await communicator.disconnect()
