import { useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";
import { ApiError, createBoard, getBoards, setBoardParent } from "../api/client";
import { navigateToBoard } from "../lib/route";
import { isWithin, treeRows } from "../lib/tree";
import { useBoardStore } from "../store/boardStore";
import type { BoardSummary } from "../types";

const TOP = "__top__";

async function refreshBoards() {
  const list = await getBoards();
  useBoardStore.getState().setBoards(list);
  return list;
}

/** The board tree: drag a board onto another to nest it there, or onto
 * the top strip to make it top level. Each row also has a "Move to…"
 * menu (keyboard and touch). A parent board shows all its sub-boards'
 * tasks. */
export function BoardFamilyPanel() {
  const open = useBoardStore((s) => s.familyOpen);
  const setFamilyOpen = useBoardStore((s) => s.setFamilyOpen);
  const boards = useBoardStore((s) => s.boards);
  const current = useBoardStore((s) => s.board?.id);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null); // parent id, or TOP
  const [masterName, setMasterName] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    refreshBoards().catch(() => {});
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setFamilyOpen(false);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      opener?.focus?.();
    };
  }, [open, setFamilyOpen]);

  if (!open) return null;

  const rows = treeRows(boards.filter((b) => b.kind !== "inbox"));
  const tops = rows.filter((r) => r.depth === 0);
  const childCount = (id: string) => boards.filter((b) => b.parent_id === id).length;

  /** Can `boardId` go under `target` (a board id or TOP)? */
  const allowed = (boardId: string, target: string) => {
    const board = boards.find((b) => b.id === boardId);
    if (!board) return false;
    if (target === TOP) return board.parent_id !== null;
    return target !== board.parent_id && !isWithin(target, boardId, boards);
  };

  async function move(boardId: string, target: string) {
    if (!allowed(boardId, target)) return;
    setError(null);
    const parentId = target === TOP ? null : target;
    // Optimistic: the tree redraws at once; the server's list replaces it.
    const store = useBoardStore.getState();
    store.setBoards(store.boards.map((b) => (b.id === boardId ? { ...b, parent_id: parentId } : b)));
    try {
      await setBoardParent(boardId, parentId);
    } catch (e) {
      setError((e instanceof ApiError && e.detail) || "Couldn’t move that board.");
    }
    refreshBoards().catch(() => {});
  }

  function dropProps(target: string) {
    const ok = dragging !== null && allowed(dragging, target);
    return {
      onDragOver: (e: DragEvent) => {
        if (!dragging) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = ok ? "move" : "none";
        setOver(target);
      },
      onDragLeave: () => setOver((o) => (o === target ? null : o)),
      onDrop: (e: DragEvent) => {
        e.preventDefault();
        setOver(null);
        if (dragging && ok) move(dragging, target);
        setDragging(null);
      },
      "data-drop": over === target ? (ok ? "ok" : "no") : undefined,
    };
  }

  async function createUnder(parent: string, name: string) {
    try {
      await createBoard(name, parent === TOP ? null : parent);
      setAdding(null);
      await refreshBoards();
    } catch (e) {
      setError((e instanceof ApiError && e.detail) || "Couldn’t create that board.");
    }
  }

  async function createMaster(name: string) {
    try {
      const master = await createBoard(name);
      for (const r of tops) await setBoardParent(r.board.id, master.id);
      setMasterName(null);
      await refreshBoards();
    } catch (e) {
      setError((e instanceof ApiError && e.detail) || "Couldn’t create the master board.");
    }
  }

  return (
    <>
      <div className="drawer-backdrop" onPointerDown={() => setFamilyOpen(false)} />
      <aside className="drawer family" role="dialog" aria-modal="true" aria-labelledby="family-title">
        <header className="drawer-header">
          <div className="drawer-heading">
            <span className="eyebrow">Boards</span>
            <h2 id="family-title">Board family</h2>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="drawer-close"
            onClick={() => setFamilyOpen(false)}
            aria-label="Close board family"
          >
            ×
          </button>
        </header>
        <div className="drawer-scroll">
          <p className="settings-intro">
            A board shows its own tasks and every task of the boards inside it. Drag a board onto
            another to put it inside, or onto the strip below to bring it to the top.
          </p>

          {tops.length > 1 &&
            (masterName === null ? (
              <div className="family-master">
                <span>
                  {tops.length} boards are at the top. A master board over them would show every
                  task in one place.
                </span>
                <button type="button" className="attach-add" onClick={() => setMasterName("All boards")}>
                  Create master board
                </button>
              </div>
            ) : (
              <NameForm
                label="Master board name"
                initial={masterName}
                submitLabel="Create"
                onSubmit={createMaster}
                onCancel={() => setMasterName(null)}
              />
            ))}

          {error && <p className="attach-error" role="alert">{error}</p>}

          <div className="family-top" {...dropProps(TOP)}>
            {dragging ? "Drop here to make it a top-level board" : "Top level"}
          </div>

          <ul className="family-tree" role="tree" aria-label="Boards">
            {rows.map(({ board, depth }) => (
              <li
                key={board.id}
                role="treeitem"
                aria-level={depth + 1}
                aria-current={board.id === current ? "page" : undefined}
                className={`family-row${dragging === board.id ? " is-dragging" : ""}${
                  dragging && isWithin(board.id, dragging, boards) ? " is-carried" : ""
                }`}
                style={{ "--depth": depth } as React.CSSProperties}
              >
                <div
                  className="family-node"
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", board.id);
                    setDragging(board.id);
                  }}
                  onDragEnd={() => {
                    setDragging(null);
                    setOver(null);
                  }}
                  {...dropProps(board.id)}
                >
                  <span className="family-grip" aria-hidden="true">
                    ⠿
                  </span>
                  <span className="family-name">
                    {board.name}
                    {board.id === current && <span className="menu-hint">viewing</span>}
                  </span>
                  {childCount(board.id) > 0 && (
                    <span className="family-count" title="Boards directly inside">
                      {childCount(board.id)} inside
                    </span>
                  )}
                  <span className="family-actions">
                    <button
                      type="button"
                      onClick={() => {
                        setFamilyOpen(false);
                        navigateToBoard(board.slug);
                      }}
                    >
                      Open
                    </button>
                    <button type="button" onClick={() => setAdding(board.id)} title="New board inside this one">
                      + Inside
                    </button>
                    <MoveTo board={board} boards={boards} allowed={allowed} onMove={move} />
                  </span>
                </div>
                {adding === board.id && (
                  <NameForm
                    label={`New board inside ${board.name}`}
                    initial=""
                    submitLabel="Create"
                    onSubmit={(name) => createUnder(board.id, name)}
                    onCancel={() => setAdding(null)}
                  />
                )}
              </li>
            ))}
          </ul>
        </div>
      </aside>
    </>
  );
}

function MoveTo({
  board,
  boards,
  allowed,
  onMove,
}: {
  board: BoardSummary;
  boards: BoardSummary[];
  allowed: (id: string, target: string) => boolean;
  onMove: (id: string, target: string) => void;
}) {
  const targets = treeRows(boards.filter((b) => b.kind !== "inbox")).filter((r) => allowed(board.id, r.board.id));
  return (
    <select
      className="family-move"
      aria-label={`Move ${board.name} into…`}
      value=""
      onChange={(e) => e.target.value && onMove(board.id, e.target.value)}
    >
      <option value="">Move to…</option>
      {board.parent_id !== null && <option value={TOP}>Top level</option>}
      {targets.map((r) => (
        <option key={r.board.id} value={r.board.id}>
          {"  ".repeat(r.depth)}
          {r.board.name}
        </option>
      ))}
    </select>
  );
}

function NameForm({
  label,
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  label: string;
  initial: string;
  submitLabel: string;
  onSubmit: (name: string) => Promise<void> | void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    await onSubmit(name.trim());
    setBusy(false);
  }
  return (
    <form className="family-form" onSubmit={submit} onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), onCancel())}>
      <input autoFocus value={name} onChange={(e) => setName(e.target.value)} aria-label={label} placeholder={label} maxLength={200} />
      <button type="button" onClick={onCancel}>
        Cancel
      </button>
      <button type="submit" className="primary" disabled={busy || !name.trim()}>
        {submitLabel}
      </button>
    </form>
  );
}
