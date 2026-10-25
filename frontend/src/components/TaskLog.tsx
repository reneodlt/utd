import { useCallback, useEffect, useState, type KeyboardEvent } from "react";
import { ApiError, addComment, getComments, updateComment } from "../api/client";
import { useBoardOwners } from "../lib/boardOwners";
import { newOpId } from "../lib/compat";
import { relativeTime, whenLabel } from "../lib/history";
import { useBoardStore } from "../store/boardStore";
import type { Task, TaskComment } from "../types";
import { isClip, MediaClip } from "./Attachments";
import { OwnerBadge } from "./Owners";

/** A moment as the value of an <input type="datetime-local"> (local time). */
function toLocalInput(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

const nowLocal = () => toLocalInput(new Date());
const yesterdayLocal = () => toLocalInput(new Date(Date.now() - 86_400_000));

/** When something happened: now by default, yesterday, or any past moment. */
function WhenControl({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const isNow = value === "";
  return (
    <span className="log-when">
      <button type="button" className={`log-when-pick${isNow ? " is-on" : ""}`} onClick={() => onChange("")}>
        Now
      </button>
      <button
        type="button"
        className={`log-when-pick${!isNow && value === yesterdayLocal() ? " is-on" : ""}`}
        onClick={() => onChange(yesterdayLocal())}
      >
        Yesterday
      </button>
      <input
        type="datetime-local"
        value={isNow ? nowLocal() : value}
        max={nowLocal()}
        aria-label="When it happened"
        onChange={(e) => onChange(e.target.value)}
      />
    </span>
  );
}

const META = () => {
  const opId = newOpId();
  useBoardStore.getState().registerOp(opId);
  return { op_id: opId, actor: "board-user" };
};

/** The drawer's log: timestamped notes on a task (calls, progress, what
 * was agreed), newest first, each optionally about one of the owners. */
export function TaskLog({ task }: { task: Task }) {
  const lastEventId = useBoardStore((s) => s.lastEventId);
  const [entries, setEntries] = useState<TaskComment[] | null>(null);
  const [text, setText] = useState("");
  const [about, setAbout] = useState<string>("");
  const [when, setWhen] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { shortlist, others } = useBoardOwners();

  const load = useCallback(() => {
    getComments(task.id)
      .then(setEntries)
      .catch(() => setEntries((e) => e ?? []));
  }, [task.id]);

  // New entries from anywhere (another screen) come in with the task's events.
  const count = task.comment_count ?? 0;
  useEffect(() => {
    const t = window.setTimeout(load, entries === null ? 0 : 200);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, count, lastEventId]);

  async function add() {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    setError(null);
    try {
      const entry = await addComment(task.id, {
        body,
        about_id: about || null,
        ...(when ? { happened_at: new Date(when).toISOString() } : {}),
        meta: META(),
      });
      setEntries((list) =>
        [entry, ...(list ?? []).filter((e) => e.id !== entry.id)].sort((a, b) => b.happened_at.localeCompare(a.happened_at)),
      );
      setText("");
      setWhen("");
    } catch (e) {
      setError((e instanceof ApiError && e.detail) || "Couldn’t add that.");
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    e.stopPropagation();
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      add();
    }
  }

  const ownerChoices = [...shortlist, ...others];
  // Sound clips and videos attached to the task sit in the log at the moment
  // they were attached, so they play where the conversation is.
  const items = [
    ...(entries ?? []).map((entry) => ({ entry, at: entry.happened_at })),
    ...task.attachments.filter(isClip).map((clip) => ({ clip, at: clip.created_at })),
  ].sort((a, b) => b.at.localeCompare(a.at));

  return (
    <section className="task-log" aria-labelledby="log-title">
      <div className="attachments-bar">
        <h3 id="log-title">
          Log {count > 0 && <span className="history-count">{count}</span>}
        </h3>
      </div>
      <div className="log-add">
        <textarea
          value={text}
          rows={2}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Add a note: a call, an update, what was agreed…"
          aria-label="New log entry"
        />
        <WhenControl value={when} onChange={setWhen} />
        <div className="log-add-row">
          <select value={about} onChange={(e) => setAbout(e.target.value)} aria-label="About or with">
            <option value="">No one in particular</option>
            {shortlist.length > 0 && (
              <optgroup label="On this board">
                {shortlist.map((o) => (
                  <option key={o.id} value={o.id}>
                    with {o.name}
                  </option>
                ))}
              </optgroup>
            )}
            {others.length > 0 && (
              <optgroup label="Everyone else">
                {others.map((o) => (
                  <option key={o.id} value={o.id}>
                    with {o.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          <button type="button" className="primary" disabled={busy || !text.trim()} onClick={add} title="Add (⌘/Ctrl+Enter)">
            {busy ? "Adding…" : "Add to log"}
          </button>
        </div>
        {error && <p className="attach-error">{error}</p>}
      </div>
      {items.length > 0 && (
        <ol className="log-list">
          {items.map((item) =>
            "clip" in item ? (
              <li key={item.clip.id} className="log-entry log-clip">
                <div className="log-meta">
                  <time dateTime={item.at} title={whenLabel(item.at)}>
                    {relativeTime(item.at)}
                  </time>
                  <span className="log-typed">attached {item.clip.data.media === "video" ? "a video" : "a sound clip"}</span>
                </div>
                <MediaClip taskId={task.id} attachment={item.clip} />
              </li>
            ) : (
              <LogEntry key={item.entry.id} entry={item.entry} owners={ownerChoices} onChanged={load} />
            ),
          )}
        </ol>
      )}
    </section>
  );
}

function LogEntry({
  entry,
  owners,
  onChanged,
}: {
  entry: TaskComment;
  owners: ReturnType<typeof useBoardOwners>["shortlist"];
  onChanged: () => void;
}) {
  const ownersById = useBoardStore((s) => s.ownersById);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(entry.body);
  const [about, setAbout] = useState(entry.about_id ?? "");
  const [when, setWhen] = useState(toLocalInput(entry.happened_at));
  const [error, setError] = useState<string | null>(null);
  const owner = entry.about_id ? ownersById[entry.about_id] : undefined;
  // Typed later than it happened (by more than a minute): say so.
  const typedLater = new Date(entry.created_at).getTime() - new Date(entry.happened_at).getTime() > 60_000;

  async function save() {
    try {
      const happened = when ? new Date(when).toISOString() : entry.happened_at;
      await updateComment(entry.id, {
        body: draft,
        about_id: about || null,
        ...(happened !== entry.happened_at ? { happened_at: happened } : {}),
        meta: META(),
      });
      setEditing(false);
      onChanged();
    } catch (e) {
      setError((e instanceof ApiError && e.detail) || "Couldn’t save that.");
    }
  }

  async function remove() {
    try {
      await updateComment(entry.id, { deleted: true, meta: META() });
      onChanged();
      useBoardStore.getState().offerUndo("Removed a log entry", async () => {
        await updateComment(entry.id, { deleted: false, meta: { actor: "board-user" } });
        onChanged();
      });
    } catch {
      setError("Couldn’t remove it.");
    }
  }

  if (editing) {
    return (
      <li className="log-entry is-editing">
        <textarea
          value={draft}
          rows={3}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
            if (e.key === "Escape") setEditing(false);
          }}
          aria-label="Edit log entry"
        />
        <WhenControl value={when} onChange={(v) => setWhen(v || nowLocal())} />
        <div className="log-add-row">
          <select value={about} onChange={(e) => setAbout(e.target.value)} aria-label="About or with">
            <option value="">No one in particular</option>
            {owners.map((o) => (
              <option key={o.id} value={o.id}>
                with {o.name}
              </option>
            ))}
          </select>
          <button type="button" onClick={() => setEditing(false)}>
            Cancel
          </button>
          <button type="button" className="primary" onClick={save}>
            Save
          </button>
        </div>
        {error && <p className="attach-error">{error}</p>}
      </li>
    );
  }

  return (
    <li className="log-entry">
      <div className="log-meta">
        {owner && (
          <span className="log-about">
            <OwnerBadge owner={owner} size="sm" /> {owner.name}
          </span>
        )}
        <time dateTime={entry.happened_at} title={whenLabel(entry.happened_at)}>
          {relativeTime(entry.happened_at)}
        </time>
        {typedLater && <span className="log-typed">logged {relativeTime(entry.created_at)}</span>}
        {entry.edited_at && <span className="log-edited">edited</span>}
        <span className="log-tools">
          <button type="button" className="link-button" onClick={() => setEditing(true)}>
            Edit
          </button>
          <button type="button" className="link-button log-remove" onClick={remove}>
            Remove
          </button>
        </span>
      </div>
      <p className="log-body">{entry.body}</p>
      {error && <p className="attach-error">{error}</p>}
    </li>
  );
}
