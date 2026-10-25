import { useMemo, useRef, useState } from "react";
import { ApiError, linkTasks, unlinkTasks } from "../api/client";
import { newOpId } from "../lib/compat";
import { quote } from "../lib/undo";
import { useBoardStore } from "../store/boardStore";
import type { Task, TaskLink } from "../types";

type LinkType = TaskLink["link_type"];

/** How a link reads from each end. */
const OUT: Record<LinkType, string> = {
  blocks: "Blocks",
  relates_to: "Related to",
  similar_to: "Similar to",
  milestone_of: "Milestone of",
  duplicates: "Duplicate of",
};
const IN: Record<LinkType, string> = {
  blocks: "Blocked by",
  relates_to: "Related to",
  similar_to: "Similar to",
  milestone_of: "Has milestone",
  duplicates: "Duplicated by",
};

/** Choices when adding, from this task's point of view. `reverse` = the
 * link is stored from the other task to this one. */
const CHOICES: { label: string; type: LinkType; reverse: boolean }[] = [
  { label: "Blocks…", type: "blocks", reverse: false },
  { label: "Is blocked by…", type: "blocks", reverse: true },
  { label: "Relates to…", type: "relates_to", reverse: false },
  { label: "Duplicate of…", type: "duplicates", reverse: false },
  { label: "Duplicated by…", type: "duplicates", reverse: true },
  { label: "Similar to…", type: "similar_to", reverse: false },
  { label: "Milestone of…", type: "milestone_of", reverse: false },
  { label: "Has milestone…", type: "milestone_of", reverse: true },
];

interface Row {
  link: TaskLink;
  other: string;
  phrase: string;
}

/** The drawer's links: both directions, add (same board — the server
 * doesn't link across boards), remove with undo. */
export function TaskLinks({ task }: { task: Task }) {
  const tasksById = useBoardStore((s) => s.tasksById);
  const openDetail = useBoardStore((s) => s.openDetail);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Outgoing links travel on this task; incoming ones on the other tasks.
  const rows: Row[] = useMemo(() => {
    const out = task.links.map((link) => ({ link, other: link.to_task_id, phrase: OUT[link.link_type] }));
    const incoming = Object.values(tasksById).flatMap((t) =>
      t.id === task.id
        ? []
        : t.links
            .filter((l) => l.to_task_id === task.id)
            .map((link) => ({ link: { ...link, from_task_id: t.id }, other: t.id, phrase: IN[link.link_type] })),
    );
    return [...out, ...incoming].sort((a, b) => a.phrase.localeCompare(b.phrase));
  }, [task, tasksById]);

  const titleOf = (id: string) => tasksById[id]?.title ?? "a task no longer on the board";

  async function remove(row: Row) {
    setError(null);
    const opId = newOpId();
    useBoardStore.getState().registerOp(opId);
    try {
      await unlinkTasks(row.link.from_task_id, row.link.id, { op_id: opId, actor: "board-user" });
      const { from_task_id, to_task_id, link_type } = row.link;
      useBoardStore
        .getState()
        .offerUndo(`Unlinked ${quote(titleOf(row.other))}`, () =>
          linkTasks(from_task_id, to_task_id, link_type, { actor: "board-user" }),
        );
    } catch (e) {
      useBoardStore.getState().resolveOp(opId);
      setError((e instanceof ApiError && e.detail) || "Couldn’t remove that link.");
    }
  }

  return (
    <section className="task-links" aria-labelledby="links-title">
      <div className="attachments-bar">
        <h3 id="links-title">
          Links {rows.length > 0 && <span className="history-count">{rows.length}</span>}
        </h3>
        {!adding && (
          <button type="button" className="attach-add" onClick={() => setAdding(true)}>
            + Link
          </button>
        )}
      </div>
      {error && <p className="attach-error">{error}</p>}
      {adding && <AddLink task={task} onDone={() => setAdding(false)} onError={setError} />}
      {rows.length === 0 && !adding && (
        <p className="attachments-empty">Blocks, blocked by, duplicates, related tasks on this board.</p>
      )}
      {rows.length > 0 && (
        <ul className="link-list">
          {rows.map((row) => (
            <li key={`${row.link.id}-${row.other}`} className={`link-row link-${row.link.link_type}`}>
              <span className="link-phrase">{row.phrase}</span>
              <button type="button" className="tree-title" onClick={() => openDetail(row.other)}>
                {titleOf(row.other)}
              </button>
              <button
                type="button"
                className="link-remove"
                aria-label={`Remove link: ${row.phrase} ${titleOf(row.other)}`}
                title="Remove link"
                onClick={() => remove(row)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AddLink({ task, onDone, onError }: { task: Task; onDone: () => void; onError: (e: string | null) => void }) {
  const tasksById = useBoardStore((s) => s.tasksById);
  const [choice, setChoice] = useState(0);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const q = query.trim().toLowerCase();
  const candidates = Object.values(tasksById)
    .filter((t) => t.board_id === task.board_id && t.id !== task.id)
    .filter((t) => !q || t.title.toLowerCase().includes(q))
    .slice(0, 8);

  async function pick(other: Task) {
    const { type, reverse } = CHOICES[choice];
    setBusy(true);
    onError(null);
    try {
      const [from, to] = reverse ? [other.id, task.id] : [task.id, other.id];
      await linkTasks(from, to, type, { actor: "board-user" });
      onDone();
    } catch (e) {
      onError((e instanceof ApiError && e.detail) || "Couldn’t add that link.");
      setBusy(false);
    }
  }

  return (
    <div className="attach-form link-add" onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), onDone())}>
      <select value={choice} onChange={(e) => setChoice(Number(e.target.value))} aria-label="Kind of link">
        {CHOICES.map((c, i) => (
          <option key={c.label} value={i}>
            {c.label}
          </option>
        ))}
      </select>
      <input
        ref={inputRef}
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Find a task on this board"
        aria-label="Find a task to link"
        onKeyDown={(e) => {
          if (e.key === "Enter" && candidates[0]) {
            e.preventDefault();
            pick(candidates[0]);
          }
        }}
      />
      <ul className="link-candidates">
        {candidates.map((t) => (
          <li key={t.id}>
            <button type="button" disabled={busy} onClick={() => pick(t)}>
              {t.title}
            </button>
          </li>
        ))}
        {candidates.length === 0 && <li className="attachments-empty">No matching task on this board.</li>}
      </ul>
      <div className="attach-form-buttons">
        <button type="button" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}
