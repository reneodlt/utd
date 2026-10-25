import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { archiveTask, createTask, deleteTask } from "../api/client";
import { iconOf, pluginFor } from "../attachments/registry";
import { copyText, newOpId } from "../lib/compat";
import { dueLabel, today } from "../lib/cardColour";
import { doneLaneFor, markDone, toggleToday, useUnfinishedSubtasks } from "../lib/planning";
import { quote, restoreAll } from "../lib/undo";
import { useBoardStore } from "../store/boardStore";
import type { Task } from "../types";
import { titleOf } from "./Attachments";
import { MoveToBoardPicker } from "./MoveToBoard";

/** Quick-open entries in the menu; the rest are one click away in the drawer. */
const MENU_ATTACHMENTS = 3;

/** Right-click menu for a card. Context-sensitive: shows the task's git
 * links, blocked state, and subtask entry point. */
export default function TaskContextMenu() {
  const menu = useBoardStore((s) => s.menu);
  const task = useBoardStore((s) => (s.menu ? s.tasksById[s.menu.taskId] : undefined));
  if (!menu || !task) return null;
  return <MenuPanel key={`${menu.taskId}:${menu.x}:${menu.y}`} x={menu.x} y={menu.y} task={task} />;
}

function MenuPanel({ x, y, task }: { x: number; y: number; task: Task }) {
  const closeMenu = useBoardStore((s) => s.closeMenu);
  const openDetail = useBoardStore((s) => s.openDetail);
  const focused = useBoardStore((s) => s.focusTaskId === task.id);
  const setFocus = useBoardStore((s) => s.setFocus);
  const subtaskCount = useBoardStore((s) => s.childrenByParent[task.id]?.length ?? 0);
  const doneLane = useBoardStore(() => doneLaneFor(task.id));
  const inDoneLane = useBoardStore((s) => !!s.lanes.find((l) => l.id === task.lane_id)?.is_final);
  const unfinished = useUnfinishedSubtasks(task.id);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const [mode, setMode] = useState<"menu" | "subtask" | "move">("menu");
  const [title, setTitle] = useState("");

  useLayoutEffect(() => {
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPos({
      left: Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)),
    });
  }, [x, y, mode]);

  useEffect(() => {
    if (mode === "menu") {
      panelRef.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    }
  }, [mode]);

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      closeMenu();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const items = Array.from(
      panelRef.current?.querySelectorAll<HTMLElement>("[role=menuitem]:not(:disabled)") ?? [],
    );
    if (items.length === 0) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    items[(current + step + items.length) % items.length].focus();
  }

  async function submitSubtask(event: FormEvent) {
    event.preventDefault();
    const trimmed = title.trim();
    const board = useBoardStore.getState().board;
    if (!trimmed || !board) return;
    const opId = newOpId();
    useBoardStore.getState().registerOp(opId);
    closeMenu();
    try {
      const created = await createTask(board.id, {
        lane_id: task.lane_id,
        title: trimmed,
        parent_id: task.id,
        meta: { op_id: opId, actor: "board-user" },
      });
      useBoardStore.getState().upsertTask(created);
    } catch {
      useBoardStore.getState().resolveOp(opId);
    }
  }

  async function archive(run: typeof archiveTask | typeof deleteTask = archiveTask) {
    const opId = newOpId();
    useBoardStore.getState().registerOp(opId);
    closeMenu();
    try {
      await run(task.id, { op_id: opId, actor: "board-user" });
      useBoardStore.getState().removeTask(task.id);
      useBoardStore
        .getState()
        .offerUndo(`${run === deleteTask ? "Deleted" : "Archived"} ${quote(task.title)}`, () => restoreAll([task.id]));
    } catch {
      useBoardStore.getState().resolveOp(opId);
    }
  }

  function done() {
    closeMenu();
    markDone(task.id);
  }

  function copyId() {
    copyText(task.id);
    closeMenu();
  }

  if (mode === "move") {
    return <MoveToBoardPicker task={task} anchor={new DOMRect(pos.left, pos.top, 0, 0)} onClose={closeMenu} />;
  }

  return (
    <>
      <div
        className="menu-backdrop"
        onPointerDown={closeMenu}
        onContextMenu={(e) => {
          e.preventDefault();
          closeMenu();
        }}
      />
      <div
        ref={panelRef}
        className="context-menu"
        role="menu"
        aria-label={`Actions for ${task.title}`}
        style={pos}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <header className="menu-header">
          <span className="menu-title">{task.title}</span>
          <span className="menu-id">{task.id.slice(0, 8)}</span>
        </header>
        {task.blocked_by.length > 0 && (
          <p className="menu-note">
            blocked by {task.blocked_by.length} task{task.blocked_by.length > 1 ? "s" : ""}
          </p>
        )}
        {mode === "menu" ? (
          <>
            <button
              type="button"
              role="menuitem"
              className="menu-item"
              onClick={() => openDetail(task.id)}
            >
              Details & history
            </button>
            <button
              type="button"
              role="menuitem"
              className="menu-item"
              onClick={() => setFocus(focused ? null : task.id)}
            >
              {focused ? "Leave focus" : "Focus on this task"}
              {!focused && subtaskCount > 0 && (
                <span className="menu-hint">+ {subtaskCount} subtasks</span>
              )}
            </button>
            <div className="menu-divider" role="separator" />
            <button
              type="button"
              role="menuitem"
              className="menu-item"
              onClick={() => {
                closeMenu();
                toggleToday(task.id);
              }}
            >
              {task.due_date === today() ? "Remove from Today" : "Add to Today"}
              <span className="menu-hint">
                {task.due_date === today()
                  ? "clears the deadline"
                  : task.due_date
                    ? `was ${dueLabel(task.due_date).toLowerCase()}`
                    : "deadline today"}
              </span>
            </button>
            {doneLane && !inDoneLane && (
              <button
                type="button"
                role="menuitem"
                className="menu-item"
                disabled={unfinished > 0}
                onClick={done}
                title={unfinished > 0 ? "Finish its subtasks first" : undefined}
              >
                Done
                <span className="menu-hint">
                  {unfinished > 0
                    ? `${unfinished} subtask${unfinished > 1 ? "s" : ""} not done`
                    : `to ${doneLane.name}`}
                </span>
              </button>
            )}
            <div className="menu-divider" role="separator" />
            <button
              type="button"
              role="menuitem"
              className="menu-item"
              onClick={() => setMode("subtask")}
            >
              Add subtask…
              {subtaskCount > 0 && <span className="menu-hint">{subtaskCount} so far</span>}
            </button>
            <button type="button" role="menuitem" className="menu-item" onClick={() => setMode("move")}>
              Move to board…
              {subtaskCount > 0 && <span className="menu-hint">with its subtasks</span>}
            </button>
            <button type="button" role="menuitem" className="menu-item" onClick={copyId}>
              Copy task ID
            </button>
            <button
              type="button"
              role="menuitem"
              className="menu-item"
              onClick={() => openDetail(task.id)}
            >
              Categories &amp; attachments…
              {task.attachments.length > 0 && (
                <span className="menu-hint">{task.attachments.length} attached</span>
              )}
            </button>
            {task.attachments.slice(0, MENU_ATTACHMENTS).map((a) => {
              const plugin = pluginFor(a.kind);
              const [primary] = plugin.actions(a.data, a.label);
              if (!primary) return null;
              return (
                <a
                  key={a.id}
                  role="menuitem"
                  className="menu-item menu-attachment"
                  href={primary.href}
                  download={primary.download}
                  target={primary.newTab ? "_blank" : undefined}
                  rel={primary.newTab ? "noreferrer" : undefined}
                  title={`${primary.label}: ${titleOf(a)}`}
                  onClick={closeMenu}
                >
                  <span className="menu-icon" aria-hidden="true">{iconOf(plugin, a.data)}</span>
                  <span className="menu-attachment-text">{titleOf(a)}</span>
                  <span className="menu-hint">{primary.newTab ? "↗" : primary.label}</span>
                </a>
              );
            })}
            <div className="menu-divider" role="separator" />
            <button
              type="button"
              role="menuitem"
              className="menu-item"
              onClick={() => archive(archiveTask)}
            >
              Archive task
              <span className="menu-hint">keep for reference</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="menu-item menu-danger"
              onClick={() => archive(deleteTask)}
            >
              Delete task
              <span className="menu-hint">restorable from Deleted</span>
            </button>
          </>
        ) : (
          <form className="menu-form" onSubmit={submitSubtask}>
            <input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Subtask title, then Enter"
              aria-label={`New subtask of ${task.title}`}
            />
          </form>
        )}
      </div>
    </>
  );
}
