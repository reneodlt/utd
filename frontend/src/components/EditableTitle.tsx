import { useEffect, useRef, useState } from "react";
import { ApiError, setTaskTitle } from "../api/client";
import { newOpId } from "../lib/compat";
import { useBoardStore } from "../store/boardStore";
import type { Task } from "../types";

/** The drawer's title: click to rename (Enter or leaving saves, Esc
 * cancels). Photo tasks start with a placeholder name, so this matters. */
export default function EditableTitle({ task }: { task: Task }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(task.title);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editing) setValue(task.title);
  }, [task.title, editing]);

  useEffect(() => {
    const el = ref.current;
    if (!editing || !el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [editing, value]);

  async function save() {
    setEditing(false);
    const title = value.replace(/\s+/g, " ").trim();
    if (!title || title === task.title) {
      setValue(task.title);
      return;
    }
    const store = useBoardStore.getState();
    const opId = newOpId();
    store.registerOp(opId);
    store.upsertTask({ ...store.tasksById[task.id], title });
    try {
      useBoardStore.getState().upsertTask(await setTaskTitle(task.id, title, { op_id: opId, actor: "board-user" }));
      setError(null);
    } catch (e) {
      const state = useBoardStore.getState();
      state.resolveOp(opId);
      state.upsertTask({ ...state.tasksById[task.id], title: task.title });
      setError((e instanceof ApiError && e.detail) || "Couldn’t rename it.");
    }
  }

  if (!editing) {
    return (
      <>
        <h2 id="drawer-title" className="drawer-title-edit" title="Click to rename" tabIndex={0}
          onClick={() => setEditing(true)}
          onKeyDown={(e) => e.key === "Enter" && setEditing(true)}
        >
          {task.title}
        </h2>
        {error && <p className="attach-error">{error}</p>}
      </>
    );
  }
  return (
    <textarea
      ref={ref}
      id="drawer-title"
      className="drawer-title-input"
      value={value}
      rows={1}
      maxLength={300}
      autoFocus
      onFocus={(e) => e.target.select()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          save();
        } else if (e.key === "Escape") {
          e.stopPropagation();
          setValue(task.title);
          setEditing(false);
        }
      }}
      aria-label="Task title"
    />
  );
}
