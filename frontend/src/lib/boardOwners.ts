/** Owners are shared by every board, so each board's pickers lead with
 * the people actually used on it (most recent first); everyone else is a
 * search away under "More people…". */

import { useMemo } from "react";
import { useBoardStore } from "../store/boardStore";
import type { Owner } from "../types";

export interface BoardOwners {
  /** Used on this board (or its sub-boards), most recent first. */
  shortlist: Owner[];
  /** Everyone else, in their usual order. */
  others: Owner[];
}

export function useBoardOwners(): BoardOwners {
  const ownersById = useBoardStore((s) => s.ownersById);
  const usedOwnerIds = useBoardStore((s) => s.usedOwnerIds);
  const tasksById = useBoardStore((s) => s.tasksById);
  return useMemo(() => {
    const order: string[] = [];
    const add = (id: string) => {
      if (!order.includes(id)) order.push(id);
    };
    // Owners on the loaded (open) tasks, newest-changed first, then the
    // server's list (which includes archived tasks' owners).
    const tasks = Object.values(tasksById).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    for (const t of tasks) t.owner_ids.forEach(add);
    usedOwnerIds.forEach(add);
    const live = (id: string) => ownersById[id] && !ownersById[id].archived;
    const shortlist = order.filter(live).map((id) => ownersById[id]);
    const listed = new Set(shortlist.map((o) => o.id));
    const others = Object.values(ownersById)
      .filter((o) => !o.archived && !listed.has(o.id))
      .sort((a, b) => a.position - b.position);
    return { shortlist, others };
  }, [ownersById, usedOwnerIds, tasksById]);
}

/** Case-insensitive match on name or short code. */
export function ownerMatches(owner: Owner, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || owner.name.toLowerCase().includes(q) || owner.code.toLowerCase().includes(q);
}
