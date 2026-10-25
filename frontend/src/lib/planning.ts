/** Planning today: put a task on (or take it off) today's plan by setting
 * its deadline to today — the Today view lists it — and mark it done. */

import { setTaskDueDate } from "../api/client";
import { useBoardStore } from "../store/boardStore";
import { today } from "./cardColour";
import { newOpId } from "./compat";
import { quote } from "./undo";

export { doneLaneFor, markDone } from "./subtasks";

/** Deadline today, or cleared if it's already today. With undo. */
export async function toggleToday(taskId: string): Promise<void> {
  const store = useBoardStore.getState();
  const task = store.tasksById[taskId];
  if (!task) return;
  const before = task.due_date;
  const next = before === today() ? null : today();
  const opId = newOpId();
  store.registerOp(opId);
  store.upsertTask({ ...task, due_date: next });
  const set = async (due: string | null, op?: string) => {
    const updated = await setTaskDueDate(taskId, due, { ...(op ? { op_id: op } : {}), actor: "board-user" });
    useBoardStore.getState().upsertTask(updated);
  };
  try {
    await set(next, opId);
    useBoardStore
      .getState()
      .offerUndo(`${next ? "Added to Today" : "Removed from Today"}: ${quote(task.title)}`, () => set(before));
  } catch {
    const s = useBoardStore.getState();
    s.resolveOp(opId);
    if (s.tasksById[taskId]) s.upsertTask({ ...s.tasksById[taskId], due_date: before });
  }
}

/** Subtasks not yet in a final lane (the server won't move a parent past them). */
export function useUnfinishedSubtasks(taskId: string): number {
  return useBoardStore(
    (s) =>
      (s.childrenByParent[taskId] ?? []).filter((id) => {
        const lane = s.lanes.find((l) => l.id === s.tasksById[id]?.lane_id);
        return !lane?.is_final;
      }).length,
  );
}
