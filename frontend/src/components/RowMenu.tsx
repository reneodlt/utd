import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

export interface RowMenuItem {
  label: string;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export interface RowMenuState<T> {
  item: T;
  x: number;
  y: number;
}

/** Right-click (or ⋯) menu for a row in the Archived, Deleted and Today
 * lists: the same look and keys as a card's menu, with whatever actions
 * fit that list. */
export function RowMenu({
  x,
  y,
  title,
  id,
  items,
  onClose,
}: {
  x: number;
  y: number;
  title: string;
  id: string;
  items: (RowMenuItem | "divider")[];
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPos({
      left: Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)),
    });
  }, [x, y]);

  useEffect(() => {
    panelRef.current?.querySelector<HTMLElement>("[role=menuitem]:not(:disabled)")?.focus();
  }, []);

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const buttons = Array.from(panelRef.current?.querySelectorAll<HTMLElement>("[role=menuitem]:not(:disabled)") ?? []);
    if (!buttons.length) return;
    event.preventDefault();
    const current = buttons.indexOf(document.activeElement as HTMLElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    buttons[(current + step + buttons.length) % buttons.length].focus();
  }

  return (
    <>
      <div
        className="menu-backdrop"
        onPointerDown={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div
        ref={panelRef}
        className="context-menu"
        role="menu"
        aria-label={`Actions for ${title}`}
        style={pos}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <header className="menu-header">
          <span className="menu-title">{title}</span>
          <span className="menu-id">{id.slice(0, 8)}</span>
        </header>
        {items.map((item, i) =>
          item === "divider" ? (
            <div key={`d${i}`} className="menu-divider" role="separator" />
          ) : (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={`menu-item${item.danger ? " menu-danger" : ""}`}
              disabled={item.disabled}
              onClick={() => {
                onClose();
                item.onSelect();
              }}
            >
              {item.label}
              {item.hint && <span className="menu-hint">{item.hint}</span>}
            </button>
          ),
        )}
      </div>
    </>
  );
}

/** The ⋯ button that opens a row's menu (touch has no right-click). */
export function RowMenuButton({ label, onOpen }: { label: string; onOpen: (x: number, y: number) => void }) {
  return (
    <button
      type="button"
      className="row-menu-button"
      aria-label={`More actions for ${label}`}
      title="More actions"
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        onOpen(r.right - 200, r.bottom + 4);
      }}
    >
      ⋯
    </button>
  );
}
