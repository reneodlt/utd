"""Search across every board: task titles, details and attachments, plus
board names (for jumping to a board). Plain case-insensitive substring
matching — fine at this scale, and the same on SQLite and Postgres."""

from django.db.models import Q, TextField
from django.db.models.functions import Cast

from .models import Attachment, Board, Task, TaskComment

LIMIT = 30


def _snippet(text: str, needle: str, width: int = 90) -> str:
    """The bit of `text` around the first match, on one line."""
    flat = " ".join(text.split())
    at = flat.lower().find(needle.lower())
    if at < 0:
        return ""
    start = max(0, at - width // 3)
    snippet = flat[start:start + width]
    return ("…" if start else "") + snippet + ("…" if start + width < len(flat) else "")


def _log_snippet(task: Task, needle: str) -> str:
    entry = task.comments.filter(deleted_at__isnull=True, body__icontains=needle).first()
    return f"log: {_snippet(entry.body, needle)}" if entry else ""


def search(query: str) -> dict:
    q = query.strip()
    if len(q) < 2:
        return {"boards": [], "tasks": []}
    boards = list(
        Board.objects.filter(archived_at__isnull=True, name__icontains=q).order_by("name")[:8]
    )
    live_boards = Board.objects.filter(archived_at__isnull=True)

    in_attachments = (
        Attachment.objects.annotate(text=Cast("data", TextField()))
        .filter(archived_at__isnull=True)
        .filter(Q(label__icontains=q) | Q(text__icontains=q))
        .values_list("task_id", flat=True)
    )
    in_log = (
        TaskComment.objects.filter(deleted_at__isnull=True, body__icontains=q)
        .values_list("task_id", flat=True)
    )
    tasks = list(
        Task.objects.filter(board__in=live_boards)
        .filter(Q(title__icontains=q) | Q(description__icontains=q) | Q(pk__in=in_attachments)
                | Q(pk__in=in_log))
        .select_related("board", "lane", "parent")
        .order_by("-updated_at")[:200]
    )

    def rank(t: Task):
        title = t.title.lower()
        needle = q.lower()
        match = 0 if title.startswith(needle) else 1 if needle in title else 2
        off_board = 1 if t.archived_at else 0  # open tasks first
        return (off_board, match, -t.updated_at.timestamp())

    tasks.sort(key=rank)
    results = []
    for t in tasks[:LIMIT]:
        in_title = q.lower() in t.title.lower()
        results.append({
            "id": str(t.pk),
            "title": t.title,
            "board": {"id": str(t.board_id), "name": t.board.name, "slug": t.board.slug},
            "lane": t.lane.name,
            "state": "deleted" if t.deleted_at else "archived" if t.archived_at else "open",
            "parent_title": t.parent.title if t.parent else None,
            "due_date": t.due_date.isoformat() if t.due_date else None,
            # Where it matched, when not in the title.
            "snippet": "" if in_title else (_snippet(t.description, q) or _log_snippet(t, q)
                                            or "in an attachment"),
        })
    return {
        "boards": [{"id": str(b.pk), "name": b.name, "slug": b.slug} for b in boards],
        "tasks": results,
    }
