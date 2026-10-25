import { useCallback, useEffect, useState } from "react";
import { deleteTask, getOffBoardTasks, restoreTask } from "../api/client";
import { copyText, newOpId } from "../lib/compat";
import { filtersActive, passesFilters } from "../lib/filters";
import { binToArchive, quote, sendBack } from "../lib/undo";
import { relativeTime } from "../lib/history";
import { useBoardStore } from "../store/boardStore";
import type { BoardView, Task } from "../types";
import { OwnerStack } from "./Owners";
import { RowMenu, RowMenuButton, type RowMenuState } from "./RowMenu";

const VIEWS: { value: BoardView; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "archived", label: "Archived" },
  { value: "deleted", label: "Deleted" },
  { value: "today", label: "Today" },
];

/** Header switch between the board and its archive / bin. */
export function ViewSwitch() {
  const view = useBoardStore((s) => s.view);
  const setView = useBoardStore((s) => s.setView);
  // A Map view once the board can place tasks (a location category).
  const hasPlaces = useBoardStore((s) =>
    Object.values(s.categoriesById).some((c) => !c.archived && c.value_type === "location"),
  );
  const views = hasPlaces ? [...VIEWS, { value: "map" as const, label: "Map" }] : VIEWS;
  return (
    <div className="segmented view-switch" role="group" aria-label="Show tasks">
      {views.map((v) => (
        <button key={v.value} type="button" aria-pressed={view === v.value} onClick={() => setView(v.value)}>
          {v.label}
        </button>
      ))}
    </div>
  );
}

interface ListState {
  tasks: Task[];
  count: number;
  status: "loading" | "ready" | "error";
}

/** The archived or deleted tasks, newest first, with restore (and, for
 * the archive, delete). Nothing is ever destroyed from here. */
export function OffBoardList({ state }: { state: "archived" | "deleted" }) {
  const boardId = useBoardStore((s) => s.board?.id);
  const lanes = useBoardStore((s) => s.lanes);
  const lastEventId = useBoardStore((s) => s.lastEventId);
  const ownerFilter = useBoardStore((s) => s.ownerFilter);
  const ownersById = useBoardStore((s) => s.ownersById);
  const categoryFilter = useBoardStore((s) => s.categoryFilter);
  const categoriesById = useBoardStore((s) => s.categoriesById);
  const filters = { ownerFilter, ownersById, categoryFilter, categoriesById };
  const openDetail = useBoardStore((s) => s.openDetail);
  const [list, setList] = useState<ListState>({ tasks: [], count: 0, status: "loading" });
  const [busy, setBusy] = useState<Record<string, true>>({});
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<RowMenuState<Task> | null>(null);

  const load = useCallback(async () => {
    if (!boardId) return;
    try {
      const page = await getOffBoardTasks(boardId, state);
      setList({ tasks: page.results, count: page.count, status: "ready" });
    } catch {
      setList((l) => ({ ...l, status: l.tasks.length ? "ready" : "error" }));
    }
  }, [boardId, state]);

  // Any board event may add to or take from this list (someone archives,
  // restores...): refetch, debounced.
  useEffect(() => {
    const timer = window.setTimeout(load, 200);
    return () => window.clearTimeout(timer);
  }, [load, lastEventId]);

  async function act(task: Task, run: typeof restoreTask) {
    setBusy((b) => ({ ...b, [task.id]: true }));
    const store = useBoardStore.getState();
    const opId = newOpId();
    store.registerOp(opId);
    try {
      const updated = await run(task.id, { op_id: opId, actor: "board-user" });
      if (!updated.archived_at) useBoardStore.getState().upsertTask(updated);
      setList((l) => ({ ...l, tasks: l.tasks.filter((t) => t.id !== task.id), count: l.count - 1 }));
      // Undo puts it back where it was listed: the archive or the bin.
      useBoardStore
        .getState()
        .offerUndo(
          `${run === restoreTask ? "Restored" : "Deleted"} ${quote(task.title)}`,
          run === restoreTask ? () => sendBack(task.id, state) : () => binToArchive(task.id).then(load),
        );
    } catch {
      useBoardStore.getState().resolveOp(opId);
    } finally {
      setBusy((b) => {
        const next = { ...b };
        delete next[task.id];
        return next;
      });
    }
  }

  const q = query.trim().toLowerCase();
  const shown = list.tasks.filter(
    (t) => passesFilters(t, filters) && (!q || t.title.toLowerCase().includes(q)),
  );
  const noun = state === "archived" ? "archived" : "deleted";

  return (
    <main className="offboard">
      <div className="offboard-bar">
        <h2>
          {state === "archived" ? "Archived tasks" : "Deleted tasks"}
          <span className="history-count">{list.count}</span>
        </h2>
        <input
          className="offboard-search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search ${noun} tasks`}
          aria-label={`Search ${noun} tasks`}
        />
      </div>
      <p className="offboard-note">
        {state === "archived"
          ? "Done with but kept for reference. Restore puts a task back at the bottom of the lane it left."
          : "The bin. Nothing here is gone for good: restore puts a task back on the board."}
        {filtersActive(filters) && " The board’s filters apply here too."}
      </p>

      {list.status === "loading" && <p className="history-empty">Loading…</p>}
      {list.status === "error" && (
        <p className="history-empty">
          Couldn’t load them.{" "}
          <button type="button" className="link-button" onClick={load}>
            Try again
          </button>
        </p>
      )}
      {list.status === "ready" && shown.length === 0 && (
        <p className="offboard-empty">
          {list.tasks.length === 0 ? `No ${noun} tasks.` : "Nothing matches."}
        </p>
      )}

      {shown.length > 0 && (
        <ul className="offboard-list">
          {shown.map((task) => {
            const lane = lanes.find((l) => l.id === task.lane_id);
            const when = state === "archived" ? task.archived_at : task.deleted_at;
            return (
              <li
                key={task.id}
                className="offboard-row"
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ item: task, x: e.clientX, y: e.clientY });
                }}
              >
                <span className="offboard-lane" style={{ background: lane?.color ?? "var(--faint)" }} />
                <button type="button" className="offboard-title" onClick={() => openDetail(task.id)}>
                  {task.title}
                </button>
                <span className="offboard-meta">
                  from {lane?.name ?? "a removed lane"}
                  {when && ` · ${noun} ${relativeTime(when)}`}
                </span>
                <span className="offboard-owners">
                  <OwnerStack task={task} interactive={false} />
                </span>
                <span className="offboard-actions">
                  <button type="button" disabled={!!busy[task.id]} onClick={() => act(task, restoreTask)}>
                    Restore
                  </button>
                  {state === "archived" && (
                    <button
                      type="button"
                      className="offboard-delete"
                      disabled={!!busy[task.id]}
                      onClick={() => act(task, deleteTask)}
                    >
                      Delete
                    </button>
                  )}
                  <RowMenuButton label={task.title} onOpen={(x, y) => setMenu({ item: task, x, y })} />
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {menu && (
        <RowMenu
          x={menu.x}
          y={menu.y}
          title={menu.item.title}
          id={menu.item.id}
          onClose={() => setMenu(null)}
          items={[
            { label: "Details & history", onSelect: () => openDetail(menu.item.id) },
            "divider",
            {
              label: "Restore",
              hint: `back to ${lanes.find((l) => l.id === menu.item.lane_id)?.name ?? "the board"}`,
              disabled: !!busy[menu.item.id],
              onSelect: () => act(menu.item, restoreTask),
            },
            ...(state === "archived"
              ? [
                  {
                    label: "Delete task",
                    hint: "restorable from Deleted",
                    danger: true,
                    disabled: !!busy[menu.item.id],
                    onSelect: () => act(menu.item, deleteTask),
                  },
                ]
              : []),
            "divider",
            { label: "Copy task ID", onSelect: () => copyText(menu.item.id) },
          ]}
        />
      )}
      {list.count > list.tasks.length && (
        <p className="offboard-note">Showing the newest {list.tasks.length} of {list.count}.</p>
      )}
    </main>
  );
}
