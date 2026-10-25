import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** Popover pinned to a trigger's screen position, portalled so lane
 * scrolling can't clip it. */
export default function FloatingPanel({
  anchor,
  onClose,
  label,
  className,
  children,
}: {
  anchor: DOMRect;
  onClose: () => void;
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: anchor.bottom + 6, left: anchor.right - 240 });

  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const left = Math.min(Math.max(8, anchor.right - width), window.innerWidth - width - 8);
    const below = anchor.bottom + 6;
    const top = below + height > window.innerHeight - 8 ? Math.max(8, anchor.top - height - 6) : below;
    setPos({ top, left });
    el.querySelector<HTMLElement>("input, [role=menuitemcheckbox], button")?.focus();
  }, [anchor]);

  // Escape closes this panel first, whatever has focus (a clicked control
  // may have unmounted, leaving focus on <body>) — caught in the capture
  // phase so the drawer or focus mode underneath don't also react.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  // React bubbles portal events to the React parent — here, the card —
  // so clicks in the panel would otherwise open the card or start a drag.
  const contain = (e: React.SyntheticEvent) => e.stopPropagation();
  return createPortal(
    <div
      className="floating-root"
      onClick={contain}
      onPointerDown={contain}
      onKeyDown={contain}
      onContextMenu={contain}
    >
      <div className="menu-backdrop" onPointerDown={onClose} />
      <div
        ref={panelRef}
        className={`popover owner-popover${className ? ` ${className}` : ""}`}
        role="menu"
        aria-label={label}
        style={{ position: "fixed", top: pos.top, left: pos.left }}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
