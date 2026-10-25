import { create } from "zustand";
import { getArchivedValues } from "../api/client";
import { isFlashAnimation } from "../animations/catalogue";
import { loadSubtaskViews, saveSubtaskViews, SUBTASK_VIEWS, type SubtaskView } from "../lib/collapse";
import { loadFocus, saveFocus } from "../lib/focus";
import { loadCategoryFilter, saveCategoryFilter } from "../lib/filters";
import { loadColourBy, saveColourBy, type ColourBy } from "../lib/cardColour";
import { loadOwnerFilter, saveOwnerFilter } from "../lib/owners";
import type {
  ArchivedValue,
  Board,
  BoardSummary,
  ConnectionStatus,
  Lane,
  BoardView,
  Category,
  Owner,
  Snapshot,
  Task,
  WsEvent,
} from "../types";

export interface ActivityItem {
  id: number;
  text: string;
  animation: string;
  ts: string;
}

export interface DropBlock {
  laneId: string;
  /** Subtasks holding a parent back (the subtask rule). */
  blockers: string[];
  /** Otherwise, why the drop isn't allowed (shown on the lane). */
  reason?: string;
}

export type SettingsTab = "people" | "categories" | "automations";

export interface UndoOffer {
  id: number;
  label: string;
  run: () => Promise<unknown>;
}

let undoSeq = 0;

export interface MenuState {
  taskId: string;
  x: number;
  y: number;
}

interface BoardState {
  /** All non-archived boards, for the switcher. */
  boards: BoardSummary[];
  board: Board | null;
  lanes: Lane[];
  tasksById: Record<string, Task>;
  taskIdsByLane: Record<string, string[]>;
  /** Active subtask ids per parent, ordered by lane then position — derived
   * client-side because a subtask's create/archive/move broadcast doesn't
   * re-send its parent. */
  childrenByParent: Record<string, string[]>;
  lastEventId: number;
  status: ConnectionStatus;
  pendingOps: Record<string, true>;
  flashes: Record<string, string>;
  activity: ActivityItem[];
  dragActive: boolean;
  /** While dragging a parent over a lane it may not enter: that lane and the
   * subtasks still sitting to its left, holding the parent back. */
  dropBlock: DropBlock | null;
  menu: MenuState | null;
  /** The card whose detail drawer (with its history) is open. */
  detailTaskId: string | null;
  /** The task in focus mode on this device: it and its subtasks stay sharp,
   * the rest of the board fades. Remembered per board in localStorage. */
  focusTaskId: string | null;
  /** Cards showing their subtasks as a progress bar rather than a list. */
  /** How each card shows its subtasks (absent = list). */
  subtaskViews: Record<string, SubtaskView>;
  /** Minute heartbeat so time-based UI (ages, aging tints) stays current. */
  tick: number;
  /** Every owner, archived included (history still names them). */
  ownersById: Record<string, Owner>;
  /** Owner ids (or "unassigned") whose tasks are shown; empty = all. */
  ownerFilter: string[];
  /** Categories this board can use: shared ones and its own (archived
   * included, flagged, so history can name them). */
  categoriesById: Record<string, Category>;
  /** Category ids (or "uncategorised") whose tasks are shown; empty = all. */
  categoryFilter: string[];
  /** What colours the cards (time in lane, owner, deadline, category). */
  colourBy: ColourBy;
  /** Descendant boards shown on this one, by id (not this board itself). */
  familyById: Record<string, BoardSummary>;
  /** Descendant lane id → this board's lane it shows in. */
  laneMap: Record<string, string>;
  /** Per descendant board: this board's lane → the lane a move lands in. */
  laneBack: Record<string, Record<string, string>>;
  /** Figures on archived tasks in the family, for totals (the board only
   * loads open tasks). Refetched when tasks are archived or come back. */
  archivedValues: ArchivedValue[];
  /** Owners used on this board's tasks, most recent first (the shortlist
   * in owner pickers); owners on the loaded tasks count too. */
  usedOwnerIds: string[];
  familyOpen: boolean;
  lanesOpen: boolean;
  searchOpen: boolean;
  /** The last undoable action (one slot; the toast offers it). */
  undo: UndoOffer | null;
  /** Which settings tab is open, if any. */
  settingsOpen: SettingsTab | false;
  /** Board (open tasks) or the archived / deleted lists. Not persisted. */
  view: BoardView;

  setBoards(boards: BoardSummary[]): void;
  renameBoardLocal(boardId: string, name: string): void;
  /** Clear all per-board state before hydrating a different board. */
  resetForBoard(): void;
  loadSnapshot(snapshot: Snapshot): void;
  applyEvent(event: WsEvent): void;
  upsertTask(task: Task): void;
  removeTask(taskId: string): void;
  optimisticMove(taskId: string, toLaneId: string, index: number): void;
  reorderWithinLane(laneId: string, from: number, to: number): void;
  restoreOrder(order: Record<string, string[]>, laneByTask: Record<string, string>): void;
  registerOp(opId: string): void;
  resolveOp(opId: string): void;
  clearFlash(taskId: string): void;
  flashTasks(taskIds: string[], animation: string): void;
  setStatus(status: ConnectionStatus): void;
  setDragActive(active: boolean): void;
  setDropBlock(block: DropBlock | null): void;
  openMenu(taskId: string, x: number, y: number): void;
  closeMenu(): void;
  openDetail(taskId: string): void;
  closeDetail(): void;
  setFocus(taskId: string | null): void;
  /** list → checklist → bar → list */
  cycleSubtaskView(taskId: string): void;
  tickMinute(): void;
  setOwners(owners: Owner[]): void;
  setOwnerFilter(ids: string[]): void;
  setSettingsOpen(open: SettingsTab | false): void;
  setView(view: BoardView): void;
  upsertCategory(category: Category): void;
  setCategoryFilter(ids: string[]): void;
  setColourBy(mode: ColourBy): void;
  setFamilyOpen(open: boolean): void;
  setLanesOpen(open: boolean): void;
  setSearchOpen(open: boolean): void;
  offerUndo(label: string, run: () => Promise<unknown>): void;
  clearUndo(): void;
  /** Apply a fresh lane list for this board (after a lane edit). */
  setLanes(lanes: Lane[]): void;
  refreshArchivedValues(): void;
  /** The lane a task really lives in for a move to this board's lane. */
  homeLane(task: Task, displayLaneId: string): string;
}

/** A descendant board's task, placed in this board's matching lane (its
 * own lane_id is swapped for the display lane; homeLane() maps back).
 * Idempotent: tasks already in a display lane pass through. */
function inDisplayLane(task: Task, laneMap: Record<string, string>): Task {
  const shown = laneMap[task.lane_id];
  return shown ? { ...task, lane_id: shown } : task;
}

function laneOrder(tasks: Task[], laneId: string): string[] {
  return tasks
    .filter((t) => t.lane_id === laneId && !t.archived_at)
    .sort((a, b) => a.position - b.position)
    .map((t) => t.id);
}

function deriveChildren(
  tasksById: Record<string, Task>,
  lanes: Lane[],
): Record<string, string[]> {
  const laneOrderById: Record<string, number> = {};
  for (const lane of lanes) laneOrderById[lane.id] = lane.order;
  const children: Record<string, Task[]> = {};
  for (const task of Object.values(tasksById)) {
    if (task.parent_id && !task.archived_at) {
      (children[task.parent_id] ??= []).push(task);
    }
  }
  const result: Record<string, string[]> = {};
  for (const [parentId, tasks] of Object.entries(children)) {
    result[parentId] = tasks
      .sort(
        (a, b) =>
          (laneOrderById[a.lane_id] ?? 0) - (laneOrderById[b.lane_id] ?? 0) ||
          a.position - b.position,
      )
      .map((t) => t.id);
  }
  return result;
}

function rebuildLanes(
  tasksById: Record<string, Task>,
  taskIdsByLane: Record<string, string[]>,
  laneIds: (string | undefined)[],
): Record<string, string[]> {
  const tasks = Object.values(tasksById);
  const next = { ...taskIdsByLane };
  for (const laneId of laneIds) {
    if (laneId) next[laneId] = laneOrder(tasks, laneId);
  }
  return next;
}

/** Events after which the task is no longer on the board. */
const LEAVES_BOARD = new Set(["task.archived", "task.deleted"]);
/** Events that change which figures sit on archived tasks. */
const MOVES_ARCHIVE = new Set(["task.archived", "task.deleted", "task.restored"]);
let archivedTimer: number | undefined;

/** Keep totals steady while the archived figures are refetched: a task
 * leaving for the archive takes its figures with it (rolling up into its
 * nearest open ancestor); one coming back, or binned, drops them. */
function shiftArchivedValues(
  current: ArchivedValue[],
  type: string,
  task: Task,
  openTasks: Record<string, Task>,
  categoriesById: Record<string, Category>,
): ArchivedValue[] {
  const others = current.filter((v) => v.task_id !== task.id);
  if (type !== "task.archived") return others;
  let anchor = task.parent_id;
  const seen = new Set<string>();
  while (anchor && !openTasks[anchor] && !seen.has(anchor)) {
    seen.add(anchor);
    // An archived ancestor we know about: carry on above it.
    anchor = current.find((v) => v.task_id === anchor)?.anchor_id ?? null;
  }
  const mine = task.category_ids.flatMap((id) => {
    const category = categoriesById[id];
    const amount = task.values?.[id];
    if (!category || category.archived || !category.value_type || amount === undefined) return [];
    return [{
      task_id: task.id,
      board_id: task.board_id,
      category_id: id,
      amount,
      estimate: task.estimates?.[id] ?? null,
      title: task.title,
      owner_ids: task.owner_ids,
      category_ids: task.category_ids,
      anchor_id: anchor ?? null,
    }];
  });
  return [...others, ...mine];
}

const VERBS: Record<string, string> = {
  "task.created": "created",
  "task.moved": "moved",
  "task.updated": "updated",
  "task.archived": "archived",
  "task.deleted": "deleted",
  "task.restored": "restored",
  "task.linked": "linked",
  "task.unlinked": "unlinked",
};

/** The remembered focus, if that task is still on the board. */
function restoreFocus(boardId: string, tasksById: Record<string, Task>): string | null {
  const stored = loadFocus(boardId);
  if (stored && tasksById[stored]) return stored;
  if (stored) saveFocus(boardId, null);
  return null;
}

/** Focus ends when its task leaves the board (archived here or elsewhere). */
function keepFocus(
  focusTaskId: string | null,
  tasksById: Record<string, Task>,
  boardId: string | undefined,
): string | null {
  if (!focusTaskId || tasksById[focusTaskId]) return focusTaskId;
  if (boardId) saveFocus(boardId, null);
  return null;
}

export const useBoardStore = create<BoardState>()((set, get) => ({
  boards: [],
  board: null,
  lanes: [],
  tasksById: {},
  taskIdsByLane: {},
  childrenByParent: {},
  lastEventId: 0,
  status: "connecting",
  pendingOps: {},
  flashes: {},
  activity: [],
  dragActive: false,
  dropBlock: null,
  menu: null,
  detailTaskId: null,
  focusTaskId: null,
  subtaskViews: {},
  tick: 0,
  ownersById: {},
  ownerFilter: [],
  categoriesById: {},
  categoryFilter: [],
  colourBy: "age",
  familyById: {},
  laneMap: {},
  laneBack: {},
  archivedValues: [],
  usedOwnerIds: [],
  familyOpen: false,
  lanesOpen: false,
  searchOpen: false,
  undo: null,
  settingsOpen: false,
  view: "open",

  setBoards(boards) {
    set({ boards });
  },

  renameBoardLocal(boardId, name) {
    set((s) => ({
      boards: s.boards.map((b) => (b.id === boardId ? { ...b, name } : b)),
      board: s.board?.id === boardId ? { ...s.board, name } : s.board,
    }));
  },

  resetForBoard() {
    set({
      board: null,
      lanes: [],
      tasksById: {},
      taskIdsByLane: {},
      childrenByParent: {},
      lastEventId: 0,
      status: "connecting",
      pendingOps: {},
      flashes: {},
      activity: [],
      dragActive: false,
      dropBlock: null,
      menu: null,
      detailTaskId: null,
      focusTaskId: null,
      subtaskViews: {},
      ownerFilter: [],
      categoriesById: {},
      categoryFilter: [],
      familyById: {},
      laneMap: {},
      laneBack: {},
      archivedValues: [],
      usedOwnerIds: [],
      view: "open",
    });
  },

  loadSnapshot(snapshot) {
    const tasksById: Record<string, Task> = {};
    const tasks = snapshot.tasks.map((t) => inDisplayLane(t, snapshot.lane_map));
    for (const task of tasks) tasksById[task.id] = task;
    const taskIdsByLane: Record<string, string[]> = {};
    for (const lane of snapshot.lanes) {
      taskIdsByLane[lane.id] = laneOrder(tasks, lane.id);
    }
    set({
      board: snapshot.board,
      lanes: snapshot.lanes,
      tasksById,
      taskIdsByLane,
      childrenByParent: deriveChildren(tasksById, snapshot.lanes),
      lastEventId: snapshot.last_event_id,
      status: "open",
      focusTaskId: restoreFocus(snapshot.board.id, tasksById),
      subtaskViews: loadSubtaskViews(snapshot.board.id),
      ownersById: Object.fromEntries(snapshot.owners.map((o) => [o.id, o])),
      ownerFilter: loadOwnerFilter(snapshot.board.id),
      categoriesById: Object.fromEntries(snapshot.categories.map((c) => [c.id, c])),
      categoryFilter: loadCategoryFilter(snapshot.board.id),
      colourBy: loadColourBy(snapshot.board.id),
      familyById: Object.fromEntries(snapshot.family.map((b) => [b.id, b])),
      laneMap: snapshot.lane_map,
      laneBack: snapshot.lane_back,
      archivedValues: snapshot.archived_values ?? [],
      usedOwnerIds: snapshot.used_owner_ids ?? [],
    });
  },

  applyEvent(event) {
    if (!("task" in event)) {
      if (event.type === "owners.changed") {
        get().setOwners(event.owners);
        return;
      }
      if (event.type === "category.changed") {
        get().upsertCategory(event.category);
        return;
      }
      if (event.type === "lane.rebalanced") {
        set((s) => {
          const laneId = s.laneMap[event.lane_id] ?? event.lane_id;
          const tasksById = { ...s.tasksById };
          for (const [taskId, position] of Object.entries(event.positions)) {
            const task = tasksById[taskId];
            if (task) tasksById[taskId] = { ...task, position };
          }
          return {
            tasksById,
            taskIdsByLane: rebuildLanes(tasksById, s.taskIdsByLane, [laneId]),
          };
        });
      }
      return;
    }

    const state = get();
    const task = inDisplayLane(event.task, state.laneMap);
    const { meta } = event;
    if (meta.event_id <= state.lastEventId) return; // already in snapshot
    const ownOp = meta.op_id !== "" && state.pendingOps[meta.op_id];
    if (MOVES_ARCHIVE.has(event.type) || (event.type === "task.updated" && event.task.archived_at)) {
      state.refreshArchivedValues();
    }

    set((s) => {
      const previous = s.tasksById[task.id];
      const tasksById = { ...s.tasksById };
      // Gone to a board this one doesn't show: it leaves, like archiving.
      const elsewhere = !!s.board && task.board_id !== s.board.id && !(task.board_id in s.familyById);
      if (LEAVES_BOARD.has(event.type) || elsewhere) {
        delete tasksById[task.id];
      } else {
        tasksById[task.id] = task;
      }
      const pendingOps = { ...s.pendingOps };
      if (ownOp) delete pendingOps[meta.op_id];
      const archivedValues = MOVES_ARCHIVE.has(event.type)
        ? shiftArchivedValues(s.archivedValues, event.type, previous ?? task, tasksById, s.categoriesById)
        : s.archivedValues;

      const flashes = { ...s.flashes };
      // Animations come from the server (a rule's celebrate, an unblock
      // pulse): play them here too, even for our own change.
      if (event.type !== "task.archived" && isFlashAnimation(meta.animation)) {
        flashes[task.id] = meta.animation;
      }

      let verb = VERBS[event.type] ?? event.type;
      if (event.type === "task.updated" && meta.changed_fields?.includes("blocked_by")) {
        verb = meta.unblocked ? "unblocked" : "re-blocked";
      }
      const activity = ownOp
        ? s.activity
        : [
            {
              id: meta.event_id,
              text: `${meta.actor} ${verb} “${task.title}”`,
              animation: meta.animation,
              ts: meta.ts,
            },
            ...s.activity,
          ].slice(0, 20);

      return {
        tasksById,
        taskIdsByLane: rebuildLanes(tasksById, s.taskIdsByLane, [
          previous?.lane_id,
          task.lane_id,
        ]),
        childrenByParent: deriveChildren(tasksById, s.lanes),
        lastEventId: meta.event_id,
        pendingOps,
        flashes,
        activity,
        menu: LEAVES_BOARD.has(event.type) && s.menu?.taskId === task.id ? null : s.menu,
        focusTaskId: keepFocus(s.focusTaskId, tasksById, s.board?.id),
        archivedValues,
      };
    });
  },

  upsertTask(incoming) {
    set((s) => {
      const task = inDisplayLane(incoming, s.laneMap);
      const previous = s.tasksById[task.id];
      const tasksById = { ...s.tasksById, [task.id]: task };
      return {
        tasksById,
        taskIdsByLane: rebuildLanes(tasksById, s.taskIdsByLane, [
          previous?.lane_id,
          task.lane_id,
        ]),
        childrenByParent: deriveChildren(tasksById, s.lanes),
      };
    });
  },

  removeTask(taskId) {
    set((s) => {
      const task = s.tasksById[taskId];
      if (!task) return s;
      const tasksById = { ...s.tasksById };
      delete tasksById[taskId];
      return {
        tasksById,
        taskIdsByLane: rebuildLanes(tasksById, s.taskIdsByLane, [task.lane_id]),
        childrenByParent: deriveChildren(tasksById, s.lanes),
        menu: s.menu?.taskId === taskId ? null : s.menu,
        focusTaskId: keepFocus(s.focusTaskId, tasksById, s.board?.id),
      };
    });
  },

  optimisticMove(taskId, toLaneId, index) {
    set((s) => {
      const task = s.tasksById[taskId];
      if (!task) return s;
      const taskIdsByLane = { ...s.taskIdsByLane };
      for (const laneId of Object.keys(taskIdsByLane)) {
        if (taskIdsByLane[laneId].includes(taskId)) {
          taskIdsByLane[laneId] = taskIdsByLane[laneId].filter((id) => id !== taskId);
        }
      }
      const target = [...(taskIdsByLane[toLaneId] ?? [])];
      const clamped = Math.max(0, Math.min(index, target.length));
      target.splice(clamped, 0, taskId);
      taskIdsByLane[toLaneId] = target;
      return {
        taskIdsByLane,
        tasksById: { ...s.tasksById, [taskId]: { ...task, lane_id: toLaneId } },
      };
    });
  },

  reorderWithinLane(laneId, from, to) {
    set((s) => {
      const ids = [...(s.taskIdsByLane[laneId] ?? [])];
      const [moved] = ids.splice(from, 1);
      ids.splice(to, 0, moved);
      return { taskIdsByLane: { ...s.taskIdsByLane, [laneId]: ids } };
    });
  },

  restoreOrder(order, laneByTask) {
    set((s) => {
      const tasksById = { ...s.tasksById };
      for (const [taskId, laneId] of Object.entries(laneByTask)) {
        if (tasksById[taskId]) tasksById[taskId] = { ...tasksById[taskId], lane_id: laneId };
      }
      return { taskIdsByLane: order, tasksById };
    });
  },

  registerOp(opId) {
    set((s) => ({ pendingOps: { ...s.pendingOps, [opId]: true } }));
  },

  resolveOp(opId) {
    set((s) => {
      const pendingOps = { ...s.pendingOps };
      delete pendingOps[opId];
      return { pendingOps };
    });
  },

  clearFlash(taskId) {
    set((s) => {
      if (!(taskId in s.flashes)) return s;
      const flashes = { ...s.flashes };
      delete flashes[taskId];
      return { flashes };
    });
  },

  flashTasks(taskIds, animation) {
    if (!isFlashAnimation(animation)) return;
    set((s) => {
      const flashes = { ...s.flashes };
      for (const id of taskIds) {
        if (s.tasksById[id]) flashes[id] = animation;
      }
      return { flashes };
    });
  },

  setStatus(status) {
    set({ status });
  },

  setDragActive(dragActive) {
    set(dragActive ? { dragActive } : { dragActive, dropBlock: null });
  },

  setDropBlock(dropBlock) {
    set((s) =>
      s.dropBlock?.laneId === dropBlock?.laneId &&
      s.dropBlock?.blockers.join() === dropBlock?.blockers.join() &&
      s.dropBlock?.reason === dropBlock?.reason
        ? s
        : { dropBlock },
    );
  },

  openMenu(taskId, x, y) {
    set({ menu: { taskId, x, y } });
  },

  closeMenu() {
    set((s) => (s.menu ? { menu: null } : s));
  },

  openDetail(taskId) {
    set({ detailTaskId: taskId, menu: null });
  },

  closeDetail() {
    set((s) => (s.detailTaskId ? { detailTaskId: null } : s));
  },

  cycleSubtaskView(taskId) {
    set((s) => {
      const current = s.subtaskViews[taskId] ?? "list";
      const next = SUBTASK_VIEWS[(SUBTASK_VIEWS.indexOf(current) + 1) % SUBTASK_VIEWS.length];
      const subtaskViews = { ...s.subtaskViews };
      if (next === "list") delete subtaskViews[taskId];
      else subtaskViews[taskId] = next;
      if (s.board) saveSubtaskViews(s.board.id, subtaskViews);
      return { subtaskViews };
    });
  },

  setFocus(taskId) {
    const board = get().board;
    if (board) saveFocus(board.id, taskId);
    set({ focusTaskId: taskId, menu: null });
  },

  tickMinute() {
    set((s) => ({ tick: s.tick + 1 }));
  },

  setOwners(owners) {
    set((s) => {
      const ownersById = Object.fromEntries(owners.map((o) => [o.id, o]));
      // Archived or deleted owners leave the filter.
      const ownerFilter = s.ownerFilter.filter(
        (id) => id === "unassigned" || (ownersById[id] && !ownersById[id].archived),
      );
      if (ownerFilter.length !== s.ownerFilter.length && s.board) {
        saveOwnerFilter(s.board.id, ownerFilter);
      }
      return { ownersById, ownerFilter };
    });
  },

  setOwnerFilter(ids) {
    const board = get().board;
    if (board) saveOwnerFilter(board.id, ids);
    set({ ownerFilter: ids });
  },

  upsertCategory(category) {
    set((s) => {
      const categoriesById = { ...s.categoriesById };
      // Another board's own category (or one just moved to another board)
      // isn't ours to show.
      const visible =
        category.board_id === null ||
        category.board_id === s.board?.id ||
        category.board_id in s.familyById;
      if (visible) categoriesById[category.id] = category;
      else delete categoriesById[category.id];
      // Removed or moved-away categories leave the filter.
      let categoryFilter = s.categoryFilter;
      if ((!visible || category.archived) && categoryFilter.includes(category.id)) {
        categoryFilter = categoryFilter.filter((id) => id !== category.id);
        if (s.board) saveCategoryFilter(s.board.id, categoryFilter);
      }
      return { categoriesById, categoryFilter };
    });
  },

  setColourBy(colourBy) {
    const board = get().board;
    if (board) saveColourBy(board.id, colourBy);
    set({ colourBy });
  },

  setCategoryFilter(ids) {
    const board = get().board;
    if (board) saveCategoryFilter(board.id, ids);
    set({ categoryFilter: ids });
  },

  setFamilyOpen(familyOpen) {
    set({ familyOpen, menu: null });
  },

  setLanesOpen(lanesOpen) {
    set({ lanesOpen, menu: null });
  },

  setSearchOpen(searchOpen) {
    set({ searchOpen, menu: null });
  },

  refreshArchivedValues() {
    window.clearTimeout(archivedTimer);
    archivedTimer = window.setTimeout(async () => {
      const boardId = get().board?.id;
      if (!boardId) return;
      try {
        const values = await getArchivedValues(boardId);
        if (get().board?.id === boardId) set({ archivedValues: values });
      } catch {
        // Totals catch up at the next snapshot.
      }
    }, 400);
  },

  offerUndo(label, run) {
    undoSeq += 1;
    set({ undo: { id: undoSeq, label, run } });
  },

  clearUndo() {
    set((s) => (s.undo ? { undo: null } : s));
  },

  setLanes(lanes) {
    set((s) => {
      const taskIdsByLane: Record<string, string[]> = {};
      for (const lane of lanes) taskIdsByLane[lane.id] = s.taskIdsByLane[lane.id] ?? [];
      return { lanes, taskIdsByLane };
    });
  },

  homeLane(task, displayLaneId) {
    const s = get();
    if (task.board_id === s.board?.id) return displayLaneId;
    return s.laneBack[task.board_id]?.[displayLaneId] ?? displayLaneId;
  },

  setView(view) {
    set({ view, menu: null });
  },

  setSettingsOpen(settingsOpen) {
    set({ settingsOpen, menu: null });
  },
}));
