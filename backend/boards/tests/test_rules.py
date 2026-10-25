from django.test import TestCase

from boards import services
from boards.models import AutomationRule, Board, Lane, Task, TaskEvent


class RulesEngineTests(TestCase):
    def setUp(self):
        self.board = Board.objects.create(
            name="B", slug="b",
            animation_catalogue={"enabled": ["pulse", "celebrate"], "default": "slide"},
        )
        self.backlog = Lane.objects.create(board=self.board, name="Backlog", order=0)
        self.review = Lane.objects.create(board=self.board, name="Review", order=1)
        self.done = Lane.objects.create(board=self.board, name="Done", order=2, is_final=True)

    def rule(self, name, trigger, actions, enabled=True):
        return AutomationRule.objects.create(
            board=self.board, name=name, trigger=trigger, actions=actions,
            enabled=enabled,
        )

    def move_event(self, task):
        return task.events.filter(event_type=TaskEvent.EventType.MOVED).order_by("-id").first()

    def test_set_animation_on_matching_move(self):
        self.rule("celebrate-done",
                  {"event": "task.moved", "to_lane": str(self.done.pk)},
                  [{"type": "set_animation", "name": "celebrate"}])
        task = services.create_task(self.board, self.backlog, "t")
        services.move_task(task, self.done, 0)
        self.assertEqual(self.move_event(task).animation, "celebrate")

    def test_caller_animation_wins(self):
        self.rule("celebrate-done",
                  {"event": "task.moved", "to_lane": str(self.done.pk)},
                  [{"type": "set_animation", "name": "celebrate"}])
        task = services.create_task(self.board, self.backlog, "t")
        services.move_task(task, self.done, 0, animation="pulse")
        self.assertEqual(self.move_event(task).animation, "pulse")

    def test_non_matching_lane_ignored(self):
        self.rule("celebrate-done",
                  {"event": "task.moved", "to_lane": str(self.done.pk)},
                  [{"type": "set_animation", "name": "celebrate"}])
        task = services.create_task(self.board, self.backlog, "t")
        services.move_task(task, self.review, 0)
        self.assertEqual(self.move_event(task).animation, "")

    def test_disabled_rule_ignored(self):
        self.rule("celebrate-done",
                  {"event": "task.moved", "to_lane": str(self.done.pk)},
                  [{"type": "set_animation", "name": "celebrate"}], enabled=False)
        task = services.create_task(self.board, self.backlog, "t")
        services.move_task(task, self.done, 0)
        self.assertEqual(self.move_event(task).animation, "")

    def test_create_subtask_with_dedup(self):
        self.rule("review-checklist",
                  {"event": "task.moved", "to_lane": str(self.review.pk)},
                  [{"type": "create_subtask", "title": "Code review"}])
        task = services.create_task(self.board, self.backlog, "t")
        services.move_task(task, self.review, 0)
        subtask = task.subtasks.get()
        self.assertEqual(subtask.title, "Code review")
        create_event = subtask.events.get()
        self.assertEqual(create_event.actor, "rule:review-checklist")
        self.assertEqual(create_event.source, "system")
        # bounce out and back in — no duplicate while the subtask is active
        services.move_task(task, self.backlog, 0)
        services.move_task(task, self.review, 0)
        self.assertEqual(task.subtasks.count(), 1)

    def test_move_action_and_no_recursion(self):
        # rule moves anything arriving in Review straight to Done; the
        # rule-caused move must not re-trigger rules (actor guard).
        self.rule("skip-review",
                  {"event": "task.moved", "to_lane": str(self.review.pk)},
                  [{"type": "move_task", "to_lane": str(self.done.pk)}])
        task = services.create_task(self.board, self.backlog, "t")
        services.move_task(task, self.review, 0)
        task.refresh_from_db()
        self.assertEqual(task.lane, self.done)
        rule_moves = task.events.filter(actor="rule:skip-review").count()
        self.assertEqual(rule_moves, 1)

    def test_title_contains_filter(self):
        self.rule("deploy-celebrate",
                  {"event": "task.created", "title_contains": "deploy"},
                  [{"type": "set_animation", "name": "celebrate"}])
        match = services.create_task(self.board, self.backlog, "Deploy v2")
        other = services.create_task(self.board, self.backlog, "Write docs")
        self.assertEqual(match.events.get().animation, "celebrate")
        self.assertEqual(other.events.get().animation, "")

    def test_broken_action_does_not_break_mutation(self):
        self.rule("broken",
                  {"event": "task.moved", "to_lane": str(self.done.pk)},
                  [{"type": "move_task", "to_lane": "00000000-0000-0000-0000-000000000000"}])
        task = services.create_task(self.board, self.backlog, "t")
        services.move_task(task, self.done, 0)  # must not raise
        task.refresh_from_db()
        self.assertEqual(task.lane, self.done)

    def test_mutual_rules_capped_by_depth(self):
        # two rules that bounce a task between lanes would loop forever
        # without the guards; actor prefix stops it after the first hop.
        self.rule("to-done",
                  {"event": "task.moved", "to_lane": str(self.review.pk)},
                  [{"type": "move_task", "to_lane": str(self.done.pk)}])
        self.rule("to-review",
                  {"event": "task.moved", "to_lane": str(self.done.pk)},
                  [{"type": "move_task", "to_lane": str(self.review.pk)}])
        task = services.create_task(self.board, self.backlog, "t")
        services.move_task(task, self.review, 0)
        self.assertLess(Task.objects.get(pk=task.pk).events.count(), 10)
