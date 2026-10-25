import { useEffect, useRef, useState, type FormEvent } from "react";
import { addLane, ApiError, removeLane, reorderLanes, updateLane, type LaneFields } from "../api/client";
import { useBoardStore } from "../store/boardStore";
import type { Lane } from "../types";

const COLOURS = [
  "#6b7280", "#3b82f6", "#0ea5e9", "#14b8a6", "#22c55e",
  "#eab308", "#f59e0b", "#f97316", "#ef4444", "#a855f7",
];

type Pending = { laneId: string; fields: LaneFields; boards: string[] } | null;

/** Board settings: the lanes. Parents always hold every lane their
 * sub-boards have (the server keeps that true), so here a lane can show
 * which sub-boards share it. */
export function LanesPanel() {
  const open = useBoardStore((s) => s.lanesOpen);
  const setLanesOpen = useBoardStore((s) => s.setLanesOpen);
  const board = useBoardStore((s) => s.board);
  const lanes = useBoardStore((s) => s.lanes);
  const counts = useBoardStore((s) => s.taskIdsByLane);
  const family = useBoardStore((s) => s.familyById);
  const laneBack = useBoardStore((s) => s.laneBack);
  const [error, setError] = useState<string | null>(null);
  const [cascade, setCascade] = useState<Pending>(null);
  const [adding, setAdding] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setCascade(null);
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setLanesOpen(false);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      opener?.focus?.();
    };
  }, [open, setLanesOpen]);

  if (!open || !board) return null;

  /** Run a lane change; the answer is the board's new lane list. */
  async function run(change: () => Promise<Lane[]>, onConflict?: (boards: string[]) => void) {
    setError(null);
    try {
      useBoardStore.getState().setLanes(await change());
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && onConflict) {
        const boards = ((e.body.boards as { name: string }[]) ?? []).map((b) => b.name);
        onConflict(boards);
      } else {
        setError((e instanceof ApiError && e.detail) || "Couldn’t change the lanes.");
      }
      return false;
    }
  }

  const edit = (lane: Lane, fields: LaneFields) =>
    run(
      () => updateLane(lane.id, fields),
      (boards) => setCascade({ laneId: lane.id, fields, boards }),
    );

  const move = (index: number, by: number) => {
    const ids = lanes.map((l) => l.id);
    const [id] = ids.splice(index, 1);
    ids.splice(index + by, 0, id);
    run(() => reorderLanes(board.id, ids));
  };

  // Which sub-boards share each lane (by name) — shown on parents only.
  const subBoards = Object.values(family);
  const sharedBy = (lane: Lane) =>
    subBoards.filter((b) => laneBack[b.id]?.[lane.id]).map((b) => b.name);

  return (
    <>
      <div className="drawer-backdrop" onPointerDown={() => setLanesOpen(false)} />
      <aside className="drawer lanes-panel" role="dialog" aria-modal="true" aria-labelledby="lanes-title">
        <header className="drawer-header">
          <div className="drawer-heading">
            <span className="eyebrow">{board.name}</span>
            <h2 id="lanes-title">Lanes</h2>
          </div>
          <button ref={closeRef} type="button" className="drawer-close" onClick={() => setLanesOpen(false)} aria-label="Close lanes">
            ×
          </button>
        </header>
        <div className="drawer-scroll">
          <p className="settings-intro">
            Tasks in a <strong>final</strong> lane count as done: they stop blocking, count as
            finished subtasks, and the lane gets “Archive all”.
            {subBoards.length > 0 &&
              " This board also holds every lane its sub-boards have; those are kept in step automatically."}
          </p>

          {error && <p className="attach-error" role="alert">{error}</p>}

          {cascade && (
            <div className="lane-cascade" role="alert">
              <span>
                {cascade.boards.join(", ")} also {cascade.boards.length === 1 ? "has" : "have"} this lane.
                Rename it there too?
              </span>
              <span className="lane-cascade-buttons">
                <button type="button" onClick={() => setCascade(null)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="primary"
                  onClick={async () => {
                    const { laneId, fields } = cascade;
                    setCascade(null);
                    await run(() => updateLane(laneId, { ...fields, cascade: true }));
                  }}
                >
                  Rename everywhere
                </button>
              </span>
            </div>
          )}

          <ol className="lane-config-list">
            {lanes.map((lane, i) => (
              <LaneRow
                key={lane.id}
                lane={lane}
                others={lanes.filter((l) => l.id !== lane.id)}
                count={(counts[lane.id] ?? []).length}
                sharedBy={sharedBy(lane)}
                first={i === 0}
                last={i === lanes.length - 1}
                onEdit={(fields) => edit(lane, fields)}
                onMove={(by) => move(i, by)}
                onRemove={(moveTo) =>
                  run(
                    () => removeLane(lane.id, moveTo),
                    (boards) =>
                      setError(`${boards.join(", ")} still ${boards.length === 1 ? "has" : "have"} this lane; remove it there first.`),
                  )
                }
              />
            ))}
          </ol>

          {adding ? (
            <AddLane
              lanes={lanes}
              onCancel={() => setAdding(false)}
              onAdd={async (fields, index) => {
                if (await run(() => addLane(board.id, { ...fields, index }))) setAdding(false);
              }}
            />
          ) : (
            <button type="button" className="attach-add settings-add" onClick={() => setAdding(true)}>
              + Add lane
            </button>
          )}
        </div>
      </aside>
    </>
  );
}

function LaneRow({
  lane,
  others,
  count,
  sharedBy,
  first,
  last,
  onEdit,
  onMove,
  onRemove,
}: {
  lane: Lane;
  others: Lane[];
  count: number;
  sharedBy: string[];
  first: boolean;
  last: boolean;
  onEdit: (fields: LaneFields) => Promise<boolean>;
  onMove: (by: number) => void;
  onRemove: (moveTo?: string) => void;
}) {
  const [name, setName] = useState(lane.name);
  const [wip, setWip] = useState(lane.wip_limit === null ? "" : String(lane.wip_limit));
  const [colours, setColours] = useState(false);
  const [removing, setRemoving] = useState(false);
  // Ticks at once; reverts if the save fails.
  const [isFinal, setIsFinal] = useState(lane.is_final);
  useEffect(() => setIsFinal(lane.is_final), [lane.is_final]);
  const [moveTo, setMoveTo] = useState(others[0]?.id ?? "");

  useEffect(() => setName(lane.name), [lane.name]);
  useEffect(() => setWip(lane.wip_limit === null ? "" : String(lane.wip_limit)), [lane.wip_limit]);

  async function commitName() {
    const trimmed = name.trim();
    if (!trimmed || trimmed === lane.name) {
      setName(lane.name);
      return;
    }
    if (!(await onEdit({ name: trimmed }))) setName(lane.name);
  }

  function commitWip() {
    const value = wip.trim() === "" ? null : Math.max(0, Math.floor(Number(wip)));
    if (Number.isNaN(value) || value === lane.wip_limit) {
      setWip(lane.wip_limit === null ? "" : String(lane.wip_limit));
      return;
    }
    onEdit({ wip_limit: value });
  }

  return (
    <li className={`lane-config${isFinal ? " is-final" : ""}`} style={{ "--lane-color": lane.color } as React.CSSProperties}>
      <div className="lane-config-main">
        <button
          type="button"
          className="lane-swatch"
          style={{ background: lane.color }}
          aria-label={`Colour for ${lane.name}`}
          aria-expanded={colours}
          onClick={() => setColours((c) => !c)}
        />
        <input
          className="lane-name"
          value={name}
          maxLength={100}
          aria-label="Lane name"
          onChange={(e) => setName(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") {
              e.stopPropagation();
              setName(lane.name);
            }
          }}
        />
        <span className="lane-config-moves">
          <button type="button" disabled={first} onClick={() => onMove(-1)} aria-label={`Move ${lane.name} left`} title="Move left">
            ↑
          </button>
          <button type="button" disabled={last} onClick={() => onMove(1)} aria-label={`Move ${lane.name} right`} title="Move right">
            ↓
          </button>
        </span>
      </div>

      {colours && (
        <div className="swatches lane-swatches">
          {COLOURS.map((c) => (
            <button
              key={c}
              type="button"
              className="swatch"
              style={{ background: c }}
              aria-label={`Colour ${c}`}
              aria-pressed={lane.color === c}
              onClick={() => {
                setColours(false);
                onEdit({ color: c });
              }}
            />
          ))}
        </div>
      )}

      <div className="lane-config-options">
        <label className="lane-final">
          <input
            type="checkbox"
            checked={isFinal}
            onChange={async (e) => {
              const next = e.target.checked;
              setIsFinal(next);
              if (!(await onEdit({ is_final: next }))) setIsFinal(!next);
            }}
          />
          Final (done) lane
        </label>
        <label className="lane-wip">
          WIP limit
          <input
            type="number"
            min={0}
            inputMode="numeric"
            value={wip}
            placeholder="none"
            onChange={(e) => setWip(e.target.value)}
            onBlur={commitWip}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
        </label>
        <span className="lane-config-count">{count} open</span>
        {sharedBy.length > 0 && (
          <span className="lane-config-shared" title="Sub-boards with this lane">
            also on {sharedBy.join(", ")}
          </span>
        )}
        {!removing && others.length > 0 && (
          <button type="button" className="lane-remove" onClick={() => (count ? setRemoving(true) : onRemove())}>
            Remove
          </button>
        )}
      </div>

      {removing && (
        <div className="lane-remove-confirm">
          <span>Move its {count} open task{count === 1 ? "" : "s"} to</span>
          <select value={moveTo} onChange={(e) => setMoveTo(e.target.value)} aria-label="Move tasks to">
            {others.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
          <button type="button" onClick={() => setRemoving(false)}>
            Cancel
          </button>
          <button type="button" className="is-danger" onClick={() => onRemove(moveTo)}>
            Move &amp; remove
          </button>
        </div>
      )}
    </li>
  );
}

function AddLane({
  lanes,
  onAdd,
  onCancel,
}: {
  lanes: Lane[];
  onAdd: (fields: LaneFields, index: number) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  // Default: just before the first final lane (new lanes are usually steps
  // of work, not another "done").
  const firstFinal = lanes.findIndex((l) => l.is_final);
  const [index, setIndex] = useState(firstFinal >= 0 ? firstFinal : lanes.length);
  const [isFinal, setIsFinal] = useState(false);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    onAdd({ name: name.trim(), is_final: isFinal, color: COLOURS[(lanes.length * 3) % COLOURS.length] }, index);
  }

  return (
    <form className="attach-form lane-add" onSubmit={submit} onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), onCancel())}>
      <label className="attach-field">
        <span>Lane name</span>
        <input autoFocus value={name} maxLength={100} onChange={(e) => setName(e.target.value)} placeholder="Blocked, QA, Waiting on client…" />
      </label>
      <label className="attach-field">
        <span>Position</span>
        <select value={index} onChange={(e) => setIndex(Number(e.target.value))}>
          <option value={0}>First</option>
          {lanes.map((l, i) => (
            <option key={l.id} value={i + 1}>
              After {l.name}
            </option>
          ))}
        </select>
      </label>
      <label className="lane-final">
        <input type="checkbox" checked={isFinal} onChange={(e) => setIsFinal(e.target.checked)} />
        Final (done) lane
      </label>
      <div className="attach-form-buttons">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={!name.trim()}>
          Add lane
        </button>
      </div>
    </form>
  );
}
