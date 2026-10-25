from rest_framework import serializers

from .models import Attachment, Board, Category, Lane, Owner, Task, TaskEvent, TaskLink


class LaneSerializer(serializers.ModelSerializer):
    class Meta:
        model = Lane
        fields = ["id", "board_id", "name", "order", "color", "wip_limit", "is_final"]


class BoardSerializer(serializers.ModelSerializer):
    lanes = serializers.SerializerMethodField()
    parent_id = serializers.UUIDField(read_only=True, allow_null=True)

    class Meta:
        model = Board
        fields = ["id", "name", "slug", "parent_id", "kind", "animation_catalogue", "metadata",
                  "lanes", "hours_per_day"]

    hours_per_day = serializers.SerializerMethodField()

    def get_hours_per_day(self, board):
        from .services import hours_per_day
        return hours_per_day(board)


    def get_lanes(self, board):
        return LaneSerializer(
            [l for l in board.lanes.all() if l.archived_at is None], many=True
        ).data

class BoardListSerializer(serializers.ModelSerializer):
    parent_id = serializers.UUIDField(read_only=True, allow_null=True)
    open_count = serializers.SerializerMethodField()

    class Meta:
        model = Board
        fields = ["id", "name", "slug", "parent_id", "kind", "open_count"]

    def get_open_count(self, board):
        """The inbox says how much is waiting in it; other boards don't."""
        if board.kind != "inbox":
            return None
        return board.tasks.filter(archived_at__isnull=True).count()


class BoardWithLanesSerializer(BoardListSerializer):
    """For choosing where a task goes: every board with its lanes."""

    lanes = serializers.SerializerMethodField()

    class Meta(BoardListSerializer.Meta):
        fields = BoardListSerializer.Meta.fields + ["lanes"]

    def get_lanes(self, board):
        return [
            {"id": str(l.pk), "name": l.name, "color": l.color, "is_final": l.is_final}
            for l in sorted(board.lanes.all(), key=lambda l: l.order)
            if l.archived_at is None
        ]


class AttachmentSerializer(serializers.ModelSerializer):
    class Meta:
        model = Attachment
        fields = ["id", "kind", "label", "data", "position", "created_at"]

    def to_representation(self, attachment):
        out = super().to_representation(attachment)
        if attachment.kind == "file" and attachment.file:
            # Where to fetch it (served by the API, not a public media URL).
            data = out["data"]
            out["data"] = {
                **data,
                # Rows from before media support have no "media" key.
                "media": data.get("media") or (
                    "image" if str(data.get("content_type", "")).startswith("image/") else "file"),
                "url": f"/api/files/{attachment.pk}/",
                **({"thumb_url": f"/api/files/{attachment.pk}/?thumb=1"} if attachment.thumb else {}),
            }
        return out


class OwnerSerializer(serializers.ModelSerializer):
    archived = serializers.SerializerMethodField()

    class Meta:
        model = Owner
        fields = ["id", "name", "code", "fg", "bg", "emoji", "contacts", "position", "archived"]

    def get_archived(self, owner):
        return owner.archived_at is not None


class CategorySerializer(serializers.ModelSerializer):
    board_id = serializers.UUIDField(read_only=True, allow_null=True)
    archived = serializers.SerializerMethodField()

    class Meta:
        model = Category
        fields = ["id", "board_id", "name", "color", "position", "value_type", "value_config",
                  "archived"]

    def get_archived(self, category):
        return category.archived_at is not None


def serialize_owners() -> list[dict]:
    """Every owner, archived ones flagged, so old history keeps its names."""
    return OwnerSerializer(Owner.objects.all(), many=True).data


class TaskLinkSerializer(serializers.ModelSerializer):
    from_task_id = serializers.UUIDField(read_only=True)
    to_task_id = serializers.UUIDField(read_only=True)

    class Meta:
        model = TaskLink
        fields = ["id", "from_task_id", "to_task_id", "link_type", "metadata"]


class TaskSerializer(serializers.ModelSerializer):
    """Full task representation — used by the REST API, the snapshot, and
    every websocket envelope, so all consumers see an identical shape."""

    board_id = serializers.UUIDField(read_only=True)
    lane_id = serializers.UUIDField(read_only=True)
    parent_id = serializers.UUIDField(read_only=True, allow_null=True)
    subtask_count = serializers.SerializerMethodField()
    blocked_by = serializers.SerializerMethodField()
    links = TaskLinkSerializer(many=True, read_only=True, source="links_out")
    attachments = serializers.SerializerMethodField()
    owner_ids = serializers.SerializerMethodField()
    category_ids = serializers.SerializerMethodField()
    values = serializers.SerializerMethodField()
    locations = serializers.SerializerMethodField()
    comment_count = serializers.SerializerMethodField()
    estimates = serializers.SerializerMethodField()

    class Meta:
        model = Task
        fields = [
            "id", "board_id", "lane_id", "parent_id", "title", "description",
            "position", "metadata", "subtask_count", "blocked_by", "links",
            "attachments", "owner_ids", "category_ids", "values", "locations", "comment_count", "estimates", "due_date", "hide_subtasks",
            "owner_follows_next", "lane_entered_at", "archived_at", "deleted_at",
            "created_at", "updated_at",
        ]

    def get_subtask_count(self, task):
        return task.subtasks.filter(archived_at__isnull=True).count()

    def get_attachments(self, task):
        # Filtered in Python so the views' prefetch is reused.
        active = [a for a in task.attachments.all() if a.archived_at is None]
        active.sort(key=lambda a: (a.position, a.created_at))
        return AttachmentSerializer(active, many=True).data

    def get_owner_ids(self, task):
        owners = sorted(task.owners.all(), key=lambda o: (o.position, o.created_at))
        return [str(o.pk) for o in owners]

    def get_category_ids(self, task):
        categories = sorted(task.categories.all(), key=lambda c: (c.position, c.created_at))
        return [str(c.pk) for c in categories]

    def get_values(self, task):
        """{category_id: amount} — figures still meaning what their category
        says (one written before the category changed type is left out)."""
        return {
            str(v.category_id): float(v.amount)
            for v in task.values.all()
            if v.value_type == v.category.value_type and v.value_type != "location"
        }

    def get_locations(self, task):
        """{category_id: {lat, lng, label?}} for location categories."""
        return {
            str(v.category_id): v.data
            for v in task.values.all()
            if v.value_type == "location" and v.category.value_type == "location" and v.data
        }

    def get_comment_count(self, task):
        count = getattr(task, "live_comments", None)
        if count is None:
            count = task.comments.filter(deleted_at__isnull=True).count()
        return count

    def get_estimates(self, task):
        """{category_id: estimate} for figures changed after the task was
        done (their `values` entry is then the actual)."""
        return {
            str(v.category_id): float(v.estimate)
            for v in task.values.all()
            if v.estimate is not None and v.value_type == v.category.value_type
        }

    def get_blocked_by(self, task):
        """Blocking is flow-aware: a blocker that reached the board's final
        lane (or was archived) no longer blocks anything."""
        return [
            str(link.from_task_id)
            for link in task.links_in.all()
            if link.link_type == TaskLink.LinkType.BLOCKS
            and link.from_task.archived_at is None
            and not link.from_task.lane.is_final
        ]


class TaskEventSerializer(serializers.ModelSerializer):
    task_id = serializers.UUIDField(read_only=True)
    from_lane_id = serializers.UUIDField(read_only=True, allow_null=True)
    to_lane_id = serializers.UUIDField(read_only=True, allow_null=True)
    # Names travel with the ids so a history survives renamed or deleted
    # lanes being unknown to the client.
    from_lane_name = serializers.CharField(
        source="from_lane.name", read_only=True, default=None
    )
    to_lane_name = serializers.CharField(source="to_lane.name", read_only=True, default=None)
    caused_by = serializers.SerializerMethodField()

    class Meta:
        model = TaskEvent
        fields = [
            "id", "task_id", "event_type", "actor", "source", "from_lane_id",
            "from_lane_name", "to_lane_id", "to_lane_name", "payload",
            "animation", "op_id", "caused_by", "created_at",
        ]

    def get_caused_by(self, event):
        """A one-line summary of the triggering event, enough to render
        "because X moved Y to Done" without a second request."""
        cause = event.caused_by
        if cause is None:
            return None
        return {
            "id": cause.id,
            "task_id": str(cause.task_id),
            "event_type": cause.event_type,
            "actor": cause.actor,
            "source": cause.source,
            "to_lane_name": cause.to_lane.name if cause.to_lane else None,
        }


def serialize_task(task: Task) -> dict:
    """Serialize a task for websocket envelopes (no request context needed)."""
    return TaskSerializer(task).data
