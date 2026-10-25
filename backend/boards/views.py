import json

from django.db import transaction
from django.db.models import Count, Prefetch, Q
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework import status
from rest_framework.decorators import api_view
from rest_framework.pagination import LimitOffsetPagination
from rest_framework.response import Response

from . import attachments, automation, family, geocode, owner_log, rollup, services
from .models import Attachment, AutomationRule, Board, Category, Lane, Owner, Source, Task, TaskComment, TaskEvent, TaskLink, TaskValue
from .serializers import (
    BoardWithLanesSerializer,
    BoardListSerializer,
    AttachmentSerializer,
    BoardSerializer,
    CategorySerializer,
    OwnerSerializer,
    LaneSerializer,
    TaskEventSerializer,
    TaskLinkSerializer,
    TaskSerializer,
)


def _meta(request) -> dict:
    """Extract actor/animation/op_id from the request's optional "meta"
    object; derive source from the X-UTD-Source header (the frontend sets
    "ui", everything else counts as an external API caller)."""
    meta = request.data.get("meta") or {}
    if isinstance(meta, str):  # multipart uploads send it as a JSON field
        try:
            meta = json.loads(meta)
        except ValueError:
            meta = {}
    if not isinstance(meta, dict):
        meta = {}
    source = Source.UI if request.headers.get("X-UTD-Source") == "ui" else Source.API
    return {
        "actor": str(meta.get("actor") or "anonymous")[:200],
        "animation": str(meta.get("animation") or "")[:50],
        "op_id": str(meta.get("op_id") or "")[:64],
        "source": source,
    }


def _active_task(task_id) -> Task:
    return get_object_or_404(Task, pk=task_id, archived_at__isnull=True)


def _task_queryset():
    return Task.objects.select_related("board").annotate(
        live_comments=Count("comments", filter=Q(comments__deleted_at__isnull=True), distinct=True),
    ).prefetch_related(
        "attachments",
        "owners",
        "categories",
        Prefetch("values", queryset=TaskValue.objects.select_related("category")),
        Prefetch("links_out", queryset=TaskLink.objects.select_related("to_task")),
        Prefetch("links_in", queryset=TaskLink.objects.select_related("from_task__lane")),
        "subtasks",
    )


@api_view(["GET", "POST"])
def board_list(request):
    if request.method == "GET":
        services.inbox_board()  # always there to jump to
        boards = Board.objects.filter(archived_at__isnull=True).order_by("created_at")
        if request.query_params.get("lanes"):
            return Response(BoardWithLanesSerializer(boards.prefetch_related("lanes"), many=True).data)
        return Response(BoardListSerializer(boards, many=True).data)

    parent = None
    if request.data.get("parent_id"):
        parent = get_object_or_404(Board, pk=request.data["parent_id"], archived_at__isnull=True)
    try:
        board = services.create_board(
            str(request.data.get("name") or ""),
            lanes=request.data.get("lanes"),
            parent=parent,
        )
    except services.ServiceError as exc:
        return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
    return Response(
        BoardSerializer(Board.objects.prefetch_related("lanes").get(pk=board.pk)).data,
        status=status.HTTP_201_CREATED,
    )


@api_view(["GET", "PATCH", "DELETE"])
def board_detail(request, board_id):
    board = get_object_or_404(Board.objects.prefetch_related("lanes"), pk=board_id)
    if request.method == "DELETE":
        services.archive_board(board)
        return Response(status=status.HTTP_204_NO_CONTENT)
    if request.method == "PATCH":
        try:
            if "name" in request.data:
                services.rename_board(board, str(request.data["name"]))
            if "parent_id" in request.data:
                parent_id = request.data["parent_id"]
                parent = get_object_or_404(Board, pk=parent_id) if parent_id else None
                services.set_board_parent(board, parent)
            if "hours_per_day" in request.data:
                services.set_hours_per_day(board, request.data["hours_per_day"])
        except services.ServiceError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
    return Response(BoardSerializer(board).data)


@api_view(["GET"])
def board_snapshot(request, board_id):
    """The hydration payload: everything a client needs to render the board,
    plus last_event_id so websocket clients can detect missed events.

    A board shows its descendants' tasks too: `family` names those boards,
    `lane_map` says which of this board's lanes each of their lanes shows
    in, and `lane_back` which of their lanes a drop in ours lands in."""
    board = get_object_or_404(Board.objects.prefetch_related("lanes"), pk=board_id)
    below = family.descendants(board)
    ids = [board.pk] + [b.pk for b in below]
    tasks = (
        _task_queryset()
        .filter(board_id__in=ids, archived_at__isnull=True)
        .order_by("lane__order", "position")
    )
    last_event = (
        TaskEvent.objects.filter(board_id__in=ids).order_by("-id")
        .values_list("id", flat=True).first()
    )
    lane_map, lane_back = family.lane_maps(board, below)
    return Response({
        "board": BoardSerializer(board).data,
        "lanes": LaneSerializer(board.lanes.filter(archived_at__isnull=True), many=True).data,
        "tasks": TaskSerializer(tasks, many=True).data,
        "owners": OwnerSerializer(Owner.objects.all(), many=True).data,
        "categories": CategorySerializer(_board_categories(board, ids), many=True).data,
        "family": BoardListSerializer(below, many=True).data,
        "lane_map": lane_map,
        "lane_back": lane_back,
        "archived_values": rollup.archived_values(ids),
        "used_owner_ids": services.used_owner_ids(ids),
        "last_event_id": last_event or 0,
    })


OFF_BOARD_LIMIT = 500


@api_view(["GET", "POST"])
def task_create(request, board_id):
    board = get_object_or_404(Board, pk=board_id)
    if request.method == "GET":
        return _off_board_tasks(request, board)
    data = request.data
    lane = get_object_or_404(Lane, pk=data.get("lane_id"), board=board, archived_at__isnull=True)
    title = (data.get("title") or "").strip()
    if not title:
        return Response({"detail": "title is required"}, status=status.HTTP_400_BAD_REQUEST)
    parent = None
    if data.get("parent_id"):
        parent = _active_task(data["parent_id"])
    attachments = data.get("attachments") or []
    if not isinstance(attachments, list):
        return Response({"detail": "attachments must be a list"},
                        status=status.HTTP_400_BAD_REQUEST)
    meta = _meta(request)
    try:
        # One unit: a task and its attachments (quick add) land together or
        # not at all.
        with transaction.atomic():
            task = services.create_task(
                board, lane, title,
                description=data.get("description", ""),
                parent=parent,
                metadata=data.get("metadata"),
                index=data.get("index"),
                due_date=data.get("due_date"),
                **meta,
            )
            categories, values = _categories_from(data), _values_from(data)
            if categories is not ... or values is not ...:
                services.update_task(task, {}, categories=categories, values=values,
                                     **{k: v for k, v in meta.items() if k != "animation"})
            for item in attachments:
                if not isinstance(item, dict):
                    raise services.ServiceError("each attachment must be an object")
                services.add_attachment(
                    task, str(item.get("kind") or ""), item.get("data") or {},
                    label=item.get("label", ""),
                    **{k: v for k, v in meta.items() if k != "animation"},
                )
    except services.ServiceError as exc:
        return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
    return Response(
        TaskSerializer(_task_queryset().get(pk=task.pk)).data,
        status=status.HTTP_201_CREATED,
    )


@api_view(["GET", "PATCH", "DELETE"])
def task_detail(request, task_id):
    task = get_object_or_404(_task_queryset(), pk=task_id)
    if request.method == "GET":
        return Response(TaskSerializer(task).data)
    if request.method == "DELETE":
        services.archive_task(task, **_meta(request))
        return Response(status=status.HTTP_204_NO_CONTENT)

    data = request.data
    changes = {f: data[f] for f in ("title", "description", "metadata", "due_date", "hide_subtasks",
                                    "owner_follows_next") if f in data}
    parent = ...
    if "parent_id" in data:
        parent = _active_task(data["parent_id"]) if data["parent_id"] else None
    owners = ...
    if "owner_ids" in data:
        ids = data["owner_ids"]
        if not isinstance(ids, list):
            return Response({"detail": "owner_ids must be a list"},
                            status=status.HTTP_400_BAD_REQUEST)
        owners = list(Owner.objects.filter(pk__in=[str(i) for i in ids]))
        if len(owners) != len(set(map(str, ids))):
            return Response({"detail": "unknown owner id"}, status=status.HTTP_400_BAD_REQUEST)
    try:
        categories = _categories_from(data)
        values = _values_from(data)
        task = services.update_task(task, changes, parent=parent, owners=owners,
                                    categories=categories, values=values, **_meta(request))
    except services.ServiceError as exc:
        return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
    return Response(TaskSerializer(_task_queryset().get(pk=task.pk)).data)


def _categories_from(data):
    """category_ids in a request: the task's complete new list, or ... ."""
    if "category_ids" not in data:
        return ...
    ids = data["category_ids"]
    if not isinstance(ids, list):
        raise services.ServiceError("category_ids must be a list")
    categories = list(Category.objects.filter(pk__in=[str(i) for i in ids]))
    if len(categories) != len(set(map(str, ids))):
        raise services.ServiceError("unknown category id")
    return categories


def _values_from(data):
    """values in a request: {category_id: figure or null}, or ... ."""
    if "values" not in data:
        return ...
    raw = data["values"]
    if not isinstance(raw, dict):
        raise services.ServiceError("values must be an object")
    found = {str(c.pk): c for c in Category.objects.filter(pk__in=[str(k) for k in raw])}
    if len(found) != len(raw):
        raise services.ServiceError("unknown category id in values")
    return {found[str(k)]: v for k, v in raw.items()}


@api_view(["GET"])
def board_archived_values(request, board_id):
    """Figures on the board family's archived tasks, for totals."""
    board = get_object_or_404(Board, pk=board_id)
    ids = [board.pk] + [b.pk for b in family.descendants(board)]
    return Response(rollup.archived_values(ids))


@api_view(["POST"])
def task_move_board(request, task_id):
    """{"board_id", "lane_id"?, "index"?}: to another board, subtasks and all."""
    task = _active_task(task_id)
    board = get_object_or_404(Board, pk=request.data.get("board_id"))
    lane = None
    if request.data.get("lane_id"):
        lane = get_object_or_404(Lane, pk=request.data["lane_id"])
    index = request.data.get("index")
    if index is not None and not isinstance(index, int):
        return Response({"detail": "index must be an integer"}, status=status.HTTP_400_BAD_REQUEST)
    try:
        task = services.move_to_board(task, board, lane, index=index, **_meta(request))
    except services.SubtaskBlockedError as exc:
        return Response({"detail": str(exc)}, status=status.HTTP_409_CONFLICT)
    except services.ServiceError as exc:
        return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
    return Response(TaskSerializer(_task_queryset().get(pk=task.pk)).data)


def _rule_json(rule, board):
    from django.db.models import Max as _Max
    trigger, conditions, actions = automation.normalized(rule)
    stats = rule.runs.aggregate(last=_Max("created_at"))
    return {
        "id": str(rule.pk),
        "board_id": str(rule.board_id),
        "board_name": rule.board.name,
        "name": rule.name,
        "enabled": rule.enabled,
        "scope": rule.scope,
        "trigger": trigger,
        "conditions": conditions,
        "actions": actions,
        "position": rule.position,
        "runs": rule.runs.count(),
        "failed_runs": rule.runs.exclude(error="").count(),
        "last_run": stats["last"].isoformat() if stats["last"] else None,
        "problems": automation.problems(rule),
        # From a parent board, applying here too (edit it there).
        "inherited": rule.board_id != board.pk,
        "archived": rule.archived_at is not None,
        "names": automation.names(trigger, conditions, actions),
    }


@api_view(["GET", "POST"])
def rule_list(request, board_id):
    """GET: this board's rules, then its parents' that apply to it too.
    POST: a new rule for this board (checked by automation.save_rule)."""
    board = get_object_or_404(Board, pk=board_id)
    if request.method == "POST":
        try:
            rule = automation.save_rule(board, request.data)
        except automation.RuleError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        return Response(_rule_json(rule, board), status=status.HTTP_201_CREATED)
    own = AutomationRule.objects.filter(board=board, archived_at__isnull=True)
    inherited = AutomationRule.objects.filter(
        board_id__in=list(family.ancestor_ids(board.pk)), scope="family", archived_at__isnull=True)
    rules = [*own.order_by("position", "created_at"), *inherited.order_by("position", "created_at")]
    return Response([_rule_json(r, board) for r in rules])


@api_view(["PATCH"])
def rule_detail(request, rule_id):
    """Edit, switch on/off, or remove ({"archived": true}; false brings it back)."""
    rule = get_object_or_404(AutomationRule, pk=rule_id)
    data = dict(request.data)
    if "archived" in data:
        rule.archived_at = timezone.now() if data.pop("archived") else None
        rule.save(update_fields=["archived_at", "updated_at"])
    if data:
        try:
            rule = automation.save_rule(rule.board, data, rule)
        except automation.RuleError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
    return Response(_rule_json(rule, rule.board))


@api_view(["GET"])
def rule_runs(request, rule_id):
    """The last times it fired: on which task, and anything that failed."""
    rule = get_object_or_404(AutomationRule, pk=rule_id)
    runs = rule.runs.select_related("task__board")[:30]
    return Response({
        "count": rule.runs.count(),
        "runs": [{
            "task_id": str(r.task_id),
            "task_title": r.task.title,
            "board_slug": r.task.board.slug,
            "board_name": r.task.board.name,
            "created_at": r.created_at.isoformat(),
            "error": r.error,
        } for r in runs],
    })


def _comment_json(c):
    return {
        "id": str(c.pk), "task_id": str(c.task_id), "body": c.body,
        "about_id": str(c.about_id) if c.about_id else None, "actor": c.actor,
        "happened_at": c.happened_at.isoformat(),
        "created_at": c.created_at.isoformat(),
        "edited_at": c.edited_at.isoformat() if c.edited_at else None,
    }


def _owner_or_none(owner_id):
    if not owner_id:
        return None
    return get_object_or_404(Owner, pk=owner_id)


@api_view(["GET", "POST"])
def task_comments(request, task_id):
    """GET: the task's log, newest first. POST {"body", "about_id"?}."""
    task = get_object_or_404(Task, pk=task_id)
    if request.method == "POST":
        try:
            comment = services.add_comment(task, str(request.data.get("body") or ""),
                                           about=_owner_or_none(request.data.get("about_id")),
                                           happened_at=request.data.get("happened_at"),
                                           **{k: v for k, v in _meta(request).items() if k != "animation"})
        except services.ServiceError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        return Response(_comment_json(comment), status=status.HTTP_201_CREATED)
    comments = task.comments.filter(deleted_at__isnull=True)
    return Response([_comment_json(c) for c in comments])


@api_view(["PATCH"])
def comment_detail(request, comment_id):
    """{"body"?, "about_id"?} to edit; {"deleted": true|false} to remove or bring back."""
    comment = get_object_or_404(TaskComment, pk=comment_id)
    meta = {k: v for k, v in _meta(request).items() if k != "animation"}
    try:
        if "deleted" in request.data:
            services.delete_comment(comment, restore=not request.data["deleted"], **meta)
        fields = {}
        if "body" in request.data:
            fields["body"] = str(request.data["body"] or "")
        if "about_id" in request.data:
            fields["about"] = _owner_or_none(request.data["about_id"])
        if "happened_at" in request.data:
            fields["happened_at"] = request.data["happened_at"]
        if fields:
            services.edit_comment(comment, **fields, **meta)
    except services.ServiceError as exc:
        return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
    return Response(_comment_json(comment))


@api_view(["GET"])
def geocode_search(request):
    """?q=an address → places ({label, lat, lng}) from OpenStreetMap."""
    try:
        return Response(geocode.search(request.query_params.get("q", "")))
    except geocode.GeocodeError as exc:
        return Response({"detail": str(exc)}, status=status.HTTP_503_SERVICE_UNAVAILABLE)


@api_view(["GET"])
def task_owner_log(request, task_id):
    """Who owned it when, from the audit trail (and the lanes it passed
    through meanwhile)."""
    task = get_object_or_404(Task, pk=task_id)
    return Response(owner_log.owner_log(task))


@api_view(["POST"])
def task_move(request, task_id):
    task = _active_task(task_id)
    lane = get_object_or_404(Lane, pk=request.data.get("to_lane_id"))
    index = request.data.get("index")
    if index is not None and not isinstance(index, int):
        return Response({"detail": "index must be an integer"},
                        status=status.HTTP_400_BAD_REQUEST)
    try:
        task = services.move_task(task, lane, index, **_meta(request))
    except services.SubtaskBlockedError as exc:
        return Response(
            {
                "detail": str(exc),
                "code": "subtask_block",
                "blocking_task_ids": [str(t.pk) for t in exc.blockers],
            },
            status=status.HTTP_400_BAD_REQUEST,
        )
    except services.ServiceError as exc:
        return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
    return Response(TaskSerializer(_task_queryset().get(pk=task.pk)).data)


@api_view(["POST"])
def task_archive(request, task_id):
    """POST alias of DELETE so curl callers can pass a meta body easily."""
    task = _active_task(task_id)
    services.archive_task(task, **_meta(request))
    return Response(status=status.HTTP_204_NO_CONTENT)


def _off_board_tasks(request, board):
    """GET ?state=archived|deleted: tasks off the board, newest first.
    (Open tasks come from the snapshot.)"""
    state = request.query_params.get("state")
    tasks = _task_queryset().filter(board_id__in=family.family_ids(board)).select_related("lane")
    if state == "archived":
        tasks = tasks.filter(archived_at__isnull=False, deleted_at__isnull=True)
        tasks = tasks.order_by("-archived_at")
    elif state == "deleted":
        tasks = tasks.filter(deleted_at__isnull=False).order_by("-deleted_at")
    else:
        return Response({"detail": "state must be archived or deleted"},
                        status=status.HTTP_400_BAD_REQUEST)
    total = tasks.count()
    return Response({
        "count": total,
        "results": TaskSerializer(tasks[:OFF_BOARD_LIMIT], many=True).data,
    })


@api_view(["POST"])
def task_delete(request, task_id):
    """Soft delete (the bin). Works on open and archived tasks."""
    task = get_object_or_404(Task, pk=task_id)
    services.delete_task(task, **_meta(request))
    return Response(TaskSerializer(_task_queryset().get(pk=task.pk)).data)


@api_view(["POST"])
def task_restore(request, task_id):
    """From the archive or the bin, back onto the board."""
    task = get_object_or_404(Task, pk=task_id)
    services.restore_task(task, **_meta(request))
    return Response(TaskSerializer(_task_queryset().get(pk=task.pk)).data)


@api_view(["POST"])
def lane_archive_all(request, lane_id):
    lane = get_object_or_404(Lane, pk=lane_id)
    meta = _meta(request)
    meta.pop("animation")
    tasks = services.archive_lane(lane, **meta)
    return Response({"archived": [str(t.pk) for t in tasks]})


@api_view(["POST"])
def task_link_create(request, task_id):
    task = _active_task(task_id)
    to_task = _active_task(request.data.get("to_task_id"))
    try:
        link = services.link_tasks(
            task, to_task, request.data.get("link_type", ""), **_meta(request)
        )
    except services.ServiceError as exc:
        return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
    return Response(TaskLinkSerializer(link).data, status=status.HTTP_201_CREATED)


@api_view(["DELETE"])
def task_link_delete(request, task_id, link_id):
    link = get_object_or_404(TaskLink, pk=link_id, from_task_id=task_id)
    services.unlink_tasks(link, **_meta(request))
    return Response(status=status.HTTP_204_NO_CONTENT)


@api_view(["GET", "POST"])
def owner_list(request):
    if request.method == "GET":
        return Response(OwnerSerializer(Owner.objects.all(), many=True).data)
    try:
        owner = services.create_owner(request.data)
    except services.ServiceError as exc:
        return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
    return Response(OwnerSerializer(owner).data, status=status.HTTP_201_CREATED)


@api_view(["PATCH", "DELETE"])
def owner_detail(request, owner_id):
    owner = get_object_or_404(Owner, pk=owner_id)
    if request.method == "DELETE":
        services.archive_owner(owner)
        return Response(status=status.HTTP_204_NO_CONTENT)
    try:
        owner = services.update_owner(owner, request.data)
    except services.ServiceError as exc:
        return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
    return Response(OwnerSerializer(owner).data)


def _board_categories(board, board_ids=None):
    """Shared categories plus the board's own (and, for a snapshot, its
    descendants' — their tasks show here); archived ones included, flagged,
    so history can still name them."""
    return Category.objects.filter(
        Q(board__isnull=True) | Q(board_id__in=board_ids or [board.pk])
    )


@api_view(["GET", "POST"])
def category_list(request, board_id):
    """GET: what this board can use. POST {"name", "color", "shared"?}:
    a new category, the board's own unless shared is true."""
    board = get_object_or_404(Board, pk=board_id)
    if request.method == "GET":
        return Response(CategorySerializer(_board_categories(board), many=True).data)
    data = request.data
    try:
        category = services.create_category(
            str(data.get("name") or ""),
            board=None if data.get("shared") else board,
            color=data.get("color") or "#6366f1",
            value_type=data.get("value_type") or "",
            value_config=data.get("value_config") or {},
        )
    except services.ServiceError as exc:
        return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
    return Response(CategorySerializer(category).data, status=status.HTTP_201_CREATED)


@api_view(["POST"])
def category_order(request):
    """{"category_ids": [...]} highest priority first."""
    try:
        services.reorder_categories(list(request.data.get("category_ids") or []))
    except services.ServiceError as exc:
        return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
    return Response(status=status.HTTP_204_NO_CONTENT)


@api_view(["PATCH", "DELETE"])
def category_detail(request, category_id):
    category = get_object_or_404(Category, pk=category_id)
    if request.method == "DELETE":
        services.archive_category(category)
        return Response(status=status.HTTP_204_NO_CONTENT)
    try:
        category = services.update_category(category, request.data)
    except services.ServiceError as exc:
        return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
    return Response(CategorySerializer(category).data)


def _lanes_response(board, status_code=status.HTTP_200_OK):
    return Response(
        LaneSerializer(board.lanes.filter(archived_at__isnull=True), many=True).data,
        status=status_code,
    )


@api_view(["GET", "POST"])
def lane_list(request, board_id):
    """GET: the board's lanes in order. POST {"name", "color"?, "wip_limit"?,
    "is_final"?, "index"?}: add one (ancestors gain it too)."""
    board = get_object_or_404(Board, pk=board_id, archived_at__isnull=True)
    if request.method == "POST":
        data = request.data
        fields = {k: data[k] for k in ("name", "color", "wip_limit", "is_final") if k in data}
        try:
            services.create_lane(board, fields, index=data.get("index"))
        except services.ServiceError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        return _lanes_response(board, status.HTTP_201_CREATED)
    return _lanes_response(board)


@api_view(["POST"])
def lane_order(request, board_id):
    """{"lane_ids": [...]}: every lane of the board, in the new order."""
    board = get_object_or_404(Board, pk=board_id, archived_at__isnull=True)
    try:
        services.reorder_lanes(board, list(request.data.get("lane_ids") or []))
    except services.ServiceError as exc:
        return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
    return _lanes_response(board)


@api_view(["PATCH", "DELETE"])
def lane_detail(request, lane_id):
    """PATCH name/color/wip_limit/is_final (+ "cascade": true to rename the
    same lane on sub-boards). DELETE (?move_to=<lane id> when it has open
    tasks) hides it."""
    lane = get_object_or_404(Lane, pk=lane_id, archived_at__isnull=True)
    try:
        if request.method == "DELETE":
            move_to_id = request.query_params.get("move_to") or request.data.get("move_to")
            move_to = get_object_or_404(Lane, pk=move_to_id) if move_to_id else None
            services.remove_lane(lane, move_to=move_to, **{
                k: v for k, v in _meta(request).items() if k in ("actor", "source")})
        else:
            data = request.data
            fields = {k: data[k] for k in ("name", "color", "wip_limit", "is_final") if k in data}
            services.update_lane(lane, fields, cascade=bool(data.get("cascade")))
    except services.LaneUsedBelowError as exc:
        return Response(
            {"detail": str(exc), "code": "used_below",
             "boards": [{"id": str(b.pk), "name": b.name} for b in exc.boards]},
            status=status.HTTP_409_CONFLICT,
        )
    except services.ServiceError as exc:
        return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
    return _lanes_response(lane.board)


@api_view(["GET"])
def link_title(request):
    """GET ?url=… → {"title", …} for a pasted link (empty if unknown)."""
    from .unfurl import unfurl
    return Response(unfurl(str(request.query_params.get("url") or "")))


@api_view(["GET"])
def search_everything(request):
    """GET ?q=…: matching boards (by name) and tasks (title, details,
    attachments) across every board, open tasks first."""
    from .search import search
    return Response(search(str(request.query_params.get("q") or "")))


def board_calendar(request, board_id):
    """The board's deadlines (and its sub-boards', recursively) as an
    iCalendar feed to subscribe to. Plain Django view: text/calendar, not
    DRF's content negotiation."""
    from django.http import HttpResponse

    from .calendar import board_calendar as build
    board = get_object_or_404(Board, pk=board_id, archived_at__isnull=True)
    # Links back to cards use the address the caller used (behind a reverse
    # proxy or the dev proxy: the forwarded host/proto).
    proto = request.headers.get("X-Forwarded-Proto") or request.scheme
    host = request.headers.get("X-Forwarded-Host") or request.get_host()
    base = f"{proto.split(',')[0].strip()}://{host.split(',')[0].strip()}"
    response = HttpResponse(build(board, base), content_type="text/calendar; charset=utf-8")
    response["Content-Disposition"] = f'inline; filename="utd-{board.slug}.ics"'
    response["Cache-Control"] = "no-cache"
    return response


@api_view(["POST"])
def task_files(request, task_id):
    """Multipart: one or more "file" parts → photo/file attachments."""
    task = _active_task(task_id)
    files = request.FILES.getlist("file")
    if not files:
        return Response({"detail": "no file"}, status=status.HTTP_400_BAD_REQUEST)
    meta = _meta(request)
    added = []
    try:
        for uploaded in files:
            added.append(services.add_file(task, uploaded, **meta))
    except services.ServiceError as exc:
        return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
    return Response(
        {"attachments": AttachmentSerializer(added, many=True).data,
         "task": TaskSerializer(_task_queryset().get(pk=task.pk)).data},
        status=status.HTTP_201_CREATED,
    )


@api_view(["POST"])
def file_task(request, board_id):
    """Multipart: a "file" plus lane_id and title (and optional parent_id,
    due_date) → a new task carrying that photo/file, created together."""
    board = get_object_or_404(Board, pk=board_id, archived_at__isnull=True)
    data = request.data
    uploaded = request.FILES.get("file")
    if uploaded is None:
        return Response({"detail": "no file"}, status=status.HTTP_400_BAD_REQUEST)
    lane = get_object_or_404(Lane, pk=data.get("lane_id"), board=board, archived_at__isnull=True)
    title = (data.get("title") or "").strip() or "Photo"
    parent = _active_task(data["parent_id"]) if data.get("parent_id") else None
    meta = _meta(request)
    try:
        with transaction.atomic():
            task = services.create_task(board, lane, title[:300], parent=parent,
                                        due_date=data.get("due_date") or None, **meta)
            services.add_file(task, uploaded, **{k: v for k, v in meta.items() if k != "animation"})
    except services.ServiceError as exc:
        return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
    return Response(TaskSerializer(_task_queryset().get(pk=task.pk)).data,
                    status=status.HTTP_201_CREATED)


_RANGE_CHUNK = 64 * 1024


def _parse_range(header: str, size: int):
    """The one satisfiable (start, end) a "Range: bytes=a-b" header asks for
    (end inclusive); None to ignore the header and send everything (not a
    bytes range, malformed, or several ranges, which a player never needs);
    False if it is well formed but outside the file (416)."""
    unit, _, spec = header.partition("=")
    if unit.strip().lower() != "bytes" or "," in spec:
        return None
    first, dash, last = spec.strip().partition("-")
    if not dash or not (first.isdigit() or first == "") or not (last.isdigit() or last == ""):
        return None
    if first == "" and last == "":
        return None
    if first == "":  # suffix: the last N bytes
        count = int(last)
        if count == 0:
            return False
        return max(size - count, 0), size - 1
    start = int(first)
    end = min(int(last), size - 1) if last else size - 1
    if start >= size:
        return False
    if end < start:
        return None  # "bytes=5-2" is invalid, not unsatisfiable: ignore it
    return start, end


def _iter_range(handle, start: int, length: int):
    try:
        handle.seek(start)
        while length > 0:
            chunk = handle.read(min(_RANGE_CHUNK, length))
            if not chunk:
                break
            length -= len(chunk)
            yield chunk
    finally:
        handle.close()


def attachment_file(request, attachment_id):
    """The stored photo/file (?thumb=1 for the thumbnail). Honours
    "Range: bytes=" with 206 so <audio> and <video> can seek (and Safari
    can play at all)."""
    import mimetypes

    from django.http import FileResponse, Http404, HttpResponse, StreamingHttpResponse
    from django.utils.http import content_disposition_header

    attachment = get_object_or_404(Attachment, pk=attachment_id, kind="file")
    stored = attachment.thumb if request.GET.get("thumb") and attachment.thumb else attachment.file
    if not stored:
        raise Http404("no file")
    try:
        handle = stored.open("rb")
    except FileNotFoundError:
        raise Http404("file missing from storage") from None
    thumb = stored is attachment.thumb
    name = attachment.data.get("name", "file")
    as_attachment = bool(request.GET.get("download"))
    content_type = "image/jpeg" if thumb else (
        attachment.data.get("content_type") or mimetypes.guess_type(name)[0]
        or "application/octet-stream")
    media = attachment.data.get("media") in ("audio", "video")
    size = stored.size
    window = _parse_range(request.headers["Range"], size) if "Range" in request.headers else None
    if window is False:
        handle.close()
        response = HttpResponse(status=416)
        response["Content-Range"] = f"bytes */{size}"
    elif window:
        start, end = window
        response = StreamingHttpResponse(_iter_range(handle, start, end - start + 1),
                                         status=206, content_type=content_type)
        response["Content-Length"] = str(end - start + 1)
        response["Content-Range"] = f"bytes {start}-{end}/{size}"
        response["Content-Disposition"] = content_disposition_header(as_attachment, name)
    else:
        response = FileResponse(handle, content_type=content_type,
                                as_attachment=as_attachment, filename=name)
    response["Accept-Ranges"] = "bytes"
    response["X-Content-Type-Options"] = "nosniff"
    response["Cache-Control"] = "private, max-age=3600" if media else "private, max-age=86400"
    return response


@api_view(["GET"])
def agenda(request):
    """GET ?today=YYYY-MM-DD&days=7: unfinished tasks on every board due by
    today+days (overdue included), soonest first — the Today view."""
    from datetime import date, timedelta
    try:
        today = date.fromisoformat(request.query_params.get("today") or "")
    except ValueError:
        today = date.today()
    days = max(0, min(int(request.query_params.get("days") or 7), 60))
    tasks = (
        _task_queryset()
        .filter(board__archived_at__isnull=True, archived_at__isnull=True,
                due_date__isnull=False, due_date__lte=today + timedelta(days=days),
                lane__is_final=False)
        .select_related("board", "lane", "parent")
        .order_by("due_date", "board__name", "position")
    )
    done_lanes = {}
    for lane in Lane.objects.filter(is_final=True, archived_at__isnull=True).order_by("order"):
        done_lanes.setdefault(lane.board_id, str(lane.pk))
    out = []
    for task in tasks:
        row = TaskSerializer(task).data
        row["board"] = {"id": str(task.board_id), "name": task.board.name, "slug": task.board.slug}
        row["lane"] = {"name": task.lane.name, "color": task.lane.color}
        row["done_lane_id"] = done_lanes.get(task.board_id)
        row["parent_title"] = task.parent.title if task.parent else None
        out.append(row)
    return Response({"today": today.isoformat(), "tasks": out})


@api_view(["GET"])
def attachment_kinds(request):
    """What a task can carry, and the fields each kind takes."""
    return Response(attachments.describe())


def _attachment_response(attachment: Attachment, status_code=status.HTTP_200_OK):
    """The attachment plus its task as it now stands, so the UI can apply
    the change without waiting for its own (suppressed) websocket echo."""
    return Response(
        {
            "attachment": AttachmentSerializer(attachment).data,
            "task": TaskSerializer(_task_queryset().get(pk=attachment.task_id)).data,
        },
        status=status_code,
    )


@api_view(["POST"])
def attachment_create(request, task_id):
    task = _active_task(task_id)
    data = request.data
    try:
        attachment = services.add_attachment(
            task, str(data.get("kind") or ""), data.get("data") or {},
            label=data.get("label", ""), **_meta(request),
        )
    except services.ServiceError as exc:
        return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
    return _attachment_response(attachment, status.HTTP_201_CREATED)


@api_view(["PATCH", "DELETE"])
def attachment_detail(request, task_id, attachment_id):
    task = _active_task(task_id)
    attachment = get_object_or_404(
        Attachment, pk=attachment_id, task=task, archived_at__isnull=True
    )
    if request.method == "DELETE":
        services.remove_attachment(attachment, **_meta(request))
        return _attachment_response(attachment)
    data = request.data
    try:
        attachment = services.update_attachment(
            attachment, data=data.get("data"), label=data.get("label"), **_meta(request)
        )
    except services.ServiceError as exc:
        return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
    return _attachment_response(attachment)


@api_view(["POST"])
def external_link_create(request, task_id):
    """Compatibility: the pre-attachments endpoint. Stores a "link"
    attachment and answers in the old shape."""
    task = _active_task(task_id)
    data = request.data
    url = data.get("url", "")
    if not url:
        return Response({"detail": "url is required"}, status=status.HTTP_400_BAD_REQUEST)
    provider = data.get("provider") or "url"
    kind, link_data = (
        ("github", {"url": url}) if provider.startswith("github")
        else ("link", {"url": url, "provider": provider})
    )
    try:
        attachment = services.add_attachment(
            task, kind, link_data,
            label=data.get("label", ""), **_meta(request),
        )
    except services.ServiceError as exc:
        return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
    return Response(
        {"id": str(attachment.pk), "provider": provider,
         "url": attachment.data["url"], "label": attachment.label},
        status=status.HTTP_201_CREATED,
    )


EVENT_RELATIONS = ("from_lane", "to_lane", "caused_by__to_lane")

# Payload keys that name another task, so the history can show titles.
_TASK_REF_KEYS = ("from_task_id", "to_task_id", "unblocked_by", "reblocked_by", "parent_id")


def _referenced_task_ids(events) -> set[str]:
    ids = set()
    for event in events:
        ids.add(str(event.task_id))
        if event.caused_by_id:
            ids.add(str(event.caused_by.task_id))
        payload = event.payload or {}
        ids.update(str(payload[k]) for k in _TASK_REF_KEYS if payload.get(k))
        parent_change = (payload.get("changes") or {}).get("parent") or {}
        ids.update(str(v) for v in parent_change.values() if v)
    return ids


@api_view(["GET"])
def task_events(request, task_id):
    """A task's audit trail, newest first. ?include=subtasks also returns
    the creation events of its direct subtasks (a rule adding a checklist
    is part of the parent's story). Every page carries related_tasks, the
    titles of tasks its events mention, archived ones included."""
    task = get_object_or_404(Task, pk=task_id)
    events_filter = Q(task=task)
    if request.query_params.get("include") == "subtasks":
        events_filter |= Q(task__parent=task, event_type=TaskEvent.EventType.CREATED)
    queryset = (
        TaskEvent.objects.filter(events_filter)
        .select_related(*EVENT_RELATIONS)
        .order_by("-id")
    )
    paginator = LimitOffsetPagination()
    page = paginator.paginate_queryset(queryset, request)
    related = Task.objects.filter(pk__in=_referenced_task_ids(page)).values(
        "id", "title", "archived_at", "parent_id"
    )
    response = paginator.get_paginated_response(TaskEventSerializer(page, many=True).data)
    response.data["related_tasks"] = {
        str(row["id"]): {
            "title": row["title"],
            "archived": row["archived_at"] is not None,
            "parent_id": str(row["parent_id"]) if row["parent_id"] else None,
        }
        for row in related
    }
    return response


@api_view(["GET"])
def task_timeline(request, task_id):
    task = get_object_or_404(Task, pk=task_id)
    return Response({"task_id": str(task.pk), "timeline": services.compute_timeline(task)})


@api_view(["GET"])
def board_analytics(request, board_id):
    board = get_object_or_404(Board.objects.prefetch_related("lanes"), pk=board_id)
    return Response(services.compute_analytics(board))


@api_view(["GET"])
def board_events(request, board_id):
    board = get_object_or_404(Board, pk=board_id)
    queryset = board.events.select_related(*EVENT_RELATIONS).order_by("-id")
    since = request.query_params.get("since")
    if since is not None:
        try:
            queryset = (
                board.events.select_related(*EVENT_RELATIONS)
                .filter(id__gt=int(since))
                .order_by("id")
            )
        except ValueError:
            return Response({"detail": "since must be an integer event id"},
                            status=status.HTTP_400_BAD_REQUEST)
    paginator = LimitOffsetPagination()
    page = paginator.paginate_queryset(queryset, request)
    return paginator.get_paginated_response(
        TaskEventSerializer(page, many=True).data
    )
