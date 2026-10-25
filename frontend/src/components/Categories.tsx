import { useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent } from "react";
import {
  ApiError,
  archiveCategory,
  createCategory,
  reorderCategories,
  setHoursPerDay,
  setTaskCategories,
  updateCategory,
} from "../api/client";
import { newOpId } from "../lib/compat";
import { UNCATEGORISED } from "../lib/filters";
import { useBoardStore } from "../store/boardStore";
import { CURRENCIES, TYPE_INFO, VALUE_TYPES } from "../lib/measures";
import type { Category, Task, ValueConfig, ValueType } from "../types";
import FloatingPanel from "./FloatingPanel";
import { useChipFigures } from "./Figures";
import { keepToControl } from "../lib/controls";

export const CATEGORY_COLOURS = [
  "#6366f1", "#0ea5e9", "#14b8a6", "#22c55e", "#eab308",
  "#f97316", "#ef4444", "#ec4899", "#a855f7", "#64748b",
];

const NO_CATEGORIES: Category[] = [];

/** Categories this board can use, in their shared order. */
export function useActiveCategories(): Category[] {
  const categoriesById = useBoardStore((s) => s.categoriesById);
  return useMemo(() => {
    const list = Object.values(categoriesById).filter((c) => !c.archived);
    return list.length ? list.sort((a, b) => a.position - b.position) : NO_CATEGORIES;
  }, [categoriesById]);
}

export function categoriesOf(task: Task, categoriesById: Record<string, Category>): Category[] {
  return task.category_ids.flatMap((id) => {
    const c = categoriesById[id];
    return c && !c.archived ? [c] : [];
  });
}

export function CategoryChip({
  category,
  figure,
}: {
  category: Pick<Category, "name" | "color" | "board_id">;
  /** The task's figure for it, shown after the name ("Labour · £200"). */
  figure?: string;
}) {
  const name = category.board_id === null ? `${category.name} (all boards)` : category.name;
  return (
    <span
      className="category-chip"
      style={{ "--cat": category.color } as CSSProperties}
      title={figure ? `${name}: ${figure}` : name}
    >
      {category.name}
      {figure && <span className="chip-figure">{figure}</span>}
    </span>
  );
}

/** Save a task's full category list, optimistically. */
async function saveCategories(taskId: string, next: string[]): Promise<string | null> {
  const store = useBoardStore.getState();
  const before = store.tasksById[taskId]?.category_ids ?? [];
  const opId = newOpId();
  store.registerOp(opId);
  store.upsertTask({ ...store.tasksById[taskId], category_ids: next });
  try {
    const updated = await setTaskCategories(taskId, next, { op_id: opId, actor: "board-user" });
    useBoardStore.getState().upsertTask(updated);
    return null;
  } catch (e) {
    const state = useBoardStore.getState();
    state.resolveOp(opId);
    state.upsertTask({ ...state.tasksById[taskId], category_ids: before });
    return (e instanceof ApiError && e.detail) || "Couldn’t save that.";
  }
}

/** Tick categories on and off; type to search, or to create a new one. */
function CategoryPicker({ task, anchor, onClose }: { task: Task; anchor: DOMRect; onClose: () => void }) {
  const all = useActiveCategories();
  // A task can use shared categories and its own board's (which, for a
  // descendant board's task, isn't the board being viewed).
  const categories = all.filter((c) => c.board_id === null || c.board_id === task.board_id);
  const boardId = task.board_id;
  const taskBoardName = useBoardStore((s) =>
    task.board_id === s.board?.id ? "this board" : s.familyById[task.board_id]?.name ?? "its board",
  );
  const setSettingsOpen = useBoardStore((s) => s.setSettingsOpen);
  const liveIds = useBoardStore((s) => s.tasksById[task.id]?.category_ids ?? task.category_ids);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const q = query.trim();
  const shown = categories.filter((c) => c.name.toLowerCase().includes(q.toLowerCase()));
  const exact = categories.some((c) => c.name.toLowerCase() === q.toLowerCase());

  async function toggle(id: string) {
    const next = liveIds.includes(id) ? liveIds.filter((c) => c !== id) : [...liveIds, id];
    setError(await saveCategories(task.id, next));
  }

  async function create(shared: boolean) {
    if (!boardId || !q || creating) return;
    setCreating(true);
    try {
      const color = CATEGORY_COLOURS[Object.keys(useBoardStore.getState().categoriesById).length % CATEGORY_COLOURS.length];
      const category = await createCategory(boardId, { name: q, color, shared });
      useBoardStore.getState().upsertCategory(category);
      setQuery("");
      setError(await saveCategories(task.id, [...liveIds, category.id]));
    } catch (e) {
      setError((e instanceof ApiError && e.detail) || "Couldn’t create that.");
    } finally {
      setCreating(false);
      searchRef.current?.focus(); // the create buttons are gone; keep focus in the picker
    }
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (shown.length === 1 && q) toggle(shown[0].id);
    else if (q && !exact) create(false);
  }

  return (
    <FloatingPanel anchor={anchor} onClose={onClose} label="Categories" className="category-popover">
      <input
        ref={searchRef}
        className="picker-search"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setError(null);
        }}
        onKeyDown={onKey}
        placeholder="Find or create a category"
        aria-label="Find or create a category"
        maxLength={60}
      />
      {shown.map((c) => {
        const on = liveIds.includes(c.id);
        return (
          <button
            key={c.id}
            type="button"
            role="menuitemcheckbox"
            aria-checked={on}
            className="menu-item owner-option"
            onClick={() => toggle(c.id)}
          >
            <span className="category-dot" style={{ background: c.color }} />
            <span className="owner-option-name">{c.name}</span>
            {c.board_id === null && <span className="menu-hint">all boards</span>}
            {on && <span className="menu-check">✓</span>}
          </button>
        );
      })}
      {categories.length === 0 && !q && <p className="owner-empty">No categories yet. Type a name to make one.</p>}
      {q && !exact && (
        <>
          <button type="button" className="menu-item owner-option" disabled={creating} onClick={() => create(false)}>
            <span className="category-dot is-new" aria-hidden="true">+</span>
            <span className="owner-option-name">
              Create “{q}” <span className="menu-hint">{taskBoardName}</span>
            </span>
          </button>
          <button type="button" className="menu-item owner-option" disabled={creating} onClick={() => create(true)}>
            <span className="category-dot is-new" aria-hidden="true">+</span>
            <span className="owner-option-name">
              Create “{q}” <span className="menu-hint">all boards</span>
            </span>
          </button>
        </>
      )}
      {error && <p className="attach-error owner-error">{error}</p>}
      <div className="menu-divider" role="separator" />
      <button
        type="button"
        className="menu-item"
        onClick={() => {
          onClose();
          setSettingsOpen("categories");
        }}
      >
        Manage categories…
      </button>
    </FloatingPanel>
  );
}

/** A task's categories as chips. On a card, clicking them opens the
 * picker; `addButton` adds a "+ Category" control (the drawer). */
export function TaskCategories({
  task,
  interactive = true,
  addButton = false,
  compact = false,
}: {
  task: Task;
  interactive?: boolean;
  addButton?: boolean;
  /** Subtask rows: small chips, and a faint "+" when there are none. */
  compact?: boolean;
}) {
  const categoriesById = useBoardStore((s) => s.categoriesById);
  const categories = categoriesOf(task, categoriesById);
  const figures = useChipFigures(task);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);

  if (categories.length === 0 && !addButton && !(compact && interactive)) return null;
  // The drawer has an input per figure, so its chips stay plain.
  const chips = categories.map((c) => (
    <CategoryChip key={c.id} category={c} figure={addButton ? undefined : figures[c.id]} />
  ));
  const cls = `card-categories${compact ? " is-compact" : ""}`;
  if (!interactive) return <div className={cls}>{chips}</div>;

  const open = (e: React.MouseEvent<HTMLElement>) => {
    e.stopPropagation();
    setAnchor(e.currentTarget.getBoundingClientRect());
  };
  return (
    <div className={cls}>
      {categories.length > 0 && (
        <button
          type="button"
          className="category-edit"
          aria-label={`Categories: ${categories.map((c) => c.name).join(", ")}. Change`}
          {...keepToControl}
          onClick={open}
        >
          {chips}
        </button>
      )}
      {addButton && (
        <button type="button" className="category-add" {...keepToControl} onClick={open}>
          + Category
        </button>
      )}
      {compact && categories.length === 0 && (
        <button type="button" className="category-add is-compact" aria-label="Add a category" title="Add a category" {...keepToControl} onClick={open}>
          +
        </button>
      )}
      {anchor && <CategoryPicker task={task} anchor={anchor} onClose={() => setAnchor(null)} />}
    </div>
  );
}

/** Settings tab: every category this board can use, in priority order
 * (the top one a card has sets its colour in "colour by category"). */
export function CategorySettings() {
  const categories = useActiveCategories();
  const boardId = useBoardStore((s) => s.board?.id);
  const boardName = useBoardStore((s) => s.board?.name ?? "this board");
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const visible = categories.filter((c) => c.board_id === null || c.board_id === boardId);

  async function move(index: number, by: number) {
    const ids = visible.map((c) => c.id);
    const [id] = ids.splice(index, 1);
    ids.splice(index + by, 0, id);
    // Show it at once: positions follow the new order.
    const store = useBoardStore.getState();
    ids.forEach((cid, i) => store.upsertCategory({ ...store.categoriesById[cid], position: (i + 1) * 1024 }));
    try {
      await reorderCategories(ids);
      setError(null);
    } catch {
      setError("Couldn’t save the order.");
    }
  }

  return (
    <>
      {editing === "new" ? (
        <CategoryForm onDone={() => setEditing(null)} />
      ) : (
        <button type="button" className="attach-add settings-add" onClick={() => setEditing("new")}>
          + Add category
        </button>
      )}
      <section className="category-group">
        <h3>
          Priority <span className="history-count">{visible.length}</span>
        </h3>
        <p className="attachments-empty">
          Top wins: when a card has several categories, the highest one sets its colour.
        </p>
        {error && <p className="attach-error">{error}</p>}
        <ol className="owner-list category-priority">
          {visible.map((c, i) =>
            editing === c.id ? (
              <li key={c.id}>
                <CategoryForm category={c} onDone={() => setEditing(null)} />
              </li>
            ) : (
              <li key={c.id} className="owner-row">
                <span className="category-rank">{i + 1}</span>
                <span className="category-row-main">
                  <CategoryChip category={c} />
                  <span className="category-scope">
                    {c.board_id === null ? "all boards" : `${boardName} only`}
                    {c.value_type && ` · ${TYPE_INFO[c.value_type].label.toLowerCase()}`}
                    {c.value_type === "money" && ` (${c.value_config?.currency ?? "GBP"})`}
                  </span>
                </span>
                <div className="attachment-tools category-tools">
                  <button type="button" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Raise ${c.name}`} title="Higher priority">
                    ↑
                  </button>
                  <button
                    type="button"
                    disabled={i === visible.length - 1}
                    onClick={() => move(i, 1)}
                    aria-label={`Lower ${c.name}`}
                    title="Lower priority"
                  >
                    ↓
                  </button>
                  <button type="button" title="Edit" aria-label={`Edit ${c.name}`} onClick={() => setEditing(c.id)}>
                    ✎
                  </button>
                </div>
              </li>
            ),
          )}
        </ol>
      </section>
    </>
  );
}

function CategoryForm({ category, onDone }: { category?: Category; onDone: () => void }) {
  const boardId = useBoardStore((s) => s.board?.id);
  const boardName = useBoardStore((s) => s.board?.name ?? "This board");
  const count = useBoardStore((s) => Object.keys(s.categoriesById).length);
  const [name, setName] = useState(category?.name ?? "");
  const [color, setColor] = useState(category?.color ?? CATEGORY_COLOURS[count % CATEGORY_COLOURS.length]);
  const [shared, setShared] = useState(category ? category.board_id === null : false);
  const [valueType, setValueType] = useState<ValueType | "">(category?.value_type ?? "");
  const [currency, setCurrency] = useState(category?.value_config?.currency ?? "GBP");
  const [unit, setUnit] = useState(category?.value_config?.unit ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!boardId) return;
    setSaving(true);
    try {
      const value_config: ValueConfig =
        valueType === "money" ? { currency } : valueType === "number" && unit.trim() ? { unit: unit.trim() } : {};
      const saved = category
        ? await updateCategory(category.id, {
            name,
            color,
            board_id: shared ? null : boardId,
            value_type: valueType,
            value_config,
          })
        : await createCategory(boardId, { name, color, shared, value_type: valueType, value_config });
      useBoardStore.getState().upsertCategory(saved);
      onDone();
    } catch (e) {
      setError((e instanceof ApiError && e.detail) || "Couldn’t save that.");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!category) return;
    try {
      await archiveCategory(category.id);
      useBoardStore.getState().upsertCategory({ ...category, archived: true });
      onDone();
    } catch {
      setError("Couldn’t remove that.");
    }
  }

  return (
    <form className="attach-form owner-form" onSubmit={submit}>
      <div className="owner-preview">
        <CategoryChip category={{ name: name || "Category", color, board_id: shared ? null : "board" }} />
      </div>
      <label className="attach-field">
        <span>Name</span>
        <input autoFocus required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder="Bug, Frontend, Client work…" />
      </label>
      <fieldset className="owner-colours">
        <legend>Colour</legend>
        <div className="swatches">
          {CATEGORY_COLOURS.map((c) => (
            <button
              key={c}
              type="button"
              className="swatch"
              style={{ background: c }}
              aria-label={`Colour ${c}`}
              aria-pressed={color === c}
              onClick={() => setColor(c)}
            />
          ))}
          <label className="swatch swatch-custom" title="Custom colour">
            <input type="color" value={color} aria-label="Custom colour" onChange={(e) => setColor(e.target.value)} />
          </label>
        </div>
      </fieldset>
      <fieldset className="owner-colours">
        <legend>Available on</legend>
        <div className="segmented scope-switch" role="group" aria-label="Available on">
          <button type="button" aria-pressed={!shared} onClick={() => setShared(false)}>
            {boardName} only
          </button>
          <button type="button" aria-pressed={shared} onClick={() => setShared(true)}>
            All boards
          </button>
        </div>
      </fieldset>
      <fieldset className="owner-colours">
        <legend>Tasks in it carry</legend>
        <div className="segmented value-type-switch" role="group" aria-label="Tasks in it carry">
          <button type="button" aria-pressed={valueType === ""} onClick={() => setValueType("")}>
            Nothing
          </button>
          {VALUE_TYPES.map((t) => (
            <button key={t} type="button" aria-pressed={valueType === t} onClick={() => setValueType(t)}>
              {TYPE_INFO[t].label}
            </button>
          ))}
        </div>
        {valueType && <p className="attachments-empty">{TYPE_INFO[valueType].hint}</p>}
        {valueType === "money" && (
          <label className="attach-field">
            <span>Currency</span>
            <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {CURRENCIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.symbol} {c.code}
                </option>
              ))}
            </select>
          </label>
        )}
        {valueType === "number" && (
          <label className="attach-field">
            <span>Unit (optional)</span>
            <input value={unit} maxLength={12} onChange={(e) => setUnit(e.target.value)} placeholder="pts, mi, kg…" />
          </label>
        )}
        {valueType === "duration" && <WorkingDay />}
        {category && category.value_type && valueType !== category.value_type && (
          <p className="attachments-empty">
            Figures already entered as {TYPE_INFO[category.value_type].label.toLowerCase()} are kept but hidden; they
            come back if you switch back.
          </p>
        )}
      </fieldset>
      {error && <p className="attach-error" role="alert">{error}</p>}
      <div className="attach-form-buttons">
        {category &&
          (confirmRemove ? (
            <button type="button" className="owner-remove is-confirm" onClick={remove}>
              Remove {category.name}?
            </button>
          ) : (
            <button type="button" className="owner-remove" onClick={() => setConfirmRemove(true)}>
              Remove
            </button>
          ))}
        <button type="button" onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={saving}>
          {saving ? "Saving…" : category ? "Save" : "Add"}
        </button>
      </div>
    </form>
  );
}

/** How many hours a day of time figures means, for this board (sub-boards
 * inherit it unless they set their own). */
function WorkingDay() {
  const board = useBoardStore((s) => s.board);
  const [text, setText] = useState(String(board?.hours_per_day ?? 7.5));
  const [note, setNote] = useState<string | null>(null);
  if (!board) return null;
  async function save() {
    if (!board) return;
    const hours = Number(text);
    if (String(hours) === String(board.hours_per_day)) return;
    try {
      const saved = await setHoursPerDay(board.id, text.trim() === "" ? null : hours);
      useBoardStore.setState((s) => (s.board ? { board: { ...s.board, hours_per_day: saved.hours_per_day } } : s));
      setText(String(saved.hours_per_day));
      setNote("Saved.");
    } catch (e) {
      setNote((e instanceof ApiError && e.detail) || "Couldn’t save that.");
    }
  }
  return (
    <label className="attach-field">
      <span>A working day on {board.name}, in hours</span>
      <input
        inputMode="decimal"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setNote(null);
        }}
        onBlur={save}
        onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), save())}
      />
      <small className="attachments-empty">{note ?? "So 1d means this many hours. Sub-boards use it too."}</small>
    </label>
  );
}

/** Header control: show only tasks in any of the chosen categories (or
 * none). Combined with the owner filter, a task must pass both. */
export function CategoryFilter() {
  const categories = useActiveCategories();
  const filter = useBoardStore((s) => s.categoryFilter);
  const setCategoryFilter = useBoardStore((s) => s.setCategoryFilter);
  const setSettingsOpen = useBoardStore((s) => s.setSettingsOpen);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const chosen = categories.filter((c) => filter.includes(c.id));
  const uncategorised = filter.includes(UNCATEGORISED);

  const toggle = (id: string) =>
    setCategoryFilter(filter.includes(id) ? filter.filter((f) => f !== id) : [...filter, id]);

  return (
    <>
      <button
        type="button"
        className={`filter-chip${filter.length ? " is-active" : ""}`}
        aria-haspopup="menu"
        aria-expanded={!!anchor}
        onClick={(e) => setAnchor(e.currentTarget.getBoundingClientRect())}
        title={chosen.length ? `Categories: ${chosen.map((c) => c.name).join(", ")}` : "Filter by category"}
      >
        {filter.length === 0 ? (
          <>
            <span aria-hidden="true">◇</span> Categories
          </>
        ) : (
          <>
            {chosen.slice(0, 3).map((c) => (
              <span key={c.id} className="filter-dot" style={{ background: c.color }} aria-hidden="true" />
            ))}
            <span className="filter-label">
              {chosen.length === 1 && !uncategorised
                ? chosen[0].name
                : `${chosen.length + (uncategorised ? 1 : 0)} categories`}
            </span>
          </>
        )}
      </button>
      {filter.length > 0 && (
        <button
          type="button"
          className="filter-clear"
          onClick={() => setCategoryFilter([])}
          aria-label="Clear category filter"
          title="Show every category"
        >
          ×
        </button>
      )}
      {anchor && (
        <FloatingPanel anchor={anchor} onClose={() => setAnchor(null)} label="Filter by category" className="category-popover">
          <p className="menu-label">Show tasks in</p>
          {categories.map((c) => (
            <button
              key={c.id}
              type="button"
              role="menuitemcheckbox"
              aria-checked={filter.includes(c.id)}
              className="menu-item owner-option"
              onClick={() => toggle(c.id)}
            >
              <span className="category-dot" style={{ background: c.color }} />
              <span className="owner-option-name">{c.name}</span>
              {c.board_id === null && <span className="menu-hint">all boards</span>}
              {filter.includes(c.id) && <span className="menu-check">✓</span>}
            </button>
          ))}
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={uncategorised}
            className="menu-item owner-option"
            onClick={() => toggle(UNCATEGORISED)}
          >
            <span className="category-dot is-new" aria-hidden="true">–</span>
            <span className="owner-option-name">No category</span>
            {uncategorised && <span className="menu-check">✓</span>}
          </button>
          <div className="menu-divider" role="separator" />
          {filter.length > 0 ? (
            <button type="button" className="menu-item" onClick={() => setCategoryFilter([])}>
              Show every category
            </button>
          ) : (
            <p className="owner-empty">Pick any number; tasks in any of them show.</p>
          )}
          <button
            type="button"
            className="menu-item"
            onClick={() => {
              setAnchor(null);
              setSettingsOpen("categories");
            }}
          >
            Manage categories…
          </button>
        </FloatingPanel>
      )}
    </>
  );
}
