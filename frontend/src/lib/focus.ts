/** Focus mode: one task per board (per device) is "in focus". It, its
 * parents and all of its subtasks (any depth) form the focus group: they
 * stay sharp and are shown first in each lane, above a divider. Every other
 * card fades back. Display only: stored order is never changed. */

import type { Task } from "../types";

export type FocusState = "none" | "focused" | "subtask" | "parent" | "dimmed";

type TaskIndex = Record<string, Pick<Task, "parent_id">>;

/** Ids up the parent chain from a task, nearest first. Cycle-safe, since
 * the store may briefly hold stale rows. */
function ancestorsOf(taskId: string, tasksById: TaskIndex): string[] {
  const seen = new Set<string>([taskId]);
  const chain: string[] = [];
  let parentId = tasksById[taskId]?.parent_id ?? null;
  while (parentId && !seen.has(parentId)) {
    chain.push(parentId);
    seen.add(parentId);
    parentId = tasksById[parentId]?.parent_id ?? null;
  }
  return chain;
}

export function focusStateOf(
  taskId: string,
  focusTaskId: string | null,
  tasksById: TaskIndex,
): FocusState {
  if (!focusTaskId || !tasksById[focusTaskId]) return "none";
  if (taskId === focusTaskId) return "focused";
  if (ancestorsOf(taskId, tasksById).includes(focusTaskId)) return "subtask";
  if (ancestorsOf(focusTaskId, tasksById).includes(taskId)) return "parent";
  return "dimmed";
}

/** How many levels below the focused task a subtask sits (1 = direct child);
 * 0 for anything that isn't one of its subtasks. */
export function focusDepthOf(
  taskId: string,
  focusTaskId: string | null,
  tasksById: TaskIndex,
): number {
  if (!focusTaskId || taskId === focusTaskId) return 0;
  return ancestorsOf(taskId, tasksById).indexOf(focusTaskId) + 1;
}

export function inFocusGroup(state: FocusState): boolean {
  return state === "focused" || state === "subtask" || state === "parent";
}

/** A lane's display order: the focus group first (parents, the focused
 * task, then subtasks by depth), then the rest in stored order. Without focus, the stored order unchanged. */
export function focusOrder(
  ids: string[],
  focusTaskId: string | null,
  tasksById: TaskIndex,
): { group: string[]; rest: string[] } {
  if (!focusTaskId || !tasksById[focusTaskId]) return { group: [], rest: ids };
  const group: string[] = [];
  const rest: string[] = [];
  for (const id of ids) {
    (inFocusGroup(focusStateOf(id, focusTaskId, tasksById)) ? group : rest).push(id);
  }
  // Within the group, read top-down like a tree: parents, then the focused
  // task, then its subtasks level by level (stable, so lane order holds
  // among equals).
  const rank = (id: string) => {
    const state = focusStateOf(id, focusTaskId, tasksById);
    return state === "parent" ? -1 : focusDepthOf(id, focusTaskId, tasksById);
  };
  group.sort((a, b) => rank(a) - rank(b));
  return { group, rest };
}

const key = (boardId: string) => `utd.focus.${boardId}`;

export function loadFocus(boardId: string): string | null {
  try {
    return localStorage.getItem(key(boardId));
  } catch {
    return null; // storage unavailable: focus lasts for this page only
  }
}

export function saveFocus(boardId: string, taskId: string | null) {
  try {
    if (taskId) localStorage.setItem(key(boardId), taskId);
    else localStorage.removeItem(key(boardId));
  } catch {
    // non-persistent is fine
  }
}
