import uuid

from django.db import models
from django.utils import timezone

# Gap between positions for appended/renumbered tasks; midpoint insertion
# halves gaps until REBALANCE_THRESHOLD forces a lane renumber.
POSITION_GAP = 1024.0
REBALANCE_THRESHOLD = 1e-6


class Source(models.TextChoices):
    UI = "ui"
    API = "api"
    SYSTEM = "system"
    ADMIN = "admin"


class Board(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=200)
    slug = models.SlugField(unique=True)
    # Boards nest; a board shows its own tasks plus all its descendants'.
    # No parent = a top-level board. Cycles are refused by the service layer.
    parent = models.ForeignKey(
        "self", null=True, blank=True, on_delete=models.SET_NULL, related_name="children"
    )
    # {"enabled": ["slide", "pulse", ...], "default": "slide"}
    animation_catalogue = models.JSONField(default=dict, blank=True)
    metadata = models.JSONField(default=dict, blank=True)
    # "" for an ordinary board; "inbox" for the one catch-all board where
    # quick notes land before they're given a board (kept out of the board
    # list and of every family).
    kind = models.CharField(max_length=20, blank=True, default="")
    # Soft delete: archived boards keep their tasks and audit trail but drop
    # out of the board list. Nothing hard-deletes through the API.
    archived_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return self.name

    def enabled_animations(self) -> list[str]:
        return self.animation_catalogue.get("enabled", [])


class Lane(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    board = models.ForeignKey(Board, on_delete=models.CASCADE, related_name="lanes")
    name = models.CharField(max_length=100)
    order = models.PositiveIntegerField(default=0)
    color = models.CharField(max_length=7, default="#6b7280")
    wip_limit = models.PositiveIntegerField(null=True, blank=True)
    # A "done" lane: tasks here count as resolved (stop blocking, subtasks
    # count as done, cycle time ends) and the lane offers "Archive all".
    # A board may have several (Done, Won't do) or none.
    is_final = models.BooleanField(default=False)
    # Removed lanes are hidden, never deleted: off-board tasks still point
    # at them and the audit trail names them.
    archived_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["order"]
        indexes = [models.Index(fields=["board", "order"])]

    def __str__(self):
        return f"{self.board.name} / {self.name}"


class Owner(models.Model):
    """Someone (or something — a team, a company) a task can belong to.
    Shared across boards. Shown as a badge: the emoji if set, else the
    short code, in the chosen colours. Soft-deleted: archived owners keep
    their name for history but drop out of pickers and filters."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=100)
    code = models.CharField(max_length=5)
    fg = models.CharField(max_length=7, default="#ffffff")
    bg = models.CharField(max_length=7, default="#4f46e5")
    emoji = models.CharField(max_length=16, blank=True, default="")
    # Ways to reach them, as attachment-kind records ({"kind": "phone" |
    # "email" | "link" | "place", "data": {...}, "label"?}), for owners who
    # are outside people or companies.
    contacts = models.JSONField(default=list, blank=True)
    position = models.FloatField(default=POSITION_GAP)
    archived_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["position", "created_at"]

    def __str__(self):
        return f"{self.name} ({self.code})"


class Category(models.Model):
    """A label for tasks. Shared by every board when `board` is empty, or
    belonging to one board. Names are unique (ignoring case) among the
    categories a board can see. Soft-deleted like owners."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    board = models.ForeignKey(
        Board, null=True, blank=True, on_delete=models.CASCADE, related_name="categories"
    )
    name = models.CharField(max_length=60)
    color = models.CharField(max_length=7, default="#6366f1")
    position = models.FloatField(default=POSITION_GAP)
    # What a task in this category can carry a figure for (see measures.py):
    # "" = nothing, else money / duration / number / percent. Settings in
    # value_config, e.g. {"currency": "GBP"} or {"unit": "mi"}.
    value_type = models.CharField(max_length=20, blank=True, default="")
    value_config = models.JSONField(default=dict, blank=True)
    archived_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["position", "created_at"]
        verbose_name_plural = "categories"

    def __str__(self):
        return self.name

    @property
    def shared(self) -> bool:
        return self.board_id is None


class Task(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    # board is denormalized from lane so a snapshot is a single filter
    board = models.ForeignKey(Board, on_delete=models.CASCADE, related_name="tasks")
    lane = models.ForeignKey(Lane, on_delete=models.PROTECT, related_name="tasks")
    parent = models.ForeignKey(
        "self", null=True, blank=True, on_delete=models.SET_NULL, related_name="subtasks"
    )
    title = models.CharField(max_length=300)
    description = models.TextField(blank=True, default="")
    position = models.FloatField(default=POSITION_GAP)
    metadata = models.JSONField(default=dict, blank=True)
    # Optional deadline (a day, not a moment): drives the "deadline" card
    # colouring and the due chip.
    due_date = models.DateField(null=True, blank=True)
    # Keep its subtasks off the board (they still exist, and show on this
    # card and in its drawer).
    hide_subtasks = models.BooleanField(default=False)
    # A parent's owners follow its next-up subtask's owners; setting them
    # by hand turns this off (someone owning the process, not the steps).
    owner_follows_next = models.BooleanField(default=True)
    owners = models.ManyToManyField(Owner, blank=True, related_name="tasks")
    categories = models.ManyToManyField(Category, blank=True, related_name="tasks")
    # Convenience mirror of the audit trail; TaskEvent is authoritative.
    lane_entered_at = models.DateTimeField(default=timezone.now)
    # Off the board: archived (done with, kept for reference) or also
    # deleted (binned). A deleted task always has archived_at set too, so
    # "archived_at is null" alone means "on the board". Both reversible.
    archived_at = models.DateTimeField(null=True, blank=True)
    deleted_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["position"]
        indexes = [
            models.Index(fields=["lane", "position"]),
            models.Index(fields=["board", "archived_at"]),
        ]

    def __str__(self):
        return self.title

    def ancestors(self):
        node, seen = self.parent, {self.pk}
        while node is not None and node.pk not in seen:
            yield node
            seen.add(node.pk)
            node = node.parent


class TaskLink(models.Model):
    """Directed, typed edge in the task graph. Inverse labels (blocked-by)
    are derived by readers. Parent/subtask lives on Task.parent, and sibling
    is derived from a shared parent — neither is stored here."""

    class LinkType(models.TextChoices):
        BLOCKS = "blocks"
        RELATES_TO = "relates_to"
        SIMILAR_TO = "similar_to"
        MILESTONE_OF = "milestone_of"
        DUPLICATES = "duplicates"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    from_task = models.ForeignKey(Task, on_delete=models.CASCADE, related_name="links_out")
    to_task = models.ForeignKey(Task, on_delete=models.CASCADE, related_name="links_in")
    link_type = models.CharField(max_length=20, choices=LinkType.choices)
    metadata = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["from_task", "to_task", "link_type"], name="unique_task_link"
            )
        ]

    def __str__(self):
        return f"{self.from_task_id} {self.link_type} {self.to_task_id}"


class Attachment(models.Model):
    """A reference a task carries: a web page, phone number, place, calendar
    entry... `kind` names an entry in boards.attachments.KINDS, which
    validates `data`; new kinds need no migration. Soft-deleted like tasks.

    Kind "file" (photos, documents) also stores the upload itself, plus a
    thumbnail for images, under MEDIA_ROOT."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    task = models.ForeignKey(Task, on_delete=models.CASCADE, related_name="attachments")
    kind = models.CharField(max_length=40)
    label = models.CharField(max_length=200, blank=True, default="")
    data = models.JSONField(default=dict, blank=True)
    file = models.FileField(upload_to="uploads/%Y/%m/", null=True, blank=True)
    thumb = models.FileField(upload_to="uploads/%Y/%m/thumbs/", null=True, blank=True)
    position = models.FloatField(default=POSITION_GAP)
    archived_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["position", "created_at"]
        indexes = [models.Index(fields=["task", "archived_at"])]

    def __str__(self):
        return self.label or f"{self.kind} {self.data}"


class AutomationRule(models.Model):
    """"When X, only if Y, then Z" for a board, run after each audit event
    (see automation.py for the vocabulary):

    trigger:    {"when": "moved", "lane"?: <uuid>, "from_lane"?, "final"?: true}
                {"when": "created", "lane"?}, {"when": "archived" | "deleted" |
                "unblocked" | "subtasks_done"}
    conditions: [{"type": "title_contains", "text"}, {"type": "has_category",
                "category", "negate"?}, {"type": "has_owner", "owner"},
                {"type": "no_owner"}, {"type": "is_subtask"}, {"type": "is_parent"},
                {"type": "by_person"}]
    actions:    [{"type": "set_animation", "name"}, {"type": "create_subtasks",
                "items": [{"title", "due_days"?, "category_ids"?, "values"?}],
                "lane"?}, {"type": "move", "lane"? | "final"?}, {"type": "set_due",
                "days": int | null}, {"type": "add_category" | "remove_category",
                "category"}, {"type": "owners", "mode": "set" | "add" | "clear",
                "owners"}, {"type": "archive"}]

    `scope` "family" also runs it for its sub-boards' tasks (lanes matched
    by name). Removing a rule archives it."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    board = models.ForeignKey(Board, on_delete=models.CASCADE, related_name="rules")
    name = models.CharField(max_length=100)
    enabled = models.BooleanField(default=True)
    scope = models.CharField(max_length=10, default="board")
    trigger = models.JSONField(default=dict)
    conditions = models.JSONField(default=list, blank=True)
    actions = models.JSONField(default=list)
    position = models.FloatField(default=0)
    archived_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["position", "created_at"]

    def __str__(self):
        return f"{self.board.name} / {self.name}"


class RuleRun(models.Model):
    """One time a rule fired: on which task, set off by which event, and
    what went wrong if an action couldn't be done."""

    id = models.BigAutoField(primary_key=True)
    rule = models.ForeignKey(AutomationRule, on_delete=models.CASCADE, related_name="runs")
    task = models.ForeignKey(Task, on_delete=models.CASCADE, related_name="rule_runs")
    event = models.ForeignKey("TaskEvent", null=True, blank=True, on_delete=models.SET_NULL,
                              related_name="+")
    error = models.TextField(blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-id"]


class TaskValue(models.Model):
    """A task's figure for one of its categories: £ for a cost category,
    minutes for a time one, and so on. One per (task, category). The row
    stays when the category comes off the task (hidden, back if it
    returns); `value_type` records what the amount meant when written, so
    a category that changes type doesn't reinterpret old figures."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    task = models.ForeignKey(Task, on_delete=models.CASCADE, related_name="values")
    category = models.ForeignKey(Category, on_delete=models.CASCADE, related_name="task_values")
    value_type = models.CharField(max_length=20)
    amount = models.DecimalField(max_digits=18, decimal_places=4)
    # Non-numeric figures: a location's {"lat", "lng", "label"} (amount 0).
    data = models.JSONField(null=True, blank=True)
    # Set when the figure changes after the task is done (final lane or
    # archived): the figure as it stood, kept as the estimate; `amount` is
    # then the actual.
    estimate = models.DecimalField(max_digits=18, decimal_places=4, null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["task", "category"], name="unique_task_value")
        ]


class TaskComment(models.Model):
    """A log entry on a task: notes, calls, progress — timestamped, and
    optionally about (or with) one of the owners. Soft-deleted."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    task = models.ForeignKey(Task, on_delete=models.CASCADE, related_name="comments")
    body = models.TextField()
    about = models.ForeignKey(Owner, null=True, blank=True, on_delete=models.SET_NULL,
                              related_name="comments")
    actor = models.CharField(max_length=200, default="anonymous")
    # When it happened (a call yesterday, logged today); created_at stays
    # as when it was typed. The log is ordered by this.
    happened_at = models.DateTimeField(default=timezone.now, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)
    edited_at = models.DateTimeField(null=True, blank=True)
    deleted_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-happened_at", "-created_at"]


class TaskEvent(models.Model):
    """Append-only audit trail. event_type strings match the websocket
    message types exactly; the BigAutoField id doubles as a resume cursor."""

    class EventType(models.TextChoices):
        CREATED = "task.created"
        MOVED = "task.moved"
        UPDATED = "task.updated"
        ARCHIVED = "task.archived"
        DELETED = "task.deleted"
        RESTORED = "task.restored"
        LINKED = "task.linked"
        UNLINKED = "task.unlinked"

    id = models.BigAutoField(primary_key=True)
    board = models.ForeignKey(Board, on_delete=models.CASCADE, related_name="events")
    task = models.ForeignKey(Task, on_delete=models.CASCADE, related_name="events")
    event_type = models.CharField(max_length=40, choices=EventType.choices)
    actor = models.CharField(max_length=200, default="anonymous")
    source = models.CharField(max_length=20, choices=Source.choices, default=Source.API)
    from_lane = models.ForeignKey(
        Lane, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    to_lane = models.ForeignKey(
        Lane, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    payload = models.JSONField(default=dict, blank=True)
    animation = models.CharField(max_length=50, blank=True, default="")
    op_id = models.CharField(max_length=64, blank=True, default="")
    # The event that set this one off: the triggering event for automation
    # rule actions, the blocker's move/archive for unblock ripples. Null for
    # events a caller asked for directly.
    caused_by = models.ForeignKey(
        "self", null=True, blank=True, on_delete=models.SET_NULL, related_name="effects"
    )
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        ordering = ["-id"]
        indexes = [
            models.Index(fields=["task", "created_at"]),
            models.Index(fields=["board", "-created_at"]),
        ]

    def __str__(self):
        return f"#{self.id} {self.event_type} {self.task_id}"
