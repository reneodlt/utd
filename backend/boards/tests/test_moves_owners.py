from django.test import TestCase
from rest_framework.test import APITestCase

from boards import owner_log, services
from boards.models import Board, Category, Lane, Owner, TaskEvent, TaskLink


def board(name, slug, lanes=("Backlog", "Doing", "Done")):
    b = Board.objects.create(name=name, slug=slug)
    made = [Lane.objects.create(board=b, name=n, order=i, is_final=(n == "Done"))
            for i, n in enumerate(lanes)]
    return b, made


class MoveToBoardTests(TestCase):
    def setUp(self):
        self.a, (self.a_backlog, self.a_doing, self.a_done) = board("A", "a")
        self.b, (self.b_backlog, self.b_doing, self.b_done) = board("B", "b")
        self.parent = services.create_task(self.a, self.a_doing, "Parent")
        self.child = services.create_task(self.a, self.a_done, "Child", parent=self.parent)
        self.grand = services.create_task(self.a, self.a_backlog, "Grandchild", parent=self.child)

    def test_family_moves_to_same_named_lanes(self):
        services.move_to_board(self.parent, self.b, self.b_backlog)
        for t, lane in ((self.parent, self.b_backlog), (self.child, self.b_done),
                        (self.grand, self.b_backlog)):
            t.refresh_from_db()
            self.assertEqual((t.board_id, t.lane_id), (self.b.pk, lane.pk))
        self.child.refresh_from_db()
        self.assertEqual(self.child.parent_id, self.parent.pk)
        moved = self.parent.events.filter(event_type=TaskEvent.EventType.MOVED).order_by("id").last()
        self.assertEqual((moved.payload["from_board"], moved.payload["to_board"]), ("A", "B"))

    def test_subtask_alone_leaves_its_parent(self):
        services.move_to_board(self.grand, self.b)
        self.grand.refresh_from_db()
        self.assertIsNone(self.grand.parent_id)
        self.assertEqual(self.grand.lane_id, self.b_backlog.pk)

    def test_unknown_lane_name_goes_to_first_lane(self):
        c, (c_first, *_rest) = board("C", "c", lanes=("Ideas", "Shipped"))
        services.move_to_board(self.parent, c)
        self.parent.refresh_from_db()
        self.assertEqual(self.parent.lane_id, c_first.pk)

    def test_links_kept_board_categories_dropped(self):
        other = services.create_task(self.a, self.a_backlog, "Other")
        services.link_tasks(other, self.parent, TaskLink.LinkType.BLOCKS)
        mine = services.create_category("A only", board=self.a)
        shared = services.create_category("Shared", board=None)
        services.update_task(self.parent, {}, categories=[mine, shared])
        services.move_to_board(self.parent, self.b)
        self.assertTrue(TaskLink.objects.filter(from_task=other, to_task=self.parent).exists())
        self.assertEqual(list(self.parent.categories.all()), [shared])

    def test_refusals(self):
        services.archive_task(self.parent)
        with self.assertRaises(services.ServiceError):
            services.move_to_board(self.parent, self.b)
        other = services.create_task(self.a, self.a_backlog, "Other")
        with self.assertRaises(services.ServiceError):
            services.move_to_board(other, self.b, self.a_doing)  # lane from the wrong board


class OwnerFollowsNextTests(TestCase):
    def setUp(self):
        self.b, (self.backlog, self.doing, self.done) = board("B", "b")
        self.rich = Owner.objects.create(name="Rich", code="RG")
        self.jim = Owner.objects.create(name="Jim", code="JM")
        self.boss = Owner.objects.create(name="Boss", code="BS")
        self.parent = services.create_task(self.b, self.doing, "Parent")
        self.one = services.create_task(self.b, self.doing, "One", parent=self.parent)
        self.two = services.create_task(self.b, self.backlog, "Two", parent=self.parent)

    def owners(self, task):
        return sorted(o.name for o in task.owners.all())

    def test_follows_next_and_moves_on(self):
        services.update_task(self.two, {}, owners=[self.jim])
        services.update_task(self.one, {}, owners=[self.rich])  # One is next (further along)
        self.assertEqual(self.owners(self.parent), ["Rich"])
        services.move_task(self.one, self.done, None)  # One done: Two is next
        self.assertEqual(self.owners(self.parent), ["Jim"])
        auto = self.parent.events.filter(actor="auto").order_by("id").last()
        self.assertEqual(auto.payload["owners_from_subtask"], str(self.two.pk))
        services.move_task(self.two, self.done, None)  # nothing left: keep Jim
        self.assertEqual(self.owners(self.parent), ["Jim"])

    def test_manual_owners_override_then_resume(self):
        services.update_task(self.one, {}, owners=[self.rich])
        services.update_task(self.parent, {}, owners=[self.boss], actor="rich")
        self.parent.refresh_from_db()
        self.assertFalse(self.parent.owner_follows_next)
        services.update_task(self.one, {}, owners=[self.jim])
        self.assertEqual(self.owners(self.parent), ["Boss"])
        services.update_task(self.parent, {"owner_follows_next": True})
        self.assertEqual(self.owners(self.parent), ["Jim"])

    def test_ripples_up(self):
        top = services.create_task(self.b, self.doing, "Top")
        services.update_task(self.parent, {}, parent=top)
        services.update_task(self.one, {}, owners=[self.rich])
        self.assertEqual(self.owners(top), ["Rich"])

    def test_blocked_subtask_is_skipped(self):
        services.update_task(self.one, {}, owners=[self.rich])
        services.update_task(self.two, {}, owners=[self.jim])
        services.link_tasks(self.two, self.one, TaskLink.LinkType.BLOCKS)  # One waits on Two
        self.assertEqual(self.owners(self.parent), ["Jim"])

    def test_owner_log(self):
        services.update_task(self.one, {}, owners=[self.rich])
        services.move_task(self.one, self.done, None)
        services.update_task(self.two, {}, owners=[self.jim])
        log = owner_log.owner_log(self.parent)
        names = [[Owner.objects.get(pk=i).name for i in p["owner_ids"]] for p in log]
        self.assertEqual(names[-2:], [["Rich"], ["Jim"]])
        self.assertEqual(log[-1]["set_by"], "auto")
        self.assertIsNone(log[-1]["end"])


class HideSubtasksAndInboxTests(APITestCase):
    def setUp(self):
        self.b, (self.backlog, *_rest) = board("B", "b")
        self.parent = services.create_task(self.b, self.backlog, "Parent")

    def test_flags_via_api(self):
        r = self.client.patch(f"/api/tasks/{self.parent.pk}/", {"hide_subtasks": True}, format="json")
        self.assertTrue(r.json()["hide_subtasks"])
        r = self.client.patch(f"/api/tasks/{self.parent.pk}/", {"hide_subtasks": "yes"}, format="json")
        self.assertEqual(r.status_code, 400)

    def test_inbox_listed_with_count_and_kept_out_of_families(self):
        boards = self.client.get("/api/boards/").json()
        inbox = next(b for b in boards if b["kind"] == "inbox")
        self.assertEqual(inbox["open_count"], 0)
        inbox_board = Board.objects.get(pk=inbox["id"])
        with self.assertRaises(services.ServiceError):
            services.set_board_parent(inbox_board, self.b)
        with self.assertRaises(services.ServiceError):
            services.set_board_parent(self.b, inbox_board)
        # a note there moves out to a board lane
        lane = inbox_board.lanes.get()
        note = services.create_task(inbox_board, lane, "Remember milk")
        r = self.client.post(f"/api/tasks/{note.pk}/move-board/",
                             {"board_id": str(self.b.pk), "lane_id": str(self.backlog.pk)},
                             format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["board_id"], str(self.b.pk))
        with_lanes = self.client.get("/api/boards/?lanes=1").json()
        self.assertEqual([l["name"] for l in next(b for b in with_lanes if b["id"] == str(self.b.pk))["lanes"]],
                         ["Backlog", "Doing", "Done"])
        self.assertEqual(self.client.get(f"/api/tasks/{note.pk}/owner-log/").status_code, 200)
