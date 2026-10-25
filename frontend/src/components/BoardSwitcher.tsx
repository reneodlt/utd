import { useEffect, useRef, useState, type FormEvent } from "react";
import { archiveBoard, createBoard, getBoards, renameBoard } from "../api/client";
import { copyText } from "../lib/compat";
import { navigateHome, navigateToBoard } from "../lib/route";
import { treeRows } from "../lib/tree";
import { useBoardStore } from "../store/boardStore";

type Mode = "menu" | "create" | "rename" | "calendar";

/** The board name in the header doubles as the board menu: switch between
 * boards, create, rename, archive. */
export default function BoardSwitcher() {
  const board = useBoardStore((s) => s.board);
  const boards = useBoardStore((s) => s.boards);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("menu");
  const [draft, setDraft] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setMode("menu");
    // Refresh so boards created in other tabs/clients show up.
    getBoards()
      .then((list) => useBoardStore.getState().setBoards(list))
      .catch(() => {});
  }, [open]);

  useEffect(() => {
    if (open && mode === "menu") {
      panelRef.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    }
  }, [open, mode]);

  if (!board) return null;

  function close() {
    setOpen(false);
    setDraft("");
  }

  async function submitCreate(event: FormEvent) {
    event.preventDefault();
    const name = draft.trim();
    if (!name) return;
    const created = await createBoard(name).catch(() => null);
    if (!created) return;
    useBoardStore.getState().setBoards([
      ...useBoardStore.getState().boards,
      { id: created.id, name: created.name, slug: created.slug, parent_id: created.parent_id },
    ]);
    close();
    navigateToBoard(created.slug);
  }

  async function submitRename(event: FormEvent) {
    event.preventDefault();
    if (!board) return;
    const name = draft.trim();
    if (!name || name === board.name) {
      close();
      return;
    }
    const updated = await renameBoard(board.id, name).catch(() => null);
    if (updated) useBoardStore.getState().renameBoardLocal(board.id, updated.name);
    close();
  }

  async function archive() {
    if (!board) return;
    const others = boards.filter((b) => b.id !== board.id);
    if (!window.confirm(`Archive “${board.name}”? Its tasks are kept but the board leaves the list.`)) {
      return;
    }
    close();
    await archiveBoard(board.id).catch(() => null);
    useBoardStore.getState().setBoards(others);
    if (others.length > 0) navigateToBoard(others[0].slug);
    else navigateHome();
  }

  return (
    <div className="brand popover-anchor">
      <span className="eyebrow">utd / live board</span>
      <button
        type="button"
        className="board-switch-button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <h1>{board.name}</h1>
        <span className="caret">▾</span>
      </button>
      {open && (
        <>
          <div className="menu-backdrop" onPointerDown={close} />
          <div
            ref={panelRef}
            className="popover popover-left"
            role="menu"
            aria-label="Boards"
            onKeyDown={(e) => e.key === "Escape" && close()}
          >
            {mode === "menu" && (
              <>
                <p className="menu-label">Boards</p>
                {treeRows(boards.filter((b) => b.kind !== "inbox")).map(({ board: b, depth }) => (
                  <button
                    key={b.id}
                    type="button"
                    role="menuitem"
                    className="menu-item board-tree-item"
                    style={{ paddingLeft: 9 + depth * 14 }}
                    onClick={() => {
                      close();
                      navigateToBoard(b.slug);
                    }}
                  >
                    <span>
                      {depth > 0 && <span className="board-tree-elbow" aria-hidden="true">└ </span>}
                      {b.name}
                    </span>
                    {b.id === board.id && <span className="menu-check">✓</span>}
                  </button>
                ))}
                <div className="menu-divider" role="separator" />
                <button
                  type="button"
                  role="menuitem"
                  className="menu-item"
                  onClick={() => {
                    close();
                    useBoardStore.getState().setFamilyOpen(true);
                  }}
                >
                  Board family…
                  <span className="menu-hint">nest &amp; re-parent</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="menu-item"
                  onClick={() => {
                    close();
                    useBoardStore.getState().setLanesOpen(true);
                  }}
                >
                  Lanes…
                  <span className="menu-hint">add, rename, final</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="menu-item"
                  onClick={() => setMode("calendar")}
                >
                  Calendar feed…
                  <span className="menu-hint">deadlines</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="menu-item"
                  onClick={() => {
                    setDraft("");
                    setMode("create");
                  }}
                >
                  New board…
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="menu-item"
                  onClick={() => {
                    setDraft(board.name);
                    setMode("rename");
                  }}
                >
                  Rename board…
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="menu-item menu-danger"
                  onClick={archive}
                >
                  Archive board
                </button>
              </>
            )}
            {mode === "calendar" && <CalendarFeed boardId={board.id} boardName={board.name} />}
            {(mode === "create" || mode === "rename") && (
              <form
                className="menu-form"
                onSubmit={mode === "create" ? submitCreate : submitRename}
              >
                <input
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder={
                    mode === "create" ? "New board name, then Enter" : "Board name, then Enter"
                  }
                  aria-label={mode === "create" ? "New board name" : "Rename board"}
                />
              </form>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** The board's deadlines (and its sub-boards') as a calendar to subscribe
 * to: one tap on the iPhone (webcal:), or copy the address. */
function CalendarFeed({ boardId, boardName }: { boardId: string; boardName: string }) {
  const url = `${window.location.origin}/api/boards/${boardId}/calendar.ics`;
  const webcal = url.replace(/^https?:/, "webcal:");
  const hasChildren = useBoardStore((s) => Object.keys(s.familyById).length > 0);
  const [copied, setCopied] = useState(false);
  return (
    <div className="calendar-feed">
      <p className="menu-label">Calendar feed</p>
      <p className="calendar-feed-intro">
        Every task with a deadline on <strong>{boardName}</strong>
        {hasChildren ? " and all its sub-boards" : ""}, as all-day events. Calendar apps refresh it
        on their own schedule.
      </p>
      <input className="calendar-feed-url" readOnly value={url} onFocus={(e) => e.target.select()} aria-label="Feed address" />
      <div className="calendar-feed-buttons">
        <a className="calendar-subscribe" href={webcal}>
          Subscribe
        </a>
        <button
          type="button"
          onClick={() => {
            copyText(url);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? "Copied" : "Copy address"}
        </button>
      </div>
    </div>
  );
}
