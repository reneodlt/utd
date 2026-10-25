import { lazy, Suspense, useMemo, useState } from "react";
import { renderMarkdown } from "../lib/markdown";
import type { Task } from "../types";

const DetailsEditor = lazy(() => import("./DetailsEditor"));

/** The card drawer's details: rendered Markdown; tap to edit in a rich
 * editor, or switch to the Markdown source. Stored as Markdown. */
export default function TaskDetails({ task }: { task: Task }) {
  const [editing, setEditing] = useState(false);
  const html = useMemo(() => renderMarkdown(task.description), [task.description]);

  if (editing) {
    return (
      <Suspense fallback={<p className="details-loading">Opening the editor…</p>}>
        <DetailsEditor task={task} onDone={() => setEditing(false)} />
      </Suspense>
    );
  }
  return (
    <section className="details" aria-label="Details">
      {task.description.trim() ? (
        <div
          className="prose details-view"
          role="button"
          tabIndex={0}
          title="Edit details"
          // Links inside open normally; anywhere else starts editing.
          onClick={(e) => !(e.target as HTMLElement).closest("a") && setEditing(true)}
          onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && setEditing(true)}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <button type="button" className="details-empty" onClick={() => setEditing(true)}>
          Add details: notes, checklists, links…
        </button>
      )}
    </section>
  );
}

