import { useDroppable } from "@dnd-kit/core";
import { LaneTotals } from "./Figures";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { AnimatePresence, motion } from "motion/react";
import { useMemo, useState, type CSSProperties, type FormEvent } from "react";
import { archiveLane, createTask } from "../api/client";
import { restoreAll } from "../lib/undo";
import { newOpId } from "../lib/compat";
import { focusOrder } from "../lib/focus";
import { filtersActive, passesFilters } from "../lib/filters";
import { useBoardStore } from "../store/boardStore";
import type { Lane, Task } from "../types";
import TaskCard from "./TaskCard";

const NO_IDS: string[] = [];

/** Focus mode shows a temporary order, so cards don't make room for a
 * within-lane reorder while dragging. */
const noReorder = () => null;

/** Is it a subtask whose parent (or any ancestor) keeps its subtasks off
 * the board? Not while that ancestor is in focus. */
export function hiddenUnderParent(task: Task, tasksById: Record<string, Task>, focusTaskId: string | null): boolean {
  const seen = new Set<string>();
  let parentId = task.parent_id;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = tasksById[parentId];
    if (!parent) return false;
    if (parent.hide_subtasks && parent.id !== focusTaskId) return true;
    parentId = parent.parent_id;
  }
  return false;
}

export default function LaneColumn({ lane }: { lane: Lane }) {
  const allIds = useBoardStore((s) => s.taskIdsByLane[lane.id]) ?? NO_IDS;
  const focusTaskId = useBoardStore((s) => s.focusTaskId);
  const tasksById = useBoardStore((s) => s.tasksById);
  const ownerFilter = useBoardStore((s) => s.ownerFilter);
  const ownersById = useBoardStore((s) => s.ownersById);
  const categoryFilter = useBoardStore((s) => s.categoryFilter);
  const categoriesById = useBoardStore((s) => s.categoriesById);
  // Filters hide cards, and so does a parent set to keep its subtasks off
  // the board; stored order and counts are untouched.
  const ids = useMemo(() => {
    const f = { ownerFilter, ownersById, categoryFilter, categoriesById };
    const filtering = filtersActive(f);
    return allIds.filter((id) => {
      const task = tasksById[id];
      if (!task) return false;
      if (hiddenUnderParent(task, tasksById, focusTaskId)) return false;
      return !filtering || passesFilters(task, f);
    });
  }, [allIds, ownerFilter, ownersById, categoryFilter, categoriesById, tasksById, focusTaskId]);
  const underParents = useMemo(
    () => allIds.filter((id) => tasksById[id] && hiddenUnderParent(tasksById[id], tasksById, focusTaskId)).length,
    [allIds, tasksById, focusTaskId],
  );
  // In focus mode the focus group rises to the top, above a divider.
  const { group, rest } = useMemo(
    () => focusOrder(ids, focusTaskId, tasksById),
    [ids, focusTaskId, tasksById],
  );
  const displayed = useMemo(() => [...group, ...rest], [group, rest]);
  const { setNodeRef } = useDroppable({ id: lane.id });
  const blockedBy = useBoardStore((s) =>
    s.dropBlock?.laneId === lane.id ? s.dropBlock.blockers.length : 0,
  );
  const blockReason = useBoardStore((s) =>
    s.dropBlock?.laneId === lane.id ? s.dropBlock.reason : undefined,
  );
  const count = allIds.length;
  const isFinal = lane.is_final;
  const hidden = allIds.length - ids.length;
  const byFilters = hidden - underParents;
  const overLimit = lane.wip_limit !== null && count > lane.wip_limit;

  return (
    <section
      className={`lane${blockedBy || blockReason ? " is-no-drop" : ""}`}
      style={{ "--lane-color": lane.color } as CSSProperties}
      aria-label={lane.name}
    >
      <header className="lane-header">
        <h2>{lane.name}</h2>
        {hidden > 0 && (
          <span
            className="lane-hidden"
            title={[
              byFilters > 0 && `${byFilters} hidden by the filters`,
              underParents > 0 && `${underParents} subtask${underParents > 1 ? "s" : ""} kept on their parent card`,
            ]
              .filter(Boolean)
              .join("; ")}
          >
            {hidden} hidden
          </span>
        )}
        <span
          className={`lane-count${overLimit ? " over-limit" : ""}`}
          title={overLimit ? `Over the WIP limit of ${lane.wip_limit}` : undefined}
        >
          {count}
          {lane.wip_limit !== null && ` / ${lane.wip_limit}`}
        </span>
        {isFinal && count > 0 && <ArchiveAll laneId={lane.id} count={count} hidden={hidden} />}
      </header>
      <LaneTotals laneId={lane.id} isFinal={isFinal} />

      {(blockedBy > 0 || blockReason) && (
        <div className="no-drop-note" role="status">
          <strong>Can’t move here</strong>
          <span>
            {blockReason ??
              `${blockedBy} subtask${blockedBy === 1 ? " hasn’t" : "s haven’t"} got this far yet`}
          </span>
        </div>
      )}

      <SortableContext
        items={displayed}
        strategy={focusTaskId ? noReorder : verticalListSortingStrategy}
      >
        <div ref={setNodeRef} className="lane-body">
          <AnimatePresence initial={false}>
            {group.map((id) => (
              <TaskCard key={id} taskId={id} />
            ))}
            {group.length > 0 && rest.length > 0 && (
              <motion.div
                key="focus-divider"
                className="focus-divider"
                role="separator"
                aria-label="Tasks outside the focus"
                layout
                initial={{ opacity: 0, scaleX: 0.6 }}
                animate={{ opacity: 1, scaleX: 1 }}
                exit={{ opacity: 0, scaleX: 0.6 }}
                transition={{ duration: 0.25 }}
              >
                <span>other tasks</span>
              </motion.div>
            )}
            {rest.map((id) => (
              <TaskCard key={id} taskId={id} />
            ))}
          </AnimatePresence>
        </div>
      </SortableContext>

      <AddTask laneId={lane.id} />
    </section>
  );
}

function AddTask({ laneId }: { laneId: string }) {
  const boardId = useBoardStore((s) => s.board?.id);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = title.trim();
    if (!trimmed || !boardId) return;
    setTitle("");
    const opId = newOpId();
    const store = useBoardStore.getState();
    store.registerOp(opId);
    try {
      const task = await createTask(boardId, {
        lane_id: laneId,
        title: trimmed,
        meta: { op_id: opId, actor: "board-user" },
      });
      // The websocket echo is suppressed by op_id, so add it ourselves.
      useBoardStore.getState().upsertTask(task);
    } catch {
      useBoardStore.getState().resolveOp(opId);
    }
  }

  if (!open) {
    return (
      <button type="button" className="add-task-button" onClick={() => setOpen(true)}>
        + Add task
      </button>
    );
  }

  return (
    <form className="add-task-form" onSubmit={submit}>
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => !title.trim() && setOpen(false)}
        onKeyDown={(e) => e.key === "Escape" && (setTitle(""), setOpen(false))}
        placeholder="Task title, then Enter"
        aria-label={`New task title`}
      />
    </form>
  );
}

/** The final lane's sweep: archive everything in it, after a confirm. */
function ArchiveAll({ laneId, count, hidden }: { laneId: string; count: number; hidden: number }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    try {
      const { archived } = await archiveLane(laneId, { actor: "board-user" });
      const store = useBoardStore.getState();
      for (const id of archived) store.removeTask(id);
      if (archived.length) {
        store.offerUndo(`Archived ${archived.length} task${archived.length === 1 ? "" : "s"}`, () => restoreAll(archived));
      }
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  if (!confirming) {
    return (
      <button
        type="button"
        className="lane-sweep"
        onClick={() => setConfirming(true)}
        title="Archive every task in this lane"
      >
        Archive all
      </button>
    );
  }
  return (
    <span className="lane-sweep-confirm" onKeyDown={(e) => e.key === "Escape" && setConfirming(false)}>
      <button type="button" className="lane-sweep is-confirm" onClick={run} disabled={busy} autoFocus>
        {busy ? "Archiving…" : `Archive ${count}${hidden ? ` (${hidden} hidden)` : ""}?`}
      </button>
      <button type="button" className="lane-sweep" onClick={() => setConfirming(false)} aria-label="Cancel">
        ×
      </button>
    </span>
  );
}
