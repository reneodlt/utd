from rest_framework.test import APITestCase

from boards import services
from boards.models import Board, Lane, TaskLink


class ApiTests(APITestCase):
    def setUp(self):
        self.board = Board.objects.create(
            name="B", slug="b",
            animation_catalogue={"enabled": ["celebrate"], "default": "slide"},
        )
        self.backlog = Lane.objects.create(board=self.board, name="Backlog", order=0)
        self.doing = Lane.objects.create(board=self.board, name="Doing", order=1)

    def create_task(self, title="task", **extra):
        response = self.client.post(
            f"/api/boards/{self.board.pk}/tasks/",
            {"lane_id": str(self.backlog.pk), "title": title, **extra},
            format="json",
        )
        self.assertEqual(response.status_code, 201, response.content)
        return response.json()

    def test_snapshot_shape(self):
        self.create_task("one")
        self.create_task("two")
        response = self.client.get(f"/api/boards/{self.board.pk}/snapshot/")
        data = response.json()
        self.assertEqual(len(data["lanes"]), 2)
        self.assertEqual([t["title"] for t in data["tasks"]], ["one", "two"])
        self.assertGreater(data["last_event_id"], 0)
        self.assertEqual(data["board"]["animation_catalogue"]["enabled"], ["celebrate"])

    def test_create_with_meta_and_animation(self):
        task = self.create_task("ci", meta={"actor": "github-ci", "animation": "celebrate"})
        events = self.client.get(f"/api/tasks/{task['id']}/events/").json()["results"]
        self.assertEqual(events[0]["actor"], "github-ci")
        self.assertEqual(events[0]["animation"], "celebrate")
        self.assertEqual(events[0]["source"], "api")

    def test_source_ui_header(self):
        task = self.create_task("t")
        self.client.post(
            f"/api/tasks/{task['id']}/move/",
            {"to_lane_id": str(self.doing.pk), "index": 0},
            format="json",
            headers={"X-UTD-Source": "ui"},
        )
        events = self.client.get(f"/api/tasks/{task['id']}/events/").json()["results"]
        self.assertEqual(events[0]["source"], "ui")

    def test_move_and_timeline(self):
        task = self.create_task("t")
        response = self.client.post(
            f"/api/tasks/{task['id']}/move/",
            {"to_lane_id": str(self.doing.pk), "index": 0},
            format="json",
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["lane_id"], str(self.doing.pk))
        timeline = self.client.get(f"/api/tasks/{task['id']}/timeline/").json()["timeline"]
        self.assertEqual([s["lane_name"] for s in timeline], ["Backlog", "Doing"])

    def test_move_to_unknown_lane_404(self):
        task = self.create_task("t")
        response = self.client.post(
            f"/api/tasks/{task['id']}/move/",
            {"to_lane_id": "00000000-0000-0000-0000-000000000000", "index": 0},
            format="json",
        )
        self.assertEqual(response.status_code, 404)

    def test_subtasks_and_blocked_badges_in_snapshot(self):
        parent = self.create_task("parent")
        self.create_task("child", parent_id=parent["id"])
        blocker = self.create_task("blocker")
        response = self.client.post(
            f"/api/tasks/{blocker['id']}/links/",
            {"to_task_id": parent["id"], "link_type": "blocks"},
            format="json",
        )
        self.assertEqual(response.status_code, 201)
        snapshot = self.client.get(f"/api/boards/{self.board.pk}/snapshot/").json()
        by_title = {t["title"]: t for t in snapshot["tasks"]}
        self.assertEqual(by_title["parent"]["subtask_count"], 1)
        self.assertEqual(by_title["parent"]["blocked_by"], [blocker["id"]])
        self.assertEqual(by_title["child"]["parent_id"], parent["id"])
        self.assertEqual(by_title["blocker"]["links"][0]["link_type"], "blocks")

    def test_archive_hides_from_snapshot(self):
        task = self.create_task("t")
        response = self.client.post(f"/api/tasks/{task['id']}/archive/", {}, format="json")
        self.assertEqual(response.status_code, 204)
        snapshot = self.client.get(f"/api/boards/{self.board.pk}/snapshot/").json()
        self.assertEqual(snapshot["tasks"], [])

    def test_archived_task_rejects_move(self):
        task = self.create_task("t")
        self.client.post(f"/api/tasks/{task['id']}/archive/", {}, format="json")
        response = self.client.post(
            f"/api/tasks/{task['id']}/move/",
            {"to_lane_id": str(self.doing.pk), "index": 0},
            format="json",
        )
        self.assertEqual(response.status_code, 404)

    def test_external_link(self):
        task = self.create_task("t")
        response = self.client.post(
            f"/api/tasks/{task['id']}/external-links/",
            {"provider": "github_pr", "url": "https://github.com/x/y/pull/1",
             "label": "PR #1"},
            format="json",
        )
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json()["provider"], "github_pr")
        detail = self.client.get(f"/api/tasks/{task['id']}/").json()
        [attachment] = detail["attachments"]
        self.assertEqual(attachment["kind"], "github")
        self.assertEqual(attachment["label"], "PR #1")
        self.assertEqual(attachment["data"], {"url": "https://github.com/x/y/pull/1"})

    def attach(self, task, kind, data, **extra):
        return self.client.post(
            f"/api/tasks/{task['id']}/attachments/",
            {"kind": kind, "data": data, **extra}, format="json",
        )

    def test_attachment_kinds_listed(self):
        kinds = {k["kind"] for k in self.client.get("/api/attachment-kinds/").json()}
        self.assertLessEqual(
            {"link", "phone", "email", "place", "event", "github"}, kinds)

    def test_attach_each_kind(self):
        task = self.create_task("t")
        cases = [
            ("link", {"url": "example.com/page"}, {"url": "https://example.com/page"}),
            ("phone", {"number": "tel:+44 20 7946 0958"}, {"number": "+44 20 7946 0958"}),
            ("email", {"address": "a@b.co", "subject": "Hi"}, {"address": "a@b.co", "subject": "Hi"}),
            ("place", {"address": "10 Downing St, London"}, {"address": "10 Downing St, London"}),
            ("github", {"url": "github.com/acme/app/pull/12/files"},
             {"url": "https://github.com/acme/app/pull/12/files"}),
            ("event", {"title": "Kickoff", "start": "2026-10-01T09:00", "end": "2026-10-01T10:00"},
             {"title": "Kickoff", "start": "2026-10-01T09:00", "end": "2026-10-01T10:00"}),
        ]
        for kind, data, expected in cases:
            with self.subTest(kind=kind):
                response = self.attach(task, kind, data)
                self.assertEqual(response.status_code, 201, response.content)
                self.assertEqual(response.json()["attachment"]["data"], expected)
        task_json = response.json()["task"]
        self.assertEqual([a["kind"] for a in task_json["attachments"]],
                         ["link", "phone", "email", "place", "github", "event"])

    def test_attachment_rejects_bad_data(self):
        task = self.create_task("t")
        for kind, data in [
            ("fax", {"number": "123"}),
            ("phone", {"number": "call me"}),
            ("email", {"address": "nope"}),
            ("link", {"url": "javascript:alert(1)"}),
            ("event", {"title": "x", "start": "2026-10-02", "end": "2026-10-01"}),
            ("event", {"title": "x"}),
            ("github", {"url": "https://gitlab.com/acme/app/-/issues/7"}),
            ("github", {"url": "https://github.com.evil.example/acme"}),
        ]:
            with self.subTest(kind=kind, data=data):
                self.assertEqual(self.attach(task, kind, data).status_code, 400)

    def test_attachment_edit_and_soft_remove(self):
        task = self.create_task("t")
        attachment = self.attach(task, "phone", {"number": "555 0100"}).json()["attachment"]
        url = f"/api/tasks/{task['id']}/attachments/{attachment['id']}/"
        response = self.client.patch(url, {"label": "Office", "data": {"number": "555 0199"}},
                                     format="json")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["attachment"]["label"], "Office")
        self.assertEqual(self.client.delete(url).status_code, 200)
        detail = self.client.get(f"/api/tasks/{task['id']}/").json()
        self.assertEqual(detail["attachments"], [])
        self.assertEqual(self.client.delete(url).status_code, 404)
        actions = [
            e["payload"].get("action")
            for e in self.client.get(f"/api/tasks/{task['id']}/events/").json()["results"]
            if e["event_type"] == "task.updated"
        ]
        self.assertEqual(actions, ["removed", "edited", "added"])

    def test_board_events_since_cursor(self):
        task = self.create_task("t")
        first_id = self.client.get(
            f"/api/boards/{self.board.pk}/snapshot/"
        ).json()["last_event_id"]
        self.client.post(
            f"/api/tasks/{task['id']}/move/",
            {"to_lane_id": str(self.doing.pk), "index": 0},
            format="json",
        )
        events = self.client.get(
            f"/api/boards/{self.board.pk}/events/?since={first_id}"
        ).json()["results"]
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["event_type"], "task.moved")

    def test_link_delete(self):
        a = self.create_task("a")
        b = self.create_task("b")
        link = self.client.post(
            f"/api/tasks/{a['id']}/links/",
            {"to_task_id": b["id"], "link_type": "relates_to"},
            format="json",
        ).json()
        response = self.client.delete(f"/api/tasks/{a['id']}/links/{link['id']}/")
        self.assertEqual(response.status_code, 204)
        self.assertEqual(TaskLink.objects.count(), 0)

    def test_parent_move_blocked_returns_blocking_ids(self):
        parent = self.create_task("parent")
        child = self.create_task("child", parent_id=parent["id"])
        response = self.client.post(
            f"/api/tasks/{parent['id']}/move/",
            {"to_lane_id": str(self.doing.pk), "index": 0},
            format="json",
        )
        self.assertEqual(response.status_code, 400)
        body = response.json()
        self.assertEqual(body["code"], "subtask_block")
        self.assertEqual(body["blocking_task_ids"], [child["id"]])

    def test_title_required(self):
        response = self.client.post(
            f"/api/boards/{self.board.pk}/tasks/",
            {"lane_id": str(self.backlog.pk), "title": "  "},
            format="json",
        )
        self.assertEqual(response.status_code, 400)


class BoardApiTests(APITestCase):
    def test_create_board_with_defaults(self):
        response = self.client.post("/api/boards/", {"name": "Dogfood"}, format="json")
        self.assertEqual(response.status_code, 201, response.content)
        board = response.json()
        self.assertEqual(board["name"], "Dogfood")
        self.assertEqual(board["slug"], "dogfood")
        self.assertEqual(
            [lane["name"] for lane in board["lanes"]],
            ["Backlog", "In Progress", "Review", "Done"],
        )
        self.assertIn("celebrate", board["animation_catalogue"]["enabled"])
        created = Board.objects.get(pk=board["id"])
        self.assertEqual(created.rules.count(), 1)
        rule = created.rules.get()
        self.assertEqual(rule.trigger, {"when": "moved", "final": True})

    def test_create_board_with_custom_lanes(self):
        response = self.client.post(
            "/api/boards/",
            {"name": "Chores", "lanes": [{"name": "Todo"}, {"name": "Did", "wip_limit": 5}]},
            format="json",
        )
        self.assertEqual(response.status_code, 201, response.content)
        lanes = response.json()["lanes"]
        self.assertEqual([lane["name"] for lane in lanes], ["Todo", "Did"])
        self.assertEqual(lanes[1]["wip_limit"], 5)

    def test_create_board_slug_uniquified(self):
        first = self.client.post("/api/boards/", {"name": "Work"}, format="json").json()
        second = self.client.post("/api/boards/", {"name": "Work"}, format="json").json()
        self.assertEqual(first["slug"], "work")
        self.assertEqual(second["slug"], "work-2")

    def test_create_board_rejects_blank_name_and_bad_lanes(self):
        self.assertEqual(
            self.client.post("/api/boards/", {"name": "  "}, format="json").status_code,
            400,
        )
        self.assertEqual(
            self.client.post(
                "/api/boards/", {"name": "X", "lanes": ["nope"]}, format="json"
            ).status_code,
            400,
        )
        self.assertEqual(
            self.client.post(
                "/api/boards/",
                {"name": "X", "lanes": [{"name": "A", "wip_limit": "three"}]},
                format="json",
            ).status_code,
            400,
        )

    def test_rename_board(self):
        board = self.client.post("/api/boards/", {"name": "Old"}, format="json").json()
        response = self.client.patch(
            f"/api/boards/{board['id']}/", {"name": "New"}, format="json"
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["name"], "New")
        self.assertEqual(response.json()["slug"], "old")  # slug is stable

    def test_archive_board_drops_it_from_the_list(self):
        board = self.client.post("/api/boards/", {"name": "Temp"}, format="json").json()
        keep = self.client.post("/api/boards/", {"name": "Keep"}, format="json").json()
        response = self.client.delete(f"/api/boards/{board['id']}/")
        self.assertEqual(response.status_code, 204)
        listed = self.client.get("/api/boards/").json()
        self.assertEqual([b["id"] for b in listed if b["kind"] != "inbox"], [keep["id"]])
        # Archived boards stay reachable by direct URL (tasks are preserved).
        self.assertEqual(
            self.client.get(f"/api/boards/{board['id']}/snapshot/").status_code, 200
        )

    def test_new_board_is_immediately_usable(self):
        board = self.client.post("/api/boards/", {"name": "Live"}, format="json").json()
        lane = board["lanes"][0]
        response = self.client.post(
            f"/api/boards/{board['id']}/tasks/",
            {"lane_id": lane["id"], "title": "first task"},
            format="json",
        )
        self.assertEqual(response.status_code, 201, response.content)


class OwnerApiTests(APITestCase):
    def setUp(self):
        self.board = Board.objects.create(name="B", slug="b")
        self.lane = Lane.objects.create(board=self.board, name="Backlog", order=0)
        self.task = self.client.post(
            f"/api/boards/{self.board.pk}/tasks/",
            {"lane_id": str(self.lane.pk), "title": "t"}, format="json",
        ).json()

    def owner(self, **fields):
        body = {"name": "Ada Lovelace", "code": "ADA", "fg": "#FFFFFF", "bg": "#4f46e5", **fields}
        response = self.client.post("/api/owners/", body, format="json")
        self.assertEqual(response.status_code, 201, response.content)
        return response.json()

    def test_create_validates(self):
        ada = self.owner(emoji="🦊")
        self.assertEqual(ada["fg"], "#ffffff")
        self.assertEqual(ada["emoji"], "🦊")
        for bad in ({"code": ""}, {"code": "TOOLONG"}, {"bg": "red"}, {"name": " "}):
            with self.subTest(bad=bad):
                body = {"name": "X", "code": "X", **bad}
                self.assertEqual(self.client.post("/api/owners/", body, format="json").status_code, 400)

    def test_assign_owners_is_audited(self):
        ada, acme = self.owner(), self.owner(name="Acme Ltd", code="ACME")
        url = f"/api/tasks/{self.task['id']}/"
        response = self.client.patch(url, {"owner_ids": [acme["id"], ada["id"]]}, format="json")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["owner_ids"], [ada["id"], acme["id"]])  # owner order
        self.client.patch(url, {"owner_ids": [acme["id"]]}, format="json")
        events = self.client.get(f"/api/tasks/{self.task['id']}/events/").json()["results"]
        change = events[0]["payload"]["changes"]["owners"]
        self.assertEqual(change["to"], [acme["id"]])
        self.assertEqual(len(change["from"]), 2)
        snapshot = self.client.get(f"/api/boards/{self.board.pk}/snapshot/").json()
        self.assertEqual(len(snapshot["owners"]), 2)
        self.assertEqual(snapshot["tasks"][0]["owner_ids"], [acme["id"]])

    def test_unknown_or_archived_owner_rejected(self):
        ada = self.owner()
        url = f"/api/tasks/{self.task['id']}/"
        bogus = "00000000-0000-0000-0000-000000000000"
        self.assertEqual(self.client.patch(url, {"owner_ids": [bogus]}, format="json").status_code, 400)
        self.assertEqual(self.client.delete(f"/api/owners/{ada['id']}/").status_code, 204)
        owners = self.client.get("/api/owners/").json()
        self.assertTrue(owners[0]["archived"])
        self.assertEqual(self.client.patch(url, {"owner_ids": [ada["id"]]}, format="json").status_code, 400)

    def test_edit_owner(self):
        ada = self.owner()
        response = self.client.patch(f"/api/owners/{ada['id']}/", {"code": "AL", "bg": "#0f766e"},
                                     format="json")
        self.assertEqual(response.json()["code"], "AL")
        self.assertEqual(response.json()["bg"], "#0f766e")


class ArchiveDeleteTests(APITestCase):
    def setUp(self):
        self.board = Board.objects.create(name="B", slug="b")
        self.todo = Lane.objects.create(board=self.board, name="Todo", order=0)
        self.done = Lane.objects.create(board=self.board, name="Done", order=1, is_final=True)

    def task(self, title, lane):
        return self.client.post(
            f"/api/boards/{self.board.pk}/tasks/",
            {"lane_id": str(lane.pk), "title": title}, format="json",
        ).json()

    def listing(self, state):
        return [t["title"] for t in self.client.get(
            f"/api/boards/{self.board.pk}/tasks/?state={state}").json()["results"]]

    def open_titles(self):
        return [t["title"] for t in self.client.get(
            f"/api/boards/{self.board.pk}/snapshot/").json()["tasks"]]

    def test_archive_all_in_lane(self):
        self.task("a", self.done), self.task("b", self.done), self.task("keep", self.todo)
        response = self.client.post(f"/api/lanes/{self.done.pk}/archive-all/", {}, format="json")
        self.assertEqual(len(response.json()["archived"]), 2)
        self.assertEqual(self.open_titles(), ["keep"])
        self.assertEqual(sorted(self.listing("archived")), ["a", "b"])

    def test_delete_restore_cycle(self):
        t = self.task("t", self.todo)
        deleted = self.client.post(f"/api/tasks/{t['id']}/delete/", {}, format="json").json()
        self.assertIsNotNone(deleted["deleted_at"])
        self.assertIsNotNone(deleted["archived_at"])
        self.assertEqual(self.open_titles(), [])
        self.assertEqual(self.listing("deleted"), ["t"])
        self.assertEqual(self.listing("archived"), [])
        restored = self.client.post(f"/api/tasks/{t['id']}/restore/", {}, format="json").json()
        self.assertIsNone(restored["deleted_at"])
        self.assertEqual(self.open_titles(), ["t"])
        types = [e["event_type"] for e in
                 self.client.get(f"/api/tasks/{t['id']}/events/").json()["results"]]
        self.assertEqual(types[:2], ["task.restored", "task.deleted"])

    def test_delete_from_archive_and_restore_blocks_again(self):
        blocker, blocked = self.task("blocker", self.todo), self.task("blocked", self.todo)
        self.client.post(f"/api/tasks/{blocker['id']}/links/",
                         {"to_task_id": blocked["id"], "link_type": "blocks"}, format="json")
        blocked_by = lambda: self.client.get(f"/api/tasks/{blocked['id']}/").json()["blocked_by"]
        self.assertEqual(blocked_by(), [blocker["id"]])
        self.client.post(f"/api/tasks/{blocker['id']}/archive/", {}, format="json")
        self.assertEqual(blocked_by(), [])
        self.client.post(f"/api/tasks/{blocker['id']}/delete/", {}, format="json")
        self.assertEqual(self.listing("deleted"), ["blocker"])
        self.client.post(f"/api/tasks/{blocker['id']}/restore/", {}, format="json")
        self.assertEqual(blocked_by(), [blocker["id"]])
        latest = self.client.get(f"/api/tasks/{blocked['id']}/events/").json()["results"][0]
        self.assertEqual(latest["payload"].get("reblocked_by"), blocker["id"])

    def test_restore_lands_at_bottom_of_lane(self):
        t = self.task("first", self.todo)
        self.task("second", self.todo)
        self.client.post(f"/api/tasks/{t['id']}/archive/", {}, format="json")
        self.client.post(f"/api/tasks/{t['id']}/restore/", {}, format="json")
        self.assertEqual(self.open_titles(), ["second", "first"])

    def test_listing_needs_state(self):
        self.assertEqual(self.client.get(f"/api/boards/{self.board.pk}/tasks/").status_code, 400)


class CategoryApiTests(APITestCase):
    def setUp(self):
        self.a = Board.objects.create(name="A", slug="a")
        self.b = Board.objects.create(name="B", slug="b")
        self.lane_a = Lane.objects.create(board=self.a, name="Todo", order=0)
        self.lane_b = Lane.objects.create(board=self.b, name="Todo", order=0)
        self.task_a = self.client.post(f"/api/boards/{self.a.pk}/tasks/",
                                       {"lane_id": str(self.lane_a.pk), "title": "ta"},
                                       format="json").json()
        self.task_b = self.client.post(f"/api/boards/{self.b.pk}/tasks/",
                                       {"lane_id": str(self.lane_b.pk), "title": "tb"},
                                       format="json").json()

    def create(self, board, name, **extra):
        return self.client.post(f"/api/boards/{board.pk}/categories/",
                                {"name": name, "color": "#16a34a", **extra}, format="json")

    def names(self, board):
        return sorted(c["name"] for c in
                      self.client.get(f"/api/boards/{board.pk}/categories/").json())

    def set_categories(self, task, ids):
        return self.client.patch(f"/api/tasks/{task['id']}/", {"category_ids": ids}, format="json")

    def test_scopes_are_visible_where_they_should_be(self):
        self.assertEqual(self.create(self.a, "Bug", shared=True).status_code, 201)
        self.assertEqual(self.create(self.a, "Frontend").status_code, 201)
        self.assertEqual(self.names(self.a), ["Bug", "Frontend"])
        self.assertEqual(self.names(self.b), ["Bug"])
        snapshot = self.client.get(f"/api/boards/{self.b.pk}/snapshot/").json()
        self.assertEqual([c["name"] for c in snapshot["categories"]], ["Bug"])

    def test_names_unique_within_what_a_board_sees(self):
        self.create(self.a, "Bug", shared=True)
        self.assertEqual(self.create(self.b, "bug").status_code, 400)       # clashes with shared
        self.assertEqual(self.create(self.a, "Design").status_code, 201)
        self.assertEqual(self.create(self.b, "Design").status_code, 201)    # other board: fine
        self.assertEqual(self.create(self.a, "design", shared=True).status_code, 400)

    def test_assign_respects_scope_and_is_audited(self):
        shared = self.create(self.a, "Bug", shared=True).json()
        own_a = self.create(self.a, "Frontend").json()
        response = self.set_categories(self.task_a, [own_a["id"], shared["id"]])
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["category_ids"], [shared["id"], own_a["id"]])
        self.assertEqual(self.set_categories(self.task_b, [own_a["id"]]).status_code, 400)
        self.assertEqual(self.set_categories(self.task_b, [shared["id"]]).status_code, 200)
        event = self.client.get(f"/api/tasks/{self.task_a['id']}/events/").json()["results"][0]
        self.assertEqual(sorted(event["payload"]["changes"]["categories"]["to"]),
                         sorted([shared["id"], own_a["id"]]))

    def test_scope_changes(self):
        own_a = self.create(self.a, "Frontend").json()
        url = f"/api/categories/{own_a['id']}/"
        shared = self.client.patch(url, {"board_id": None}, format="json")
        self.assertEqual(shared.status_code, 200)
        self.assertIsNone(shared.json()["board_id"])
        self.set_categories(self.task_b, [own_a["id"]])
        # used on board B now, so it can't become board A's own
        self.assertEqual(self.client.patch(url, {"board_id": str(self.a.pk)}, format="json")
                         .status_code, 400)
        self.set_categories(self.task_b, [])
        self.assertEqual(self.client.patch(url, {"board_id": str(self.a.pk)}, format="json")
                         .status_code, 200)
        self.assertEqual(self.names(self.b), [])

    def test_archive_hides_from_assignment(self):
        bug = self.create(self.a, "Bug").json()
        self.assertEqual(self.client.delete(f"/api/categories/{bug['id']}/").status_code, 204)
        self.assertTrue(self.client.get(f"/api/boards/{self.a.pk}/categories/").json()[0]["archived"])
        self.assertEqual(self.set_categories(self.task_a, [bug["id"]]).status_code, 400)
        self.assertEqual(self.create(self.a, "Bug").status_code, 201)  # name free again


class BoardFamilyTests(APITestCase):
    def board(self, name, parent=None, lanes=None):
        body = {"name": name, **({"parent_id": parent["id"]} if parent else {}),
                **({"lanes": lanes} if lanes else {})}
        response = self.client.post("/api/boards/", body, format="json")
        self.assertEqual(response.status_code, 201, response.content)
        return response.json()

    def task(self, board, lane_index, title):
        return self.client.post(
            f"/api/boards/{board['id']}/tasks/",
            {"lane_id": board["lanes"][lane_index]["id"], "title": title}, format="json",
        ).json()

    def snapshot(self, board):
        return self.client.get(f"/api/boards/{board['id']}/snapshot/").json()

    def reparent(self, board, parent):
        return self.client.patch(f"/api/boards/{board['id']}/",
                                 {"parent_id": parent["id"] if parent else None}, format="json")

    def test_parent_shows_descendant_tasks(self):
        master = self.board("Master")
        team = self.board("Team", master)
        squad = self.board("Squad", team)
        self.task(master, 0, "m"), self.task(team, 1, "t"), self.task(squad, 3, "s")
        snap = self.snapshot(master)
        self.assertEqual(sorted(t["title"] for t in snap["tasks"]), ["m", "s", "t"])
        self.assertEqual(sorted(b["name"] for b in snap["family"]), ["Squad", "Team"])
        self.assertEqual(sorted(t["title"] for t in self.snapshot(team)["tasks"]), ["s", "t"])
        self.assertEqual([t["title"] for t in self.snapshot(squad)["tasks"]], ["s"])
        # same-named lanes line up both ways
        squad_done = squad["lanes"][3]["id"]
        self.assertEqual(snap["lane_map"][squad_done], master["lanes"][3]["id"])
        self.assertEqual(snap["lane_back"][squad["id"]][master["lanes"][3]["id"]], squad_done)

    def test_parent_gains_child_lanes_superset(self):
        master = self.board("Master")
        child = self.board("Ops", master, lanes=[{"name": "Todo"}, {"name": "Backlog"},
                                                 {"name": "QA"}, {"name": "Shipped", "is_final": True}])
        names = [l["name"] for l in self.snapshot(master)["lanes"]]
        # new lanes slot in after their nearest predecessor that the parent has
        self.assertEqual(names, ["Todo", "Backlog", "QA", "In Progress", "Review", "Done", "Shipped"])
        snap = self.snapshot(master)
        by_name = {l["name"]: l for l in snap["lanes"]}
        self.assertTrue(by_name["Shipped"]["is_final"])
        # every child lane lines up by name, both ways; parent-only lanes don't map back
        for lane in child["lanes"]:
            self.assertEqual(snap["lane_map"][lane["id"]], by_name[lane["name"]]["id"])
        back = snap["lane_back"][child["id"]]
        self.assertNotIn(by_name["Review"]["id"], back)
        self.assertEqual(back[by_name["QA"]["id"]], child["lanes"][2]["id"])

    def test_reparent_rules(self):
        a, b = self.board("A"), self.board("B")
        c = self.board("C", b)
        self.assertEqual(self.reparent(b, a).status_code, 200)
        self.assertEqual(self.reparent(a, c).status_code, 400)   # cycle via b
        self.assertEqual(self.reparent(a, a).status_code, 400)
        self.assertEqual(self.reparent(c, None).status_code, 200)
        listing = {x["name"]: x["parent_id"] for x in self.client.get("/api/boards/").json()}
        self.assertEqual(listing["B"], a["id"])
        self.assertIsNone(listing["C"])

    def test_archiving_a_board_lifts_its_children(self):
        master = self.board("Master")
        mid = self.board("Mid", master)
        leaf = self.board("Leaf", mid)
        self.client.delete(f"/api/boards/{mid['id']}/")
        listing = {x["name"]: x["parent_id"] for x in self.client.get("/api/boards/").json()}
        self.assertEqual(listing["Leaf"], master["id"])
        self.assertNotIn("Mid", listing)
        self.task(leaf, 0, "leaf task")
        self.assertEqual([t["title"] for t in self.snapshot(master)["tasks"]], ["leaf task"])

    def test_archive_all_includes_descendants_in_that_lane(self):
        master = self.board("Master")
        child = self.board("Child", master)
        self.task(master, 3, "mine"), self.task(child, 3, "theirs"), self.task(child, 0, "not done")
        done = master["lanes"][3]["id"]
        response = self.client.post(f"/api/lanes/{done}/archive-all/", {}, format="json")
        self.assertEqual(len(response.json()["archived"]), 2)
        self.assertEqual([t["title"] for t in self.snapshot(master)["tasks"]], ["not done"])
        archived = self.client.get(f"/api/boards/{master['id']}/tasks/?state=archived").json()
        self.assertEqual(archived["count"], 2)

    def test_child_board_category_visible_in_parent_snapshot(self):
        master = self.board("Master")
        child = self.board("Child", master)
        self.client.post(f"/api/boards/{child['id']}/categories/", {"name": "Ops"}, format="json")
        names = [c["name"] for c in self.snapshot(master)["categories"]]
        self.assertEqual(names, ["Ops"])


class LaneConfigTests(APITestCase):
    def board(self, name, parent=None):
        body = {"name": name, **({"parent_id": parent["id"]} if parent else {})}
        return self.client.post("/api/boards/", body, format="json").json()

    def lanes(self, board):
        return self.client.get(f"/api/boards/{board['id']}/lanes/").json()

    def names(self, board):
        return [l["name"] for l in self.lanes(board)]

    def test_add_reorder_edit(self):
        b = self.board("B")
        r = self.client.post(f"/api/boards/{b['id']}/lanes/",
                             {"name": "Blocked", "color": "#ef4444", "index": 2}, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(self.names(b), ["Backlog", "In Progress", "Blocked", "Review", "Done"])
        self.assertEqual(self.client.post(f"/api/boards/{b['id']}/lanes/", {"name": "blocked"},
                                          format="json").status_code, 400)  # duplicate
        ids = [l["id"] for l in self.lanes(b)]
        self.client.post(f"/api/boards/{b['id']}/lanes/order/",
                         {"lane_ids": [ids[4], *ids[:4]]}, format="json")
        self.assertEqual(self.names(b)[0], "Done")
        lane = self.lanes(b)[2]
        r = self.client.patch(f"/api/lanes/{lane['id']}/",
                              {"name": "Doing", "wip_limit": 2, "is_final": True}, format="json")
        self.assertEqual(r.status_code, 200)
        edited = next(l for l in r.json() if l["id"] == lane["id"])
        self.assertEqual((edited["name"], edited["wip_limit"], edited["is_final"]), ("Doing", 2, True))

    def test_final_flag_drives_archive_all_and_blocking(self):
        b = self.board("B")
        lanes = self.lanes(b)
        backlog, review = lanes[0], lanes[2]
        t = lambda title, lane: self.client.post(f"/api/boards/{b['id']}/tasks/",
                                                 {"lane_id": lane["id"], "title": title},
                                                 format="json").json()
        blocker, blocked = t("blocker", backlog), t("blocked", backlog)
        self.client.post(f"/api/tasks/{blocker['id']}/links/",
                         {"to_task_id": blocked["id"], "link_type": "blocks"}, format="json")
        self.client.patch(f"/api/lanes/{review['id']}/", {"is_final": True}, format="json")
        self.client.post(f"/api/tasks/{blocker['id']}/move/", {"to_lane_id": review["id"]},
                         format="json")
        self.assertEqual(self.client.get(f"/api/tasks/{blocked['id']}/").json()["blocked_by"], [])

    def test_remove_lane_moves_open_tasks(self):
        b = self.board("B")
        backlog, doing = self.lanes(b)[0], self.lanes(b)[1]
        task = self.client.post(f"/api/boards/{b['id']}/tasks/",
                                {"lane_id": doing["id"], "title": "t"}, format="json").json()
        self.assertEqual(self.client.delete(f"/api/lanes/{doing['id']}/").status_code, 400)
        r = self.client.delete(f"/api/lanes/{doing['id']}/?move_to={backlog['id']}")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertNotIn("In Progress", self.names(b))
        self.assertEqual(self.client.get(f"/api/tasks/{task['id']}/").json()["lane_id"], backlog["id"])

    def test_parent_lane_used_below_is_protected(self):
        master = self.board("Master")
        child = self.board("Ops", master)
        self.client.post(f"/api/boards/{child['id']}/lanes/", {"name": "QA", "index": 3},
                         format="json")
        self.assertIn("QA", self.names(master))              # superset
        qa = next(l for l in self.lanes(master) if l["name"] == "QA")
        r = self.client.delete(f"/api/lanes/{qa['id']}/")
        self.assertEqual(r.status_code, 409)
        self.assertEqual(r.json()["boards"][0]["name"], "Ops")
        r = self.client.patch(f"/api/lanes/{qa['id']}/", {"name": "Testing"}, format="json")
        self.assertEqual(r.status_code, 409)
        r = self.client.patch(f"/api/lanes/{qa['id']}/", {"name": "Testing", "cascade": True},
                              format="json")
        self.assertEqual(r.status_code, 200)
        self.assertIn("Testing", self.names(child))
        self.assertNotIn("QA", self.names(master))

    def test_reparent_brings_lanes_up(self):
        a = self.board("A")
        b = self.board("B")
        self.client.post(f"/api/boards/{b['id']}/lanes/", {"name": "Waiting"}, format="json")
        self.client.patch(f"/api/boards/{b['id']}/", {"parent_id": a["id"]}, format="json")
        self.assertIn("Waiting", self.names(a))

    def test_restore_into_removed_lane_goes_to_first_lane(self):
        b = self.board("B")
        backlog, review = self.lanes(b)[0], self.lanes(b)[2]
        task = self.client.post(f"/api/boards/{b['id']}/tasks/",
                                {"lane_id": review["id"], "title": "t"}, format="json").json()
        self.client.post(f"/api/tasks/{task['id']}/archive/", {}, format="json")
        self.client.delete(f"/api/lanes/{review['id']}/")
        restored = self.client.post(f"/api/tasks/{task['id']}/restore/", {}, format="json").json()
        self.assertEqual(restored["lane_id"], backlog["id"])


class QuickAddTests(APITestCase):
    def setUp(self):
        self.board = Board.objects.create(name="B", slug="b")
        self.lane = Lane.objects.create(board=self.board, name="Backlog", order=0)

    def create(self, **body):
        return self.client.post(f"/api/boards/{self.board.pk}/tasks/",
                                {"lane_id": str(self.lane.pk), **body}, format="json")

    def test_task_with_attachment_in_one_call(self):
        r = self.create(title="PR #42: Fix login",
                        attachments=[{"kind": "github", "data": {"url": "https://github.com/a/b/pull/42"}}])
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["attachments"][0]["kind"], "github")

    def test_bad_attachment_creates_nothing(self):
        r = self.create(title="x", attachments=[{"kind": "phone", "data": {"number": "nope"}}])
        self.assertEqual(r.status_code, 400)
        self.assertEqual(self.board.tasks.count(), 0)

    def test_link_title_endpoint(self):
        from unittest import mock
        with mock.patch("boards.unfurl._github", return_value={"title": "PR #1: Hi"}):
            r = self.client.get("/api/link-title/", {"url": "https://github.com/a/b/pull/1"})
        self.assertEqual(r.json()["title"], "PR #1: Hi")
        self.assertEqual(self.client.get("/api/link-title/", {"url": "ftp://x"}).json(), {})


class DeadlineAndPriorityTests(APITestCase):
    def setUp(self):
        self.board = Board.objects.create(name="B", slug="b")
        self.lane = Lane.objects.create(board=self.board, name="Todo", order=0)
        self.task = self.client.post(f"/api/boards/{self.board.pk}/tasks/",
                                     {"lane_id": str(self.lane.pk), "title": "t"}, format="json").json()

    def test_due_date_set_clear_and_audited(self):
        url = f"/api/tasks/{self.task['id']}/"
        self.assertEqual(self.client.patch(url, {"due_date": "2026-10-01"}, format="json").json()["due_date"],
                         "2026-10-01")
        self.assertEqual(self.client.patch(url, {"due_date": "next week"}, format="json").status_code, 400)
        self.assertIsNone(self.client.patch(url, {"due_date": None}, format="json").json()["due_date"])
        events = self.client.get(f"/api/tasks/{self.task['id']}/events/").json()["results"]
        self.assertEqual(events[1]["payload"]["changes"]["due_date"], {"from": None, "to": "2026-10-01"})

    def test_category_priority_order(self):
        make = lambda n: self.client.post(f"/api/boards/{self.board.pk}/categories/", {"name": n},
                                          format="json").json()["id"]
        a, b, c = make("A"), make("B"), make("C")
        self.assertEqual(self.client.post("/api/categories/order/", {"category_ids": [c, a, b]},
                                          format="json").status_code, 204)
        names = [x["name"] for x in sorted(self.client.get(f"/api/boards/{self.board.pk}/categories/").json(),
                                          key=lambda x: x["position"])]
        self.assertEqual(names, ["C", "A", "B"])


class CreateWithDueDateTests(APITestCase):
    def test_create_with_due_date(self):
        board = Board.objects.create(name="B", slug="b")
        lane = Lane.objects.create(board=board, name="Todo", order=0)
        url = f"/api/boards/{board.pk}/tasks/"
        r = self.client.post(url, {"lane_id": str(lane.pk), "title": "t", "due_date": "2026-10-02"}, format="json")
        self.assertEqual(r.json()["due_date"], "2026-10-02")
        r = self.client.post(url, {"lane_id": str(lane.pk), "title": "t", "due_date": "soon"}, format="json")
        self.assertEqual(r.status_code, 400)


class SearchAndCalendarTests(APITestCase):
    def setUp(self):
        self.master = self.client.post("/api/boards/", {"name": "Master"}, format="json").json()
        self.child = self.client.post("/api/boards/", {"name": "Garden", "parent_id": self.master["id"]},
                                      format="json").json()

    def task(self, board, title, lane=0, **extra):
        return self.client.post(f"/api/boards/{board['id']}/tasks/",
                                {"lane_id": board["lanes"][lane]["id"], "title": title, **extra},
                                format="json").json()

    def test_search_titles_details_attachments_and_boards(self):
        a = self.task(self.master, "Renew passport")
        b = self.task(self.child, "Plant bulbs", description="before the frost; buy compost")
        c = self.task(self.child, "Call nursery",
                      attachments=[{"kind": "phone", "data": {"number": "01234 567890"}, "label": "Greenfingers"}])
        self.client.post(f"/api/tasks/{a['id']}/archive/", {}, format="json")
        r = self.client.get("/api/search/", {"q": "passport"}).json()
        self.assertEqual([t["title"] for t in r["tasks"]], ["Renew passport"])
        self.assertEqual(r["tasks"][0]["state"], "archived")
        r = self.client.get("/api/search/", {"q": "compost"}).json()
        self.assertEqual(r["tasks"][0]["id"], b["id"])
        self.assertIn("compost", r["tasks"][0]["snippet"])
        self.assertEqual(self.client.get("/api/search/", {"q": "greenfingers"}).json()["tasks"][0]["id"], c["id"])
        self.assertEqual([x["name"] for x in self.client.get("/api/search/", {"q": "gard"}).json()["boards"]],
                         ["Garden"])
        self.assertEqual(self.client.get("/api/search/", {"q": "x"}).json(), {"boards": [], "tasks": []})

    def test_calendar_includes_sub_boards_and_skips_undated_and_archived(self):
        self.task(self.master, "File taxes", due_date="2026-10-31")
        self.task(self.child, "Plant bulbs, tulips", due_date="2026-10-15")
        self.task(self.child, "No deadline")
        gone = self.task(self.child, "Old thing", due_date="2026-10-01")
        self.client.post(f"/api/tasks/{gone['id']}/archive/", {}, format="json")
        self.task(self.child, "Mowed", lane=3, due_date="2026-09-20")
        r = self.client.get(f"/api/boards/{self.master['id']}/calendar.ics")
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r["Content-Type"].startswith("text/calendar"))
        body = r.content.decode()
        self.assertIn("SUMMARY:File taxes", body)
        self.assertIn("SUMMARY:Plant bulbs\\, tulips", body)          # escaped comma
        self.assertIn("DTSTART;VALUE=DATE:20261015", body)
        self.assertIn("SUMMARY:✓ Mowed", body)                        # done, kept
        self.assertNotIn("No deadline", body)
        self.assertNotIn("Old thing", body)
        self.assertEqual(body.count("BEGIN:VEVENT"), 3)
        self.assertIn("Garden (in Master)", body)
        child_feed = self.client.get(f"/api/boards/{self.child['id']}/calendar.ics").content.decode()
        self.assertNotIn("File taxes", child_feed)                     # parents don't leak down


class UploadBase(APITestCase):
    """A board, a task and a throwaway MEDIA_ROOT."""

    def setUp(self):
        import tempfile
        from django.test import override_settings
        self._media = tempfile.TemporaryDirectory()
        self._override = override_settings(MEDIA_ROOT=self._media.name)
        self._override.enable()
        self.board = self.client.post("/api/boards/", {"name": "B"}, format="json").json()
        self.lane = self.board["lanes"][0]["id"]
        self.task = self.client.post(f"/api/boards/{self.board['id']}/tasks/",
                                     {"lane_id": self.lane, "title": "t"}, format="json").json()

    def tearDown(self):
        self._override.disable()
        self._media.cleanup()

    def png(self, name="photo.png", size=(1200, 800)):
        import io
        from django.core.files.uploadedfile import SimpleUploadedFile
        from PIL import Image
        buf = io.BytesIO()
        Image.new("RGB", size, (200, 30, 30)).save(buf, "PNG")
        return SimpleUploadedFile(name, buf.getvalue(), content_type="image/png")


class UploadAndAgendaTests(UploadBase):
    def test_upload_photo_to_task_makes_thumbnail_and_serves_both(self):
        r = self.client.post(f"/api/tasks/{self.task['id']}/files/", {"file": self.png()}, format="multipart")
        self.assertEqual(r.status_code, 201, r.content)
        data = r.json()["attachments"][0]["data"]
        self.assertEqual((data["width"], data["height"]), ("1200", "800"))
        self.assertTrue(data["thumb_url"].endswith("?thumb=1"))
        full = self.client.get(data["url"])
        self.assertEqual(full["Content-Type"], "image/png")
        thumb = self.client.get(data["thumb_url"])
        self.assertEqual(thumb["Content-Type"], "image/jpeg")
        from PIL import Image
        import io
        self.assertEqual(max(Image.open(io.BytesIO(b"".join(thumb.streaming_content))).size), 640)

    def test_file_task_creates_task_with_photo(self):
        r = self.client.post(f"/api/boards/{self.board['id']}/file-task/",
                             {"file": self.png(), "lane_id": self.lane, "title": "Photo · 25 Sep"},
                             format="multipart")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["title"], "Photo · 25 Sep")
        self.assertEqual(r.json()["attachments"][0]["kind"], "file")

    def test_rejects_empty_and_plain_file_kind(self):
        from django.core.files.uploadedfile import SimpleUploadedFile
        r = self.client.post(f"/api/tasks/{self.task['id']}/files/",
                             {"file": SimpleUploadedFile("x.txt", b"", content_type="text/plain")},
                             format="multipart")
        self.assertEqual(r.status_code, 400)
        r = self.client.post(f"/api/tasks/{self.task['id']}/attachments/",
                             {"kind": "file", "data": {"name": "x"}}, format="json")
        self.assertEqual(r.status_code, 400)

    def test_agenda_across_boards(self):
        other = self.client.post("/api/boards/", {"name": "C"}, format="json").json()
        mk = lambda b, title, due, lane=0: self.client.post(
            f"/api/boards/{b['id']}/tasks/", {"lane_id": b["lanes"][lane]["id"], "title": title, "due_date": due},
            format="json")
        mk(self.board, "late", "2026-09-20"); mk(other, "today", "2026-09-25")
        mk(self.board, "soon", "2026-09-29"); mk(self.board, "far", "2026-12-01")
        mk(other, "done already", "2026-09-24", lane=3)
        r = self.client.get("/api/agenda/", {"today": "2026-09-25", "days": 7}).json()
        self.assertEqual([t["title"] for t in r["tasks"]], ["late", "today", "soon"])
        self.assertEqual(r["tasks"][1]["board"]["name"], "C")
        self.assertIsNotNone(r["tasks"][0]["done_lane_id"])


# Header-only stand-ins: enough bytes for the sniffer, not for a decoder.
FAKE_OGG_OPUS = b"OggS\x00\x02" + b"\x00" * 20 + b"OpusHead\x01\x01" + b"\x00" * 40
FAKE_MP3 = b"ID3\x03\x00\x00\x00\x00\x00\x00" + b"\xff\xfb\x90\x00" * 64
FAKE_WAV = b"RIFF\x24\x00\x00\x00WAVEfmt " + bytes(range(256)) * 4
FAKE_MP4 = b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2" + b"\x00" * 64
FAKE_M4A = b"\x00\x00\x00\x18ftypM4A \x00\x00\x02\x00M4A mp42" + b"\x00" * 64


class MediaHelpers:
    def upload(self, raw, name, content_type="application/octet-stream"):
        from django.core.files.uploadedfile import SimpleUploadedFile
        return self.client.post(f"/api/tasks/{self.task['id']}/files/",
                                {"file": SimpleUploadedFile(name, raw, content_type=content_type)},
                                format="multipart")

    def attach_one(self, raw, name, content_type="application/octet-stream"):
        r = self.upload(raw, name, content_type)
        self.assertEqual(r.status_code, 201, r.content)
        return r.json()["attachments"][0]


class MediaUploadTests(MediaHelpers, UploadBase):
    """Audio and video: sniffed from the bytes, limits per class, Range
    serving, label edits."""

    def test_audio_and_video_types_are_sniffed(self):
        for raw, name, want, media in [
            (FAKE_OGG_OPUS, "take.opus", "audio/opus", "audio"),
            (FAKE_MP3, "take.mp3", "audio/mpeg", "audio"),
            (FAKE_WAV, "take.wav", "audio/wav", "audio"),
            (b"fLaC" + b"\x00" * 64, "take.flac", "audio/flac", "audio"),
            (FAKE_M4A, "take.m4a", "audio/mp4", "audio"),
            (FAKE_MP4, "clip.mp4", "video/mp4", "video"),
            (b"\x00\x00\x00\x14ftypqt  " + b"\x00" * 64, "clip.mov", "video/quicktime", "video"),
            (b"\x1a\x45\xdf\xa3" + b"\x00" * 64, "clip.webm", "video/webm", "video"),
            (b"\x1a\x45\xdf\xa3" + b"\x00" * 64, "voice.weba", "audio/webm", "audio"),
        ]:
            with self.subTest(name=name):
                data = self.attach_one(raw, name)["data"]
                self.assertEqual((data["content_type"], data["media"]), (want, media))
                self.assertEqual(self.client.get(data["url"])["Content-Type"], want)

    def test_sniffed_type_beats_a_lying_name_and_client(self):
        data = self.attach_one(FAKE_MP3, "notes.txt", "text/plain")["data"]
        self.assertEqual((data["content_type"], data["media"]), ("audio/mpeg", "audio"))
        data = self.attach_one(FAKE_OGG_OPUS, "movie.mp4", "video/mp4")["data"]
        self.assertEqual((data["content_type"], data["media"]), ("audio/opus", "audio"))
        # Text claiming to be audio is not audio.
        data = self.attach_one(b"just some words", "song.mp3", "audio/mpeg")["data"]
        self.assertEqual((data["content_type"], data["media"]), ("application/octet-stream", "file"))

    def test_photos_still_thumbnail_and_say_image(self):
        data = self.attach_one(self.png().read(), "p.png", "image/png")["data"]
        self.assertEqual(data["media"], "image")
        self.assertIn("thumb_url", data)

    def test_audio_limit_is_20_mb_with_a_clear_message(self):
        r = self.upload(b"ID3" + b"\x00" * (20 * 1024 * 1024), "big.mp3", "audio/mpeg")
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()["detail"], "audio files can be up to 20 MB")
        self.assertEqual(self.client.get(f"/api/tasks/{self.task['id']}/").json()["attachments"], [])
        # Exactly at the limit is fine.
        self.assertEqual(self.upload(b"ID3" + b"\x00" * (20 * 1024 * 1024 - 3), "ok.mp3").status_code, 201)

    def test_video_and_other_limits(self):
        from django.test import override_settings
        with override_settings(MAX_VIDEO_BYTES=2 * 1024 * 1024):
            r = self.upload(FAKE_MP4 + b"\x00" * (2 * 1024 * 1024), "big.mp4")
            self.assertEqual(r.status_code, 400)
            self.assertEqual(r.json()["detail"], "video files can be up to 2 MB")
        r = self.upload(b"x" * (25 * 1024 * 1024 + 1), "big.bin")
        self.assertEqual(r.json()["detail"], "files can be up to 25 MB")

    def test_range_requests(self):
        data = self.attach_one(FAKE_WAV, "take.wav")["data"]
        size = len(FAKE_WAV)

        def get(rng=None):
            return self.client.get(data["url"], **({"HTTP_RANGE": rng} if rng else {}))

        whole = get()
        self.assertEqual(whole.status_code, 200)
        self.assertEqual(whole["Accept-Ranges"], "bytes")
        self.assertEqual(whole["Content-Length"], str(size))
        self.assertEqual(whole["Cache-Control"], "private, max-age=3600")
        part = get("bytes=10-19")
        self.assertEqual(part.status_code, 206)
        self.assertEqual(part["Content-Range"], f"bytes 10-19/{size}")
        self.assertEqual(part["Content-Length"], "10")
        self.assertEqual(part["Content-Type"], "audio/wav")
        self.assertEqual(b"".join(part.streaming_content), FAKE_WAV[10:20])
        tail = get(f"bytes={size - 5}-")
        self.assertEqual((tail.status_code, b"".join(tail.streaming_content)), (206, FAKE_WAV[-5:]))
        suffix = get("bytes=-7")
        self.assertEqual(b"".join(suffix.streaming_content), FAKE_WAV[-7:])
        clamped = get(f"bytes=0-{size * 10}")
        self.assertEqual(clamped["Content-Range"], f"bytes 0-{size - 1}/{size}")
        beyond = get(f"bytes={size}-")
        self.assertEqual(beyond.status_code, 416)
        self.assertEqual(beyond["Content-Range"], f"bytes */{size}")
        self.assertEqual(get("bytes=-0").status_code, 416)
        # Garbage and multi-range headers are ignored: the whole file, 200.
        for header in ("bytes=5-2", "items=1-2", "bytes=a-b", "bytes=0-1,5-6"):
            self.assertEqual(get(header).status_code, 200, header)

    def test_label_edit_writes_an_audit_row(self):
        att = self.attach_one(FAKE_OGG_OPUS, "take.opus")
        url = f"/api/tasks/{self.task['id']}/attachments/{att['id']}/"
        r = self.client.patch(url, {"label": "chosen"}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()["attachment"]
        self.assertEqual(body["label"], "chosen")
        self.assertEqual(body["data"]["media"], "audio")   # data untouched
        self.assertIn("url", body["data"])
        events = [e for e in self.client.get(f"/api/tasks/{self.task['id']}/events/").json()["results"]
                  if e["event_type"] == "task.updated"]
        self.assertEqual([e["payload"]["action"] for e in events], ["edited", "added"])
        self.assertEqual(events[0]["payload"]["before"]["label"], "")
        self.assertEqual(events[0]["payload"]["attachment"]["label"], "chosen")
        # An unchanged label is not an event.
        self.client.patch(url, {"label": "chosen"}, format="json")
        again = [e for e in self.client.get(f"/api/tasks/{self.task['id']}/events/").json()["results"]
                 if e["event_type"] == "task.updated"]
        self.assertEqual(len(again), 2)

    def test_without_ffprobe_there_is_no_duration_or_poster(self):
        from unittest import mock
        with mock.patch("boards.uploads._tool", return_value=None):
            audio = self.attach_one(FAKE_MP3, "a.mp3")["data"]
            video = self.attach_one(FAKE_MP4, "v.mp4")["data"]
        self.assertNotIn("duration", audio)
        self.assertEqual(video["media"], "video")
        self.assertNotIn("thumb_url", video)


def _make_media(path, *args):
    import subprocess
    subprocess.run(["ffmpeg", "-v", "error", "-y", *args, path], check=True, timeout=60)


class MediaToolsTests(MediaHelpers, UploadBase):
    """Real files through ffprobe and ffmpeg; skipped where they're absent."""

    def setUp(self):
        import shutil
        from unittest import SkipTest
        if not (shutil.which("ffprobe") and shutil.which("ffmpeg")):
            raise SkipTest("ffmpeg/ffprobe not installed")
        super().setUp()

    def real(self, name, *args):
        import os
        path = os.path.join(self._media.name, "src-" + name)
        _make_media(path, *args)
        with open(path, "rb") as fh:
            return fh.read()

    def test_duration_is_probed_for_audio(self):
        raw = self.real("tone.ogg", "-f", "lavfi", "-i", "sine=frequency=440:duration=2.5", "-c:a", "libopus")
        data = self.attach_one(raw, "tone.ogg")["data"]
        self.assertEqual(data["media"], "audio")
        self.assertEqual(data["content_type"], "audio/opus")
        self.assertAlmostEqual(float(data["duration"]), 2.5, delta=0.3)

    def test_audio_only_mp4_is_audio_and_video_gets_a_poster(self):
        raw = self.real("tone.m4a", "-f", "lavfi", "-i", "sine=duration=1", "-c:a", "aac", "-f", "ipod")
        data = self.attach_one(raw, "mystery.mp4")["data"]   # name says video, streams say audio
        self.assertEqual((data["media"], data["content_type"]), ("audio", "audio/mp4"))
        raw = self.real("clip.mp4", "-f", "lavfi", "-i", "testsrc=duration=2:size=96x64:rate=10",
                        "-pix_fmt", "yuv420p")
        data = self.attach_one(raw, "clip.mp4")["data"]
        self.assertEqual((data["media"], data["width"], data["height"]), ("video", "96", "64"))
        self.assertAlmostEqual(float(data["duration"]), 2.0, delta=0.3)
        from PIL import Image
        import io
        poster = self.client.get(data["thumb_url"])
        self.assertEqual(poster["Content-Type"], "image/jpeg")
        Image.open(io.BytesIO(b"".join(poster.streaming_content))).verify()
