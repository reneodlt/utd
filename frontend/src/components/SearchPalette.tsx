import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { search, type SearchResults } from "../api/client";
import { dueLabel } from "../lib/cardColour";
import { navigateToBoard, navigateToTask } from "../lib/route";
import { useBoardStore } from "../store/boardStore";

type Item =
  | { kind: "board"; id: string; name: string; slug: string }
  | { kind: "task"; task: SearchResults["tasks"][number] };

const EMPTY: SearchResults = { boards: [], tasks: [] };

/** Search button for the header (desktop and phone). */
export function SearchButton() {
  const setSearchOpen = useBoardStore((s) => s.setSearchOpen);
  return (
    <button
      type="button"
      className="theme-button search-button"
      onClick={() => setSearchOpen(true)}
      aria-label="Search all boards (⌘K)"
      title="Search all boards (⌘K or /)"
    >
      ⌕
    </button>
  );
}

/** ⌘K / Ctrl+K / "/" — find any task on any board (titles, details,
 * attachments) or jump to a board. Enter opens the task's details,
 * switching board first if it lives elsewhere. */
export function SearchPalette() {
  const open = useBoardStore((s) => s.searchOpen);
  const setSearchOpen = useBoardStore((s) => s.setSearchOpen);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResults>(EMPTY);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Global shortcuts.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const typing = (e.target as HTMLElement | null)?.closest("input, textarea, select, [contenteditable]");
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setSearchOpen(true);
      } else if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setSearchOpen]);

  useEffect(() => {
    if (open) {
      setActive(0);
      requestAnimationFrame(() => inputRef.current?.select());
    }
  }, [open]);

  // Debounced search; stale answers are ignored.
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length < 2) {
      setResults(EMPTY);
      setLoading(false);
      return;
    }
    let live = true;
    setLoading(true);
    const timer = window.setTimeout(() => {
      search(q)
        .then((r) => {
          if (!live) return;
          setResults(r);
          setActive(0);
        })
        .catch(() => live && setResults(EMPTY))
        .finally(() => live && setLoading(false));
    }, 150);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [query, open]);

  if (!open) return null;

  const items: Item[] = [
    ...results.boards.map((b) => ({ kind: "board" as const, ...b })),
    ...results.tasks.map((t) => ({ kind: "task" as const, task: t })),
  ];

  function choose(item: Item) {
    setSearchOpen(false);
    const s = useBoardStore.getState();
    if (item.kind === "board") {
      navigateToBoard(item.slug);
      return;
    }
    const { task } = item;
    const here = task.board.id === s.board?.id || task.board.id in s.familyById;
    if (here) s.openDetail(task.id);
    else navigateToTask(task.board.slug, task.id);
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.stopPropagation();
      setSearchOpen(false);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!items.length) return;
      const next = (active + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      setActive(next);
      listRef.current?.querySelectorAll("li[data-item]")[next]?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter" && items[active]) {
      e.preventDefault();
      choose(items[active]);
    }
  }

  let index = -1;
  const row = (item: Item, content: React.ReactNode, key: string) => {
    index += 1;
    const i = index;
    return (
      <li
        key={key}
        data-item
        role="option"
        aria-selected={i === active}
        className={`search-row${i === active ? " is-active" : ""}`}
        onMouseEnter={() => setActive(i)}
        onClick={() => choose(item)}
      >
        {content}
      </li>
    );
  };

  const q = query.trim();
  return (
    <>
      <div className="search-backdrop" onPointerDown={() => setSearchOpen(false)} />
      <div className="search-palette" role="dialog" aria-modal="true" aria-label="Search" onKeyDown={onKeyDown}>
        <div className="search-input-row">
          <span className="search-glyph" aria-hidden="true">
            ⌕
          </span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tasks and boards…"
            aria-label="Search tasks and boards"
            aria-controls="search-results"
            enterKeyHint="go"
            autoFocus
          />
          <kbd className="search-kbd">esc</kbd>
        </div>
        <ul id="search-results" ref={listRef} role="listbox" className="search-results">
          {q.length < 2 && <li className="search-hint">Type to search every board: titles, details and attachments.</li>}
          {q.length >= 2 && !loading && items.length === 0 && <li className="search-hint">Nothing matches “{q}”.</li>}
          {results.boards.length > 0 && <li className="search-group">Boards</li>}
          {results.boards.map((b) =>
            row(
              { kind: "board", ...b },
              <>
                <span className="search-kind" aria-hidden="true">
                  ▦
                </span>
                <span className="search-main">
                  <span className="search-title">{b.name}</span>
                </span>
                <span className="search-meta">board</span>
              </>,
              `b-${b.id}`,
            ),
          )}
          {results.tasks.length > 0 && <li className="search-group">Tasks</li>}
          {results.tasks.map((t) =>
            row(
              { kind: "task", task: t },
              <>
                <span className="search-kind" aria-hidden="true">
                  {t.state === "open" ? "◻" : t.state === "archived" ? "⌫" : "✕"}
                </span>
                <span className="search-main">
                  <span className={`search-title${t.state !== "open" ? " is-off" : ""}`}>{t.title}</span>
                  <span className="search-sub">
                    {t.parent_title && <>↳ {t.parent_title} · </>}
                    {t.board.name} · {t.lane}
                    {t.snippet && <> · <em>{t.snippet}</em></>}
                  </span>
                </span>
                <span className="search-meta">
                  {t.state !== "open" ? t.state : t.due_date ? dueLabel(t.due_date) : ""}
                </span>
              </>,
              `t-${t.id}`,
            ),
          )}
        </ul>
      </div>
    </>
  );
}
