"""A board's deadlines as an iCalendar feed (subscribe from the iPhone
Calendar, etc.): every task with a due date on the board and, recursively,
its sub-boards, as an all-day event on that day. Finished tasks (in a final
lane) stay, marked ✓; archived and deleted tasks drop out."""

from datetime import timedelta, timezone

from .family import family_ids
from .models import Board, Task

PRODID = "-//UTD//Board deadlines//EN"


def _escape(text: str) -> str:
    return (text.replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,")
            .replace("\r\n", "\\n").replace("\n", "\\n"))


def _fold(line: str) -> str:
    """RFC 5545: lines over 75 octets continue on the next, space-indented."""
    out, raw = [], line.encode("utf-8")
    while len(raw) > 75:
        cut = 75 if not out else 74
        # don't split a UTF-8 sequence
        while cut > 0 and (raw[cut] & 0xC0) == 0x80:
            cut -= 1
        out.append(raw[:cut].decode("utf-8"))
        raw = raw[cut:]
    out.append(raw.decode("utf-8"))
    return "\r\n ".join(out)


def _stamp(dt) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def board_calendar(board: Board, base_url: str) -> str:
    ids = family_ids(board)
    tasks = (
        Task.objects.filter(board_id__in=ids, archived_at__isnull=True, due_date__isnull=False)
        .select_related("board", "lane", "parent")
        .order_by("due_date")
    )
    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        f"PRODID:{PRODID}",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        f"X-WR-CALNAME:{_escape(f'UTD · {board.name}')}",
        f"X-WR-CALDESC:{_escape(f'Deadlines on {board.name} and its sub-boards')}",
        # How often calendar apps should re-check (they may not honour it).
        "REFRESH-INTERVAL;VALUE=DURATION:PT30M",
        "X-PUBLISHED-TTL:PT30M",
    ]
    for task in tasks:
        done = task.lane.is_final
        title = f"✓ {task.title}" if done else task.title
        where = task.board.name if task.board_id == board.pk else f"{task.board.name} (in {board.name})"
        details = [f"{where} · {task.lane.name}"]
        if task.parent:
            details.append(f"Subtask of: {task.parent.title}")
        link = f"{base_url}/#/b/{task.board.slug}/t/{task.pk}"
        details.append(link)
        lines += [
            "BEGIN:VEVENT",
            f"UID:task-{task.pk}@utd",
            f"DTSTAMP:{_stamp(task.updated_at)}",
            f"LAST-MODIFIED:{_stamp(task.updated_at)}",
            f"DTSTART;VALUE=DATE:{task.due_date.strftime('%Y%m%d')}",
            f"DTEND;VALUE=DATE:{(task.due_date + timedelta(days=1)).strftime('%Y%m%d')}",
            f"SUMMARY:{_escape(title)}",
            f"DESCRIPTION:{_escape(chr(10).join(details))}",
            f"URL:{link}",
            f"CATEGORIES:{_escape(task.board.name)}",
            "TRANSP:TRANSPARENT",
        ]
        if not done:
            # A nudge at 9am on the day (calendar apps may drop alerts on
            # subscribed calendars, depending on settings).
            lines += ["BEGIN:VALARM", "ACTION:DISPLAY", f"DESCRIPTION:{_escape(title)}",
                      "TRIGGER:PT9H", "END:VALARM"]
        lines.append("END:VEVENT")
    lines.append("END:VCALENDAR")
    return "\r\n".join(_fold(line) for line in lines) + "\r\n"
