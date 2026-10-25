import { useEffect, useState } from "react";
import { useBoardStore } from "../store/boardStore";

const SHOW_MS = 6000;

/** "Archived “X” · Undo" — the last undoable action, for a few seconds.
 * ⌘Z / Ctrl+Z (outside text fields) does the same. Undo is itself an
 * ordinary, audited change (the reverse move, a restore…). */
export default function UndoToast() {
  const undo = useBoardStore((s) => s.undo);
  const clearUndo = useBoardStore((s) => s.clearUndo);
  const [state, setState] = useState<"idle" | "working" | "done" | "failed">("idle");

  async function run() {
    const offer = useBoardStore.getState().undo;
    if (!offer || state === "working") return;
    setState("working");
    try {
      await offer.run();
      setState("done");
    } catch {
      setState("failed");
    }
    window.setTimeout(() => {
      if (useBoardStore.getState().undo?.id === offer.id) clearUndo();
      setState("idle");
    }, 1400);
  }

  useEffect(() => {
    if (!undo) return;
    setState("idle");
    const timer = window.setTimeout(() => {
      if (useBoardStore.getState().undo?.id === undo.id) clearUndo();
    }, SHOW_MS);
    return () => window.clearTimeout(timer);
  }, [undo, clearUndo]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.key === "z" || e.key === "Z") || !(e.metaKey || e.ctrlKey) || e.shiftKey) return;
      if ((e.target as HTMLElement | null)?.closest("input, textarea, select, [contenteditable]")) return;
      if (!useBoardStore.getState().undo) return;
      e.preventDefault();
      run();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!undo) return null;
  return (
    <div className="undo-toast" role="status" aria-live="polite">
      <span className="undo-label">
        {state === "done" ? "Undone" : state === "failed" ? "Couldn’t undo that" : undo.label}
      </span>
      {state === "idle" && (
        <button type="button" onClick={run}>
          Undo
        </button>
      )}
      {state === "idle" && (
        <button type="button" className="undo-close" aria-label="Dismiss" onClick={clearUndo}>
          ×
        </button>
      )}
    </div>
  );
}
