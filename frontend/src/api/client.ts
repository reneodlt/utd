import type {
  ArchivedValue,
  Attachment,
  Board,
  BoardSummary,
  BoardWithLanes,
  OwnerPeriod,
  Place,
  Rule,
  RuleRunRecord,
  TaskComment,
  Category,
  Lane,
  Owner,
  Snapshot,
  Task,
  TaskHistoryPage,
  ValueConfig,
} from "../types";

export interface MutationMeta {
  op_id?: string;
  animation?: string;
  actor?: string;
}

/** A failed request; `detail` is the server's human-readable reason, if any. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly detail: string | undefined,
    readonly status = 0,
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

function parsed(body: string): Record<string, unknown> {
  try {
    const value = JSON.parse(body);
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function detailOf(body: string): string | undefined {
  try {
    const detail = JSON.parse(body)?.detail;
    return typeof detail === "string" ? detail : undefined;
  } catch {
    return undefined;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // FormData (uploads) sets its own multipart Content-Type.
  const json = !(init?.body instanceof FormData);
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(json ? { "Content-Type": "application/json" } : {}),
      "X-UTD-Source": "ui",
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new ApiError(`${response.status} ${path}: ${body}`, detailOf(body), response.status, parsed(body));
  }
  if (response.status === 204) return undefined as T;
  return response.json();
}

export function getBoards(): Promise<BoardSummary[]> {
  return request("/api/boards/");
}

export function createBoard(
  name: string,
  parentId: string | null = null,
): Promise<Board & { lanes: Lane[] }> {
  return request("/api/boards/", {
    method: "POST",
    body: JSON.stringify({ name, ...(parentId ? { parent_id: parentId } : {}) }),
  });
}

/** Re-parent a board; null makes it top level. */
export function setBoardParent(boardId: string, parentId: string | null): Promise<Board> {
  return request(`/api/boards/${boardId}/`, {
    method: "PATCH",
    body: JSON.stringify({ parent_id: parentId }),
  });
}

export function setHoursPerDay(boardId: string, hours: number | null): Promise<Board> {
  return request(`/api/boards/${boardId}/`, {
    method: "PATCH",
    body: JSON.stringify({ hours_per_day: hours }),
  });
}

export function getArchivedValues(boardId: string): Promise<ArchivedValue[]> {
  return request(`/api/boards/${boardId}/archived-values/`);
}

/** Set (or, with null, clear) a task's figures, per category. */
export function setTaskValues(
  taskId: string,
  values: Record<string, number | Place | null>,
  meta?: MutationMeta,
): Promise<Task> {
  return request(`/api/tasks/${taskId}/`, {
    method: "PATCH",
    body: JSON.stringify({ values, meta }),
  });
}

/** Every board with its lanes (where a task can go). */
export function getBoardsWithLanes(): Promise<BoardWithLanes[]> {
  return request(`/api/boards/?lanes=1`);
}

/** To another board (subtasks and all); lane defaults to the same-named one. */
export function moveTaskToBoard(
  taskId: string,
  body: { board_id: string; lane_id?: string; index?: number; meta?: MutationMeta },
): Promise<Task> {
  return request(`/api/tasks/${taskId}/move-board/`, { method: "POST", body: JSON.stringify(body) });
}

export function getOwnerLog(taskId: string): Promise<OwnerPeriod[]> {
  return request(`/api/tasks/${taskId}/owner-log/`);
}

/** Flip a task's board options: hide its subtasks, owners follow the next one. */
export function setTaskFlags(
  taskId: string,
  flags: { hide_subtasks?: boolean; owner_follows_next?: boolean },
  meta?: MutationMeta,
): Promise<Task> {
  return request(`/api/tasks/${taskId}/`, { method: "PATCH", body: JSON.stringify({ ...flags, meta }) });
}

export type RuleDraft = Pick<Rule, "name" | "scope" | "trigger" | "conditions" | "actions"> & { enabled?: boolean };

export function getRules(boardId: string): Promise<Rule[]> {
  return request(`/api/boards/${boardId}/rules/`);
}

export function createRule(boardId: string, rule: RuleDraft): Promise<Rule> {
  return request(`/api/boards/${boardId}/rules/`, { method: "POST", body: JSON.stringify(rule) });
}

export function updateRule(ruleId: string, fields: Partial<RuleDraft> & { archived?: boolean }): Promise<Rule> {
  return request(`/api/rules/${ruleId}/`, { method: "PATCH", body: JSON.stringify(fields) });
}

export function getRuleRuns(ruleId: string): Promise<{ count: number; runs: RuleRunRecord[] }> {
  return request(`/api/rules/${ruleId}/runs/`);
}

export function getComments(taskId: string): Promise<TaskComment[]> {
  return request(`/api/tasks/${taskId}/comments/`);
}

export function addComment(
  taskId: string,
  body: { body: string; about_id?: string | null; happened_at?: string; meta?: MutationMeta },
): Promise<TaskComment> {
  return request(`/api/tasks/${taskId}/comments/`, { method: "POST", body: JSON.stringify(body) });
}

export function updateComment(
  commentId: string,
  fields: { body?: string; about_id?: string | null; happened_at?: string | null; deleted?: boolean; meta?: MutationMeta },
): Promise<TaskComment> {
  return request(`/api/comments/${commentId}/`, { method: "PATCH", body: JSON.stringify(fields) });
}

/** Address search (OpenStreetMap, via the UTD server). */
export function geocode(query: string): Promise<Place[]> {
  return request(`/api/geocode/?q=${encodeURIComponent(query)}`);
}

export function renameBoard(boardId: string, name: string): Promise<Board> {
  return request(`/api/boards/${boardId}/`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
}

export function archiveBoard(boardId: string): Promise<void> {
  return request(`/api/boards/${boardId}/`, { method: "DELETE" });
}

export function getSnapshot(boardId: string): Promise<Snapshot> {
  return request(`/api/boards/${boardId}/snapshot/`);
}

export function createTask(
  boardId: string,
  body: {
    lane_id: string;
    title: string;
    description?: string;
    parent_id?: string;
    index?: number;
    /** Created with the task, atomically. */
    attachments?: { kind: string; data: Record<string, string>; label?: string }[];
    /** Deadline, YYYY-MM-DD. */
    due_date?: string;
    category_ids?: string[];
    /** {category_id: figure}; each category must be in category_ids. */
    values?: Record<string, number>;
    meta?: MutationMeta;
  },
): Promise<Task> {
  return request(`/api/boards/${boardId}/tasks/`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function moveTask(
  taskId: string,
  /** index null/absent = the end of the lane. */
  body: { to_lane_id: string; index?: number | null; meta?: MutationMeta },
): Promise<Task> {
  return request(`/api/tasks/${taskId}/move/`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function archiveTask(taskId: string, meta?: MutationMeta): Promise<void> {
  return request(`/api/tasks/${taskId}/archive/`, {
    method: "POST",
    body: JSON.stringify({ meta }),
  });
}

/** Soft delete into the bin; restorable. */
export function deleteTask(taskId: string, meta?: MutationMeta): Promise<Task> {
  return request(`/api/tasks/${taskId}/delete/`, {
    method: "POST",
    body: JSON.stringify({ meta }),
  });
}

export function restoreTask(taskId: string, meta?: MutationMeta): Promise<Task> {
  return request(`/api/tasks/${taskId}/restore/`, {
    method: "POST",
    body: JSON.stringify({ meta }),
  });
}

export function archiveLane(laneId: string, meta?: MutationMeta): Promise<{ archived: string[] }> {
  return request(`/api/lanes/${laneId}/archive-all/`, {
    method: "POST",
    body: JSON.stringify({ meta }),
  });
}

/** Archived or binned tasks, newest first (capped server-side). */
export function getOffBoardTasks(
  boardId: string,
  state: "archived" | "deleted",
): Promise<{ count: number; results: Task[] }> {
  return request(`/api/boards/${boardId}/tasks/?state=${state}`);
}

export const HISTORY_PAGE_SIZE = 50;

/** A card's audit trail, newest first, including its subtasks' creation. */
export function getTaskHistory(taskId: string, offset = 0): Promise<TaskHistoryPage> {
  const query = `include=subtasks&limit=${HISTORY_PAGE_SIZE}&offset=${offset}`;
  return request(`/api/tasks/${taskId}/events/?${query}`);
}

/** An attachment change answers with the task as it now stands. */
export interface AttachmentResult {
  attachment: Attachment;
  task: Task;
}

export function addAttachment(
  taskId: string,
  body: { kind: string; data: Record<string, string>; label?: string; meta?: MutationMeta },
): Promise<AttachmentResult> {
  return request(`/api/tasks/${taskId}/attachments/`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function updateAttachment(
  taskId: string,
  attachmentId: string,
  body: { data?: Record<string, string>; label?: string; meta?: MutationMeta },
): Promise<AttachmentResult> {
  return request(`/api/tasks/${taskId}/attachments/${attachmentId}/`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function removeAttachment(
  taskId: string,
  attachmentId: string,
  meta?: MutationMeta,
): Promise<AttachmentResult> {
  return request(`/api/tasks/${taskId}/attachments/${attachmentId}/`, {
    method: "DELETE",
    body: JSON.stringify({ meta }),
  });
}

export function setTaskOwners(
  taskId: string,
  ownerIds: string[],
  meta?: MutationMeta,
): Promise<Task> {
  return request(`/api/tasks/${taskId}/`, {
    method: "PATCH",
    body: JSON.stringify({ owner_ids: ownerIds, meta }),
  });
}

export type OwnerFields = Pick<Owner, "name" | "code" | "fg" | "bg" | "emoji" | "contacts">;

export function createOwner(fields: OwnerFields): Promise<Owner> {
  return request("/api/owners/", { method: "POST", body: JSON.stringify(fields) });
}

export function updateOwner(ownerId: string, fields: Partial<OwnerFields>): Promise<Owner> {
  return request(`/api/owners/${ownerId}/`, { method: "PATCH", body: JSON.stringify(fields) });
}

export function archiveOwner(ownerId: string): Promise<void> {
  return request(`/api/owners/${ownerId}/`, { method: "DELETE" });
}

export function setTaskCategories(
  taskId: string,
  categoryIds: string[],
  meta?: MutationMeta,
): Promise<Task> {
  return request(`/api/tasks/${taskId}/`, {
    method: "PATCH",
    body: JSON.stringify({ category_ids: categoryIds, meta }),
  });
}

/** A new category: this board's own, or shared by every board. */
export function createCategory(
  boardId: string,
  fields: { name: string; color: string; shared: boolean; value_type?: string; value_config?: ValueConfig },
): Promise<Category> {
  return request(`/api/boards/${boardId}/categories/`, {
    method: "POST",
    body: JSON.stringify(fields),
  });
}

/** board_id: null shares it; a board id makes it that board's own. */
export function updateCategory(
  categoryId: string,
  fields: Partial<Pick<Category, "name" | "color" | "board_id" | "value_type" | "value_config">>,
): Promise<Category> {
  return request(`/api/categories/${categoryId}/`, {
    method: "PATCH",
    body: JSON.stringify(fields),
  });
}

export function archiveCategory(categoryId: string): Promise<void> {
  return request(`/api/categories/${categoryId}/`, { method: "DELETE" });
}

/** Replace a task's details (Markdown). Audited like any edit. */
export function setTaskDescription(
  taskId: string,
  description: string,
  meta?: MutationMeta,
): Promise<Task> {
  return request(`/api/tasks/${taskId}/`, {
    method: "PATCH",
    body: JSON.stringify({ description, meta }),
  });
}

export type LaneFields = Partial<Pick<Lane, "name" | "color" | "wip_limit" | "is_final">>;

/** Lane changes answer with the board's lanes, in order. */
export function addLane(boardId: string, fields: LaneFields & { index?: number }): Promise<Lane[]> {
  return request(`/api/boards/${boardId}/lanes/`, { method: "POST", body: JSON.stringify(fields) });
}

/** `cascade` renames the same lane on sub-boards too (else 409 "used_below"). */
export function updateLane(laneId: string, fields: LaneFields & { cascade?: boolean }): Promise<Lane[]> {
  return request(`/api/lanes/${laneId}/`, { method: "PATCH", body: JSON.stringify(fields) });
}

export function reorderLanes(boardId: string, laneIds: string[]): Promise<Lane[]> {
  return request(`/api/boards/${boardId}/lanes/order/`, {
    method: "POST",
    body: JSON.stringify({ lane_ids: laneIds }),
  });
}

/** Hide a lane; its open tasks move to `moveTo` (required if it has any). */
export function removeLane(laneId: string, moveTo?: string): Promise<Lane[]> {
  const query = moveTo ? `?move_to=${moveTo}` : "";
  return request(`/api/lanes/${laneId}/${query}`, { method: "DELETE" });
}

/** A pasted link's real title (GitHub PR/issue title, page title), or {}. */
export function getLinkTitle(url: string): Promise<{ title?: string; state?: string }> {
  return request(`/api/link-title/?url=${encodeURIComponent(url)}`);
}

/** Set or clear (null) a task's deadline, YYYY-MM-DD. */
export function setTaskDueDate(taskId: string, dueDate: string | null, meta?: MutationMeta): Promise<Task> {
  return request(`/api/tasks/${taskId}/`, {
    method: "PATCH",
    body: JSON.stringify({ due_date: dueDate, meta }),
  });
}

/** Category priority, highest first (sets "colour by category"). */
export function reorderCategories(categoryIds: string[]): Promise<void> {
  return request("/api/categories/order/", {
    method: "POST",
    body: JSON.stringify({ category_ids: categoryIds }),
  });
}

export interface SearchResults {
  boards: { id: string; name: string; slug: string }[];
  tasks: {
    id: string;
    title: string;
    board: { id: string; name: string; slug: string };
    lane: string;
    state: "open" | "archived" | "deleted";
    parent_title: string | null;
    due_date: string | null;
    snippet: string;
  }[];
}

/** Every board's tasks (title, details, attachments) and board names. */
export function search(query: string): Promise<SearchResults> {
  return request(`/api/search/?q=${encodeURIComponent(query)}`);
}

export function linkTasks(fromId: string, toId: string, linkType: string, meta?: MutationMeta): Promise<unknown> {
  return request(`/api/tasks/${fromId}/links/`, {
    method: "POST",
    body: JSON.stringify({ to_task_id: toId, link_type: linkType, meta }),
  });
}

export function unlinkTasks(fromId: string, linkId: string, meta?: MutationMeta): Promise<void> {
  return request(`/api/tasks/${fromId}/links/${linkId}/`, {
    method: "DELETE",
    body: JSON.stringify({ meta }),
  });
}

/** Attach photos/files to a task (multipart). */
export function uploadFiles(taskId: string, files: File[]): Promise<{ attachments: Attachment[]; task: Task }> {
  const form = new FormData();
  for (const f of files) form.append("file", f);
  form.append("meta", JSON.stringify({ actor: "board-user" }));
  return request(`/api/tasks/${taskId}/files/`, { method: "POST", body: form });
}

/** A new task carrying one photo/file, created together. */
export function createFileTask(
  boardId: string,
  file: File,
  fields: { lane_id: string; title: string; parent_id?: string; due_date?: string },
): Promise<Task> {
  const form = new FormData();
  form.append("file", file);
  for (const [k, v] of Object.entries(fields)) if (v) form.append(k, v);
  form.append("meta", JSON.stringify({ actor: "board-user" }));
  return request(`/api/boards/${boardId}/file-task/`, { method: "POST", body: form });
}

export interface AgendaTask extends Task {
  board: { id: string; name: string; slug: string };
  lane: { name: string; color: string };
  done_lane_id: string | null;
  parent_title: string | null;
}

/** Unfinished tasks on every board due by today+days (overdue included). */
export function getAgenda(today: string, days = 7): Promise<{ today: string; tasks: AgendaTask[] }> {
  return request(`/api/agenda/?today=${today}&days=${days}`);
}

/** Rename a task. */
export function setTaskTitle(taskId: string, title: string, meta?: MutationMeta): Promise<Task> {
  return request(`/api/tasks/${taskId}/`, {
    method: "PATCH",
    body: JSON.stringify({ title, meta }),
  });
}
