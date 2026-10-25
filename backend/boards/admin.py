from django.contrib import admin

from .models import Attachment, AutomationRule, Board, Category, Lane, Owner, Task, TaskEvent, TaskLink

# NOTE: admin edits bypass the service layer (no audit row, no websocket
# broadcast). Treat it as a break-glass tool and a free config UI for
# boards/lanes/catalogues, not a day-to-day task editor.


class LaneInline(admin.TabularInline):
    model = Lane
    extra = 0


@admin.register(Board)
class BoardAdmin(admin.ModelAdmin):
    list_display = ["name", "slug", "created_at"]
    inlines = [LaneInline]


@admin.register(Lane)
class LaneAdmin(admin.ModelAdmin):
    list_display = ["name", "board", "order", "color", "wip_limit"]
    list_filter = ["board"]


@admin.register(Task)
class TaskAdmin(admin.ModelAdmin):
    list_display = ["title", "board", "lane", "parent", "position", "archived_at"]
    list_filter = ["board", "lane"]
    search_fields = ["title", "description"]


@admin.register(TaskLink)
class TaskLinkAdmin(admin.ModelAdmin):
    list_display = ["from_task", "link_type", "to_task", "created_at"]
    list_filter = ["link_type"]


@admin.register(Category)
class CategoryAdmin(admin.ModelAdmin):
    list_display = ["name", "board", "color", "archived_at"]
    list_filter = ["board"]


@admin.register(Owner)
class OwnerAdmin(admin.ModelAdmin):
    list_display = ["name", "code", "fg", "bg", "emoji", "archived_at"]


@admin.register(Attachment)
class AttachmentAdmin(admin.ModelAdmin):
    list_display = ["task", "kind", "label", "data", "archived_at"]
    list_filter = ["kind"]


@admin.register(AutomationRule)
class AutomationRuleAdmin(admin.ModelAdmin):
    list_display = ["name", "board", "enabled", "trigger", "created_at"]
    list_filter = ["board", "enabled"]


@admin.register(TaskEvent)
class TaskEventAdmin(admin.ModelAdmin):
    """Read-only: the audit trail is append-only, even for superusers."""

    list_display = ["id", "event_type", "task", "actor", "source",
                    "from_lane", "to_lane", "animation", "created_at"]
    list_filter = ["event_type", "source", "board"]
    search_fields = ["actor", "op_id"]

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False
