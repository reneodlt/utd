import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { archiveTask, deleteTask, getAgenda, moveTask, restoreTask, setTaskDueDate, type AgendaTask } from "../api/client";
import { copyText } from "../lib/compat";
import { dueLabel } from "../lib/cardColour";
import { passesOwnerFilter } from "../lib/owners";
import { navigateToTask } from "../lib/route";
import { quote } from "../lib/undo";
import { useBoardStore } from "../store/boardStore";
import { OwnerBadge } from "./Owners";
import { RowMenu, RowMenuButton, type RowMenuItem, type RowMenuState } from "./RowMenu";

const DAYS_AHEAD = 7;
const REFRESH_MS = 60_000;

function localIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

type Group = { key: string; title: string; tasks: AgendaTask[] };

function groupTasks(tasks: AgendaTask[], today: string): Group[] {
  const t = new Date(`${today}T00:00`);
  const tomorrow = localIso(new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1));
  const groups: Group[] = [
    { key: "overdue", title: "Overdue", tasks: [] },
    { key: "today", title: "Today", tasks: [] },
    { key: "tomorrow", title: "Tomorrow", tasks: [] },
    { key: "soon", title: `Next ${DAYS_AHEAD} days`, tasks: [] },
  ];
  for (const task of tasks) {
    const due = task.due_date!;
    const g = due < today ? 0 : due === today ? 1 : due === tomorrow ? 2 : 3;
    groups[g].tasks.push(task);
  }
  return groups.filter((g) => g.tasks.length > 0);
}

/** Every board's unfinished tasks due soon, in one list: overdue, today,
 * tomorrow, the week ahead. Tick one off (into its board's done lane),
 * or open it. */
export default function AgendaView() {
  const lastEventId = useBoardStore((s) => s.lastEventId);
  const ownerFilter = useBoardStore((s) => s.ownerFilter);
  const ownersById = useBoardStore((s) => s.ownersById);
  const [tasks, setTasks] = useState<AgendaTask[] | null>(null);
  const [today, setToday] = useState(localIso(new Date()));
  const [error, setError] = useState(false);
  const [menu, setMenu] = useState<RowMenuState<AgendaTask> | null>(null);

  const load = useCallback(async () => {
    const now = localIso(new Date());
    try {
      const r = await getAgenda(now, DAYS_AHEAD);
      setTasks(r.tasks);
      setToday(now);
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  // Refresh on board events, coming back to the app, and every minute
  // (other boards' changes don't reach this board's live feed).
  useEffect(() => {
    const t = window.setTimeout(load, 150);
    return () => window.clearTimeout(t);
  }, [load, lastEventId]);
  useEffect(() => {
    const onVisible = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onVisible);
    const timer = window.setInterval(load, REFRESH_MS);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(timer);
    };
  }, [load]);

  async function tick(task: AgendaTask) {
    if (!task.done_lane_id) return;
    setTasks((list) => list?.filter((t) => t.id !== task.id) ?? null);
    try {
      await moveTask(task.id, { to_lane_id: task.done_lane_id, index: null, meta: { actor: "board-user" } });
      useBoardStore.getState().offerUndo(`Done: ${quote(task.title)}`, async () => {
        await moveTask(task.id, { to_lane_id: task.lane_id, index: null, meta: { actor: "board-user" } });
        await load();
      });
    } catch {
      load();
    }
  }

  /** Run a change, then refresh; undo runs `back` and refreshes too. */
  async function change(task: AgendaTask, label: string, run: () => Promise<unknown>, back: () => Promise<unknown>) {
    setTasks((list) => list?.filter((t) => t.id !== task.id) ?? null);
    try {
      await run();
      useBoardStore.getState().offerUndo(`${label} ${quote(task.title)}`, async () => {
        await back();
        await load();
      });
    } finally {
      load();
    }
  }

  function menuItems(task: AgendaTask): (RowMenuItem | "divider")[] {
    const meta = { actor: "board-user" };
    const isToday = task.due_date === today;
    return [
      { label: "Details & history", onSelect: () => open(task) },
      "divider",
      ...(task.done_lane_id ? [{ label: "Done", hint: "to the final lane", onSelect: () => tick(task) }] : []),
      isToday
        ? {
            label: "Remove from Today",
            hint: "clears the deadline",
            onSelect: () =>
              change(task, "Removed from Today:", () => setTaskDueDate(task.id, null, meta), () =>
                setTaskDueDate(task.id, task.due_date, meta),
              ),
          }
        : {
            label: "Move to Today",
            hint: `was ${dueLabel(task.due_date!).toLowerCase()}`,
            onSelect: () =>
              change(task, "Moved to Today:", () => setTaskDueDate(task.id, today, meta), () =>
                setTaskDueDate(task.id, task.due_date, meta),
              ),
          },
      "divider",
      {
        label: "Archive task",
        hint: "keep for reference",
        onSelect: () => change(task, "Archived", () => archiveTask(task.id, meta), () => restoreTask(task.id, meta)),
      },
      {
        label: "Delete task",
        hint: "restorable from Deleted",
        danger: true,
        onSelect: () => change(task, "Deleted", () => deleteTask(task.id, meta), () => restoreTask(task.id, meta)),
      },
      "divider",
      { label: "Copy task ID", onSelect: () => copyText(task.id) },
    ];
  }

  function open(task: AgendaTask) {
    const s = useBoardStore.getState();
    const here = task.board.id === s.board?.id || task.board.id in s.familyById;
    if (here) s.openDetail(task.id);
    else navigateToTask(task.board.slug, task.id);
  }

  const visible = (tasks ?? []).filter((t) => passesOwnerFilter(t, ownerFilter, ownersById));
  const groups = groupTasks(visible, today);

  return (
    <main className="offboard agenda">
      <div className="offboard-bar">
        <h2>
          Today &amp; this week <span className="history-count">{visible.length}</span>
        </h2>
      </div>
      <p className="offboard-note">
        Unfinished tasks with deadlines, from every board.
        {ownerFilter.length > 0 && " The owner filter applies here too."}
      </p>
      {tasks === null && !error && <p className="history-empty">Loading…</p>}
      {error && (
        <p className="history-empty">
          Couldn’t load the agenda.{" "}
          <button type="button" className="link-button" onClick={load}>
            Try again
          </button>
        </p>
      )}
      {tasks !== null && groups.length === 0 && (
        <p className="offboard-empty">Nothing due in the next {DAYS_AHEAD} days. Enjoy.</p>
      )}
      {groups.map((g) => (
        <section key={g.key} className={`agenda-group agenda-${g.key}`}>
          <h3>
            {g.title} <span className="history-count">{g.tasks.length}</span>
          </h3>
          <ul className="offboard-list">
            {g.tasks.map((task) => (
              <li
                key={task.id}
                className="agenda-row"
                style={{ "--lane-color": task.lane.color } as CSSProperties}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ item: task, x: e.clientX, y: e.clientY });
                }}
              >
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={false}
                  aria-label={`Mark ${task.title} done`}
                  className="subtask-check"
                  disabled={!task.done_lane_id}
                  title={task.done_lane_id ? "Done" : "This board has no final lane"}
                  onClick={() => tick(task)}
                />
                <button type="button" className="agenda-main" onClick={() => open(task)}>
                  <span className="agenda-title">{task.title}</span>
                  <span className="agenda-sub">
                    {task.parent_title && <>↳ {task.parent_title} · </>}
                    {task.board.name} · <span className="subtask-dot" style={{ background: task.lane.color }} /> {task.lane.name}
                  </span>
                </button>
                <span className="agenda-owners">
                  {task.owner_ids
                    .map((id) => ownersById[id])
                    .filter((o) => o && !o.archived)
                    .slice(0, 3)
                    .map((o) => (
                      <OwnerBadge key={o.id} owner={o} size="sm" />
                    ))}
                </span>
                <span className={`badge badge-due due-${g.key === "soon" ? "later" : g.key === "tomorrow" ? "soon" : g.key}`}>
                  {dueLabel(task.due_date!)}
                </span>
                <RowMenuButton label={task.title} onOpen={(x, y) => setMenu({ item: task, x, y })} />
              </li>
            ))}
          </ul>
        </section>
      ))}
      {menu && (
        <RowMenu
          x={menu.x}
          y={menu.y}
          title={menu.item.title}
          id={menu.item.id}
          onClose={() => setMenu(null)}
          items={menuItems(menu.item)}
        />
      )}
    </main>
  );
}
