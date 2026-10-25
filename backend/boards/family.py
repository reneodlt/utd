"""Board families: boards nest (Board.parent), and a board shows its own
tasks plus every task of its (non-archived) descendant boards.

Each board configures its own lanes; a parent always holds the superset of
its sub-boards' lanes (kept in sync by the service layer), and lanes line up
by name. A descendant's task shows in the same-named lane here, and moves
from this view land in the same-named lane of its own board.
"""

from .models import Board, Lane


def descendants(board: Board) -> list[Board]:
    """Non-archived boards below this one, any depth (an archived board's
    subtree is left out)."""
    result, frontier = [], [board.pk]
    seen = {board.pk}
    while frontier:
        children = list(
            Board.objects.filter(parent_id__in=frontier, archived_at__isnull=True)
            .exclude(pk__in=seen)
            .order_by("created_at")
        )
        result.extend(children)
        seen.update(c.pk for c in children)
        frontier = [c.pk for c in children]
    return result


def family_ids(board: Board) -> list:
    """This board and its descendants: whose tasks it shows."""
    return [board.pk] + [b.pk for b in descendants(board)]


def ancestor_ids(board_id) -> list:
    """Boards above this one, nearest first (cycle-safe)."""
    chain, seen = [], {board_id}
    parent_id = Board.objects.filter(pk=board_id).values_list("parent_id", flat=True).first()
    while parent_id and parent_id not in seen:
        chain.append(parent_id)
        seen.add(parent_id)
        parent_id = Board.objects.filter(pk=parent_id).values_list("parent_id", flat=True).first()
    return chain


def _active(board: Board) -> list[Lane]:
    return list(board.lanes.filter(archived_at__isnull=True).order_by("order"))


def lane_maps(board: Board, others: list[Board]) -> tuple[dict, dict]:
    """Lanes line up by name (ignoring case). Parents hold the superset of
    their sub-boards' lanes (services._sync_up), so every descendant lane
    has a match here; the other way, a lane this board has but a sub-board
    lacks has no entry — a task from that board can't be dropped there.
    Returns ({child_lane_id: lane_id}, {board_id: {lane_id: child_lane_id}})."""
    own = _active(board)
    by_name = {l.name.strip().lower(): l for l in own}
    forward, back = {}, {}
    for other in others:
        theirs = _active(other)
        back[str(other.pk)] = {}
        for lane in theirs:
            match = by_name.get(lane.name.strip().lower())
            if match is None and own:
                # Only before the superset has been synced: nearest by position.
                i = theirs.index(lane)
                match = own[round(i / max(len(theirs) - 1, 1) * (len(own) - 1))]
            if match is not None:
                forward[str(lane.pk)] = str(match.pk)
                if lane.name.strip().lower() == match.name.strip().lower():
                    back[str(other.pk)][str(match.pk)] = str(lane.pk)
    return forward, back


def lanes_shown_in(lane: Lane) -> list:
    """Every lane (this board's or a descendant's) whose tasks this lane
    shows."""
    board = lane.board
    forward, _ = lane_maps(board, descendants(board))
    return [lane.pk] + [child for child, shown in forward.items() if shown == str(lane.pk)]
