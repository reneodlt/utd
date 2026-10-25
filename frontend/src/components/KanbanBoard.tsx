import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCorners,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { LaneTotals } from "./Figures";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { LayoutGroup } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { getSnapshot, moveTask } from "../api/client";
import { newOpId } from "../lib/compat";
import { moveBack, placeOf, quote } from "../lib/undo";
import { useIsPhone } from "../lib/useIsPhone";

import { useBoardStore } from "../store/boardStore";
import LaneColumn from "./LaneColumn";
import TaskCardOverlay from "./TaskCardOverlay";

/** Lane tabs (phone) are drop targets too: "tab:<laneId>". */
const TAB = "tab:";

/** The lane under the pointer decides; nearest corners only as a fallback
 * (keyboard drags, or the pointer between lanes). Corner distance alone
 * flip-flops between neighbouring lanes as cards shift. */
const collision: CollisionDetection = (args) => {
  const within = pointerWithin(args);
  return within.length > 0 ? within : closestCorners(args);
};

/** Phone drags: holding at a screen edge pages one lane per step. */
const EDGE_PX = 28;
const EDGE_STEP_MS = 700;
const TAB_DWELL_MS = 350;

interface DragOrigin {
  order: Record<string, string[]>;
  laneByTask: Record<string, string>;
}

export default function KanbanBoard() {
  const lanes = useBoardStore((s) => s.lanes);
  const [activeId, setActiveId] = useState<string | null>(null);
  const originRef = useRef<DragOrigin | null>(null);

  // Mouse: drag after 6px. Touch: press and hold, so swipes still scroll
  // the lane (and, on a phone, page between lanes).
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const laneOf = (id: string): string | undefined => {
    const s = useBoardStore.getState();
    if (id.startsWith(TAB)) return id.slice(TAB.length);
    return s.taskIdsByLane[id] ? id : s.tasksById[id]?.lane_id;
  };

  /** Rule: a parent may never sit right of its subtasks. The server enforces
   * this too; checking here lets the board show it while dragging. */
  const blockersFor = (taskId: string, laneId: string): string[] => {
    const s = useBoardStore.getState();
    const laneOrderById = new Map(s.lanes.map((l) => [l.id, l.order]));
    const targetOrder = laneOrderById.get(laneId) ?? 0;
    return (s.childrenByParent[taskId] ?? []).filter((childId) => {
      const child = s.tasksById[childId];
      return child && (laneOrderById.get(child.lane_id) ?? 0) < targetOrder;
    });
  };

  function handleDragStart(event: DragStartEvent) {
    const id = String(event.active.id);
    // A long-press may have begun a text selection (iOS loupe): drop it.
    window.getSelection()?.removeAllRanges();
    watchTouchEnd(event.activatorEvent);
    const s = useBoardStore.getState();
    setActiveId(id);
    s.setDragActive(true);
    originRef.current = {
      order: Object.fromEntries(
        Object.entries(s.taskIdsByLane).map(([lane, ids]) => [lane, [...ids]]),
      ),
      laneByTask: { [id]: s.tasksById[id]?.lane_id ?? "" },
    };
  }

  function handleDragOver(event: DragOverEvent) {
    const { active, over } = event;
    const s = useBoardStore.getState();
    const origin = originRef.current;
    if (!over || !origin) return s.setDropBlock(null);
    const activeIdStr = String(active.id);
    const overId = String(over.id);
    const activeLane = s.tasksById[activeIdStr]?.lane_id;
    const overLane = laneOf(overId);

    // Resting on a lane tab brings that lane on screen, so the card can be
    // placed within it.
    if (tabTimer.current) window.clearTimeout(tabTimer.current);
    tabTimer.current = null;
    if (overId.startsWith(TAB)) {
      const index = s.lanes.findIndex((l) => l.id === overLane);
      tabTimer.current = window.setTimeout(() => showLane(index), TAB_DWELL_MS);
    }
    if (!activeLane || !overLane) return;

    // A lane the card may not enter: leave it at home rather than opening
    // a gap it can't drop into, and say why. Either a parent passing its
    // subtasks, or a sub-board's task over a lane its own board lacks.
    const blockers = blockersFor(activeIdStr, overLane);
    const task = s.tasksById[activeIdStr];
    const foreign = task && task.board_id !== s.board?.id;
    const reason =
      foreign && !s.laneBack[task.board_id]?.[overLane]
        ? `${s.familyById[task.board_id]?.name ?? "Its board"} has no “${
            s.lanes.find((l) => l.id === overLane)?.name ?? "such"
          }” lane`
        : undefined;
    if (blockers.length > 0 || reason) {
      s.setDropBlock({ laneId: overLane, blockers, reason });
      if (activeLane !== origin.laneByTask[activeIdStr]) {
        s.restoreOrder(origin.order, origin.laneByTask);
      }
      return;
    }
    s.setDropBlock(null);
    if (activeLane === overLane) return;
    // Crossing into another lane: move it there optimistically so the gap
    // follows the pointer; within-lane shuffling is dnd-kit's job.
    const ids = s.taskIdsByLane[overLane] ?? [];
    const overIndex = ids.indexOf(overId);
    s.optimisticMove(activeIdStr, overLane, overIndex >= 0 ? overIndex : ids.length);
  }

  /** Phone: hold near the left/right edge to page one lane at a time. */
  function handleDragMove(event: DragMoveEvent) {
    if (!phone) return;
    const start = event.activatorEvent as TouchEvent | MouseEvent;
    const startX = "touches" in start ? start.touches[0]?.clientX ?? 0 : start.clientX;
    const x = startX + event.delta.x;
    const dir = x < EDGE_PX ? -1 : x > window.innerWidth - EDGE_PX ? 1 : 0;
    if (dir === edgeDir.current) return;
    edgeDir.current = dir;
    if (edgeTimer.current) window.clearInterval(edgeTimer.current);
    edgeTimer.current = null;
    if (dir !== 0) {
      edgeTimer.current = window.setInterval(() => {
        // Never page once the drag is over, however it ended.
        if (!originRef.current) {
          stopDragTimers();
          return;
        }
        const next = Math.max(0, Math.min(lanes.length - 1, activeLaneRef.current + edgeDir.current));
        if (next !== activeLaneRef.current) showLane(next);
      }, EDGE_STEP_MS);
    }
  }

  /** iOS can fail to deliver the final touchend/touchcancel to the element
   * the drag started on once that card has been re-mounted in another lane,
   * leaving the drag (and edge paging) running after the finger lifts.
   * Watch the window too, and if the drag is still live just after the
   * touch ended, replay the event where dnd-kit is listening so it
   * finishes (or cancels) the drop normally. */
  function watchTouchEnd(activator: Event) {
    if (!("touches" in activator) || !activator.target) return;
    const target = activator.target;
    const onFinish = (e: TouchEvent) => {
      if (e.touches.length > 0) return;
      window.setTimeout(() => {
        if (!originRef.current) return; // dnd-kit saw it; all done
        target.dispatchEvent(new TouchEvent(e.type, { bubbles: true, cancelable: true }));
      }, 80);
    };
    window.addEventListener("touchend", onFinish, true);
    window.addEventListener("touchcancel", onFinish, true);
    touchCleanup.current = () => {
      window.removeEventListener("touchend", onFinish, true);
      window.removeEventListener("touchcancel", onFinish, true);
    };
  }

  function stopDragTimers() {
    touchCleanup.current?.();
    touchCleanup.current = null;
    if (tabTimer.current) window.clearTimeout(tabTimer.current);
    if (edgeTimer.current) window.clearInterval(edgeTimer.current);
    tabTimer.current = null;
    edgeTimer.current = null;
    edgeDir.current = 0;
  }

  function handleDragEnd(event: DragEndEvent) {
    stopDragTimers();
    const { active, over } = event;
    const activeIdStr = String(active.id);
    setActiveId(null);
    const store = useBoardStore.getState();
    const dropBlock = store.dropBlock;
    store.setDragActive(false);
    const origin = originRef.current;
    originRef.current = null;
    if (!origin) return;

    // Dropped on a lane it may not enter: back home, and shake the culprits.
    if (dropBlock) {
      store.restoreOrder(origin.order, origin.laneByTask);
      store.flashTasks(dropBlock.blockers, "alarm");
      return;
    }

    // In focus mode lanes show a temporary order, so reordering within a
    // lane is off; moving to another lane still works (handled on drag over).
    if (over && !store.focusTaskId) {
      const overId = String(over.id);
      const laneId = store.tasksById[activeIdStr]?.lane_id;
      if (laneId) {
        const ids = store.taskIdsByLane[laneId] ?? [];
        const from = ids.indexOf(activeIdStr);
        const to = ids.indexOf(overId);
        if (overId !== activeIdStr && from >= 0 && to >= 0 && from !== to) {
          store.reorderWithinLane(laneId, from, to);
        }
      }
    }

    const s = useBoardStore.getState();
    const task = s.tasksById[activeIdStr];
    if (!task) return;
    const laneId = task.lane_id;
    const index = (s.taskIdsByLane[laneId] ?? []).indexOf(activeIdStr);
    const originLane = origin.laneByTask[activeIdStr];
    const originIndex = origin.order[originLane]?.indexOf(activeIdStr) ?? -1;
    if (laneId === originLane && index === originIndex) return;

    // Belt and braces: the card should never have been let into such a lane.
    const blockers = blockersFor(activeIdStr, laneId);
    if (blockers.length > 0) {
      s.restoreOrder(origin.order, origin.laneByTask);
      s.flashTasks(blockers, "alarm");
      return;
    }

    // A descendant board's task moves within its own board: the matching
    // lane there, placed among that board's tasks only.
    const sameBoardBefore = (s.taskIdsByLane[laneId] ?? [])
      .slice(0, index)
      .filter((id) => s.tasksById[id]?.board_id === task.board_id).length;
    const opId = newOpId();
    s.registerOp(opId);
    // Where it came from, for undo.
    const from = placeOf(activeIdStr, origin.order);
    const laneName = s.lanes.find((l) => l.id === laneId)?.name ?? "";
    moveTask(activeIdStr, {
      to_lane_id: s.homeLane(task, laneId),
      index: sameBoardBefore,
      meta: { op_id: opId, actor: "board-user" },
    })
      .then(() => {
        if (!from) return;
        useBoardStore
          .getState()
          .offerUndo(
            laneId === originLane ? `Reordered ${quote(task.title)}` : `Moved ${quote(task.title)} to ${laneName}`,
            () => moveBack(activeIdStr, from),
          );
      })
      .catch(() => {
      // Server rejected or died: fall back to its truth.
      const state = useBoardStore.getState();
      state.resolveOp(opId);
      if (state.board) {
        getSnapshot(state.board.id).then((snap) =>
          useBoardStore.getState().loadSnapshot(snap),
        );
      }
    });
  }

  function handleDragCancel() {
    stopDragTimers();
    setActiveId(null);
    const s = useBoardStore.getState();
    s.setDragActive(false);
    if (originRef.current) {
      s.restoreOrder(originRef.current.order, originRef.current.laneByTask);
      originRef.current = null;
    }
  }

  const activeTask = activeId ? useBoardStore.getState().tasksById[activeId] : null;

  // Phone: one lane per screen, snapped, with a tab strip that follows.
  const phone = useIsPhone();
  const lanesRef = useRef<HTMLElement>(null);
  const [activeLane, setActiveLane] = useState(0);
  const activeLaneRef = useRef(0);
  activeLaneRef.current = activeLane;
  const tabTimer = useRef<number | null>(null);
  const edgeTimer = useRef<number | null>(null);
  const edgeDir = useRef(0);
  const touchCleanup = useRef<(() => void) | null>(null);
  const boardId = useBoardStore((s) => s.board?.id);

  const showLane = (index: number, smooth = true) => {
    const el = lanesRef.current?.children[index] as HTMLElement | undefined;
    el?.scrollIntoView({ behavior: smooth ? "smooth" : "auto", inline: "center", block: "nearest" });
    setActiveLane(index);
  };

  // Open on the first lane with cards in it, once per board.
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (!phone || !boardId || lanes.length === 0 || opened.current === boardId) return;
    opened.current = boardId;
    const byLane = useBoardStore.getState().taskIdsByLane;
    const first = lanes.findIndex((l) => (byLane[l.id] ?? []).length > 0);
    requestAnimationFrame(() => showLane(first >= 0 ? first : 0, false));
  }, [phone, boardId, lanes]);

  function onLanesScroll() {
    const el = lanesRef.current;
    if (!el) return;
    // The lane whose centre is nearest the middle of the screen.
    const mid = el.getBoundingClientRect().left + el.clientWidth / 2;
    const kids = Array.from(el.children) as HTMLElement[];
    const off = (kid: HTMLElement) => {
      const r = kid.getBoundingClientRect();
      return Math.abs(r.left + r.width / 2 - mid);
    };
    let best = 0;
    kids.forEach((kid, i) => {
      if (off(kid) < off(kids[best])) best = i;
    });
    if (best !== activeLane) setActiveLane(best);
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collision}
      // Phone: no sideways auto-scroll (it flung past lanes mid-drag);
      // edges and tabs page deliberately instead. Vertical stays.
      autoScroll={phone ? { threshold: { x: 0, y: 0.2 } } : true}
      onDragStart={handleDragStart}
      onDragMove={handleDragMove}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      {/* One layout group: when focus reorders lanes, cards that didn't
          re-render themselves still glide to their new spots. */}
      <LayoutGroup>
        {phone && <LaneTabs active={activeLane} onPick={(i) => showLane(i)} />}
        <main className="lanes" ref={lanesRef} onScroll={phone ? onLanesScroll : undefined}>
          {lanes.map((lane) => (
            <LaneColumn key={lane.id} lane={lane} />
          ))}
        </main>
      </LayoutGroup>
      <DragOverlay dropAnimation={{ duration: 180 }}>
        {activeTask ? <TaskCardOverlay task={activeTask} /> : null}
      </DragOverlay>
    </DndContext>
  );
}

/** Phone: which lane is on screen, and a tap away from the others. */
function LaneTabs({ active, onPick }: { active: number; onPick: (index: number) => void }) {
  const lanes = useBoardStore((s) => s.lanes);
  const counts = useBoardStore((s) => lanes.map((l) => (s.taskIdsByLane[l.id] ?? []).length).join());
  const n = counts.split(",").map(Number);
  const stripRef = useRef<HTMLDivElement>(null);

  // Keep the active tab in view as lanes are swiped.
  useEffect(() => {
    const tab = stripRef.current?.children[active] as HTMLElement | undefined;
    tab?.scrollIntoView({ behavior: "smooth", inline: "nearest", block: "nearest" });
  }, [active]);

  return (
    <div ref={stripRef} className="lane-tabs" role="tablist" aria-label="Lanes">
      {lanes.map((lane, i) => (
        <LaneTab
          key={lane.id}
          laneId={lane.id}
          name={lane.name}
          color={lane.color}
          count={n[i]}
          limit={lane.wip_limit}
          isFinal={lane.is_final}
          selected={i === active}
          onPick={() => onPick(i)}
        />
      ))}
    </div>
  );
}

/** A lane tab; while dragging, also a drop target for "the end of that lane". */
function LaneTab({
  laneId,
  name,
  color,
  count,
  limit,
  isFinal,
  selected,
  onPick,
}: {
  laneId: string;
  name: string;
  color: string;
  count: number;
  limit: number | null;
  isFinal: boolean;
  selected: boolean;
  onPick: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `${TAB}${laneId}` });
  const dragging = useBoardStore((s) => s.dragActive);
  const over = limit !== null && count > limit;
  return (
    <button
      ref={setNodeRef}
      type="button"
      role="tab"
      aria-selected={selected}
      className={`lane-tab${over ? " over-limit" : ""}${dragging ? " is-drop-target" : ""}${isOver ? " is-over" : ""}`}
      style={{ "--lane-color": color } as React.CSSProperties}
      onClick={onPick}
    >
      <span className="lane-tab-name">
        {name}
        <span className="lane-tab-count">
          {count}
          {limit !== null && `/${limit}`}
        </span>
      </span>
      {selected && <LaneTotals laneId={laneId} isFinal={isFinal} compact />}
    </button>
  );
}
