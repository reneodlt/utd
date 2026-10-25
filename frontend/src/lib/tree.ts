/** The board tree: boards nest via parent_id. */

import type { BoardSummary } from "../types";

export interface TreeRow {
  board: BoardSummary;
  depth: number;
}

/** Boards in tree order (parents before children, siblings in list
 * order), each with its depth. Boards whose parent isn't in the list
 * (archived, say) are treated as top level. */
export function treeRows(boards: BoardSummary[]): TreeRow[] {
  const ids = new Set(boards.map((b) => b.id));
  const kids = new Map<string | null, BoardSummary[]>();
  for (const b of boards) {
    const parent = b.parent_id && ids.has(b.parent_id) ? b.parent_id : null;
    kids.set(parent, [...(kids.get(parent) ?? []), b]);
  }
  const rows: TreeRow[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number) => {
    for (const b of kids.get(parent) ?? []) {
      if (seen.has(b.id)) continue; // cycle-safe
      seen.add(b.id);
      rows.push({ board: b, depth });
      walk(b.id, depth + 1);
    }
  };
  walk(null, 0);
  return rows;
}

/** Is `id` the board itself or somewhere below `ancestorId`? */
export function isWithin(id: string, ancestorId: string, boards: BoardSummary[]): boolean {
  const byId = new Map(boards.map((b) => [b.id, b]));
  const seen = new Set<string>();
  let cur: string | null | undefined = id;
  while (cur && !seen.has(cur)) {
    if (cur === ancestorId) return true;
    seen.add(cur);
    cur = byId.get(cur)?.parent_id;
  }
  return false;
}
