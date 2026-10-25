import { useCallback, useEffect, useState } from "react";
import { ApiError, getOwnerLog, setTaskFlags } from "../api/client";
import { newOpId } from "../lib/compat";
import { relativeTime } from "../lib/history";
import { formatDuration } from "../lib/time";
import { quote } from "../lib/undo";
import { useBoardStore } from "../store/boardStore";
import type { OwnerPeriod, Task } from "../types";
import { OwnerBadge } from "./Owners";

type Flag = "hide_subtasks" | "owner_follows_next";

async function saveFlag(task: Task, flag: Flag, value: boolean): Promise<string | null> {
  const store = useBoardStore.getState();
  const before = !!task[flag];
  const opId = newOpId();
  store.registerOp(opId);
  store.upsertTask({ ...task, [flag]: value });
  try {
    const updated = await setTaskFlags(task.id, { [flag]: value }, { op_id: opId, actor: "board-user" });
    useBoardStore.getState().upsertTask(updated);
    const label =
      flag === "hide_subtasks"
        ? value
          ? "Subtasks kept off the board"
          : "Subtasks back on the board"
        : value
          ? "Owners follow the next subtask"
          : "Owners set by hand";
    useBoardStore.getState().offerUndo(`${label}: ${quote(task.title)}`, async () => {
      const restored = await setTaskFlags(task.id, { [flag]: before }, { actor: "board-user" });
      useBoardStore.getState().upsertTask(restored);
    });
    return null;
  } catch (e) {
    const s = useBoardStore.getState();
    s.resolveOp(opId);
    s.upsertTask({ ...s.tasksById[task.id], [flag]: before });
    return (e instanceof ApiError && e.detail) || "Couldn’t save that.";
  }
}

/** A parent's options: owners follow its next subtask (off once someone
 * sets them by hand), and keeping its subtasks off the board. */
export function ParentOptions({ task }: { task: Task }) {
  const count = useBoardStore((s) => s.childrenByParent[task.id]?.length ?? 0);
  const [error, setError] = useState<string | null>(null);
  if (count === 0) return null;
  const follows = task.owner_follows_next !== false;
  const hides = !!task.hide_subtasks;
  const toggle = async (flag: Flag, value: boolean) => setError(await saveFlag(task, flag, value));
  return (
    <section className="parent-options" aria-label="Subtask options">
      <label className="parent-option">
        <input type="checkbox" checked={follows} onChange={(e) => toggle("owner_follows_next", e.target.checked)} />
        <span>
          Owners follow the next subtask
          <small>
            {follows
              ? "Changes as the work moves on. Setting owners here by hand stops it."
              : "Set by hand (someone owning the whole thing). Tick to follow the next subtask again."}
          </small>
        </span>
      </label>
      <label className="parent-option">
        <input type="checkbox" checked={hides} onChange={(e) => toggle("hide_subtasks", e.target.checked)} />
        <span>
          Keep its subtasks off the board
          <small>They stay on this card and here, where you can still tick them off.</small>
        </span>
      </label>
      {error && <p className="attach-error">{error}</p>}
    </section>
  );
}

/** Who owned it when: one row per stretch, newest first. */
export function OwnerLog({ task }: { task: Task }) {
  const ownersById = useBoardStore((s) => s.ownersById);
  const tasksById = useBoardStore((s) => s.tasksById);
  const lastEventId = useBoardStore((s) => s.lastEventId);
  const [periods, setPeriods] = useState<OwnerPeriod[] | null>(null);

  const load = useCallback(() => {
    getOwnerLog(task.id)
      .then(setPeriods)
      .catch(() => setPeriods((p) => p ?? []));
  }, [task.id]);

  useEffect(() => {
    const t = window.setTimeout(load, 250);
    return () => window.clearTimeout(t);
  }, [load, lastEventId]);

  // Unowned for under a minute (owners set right after creating): noise.
  const shown = (periods ?? []).filter(
    (p) => p.owner_ids.length > 0 || !p.end || new Date(p.end).getTime() - new Date(p.start).getTime() >= 60_000,
  );
  if (shown.length === 0) return null;
  if (shown.length === 1 && shown[0].owner_ids.length === 0) return null;
  const rows = [...shown].reverse();
  return (
    <section className="owner-log" aria-labelledby="owner-log-title">
      <h3 id="owner-log-title">
        Owners over time <span className="history-count">{shown.length}</span>
      </h3>
      <ol>
        {rows.map((p) => {
          const end = p.end ? new Date(p.end).getTime() : Date.now();
          const seconds = Math.max(0, (end - new Date(p.start).getTime()) / 1000);
          const owners = p.owner_ids.map((id) => ownersById[id]).filter(Boolean);
          const via = p.via_subtask ? tasksById[p.via_subtask]?.title : undefined;
          return (
            <li key={p.start} className={p.end ? undefined : "is-current"}>
              <span className="owner-log-who">
                {owners.length ? owners.map((o) => <OwnerBadge key={o.id} owner={o} size="sm" />) : <em>Nobody</em>}
                <span className="owner-log-names">{owners.map((o) => o.name).join(", ")}</span>
              </span>
              <span className="owner-log-when">
                {p.end ? formatDuration(seconds) : `now · ${formatDuration(seconds)}`}
                <small>since {relativeTime(p.start)}</small>
              </span>
              <span className="owner-log-how">
                {p.set_by === "auto" ? `followed the next subtask${via ? ` (${quote(via)})` : ""}` : `set by ${p.set_by}`}
                {p.lanes.length > 0 && ` · ${p.lanes.join(" → ")}`}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
