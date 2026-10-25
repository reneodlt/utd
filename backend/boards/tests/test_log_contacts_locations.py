from rest_framework.test import APITestCase

from boards import services
from boards.models import Board, Category, Lane, Owner, TaskEvent
from boards.search import search


class LogContactsLocationsTests(APITestCase):
    def setUp(self):
        self.board = Board.objects.create(name="B", slug="b")
        self.backlog = Lane.objects.create(board=self.board, name="Backlog", order=0)
        self.task = services.create_task(self.board, self.backlog, "Fix the gate")
        self.jim = Owner.objects.create(name="Jim's Joinery", code="JJ")

    def test_log_add_edit_remove_restore_audited_and_counted(self):
        r = self.client.post(f"/api/tasks/{self.task.pk}/comments/",
                             {"body": "Called Jim, quote by Friday", "about_id": str(self.jim.pk)},
                             format="json")
        self.assertEqual(r.status_code, 201, r.content)
        cid = r.json()["id"]
        self.assertEqual(r.json()["about_id"], str(self.jim.pk))
        self.assertEqual(self.client.get(f"/api/tasks/{self.task.pk}/").json()["comment_count"], 1)
        self.client.patch(f"/api/comments/{cid}/", {"body": "Called Jim, quote Monday"}, format="json")
        listed = self.client.get(f"/api/tasks/{self.task.pk}/comments/").json()
        self.assertEqual((listed[0]["body"], bool(listed[0]["edited_at"])), ("Called Jim, quote Monday", True))
        self.client.patch(f"/api/comments/{cid}/", {"deleted": True}, format="json")
        self.assertEqual(self.client.get(f"/api/tasks/{self.task.pk}/comments/").json(), [])
        self.client.patch(f"/api/comments/{cid}/", {"deleted": False}, format="json")
        actions = [e.payload.get("action") for e in self.task.events.filter(
            event_type=TaskEvent.EventType.UPDATED).order_by("id")]
        self.assertEqual(actions, ["added", "edited", "removed", "restored"])
        empty = self.client.post(f"/api/tasks/{self.task.pk}/comments/", {"body": "  "}, format="json")
        self.assertEqual(empty.status_code, 400)
        hit = search("quote monday")["tasks"][0]
        self.assertEqual(hit["id"], str(self.task.pk))
        self.assertTrue(hit["snippet"].startswith("log:"))

    def test_log_happened_at(self):
        from datetime import timedelta
        from django.utils import timezone
        now = self.client.post(f"/api/tasks/{self.task.pk}/comments/", {"body": "Typed now"}, format="json").json()
        self.assertEqual(now["happened_at"][:19], now["created_at"][:19])
        yesterday = (timezone.now() - timedelta(days=1)).isoformat()
        old = self.client.post(f"/api/tasks/{self.task.pk}/comments/",
                               {"body": "Call yesterday", "happened_at": yesterday}, format="json").json()
        self.assertEqual(old["happened_at"][:16], yesterday[:16])
        self.assertNotEqual(old["happened_at"], old["created_at"])
        listed = self.client.get(f"/api/tasks/{self.task.pk}/comments/").json()
        self.assertEqual([c["body"] for c in listed], ["Typed now", "Call yesterday"])  # by happened_at
        future = (timezone.now() + timedelta(hours=1)).isoformat()
        r = self.client.post(f"/api/tasks/{self.task.pk}/comments/", {"body": "x", "happened_at": future}, format="json")
        self.assertEqual(r.status_code, 400)
        r = self.client.patch(f"/api/comments/{now['id']}/", {"happened_at": "not a date"}, format="json")
        self.assertEqual(r.status_code, 400)
        two_days = (timezone.now() - timedelta(days=2)).isoformat()
        r = self.client.patch(f"/api/comments/{now['id']}/", {"happened_at": two_days}, format="json")
        self.assertEqual(r.json()["happened_at"][:16], two_days[:16])
        self.assertIsNotNone(r.json()["edited_at"])
        last = self.task.events.filter(event_type=TaskEvent.EventType.UPDATED).order_by("id").last().payload
        self.assertEqual(last["action"], "edited")
        self.assertEqual(last["before"]["happened_at"][:19], now["happened_at"][:19])
        self.assertEqual(last["comment"]["happened_at"][:16], two_days[:16])

    def test_owner_contacts_checked(self):
        r = self.client.patch(f"/api/owners/{self.jim.pk}/", {"contacts": [
            {"kind": "phone", "data": {"number": "+44 20 7946 0958"}, "label": "Office"},
            {"kind": "email", "data": {"address": "jim@example.com"}},
            {"kind": "link", "data": {"url": "https://example.com"}},
        ]}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual([c["kind"] for c in r.json()["contacts"]], ["phone", "email", "link"])
        bad = self.client.patch(f"/api/owners/{self.jim.pk}/", {"contacts": [
            {"kind": "email", "data": {"address": "not an email"}}]}, format="json")
        self.assertEqual(bad.status_code, 400)
        bad = self.client.patch(f"/api/owners/{self.jim.pk}/", {"contacts": [
            {"kind": "fax", "data": {}}]}, format="json")
        self.assertEqual(bad.status_code, 400)

    def test_location_category(self):
        site = services.create_category("Site", board=self.board, value_type="location")
        services.update_task(self.task, {}, categories=[site])
        r = self.client.patch(f"/api/tasks/{self.task.pk}/", {"values": {
            str(site.pk): {"lat": 51.5007, "lng": -0.1246, "label": "Parliament"}}}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        data = r.json()
        self.assertEqual(data["locations"], {str(site.pk): {"lat": 51.5007, "lng": -0.1246, "label": "Parliament"}})
        self.assertEqual(data["values"], {})  # not a figure
        bad = self.client.patch(f"/api/tasks/{self.task.pk}/", {"values": {
            str(site.pk): {"lat": 123, "lng": 0}}}, format="json")
        self.assertEqual(bad.status_code, 400)
        cleared = self.client.patch(f"/api/tasks/{self.task.pk}/", {"values": {str(site.pk): None}}, format="json")
        self.assertEqual(cleared.json()["locations"], {})
        change = self.task.events.filter(event_type=TaskEvent.EventType.UPDATED).order_by("id")
        self.assertEqual(change.last().payload["changes"]["values"][str(site.pk)]["from"], "Parliament")

    def test_used_owners_shortlist(self):
        other_board = Board.objects.create(name="Other", slug="other")
        other_lane = Lane.objects.create(board=other_board, name="Backlog", order=0)
        stranger = Owner.objects.create(name="Stranger", code="ST")
        services.update_task(self.task, {}, owners=[self.jim])
        elsewhere = services.create_task(other_board, other_lane, "Elsewhere")
        services.update_task(elsewhere, {}, owners=[stranger])
        snap = self.client.get(f"/api/boards/{self.board.pk}/snapshot/").json()
        self.assertEqual(snap["used_owner_ids"], [str(self.jim.pk)])
