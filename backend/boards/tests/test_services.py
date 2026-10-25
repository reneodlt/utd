from django.test import TestCase

from boards import services
from boards.models import (
    POSITION_GAP,
    Board,
    Lane,
    Source,
    Task,
    TaskEvent,
    TaskLink,
)


def make_board():
    board = Board.objects.create(
        name="B", slug="b",
        animation_catalogue={"enabled": ["pulse", "celebrate"], "default": "slide"},
    )
    backlog = Lane.objects.create(board=board, name="Backlog", order=0)
    doing = Lane.objects.create(board=board, name="Doing", order=1)
    return board, backlog, doing


class CreateTaskTests(TestCase):
    def setUp(self):
        self.board, self.backlog, self.doing = make_board()

    def test_create_appends_and_audits(self):
        t1 = services.create_task(self.board, self.backlog, "one", actor="rich")
        t2 = services.create_task(self.board, self.backlog, "two")
        self.assertEqual(t1.position, POSITION_GAP)
        self.assertEqual(t2.position, 2 * POSITION_GAP)
        event = t1.events.get()
        self.assertEqual(event.event_type, TaskEvent.EventType.CREATED)
        self.assertEqual(event.actor, "rich")
        self.assertEqual(event.to_lane, self.backlog)

    def test_create_at_index_zero(self):
        services.create_task(self.board, self.backlog, "one")
        t2 = services.create_task(self.board, self.backlog, "two", index=0)
        self.assertEqual(t2.position, 0.0)  # first - GAP

    def test_unknown_animation_dropped(self):
        task = services.create_task(self.board, self.backlog, "t", animation="explode")
        self.assertEqual(task.events.get().animation, "")

    def test_known_animation_kept(self):
        task = services.create_task(self.board, self.backlog, "t", animation="celebrate")
        self.assertEqual(task.events.get().animation, "celebrate")

    def test_lane_board_mismatch(self):
        other = Board.objects.create(name="X", slug="x")
        with self.assertRaises(services.ServiceError):
            services.create_task(other, self.backlog, "t")


class MoveTaskTests(TestCase):
    def setUp(self):
        self.board, self.backlog, self.doing = make_board()
        self.tasks = [
            services.create_task(self.board, self.backlog, f"t{i}") for i in range(3)
        ]

    def test_move_between_lanes_updates_lane_entered_at(self):
        task = self.tasks[0]
        before = task.lane_entered_at
        services.move_task(task, self.doing, 0, actor="mover")
        task.refresh_from_db()
        self.assertEqual(task.lane, self.doing)
        self.assertGreater(task.lane_entered_at, before)
        event = task.events.order_by("-id").first()
        self.assertEqual(event.event_type, TaskEvent.EventType.MOVED)
        self.assertEqual(event.from_lane, self.backlog)
        self.assertEqual(event.to_lane, self.doing)

    def test_move_within_lane_computes_midpoint(self):
        # move t2 (last) between t0 and t1
        services.move_task(self.tasks[2], self.backlog, 1)
        self.tasks[2].refresh_from_db()
        self.assertEqual(self.tasks[2].position, 1.5 * POSITION_GAP)

    def test_index_clamped(self):
        services.move_task(self.tasks[0], self.doing, 999)
        services.move_task(self.tasks[1], self.doing, -5)
        order = list(
            Task.objects.filter(lane=self.doing).order_by("position")
            .values_list("title", flat=True)
        )
        self.assertEqual(order, ["t1", "t0"])

    def test_same_lane_move_excludes_self_from_index_math(self):
        # moving t0 to index 2 in a 3-task lane = end of [t1, t2]
        services.move_task(self.tasks[0], self.backlog, 2)
        order = list(
            self.backlog.tasks.order_by("position").values_list("title", flat=True)
        )
        self.assertEqual(order, ["t1", "t2", "t0"])

    def test_repeated_midpoint_insertion_triggers_rebalance(self):
        for _ in range(60):
            services.move_task(self.tasks[2], self.backlog, 1)
        positions = list(self.backlog.tasks.order_by("position")
                         .values_list("position", flat=True))
        self.assertEqual(len(positions), 3)
        # after a rebalance, gaps are healthy again
        self.assertGreater(positions[1] - positions[0], 1.0)
        self.assertGreater(positions[2] - positions[1], 1.0)

    def test_cross_board_move_rejected(self):
        other_board = Board.objects.create(name="X", slug="x")
        other_lane = Lane.objects.create(board=other_board, name="L", order=0)
        with self.assertRaises(services.ServiceError):
            services.move_task(self.tasks[0], other_lane, 0)

    def test_archived_task_cannot_move(self):
        services.archive_task(self.tasks[0])
        with self.assertRaises(services.ServiceError):
            services.move_task(self.tasks[0], self.doing, 0)


class SubtaskMoveRuleTests(TestCase):
    """A parent may never sit to the right of its active subtasks."""

    def setUp(self):
        self.board, self.backlog, self.doing = make_board()
        self.done = Lane.objects.create(board=self.board, name="Done", order=2, is_final=True)
        self.parent = services.create_task(self.board, self.backlog, "parent")
        self.child = services.create_task(
            self.board, self.backlog, "child", parent=self.parent
        )

    def test_parent_blocked_by_left_subtask(self):
        services.move_task(self.child, self.doing, 0)  # child → order 1
        with self.assertRaises(services.SubtaskBlockedError) as ctx:
            services.move_task(self.parent, self.done, 0)  # parent → order 2
        self.assertEqual([t.pk for t in ctx.exception.blockers], [self.child.pk])
        self.parent.refresh_from_db()
        self.assertEqual(self.parent.lane, self.backlog)

    def test_parent_may_join_subtask_lane(self):
        services.move_task(self.child, self.doing, 0)
        services.move_task(self.parent, self.doing, 0)  # same order — allowed
        self.parent.refresh_from_db()
        self.assertEqual(self.parent.lane, self.doing)

    def test_parent_moves_freely_once_subtasks_are_ahead(self):
        services.move_task(self.child, self.done, 0)
        services.move_task(self.parent, self.doing, 0)
        self.parent.refresh_from_db()
        self.assertEqual(self.parent.lane, self.doing)

    def test_archived_subtasks_do_not_block(self):
        services.archive_task(self.child)
        services.move_task(self.parent, self.done, 0)
        self.parent.refresh_from_db()
        self.assertEqual(self.parent.lane, self.done)

    def test_childless_task_unaffected(self):
        solo = services.create_task(self.board, self.backlog, "solo")
        services.move_task(solo, self.done, 0)
        solo.refresh_from_db()
        self.assertEqual(solo.lane, self.done)


class UpdateAndArchiveTests(TestCase):
    def setUp(self):
        self.board, self.backlog, _ = make_board()
        self.task = services.create_task(self.board, self.backlog, "t")

    def test_update_records_changed_fields(self):
        services.update_task(self.task, {"title": "new", "description": "d"})
        event = self.task.events.order_by("-id").first()
        self.assertEqual(event.event_type, TaskEvent.EventType.UPDATED)
        self.assertEqual(set(event.payload["changed_fields"]), {"title", "description"})

    def test_noop_update_writes_no_event(self):
        count = TaskEvent.objects.count()
        services.update_task(self.task, {"title": "t"})
        self.assertEqual(TaskEvent.objects.count(), count)

    def test_unknown_field_rejected(self):
        with self.assertRaises(services.ServiceError):
            services.update_task(self.task, {"position": 1})

    def test_archive_is_idempotent(self):
        services.archive_task(self.task)
        first = self.task.archived_at
        services.archive_task(self.task)
        self.task.refresh_from_db()
        self.assertEqual(self.task.archived_at, first)
        self.assertEqual(
            self.task.events.filter(event_type=TaskEvent.EventType.ARCHIVED).count(), 1
        )


class HierarchyAndLinkTests(TestCase):
    def setUp(self):
        self.board, self.backlog, _ = make_board()
        self.a = services.create_task(self.board, self.backlog, "a")
        self.b = services.create_task(self.board, self.backlog, "b", parent=self.a)
        self.c = services.create_task(self.board, self.backlog, "c", parent=self.b)

    def test_cycle_rejected(self):
        with self.assertRaises(services.ServiceError):
            services.update_task(self.a, {}, parent=self.c)

    def test_self_parent_rejected(self):
        with self.assertRaises(services.ServiceError):
            services.update_task(self.a, {}, parent=self.a)

    def test_link_dedup_and_audit_both_ends(self):
        services.link_tasks(self.a, self.c, TaskLink.LinkType.BLOCKS, actor="rich")
        services.link_tasks(self.a, self.c, TaskLink.LinkType.BLOCKS)
        self.assertEqual(TaskLink.objects.count(), 1)
        for task in (self.a, self.c):
            self.assertEqual(
                task.events.filter(event_type=TaskEvent.EventType.LINKED).count(), 1
            )

    def test_self_link_rejected(self):
        with self.assertRaises(services.ServiceError):
            services.link_tasks(self.a, self.a, TaskLink.LinkType.RELATES_TO)

    def test_blocks_loop_rejected(self):
        services.link_tasks(self.a, self.b, TaskLink.LinkType.BLOCKS)
        services.link_tasks(self.b, self.c, TaskLink.LinkType.BLOCKS)
        with self.assertRaises(services.ServiceError):
            services.link_tasks(self.c, self.a, TaskLink.LinkType.BLOCKS)
        with self.assertRaises(services.ServiceError):
            services.link_tasks(self.b, self.a, TaskLink.LinkType.BLOCKS)
        # other kinds of link don't order anything
        services.link_tasks(self.c, self.a, TaskLink.LinkType.RELATES_TO)
        self.assertEqual(TaskLink.objects.count(), 3)

    def test_unlink_audits_both_ends(self):
        link = services.link_tasks(self.a, self.c, TaskLink.LinkType.BLOCKS)
        services.unlink_tasks(link)
        self.assertEqual(TaskLink.objects.count(), 0)
        for task in (self.a, self.c):
            self.assertEqual(
                task.events.filter(event_type=TaskEvent.EventType.UNLINKED).count(), 1
            )


class UnblockRippleTests(TestCase):
    """Blocking is flow-aware: blockers in the final lane (or archived) stop
    blocking, and the state flip is audited + broadcast on the blocked task."""

    def setUp(self):
        self.board, self.backlog, self.doing = make_board()
        self.done = Lane.objects.create(board=self.board, name="Done", order=2, is_final=True)
        self.blocker = services.create_task(self.board, self.backlog, "blocker")
        self.blocked = services.create_task(self.board, self.backlog, "blocked")
        services.link_tasks(self.blocker, self.blocked, TaskLink.LinkType.BLOCKS)

    def ripple_events(self):
        return self.blocked.events.filter(
            event_type=TaskEvent.EventType.UPDATED,
            payload__has_key="unblocked_by",
        )

    def test_blocker_reaching_final_lane_unblocks(self):
        services.move_task(self.blocker, self.done, 0, actor="ci")
        event = self.ripple_events().get()
        self.assertEqual(event.payload["unblocked_by"], str(self.blocker.pk))
        self.assertEqual(event.source, Source.SYSTEM)
        self.assertEqual(event.actor, "ci")
        self.assertEqual(event.animation, "pulse")

    def test_intermediate_move_does_not_ripple(self):
        services.move_task(self.blocker, self.doing, 0)
        self.assertEqual(self.ripple_events().count(), 0)

    def test_blocker_leaving_final_lane_reblocks(self):
        services.move_task(self.blocker, self.done, 0)
        services.move_task(self.blocker, self.doing, 0)
        reblock = self.blocked.events.filter(
            event_type=TaskEvent.EventType.UPDATED,
            payload__has_key="reblocked_by",
        ).get()
        self.assertEqual(reblock.animation, "")  # alarm not in this catalogue
        self.assertEqual(reblock.payload["reblocked_by"], str(self.blocker.pk))

    def test_archiving_blocker_unblocks(self):
        services.archive_task(self.blocker)
        self.assertEqual(self.ripple_events().count(), 1)

    def test_no_ripple_while_second_blocker_active(self):
        other = services.create_task(self.board, self.backlog, "other-blocker")
        services.link_tasks(other, self.blocked, TaskLink.LinkType.BLOCKS)
        services.move_task(self.blocker, self.done, 0)
        self.assertEqual(self.ripple_events().count(), 0)
        services.move_task(other, self.done, 0)
        self.assertEqual(self.ripple_events().count(), 1)


class AnalyticsTests(TestCase):
    def setUp(self):
        self.board, self.backlog, self.doing = make_board()
        self.done = Lane.objects.create(board=self.board, name="Done", order=2, is_final=True)

    def test_empty_board(self):
        analytics = services.compute_analytics(self.board)
        self.assertEqual(analytics["cycle_time"]["completed"], 0)
        self.assertIsNone(analytics["cycle_time"]["p50_seconds"])
        self.assertEqual(analytics["throughput"]["last_7d"], 0)
        self.assertEqual(len(analytics["lanes"]), 3)

    def test_cycle_and_throughput_counting(self):
        finished = services.create_task(self.board, self.backlog, "finished")
        services.move_task(finished, self.doing, 0)
        services.move_task(finished, self.done, 0)
        wip = services.create_task(self.board, self.backlog, "wip")
        services.move_task(wip, self.doing, 0)

        analytics = services.compute_analytics(self.board)
        self.assertEqual(analytics["cycle_time"]["completed"], 1)
        self.assertGreaterEqual(analytics["cycle_time"]["p50_seconds"], 0)
        self.assertEqual(analytics["throughput"]["last_7d"], 1)
        by_name = {l["name"]: l for l in analytics["lanes"]}
        self.assertEqual(by_name["Backlog"]["active_tasks"], 0)
        self.assertEqual(by_name["Doing"]["active_tasks"], 1)
        self.assertEqual(by_name["Done"]["active_tasks"], 1)
        # finished: Backlog + Doing spans; wip: Backlog span
        self.assertEqual(by_name["Backlog"]["completed_spans"], 2)
        self.assertEqual(by_name["Doing"]["completed_spans"], 1)

    def test_reorders_do_not_split_residency(self):
        task = services.create_task(self.board, self.backlog, "t")
        services.create_task(self.board, self.backlog, "other")
        services.move_task(task, self.backlog, 1)  # same-lane reorder
        services.move_task(task, self.done, 0)
        analytics = services.compute_analytics(self.board)
        by_name = {l["name"]: l for l in analytics["lanes"]}
        self.assertEqual(by_name["Backlog"]["completed_spans"], 1)


class TimelineTests(TestCase):
    def setUp(self):
        self.board, self.backlog, self.doing = make_board()

    def test_timeline_spans_follow_moves(self):
        task = services.create_task(self.board, self.backlog, "t")
        services.move_task(task, self.doing, 0)
        services.move_task(task, self.backlog, 0)
        timeline = services.compute_timeline(task)
        self.assertEqual([s["lane_name"] for s in timeline],
                         ["Backlog", "Doing", "Backlog"])
        self.assertIsNone(timeline[-1]["left_at"])
        self.assertIsNotNone(timeline[0]["left_at"])
        for span in timeline:
            self.assertGreaterEqual(span["seconds"], 0)


class SourceChoiceTests(TestCase):
    def test_source_values(self):
        self.assertEqual(
            set(Source.values), {"ui", "api", "system", "admin"}
        )
