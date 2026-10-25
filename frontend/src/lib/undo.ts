/** The reverse of common actions, for the undo toast. Each undo is an
 * ordinary change through the API (so it's audited like any other). */

import { archiveTask, deleteTask, getSnapshot, moveTask, restoreTask } from "../api/client";
import { useBoardStore } from "../store/boardStore";
import { newOpId } from "./compat";

/** Where a card sat: its display lane and index (this view), and its
 * index among its own board's cards (what the server's move needs). */
export interface Place {
  laneId: string;
  index: number;
  sameBoardIndex: number;
}

export function placeOf(taskId: string, order = useBoardStore.getState().taskIdsByLane): Place | null {
  const s = useBoardStore.getState();
  const task = s.tasksById[taskId];
  if (!task) return null;
  for (const [laneId, ids] of Object.entries(order)) {
    const index = ids.indexOf(taskId);
    if (index < 0) continue;
    const sameBoardIndex = ids.slice(0, index).filter((id) => s.tasksById[id]?.board_id === task.board_id).length;
    return { laneId, index, sameBoardIndex };
  }
  return null;
}

/** Put a card back where it was. */
export async function moveBack(taskId: string, place: Place): Promise<void> {
  const s = useBoardStore.getState();
  const task = s.tasksById[taskId];
  if (!task) throw new Error("gone");
  const opId = newOpId();
  s.registerOp(opId);
  s.optimisticMove(taskId, place.laneId, place.index);
  try {
    await moveTask(taskId, {
      to_lane_id: s.homeLane(task, place.laneId),
      index: place.sameBoardIndex,
      meta: { op_id: opId, actor: "board-user" },
    });
  } catch (e) {
    const state = useBoardStore.getState();
    state.resolveOp(opId);
    if (state.board) getSnapshot(state.board.id).then((snap) => useBoardStore.getState().loadSnapshot(snap));
    throw e;
  }
}

/** Bring archived/deleted tasks back onto the board. */
export async function restoreAll(taskIds: string[]): Promise<void> {
  for (const id of taskIds) {
    const task = await restoreTask(id, { actor: "board-user" });
    useBoardStore.getState().upsertTask(task);
  }
}

/** Bin → archive: a deleted task is also "archived", so archiving it again
 * is a no-op; restore it first, then archive. */
export async function binToArchive(taskId: string): Promise<void> {
  await restoreTask(taskId, { actor: "board-user" });
  await archiveTask(taskId, { actor: "board-user" });
  useBoardStore.getState().removeTask(taskId);
}

/** Put a restored task back where it came from: the archive or the bin. */
export async function sendBack(taskId: string, to: "archived" | "deleted"): Promise<void> {
  await (to === "archived" ? archiveTask : deleteTask)(taskId, { actor: "board-user" });
  useBoardStore.getState().removeTask(taskId);
}

export const quote = (title: string) => `“${title.length > 40 ? `${title.slice(0, 39)}…` : title}”`;
