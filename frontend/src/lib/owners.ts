/** Owner filter: which owners' tasks the board shows. Empty means no
 * filter. Per device, remembered per board, like focus. */

import type { Owner, Task } from "../types";

/** Filter entry for tasks with no (active) owner. */
export const UNASSIGNED = "unassigned";

const key = (boardId: string) => `utd.ownerFilter.${boardId}`;

export function loadOwnerFilter(boardId: string): string[] {
  try {
    const ids: unknown = JSON.parse(localStorage.getItem(key(boardId)) ?? "[]");
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export function saveOwnerFilter(boardId: string, ids: string[]) {
  try {
    if (ids.length) localStorage.setItem(key(boardId), JSON.stringify(ids));
    else localStorage.removeItem(key(boardId));
  } catch {
    // non-persistent is fine
  }
}

/** The task's owners that should be shown: known and not archived. */
export function activeOwnersOf(task: Task, ownersById: Record<string, Owner>): Owner[] {
  return task.owner_ids.flatMap((id) => {
    const owner = ownersById[id];
    return owner && !owner.archived ? [owner] : [];
  });
}

/** Does the task pass the filter? Any selected owner (or "unassigned") matches. */
export function passesOwnerFilter(
  task: Task,
  filter: string[],
  ownersById: Record<string, Owner>,
): boolean {
  if (filter.length === 0) return true;
  const owners = activeOwnersOf(task, ownersById);
  if (owners.length === 0) return filter.includes(UNASSIGNED);
  return owners.some((o) => filter.includes(o.id));
}

/** Readable text on a background: near-white or near-black, whichever
 * contrasts more (WCAG relative luminance). */
export function readableOn(bg: string): string {
  const hex = bg.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.36 ? "#111827" : "#ffffff";
}

/** Initials suggested from a name: "Ada Lovelace" → "AL", "Acme" → "ACME". */
export function suggestCode(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  if (words.length === 1) return words[0].slice(0, 4).toUpperCase();
  return words.slice(0, 3).map((w) => w[0]).join("").toUpperCase();
}
