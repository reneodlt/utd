import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getTaskHistory } from "../api/client";
import { copyText } from "../lib/compat";
import {
  dayLabel,
  describeActor,
  describeCause,
  describeEvent,
  makeTitleOf,
  relativeTime,
  type ActorKind,
} from "../lib/history";
import { useBoardStore } from "../store/boardStore";
import type { RelatedTask, Task, TaskEventRecord } from "../types";
import { AttachmentsSection } from "./Attachments";
import { DueDateField } from "./ColourBy";
import { TaskCategories } from "./Categories";
import { OwnerStack } from "./Owners";
import EditableTitle from "./EditableTitle";
import TaskDetails from "./TaskDetails";
import { FlowEditor } from "./FlowEditor";
import { TaskLog } from "./TaskLog";
import { TaskOwnerContacts } from "./OwnerContacts";
import { OwnerLog, ParentOptions } from "./Ownership";
import { MoveToBoardPicker } from "./MoveToBoard";
import { doneLaneFor, markDone, useUnfinishedSubtasks } from "../lib/planning";
import { RollupSummary, TaskFigures } from "./Figures";
import { formatValue } from "../lib/measures";
import { useHoursPerDay } from "../lib/rollup";
import { TaskLinks } from "./TaskLinks";
import { Ancestry, SubtaskTree } from "./TaskTree";

type Filter = "all" | "people" | "automation";

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "people", label: "People & API" },
  { value: "automation", label: "Automation" },
];

const AUTOMATION: ActorKind[] = ["rule", "automatic"];

const NO_CHILDREN: string[] = [];

/** Side drawer for one card: what it is now, and everything that happened
 * to it, by whom, and why. Opened by clicking a card or from its menu. */
export default function CardDrawer() {
  const taskId = useBoardStore((s) => s.detailTaskId);
  if (!taskId) return null;
  return <Drawer key={taskId} taskId={taskId} />;
}

interface HistoryState {
  events: TaskEventRecord[];
  related: Record<string, RelatedTask>;
  total: number;
  status: "loading" | "ready" | "error";
}

function mergeEvents(current: TaskEventRecord[], incoming: TaskEventRecord[]) {
  const byId = new Map(current.map((e) => [e.id, e]));
  for (const event of incoming) byId.set(event.id, event);
  return [...byId.values()].sort((a, b) => b.id - a.id);
}

/** The task's board; click to move it (and its subtasks) to another. */
function BoardButton({ task }: { task: Task }) {
  const name = useBoardStore((s) =>
    task.board_id === s.board?.id ? s.board?.name : (s.familyById[task.board_id]?.name ?? "Board"),
  );
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  return (
    <>
      <button
        type="button"
        className="drawer-board"
        title="Move to another board"
        onClick={(e) => setAnchor(e.currentTarget.getBoundingClientRect())}
      >
        {name} ▾
      </button>
      {anchor && <MoveToBoardPicker task={task} anchor={anchor} onClose={() => setAnchor(null)} />}
    </>
  );
}

/** "✓ Done": straight to the board's final lane (with undo). */
function DoneButton({ taskId }: { taskId: string }) {
  const doneLane = useBoardStore(() => doneLaneFor(taskId));
  const inDoneLane = useBoardStore((s) => {
    const task = s.tasksById[taskId];
    return !!s.lanes.find((l) => l.id === task?.lane_id)?.is_final;
  });
  const unfinished = useUnfinishedSubtasks(taskId);
  if (!doneLane || inDoneLane) return null;
  return (
    <button
      type="button"
      className="drawer-focus drawer-done"
      disabled={unfinished > 0}
      onClick={() => markDone(taskId)}
      title={
        unfinished > 0
          ? `Finish its ${unfinished} open subtask${unfinished > 1 ? "s" : ""} first`
          : `Move to ${doneLane.name}`
      }
    >
      ✓ Done
    </button>
  );
}

function Drawer({ taskId }: { taskId: string }) {
  const closeDetail = useBoardStore((s) => s.closeDetail);
  const focused = useBoardStore((s) => s.focusTaskId === taskId);
  const setFocus = useBoardStore((s) => s.setFocus);
  const task = useBoardStore((s) => s.tasksById[taskId]);
  const tasksById = useBoardStore((s) => s.tasksById);
  const lanes = useBoardStore((s) => s.lanes);
  // Joined to a string: childrenByParent is rebuilt on every board event,
  // and only a real change in this card's subtasks should refetch.
  const childKey = useBoardStore((s) => (s.childrenByParent[taskId] ?? NO_CHILDREN).join());
  const childCount = useBoardStore((s) => s.childrenByParent[taskId]?.length ?? 0);
  useBoardStore((s) => s.tick); // keep "5m ago" current

  const [history, setHistory] = useState<HistoryState>({
    events: [],
    related: {},
    total: 0,
    status: "loading",
  });
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [showReorders, setShowReorders] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Newest page. Merged rather than replaced so older pages stay loaded.
  const refresh = useCallback(async () => {
    try {
      const page = await getTaskHistory(taskId);
      setHistory((h) => ({
        events: mergeEvents(h.events, page.results),
        related: { ...h.related, ...page.related_tasks },
        total: page.count,
        status: "ready",
      }));
    } catch {
      setHistory((h) => ({ ...h, status: h.events.length ? "ready" : "error" }));
    }
  }, [taskId]);

  // Refetch whenever this card or its set of subtasks changes: every
  // broadcast for the card replaces its task object in the store.
  useEffect(() => {
    const timer = window.setTimeout(refresh, 250);
    return () => window.clearTimeout(timer);
  }, [refresh, task, childKey]);

  async function loadOlder() {
    setLoadingOlder(true);
    try {
      const page = await getTaskHistory(taskId, history.events.length);
      setHistory((h) => ({
        ...h,
        events: mergeEvents(h.events, page.results),
        related: { ...h.related, ...page.related_tasks },
        total: page.count,
      }));
    } finally {
      setLoadingOlder(false);
    }
  }

  // Focus the drawer on open, hand focus back on close, Escape closes.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeDetail();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      opener?.focus?.();
    };
  }, [closeDetail]);

  const titleOf = useMemo(
    () => makeTitleOf(taskId, history.related, tasksById),
    [taskId, history.related, tasksById],
  );

  const reorderCount = history.events.filter(
    (e) => e.event_type === "task.moved" && e.from_lane_id === e.to_lane_id,
  ).length;

  const visible = history.events.filter((event) => {
    if (!showReorders && event.event_type === "task.moved" && event.from_lane_id === event.to_lane_id) {
      return false;
    }
    if (filter === "all") return true;
    const automated = AUTOMATION.includes(describeActor(event.actor, event.source).kind);
    return filter === "automation" ? automated : !automated;
  });

  const days: { label: string; events: TaskEventRecord[] }[] = [];
  for (const event of visible) {
    const label = dayLabel(event.created_at);
    const last = days[days.length - 1];
    if (last?.label === label) last.events.push(event);
    else days.push({ label, events: [event] });
  }

  const title = task?.title ?? history.related[taskId]?.title ?? "Card";
  const lane = task ? lanes.find((l) => l.id === task.lane_id) : undefined;
  const archived = !task && history.status === "ready";
  const parentId = task?.parent_id ?? history.related[taskId]?.parent_id;
  const hasMore = history.events.length < history.total;

  return (
    <>
      <div className="drawer-backdrop" onPointerDown={closeDetail} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title">
        <header className="drawer-header">
          <div className="drawer-heading">
            <span className="eyebrow">
              {lane && (
                <span className="drawer-lane">
                  <span className="subtask-dot" style={{ background: lane.color }} />
                  {lane.name}
                </span>
              )}
              {archived && <span className="drawer-lane">archived</span>}
              {task && !archived && <BoardButton task={task} />}
              <button
                type="button"
                className="drawer-id"
                title="Copy task ID"
                onClick={() => copyText(taskId)}
              >
                {taskId.slice(0, 8)}
              </button>
            </span>
            <Ancestry task={task} parentId={parentId} titleOf={titleOf} />
            {task ? <EditableTitle key={task.id} task={task} /> : <h2 id="drawer-title">{title}</h2>}
          </div>
          {task && (
            <div className="drawer-owners">
              <OwnerStack task={task} />
            </div>
          )}
          {task && <DoneButton taskId={task.id} />}
          {task && (
            <button
              type="button"
              className={`drawer-focus${focused ? " is-on" : ""}`}
              aria-pressed={focused}
              onClick={() => setFocus(focused ? null : taskId)}
              title={focused ? "Leave focus" : "Focus on this task and its subtasks"}
            >
              {focused ? "◉ In focus" : "◎ Focus"}
            </button>
          )}
          <button
            ref={closeRef}
            type="button"
            className="drawer-close"
            onClick={closeDetail}
            aria-label="Close card details"
          >
            ×
          </button>
        </header>

        <div className="drawer-scroll">
          {task && (
            <div className="drawer-categories">
              <TaskCategories task={task} addButton />
            </div>
          )}
          {task && <TaskOwnerContacts task={task} />}
          {task && <TaskFigures task={task} />}
          {task && <DueDateField task={task} />}
          {task && task.blocked_by.length > 0 && (
            <section className="drawer-about">
              {task && task.blocked_by.length > 0 && (
                <p className="drawer-fact drawer-fact-blocked">
                  Blocked by {task.blocked_by.map((id) => titleOf(id)).join(", ")}
                </p>
              )}
            </section>
          )}

          {task && <TaskDetails key={task.id} task={task} />}

          {task && <TaskLog key={`log-${task.id}`} task={task} />}

          {task && <SubtaskTree key={`tree-${task.id}`} task={task} />}

          {task && <ParentOptions task={task} />}

          {task && <RollupSummary taskId={task.id} />}

          {task && childCount >= 2 && <FlowEditor key={`flow-${task.id}`} task={task} />}

          {task && <TaskLinks key={`links-${task.id}`} task={task} />}

          {task && <AttachmentsSection task={task} />}

          {task && <OwnerLog key={`owners-${task.id}`} task={task} />}

          <section className="history" aria-labelledby="history-title">
            <div className="history-bar">
              <h3 id="history-title">
                History
                {history.total > 0 && <span className="history-count">{history.total}</span>}
              </h3>
              <div className="segmented" role="group" aria-label="Filter history">
                {FILTERS.map((f) => (
                  <button
                    key={f.value}
                    type="button"
                    aria-pressed={filter === f.value}
                    onClick={() => setFilter(f.value)}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>
            {reorderCount > 0 && (
              <label className="history-toggle">
                <input
                  type="checkbox"
                  checked={showReorders}
                  onChange={(e) => setShowReorders(e.target.checked)}
                />
                Show {reorderCount} reorder{reorderCount > 1 ? "s" : ""} within a lane
              </label>
            )}

            {history.status === "loading" && <p className="history-empty">Loading history…</p>}
            {history.status === "error" && (
              <p className="history-empty">
                Couldn’t load the history.{" "}
                <button type="button" className="link-button" onClick={refresh}>
                  Try again
                </button>
              </p>
            )}
            {history.status === "ready" && visible.length === 0 && (
              <p className="history-empty">Nothing matches this filter.</p>
            )}

            {days.map((day) => (
              <div key={day.label} className="history-day">
                <h4>{day.label}</h4>
                <ol>
                  {day.events.map((event) => (
                    <HistoryRow key={event.id} event={event} taskId={taskId} titleOf={titleOf} />
                  ))}
                </ol>
              </div>
            ))}

            {hasMore && history.status === "ready" && (
              <button
                type="button"
                className="history-more"
                onClick={loadOlder}
                disabled={loadingOlder}
              >
                {loadingOlder ? "Loading…" : `Load older (${history.total - history.events.length} more)`}
              </button>
            )}
          </section>
        </div>
      </aside>
    </>
  );
}

function HistoryRow({
  event,
  taskId,
  titleOf,
}: {
  event: TaskEventRecord;
  taskId: string;
  titleOf: ReturnType<typeof makeTitleOf>;
}) {
  const actor = describeActor(event.actor, event.source);
  const ownersById = useBoardStore((s) => s.ownersById);
  const categoriesById = useBoardStore((s) => s.categoriesById);
  const hoursPerDay = useHoursPerDay();
  const line = describeEvent(event, taskId, titleOf, {
    owner: (id) => ownersById[id]?.name ?? "a removed owner",
    category: (id) => categoriesById[id]?.name ?? "a removed category",
    figure: (id, amount, type) => {
      const category = categoriesById[id];
      return category?.value_type === type ? formatValue(category, Number(amount), hoursPerDay) : amount;
    },
  });
  const cause = describeCause(event, titleOf);
  const when = new Date(event.created_at);
  return (
    <li className={`history-row history-${line.kind}`}>
      <span className="history-marker" aria-hidden="true" />
      <div className="history-main">
        <p className="history-text">
          <span className={`actor actor-${actor.kind}`}>
            {actor.name}
            <span className="actor-kind">{actor.label}</span>
          </span>{" "}
          {line.text}
          {event.animation && <span className="history-animation">{event.animation}</span>}
        </p>
        {cause && <p className="history-cause">{cause}</p>}
        {line.details.length > 0 && (
          <details className="history-details">
            <summary>Show change</summary>
            {line.details.map((d) => (
              <div key={d.field} className="change">
                <span className="change-field">{d.field}</span>
                {d.from && <pre className="change-from">{d.from}</pre>}
                <pre className="change-to">{d.to}</pre>
              </div>
            ))}
          </details>
        )}
      </div>
      <time
        className="history-time"
        dateTime={event.created_at}
        title={`${when.toLocaleString()} · event #${event.id}${event.op_id ? ` · op ${event.op_id}` : ""}`}
      >
        {relativeTime(event.created_at)}
      </time>
    </li>
  );
}
