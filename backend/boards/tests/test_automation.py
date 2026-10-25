from datetime import timedelta

from django.utils import timezone
from rest_framework.test import APITestCase

from boards import automation, services
from boards.models import AutomationRule, Board, Category, Lane, Owner, RuleRun, TaskLink


def make(name="B", slug="b", parent=None):
    board = Board.objects.create(name=name, slug=slug, parent=parent,
                                 animation_catalogue={"enabled": ["celebrate", "pulse"], "default": "slide"})
    lanes = {n: Lane.objects.create(board=board, name=n, order=i, is_final=(n == "Done"))
             for i, n in enumerate(["Backlog", "Doing", "Review", "Done"])}
    return board, lanes


class AutomationEngineTests(APITestCase):
    def setUp(self):
        self.board, self.lanes = make()
        self.rich = Owner.objects.create(name="Rich", code="RG")

    def rule(self, trigger, actions, conditions=(), board=None, **extra):
        return automation.save_rule(board or self.board, {
            "name": extra.pop("name", f"r{AutomationRule.objects.count()}"),
            "trigger": trigger, "conditions": list(conditions), "actions": actions, **extra,
        })

    def test_final_lane_trigger_follows_whichever_lane_is_final(self):
        self.rule({"when": "moved", "final": True}, [{"type": "set_animation", "name": "celebrate"}])
        t = services.create_task(self.board, self.lanes["Backlog"], "t")
        services.move_task(t, self.lanes["Review"], None)
        self.assertEqual(t.events.order_by("id").last().animation, "")
        self.lanes["Review"].is_final = True
        self.lanes["Review"].save()
        services.move_task(t, self.lanes["Doing"], None)
        services.move_task(t, self.lanes["Review"], None)
        self.assertEqual(t.events.order_by("id").last().animation, "celebrate")

    def test_subtasks_done_moves_parent_and_one_hop_celebrates(self):
        self.rule({"when": "subtasks_done"}, [{"type": "move", "final": True}], name="finish-parent")
        self.rule({"when": "moved", "final": True}, [{"type": "set_animation", "name": "celebrate"}],
                  name="celebrate")
        parent = services.create_task(self.board, self.lanes["Doing"], "Parent")
        a = services.create_task(self.board, self.lanes["Doing"], "A", parent=parent)
        b = services.create_task(self.board, self.lanes["Doing"], "B", parent=parent)
        services.move_task(a, self.lanes["Done"], None)
        parent.refresh_from_db()
        self.assertEqual(parent.lane, self.lanes["Doing"])  # B still open
        services.archive_task(b)  # the last one finishes (archived)
        parent.refresh_from_db()
        self.assertEqual(parent.lane, self.lanes["Done"])
        move = parent.events.order_by("id").last()
        self.assertEqual((move.actor, move.animation), ("rule:finish-parent", "celebrate"))

    def test_conditions(self):
        bug = services.create_category("Bug", board=self.board)
        self.rule({"when": "created"}, [{"type": "set_due", "days": 1}],
                  conditions=[{"type": "has_category", "category": str(bug.pk), "negate": True},
                              {"type": "title_contains", "text": "call"}, {"type": "by_person"}])
        hit = services.create_task(self.board, self.lanes["Backlog"], "Call Jim")
        miss = services.create_task(self.board, self.lanes["Backlog"], "Write docs")
        hit.refresh_from_db(), miss.refresh_from_db()
        self.assertEqual(hit.due_date, timezone.localdate() + timedelta(days=1))
        self.assertIsNone(miss.due_date)

    def test_actions_categories_owners_subtasks_archive(self):
        ux = services.create_category("UX", board=None)
        self.rule({"when": "moved", "lane": str(self.lanes["Review"].pk)}, [
            {"type": "add_category", "category": str(ux.pk)},
            {"type": "owners", "mode": "add", "owners": [str(self.rich.pk)]},
            {"type": "create_subtasks", "items": [{"title": "Check copy", "due_days": 2}, {"title": "Check links"}]},
        ])
        self.rule({"when": "moved", "lane": str(self.lanes["Backlog"].pk)}, [{"type": "archive"}],
                  conditions=[{"type": "title_contains", "text": "junk"}])
        t = services.create_task(self.board, self.lanes["Doing"], "Page")
        services.move_task(t, self.lanes["Review"], None)
        self.assertEqual([c.name for c in t.categories.all()], ["UX"])
        self.assertEqual([o.name for o in t.owners.all()], ["Rich"])
        subs = {s.title: s for s in t.subtasks.all()}
        self.assertEqual(sorted(subs), ["Check copy", "Check links"])
        self.assertEqual(subs["Check copy"].due_date, timezone.localdate() + timedelta(days=2))
        junk = services.create_task(self.board, self.lanes["Doing"], "junk mail")
        services.move_task(junk, self.lanes["Backlog"], None)
        junk.refresh_from_db()
        self.assertIsNotNone(junk.archived_at)

    def test_unblocked_trigger(self):
        self.rule({"when": "unblocked"}, [{"type": "move", "lane": str(self.lanes["Doing"].pk)}])
        blocker = services.create_task(self.board, self.lanes["Doing"], "Blocker")
        waiting = services.create_task(self.board, self.lanes["Backlog"], "Waiting")
        services.link_tasks(blocker, waiting, TaskLink.LinkType.BLOCKS)
        services.move_task(blocker, self.lanes["Done"], None)
        waiting.refresh_from_db()
        self.assertEqual(waiting.lane, self.lanes["Doing"])

    def test_family_scope_matches_sub_board_lanes_by_name(self):
        child, child_lanes = make("Child", "child", parent=self.board)
        self.rule({"when": "moved", "lane": str(self.lanes["Review"].pk)},
                  [{"type": "create_subtasks", "items": [{"title": "Review it"}]}], scope="family")
        self.rule({"when": "moved", "lane": str(self.lanes["Review"].pk)},
                  [{"type": "set_due", "days": 0}], name="board-only")
        t = services.create_task(child, child_lanes["Doing"], "Sub-board task")
        services.move_task(t, child_lanes["Review"], None)
        t.refresh_from_db()
        self.assertEqual([s.title for s in t.subtasks.all()], ["Review it"])
        self.assertIsNone(t.due_date)  # board-only rule didn't reach the sub-board

    def test_runs_logged_with_failures_and_problems_flagged(self):
        rule = self.rule({"when": "created"}, [{"type": "move", "lane": str(self.lanes["Doing"].pk)}])
        self.lanes["Doing"].archived_at = timezone.now()
        self.lanes["Doing"].save()
        t = services.create_task(self.board, self.lanes["Backlog"], "t")  # must not raise
        run = RuleRun.objects.get(rule=rule)
        self.assertEqual(run.task, t)
        self.assertIn("lane", run.error)
        self.assertTrue(automation.problems(rule))

    def test_validation(self):
        other, other_lanes = make("Other", "other")
        cases = [
            {"when": "moved", "lane": str(other_lanes["Doing"].pk)},  # another board's lane
            {"when": "exploded"},
        ]
        for trigger in cases:
            with self.assertRaises(automation.RuleError):
                self.rule(trigger, [{"type": "archive"}])
        with self.assertRaises(automation.RuleError):
            self.rule({"when": "created"}, [])
        with self.assertRaises(automation.RuleError):
            self.rule({"when": "created"}, [{"type": "set_animation", "name": "fireworks"}])
        self.rule({"when": "created"}, [{"type": "archive"}], name="same")
        with self.assertRaises(automation.RuleError):
            self.rule({"when": "created"}, [{"type": "archive"}], name="SAME")

    def test_api_crud_runs_and_inherited(self):
        child, _ = make("Child", "child", parent=self.board)
        r = self.client.post(f"/api/boards/{self.board.pk}/rules/", {
            "name": "tidy", "scope": "family", "trigger": {"when": "archived"},
            "actions": [{"type": "set_due", "days": None}]}, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        rule_id = r.json()["id"]
        bad = self.client.post(f"/api/boards/{self.board.pk}/rules/", {
            "name": "x", "trigger": {"when": "nope"}, "actions": []}, format="json")
        self.assertEqual(bad.status_code, 400)
        listed = self.client.get(f"/api/boards/{child.pk}/rules/").json()
        self.assertEqual([(x["name"], x["inherited"]) for x in listed], [("tidy", True)])
        self.client.patch(f"/api/rules/{rule_id}/", {"enabled": False}, format="json")
        self.assertFalse(AutomationRule.objects.get(pk=rule_id).enabled)
        self.client.patch(f"/api/rules/{rule_id}/", {"archived": True}, format="json")
        self.assertEqual(self.client.get(f"/api/boards/{self.board.pk}/rules/").json(), [])
        self.client.patch(f"/api/rules/{rule_id}/", {"archived": False, "enabled": True}, format="json")
        t = services.create_task(self.board, self.lanes["Backlog"], "t")
        services.archive_task(t)
        runs = self.client.get(f"/api/rules/{rule_id}/runs/").json()
        self.assertEqual([x["task_title"] for x in runs["runs"]], ["t"])
        self.assertEqual(self.client.get(f"/api/boards/{self.board.pk}/rules/").json()[0]["runs"], 1)
