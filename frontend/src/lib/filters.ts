/** Board filters: by owner and by category. Within one filter any chosen
 * value matches; across filters a task must pass both. An empty filter is
 * off. Each is per device, remembered per board. */

import type { Category, Owner, Task } from "../types";
import { passesOwnerFilter } from "./owners";

/** Category filter entry for tasks with no (active) category. */
export const UNCATEGORISED = "uncategorised";

const key = (boardId: string) => `utd.categoryFilter.${boardId}`;

export function loadCategoryFilter(boardId: string): string[] {
  try {
    const ids: unknown = JSON.parse(localStorage.getItem(key(boardId)) ?? "[]");
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export function saveCategoryFilter(boardId: string, ids: string[]) {
  try {
    if (ids.length) localStorage.setItem(key(boardId), JSON.stringify(ids));
    else localStorage.removeItem(key(boardId));
  } catch {
    // non-persistent is fine
  }
}

export function passesCategoryFilter(
  task: Task,
  filter: string[],
  categoriesById: Record<string, Category>,
): boolean {
  if (filter.length === 0) return true;
  const active = task.category_ids.filter((id) => categoriesById[id] && !categoriesById[id].archived);
  if (active.length === 0) return filter.includes(UNCATEGORISED);
  return active.some((id) => filter.includes(id));
}

export interface FilterState {
  ownerFilter: string[];
  ownersById: Record<string, Owner>;
  categoryFilter: string[];
  categoriesById: Record<string, Category>;
}

export function filtersActive(s: FilterState): boolean {
  return s.ownerFilter.length > 0 || s.categoryFilter.length > 0;
}

export function passesFilters(task: Task, s: FilterState): boolean {
  return (
    passesOwnerFilter(task, s.ownerFilter, s.ownersById) &&
    passesCategoryFilter(task, s.categoryFilter, s.categoriesById)
  );
}
