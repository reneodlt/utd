import { useState } from "react";
import { ApiError, setTaskDueDate } from "../api/client";
import { COLOUR_OPTIONS, dueLabel, dueState, type ColourBy } from "../lib/cardColour";
import { newOpId } from "../lib/compat";
import { useBoardStore } from "../store/boardStore";
import type { Task } from "../types";

/** "Colour: Time in lane ▾" — what the cards' colour means. */
export function ColourBySelect({ variant = "chip" }: { variant?: "chip" | "sheet" }) {
  const colourBy = useBoardStore((s) => s.colourBy);
  const setColourBy = useBoardStore((s) => s.setColourBy);
  if (variant === "sheet") {
    return (
      <div className="segmented colour-by-sheet" role="group" aria-label="Colour cards by">
        {COLOUR_OPTIONS.map((o) => (
          <button key={o.value} type="button" aria-pressed={colourBy === o.value} onClick={() => setColourBy(o.value)}>
            {o.label}
          </button>
        ))}
      </div>
    );
  }
  return (
    <label className={`colour-by${colourBy !== "age" ? " is-active" : ""}`} title="What the cards’ colour shows">
      <span className="colour-by-swatch" aria-hidden="true" />
      <select value={colourBy} onChange={(e) => setColourBy(e.target.value as ColourBy)} aria-label="Colour cards by">
        {COLOUR_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            Colour: {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function isoIn(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The drawer's deadline control: a date, quick picks, clear. */
export function DueDateField({ task }: { task: Task }) {
  const [error, setError] = useState<string | null>(null);
  const inFinal = useBoardStore((s) => !!s.lanes.find((l) => l.id === task.lane_id)?.is_final);

  async function save(value: string | null) {
    if (value === task.due_date) return;
    const store = useBoardStore.getState();
    const opId = newOpId();
    store.registerOp(opId);
    const before = task.due_date;
    store.upsertTask({ ...store.tasksById[task.id], due_date: value });
    try {
      const updated = await setTaskDueDate(task.id, value, { op_id: opId, actor: "board-user" });
      useBoardStore.getState().upsertTask(updated);
      setError(null);
    } catch (e) {
      const state = useBoardStore.getState();
      state.resolveOp(opId);
      state.upsertTask({ ...state.tasksById[task.id], due_date: before });
      setError((e instanceof ApiError && e.detail) || "Couldn’t save the deadline.");
    }
  }

  const state = task.due_date && !inFinal ? dueState(task.due_date) : null;
  return (
    <div className="due-field">
      <span className="due-field-label">Deadline</span>
      <input
        type="date"
        value={task.due_date ?? ""}
        onChange={(e) => save(e.target.value || null)}
        aria-label="Deadline"
      />
      {task.due_date ? (
        <>
          {state && <span className={`badge badge-due due-${state}`}>{dueLabel(task.due_date)}</span>}
          <button type="button" className="link-button" onClick={() => save(null)}>
            Clear
          </button>
        </>
      ) : (
        <span className="due-quick">
          <button type="button" onClick={() => save(isoIn(0))}>
            Today
          </button>
          <button type="button" onClick={() => save(isoIn(1))}>
            Tomorrow
          </button>
          <button type="button" onClick={() => save(isoIn(7))}>
            +1 week
          </button>
        </span>
      )}
      {error && <span className="attach-error">{error}</span>}
    </div>
  );
}
