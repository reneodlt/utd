import { useEffect, useState } from "react";
import { BoardTotal } from "./Figures";
import { getBoards } from "../api/client";
import { navigateToBoard } from "../lib/route";
import { formatDuration } from "../lib/time";
import { useBoardStore } from "../store/boardStore";
import type { Analytics } from "../types";
import BoardSwitcher from "./BoardSwitcher";
import ConnectionBadge from "./ConnectionBadge";
import { CategoryFilter } from "./Categories";
import { ColourBySelect } from "./ColourBy";
import { ViewSwitch } from "./OffBoard";
import { OwnerFilter, SettingsButton } from "./Owners";
import ThemeSwitcher from "./ThemeSwitcher";
import PhoneControls from "./PhoneControls";
import QuickAdd from "./QuickAdd";
import { SearchButton } from "./SearchPalette";
import { useIsPhone } from "../lib/useIsPhone";

/** Live flow metrics computed server-side from the audit trail. */
function FlowStats() {
  const boardId = useBoardStore((s) => s.board?.id);
  const lastEventId = useBoardStore((s) => s.lastEventId);
  const [stats, setStats] = useState<Analytics | null>(null);

  useEffect(() => {
    if (!boardId) return;
    let live = true;
    fetch(`/api/boards/${boardId}/analytics/`)
      .then((r) => r.json())
      .then((data) => live && setStats(data))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [boardId, lastEventId]);

  if (!stats || stats.cycle_time.completed === 0) return null;
  const residency = stats.lanes
    .filter((lane) => lane.avg_residency_seconds !== null)
    .map((lane) => `${lane.name}: avg ${formatDuration(lane.avg_residency_seconds!)}`)
    .join("\n");
  return (
    <span
      className="flow-chip"
      title={`Cycle time p50/p85 (create → done) and completions in the last 7 days.\n\n${residency}`}
    >
      cycle {formatDuration(stats.cycle_time.p50_seconds ?? 0)}
      {stats.cycle_time.p85_seconds !== null &&
        ` / p85 ${formatDuration(stats.cycle_time.p85_seconds)}`}
      {" · "}
      {stats.throughput.last_7d} done/7d
    </span>
  );
}

/** Shown while focus mode is on: names the task and turns focus off. */
function FocusChip() {
  const task = useBoardStore((s) => (s.focusTaskId ? s.tasksById[s.focusTaskId] : undefined));
  const setFocus = useBoardStore((s) => s.setFocus);
  const openDetail = useBoardStore((s) => s.openDetail);
  if (!task) return null;
  return (
    <span className="focus-chip">
      <button type="button" className="focus-chip-title" onClick={() => openDetail(task.id)}>
        <span aria-hidden="true">◉</span> Focus: {task.title}
      </button>
      <button
        type="button"
        className="focus-chip-clear"
        onClick={() => setFocus(null)}
        aria-label="Leave focus"
        title="Leave focus (Esc)"
      >
        ×
      </button>
    </span>
  );
}

/** Jump to the inbox, with how many notes are waiting there. */
function InboxButton() {
  const boards = useBoardStore((s) => s.boards);
  const board = useBoardStore((s) => s.board);
  const here = board?.kind === "inbox";
  const localCount = useBoardStore((s) => (here ? Object.values(s.tasksById).filter((t) => !t.parent_id).length : 0));
  const inbox = boards.find((b) => b.kind === "inbox");

  // Other boards don't hear about the inbox's changes: refresh now and then.
  useEffect(() => {
    const refresh = () =>
      getBoards()
        .then((list) => useBoardStore.getState().setBoards(list))
        .catch(() => {});
    const timer = window.setInterval(refresh, 60_000);
    const onVisible = () => document.visibilityState === "visible" && refresh();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  if (!inbox) return null;
  const count = here ? localCount : (inbox.open_count ?? 0);
  return (
    <button
      type="button"
      className={`inbox-button${here ? " is-here" : ""}`}
      aria-label={`Inbox, ${count} waiting`}
      title={here ? "You’re in the inbox" : "Inbox: notes waiting for a board"}
      onClick={() => navigateToBoard(inbox.slug)}
    >
      <span aria-hidden="true">⇩</span> Inbox
      {count > 0 && <span className="inbox-count">{count}</span>}
    </button>
  );
}

export default function BoardHeader() {
  const phone = useIsPhone();
  const inboxHere = useBoardStore((s) => s.board?.kind === "inbox");

  if (phone) {
    return (
      <header className="board-header is-phone">
        <BoardSwitcher />
        <ConnectionBadge />
        <InboxButton />
        <SearchButton />
        <PhoneControls />
        <FocusChip />
        {!inboxHere && <QuickAdd />}
      </header>
    );
  }

  return (
    <header className="board-header">
      <BoardSwitcher />
      <InboxButton />

      {!inboxHere && <QuickAdd />}

      <ViewSwitch />
      <FocusChip />
      <div className="owner-filter">
        <OwnerFilter />
      </div>
      <div className="owner-filter">
        <CategoryFilter />
      </div>
      <ColourBySelect />
      <BoardTotal />
      <FlowStats />
      <ConnectionBadge />
      <SearchButton />
      <ThemeSwitcher />
      <SettingsButton />
    </header>
  );
}
