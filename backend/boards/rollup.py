"""Figures on archived tasks, for totals. The board only loads open tasks,
so the app can't see these itself: each archived (not binned) task's
figures travel with the nearest open task above it (`anchor_id`, None when
there isn't one), which is where they roll up into. Archived work counts
as done."""

from .models import Task, TaskValue


def archived_values(board_ids) -> list[dict]:
    tasks = {
        t["id"]: t
        for t in Task.objects.filter(board_id__in=board_ids)
        .values("id", "parent_id", "archived_at", "deleted_at")
    }
    rows = (
        TaskValue.objects.filter(
            task__board_id__in=board_ids,
            task__archived_at__isnull=False,
            task__deleted_at__isnull=True,
        )
        .exclude(value_type="location")
        .select_related("category", "task")
        .prefetch_related("task__categories", "task__owners")
    )
    out = []
    for row in rows:
        category = row.category
        if category.archived_at is not None or row.value_type != category.value_type:
            continue
        category_ids = [str(c.pk) for c in row.task.categories.all()]
        if str(category.pk) not in category_ids:
            continue
        out.append({
            "task_id": str(row.task_id),
            "board_id": str(row.task.board_id),
            "category_id": str(category.pk),
            "amount": float(row.amount),
            "estimate": None if row.estimate is None else float(row.estimate),
            "title": row.task.title,
            # So the board's owner / category filters can place it.
            "owner_ids": [str(o.pk) for o in row.task.owners.all()],
            "category_ids": category_ids,
            "anchor_id": _open_ancestor(row.task_id, tasks),
        })
    return out


def _open_ancestor(task_id, tasks) -> str | None:
    seen = set()
    parent = tasks.get(task_id, {}).get("parent_id")
    while parent and parent not in seen:
        seen.add(parent)
        node = tasks.get(parent)
        if node is None:
            return None
        if node["archived_at"] is None:
            return str(parent)
        parent = node["parent_id"]
    return None
