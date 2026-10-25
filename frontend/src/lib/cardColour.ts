/** What colours a card: time in lane (default), owner, deadline, category,
 * or nothing. Per device, remembered per board. */

import type { Category, Owner, Task } from "../types";
import { secondsSince } from "./time";

export type ColourBy = "age" | "owner" | "deadline" | "category" | "none";

export const COLOUR_OPTIONS: { value: ColourBy; label: string }[] = [
  { value: "age", label: "Time in lane" },
  { value: "owner", label: "Owner" },
  { value: "deadline", label: "Deadline" },
  { value: "category", label: "Category" },
  { value: "none", label: "No colour" },
];

const key = (boardId: string) => `utd.colourBy.${boardId}`;

export function loadColourBy(boardId: string): ColourBy {
  try {
    const v = localStorage.getItem(key(boardId));
    return COLOUR_OPTIONS.some((o) => o.value === v) ? (v as ColourBy) : "age";
  } catch {
    return "age";
  }
}

export function saveColourBy(boardId: string, value: ColourBy) {
  try {
    if (value === "age") localStorage.removeItem(key(boardId));
    else localStorage.setItem(key(boardId), value);
  } catch {
    // non-persistent is fine
  }
}

// ---------- deadlines ----------

export type DueState = "overdue" | "today" | "soon" | "later";

/** Today as YYYY-MM-DD in local time (deadlines are days, not moments). */
export function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function daysUntil(due: string): number {
  const [y, m, d] = due.split("-").map(Number);
  const [ty, tm, td] = today().split("-").map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(ty, tm - 1, td)) / 86_400_000);
}

export function dueState(dueDate: string | null): DueState | null {
  if (!dueDate) return null;
  const days = daysUntil(dueDate);
  return days < 0 ? "overdue" : days === 0 ? "today" : days <= 3 ? "soon" : "later";
}

/** "Overdue 2d", "Due today", "Due tomorrow", "Due Fri 3 Oct". */
export function dueLabel(dueDate: string): string {
  const days = daysUntil(dueDate);
  if (days < 0) return `Overdue ${-days}d`;
  if (days === 0) return "Due today";
  if (days === 1) return "Due tomorrow";
  const [y, m, d] = dueDate.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return `Due ${date.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}`;
}

// ---------- the card's accent ----------

export interface Accent {
  /** Extra class on .card (the time-in-lane look keeps its own classes). */
  className: string;
  /** Left edge + tint colour, when the mode sets one. */
  colour?: string;
  /** Tooltip saying why. */
  why?: string;
}

const DUE_COLOURS: Record<Exclude<DueState, "later">, string> = {
  overdue: "var(--danger)",
  today: "var(--warn)",
  soon: "#eab308",
};

export function cardAccent(
  task: Task,
  mode: ColourBy,
  ctx: {
    inFinalLane: boolean;
    ownersById: Record<string, Owner>;
    categoriesById: Record<string, Category>;
    agingHours?: { stale_hours?: number; old_hours?: number };
  },
): Accent {
  switch (mode) {
    case "age": {
      if (ctx.inFinalLane) return { className: "" };
      const hours = secondsSince(task.lane_entered_at) / 3600;
      if (hours >= (ctx.agingHours?.old_hours ?? 168)) return { className: " card-old" };
      if (hours >= (ctx.agingHours?.stale_hours ?? 72)) return { className: " card-stale" };
      return { className: "" };
    }
    case "owner": {
      const owner = task.owner_ids.map((id) => ctx.ownersById[id]).find((o) => o && !o.archived);
      return owner ? { className: " has-accent", colour: owner.bg, why: `Owner: ${owner.name}` } : { className: "" };
    }
    case "category": {
      // Highest priority = lowest position in the master category list.
      const top = task.category_ids
        .map((id) => ctx.categoriesById[id])
        .filter((c): c is Category => !!c && !c.archived)
        .sort((a, b) => a.position - b.position)[0];
      return top ? { className: " has-accent", colour: top.color, why: `Category: ${top.name}` } : { className: "" };
    }
    case "deadline": {
      const state = ctx.inFinalLane ? null : dueState(task.due_date);
      if (!state || state === "later") return { className: "" };
      return { className: ` has-accent due-${state}`, colour: DUE_COLOURS[state], why: dueLabel(task.due_date!) };
    }
    default:
      return { className: "" };
  }
}
