import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createTask } from "../api/client";
import { iconOf, pluginFor } from "../attachments/registry";
import { newOpId } from "../lib/compat";
import { filtersActive, passesFilters } from "../lib/filters";
import { dueLabel } from "../lib/cardColour";
import { figureFields } from "../lib/figureParse";
import { lookUpTitle as lookUp, parseQuickAdd, type Draft } from "../lib/quickAdd";
import { filesFrom, tasksFromFiles } from "../lib/uploads";
import { useBoardStore } from "../store/boardStore";

/** The header's quick add: type a task, paste a list (one task per line),
 * or paste links — each becomes a task of its kind (GitHub PR, page, map,
 * email, phone) with the link attached and a real title where one exists. */
export default function QuickAdd() {
  const board = useBoardStore((s) => s.board);
  const lanes = useBoardStore((s) => s.lanes);
  const [text, setText] = useState("");
  const [laneId, setLaneId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  /** Photos/files → a task each (a typed line titles a single one). */
  async function addFiles(files: File[]) {
    if (!lane || files.length === 0 || busy) return;
    setBusy(`Uploading ${files.length} file${files.length === 1 ? "" : "s"}…`);
    const typed = drafts.length === 1 ? drafts[0].title : undefined;
    const { created, errors } = await tasksFromFiles(files, lane.id, typed);
    setBusy(null);
    if (created.length && typed) setText("");
    setNotice(
      created.length
        ? `Added ${created.length} to ${lane.name}` + (errors.length ? ` · ${errors[0]}` : "")
        : errors[0] ?? "Couldn’t upload that",
    );
  }

  const lane = lanes.find((l) => l.id === laneId) ?? lanes[0];
  const drafts = useMemo(() => parseQuickAdd(text), [text]);
  const showPreview = focused && (drafts.length > 1 || drafts.some((d) => d.attachment || d.due || d.figures));

  // "n" anywhere on the board (not while typing) jumps here.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "n" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, select, [contenteditable]")) return;
      const s = useBoardStore.getState();
      if (s.detailTaskId || s.settingsOpen || s.familyOpen || s.lanesOpen || s.searchOpen || s.menu) return;
      e.preventDefault();
      ref.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Grow with the text, up to a few lines.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [text]);

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(t);
  }, [notice]);

  async function submit() {
    if (!board || !lane || drafts.length === 0 || busy) return;
    const lookups = drafts.filter((d) => d.lookup).length;
    setBusy(lookups ? `Looking up ${lookups} link${lookups === 1 ? "" : "s"}…` : "Adding…");
    const resolved: Draft[] = await Promise.all(
      drafts.map(async (d) => {
        const title = d.lookup ? await lookUp(d.lookup) : null;
        return title ? { ...d, title } : d;
      }),
    );
    setBusy("Adding…");
    const store = useBoardStore.getState();
    const created: string[] = [];
    const failedDrafts: Draft[] = [];
    // In order, so the lane reads in the order they were written.
    for (const d of resolved) {
      const opId = newOpId();
      store.registerOp(opId);
      try {
        const task = await createTask(board.id, {
          lane_id: lane.id,
          ...figureFields(d.title.slice(0, 300), d.figures, board.id),
          attachments: d.attachment ? [d.attachment] : undefined,
          due_date: d.due,
          meta: { op_id: opId, actor: "board-user" },
        });
        useBoardStore.getState().upsertTask(task);
        created.push(task.id);
      } catch {
        useBoardStore.getState().resolveOp(opId);
        failedDrafts.push(d);
      }
    }
    useBoardStore.getState().flashTasks(created, "pulse");
    const s = useBoardStore.getState();
    const f = { ownerFilter: s.ownerFilter, ownersById: s.ownersById, categoryFilter: s.categoryFilter, categoriesById: s.categoriesById };
    const hidden = filtersActive(f) ? created.filter((id) => s.tasksById[id] && !passesFilters(s.tasksById[id], f)).length : 0;
    setBusy(null);
    // Keep only what didn't make it, ready to retry.
    setText(failedDrafts.map((d) => d.title).join("\n"));
    setNotice(
      `Added ${created.length} to ${lane.name}` +
        (hidden ? ` (${hidden} hidden by filters)` : "") +
        (failedDrafts.length ? ` · ${failedDrafts.length} failed, left to retry` : ""),
    );
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape") {
      e.stopPropagation();
      setText("");
      ref.current?.blur();
    }
  }

  if (!board) return null;
  // The slot keeps the header's height; the bar floats in it and grows
  // downward over the board when several lines are pasted.
  return (
    <div className="quick-add-slot">
    <div className={`quick-add${focused ? " is-focused" : ""}`}>
      <span className="quick-add-icon" aria-hidden="true">
        +
      </span>
      <textarea
        ref={ref}
        rows={1}
        value={text}
        disabled={!!busy}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={(e) => {
          const files = filesFrom(e.clipboardData);
          if (files.length) {
            e.preventDefault();
            addFiles(files);
          }
        }}
        onDrop={(e) => {
          const files = filesFrom(e.dataTransfer);
          if (files.length) {
            e.preventDefault();
            addFiles(files);
          }
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={busy ?? notice ?? "Add tasks, links or a list…"}
        aria-label="Quick add: a task per line; links become tasks of their kind"
        enterKeyHint="done"
        spellCheck
      />
      <button
        type="button"
        className="quick-add-photo"
        onClick={() => fileRef.current?.click()}
        disabled={!!busy}
        aria-label="Add a task from a photo or file"
        title="Photo or file → a task (describe it later)"
      >
        📷
      </button>
      <input
        ref={fileRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          addFiles(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />
      {lanes.length > 1 && (
        <select
          className="quick-add-lane"
          value={lane?.id}
          onChange={(e) => setLaneId(e.target.value)}
          aria-label="Add to lane"
          title="Add to lane"
        >
          {lanes.map((l) => (
            <option key={l.id} value={l.id}>
              → {l.name}
            </option>
          ))}
        </select>
      )}
      <span className="sr-only" role="status">
        {busy ?? notice ?? ""}
      </span>
      {showPreview && (
        <ul className="quick-add-preview" aria-label="Will add">
          {drafts.slice(0, 8).map((d, i) => {
            const plugin = d.attachment ? pluginFor(d.attachment.kind) : null;
            return (
              <li key={i}>
                <span className="quick-add-kind" aria-hidden="true">
                  {plugin && d.attachment ? iconOf(plugin, d.attachment.data) : "•"}
                </span>
                <span className="quick-add-title">{d.title}</span>
                {d.due && <span className="badge badge-due">{dueLabel(d.due)}</span>}
                {d.figures?.map((f) => (
                  <span key={f.token} className="badge badge-rollup">
                    {f.token}
                  </span>
                ))}
                {d.lookup && <span className="menu-hint">title looked up</span>}
                {plugin && !d.lookup && <span className="menu-hint">{plugin.name}</span>}
              </li>
            );
          })}
          {drafts.length > 8 && <li className="quick-add-more">+{drafts.length - 8} more</li>}
          <li className="quick-add-foot">
            {drafts.length} task{drafts.length === 1 ? "" : "s"} → {lane?.name} · Enter to add · Shift+Enter new line
          </li>
        </ul>
      )}
    </div>
    </div>
  );
}
