import { useEffect, useState } from "react";
import { getBoardsWithLanes } from "../api/client";
import { moveToBoard } from "../lib/moveBoard";
import { treeRows } from "../lib/tree";
import { useBoardStore } from "../store/boardStore";
import type { BoardWithLanes, Task } from "../types";
import FloatingPanel from "./FloatingPanel";

/** Pick a board (and, optionally, a lane) to move a task to. The task's
 * subtasks go with it. */
export function MoveToBoardPicker({ task, anchor, onClose }: { task: Task; anchor: DOMRect; onClose: () => void }) {
  const currentBoardId = task.board_id;
  const [boards, setBoards] = useState<BoardWithLanes[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const subtasks = useBoardStore((s) => s.childrenByParent[task.id]?.length ?? 0);

  useEffect(() => {
    getBoardsWithLanes()
      .then(setBoards)
      .catch(() => setError("Couldn’t load the boards."));
  }, []);

  async function go(board: BoardWithLanes, lane?: BoardWithLanes["lanes"][number]) {
    setBusy(true);
    const failed = await moveToBoard(task.id, {
      boardId: board.id,
      boardName: board.name,
      laneId: lane?.id,
      laneName: lane?.name,
    });
    setBusy(false);
    if (failed) setError(failed);
    else onClose();
  }

  const others = (boards ?? []).filter((b) => b.id !== currentBoardId);
  const inbox = others.find((b) => b.kind === "inbox");
  const rows = treeRows(others.filter((b) => b.kind !== "inbox"));
  const byId = new Map(others.map((b) => [b.id, b]));

  return (
    <FloatingPanel anchor={anchor} onClose={onClose} label="Move to board" className="move-board-popover">
      <div className="move-board">
        <h3>Move to board</h3>
        <p className="attachments-empty">
          {subtasks > 0 ? `Its ${subtasks} subtask${subtasks > 1 ? "s go" : " goes"} too. ` : ""}
          Pick a board (same-named lane), or a lane.
        </p>
        {error && <p className="attach-error">{error}</p>}
        {boards === null && !error && <p className="history-empty">Loading…</p>}
        <ul className="move-board-list">
          {rows.map(({ board, depth }) => {
            const full = byId.get(board.id)!;
            return (
              <li key={board.id} style={{ paddingLeft: depth * 14 }}>
                <button type="button" className="move-board-name" disabled={busy} onClick={() => go(full)}>
                  {depth > 0 && <span className="board-tree-elbow" aria-hidden="true">└ </span>}
                  {board.name}
                </button>
                <span className="move-board-lanes">
                  {full.lanes.map((lane) => (
                    <button
                      key={lane.id}
                      type="button"
                      className="move-board-lane"
                      disabled={busy}
                      title={`${board.name} · ${lane.name}`}
                      onClick={() => go(full, lane)}
                    >
                      <span className="subtask-dot" style={{ background: lane.color }} />
                      {lane.name}
                    </button>
                  ))}
                </span>
              </li>
            );
          })}
          {inbox && (
            <li className="move-board-inbox">
              <button type="button" className="move-board-name" disabled={busy} onClick={() => go(inbox)}>
                Back to the Inbox
              </button>
            </li>
          )}
        </ul>
      </div>
    </FloatingPanel>
  );
}
