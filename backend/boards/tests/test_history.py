"""Card history: what the audit trail records about why and how a task
changed, and the task events endpoint that the history panel reads."""

from rest_framework.test import APITestCase

from boards import services
from boards.models import AutomationRule, Board, Lane, TaskEvent, TaskLink


class HistoryTests(APITestCase):
    def setUp(self):
        self.board = Board.objects.create(
            name="B", slug="b",
            animation_catalogue={"enabled": ["pulse", "celebrate", "alarm"]},
        )
        self.backlog = Lane.objects.create(board=self.board, name="Backlog", order=0)
        self.review = Lane.objects.create(board=self.board, name="Review", order=1)
        self.done = Lane.objects.create(board=self.board, name="Done", order=2, is_final=True)

    def history(self, task, query=""):
        response = self.client.get(f"/api/tasks/{task.pk}/events/{query}")
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    def test_update_records_before_and_after(self):
        task = services.create_task(self.board, self.backlog, "old title")
        services.update_task(task, {"title": "new title", "description": "hi"}, actor="rich")
        event = task.events.get(event_type=TaskEvent.EventType.UPDATED)
        self.assertEqual(event.payload["changes"], {
            "title": {"from": "old title", "to": "new title"},
            "description": {"from": "", "to": "hi"},
        })
        self.assertEqual(event.payload["changed_fields"], ["title", "description"])

    def test_reparent_records_ids_and_skips_noop(self):
        parent = services.create_task(self.board, self.backlog, "parent")
        task = services.create_task(self.board, self.backlog, "child")
        services.update_task(task, {}, parent=parent)
        event = task.events.get(event_type=TaskEvent.EventType.UPDATED)
        self.assertEqual(event.payload["changes"]["parent"],
                         {"from": None, "to": str(parent.pk)})
        # Setting the same parent again is not a change.
        services.update_task(task, {}, parent=parent)
        self.assertEqual(task.events.filter(event_type=TaskEvent.EventType.UPDATED).count(), 1)

    def test_direct_events_have_no_cause(self):
        task = services.create_task(self.board, self.backlog, "t")
        services.move_task(task, self.review, 0)
        self.assertFalse(task.events.exclude(caused_by=None).exists())

    def test_rule_actions_point_at_their_trigger(self):
        AutomationRule.objects.create(
            board=self.board, name="review-checklist",
            trigger={"event": "task.moved", "to_lane": str(self.review.pk)},
            actions=[{"type": "create_subtask", "title": "Checklist"}],
        )
        task = services.create_task(self.board, self.backlog, "t")
        services.move_task(task, self.review, 0, actor="rich")
        trigger = task.events.get(event_type=TaskEvent.EventType.MOVED)
        subtask = task.subtasks.get()
        created = subtask.events.get(event_type=TaskEvent.EventType.CREATED)
        self.assertEqual(created.actor, "rule:review-checklist")
        self.assertEqual(created.caused_by, trigger)

    def test_unblock_ripple_points_at_blocker_move(self):
        blocker = services.create_task(self.board, self.backlog, "blocker")
        blocked = services.create_task(self.board, self.backlog, "blocked")
        services.link_tasks(blocker, blocked, TaskLink.LinkType.BLOCKS)
        services.move_task(blocker, self.done, 0, actor="ci")
        moved = blocker.events.get(event_type=TaskEvent.EventType.MOVED)
        ripple = blocked.events.filter(payload__has_key="unblocked_by").get()
        self.assertEqual(ripple.caused_by, moved)

    def test_archive_ripple_points_at_archive(self):
        blocker = services.create_task(self.board, self.backlog, "blocker")
        blocked = services.create_task(self.board, self.backlog, "blocked")
        services.link_tasks(blocker, blocked, TaskLink.LinkType.BLOCKS)
        services.archive_task(blocker)
        archived = blocker.events.get(event_type=TaskEvent.EventType.ARCHIVED)
        ripple = blocked.events.filter(payload__has_key="unblocked_by").get()
        self.assertEqual(ripple.caused_by, archived)

    def test_endpoint_shape(self):
        task = services.create_task(self.board, self.backlog, "t", actor="github-ci")
        services.move_task(task, self.review, 0, actor="rich")
        data = self.history(task)
        self.assertEqual(data["count"], 2)
        moved, created = data["results"]
        self.assertEqual(moved["event_type"], "task.moved")
        self.assertEqual(moved["from_lane_name"], "Backlog")
        self.assertEqual(moved["to_lane_name"], "Review")
        self.assertIsNone(moved["caused_by"])
        self.assertEqual(created["actor"], "github-ci")
        self.assertIsNone(created["from_lane_name"])
        self.assertEqual(data["related_tasks"][str(task.pk)]["title"], "t")

    def test_endpoint_summarises_cause(self):
        blocker = services.create_task(self.board, self.backlog, "blocker")
        blocked = services.create_task(self.board, self.backlog, "blocked")
        services.link_tasks(blocker, blocked, TaskLink.LinkType.BLOCKS)
        services.move_task(blocker, self.done, 0, actor="ci")
        ripple = self.history(blocked)["results"][0]
        self.assertEqual(ripple["payload"]["unblocked_by"], str(blocker.pk))
        self.assertEqual(ripple["caused_by"]["actor"], "ci")
        self.assertEqual(ripple["caused_by"]["event_type"], "task.moved")
        self.assertEqual(ripple["caused_by"]["to_lane_name"], "Done")
        self.assertEqual(ripple["caused_by"]["task_id"], str(blocker.pk))

    def test_related_tasks_include_archived_link_targets(self):
        a = services.create_task(self.board, self.backlog, "a")
        b = services.create_task(self.board, self.backlog, "b")
        services.link_tasks(a, b, TaskLink.LinkType.RELATES_TO)
        services.archive_task(b)
        related = self.history(a)["related_tasks"]
        self.assertEqual(related[str(b.pk)], {"title": "b", "archived": True, "parent_id": None})

    def test_include_subtasks_adds_their_creation_only(self):
        parent = services.create_task(self.board, self.backlog, "parent")
        child = services.create_task(self.board, self.backlog, "child", parent=parent)
        services.move_task(child, self.review, 0)
        plain = self.history(parent)
        self.assertEqual([e["task_id"] for e in plain["results"]], [str(parent.pk)])
        full = self.history(parent, "?include=subtasks")
        types = [(e["task_id"], e["event_type"]) for e in full["results"]]
        self.assertEqual(types, [
            (str(child.pk), "task.created"),
            (str(parent.pk), "task.created"),
        ])
        self.assertEqual(full["related_tasks"][str(child.pk)]["parent_id"], str(parent.pk))

    def test_archived_task_history_still_readable(self):
        task = services.create_task(self.board, self.backlog, "t")
        services.archive_task(task, actor="rich")
        data = self.history(task)
        self.assertEqual(data["results"][0]["event_type"], "task.archived")
        self.assertEqual(data["results"][0]["from_lane_name"], "Backlog")

    def test_query_count_is_flat(self):
        task = services.create_task(self.board, self.backlog, "t")
        for lane in (self.review, self.backlog, self.review, self.backlog):
            services.move_task(task, lane, 0)
        # task lookup, count, page, related titles — independent of event count
        with self.assertNumQueries(4):
            self.history(task)
