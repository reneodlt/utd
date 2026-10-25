import { useEffect, useState, type FormEvent } from "react";
import { createBoard, getBoards, getSnapshot } from "../api/client";
import { BoardFamilyPanel } from "./BoardFamily";
import { LanesPanel } from "./LanesPanel";
import { SearchPalette } from "./SearchPalette";
import UndoToast from "./UndoToast";
import { boardRefFromHash, clearTaskRef, navigateToBoard, taskRefFromHash } from "../lib/route";
import { useBoardStore } from "../store/boardStore";
import { BoardSocket } from "../ws/socket";
import BoardHeader from "./BoardHeader";
import CardDrawer from "./CardDrawer";
import KanbanBoard from "./KanbanBoard";
import InboxView from "./InboxView";
import AgendaView from "./AgendaView";
import MapView from "./MapView";
import { OffBoardList } from "./OffBoard";
import { SettingsPanel } from "./Owners";
import TaskContextMenu from "./TaskContextMenu";

const BOARDS_RETRY_MS = 2000;

type Phase = "loading" | "empty" | "ready";

export default function BoardPage() {
  const board = useBoardStore((s) => s.board);
  const status = useBoardStore((s) => s.status);
  const view = useBoardStore((s) => s.view);
  const [phase, setPhase] = useState<Phase>("loading");
  const [activeBoardId, setActiveBoardId] = useState<string | null>(null);

  // Load the board list, resolve #/b/<slug> to a board, follow hash changes.
  useEffect(() => {
    let cancelled = false;
    let retry: number | null = null;

    const resolveActive = () => {
      const boards = useBoardStore.getState().boards;
      const ref = boardRefFromHash();
      // The inbox opens by address (or its header button), never by default.
      const match =
        boards.find((b) => b.slug === ref || b.id === ref) ?? boards.find((b) => b.kind !== "inbox");
      if (!match) {
        setPhase("empty");
        setActiveBoardId(null);
        return;
      }
      setPhase("ready");
      setActiveBoardId(match.id);
      navigateToBoard(match.slug, true); // normalize/repair the hash
    };

    const load = async () => {
      try {
        const boards = await getBoards();
        if (cancelled) return;
        useBoardStore.getState().setBoards(boards);
        resolveActive();
      } catch {
        if (!cancelled) retry = window.setTimeout(load, BOARDS_RETRY_MS);
      }
    };

    load();
    window.addEventListener("hashchange", resolveActive);
    return () => {
      cancelled = true;
      if (retry !== null) window.clearTimeout(retry);
      window.removeEventListener("hashchange", resolveActive);
    };
  }, []);

  // One websocket per active board; snapshot hydration rides on sync.hello.
  useEffect(() => {
    if (!activeBoardId) return;
    useBoardStore.getState().resetForBoard();

    const resync = () =>
      getSnapshot(activeBoardId)
        .then((snapshot) => useBoardStore.getState().loadSnapshot(snapshot))
        .catch(() => useBoardStore.getState().setStatus("reconnecting"));

    const socket = new BoardSocket(activeBoardId, {
      onStatus: (s) => useBoardStore.getState().setStatus(s),
      onEvent: (event) => {
        // A frame from a socket we've already left behind must not leak in.
        // Descendant boards' events are ours too: this board shows their tasks.
        if ("board_id" in event && event.board_id !== activeBoardId) {
          const s = useBoardStore.getState();
          // A task moving off this board to another still has to reach us,
          // so its card goes.
          const leaving = "task" in event && !!s.tasksById[event.task.id];
          if (!(event.board_id in s.familyById) && !leaving) return;
        }
        if (event.type === "lanes.changed") {
          resync(); // this board's (or a sub-board's) lanes changed
          return;
        }
        if (event.type === "boards.changed") {
          // Board tree or names changed: refresh the list, and this board's
          // family (which tasks it shows) with a fresh snapshot.
          getBoards()
            .then((list) => useBoardStore.getState().setBoards(list))
            .catch(() => {});
          resync();
          return;
        }
        if (event.type === "sync.hello") {
          const state = useBoardStore.getState();
          // Re-hydrate on first connect and whenever events were missed.
          if (!state.board || event.last_event_id > state.lastEventId) resync();
          return;
        }
        useBoardStore.getState().applyEvent(event);
      },
    });
    socket.open();
    return () => socket.close();
  }, [activeBoardId]);

  // Escape leaves focus mode, unless a menu or the drawer should take it
  // first, or the user is typing.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const state = useBoardStore.getState();
      if (!state.focusTaskId || state.menu || state.detailTaskId || state.settingsOpen || state.searchOpen) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable]")) return;
      state.setFocus(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // "#/b/<board>/t/<task>" (search results, calendar events): open that
  // card once its board is loaded, then tidy the address.
  const loadedBoardId = board?.id;
  useEffect(() => {
    const openFromHash = () => {
      const taskId = taskRefFromHash();
      const s = useBoardStore.getState();
      if (!taskId || !s.board) return;
      const ref = boardRefFromHash();
      if (ref !== s.board.slug && ref !== s.board.id) return; // still switching boards
      s.openDetail(taskId);
      clearTaskRef();
    };
    openFromHash();
    window.addEventListener("hashchange", openFromHash);
    return () => window.removeEventListener("hashchange", openFromHash);
  }, [loadedBoardId]);

  useEffect(() => {
    const timer = window.setInterval(
      () => useBoardStore.getState().tickMinute(),
      60_000,
    );
    return () => window.clearInterval(timer);
  }, []);

  if (phase === "empty") return <FirstBoard />;

  if (!board) {
    return (
      <div className="boot">
        <span className="boot-dot" />
        {status === "reconnecting" ? "Reconnecting to the board server…" : "Connecting…"}
      </div>
    );
  }

  return (
    <div className="board-page">
      <BoardHeader />
      {view === "open" ? (
        board.kind === "inbox" ? <InboxView /> : <KanbanBoard />
      ) : view === "today" ? (
        <AgendaView />
      ) : view === "map" ? (
        <MapView />
      ) : (
        <OffBoardList key={view} state={view} />
      )}
      <TaskContextMenu />
      <CardDrawer />
      <SettingsPanel />
      <BoardFamilyPanel />
      <LanesPanel />
      <SearchPalette />
      <UndoToast />
    </div>
  );
}

/** First run against an empty database: create the first board inline. */
function FirstBoard() {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      const created = await createBoard(trimmed);
      const boards = useBoardStore.getState().boards;
      useBoardStore
        .getState()
        .setBoards([...boards, { id: created.id, name: created.name, slug: created.slug, parent_id: created.parent_id }]);
      navigateToBoard(created.slug);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="empty-state">
      <span className="eyebrow">utd / live board</span>
      <h1>Name your first board</h1>
      <form onSubmit={submit}>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Personal, Work…"
          aria-label="Board name"
        />
        <button type="submit" disabled={busy}>
          Create
        </button>
      </form>
    </div>
  );
}
