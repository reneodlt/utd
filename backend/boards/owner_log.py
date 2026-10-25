"""Who owned a task when, read back from its audit trail: one period per
set of owners, with who set it (a person, or "auto" following the next
subtask) and the lanes the task passed through while they had it."""

from .models import Task, TaskEvent


def owner_log(task: Task) -> list[dict]:
    periods: list[dict] = []

    def start(owner_ids, at, set_by, via_subtask=None, lane=None):
        if periods:
            periods[-1]["end"] = at.isoformat()
        periods.append({
            "owner_ids": owner_ids,
            "start": at.isoformat(),
            "end": None,
            "set_by": set_by,
            "via_subtask": via_subtask,
            "lanes": [lane] if lane else [],
        })

    def enter(lane):
        if lane and periods and (not periods[-1]["lanes"] or periods[-1]["lanes"][-1] != lane):
            periods[-1]["lanes"].append(lane)

    events = (
        TaskEvent.objects.filter(task=task)
        .select_related("to_lane")
        .order_by("id")
    )
    for event in events:
        payload = event.payload or {}
        if event.event_type == TaskEvent.EventType.CREATED:
            start([], event.created_at, event.actor,
                  lane=event.to_lane.name if event.to_lane else None)
            continue
        if not periods:  # history from before this log existed
            start([], event.created_at, event.actor)
        if event.event_type == TaskEvent.EventType.MOVED:
            enter(event.to_lane.name if event.to_lane else None)
            continue
        owners = (payload.get("changes") or {}).get("owners")
        if event.event_type == TaskEvent.EventType.UPDATED and owners:
            lane = periods[-1]["lanes"][-1] if periods[-1]["lanes"] else None
            start(list(owners.get("to") or []), event.created_at, event.actor,
                  via_subtask=payload.get("owners_from_subtask"), lane=lane)
    # Drop a leading unowned stretch that lasted no time at all (owners set
    # straight after creating).
    if len(periods) > 1 and not periods[0]["owner_ids"] and periods[0]["start"] == periods[0]["end"]:
        periods.pop(0)
    return periods
