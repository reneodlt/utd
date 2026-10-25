from decimal import Decimal

from django.test import TestCase
from rest_framework.test import APITestCase

from boards import rollup, services
from boards.models import Board, Category, Lane, TaskEvent, TaskValue


def make_board():
    board = Board.objects.create(name="B", slug="b")
    backlog = Lane.objects.create(board=board, name="Backlog", order=0)
    done = Lane.objects.create(board=board, name="Done", order=1, is_final=True)
    return board, backlog, done


class ValueTests(TestCase):
    def setUp(self):
        self.board, self.backlog, self.done = make_board()
        self.labour = services.create_category("Labour", board=None, value_type="money")
        self.time = services.create_category("Design time", board=self.board,
                                              value_type="duration")
        self.plain = services.create_category("Bug", board=self.board)
        self.task = services.create_task(self.board, self.backlog, "Fence")
        services.update_task(self.task, {}, categories=[self.labour, self.time, self.plain])

    def test_set_change_clear_audited(self):
        services.update_task(self.task, {}, values={self.labour: "200.456", self.time: 90})
        self.assertEqual(self.task.values.get(category=self.labour).amount, Decimal("200.46"))
        self.assertEqual(self.task.values.get(category=self.time).amount, Decimal("90"))
        services.update_task(self.task, {}, values={self.labour: None})
        self.assertFalse(self.task.values.filter(category=self.labour).exists())
        events = self.task.events.filter(event_type=TaskEvent.EventType.UPDATED).order_by("id")
        last = events.last().payload["changes"]["values"][str(self.labour.pk)]
        self.assertEqual((last["from"], last["to"], last["name"]), ("200.46", None, "Labour"))

    def test_unchanged_value_records_nothing(self):
        services.update_task(self.task, {}, values={self.labour: 10})
        before = self.task.events.count()
        services.update_task(self.task, {}, values={self.labour: "10.00"})
        self.assertEqual(self.task.events.count(), before)

    def test_refusals(self):
        other = services.create_category("Materials", board=None, value_type="money")
        pct = services.create_category("Done %", board=None, value_type="percent")
        cases = [
            {other: 5},              # not one of the task's categories
            {self.plain: 5},         # category takes no figure
            {self.labour: "lots"},   # not a number
            {self.time: -5},         # negative time
        ]
        services.update_task(self.task, {}, categories=[self.labour, self.time, self.plain, pct])
        cases.append({pct: 150})
        for values in cases:
            with self.assertRaises(services.ServiceError):
                services.update_task(self.task, {}, values=values)

    def test_type_change_hides_old_figures(self):
        services.update_task(self.task, {}, values={self.labour: 50})
        services.update_category(self.labour, {"value_type": "duration"})
        from boards.serializers import TaskSerializer
        self.assertEqual(TaskSerializer(self.task).data["values"], {})
        services.update_category(self.labour, {"value_type": "money"})
        self.assertEqual(TaskSerializer(self.task).data["values"], {str(self.labour.pk): 50.0})

    def test_category_config_checked(self):
        with self.assertRaises(services.ServiceError):
            services.create_category("X", board=None, value_type="money",
                                     value_config={"currency": "XYZ"})
        with self.assertRaises(services.ServiceError):
            services.create_category("Y", board=None, value_type="weight")
        c = services.create_category("Miles", board=None, value_type="number",
                                     value_config={"unit": "mi", "junk": 1})
        self.assertEqual(c.value_config, {"unit": "mi"})

    def test_archived_values_anchor_to_nearest_open_ancestor(self):
        child = services.create_task(self.board, self.backlog, "Posts", parent=self.task)
        grandchild = services.create_task(self.board, self.backlog, "Concrete", parent=child)
        orphan = services.create_task(self.board, self.backlog, "Loose")
        binned = services.create_task(self.board, self.backlog, "Binned", parent=self.task)
        for t in (grandchild, orphan, binned):
            services.update_task(t, {}, categories=[self.labour], values={self.labour: 10})
        services.archive_task(child)
        services.archive_task(grandchild)
        services.archive_task(orphan)
        services.delete_task(binned)
        got = {v["task_id"]: v["anchor_id"] for v in rollup.archived_values([self.board.pk])}
        self.assertEqual(got, {str(grandchild.pk): str(self.task.pk), str(orphan.pk): None})

    def test_category_off_task_drops_out_of_archived_values(self):
        services.update_task(self.task, {}, values={self.labour: 10})
        services.update_task(self.task, {}, categories=[self.time])
        services.archive_task(self.task)
        self.assertEqual(rollup.archived_values([self.board.pk]), [])
        self.assertTrue(TaskValue.objects.filter(task=self.task).exists())  # kept, hidden

    def test_change_after_done_keeps_estimate(self):
        services.update_task(self.task, {}, values={self.labour: 200})
        services.update_task(self.task, {}, values={self.labour: 220})  # still open: no split
        row = self.task.values.get(category=self.labour)
        self.assertIsNone(row.estimate)
        services.move_task(self.task, self.done, None)
        self.task.refresh_from_db()
        services.update_task(self.task, {}, values={self.labour: 250})
        row.refresh_from_db()
        self.assertEqual((row.amount, row.estimate), (Decimal("250"), Decimal("220")))
        # further changes move the actual, the estimate stays
        services.update_task(self.task, {}, values={self.labour: 260})
        row.refresh_from_db()
        self.assertEqual((row.amount, row.estimate), (Decimal("260"), Decimal("220")))
        last = self.task.events.order_by("id").last().payload["changes"]["values"]
        self.assertEqual(last[str(self.labour.pk)]["estimate"], "220")
        # back to the estimate: no split any more
        services.update_task(self.task, {}, values={self.labour: 220})
        row.refresh_from_db()
        self.assertIsNone(row.estimate)

    def test_archived_change_keeps_estimate_and_travels(self):
        services.update_task(self.task, {}, values={self.time: 60})
        services.archive_task(self.task)
        self.task.refresh_from_db()
        services.update_task(self.task, {}, values={self.time: 90})
        got = rollup.archived_values([self.board.pk])
        self.assertEqual([(v["amount"], v["estimate"], v["title"]) for v in got], [(90.0, 60.0, "Fence")])
        from boards.serializers import TaskSerializer
        self.assertEqual(TaskSerializer(self.task).data["estimates"], {str(self.time.pk): 60.0})

    def test_first_figure_after_done_has_no_estimate(self):
        services.move_task(self.task, self.done, None)
        self.task.refresh_from_db()
        services.update_task(self.task, {}, values={self.labour: 99})
        self.assertIsNone(self.task.values.get(category=self.labour).estimate)

    def test_hours_per_day_inherits(self):
        child = Board.objects.create(name="C", slug="c", parent=self.board)
        self.assertEqual(services.hours_per_day(child), 7.5)
        services.set_hours_per_day(self.board, 8)
        child.refresh_from_db()
        self.assertEqual(services.hours_per_day(child), 8.0)
        services.set_hours_per_day(child, "6.5")
        self.assertEqual(services.hours_per_day(child), 6.5)
        with self.assertRaises(services.ServiceError):
            services.set_hours_per_day(child, 30)
        services.set_hours_per_day(child, None)
        self.assertEqual(services.hours_per_day(child), 8.0)


class ValueApiTests(APITestCase):
    def setUp(self):
        self.board, self.backlog, self.done = make_board()
        self.cost = Category.objects.create(name="Cost", value_type="money",
                                            value_config={"currency": "GBP"})

    def test_create_with_category_and_value_then_patch(self):
        r = self.client.post(f"/api/boards/{self.board.pk}/tasks/", {
            "lane_id": str(self.backlog.pk), "title": "Buy timber",
            "category_ids": [str(self.cost.pk)], "values": {str(self.cost.pk): 45},
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        task = r.json()
        self.assertEqual(task["values"], {str(self.cost.pk): 45.0})
        r = self.client.patch(f"/api/tasks/{task['id']}/",
                              {"values": {str(self.cost.pk): "12.5"}}, format="json")
        self.assertEqual(r.json()["values"], {str(self.cost.pk): 12.5})
        r = self.client.patch(f"/api/tasks/{task['id']}/",
                              {"values": {str(self.cost.pk): "abc"}}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("Cost", r.json()["detail"])

    def test_bad_create_rolls_back(self):
        r = self.client.post(f"/api/boards/{self.board.pk}/tasks/", {
            "lane_id": str(self.backlog.pk), "title": "Nope",
            "values": {str(self.cost.pk): 45},  # not in the category
        }, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertEqual(self.board.tasks.count(), 0)

    def test_snapshot_and_board_carry_totals_inputs(self):
        snap = self.client.get(f"/api/boards/{self.board.pk}/snapshot/").json()
        self.assertEqual(snap["archived_values"], [])
        self.assertEqual(snap["board"]["hours_per_day"], 7.5)
        cat = snap["categories"][0]
        self.assertEqual((cat["value_type"], cat["value_config"]), ("money", {"currency": "GBP"}))
        r = self.client.patch(f"/api/boards/{self.board.pk}/", {"hours_per_day": 8},
                              format="json")
        self.assertEqual(r.json()["hours_per_day"], 8.0)
        r = self.client.get(f"/api/boards/{self.board.pk}/archived-values/")
        self.assertEqual(r.status_code, 200)
