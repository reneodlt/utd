/** Totals of task figures: a task's own, a task plus everything under it
 * (parents), or the whole board and its sub-boards. Figures only count
 * while their category is on the task. Done = in a final lane, or
 * archived; binned tasks don't count. */

import { useMemo } from "react";
import { useBoardStore } from "../store/boardStore";
import type { ArchivedValue, Category, Lane, Task } from "../types";
import { filtersActive, passesFilters, type FilterState } from "./filters";
import { contextOf, measureOf, type Measure } from "./measures";

export interface RollupPart {
  category: Category;
  total: number;
  done: number;
  /** How many figures went in (for averages). */
  count: number;
  /** The same for tasks the owner / category filters show (open ones;
   * archived work is done, so it never adds to what's left in view). */
  viewTotal: number;
  viewDone: number;
  viewCount: number;
  /** Done figures as estimated (estimate where one was kept, else the
   * figure): compare with `done`, the actuals. */
  doneEstimate: number;
  /** Filters are on: show the in-view figure first. */
  filtered: boolean;
}

/** Figures that add together: every £ cost, every time estimate, or one
 * number / percentage category on its own. */
export interface RollupGroup extends Omit<RollupPart, "category"> {
  key: string;
  measure: Measure;
  parts: RollupPart[];
}

interface Inputs extends FilterState {
  tasksById: Record<string, Task>;
  childrenByParent: Record<string, string[]>;
  categoriesById: Record<string, Category>;
  lanes: Lane[];
  archivedValues: ArchivedValue[];
}

/** Enough of an archived task for the owner / category filters. */
export function archivedAsTask(v: ArchivedValue): Task {
  return { owner_ids: v.owner_ids ?? [], category_ids: v.category_ids ?? [v.category_id] } as unknown as Task;
}

/** A task's own figures: {category, amount, estimate?} for each valued
 * category on it. */
export function ownFigures(task: Task, categoriesById: Record<string, Category>) {
  return task.category_ids.flatMap((id) => {
    const category = categoriesById[id];
    const amount = task.values?.[id];
    if (!category || category.archived || !category.value_type || amount === undefined) return [];
    const estimate = task.estimates?.[id];
    return [{ category, amount, estimate: estimate ?? null }];
  });
}

function collect(
  taskIds: Iterable<string>,
  archived: ArchivedValue[],
  s: Inputs,
): RollupGroup[] {
  const finalLanes = new Set(s.lanes.filter((l) => l.is_final).map((l) => l.id));
  const filtered = filtersActive(s);
  const empty = { total: 0, done: 0, count: 0, viewTotal: 0, viewDone: 0, viewCount: 0, doneEstimate: 0, filtered };
  const groups = new Map<string, RollupGroup>();
  const add = (category: Category, amount: number, done: boolean, inView: boolean, estimate: number | null) => {
    const measure = measureOf(category);
    if (!measure) return;
    const key = measure.groupKey(category);
    let group = groups.get(key);
    if (!group) {
      group = { key, measure, ...empty, parts: [] };
      groups.set(key, group);
    }
    let part = group.parts.find((p) => p.category.id === category.id);
    if (!part) {
      part = { category, ...empty };
      group.parts.push(part);
    }
    for (const target of [group, part]) {
      target.total += amount;
      target.count += 1;
      if (done) {
        target.done += amount;
        target.doneEstimate += estimate ?? amount;
      }
      if (inView) {
        target.viewTotal += amount;
        target.viewCount += 1;
        if (done) target.viewDone += amount;
      }
    }
  };
  for (const id of taskIds) {
    const task = s.tasksById[id];
    if (!task) continue;
    const inView = !filtered || passesFilters(task, s);
    for (const { category, amount, estimate } of ownFigures(task, s.categoriesById)) {
      add(category, amount, finalLanes.has(task.lane_id), inView, estimate);
    }
  }
  for (const v of archived) {
    const category = s.categoriesById[v.category_id];
    if (category && !category.archived && category.value_type)
      add(category, v.amount, true, !filtered || passesFilters(archivedAsTask(v), s), v.estimate ?? null);
  }
  const list = [...groups.values()];
  const rank = (g: RollupGroup) => Math.min(...g.parts.map((p) => p.category.position));
  for (const g of list) g.parts.sort((a, b) => a.category.position - b.category.position);
  return list.sort((a, b) => rank(a) - rank(b));
}

/** The task and every open task below it. */
function subtree(taskId: string, childrenByParent: Record<string, string[]>): Set<string> {
  const ids = new Set<string>();
  const stack = [taskId];
  while (stack.length) {
    const id = stack.pop()!;
    if (ids.has(id)) continue;
    ids.add(id);
    stack.push(...(childrenByParent[id] ?? []));
  }
  return ids;
}

export interface TaskRollup {
  /** The task plus everything below it. */
  groups: RollupGroup[];
  /** Whether anything below it has figures (so a Σ means more than its own). */
  fromBelow: boolean;
}

export function taskRollup(taskId: string, s: Inputs): TaskRollup {
  const ids = subtree(taskId, s.childrenByParent);
  const archived = s.archivedValues.filter((v) => v.anchor_id !== null && ids.has(v.anchor_id));
  ids.delete(taskId);
  const below = collect(ids, archived, s);
  ids.add(taskId);
  return { groups: below.length ? collect(ids, archived, s) : [], fromBelow: below.length > 0 };
}

export function boardRollup(s: Inputs): RollupGroup[] {
  return collect(Object.keys(s.tasksById), s.archivedValues, s);
}

/** The figures on the cards sitting in one lane (its display lane, so a
 * parent board's lane includes its sub-boards' matching lanes). Archived
 * work doesn't sit in a lane, so it never counts here. */
export function laneRollup(laneId: string, s: Inputs): RollupGroup[] {
  const ids = Object.values(s.tasksById)
    .filter((t) => t.lane_id === laneId)
    .map((t) => t.id);
  return collect(ids, [], s);
}

/** A lane's figure for one category or group: every card in a lane is in
 * the same state (done in a final lane, to go elsewhere), so this is one
 * number — the in-view one first when filtering. */
export function laneFigureParts(
  g: RollupGroup | RollupPart,
  measure: Measure,
  category: Category,
  hoursPerDay: number,
  compact = false,
): FigureParts {
  const ctx = contextOf(category, hoursPerDay);
  const f = (n: number) => measure.format(n, ctx, compact);
  if (measure.rollup === "average") {
    return {
      view: g.filtered ? (g.viewCount ? f(g.viewTotal / g.viewCount) : "–") : null,
      pair: f(groupValue(g, measure)),
    };
  }
  return { view: g.filtered ? f(g.viewTotal) : null, pair: f(g.total) };
}

function useInputs(): Inputs {
  const tasksById = useBoardStore((s) => s.tasksById);
  const childrenByParent = useBoardStore((s) => s.childrenByParent);
  const categoriesById = useBoardStore((s) => s.categoriesById);
  const lanes = useBoardStore((s) => s.lanes);
  const archivedValues = useBoardStore((s) => s.archivedValues);
  const ownerFilter = useBoardStore((s) => s.ownerFilter);
  const ownersById = useBoardStore((s) => s.ownersById);
  const categoryFilter = useBoardStore((s) => s.categoryFilter);
  return useMemo(
    () => ({
      tasksById, childrenByParent, categoriesById, lanes, archivedValues,
      ownerFilter, ownersById, categoryFilter,
    }),
    [tasksById, childrenByParent, categoriesById, lanes, archivedValues, ownerFilter, ownersById, categoryFilter],
  );
}

export function useTaskRollup(taskId: string): TaskRollup {
  const inputs = useInputs();
  return useMemo(() => taskRollup(taskId, inputs), [taskId, inputs]);
}

export function useLaneRollup(laneId: string): RollupGroup[] {
  const inputs = useInputs();
  return useMemo(() => laneRollup(laneId, inputs), [laneId, inputs]);
}

export function useBoardRollup(): RollupGroup[] {
  const inputs = useInputs();
  return useMemo(() => boardRollup(inputs), [inputs]);
}

export function useHoursPerDay(): number {
  return useBoardStore((s) => s.board?.hours_per_day ?? 7.5);
}

/** A group's headline figure: the sum, or the average for percentages. */
export function groupValue(g: RollupGroup | RollupPart, measure: Measure): number {
  return measure.rollup === "average" ? (g.count ? g.total / g.count : 0) : g.total;
}

/** The pieces of a Σ figure. `view`: what's still to go among the tasks
 * the filters show (only when filtering). `pair`: still to go over the
 * total, everything not binned, finished and archived included. Averages
 * (percentages) show the in-view average, then the overall one. */
export interface FigureParts {
  view: string | null;
  pair: string;
}

export function figureParts(
  g: RollupGroup | RollupPart,
  measure: Measure,
  category: Category,
  hoursPerDay: number,
  compact = false,
): FigureParts {
  const ctx = contextOf(category, hoursPerDay);
  const f = (n: number) => measure.format(n, ctx, compact);
  if (measure.rollup === "average") {
    return {
      view: g.filtered ? (g.viewCount ? f(g.viewTotal / g.viewCount) : "–") : null,
      pair: f(groupValue(g, measure)),
    };
  }
  return {
    view: g.filtered ? f(g.viewTotal - g.viewDone) : null,
    pair: `${f(g.total - g.done)}/${f(g.total)}`,
  };
}

const joinParts = (p: FigureParts) => (p.view === null ? p.pair : `${p.view} · ${p.pair}`);

export function formatGroup(g: RollupGroup, hoursPerDay: number, compact = false): string {
  return joinParts(figureParts(g, g.measure, g.parts[0].category, hoursPerDay, compact));
}

export function formatPart(p: RollupPart, measure: Measure, hoursPerDay: number, compact = false): string {
  return joinParts(figureParts(p, measure, p.category, hoursPerDay, compact));
}

/** "£130 done", "£130 done (est £120)", or "" for averages / when
 * nothing's done yet. */
export function splitText(g: RollupGroup | RollupPart, measure: Measure, category: Category, hoursPerDay: number): string {
  if (measure.rollup !== "sum" || g.done === 0) return "";
  const ctx = contextOf(category, hoursPerDay);
  const est = Math.abs(g.doneEstimate - g.done) > 1e-9 ? ` (est ${measure.format(g.doneEstimate, ctx)})` : "";
  return `${measure.format(g.done, ctx)} done${est}`;
}

/** What the numbers mean, for tooltips and headings. */
export function figureLegend(filtered: boolean, average = false): string {
  if (average) return filtered ? "average in view · overall average" : "average";
  return filtered ? "to go in view · to go/total overall" : "to go/total";
}

/** One line per category, for tooltips. */
export function breakdownText(groups: RollupGroup[], hoursPerDay: number): string {
  return groups
    .flatMap((g) =>
      g.parts.map((p) => {
        const split = splitText(p, g.measure, p.category, hoursPerDay);
        return `${p.category.name}: ${formatPart(p, g.measure, hoursPerDay)} (${figureLegend(
          p.filtered,
          g.measure.rollup === "average",
        )}${split ? `; ${split}` : ""})`;
      }),
    )
    .join("\n");
}
