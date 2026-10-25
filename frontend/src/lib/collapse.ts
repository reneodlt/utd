/** How each card shows its subtasks: a list (default), a checklist
 * (tick unfinished ones off from the parent), or a progress bar. Per
 * device, remembered per board, like focus. */

export type SubtaskView = "list" | "checklist" | "bar";

export const SUBTASK_VIEWS: SubtaskView[] = ["list", "checklist", "bar"];

const key = (boardId: string) => `utd.subtaskView.${boardId}`;
// Before checklists existed: an array of ids shown as a bar.
const legacyKey = (boardId: string) => `utd.collapsed.${boardId}`;

export function loadSubtaskViews(boardId: string): Record<string, SubtaskView> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(key(boardId)) ?? "null");
    if (stored && typeof stored === "object" && !Array.isArray(stored)) {
      return Object.fromEntries(
        Object.entries(stored).filter(([, v]) => v === "checklist" || v === "bar"),
      ) as Record<string, SubtaskView>;
    }
    const legacy: unknown = JSON.parse(localStorage.getItem(legacyKey(boardId)) ?? "[]");
    return Array.isArray(legacy)
      ? Object.fromEntries(legacy.filter((id) => typeof id === "string").map((id) => [id, "bar"]))
      : {};
  } catch {
    return {};
  }
}

export function saveSubtaskViews(boardId: string, views: Record<string, SubtaskView>) {
  try {
    if (Object.keys(views).length) localStorage.setItem(key(boardId), JSON.stringify(views));
    else localStorage.removeItem(key(boardId));
    localStorage.removeItem(legacyKey(boardId));
  } catch {
    // non-persistent is fine
  }
}
