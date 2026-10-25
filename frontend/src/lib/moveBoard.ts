/** Moving a task to another board (its subtasks go with it), with undo:
 * back to the board and lane it came from. */

import { ApiError, getSnapshot, moveTaskToBoard } from "../api/client";
import { useBoardStore } from "../store/boardStore";
import { newOpId } from "./compat";
import { quote } from "./undo";

export async function moveToBoard(
  taskId: string,
  target: { boardId: string; boardName: string; laneId?: string; laneName?: string; index?: number },
): Promise<string | null> {
  const s = useBoardStore.getState();
  const task = s.tasksById[taskId];
  if (!task) return "That task isn’t on this board any more.";
  const from = { boardId: task.board_id, laneId: s.homeLane(task, task.lane_id) };
  const staysInView = target.boardId === s.board?.id || target.boardId in s.familyById;
  const opId = newOpId();
  s.registerOp(opId);
  if (!staysInView) {
    s.removeTask(taskId);
    if (s.detailTaskId === taskId) s.closeDetail();
  }
  try {
    await moveTaskToBoard(taskId, {
      board_id: target.boardId,
      ...(target.laneId ? { lane_id: target.laneId } : {}),
      ...(target.index !== undefined ? { index: target.index } : {}),
      meta: { op_id: opId, actor: "board-user" },
    });
    useBoardStore
      .getState()
      .offerUndo(`Moved ${quote(task.title)} to ${target.boardName}${target.laneName ? ` · ${target.laneName}` : ""}`, () =>
        moveTaskToBoard(taskId, { board_id: from.boardId, lane_id: from.laneId, meta: { actor: "board-user" } }),
      );
    return null;
  } catch (e) {
    const state = useBoardStore.getState();
    state.resolveOp(opId);
    if (state.board) getSnapshot(state.board.id).then((snap) => useBoardStore.getState().loadSnapshot(snap));
    return (e instanceof ApiError && e.detail) || "Couldn’t move it.";
  }
}
