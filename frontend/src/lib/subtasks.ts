/** Acting on subtasks from their parent card: tick one off (into a final
 * lane), or add new ones (quick-add parsing, same as the header). */

import { createTask, getSnapshot, moveTask } from "../api/client";
import { newOpId } from "./compat";
import { figureFields } from "./figureParse";
import { resolveDrafts, parseQuickAdd } from "./quickAdd";
import { useBoardStore } from "../store/boardStore";
import { moveBack, placeOf, quote } from "./undo";

/** Move a subtask into its board's first final ("done") lane. */
export function checkOffSubtask(subtaskId: string): Promise<boolean> {
  return markDone(subtaskId, "Ticked off");
}

/** The final ("done") lane a task would go to from this board, if any. */
export function doneLaneFor(taskId: string) {
  const s = useBoardStore.getState();
  const task = s.tasksById[taskId];
  if (!task) return undefined;
  const own = task.board_id === s.board?.id;
  // A final lane this board shows that the task's own board also has.
  return s.lanes.find((l) => l.is_final && (own || s.laneBack[task.board_id]?.[l.id]));
}

/** Move a task into its board's final lane, with undo. */
export async function markDone(subtaskId: string, verb = "Done:"): Promise<boolean> {
  const s = useBoardStore.getState();
  const sub = s.tasksById[subtaskId];
  if (!sub) return false;
  const target = doneLaneFor(subtaskId);
  if (!target) return false;
  const from = placeOf(subtaskId);
  const opId = newOpId();
  s.registerOp(opId);
  s.optimisticMove(subtaskId, target.id, (s.taskIdsByLane[target.id] ?? []).length);
  try {
    await moveTask(subtaskId, {
      to_lane_id: s.homeLane(sub, target.id),
      index: null,
      meta: { op_id: opId, actor: "board-user" },
    });
    if (from) useBoardStore.getState().offerUndo(`${verb} ${quote(sub.title)}`, () => moveBack(subtaskId, from));
    return true;
  } catch {
    // Put the board back as the server has it.
    const state = useBoardStore.getState();
    state.resolveOp(opId);
    if (state.board) getSnapshot(state.board.id).then((snap) => useBoardStore.getState().loadSnapshot(snap));
    return false;
  }
}

/** Add subtasks under a parent from quick-add text; returns what failed. */
export async function addSubtasks(parentId: string, text: string): Promise<string[]> {
  const s = useBoardStore.getState();
  const parent = s.tasksById[parentId];
  if (!parent) return [];
  const drafts = await resolveDrafts(parseQuickAdd(text));
  const failed: string[] = [];
  const created: string[] = [];
  for (const d of drafts) {
    const opId = newOpId();
    useBoardStore.getState().registerOp(opId);
    try {
      const task = await createTask(parent.board_id, {
        // In the parent's own lane, like "Add subtask…".
        lane_id: useBoardStore.getState().homeLane(parent, parent.lane_id),
        ...figureFields(d.title.slice(0, 300), d.figures, parent.board_id),
        parent_id: parent.id,
        attachments: d.attachment ? [d.attachment] : undefined,
        due_date: d.due,
        meta: { op_id: opId, actor: "board-user" },
      });
      useBoardStore.getState().upsertTask(task);
      created.push(task.id);
    } catch {
      useBoardStore.getState().resolveOp(opId);
      failed.push(d.title);
    }
  }
  useBoardStore.getState().flashTasks(created, "pulse");
  return failed;
}
