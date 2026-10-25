import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  type Modifier,
} from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { getBoardsWithLanes } from "../api/client";
import { moveToBoard } from "../lib/moveBoard";
import { treeRows } from "../lib/tree";
import { useBoardStore } from "../store/boardStore";
import type { BoardWithLanes } from "../types";
import QuickAdd from "./QuickAdd";
import TaskCard from "./TaskCard";

const NO_IDS: string[] = [];
const DROP = "drop:";

/** Where the drag started, on screen. */
function startPoint(event: Event | null): { x: number; y: number } | null {
  if (!event) return null;
  if ("touches" in event && (event as TouchEvent).touches.length) {
    const t = (event as TouchEvent).touches[0];
    return { x: t.clientX, y: t.clientY };
  }
  if ("clientX" in event) return { x: (event as MouseEvent).clientX, y: (event as MouseEvent).clientY };
  return null;
}

/** Keep the (small) drag label just below-right of the pointer, so the
 * lanes under the pointer stay visible. */
const besidePointer: Modifier = ({ transform, activatorEvent, draggingNodeRect }) => {
  const start = startPoint(activatorEvent);
  if (!start || !draggingNodeRect) return transform;
  return {
    ...transform,
    x: transform.x + start.x - draggingNodeRect.left + 14,
    y: transform.y + start.y - draggingNodeRect.top + 14,
  };
};

/** Where a drop lands: a board (its same-named lane) or one of its lanes. */
function dropId(boardId: string, laneId = "") {
  return `${DROP}${boardId}:${laneId}`;
}

/** The inbox: jot anything down without choosing a board, then give each
 * note a home by dragging it onto a board's lane (or Move to board… from
 * its menu or drawer). Quick add reads deadlines, £ and ~time as usual. */
export default function InboxView() {
  const lane = useBoardStore((s) => s.lanes[0]);
  const ids = useBoardStore((s) => (lane ? s.taskIdsByLane[lane.id] : undefined)) ?? NO_IDS;
  const tasksById = useBoardStore((s) => s.tasksById);
  const [boards, setBoards] = useState<BoardWithLanes[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const loadBoards = useCallback(() => {
    getBoardsWithLanes()
      .then((list) => setBoards(list.filter((b) => b.kind !== "inbox")))
      .catch(() => setBoards((b) => b ?? []));
  }, []);
  useEffect(loadBoards, [loadBoards]);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
  );

  // Top-level notes only: subtasks travel with their parent.
  const notes = ids.filter((id) => tasksById[id] && !tasksById[id].parent_id);

  function onDragStart(e: DragStartEvent) {
    setActiveId(String(e.active.id));
    setMessage(null);
    useBoardStore.getState().setDragActive(true);
  }

  async function onDragEnd(e: DragEndEvent) {
    setActiveId(null);
    useBoardStore.getState().setDragActive(false);
    const over = e.over ? String(e.over.id) : "";
    if (!over.startsWith(DROP) || !boards) return;
    const [boardId, laneId] = over.slice(DROP.length).split(":");
    const board = boards.find((b) => b.id === boardId);
    if (!board) return;
    const target = board.lanes.find((l) => l.id === laneId);
    const failed = await moveToBoard(String(e.active.id), {
      boardId,
      boardName: board.name,
      laneId: target?.id,
      laneName: target?.name,
    });
    setMessage(failed);
  }

  const active = activeId ? tasksById[activeId] : undefined;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => {
        setActiveId(null);
        useBoardStore.getState().setDragActive(false);
      }}
    >
      <main className="inbox">
        <section className="inbox-notes" aria-labelledby="inbox-title">
          <div className="inbox-head">
            <h2 id="inbox-title">
              Inbox <span className="history-count">{notes.length}</span>
            </h2>
            <p className="offboard-note">
              Jot it down now, sort it later. A line each; “due friday”, £45, ~2h and links work as usual. Drag a note
              onto a board or one of its lanes to give it a home.
            </p>
          </div>
          <div className="inbox-add">
            <QuickAdd />
          </div>
          {message && <p className="attach-error">{message}</p>}
          <SortableContext items={notes} strategy={verticalListSortingStrategy}>
            <div className="inbox-list">
              {notes.map((id) => (
                <TaskCard key={id} taskId={id} />
              ))}
              {notes.length === 0 && <p className="offboard-empty">Nothing waiting. Anything you add lands here.</p>}
            </div>
          </SortableContext>
        </section>

        <aside className="inbox-targets" aria-labelledby="inbox-targets-title">
          <h2 id="inbox-targets-title">Boards</h2>
          <p className="offboard-note">Drop on a board for its matching lane, or on a lane.</p>
          {boards === null && <p className="history-empty">Loading…</p>}
          <ul>
            {treeRows(boards ?? []).map(({ board, depth }) => {
              const full = boards!.find((b) => b.id === board.id)!;
              return (
                <li key={board.id} style={{ "--depth": depth } as CSSProperties}>
                  <DropBoard board={full} dragging={!!activeId} />
                </li>
              );
            })}
          </ul>
        </aside>
      </main>
      <DragOverlay dropAnimation={null} modifiers={[besidePointer]}>
        {active ? (
          <div className="inbox-drag-label">
            <span aria-hidden="true">⇥</span> {active.title}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function DropBoard({ board, dragging }: { board: BoardWithLanes; dragging: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: dropId(board.id) });
  return (
    <div className={`inbox-drop-board${dragging ? " is-dragging" : ""}`}>
      <div ref={setNodeRef} className={`inbox-drop-name${isOver ? " is-over" : ""}`}>
        {board.name}
      </div>
      <div className="inbox-drop-lanes">
        {board.lanes.map((lane) => (
          <DropLane key={lane.id} boardId={board.id} lane={lane} />
        ))}
      </div>
    </div>
  );
}

function DropLane({ boardId, lane }: { boardId: string; lane: BoardWithLanes["lanes"][number] }) {
  const { setNodeRef, isOver } = useDroppable({ id: dropId(boardId, lane.id) });
  return (
    <div
      ref={setNodeRef}
      className={`inbox-drop-lane${isOver ? " is-over" : ""}`}
      style={{ "--lane-color": lane.color } as CSSProperties}
    >
      <span className="subtask-dot" style={{ background: lane.color }} />
      {lane.name}
    </div>
  );
}
