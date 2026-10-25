import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { motion, useIsPresent } from "motion/react";
import { Fragment, useEffect, useRef, useState, type CSSProperties } from "react";
import { CARD_REST, CATALOGUE } from "../animations/catalogue";
import { focusDepthOf, focusStateOf } from "../lib/focus";
import { formatDuration, secondsSince } from "../lib/time";
import { useBoardStore } from "../store/boardStore";
import type { Task } from "../types";
import { AttachmentChips, AudioBadge, CardPhoto, photosOf } from "./Attachments";
import { TaskCategories } from "./Categories";
import { RollupBadges, useHasRollup } from "./Figures";
import { OwnerStack } from "./Owners";
import { cardAccent, dueLabel, dueState } from "../lib/cardColour";
import { keepToControl } from "../lib/controls";
import type { SubtaskView } from "../lib/collapse";
import { addSubtasks, checkOffSubtask } from "../lib/subtasks";
import { attachFiles, filesFrom } from "../lib/uploads";
import { describeNode, nextSubtaskOf, useFlow } from "../lib/flow";

const NO_CHILDREN: string[] = [];

export interface SubtaskRow {
  id: string;
  title: string;
  laneName: string;
  laneColor: string;
  laneOrder: number;
  /** Sitting in the board's final lane. */
  done: boolean;
}

/** Assemble the display rows for a card's subtask checklist. */
export function useSubtaskRows(taskId: string): SubtaskRow[] {
  const childIds = useBoardStore((s) => s.childrenByParent[taskId]) ?? NO_CHILDREN;
  const tasksById = useBoardStore((s) => s.tasksById);
  const lanes = useBoardStore((s) => s.lanes);
  return childIds.flatMap((id) => {
    const child = tasksById[id];
    if (!child) return [];
    const lane = lanes.find((l) => l.id === child.lane_id);
    return [{
      id,
      title: child.title,
      laneName: lane?.name ?? "",
      laneColor: lane?.color ?? "#6b7280",
      laneOrder: lane?.order ?? 0,
      done: !!lane?.is_final,
    }];
  });
}

const subtaskCount = (n: number) => `${n} subtask${n === 1 ? "" : "s"}`;

const VIEW_NAMES: Record<SubtaskView, string> = { list: "a list", checklist: "a checklist", bar: "a flow" };
const VIEW_ICONS: Record<SubtaskView, string> = { list: "▾", checklist: "☑", bar: "▸" };
const NEXT_VIEW: Record<SubtaskView, SubtaskView> = { list: "checklist", checklist: "bar", bar: "list" };

/** Checklist view: tick an unfinished subtask off (into a final lane).
 * Finished ones show ticked. */
function SubtaskCheck({ subtask, interactive }: { subtask: SubtaskRow; interactive: boolean }) {
  const [ticking, setTicking] = useState(false);
  const checked = subtask.done || ticking;
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={checked ? `${subtask.title} is done` : `Mark ${subtask.title} done`}
      className={`subtask-check${checked ? " is-checked" : ""}`}
      disabled={!interactive || subtask.done || ticking}
      style={{ "--lane-color": subtask.laneColor } as CSSProperties}
      onClick={async (e) => {
        e.stopPropagation();
        setTicking(true);
        if (!(await checkOffSubtask(subtask.id))) setTicking(false);
      }}
      {...keepToControl}
    >
      {checked ? "✓" : ""}
    </button>
  );
}

/** Add subtasks from the parent card: same parsing as the header's quick
 * add (a line each; links and contacts become typed tasks). */
/** A subtask row's owners and categories, settable in place (the pickers
 * stop clicks reaching the card, so nothing opens or drags). */
export function SubtaskExtras({ taskId, interactive }: { taskId: string; interactive: boolean }) {
  const sub = useBoardStore((s) => s.tasksById[taskId]);
  if (!sub) return null;
  return (
    <span className="subtask-extras">
      <TaskCategories task={sub} interactive={interactive} compact />
      <OwnerStack task={sub} interactive={interactive} />
    </span>
  );
}

/** "↳ Parent" above a subtask's title; opens the parent's details. */
function ParentLink({ task, title, interactive }: { task: Task; title: string; interactive: boolean }) {
  const openDetail = useBoardStore((s) => s.openDetail);
  if (!interactive || !task.parent_id) {
    return (
      <p className="card-parent">
        <span aria-hidden="true">↳ </span>
        {title}
      </p>
    );
  }
  const parentId = task.parent_id;
  return (
    <button
      type="button"
      className="card-parent"
      title={`Open “${title}”`}
      onClick={(e) => {
        e.stopPropagation();
        openDetail(parentId);
      }}
      {...keepToControl}
    >
      <span aria-hidden="true">↳ </span>
      {title}
    </button>
  );
}

export function SubtaskQuickAdd({ parentId }: { parentId: string }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  // Fit the text (one line when empty — including after adding).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 96)}px`;
  }, [text]);

  async function submit() {
    if (!text.trim() || busy) return;
    setBusy(true);
    const failed = await addSubtasks(parentId, text);
    setBusy(false);
    setText(failed.join("\n"));
  }

  return (
    <textarea
      ref={ref}
      className="subtask-add"
      rows={1}
      value={text}
      disabled={busy}
      placeholder={busy ? "Adding…" : "+ Add subtask"}
      aria-label="Add subtasks (one per line)"
      enterKeyHint="done"
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation(); // not a card shortcut / keyboard drag
        if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault();
          submit();
        } else if (e.key === "Escape") {
          setText("");
          ref.current?.blur();
        }
      }}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onTouchStart={(e) => e.stopPropagation()}
    />
  );
}

/** Subtasks as a flow strip: one segment per subtask, grouped into stages
 * by the "blocks" links between them (› between stages; unlinked ones run
 * in parallel). Done, ready (★ on the one to tackle next) or waiting on a
 * blocker. Each segment explains itself on hover or focus and opens its
 * subtask on click. */
function SubtaskFlow({
  parentId,
  subtasks,
  onOpen,
  blockingIds,
}: {
  parentId: string;
  subtasks: SubtaskRow[];
  onOpen?: (taskId: string) => void;
  blockingIds?: string[];
}) {
  const flow = useFlow(parentId);
  const tasksById = useBoardStore((s) => s.tasksById);
  const [tip, setTip] = useState<{ id: string; at: number } | null>(null);
  const rows = Object.fromEntries(subtasks.map((s) => [s.id, s]));
  const done = subtasks.filter((s) => s.done).length;
  const titleOf = (id: string) => tasksById[id]?.title ?? "a task elsewhere";
  const count = flow.stages.reduce((n, st) => n + st.length, 0);
  const anchor = (at: number) =>
    at < 0.25 ? { left: 0 } : at > 0.75 ? { right: 0 } : { left: `${at * 100}%`, translate: "-50% 0" };
  const tipRow = tip && rows[tip.id];
  const tipNode = tip && flow.nodes[tip.id];
  let index = -1;
  return (
    <div className="subtask-progress subtask-flow">
      <div className="progress-track" role="group" aria-label={`${done} of ${subtasks.length} subtasks done`}>
        {flow.stages.map((stage, si) => (
          <Fragment key={si}>
            {si > 0 && <span className="flow-sep" aria-hidden="true">›</span>}
            {stage.map((id) => {
              const row = rows[id];
              const node = flow.nodes[id];
              if (!row || !node) return null;
              index += 1;
              const at = (index + 0.5) / count;
              const next = flow.next === id && subtasks.length > 1;
              const show = () => setTip({ id, at });
              return (
                <button
                  key={id}
                  type="button"
                  className={`progress-seg flow-${node.state}${next ? " flow-next" : ""}${
                    blockingIds?.includes(id) ? " is-blocking" : ""
                  }`}
                  style={{ "--lane-color": row.laneColor } as CSSProperties}
                  aria-label={`${row.title}: ${describeNode(node, next, titleOf)}, ${row.laneName}`}
                  onMouseEnter={show}
                  onFocus={show}
                  onMouseLeave={() => setTip(null)}
                  onBlur={() => setTip(null)}
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpen?.(id);
                  }}
                  {...keepToControl}
                >
                  {next ? "★" : ""}
                </button>
              );
            })}
          </Fragment>
        ))}
        {tip && tipRow && tipNode && (
          <span className="progress-tip" style={anchor(tip.at)} aria-hidden="true">
            <span className="subtask-dot" style={{ background: tipRow.laneColor }} />
            <span className={tipRow.done ? "is-done" : undefined}>{tipRow.title}</span>
            <span className="progress-tip-lane">
              {describeNode(tipNode, flow.next === tip.id && subtasks.length > 1, titleOf)} · {tipRow.laneName}
            </span>
          </span>
        )}
      </div>
      <span className="progress-label">
        {done}/{subtasks.length}
      </span>
    </div>
  );
}

export function CardBody({
  task,
  subtasks,
  parentTitle,
  view = "list",
  onCycleView,
  onOpenSubtask,
  blockingIds,
  ownersInteractive = false,
  isNext = false,
}: {
  task: Task;
  subtasks: SubtaskRow[];
  parentTitle?: string;
  /** list, checklist (tick unfinished ones off here) or progress bar. */
  view?: SubtaskView;
  /** Interactive cards only: list → checklist → bar. */
  onCycleView?: () => void;
  /** Open a subtask's own details (absent on the drag overlay). */
  onOpenSubtask?: (taskId: string) => void;
  /** Subtasks currently stopping this card's drop (on the drag overlay). */
  blockingIds?: string[];
  /** Owners can be changed from the card (not on the drag overlay). */
  ownersInteractive?: boolean;
  /** The subtask to tackle next under its parent. */
  isNext?: boolean;
}) {
  // Tasks from a descendant board say which, quietly.
  const fromBoard = useBoardStore((s) =>
    task.board_id !== s.board?.id ? s.familyById[task.board_id]?.name : undefined,
  );
  const inFinalLane = useBoardStore((s) => !!s.lanes.find((l) => l.id === task.lane_id)?.is_final);
  const due = task.due_date ? (inFinalLane ? "done" : dueState(task.due_date)) : null;
  const hasRollup = useHasRollup(task.id);
  const hasBadges =
    isNext ||
    hasRollup ||
    (task.comment_count ?? 0) > 0 ||
    task.blocked_by.length > 0 || task.attachments.length > photosOf(task.attachments).length || !!due;
  // (sound clips count as attachments, so they already switch the badge row on)
  return (
    <>
      {parentTitle && (
        <ParentLink task={task} title={parentTitle} interactive={!!onOpenSubtask} />
      )}
      <div className="card-head">
        <p className="card-title">{task.title}</p>
        <OwnerStack task={task} interactive={ownersInteractive} />
      </div>
      <TaskCategories task={task} interactive={ownersInteractive} />
      <CardPhoto attachments={task.attachments} />
      {hasBadges && (
        <div className="card-badges">
          {isNext && (
            <span
              className="badge badge-next"
              title="Tackle this next: it's ready, and furthest along of its parent's subtasks"
            >
              ★ Next
            </span>
          )}
          {due && task.due_date && (
            <span className={`badge badge-due due-${due}`} title={`Deadline ${task.due_date}`}>
              {due === "done" ? `Was due ${task.due_date.slice(5).replace("-", "/")}` : dueLabel(task.due_date)}
            </span>
          )}
          {task.blocked_by.length > 0 && (
            <span className="badge badge-blocked" title="Blocked by another task">
              blocked
            </span>
          )}
          <RollupBadges taskId={task.id} />
          {(task.comment_count ?? 0) > 0 && (
            <span className="badge badge-log" title={`${task.comment_count} log entr${task.comment_count === 1 ? "y" : "ies"}`}>
              ✎ {task.comment_count}
            </span>
          )}
          <AudioBadge attachments={task.attachments} />
          <AttachmentChips attachments={task.attachments} />
        </div>
      )}
      {subtasks.length > 0 && view === "bar" && (
        <SubtaskFlow parentId={task.id} subtasks={subtasks} onOpen={onOpenSubtask} blockingIds={blockingIds} />
      )}
      {subtasks.length > 0 && view !== "bar" && (
        <ul className={`card-subtasks${view === "checklist" ? " is-checklist" : ""}`} aria-label="Subtasks">
          {subtasks.map((subtask) => (
            <li
              key={subtask.id}
              className={
                [subtask.done && "is-done", blockingIds?.includes(subtask.id) && "is-blocking"]
                  .filter(Boolean)
                  .join(" ") || undefined
              }
              title={subtask.done ? `${subtask.laneName} (done)` : subtask.laneName}
            >
              {view === "checklist" ? (
                <SubtaskCheck subtask={subtask} interactive={!!onCycleView} />
              ) : (
                <span className="subtask-dot" style={{ background: subtask.laneColor }} />
              )}
              {onOpenSubtask ? (
                <button
                  type="button"
                  className="subtask-title"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenSubtask(subtask.id);
                  }}
                  {...keepToControl}
                >
                  {subtask.title}
                </button>
              ) : (
                <span className="subtask-title">{subtask.title}</span>
              )}
              <SubtaskExtras taskId={subtask.id} interactive={!!onCycleView} />
            </li>
          ))}
        </ul>
      )}
      {subtasks.length > 0 && view !== "bar" && onCycleView && <SubtaskQuickAdd parentId={task.id} />}
      <footer className="card-footer">
        {subtasks.length > 0 &&
          (onCycleView ? (
            <button
              type="button"
              className="subtask-toggle"
              aria-label={`${subtaskCount(subtasks.length)}, shown as ${VIEW_NAMES[view]}. Switch view`}
              title={`Showing ${VIEW_NAMES[view]} · click for ${VIEW_NAMES[NEXT_VIEW[view]]}`}
              onClick={(e) => {
                e.stopPropagation();
                onCycleView();
              }}
              {...keepToControl}
            >
              <span className="caret" aria-hidden="true">{VIEW_ICONS[view]}</span>
              {subtaskCount(subtasks.length)}
            </button>
          ) : (
            <span className="card-age">{subtaskCount(subtasks.length)}</span>
          ))}
        {task.description.trim() && (
          <span className="card-has-details" title="Has details" aria-label="Has details">
            ≡
          </span>
        )}
        {fromBoard && (
          <span className="card-board" title={`From the ${fromBoard} board`}>
            {fromBoard}
          </span>
        )}
        <span className="card-age" title={`In this lane since ${task.lane_entered_at}`}>
          in lane {formatDuration(secondsSince(task.lane_entered_at))}
        </span>
      </footer>
    </>
  );
}

export default function TaskCard({ taskId }: { taskId: string }) {
  const task = useBoardStore((s) => s.tasksById[taskId]);
  const flash = useBoardStore((s) => s.flashes[taskId]);
  // False while this copy fades out of a lane the card has just left.
  const present = useIsPresent();
  const dragActive = useBoardStore((s) => s.dragActive);
  const clearFlash = useBoardStore((s) => s.clearFlash);
  const openMenu = useBoardStore((s) => s.openMenu);
  const openDetail = useBoardStore((s) => s.openDetail);
  const blocking = useBoardStore((s) => !!s.dropBlock?.blockers.includes(taskId));
  const focus = useBoardStore((s) => focusStateOf(taskId, s.focusTaskId, s.tasksById));
  const focusDepth = useBoardStore((s) => focusDepthOf(taskId, s.focusTaskId, s.tasksById));
  // Where the pointer went down, so a click that ended a drag doesn't open
  // the drawer. Matches the 6px drag activation distance.
  const pressedAt = useRef<{ x: number; y: number } | null>(null);
  const parentTitle = useBoardStore((s) =>
    task?.parent_id ? s.tasksById[task.parent_id]?.title : undefined,
  );
  const subtasks = useSubtaskRows(taskId);
  const isNext = useBoardStore((s) =>
    task?.parent_id ? nextSubtaskOf(task.parent_id, s) === taskId : false,
  );
  const view = useBoardStore((s) => s.subtaskViews[taskId] ?? "list");
  const cycleView = useBoardStore((s) => s.cycleSubtaskView);
  const lanes = useBoardStore((s) => s.lanes);
  const boardMetadata = useBoardStore((s) => s.board?.metadata);
  const colourBy = useBoardStore((s) => s.colourBy);
  const ownersById = useBoardStore((s) => s.ownersById);
  const categoriesById = useBoardStore((s) => s.categoriesById);
  useBoardStore((s) => s.tick); // minute heartbeat: keeps ages and aging fresh

  const [fileOver, setFileOver] = useState(false);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: taskId });

  if (!task) return null;

  const flashTarget = flash ? CATALOGUE[flash] : undefined;
  const accent = cardAccent(task, colourBy, {
    inFinalLane: !!lanes.find((lane) => lane.id === task.lane_id)?.is_final,
    ownersById,
    categoriesById,
    agingHours: boardMetadata?.aging as { stale_hours?: number; old_hours?: number } | undefined,
  });

  return (
    <div
      ref={setNodeRef}
      className={`card-slot focus-${focus}${fileOver ? " is-file-over" : ""}${isDragging ? " is-dragging" : ""}${blocking ? " is-blocking" : ""}`}
      style={
        {
          transform: CSS.Transform.toString(transform),
          transition,
          "--focus-depth": focusDepth || undefined,
        } as CSSProperties
      }
      onContextMenu={(e) => {
        e.preventDefault();
        if (!dragActive) openMenu(taskId, e.clientX, e.clientY);
      }}
      // Files from the desktop (a photo, a sound clip) attach to the card.
      onDragOver={(e) => {
        if (Array.from(e.dataTransfer.types).includes("Files")) {
          e.preventDefault();
          setFileOver(true);
        }
      }}
      onDragLeave={() => setFileOver(false)}
      onDrop={async (e) => {
        const files = filesFrom(e.dataTransfer);
        setFileOver(false);
        if (!files.length) return;
        e.preventDefault();
        e.stopPropagation();
        const failed = await attachFiles(taskId, files);
        if (failed) window.alert(failed);
        else useBoardStore.getState().flashTasks([taskId], "pulse");
      }}
      {...attributes}
      {...listeners}
      onPointerDown={(e) => {
        pressedAt.current = { x: e.clientX, y: e.clientY };
        listeners?.onPointerDown?.(e);
      }}
      onClick={(e) => {
        const start = pressedAt.current;
        pressedAt.current = null;
        if (e.button !== 0 || dragActive) return;
        // detail 0 = a keyboard or assistive-tech click: no pointer involved.
        const pointerClick = e.detail > 0 && start;
        if (pointerClick && Math.hypot(e.clientX - start.x, e.clientY - start.y) >= 6) return;
        openDetail(taskId);
      }}
    >
      {/* Motion owns this inner node; dnd-kit owns the outer one. Keeping
          their transforms on separate elements is what stops them fighting. */}
      <motion.div
        className={`card${accent.className}${isNext ? " is-next" : ""}`}
        style={accent.colour ? ({ "--card-accent": accent.colour } as CSSProperties) : undefined}
        title={accent.why}
        layout={!dragActive}
        initial={{ opacity: 0, scale: 0.92 }}
        // The copy leaving the old lane just fades out: a flash (another
        // screen's celebrate) arriving then would override its exit and
        // leave it stuck there beside the card in its new lane.
        animate={present ? (flashTarget ?? CARD_REST) : undefined}
        exit={{ opacity: 0, scale: 0.9 }}
        transition={{ layout: { duration: 0.25, ease: "easeOut" } }}
        // Only the flash finishing ends it: a card that just moved (our own
        // drag) is still fading in when the server's celebrate arrives, and
        // that fade-in finishing mustn't cut the flash short.
        onAnimationComplete={(done) => flash && done === flashTarget && clearFlash(taskId)}
      >
        <CardBody
          task={task}
          subtasks={subtasks}
          // In focus mode the indent under the focused task says whose it is.
          parentTitle={focus === "subtask" ? undefined : parentTitle}
          view={view}
          onCycleView={() => cycleView(taskId)}
          onOpenSubtask={openDetail}
          ownersInteractive
          isNext={isNext}
        />
      </motion.div>
    </div>
  );
}
