import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ApiError, setTaskValues } from "../api/client";
import { newOpId } from "../lib/compat";
import { keepToControl } from "../lib/controls";
import { filtersActive, passesFilters } from "../lib/filters";
import { contextOf, formatValue, measureOf } from "../lib/measures";
import {
  breakdownText,
  figureLegend,
  figureParts,
  formatGroup,
  formatPart,
  archivedAsTask,
  laneFigureParts,
  ownFigures,
  splitText,
  useBoardRollup,
  useHoursPerDay,
  useLaneRollup,
  useTaskRollup,
  type FigureParts,
  type RollupGroup,
} from "../lib/rollup";
import { quote } from "../lib/undo";
import { useBoardStore } from "../store/boardStore";
import type { Category, Task } from "../types";
import FloatingPanel from "./FloatingPanel";
import { LocationInput } from "./LocationInput";

/** Σ chips for a parent card, one per category in its colour: what's
 * still to go over the total, for it and everything below it. Nothing
 * when no subtask has figures (its own show on its category chips). */
const MAX_ROLLUP_CHIPS = 3;

/** A Σ figure: when filtering, what's left in view (emphasised) first,
 * then to go/total overall. */
function Fig({ parts }: { parts: FigureParts }) {
  if (parts.view === null) return <>{parts.pair}</>;
  return (
    <>
      <strong className="fig-view">{parts.view}</strong>
      <span className="fig-rest"> · {parts.pair}</span>
    </>
  );
}

export function RollupBadges({ taskId }: { taskId: string }) {
  const { groups, fromBelow } = useTaskRollup(taskId);
  const hoursPerDay = useHoursPerDay();
  if (!fromBelow) return null;
  const title = `Including subtasks:\n${breakdownText(groups, hoursPerDay)}`;
  const parts = groups
    .flatMap((g) => g.parts.map((p) => ({ g, p })))
    .sort((a, b) => a.p.category.position - b.p.category.position);
  const extra = parts.length - MAX_ROLLUP_CHIPS;
  return (
    <>
      {parts.slice(0, MAX_ROLLUP_CHIPS).map(({ g, p }) => (
        <span
          key={p.category.id}
          className="category-chip rollup-chip"
          style={{ "--cat": p.category.color } as CSSProperties}
          title={title}
          aria-label={`${p.category.name}, including subtasks: ${formatPart(p, g.measure, hoursPerDay)} (${figureLegend(
            p.filtered,
            g.measure.rollup === "average",
          )})`}
        >
          Σ <Fig parts={figureParts(p, g.measure, p.category, hoursPerDay, true)} />
          {g.measure.rollup === "average" && <span className="rollup-avg"> avg</span>}
        </span>
      ))}
      {extra > 0 && (
        <span className="badge badge-rollup" title={title}>
          +{extra}
        </span>
      )}
    </>
  );
}

const MAX_LANE_CHIPS = 4;

/** What a lane's cards add up to, per category, in the category's colour:
 * what's to go in an ordinary lane, what's done in a final one. With
 * filters on, the in-view figure leads. `compact` is the one-line form
 * for the phone's lane tab. Nothing when no card in the lane has a figure. */
export function LaneTotals({ laneId, isFinal, compact = false }: { laneId: string; isFinal: boolean; compact?: boolean }) {
  const groups = useLaneRollup(laneId);
  const hoursPerDay = useHoursPerDay();
  if (!groups.length) return null;
  const state = isFinal ? "done" : "to go";
  const filtered = groups[0].filtered;
  const legend = filtered ? `${state} in view · ${state} in the lane` : state;
  const lines = groups.flatMap((g) =>
    g.parts.map((p) => {
      const parts = laneFigureParts(p, g.measure, p.category, hoursPerDay);
      const est =
        isFinal && g.measure.rollup === "sum" && Math.abs(p.doneEstimate - p.done) > 1e-9
          ? ` (est ${g.measure.format(p.doneEstimate, contextOf(p.category, hoursPerDay))})`
          : "";
      return `${p.category.name}: ${parts.view === null ? parts.pair : `${parts.view} · ${parts.pair}`}${
        g.measure.rollup === "average" ? " average" : ""
      }${est}`;
    }),
  );
  const title = `In this lane (${legend}):\n${lines.join("\n")}`;
  if (compact) {
    // One line, per group: "£1.2k · 3h"
    return (
      <span className="lane-tab-total" title={title}>
        {groups
          .map((g) => {
            const parts = laneFigureParts(g, g.measure, g.parts[0].category, hoursPerDay, true);
            return parts.view === null ? parts.pair : `${parts.view} · ${parts.pair}`;
          })
          .join(" · ")}
      </span>
    );
  }
  const chips = groups.flatMap((g) => g.parts.map((p) => ({ g, p }))).sort((a, b) => a.p.category.position - b.p.category.position);
  const extra = chips.length - MAX_LANE_CHIPS;
  return (
    <div className="lane-totals" aria-label={`Lane totals, ${legend}`} title={title}>
      {chips.slice(0, MAX_LANE_CHIPS).map(({ g, p }) => (
        <span key={p.category.id} className="category-chip rollup-chip" style={{ "--cat": p.category.color } as CSSProperties}>
          Σ <Fig parts={laneFigureParts(p, g.measure, p.category, hoursPerDay, true)} />
          {g.measure.rollup === "average" && <span className="rollup-avg"> avg</span>}
        </span>
      ))}
      {extra > 0 && <span className="badge badge-rollup">+{extra}</span>}
    </div>
  );
}

/** Does this card have a Σ to show? (For laying out the badge row.) */
export function useHasRollup(taskId: string): boolean {
  return useTaskRollup(taskId).fromBelow;
}

/** Save one figure (or clear it), optimistically, with undo. */
async function saveFigure(task: Task, category: Category, next: number | null): Promise<string | null> {
  const store = useBoardStore.getState();
  const before = store.tasksById[task.id]?.values?.[category.id] ?? null;
  if (before === next) return null;
  const withValue = (value: number | null): Task => {
    const current = useBoardStore.getState().tasksById[task.id] ?? task;
    const values = { ...current.values };
    if (value === null) delete values[category.id];
    else values[category.id] = value;
    return { ...current, values };
  };
  const opId = newOpId();
  store.registerOp(opId);
  store.upsertTask(withValue(next));
  try {
    const updated = await setTaskValues(task.id, { [category.id]: next }, { op_id: opId, actor: "board-user" });
    useBoardStore.getState().upsertTask(updated);
    const hoursPerDay = useBoardStore.getState().board?.hours_per_day ?? 7.5;
    const shown = (v: number | null) => (v === null ? "nothing" : formatValue(category, v, hoursPerDay));
    useBoardStore.getState().offerUndo(`${category.name}: ${shown(next)} on ${quote(task.title)}`, async () => {
      const restored = await setTaskValues(task.id, { [category.id]: before }, { actor: "board-user" });
      useBoardStore.getState().upsertTask(restored);
    });
    return null;
  } catch (e) {
    const state = useBoardStore.getState();
    state.resolveOp(opId);
    state.upsertTask(withValue(before));
    return (e instanceof ApiError && e.detail) || "Couldn’t save that.";
  }
}

function FigureInput({ task, category }: { task: Task; category: Category }) {
  const hoursPerDay = useHoursPerDay();
  const value = task.values?.[category.id];
  const measure = measureOf(category)!;
  const ctx = contextOf(category, hoursPerDay);
  const shown = value === undefined ? "" : measure.format(value, ctx);
  const estimate = task.estimates?.[category.id];
  const done = useBoardStore((s) => !!task.archived_at || !!s.lanes.find((l) => l.id === task.lane_id)?.is_final);
  const [text, setText] = useState(shown);
  const [error, setError] = useState<string | null>(null);
  const editing = useRef(false);

  // Follow changes from elsewhere unless we're mid-edit.
  useEffect(() => {
    if (!editing.current) setText(shown);
  }, [shown]);

  async function commit() {
    editing.current = false;
    const t = text.trim();
    const next = t === "" ? null : measure.parse(t, ctx);
    if (t !== "" && next === null) {
      setError(
        `That doesn’t read as ${measure.label === "Time" ? "a time, e.g. 2h or 1d 4h" : `a ${measure.label.toLowerCase()} figure`}.`,
      );
      return;
    }
    setError(null);
    const failed = await saveFigure(task, category, next);
    if (failed) setError(failed);
    else setText(next === null ? "" : measure.format(next, ctx));
  }

  const id = `figure-${category.id}`;
  return (
    <div className="figure-row">
      <label htmlFor={id} className="figure-label">
        <span className="subtask-dot" style={{ background: category.color } as CSSProperties} />
        {category.name}
      </label>
      <input
        id={id}
        className={`figure-input${error ? " is-invalid" : ""}`}
        value={text}
        inputMode={category.value_type === "duration" ? "text" : "decimal"}
        placeholder={measure.placeholder(ctx)}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-error` : undefined}
        onFocus={() => (editing.current = true)}
        onChange={(e) => {
          setText(e.target.value);
          setError(null);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            // First Escape drops an unsaved edit; with nothing to drop it
            // closes the drawer as usual.
            if (text === shown && !error) return;
            e.stopPropagation();
            editing.current = false;
            setText(shown);
            setError(null);
            return;
          }
          e.stopPropagation();
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
      {error && (
        <p id={`${id}-error`} className="attach-error figure-error" role="alert">
          {error}
        </p>
      )}
      {!error && estimate !== undefined && value !== undefined && (
        <p className="figure-note">
          Actual · estimated {measure.format(estimate, ctx)} ({value >= estimate ? "+" : "−"}
          {measure.format(Math.abs(value - estimate), ctx)})
        </p>
      )}
      {!error && estimate === undefined && done && value !== undefined && (
        <p className="figure-note">Done: changing it now keeps {shown} as the estimate.</p>
      )}
    </div>
  );
}

/** The drawer: an input per category on the task that takes a figure. */
export function TaskFigures({ task }: { task: Task }) {
  const categoriesById = useBoardStore((s) => s.categoriesById);
  const valued = task.category_ids
    .map((id) => categoriesById[id])
    .filter((c): c is Category => !!c && !c.archived && !!c.value_type)
    .sort((a, b) => a.position - b.position);
  if (!valued.length) return null;
  return (
    <section className="task-figures" aria-label="Figures">
      {valued.map((c) =>
        c.value_type === "location" ? (
          <LocationInput key={c.id} task={task} category={c} />
        ) : (
          <FigureInput key={c.id} task={task} category={c} />
        ),
      )}
    </section>
  );
}

function Breakdown({ groups }: { groups: RollupGroup[] }) {
  const hoursPerDay = useHoursPerDay();
  return (
    <div className="rollup-scroll">
      <table className="rollup-table">
        <thead>
          <tr>
            <th scope="col">
              <span className="visually-hidden">Category</span>
            </th>
            <th scope="col" className="rollup-figure">
              {figureLegend(groups[0]?.filtered ?? false)}
            </th>
            <th scope="col" className="rollup-split">
              <span className="visually-hidden">Done</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <GroupRows key={g.key} group={g} hoursPerDay={hoursPerDay} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function GroupRows({ group: g, hoursPerDay }: { group: RollupGroup; hoursPerDay: number }) {
  const avg = g.measure.rollup === "average";
  const rows = g.parts.map((p) => (
    <tr key={p.category.id}>
      <th scope="row">
        <span className="subtask-dot" style={{ background: p.category.color } as CSSProperties} />
        {p.category.name}
      </th>
      <td className="rollup-figure">
        <Fig parts={figureParts(p, g.measure, p.category, hoursPerDay)} />
        {avg && <span className="rollup-avg"> avg</span>}
      </td>
      <td className="rollup-split">{splitText(p, g.measure, p.category, hoursPerDay)}</td>
    </tr>
  ));
  if (g.parts.length < 2) return <>{rows}</>;
  return (
    <>
      {rows}
      <tr className="rollup-total">
        <th scope="row">Total</th>
        <td className="rollup-figure">
          <Fig parts={figureParts(g, g.measure, g.parts[0].category, hoursPerDay)} />
        </td>
        <td className="rollup-split">{splitText(g, g.measure, g.parts[0].category, hoursPerDay)}</td>
      </tr>
    </>
  );
}

/** The drawer: totals for this task and everything under it. */
export function RollupSummary({ taskId }: { taskId: string }) {
  const { groups, fromBelow } = useTaskRollup(taskId);
  if (!fromBelow) return null;
  return (
    <section className="rollup-summary" aria-labelledby="rollup-title">
      <h3 id="rollup-title">Totals, including subtasks</h3>
      <Breakdown groups={groups} />
    </section>
  );
}

const SECTION_ROWS = 10;

interface Contributor {
  id: string;
  title: string;
  done: boolean;
  archived: boolean;
  inView: boolean;
  figures: { category: Category; amount: number; estimate: number | null }[];
  /** Board order: lane, then position; archived ones after. */
  rank: [number, number];
}

/** Every task with figures on the board family, still-to-do and completed
 * (final lane or archived), with a subtotal for each. */
function Contributors({ groups, onOpen }: { groups: RollupGroup[]; onOpen?: () => void }) {
  const tasksById = useBoardStore((s) => s.tasksById);
  const taskIdsByLane = useBoardStore((s) => s.taskIdsByLane);
  const lanes = useBoardStore((s) => s.lanes);
  const categoriesById = useBoardStore((s) => s.categoriesById);
  const archivedValues = useBoardStore((s) => s.archivedValues);
  const ownerFilter = useBoardStore((s) => s.ownerFilter);
  const ownersById = useBoardStore((s) => s.ownersById);
  const categoryFilter = useBoardStore((s) => s.categoryFilter);
  const openDetail = useBoardStore((s) => s.openDetail);
  const hoursPerDay = useHoursPerDay();

  const list = useMemo(() => {
    const f = { ownerFilter, ownersById, categoryFilter, categoriesById };
    const filtered = filtersActive(f);
    const out: Contributor[] = [];
    for (const task of Object.values(tasksById)) {
      const figures = ownFigures(task, categoriesById);
      if (!figures.length) continue;
      const lane = lanes.find((l) => l.id === task.lane_id);
      out.push({
        id: task.id,
        title: task.title,
        done: !!lane?.is_final,
        archived: false,
        inView: !filtered || passesFilters(task, f),
        figures,
        rank: [lane?.order ?? 0, (taskIdsByLane[task.lane_id] ?? []).indexOf(task.id)],
      });
    }
    const archived = new Map<string, Contributor>();
    for (const v of archivedValues) {
      const category = categoriesById[v.category_id];
      if (!category || category.archived || !category.value_type) continue;
      let c = archived.get(v.task_id);
      if (!c) {
        c = {
          id: v.task_id,
          title: v.title,
          done: true,
          archived: true,
          inView: !filtered || passesFilters(archivedAsTask(v), f),
          figures: [],
          rank: [1e6, 0],
        };
        archived.set(v.task_id, c);
      }
      c.figures.push({ category, amount: v.amount, estimate: v.estimate ?? null });
    }
    out.push(...[...archived.values()].sort((a, b) => a.title.localeCompare(b.title)));
    out.sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1]);
    for (const c of out) c.figures.sort((a, b) => a.category.position - b.category.position);
    return out;
  }, [tasksById, taskIdsByLane, lanes, categoriesById, archivedValues, ownerFilter, ownersById, categoryFilter]);

  const [expanded, setExpanded] = useState<Record<string, true>>({});
  // One column per category with figures, in priority order, shared by
  // every section so the figures line up.
  const columns = useMemo(() => {
    const seen = new Map<string, Category>();
    for (const c of list) for (const f of c.figures) seen.set(f.category.id, f.category);
    return [...seen.values()].sort((a, b) => a.position - b.position);
  }, [list]);
  if (!list.length) return null;

  const fmt = (category: Category, value: number) => formatValue(category, value, hoursPerDay);
  const isAverage = (c: Category) => measureOf(c)?.rollup === "average";
  const filtered = groups[0]?.filtered ?? false;
  // Several categories that add together (e.g. two £ ones): their sum.
  const combined = groups.filter((g) => g.parts.length > 1 && g.measure.rollup === "sum");

  // Filtering: what the filters show (with its own total), a break, then
  // what they hide. Otherwise just still-to-do and completed.
  type Block =
    | { kind: "band"; key: string; label: string; count: number }
    | { kind: "section"; key: string; title: string; items: Contributor[]; done: boolean }
    | { kind: "total"; key: string; label: string; items: Contributor[]; className: string };
  const split = (key: string, items: Contributor[]): Block[] =>
    [
      { kind: "section" as const, key: `${key}-todo`, title: "Still to do", items: items.filter((c) => !c.done), done: false },
      { kind: "section" as const, key: `${key}-done`, title: "Completed", items: items.filter((c) => c.done), done: true },
    ].filter((b) => b.items.length > 0);
  const inView = list.filter((c) => c.inView);
  const outOfView = list.filter((c) => !c.inView);
  const blocks: Block[] = filtered
    ? [
        { kind: "band", key: "in", label: "In view", count: inView.length },
        ...split("in", inView),
        { kind: "total", key: "in-total", label: "In view total", items: inView, className: "contrib-inview-total" },
        ...(outOfView.length
          ? [
              { kind: "band" as const, key: "out", label: "Filtered out", count: outOfView.length },
              ...split("out", outOfView),
            ]
          : []),
      ]
    : split("all", list);

  const totalCells = (items: Contributor[]) =>
    columns.map((col) => {
      const total = columnTotal(items, col);
      return (
        <td key={col.id} className="contrib-value">
          {total === null ? "" : `${fmt(col, total)}${isAverage(col) ? " avg" : ""}`}
        </td>
      );
    });

  const renderSection = (section: Extract<Block, { kind: "section" }>) => {
    const rows = expanded[section.key] ? section.items : section.items.slice(0, SECTION_ROWS);
    return (
      <tbody key={section.key} className={section.done ? "contrib-done" : "contrib-todo"}>
        <tr className="contrib-head">
          <th scope="rowgroup" colSpan={columns.length + 1}>
            {section.title} <span className="history-count">{section.items.length}</span>
          </th>
        </tr>
        {rows.map((c) => {
          const byCategory = new Map(c.figures.map((f) => [f.category.id, f]));
          return (
            <tr key={c.id} className={filtered && !c.inView ? "is-out-of-view" : undefined}>
              <th scope="row">
                <button
                  type="button"
                  className="contrib-title"
                  title={c.inView ? `Open “${c.title}”` : `Open “${c.title}” (hidden by the filters)`}
                  onClick={() => {
                    onOpen?.();
                    openDetail(c.id);
                  }}
                >
                  {c.title}
                  {c.archived && <span className="contrib-tag">archived</span>}
                </button>
              </th>
              {columns.map((col) => {
                const f = byCategory.get(col.id);
                return (
                  <td key={col.id} className="contrib-value">
                    {f && fmt(col, f.amount)}
                    {f && f.estimate !== null && <span className="contrib-est">est {fmt(col, f.estimate)}</span>}
                  </td>
                );
              })}
            </tr>
          );
        })}
        {section.items.length > SECTION_ROWS && !expanded[section.key] && (
          <tr className="contrib-more-row">
            <td colSpan={columns.length + 1}>
              <button
                type="button"
                className="link-button contrib-more"
                onClick={() => setExpanded((e) => ({ ...e, [section.key]: true }))}
              >
                Show all {section.items.length}
              </button>
            </td>
          </tr>
        )}
        <tr className="contrib-subtotal">
          <th scope="row">{section.done ? "Done" : "To go"}</th>
          {columns.map((col) => {
            const total = columnTotal(section.items, col);
            const est = section.done ? columnTotal(section.items, col, true) : null;
            return (
              <td key={col.id} className="contrib-value">
                {total === null ? "" : `${fmt(col, total)}${isAverage(col) ? " avg" : ""}`}
                {est !== null && total !== null && Math.abs(est - total) > 1e-9 && (
                  <span className="contrib-est">est {fmt(col, est)}</span>
                )}
              </td>
            );
          })}
        </tr>
      </tbody>
    );
  };

  return (
    <div className="rollup-scroll">
      <table className="contrib-table">
        <thead>
          <tr>
            <th scope="col">
              <span className="visually-hidden">Task</span>
            </th>
            {columns.map((c) => (
              <th key={c.id} scope="col" className="contrib-col">
                <span className="subtask-dot" style={{ background: c.color } as CSSProperties} />
                {c.name}
              </th>
            ))}
          </tr>
        </thead>
        {blocks.map((block) => {
          if (block.kind === "section") return renderSection(block);
          if (block.kind === "band")
            return (
              <tbody key={block.key} className={`contrib-band contrib-band-${block.key}`}>
                <tr>
                  <th scope="rowgroup" colSpan={columns.length + 1}>
                    {block.label} <span className="history-count">{block.count}</span>
                  </th>
                </tr>
              </tbody>
            );
          return (
            <tbody key={block.key}>
              <tr className={block.className}>
                <th scope="row">{block.label}</th>
                {totalCells(block.items)}
              </tr>
            </tbody>
          );
        })}
        <tfoot>
          <tr className="contrib-total">
            <th scope="row">{filtered ? "Total, all tasks" : "Total"}</th>
            {totalCells(list)}
          </tr>
          {combined.map((g) => {
            const first = g.parts[0].category;
            const ctx = (v: number) => formatValue(first, v, hoursPerDay);
            const label = g.key.startsWith("money:") ? `All ${g.key.slice(6)}` : `All ${g.measure.label.toLowerCase()}`;
            return (
              <tr key={g.key} className="contrib-combined">
                <th scope="row">{label}</th>
                <td colSpan={columns.length}>
                  {filtered && <strong>{ctx(g.viewTotal - g.viewDone)} to go in view · </strong>}
                  {ctx(g.total - g.done)} to go · {ctx(g.done)} done · <strong>{ctx(g.total)} total</strong>
                  {Math.abs(g.doneEstimate - g.done) > 1e-9 && <> (done est {ctx(g.doneEstimate)})</>}
                </td>
              </tr>
            );
          })}
        </tfoot>
      </table>
    </div>
  );
}

/** Tasks' total for one category column (average for percentages), as
 * estimated when `estimated` (estimate where one was kept), or null when
 * none of them has that figure. */
function columnTotal(items: Contributor[], category: Category, estimated = false): number | null {
  let sum = 0;
  let count = 0;
  for (const c of items)
    for (const f of c.figures)
      if (f.category.id === category.id) {
        sum += estimated ? (f.estimate ?? f.amount) : f.amount;
        count += 1;
      }
  if (!count) return null;
  return measureOf(category)?.rollup === "average" ? sum / count : sum;
}

/** Header: the board's totals (with its sub-boards and archived work);
 * click for the breakdown. */
export function BoardTotal({ variant = "header", onOpen }: { variant?: "header" | "sheet"; onOpen?: () => void }) {
  const groups = useBoardRollup();
  const hoursPerDay = useHoursPerDay();
  const boardName = useBoardStore((s) => s.board?.name ?? "Board");
  const hasFamily = useBoardStore((s) => Object.keys(s.familyById).length > 0);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  if (!groups.length) return null;
  const filtered = groups[0].filtered;
  const summary = groups.slice(0, 2).map((g) => (
    <span key={g.key} className="total-group">
      <Fig parts={figureParts(g, g.measure, g.parts[0].category, hoursPerDay, true)} />
      {g.measure.rollup === "average" && " avg"}
    </span>
  ));
  const note =
    `${hasFamily ? "This board and its sub-boards" : "Everything on this board"}, archived work included. ` +
    "Done means in a final lane or archived." +
    (filtered ? " Filters are on: the tasks they show come first, with their own total, then the rest." : "");
  if (variant === "sheet") {
    return (
      <div className="board-total-sheet">
        <Contributors groups={groups} onOpen={onOpen} />
        <p className="attachments-empty">{note}</p>
      </div>
    );
  }
  return (
    <>
      <button
        type="button"
        className="flow-chip board-total"
        title={`${boardName} totals:\n${breakdownText(groups, hoursPerDay)}`}
        aria-label={`${boardName} totals: ${groups.map((g) => formatGroup(g, hoursPerDay)).join("; ")}`}
        onClick={(e) => setAnchor(e.currentTarget.getBoundingClientRect())}
        {...keepToControl}
      >
        Σ {summary}
      </button>
      {anchor && (
        <FloatingPanel
          anchor={anchor}
          onClose={() => setAnchor(null)}
          label={`${boardName} totals`}
          className="board-total-popover"
        >
          <div className="board-total-panel">
            <h3>{boardName} totals</h3>
            <Contributors groups={groups} onOpen={() => setAnchor(null)} />
            <p className="attachments-empty">{note}</p>
          </div>
        </FloatingPanel>
      )}
    </>
  );
}

/** A task's own figure for a category, for its chip ("Labour · £200"). */
export function useChipFigures(task: Task): Record<string, string> {
  const categoriesById = useBoardStore((s) => s.categoriesById);
  const hoursPerDay = useHoursPerDay();
  const places = Object.entries(task.locations ?? {}).flatMap(([id, p]) =>
    task.category_ids.includes(id) && categoriesById[id] && !categoriesById[id].archived
      ? [[id, `📍 ${p.label ? p.label.split(",")[0] : "pinned"}`] as const]
      : [],
  );
  return Object.fromEntries([
    ...places,
    ...ownFigures(task, categoriesById).map(({ category, amount, estimate }) => [
      category.id,
      formatValue(category, amount, hoursPerDay, true) +
        (estimate === null ? "" : ` (est ${formatValue(category, estimate, hoursPerDay, true)})`),
    ]),
  ]);
}
