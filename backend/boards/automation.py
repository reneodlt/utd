"""Board automations: "when X, only if Y, then Z", run after each audit
event is written (services._record calls apply_rules).

Rules act through the service layer as "rule:<name>" (source system), so
what they do is audited and broadcast like anything else. A rule's own
changes may set off other rules once (one hop) and never itself; each time
a rule fires it leaves a RuleRun, with any action that couldn't be done.

A rule on a board runs for that board's tasks; with scope "family" also
for its sub-boards' tasks, lanes matched by name (as the board family
matches them)."""

from contextvars import ContextVar
from datetime import timedelta

from django.core.exceptions import ObjectDoesNotExist
from django.db import transaction
from django.db.models import Max, Q
from django.utils import timezone

from . import services
from .models import AutomationRule, Board, Category, Lane, Owner, RuleRun, Source, Task, TaskEvent

RULE_ACTOR_PREFIX = "rule:"
MAX_HOPS = 1

_hops: ContextVar[int] = ContextVar("rule_hops", default=0)
_chain: ContextVar[frozenset] = ContextVar("rule_chain", default=frozenset())

WHENS = ("moved", "created", "archived", "deleted", "unblocked", "subtasks_done")
CONDITIONS = ("title_contains", "has_category", "has_owner", "no_owner", "is_subtask",
              "is_parent", "by_person")
ACTIONS = ("set_animation", "create_subtasks", "move", "set_due", "add_category",
           "remove_category", "owners", "archive")
SCOPES = ("board", "family")


class RuleError(ValueError):
    pass


# ---------- reading rules (old ones included) ----------

_OLD_WHEN = {"task.moved": "moved", "task.created": "created", "task.archived": "archived",
             "task.deleted": "deleted"}


def normalized(rule: AutomationRule) -> tuple[dict, list, list]:
    """The rule's trigger, conditions and actions in the current format,
    reading rules written before the editor too."""
    trigger = dict(rule.trigger or {})
    conditions = list(rule.conditions or [])
    actions = list(rule.actions or [])
    if "when" not in trigger:
        new = {"when": _OLD_WHEN.get(trigger.get("event"), "")}
        if trigger.get("to_lane"):
            new["lane"] = trigger["to_lane"]
        if trigger.get("from_lane"):
            new["from_lane"] = trigger["from_lane"]
        if trigger.get("title_contains"):
            conditions.append({"type": "title_contains", "text": trigger["title_contains"]})
        trigger = new
    upgraded = []
    for action in actions:
        kind = action.get("type")
        if kind == "create_subtask":
            upgraded.append({"type": "create_subtasks", "lane": action.get("lane"),
                             "items": [{"title": action.get("title") or "Subtask"}]})
        elif kind == "move_task":
            upgraded.append({"type": "move", "lane": action.get("to_lane")})
        else:
            upgraded.append(action)
    return trigger, conditions, upgraded


# ---------- running them ----------

def _key(name: str) -> str:
    return " ".join(name.split()).lower()


def _lane_matches(rule: AutomationRule, wanted_id, lane: Lane | None) -> bool:
    if lane is None or not wanted_id:
        return False
    if str(lane.pk) == str(wanted_id):
        return True
    if rule.scope != "family":
        return False
    wanted = Lane.objects.filter(pk=wanted_id).first()
    return bool(wanted) and wanted.board_id != lane.board_id and _key(wanted.name) == _key(lane.name)


def _lane_on(board: Board, lane_id) -> Lane | None:
    """The rule's lane, or (for a sub-board's task) the same-named lane there."""
    wanted = Lane.objects.filter(pk=lane_id, archived_at__isnull=True).first()
    if wanted is None:
        return None
    if wanted.board_id == board.pk:
        return wanted
    return next((l for l in services._active_lanes(board) if _key(l.name) == _key(wanted.name)), None)


def _became_done(event: TaskEvent) -> bool:
    """Did this event take the task from unfinished to finished?"""
    if event.event_type == TaskEvent.EventType.MOVED:
        return bool(event.to_lane and event.to_lane.is_final
                    and not (event.from_lane and event.from_lane.is_final))
    if event.event_type == TaskEvent.EventType.ARCHIVED:
        return not (event.from_lane and event.from_lane.is_final)
    if event.event_type == TaskEvent.EventType.DELETED:
        return (event.payload or {}).get("from") != "archive" and not (
            event.from_lane and event.from_lane.is_final)
    return False


def _targets(rule: AutomationRule, trigger: dict, event: TaskEvent, task: Task) -> list[Task]:
    when = trigger.get("when")
    kind = event.event_type
    E = TaskEvent.EventType
    if when == "moved":
        if kind != E.MOVED or event.from_lane_id == event.to_lane_id:
            return []
        if trigger.get("final") and not (event.to_lane and event.to_lane.is_final):
            return []
        if trigger.get("lane") and not _lane_matches(rule, trigger["lane"], event.to_lane):
            return []
        if trigger.get("from_lane") and not _lane_matches(rule, trigger["from_lane"], event.from_lane):
            return []
        return [task]
    if when == "created":
        if kind != E.CREATED:
            return []
        if trigger.get("lane") and not _lane_matches(rule, trigger["lane"], event.to_lane):
            return []
        return [task]
    if when == "archived":
        return [task] if kind == E.ARCHIVED else []
    if when == "deleted":
        return [task] if kind == E.DELETED else []
    if when == "unblocked":
        return [task] if kind == E.UPDATED and (event.payload or {}).get("unblocked_by") else []
    if when == "subtasks_done":
        parent = task.parent
        if parent is None or parent.archived_at is not None or not _became_done(event):
            return []
        still_open = parent.subtasks.filter(archived_at__isnull=True).select_related("lane")
        if any(not t.lane.is_final for t in still_open):
            return []
        return [parent]
    return []


def _condition_ok(condition: dict, event: TaskEvent, target: Task) -> bool:
    kind = condition.get("type")
    if kind == "title_contains":
        return str(condition.get("text", "")).lower() in target.title.lower()
    if kind == "has_category":
        present = target.categories.filter(pk=condition.get("category")).exists()
        return present != bool(condition.get("negate"))
    if kind == "has_owner":
        return target.owners.filter(pk=condition.get("owner")).exists()
    if kind == "no_owner":
        return not target.owners.filter(archived_at__isnull=True).exists()
    if kind == "is_subtask":
        return target.parent_id is not None
    if kind == "is_parent":
        return target.subtasks.filter(archived_at__isnull=True).exists()
    if kind == "by_person":
        return (event.source != Source.SYSTEM and not event.actor.startswith(RULE_ACTOR_PREFIX)
                and event.actor != services.AUTO_OWNER_ACTOR)
    return False


def _usable_category(category_id, board: Board) -> Category:
    category = Category.objects.get(pk=category_id, archived_at__isnull=True)
    if category.board_id not in (None, board.pk):
        raise services.ServiceError(f"{category.name} isn’t available on {board.name}")
    return category


def _act(action: dict, rule: AutomationRule, event: TaskEvent, target: Task) -> None:
    kind = action.get("type")
    who = {"actor": f"{RULE_ACTOR_PREFIX}{rule.name}", "source": Source.SYSTEM}
    board = target.board
    if kind == "set_animation":
        # A flourish on the event that set it off; a caller's own wins.
        if target.pk == event.task_id and not event.animation:
            name = services._clean_animation(board, action.get("name", ""))
            if name:
                event.animation = name
                event.save(update_fields=["animation"])
    elif kind == "create_subtasks":
        lane = _lane_on(board, action["lane"]) if action.get("lane") else target.lane
        if lane is None:
            raise services.ServiceError("its lane is gone")
        for item in action.get("items") or []:
            title = str(item.get("title") or "").strip()[:300]
            if not title or target.subtasks.filter(title=title, archived_at__isnull=True).exists():
                continue
            due = item.get("due_days")
            sub = services.create_task(
                board, lane, title, parent=target,
                due_date=(timezone.localdate() + timedelta(days=int(due))).isoformat()
                if due is not None else None,
                **who)
            categories = [c for c in (_try_category(cid, board) for cid in item.get("category_ids") or []) if c]
            if categories:
                given = item.get("values") or {}
                values = {c: given[str(c.pk)] for c in categories if c.value_type and str(c.pk) in given}
                services.update_task(sub, {}, categories=categories, values=values or ..., **who)
    elif kind == "move":
        if action.get("final"):
            lane = services._active_lanes(board).filter(is_final=True).first()
        else:
            lane = _lane_on(board, action.get("lane"))
        if lane is None:
            raise services.ServiceError("its lane is gone" if not action.get("final")
                                        else f"{board.name} has no final lane")
        if lane.pk != target.lane_id:
            services.move_task(target, lane, None, **who)
    elif kind == "set_due":
        days = action.get("days")
        due = None if days is None else (timezone.localdate() + timedelta(days=int(days))).isoformat()
        services.update_task(target, {"due_date": due}, **who)
    elif kind in ("add_category", "remove_category"):
        category = _usable_category(action.get("category"), board)
        current = list(target.categories.all())
        has = any(c.pk == category.pk for c in current)
        if kind == "add_category" and not has:
            services.update_task(target, {}, categories=current + [category], **who)
        elif kind == "remove_category" and has:
            services.update_task(target, {}, categories=[c for c in current if c.pk != category.pk], **who)
    elif kind == "owners":
        mode = action.get("mode", "set")
        chosen = list(Owner.objects.filter(pk__in=action.get("owners") or [], archived_at__isnull=True))
        if mode == "clear":
            owners = []
        elif mode == "add":
            owners = list({o.pk: o for o in [*target.owners.all(), *chosen]}.values())
        else:
            owners = chosen
        services.update_task(target, {}, owners=owners, **who)
    elif kind == "archive":
        services.archive_task(target, **who)
    else:
        raise services.ServiceError(f"unknown action {kind}")


def _try_category(category_id, board):
    try:
        return _usable_category(category_id, board)
    except (ObjectDoesNotExist, services.ServiceError, ValueError):
        return None


def apply_rules(event: TaskEvent, task: Task) -> None:
    hops = _hops.get()
    if hops > MAX_HOPS:
        return
    from .family import ancestor_ids
    chain = _chain.get()
    rules = (
        AutomationRule.objects.filter(enabled=True, archived_at__isnull=True)
        .filter(Q(board_id=task.board_id) | Q(board_id__in=list(ancestor_ids(task.board_id)), scope="family"))
        .order_by("position", "created_at")
    )
    for rule in rules:
        if rule.pk in chain:
            continue
        trigger, conditions, actions = normalized(rule)
        try:
            targets = _targets(rule, trigger, event, task)
        except (ObjectDoesNotExist, ValueError):
            continue
        for target in targets:
            if not all(_condition_ok(c, event, target) for c in conditions):
                continue
            errors = []
            hop_token = _hops.set(hops + 1)
            chain_token = _chain.set(chain | {rule.pk})
            try:
                with services._caused_by(event):
                    for action in actions:
                        try:
                            # A failed action must never undo the change
                            # that set the rule off, nor the rule's others.
                            with transaction.atomic():
                                target.refresh_from_db()
                                _act(action, rule, event, target)
                        except (services.ServiceError, ObjectDoesNotExist, KeyError,
                                ValueError, TypeError) as exc:
                            errors.append(f"{describe_action_kind(action)}: {exc}")
            finally:
                _chain.reset(chain_token)
                _hops.reset(hop_token)
            RuleRun.objects.create(rule=rule, task=target, event=event, error="; ".join(errors))


def describe_action_kind(action: dict) -> str:
    return {
        "set_animation": "animation", "create_subtasks": "add subtasks", "move": "move",
        "set_due": "deadline", "add_category": "add category", "remove_category": "remove category",
        "owners": "owners", "archive": "archive",
    }.get(action.get("type"), str(action.get("type")))


# ---------- checking a rule before it's saved ----------

def _lane_id(board: Board, value, what: str) -> str:
    lane = Lane.objects.filter(pk=value, board=board, archived_at__isnull=True).first() if value else None
    if lane is None:
        raise RuleError(f"pick a lane on {board.name} for {what}")
    return str(lane.pk)


def _category_id(board: Board, value) -> str:
    category = Category.objects.filter(pk=value, archived_at__isnull=True).first() if value else None
    if category is None or category.board_id not in (None, board.pk):
        raise RuleError("pick a category this board can use")
    return str(category.pk)


def _owner_ids(values) -> list[str]:
    if not isinstance(values, list):
        raise RuleError("owners must be a list")
    found = {str(o.pk) for o in Owner.objects.filter(pk__in=[str(v) for v in values], archived_at__isnull=True)}
    if len(found) != len(set(map(str, values))):
        raise RuleError("unknown or removed owner")
    return sorted(found)


def clean_trigger(board: Board, trigger) -> dict:
    if not isinstance(trigger, dict) or trigger.get("when") not in WHENS:
        raise RuleError("choose what sets the rule off")
    when = trigger["when"]
    out = {"when": when}
    if when == "moved":
        if trigger.get("final"):
            out["final"] = True
        elif trigger.get("lane"):
            out["lane"] = _lane_id(board, trigger["lane"], "“moves into”")
        if trigger.get("from_lane"):
            out["from_lane"] = _lane_id(board, trigger["from_lane"], "“moves from”")
    elif when == "created" and trigger.get("lane"):
        out["lane"] = _lane_id(board, trigger["lane"], "“created in”")
    return out


def clean_conditions(board: Board, conditions) -> list:
    if conditions in (None, ""):
        return []
    if not isinstance(conditions, list):
        raise RuleError("conditions must be a list")
    out = []
    for c in conditions:
        kind = isinstance(c, dict) and c.get("type")
        if kind not in CONDITIONS:
            raise RuleError(f"unknown condition: {kind}")
        if kind == "title_contains":
            text = str(c.get("text") or "").strip()
            if not text:
                raise RuleError("say what the title should contain")
            out.append({"type": kind, "text": text[:100]})
        elif kind == "has_category":
            out.append({"type": kind, "category": _category_id(board, c.get("category")),
                        **({"negate": True} if c.get("negate") else {})})
        elif kind == "has_owner":
            owner = _owner_ids([c.get("owner")]) if c.get("owner") else []
            if not owner:
                raise RuleError("pick an owner")
            out.append({"type": kind, "owner": owner[0]})
        else:
            out.append({"type": kind})
    return out


def clean_actions(board: Board, actions) -> list:
    if not isinstance(actions, list) or not actions:
        raise RuleError("add at least one thing for the rule to do")
    out = []
    for a in actions:
        kind = isinstance(a, dict) and a.get("type")
        if kind not in ACTIONS:
            raise RuleError(f"unknown action: {kind}")
        if kind == "set_animation":
            name = str(a.get("name") or "")
            if name not in board.enabled_animations():
                raise RuleError("pick one of the board’s animations")
            out.append({"type": kind, "name": name})
        elif kind == "create_subtasks":
            items = []
            for item in a.get("items") or []:
                title = str((item or {}).get("title") or "").strip()
                if not title:
                    continue
                clean = {"title": title[:300]}
                if item.get("due_days") is not None:
                    days = int(item["due_days"])
                    if not -365 <= days <= 3650:
                        raise RuleError("a subtask deadline is too far away")
                    clean["due_days"] = days
                cats = [_category_id(board, cid) for cid in item.get("category_ids") or []]
                if cats:
                    clean["category_ids"] = cats
                    vals = {k: v for k, v in (item.get("values") or {}).items() if k in cats}
                    if vals:
                        clean["values"] = vals
                items.append(clean)
            if not items:
                raise RuleError("give at least one subtask a title")
            out.append({"type": kind, "items": items,
                        **({"lane": _lane_id(board, a["lane"], "the subtasks")} if a.get("lane") else {})})
        elif kind == "move":
            if a.get("final"):
                out.append({"type": kind, "final": True})
            else:
                out.append({"type": kind, "lane": _lane_id(board, a.get("lane"), "the move")})
        elif kind == "set_due":
            days = a.get("days")
            if days is not None:
                days = int(days)
                if not -365 <= days <= 3650:
                    raise RuleError("that deadline is too far away")
            out.append({"type": kind, "days": days})
        elif kind in ("add_category", "remove_category"):
            out.append({"type": kind, "category": _category_id(board, a.get("category"))})
        elif kind == "owners":
            mode = a.get("mode", "set")
            if mode not in ("set", "add", "clear"):
                raise RuleError("owners: set, add or clear")
            owners = [] if mode == "clear" else _owner_ids(a.get("owners") or [])
            if mode != "clear" and not owners:
                raise RuleError("pick at least one owner")
            out.append({"type": kind, "mode": mode, "owners": owners})
        else:
            out.append({"type": kind})
    return out


def save_rule(board: Board, data: dict, rule: AutomationRule | None = None) -> AutomationRule:
    """Create or update a rule from the editor, checking every reference."""
    try:
        name = str(data.get("name", rule.name if rule else "") or "").strip()
        if not name:
            raise RuleError("give the rule a name")
        clash = AutomationRule.objects.filter(board=board, archived_at__isnull=True, name__iexact=name)
        if rule:
            clash = clash.exclude(pk=rule.pk)
        if clash.exists():
            raise RuleError(f"there’s already a rule called “{name}” on this board")
        scope = data.get("scope", rule.scope if rule else "board")
        if scope not in SCOPES:
            raise RuleError("scope is board or family")
        if rule is None and ("trigger" not in data or "actions" not in data):
            raise RuleError("a rule needs a trigger and at least one action")
        current = normalized(rule) if rule else ({}, [], [])
        trigger = clean_trigger(board, data["trigger"]) if "trigger" in data else current[0]
        conditions = clean_conditions(board, data["conditions"]) if "conditions" in data else current[1]
        actions = clean_actions(board, data["actions"]) if "actions" in data else current[2]
    except (TypeError, ValueError) as exc:
        raise RuleError(str(exc)) from None
    fields = {"name": name[:100], "scope": scope, "trigger": trigger, "conditions": conditions,
              "actions": actions}
    if "enabled" in data:
        fields["enabled"] = bool(data["enabled"])
    if rule is None:
        last = AutomationRule.objects.filter(board=board).aggregate(Max("position"))["position__max"]
        return AutomationRule.objects.create(board=board, position=(last or 0) + 1, **fields)
    for key, value in fields.items():
        setattr(rule, key, value)
    rule.save()
    return rule


# ---------- what the editor shows ----------

def problems(rule: AutomationRule) -> list[str]:
    """References that no longer work (removed lanes, categories, owners)."""
    trigger, conditions, actions = normalized(rule)
    found = []

    def lane(value, what):
        if value and not Lane.objects.filter(pk=value, archived_at__isnull=True).exists():
            found.append(f"{what}: that lane was removed")

    def category(value, what):
        if value and not Category.objects.filter(pk=value, archived_at__isnull=True).exists():
            found.append(f"{what}: that category was removed")

    lane(trigger.get("lane"), "When")
    lane(trigger.get("from_lane"), "When")
    for c in conditions:
        if c.get("type") == "has_category":
            category(c.get("category"), "Only if")
        if c.get("type") == "has_owner" and not Owner.objects.filter(
                pk=c.get("owner"), archived_at__isnull=True).exists():
            found.append("Only if: that owner was removed")
    for a in actions:
        if a.get("type") in ("move", "create_subtasks"):
            lane(a.get("lane"), "Then")
        if a.get("type") in ("add_category", "remove_category"):
            category(a.get("category"), "Then")
        if a.get("type") == "owners" and len(a.get("owners") or []) != Owner.objects.filter(
                pk__in=a.get("owners") or [], archived_at__isnull=True).count():
            found.append("Then: an owner was removed")
    if trigger.get("when") not in WHENS:
        found.append("When: this rule’s trigger isn’t one the editor knows")
    return found


def names(trigger: dict, conditions: list, actions: list) -> dict:
    """Display names for every lane, category and owner a rule mentions."""
    lanes, categories, owners = set(), set(), set()
    for key in ("lane", "from_lane"):
        if trigger.get(key):
            lanes.add(str(trigger[key]))
    for c in conditions:
        if c.get("category"):
            categories.add(str(c["category"]))
        if c.get("owner"):
            owners.add(str(c["owner"]))
    for a in actions:
        if a.get("lane"):
            lanes.add(str(a["lane"]))
        if a.get("category"):
            categories.add(str(a["category"]))
        owners.update(str(o) for o in a.get("owners") or [])
        for item in a.get("items") or []:
            categories.update(str(c) for c in item.get("category_ids") or [])
    out = {}
    out.update({str(l.pk): l.name for l in Lane.objects.filter(pk__in=lanes)})
    out.update({str(c.pk): c.name for c in Category.objects.filter(pk__in=categories)})
    out.update({str(o.pk): o.name for o in Owner.objects.filter(pk__in=owners)})
    return out
