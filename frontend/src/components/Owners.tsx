import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { QuickContacts } from "./OwnerContacts";
import { ContactsEditor, contactsFrom, draftsFrom, type ContactDraft } from "./OwnerContacts";
import { ownerMatches, useBoardOwners } from "../lib/boardOwners";
import { AutomationSettings } from "./Automations";
import {
  ApiError,
  archiveOwner,
  createOwner,
  setTaskOwners,
  updateOwner,
  type OwnerFields,
} from "../api/client";
import { newOpId } from "../lib/compat";
import { activeOwnersOf, readableOn, suggestCode, UNASSIGNED } from "../lib/owners";
import { useBoardStore } from "../store/boardStore";
import type { Owner, Task } from "../types";
import { CategorySettings } from "./Categories";
import FloatingPanel from "./FloatingPanel";
import { keepToControl } from "../lib/controls";

const NO_OWNERS: Owner[] = [];

/** The active owners, in their shared order. */
export function useActiveOwners(): Owner[] {
  const ownersById = useBoardStore((s) => s.ownersById);
  return useMemo(() => {
    const list = Object.values(ownersById).filter((o) => !o.archived);
    return list.length ? list.sort((a, b) => a.position - b.position) : NO_OWNERS;
  }, [ownersById]);
}

/** The one place an owner is drawn. Emoji if set, else the short code.
 * (Small logos would slot in here.) */
export function OwnerBadge({
  owner,
  size = "md",
}: {
  owner: Pick<Owner, "name" | "code" | "fg" | "bg" | "emoji">;
  size?: "sm" | "md" | "lg";
}) {
  const text = owner.emoji || owner.code || "?";
  return (
    <span
      className={`owner-badge owner-${size}${owner.emoji ? " is-emoji" : ""}`}
      style={{ "--owner-fg": owner.fg, "--owner-bg": owner.bg } as CSSProperties}
      title={owner.name}
    >
      {text}
    </span>
  );
}

/** Tick owners on and off a task; each tick saves straight away. */
function OwnerPicker({ task, anchor, onClose }: { task: Task; anchor: DOMRect; onClose: () => void }) {
  const { shortlist, others } = useBoardOwners();
  const setSettingsOpen = useBoardStore((s) => s.setSettingsOpen);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [query, setQuery] = useState("");

  async function toggle(ownerId: string) {
    const current = useBoardStore.getState().tasksById[task.id]?.owner_ids ?? task.owner_ids;
    const next = current.includes(ownerId)
      ? current.filter((id) => id !== ownerId)
      : [...current, ownerId];
    const store = useBoardStore.getState();
    const opId = newOpId();
    store.registerOp(opId);
    // Optimistic: the badge appears at once; the server's answer replaces it.
    store.upsertTask({ ...store.tasksById[task.id], owner_ids: next });
    try {
      const updated = await setTaskOwners(task.id, next, { op_id: opId, actor: "board-user" });
      useBoardStore.getState().upsertTask(updated);
      setError(null);
    } catch (e) {
      const state = useBoardStore.getState();
      state.resolveOp(opId);
      state.upsertTask({ ...state.tasksById[task.id], owner_ids: current });
      setError((e instanceof ApiError && e.detail) || "Couldn’t save that.");
    }
  }

  const liveIds = useBoardStore((s) => s.tasksById[task.id]?.owner_ids ?? task.owner_ids);

  return (
    <FloatingPanel anchor={anchor} onClose={onClose} label="Owners">
      <p className="menu-label">On this board</p>
      {shortlist.length === 0 && <p className="owner-empty">Nobody yet: pick someone below.</p>}
      {shortlist.map((owner) => (
        <OwnerOption key={owner.id} owner={owner} on={liveIds.includes(owner.id)} onToggle={() => toggle(owner.id)} />
      ))}
      {others.length > 0 &&
        (more || shortlist.length === 0 ? (
          <>
            <p className="menu-label">Everyone else</p>
            <input
              className="owner-search"
              autoFocus={shortlist.length > 0}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search people & companies"
              aria-label="Search people and companies"
            />
            <div className="owner-more-list">
              {others
                .filter((o) => ownerMatches(o, query))
                .map((owner) => (
                  <OwnerOption
                    key={owner.id}
                    owner={owner}
                    on={liveIds.includes(owner.id)}
                    onToggle={() => toggle(owner.id)}
                  />
                ))}
              {others.every((o) => !ownerMatches(o, query)) && <p className="owner-empty">No one matches.</p>}
            </div>
          </>
        ) : (
          <button type="button" className="menu-item owner-more-button" onClick={() => setMore(true)}>
            More people… <span className="menu-hint">{others.length}</span>
          </button>
        ))}
      {error && <p className="attach-error owner-error">{error}</p>}
      <div className="menu-divider" role="separator" />
      <button
        type="button"
        className="menu-item"
        onClick={() => {
          onClose();
          setSettingsOpen("people");
        }}
      >
        Manage people &amp; companies…
      </button>
    </FloatingPanel>
  );
}

function OwnerOption({ owner, on, onToggle }: { owner: Owner; on: boolean; onToggle: () => void }) {
  return (
    <div className="owner-option-row">
      <button
        type="button"
        role="menuitemcheckbox"
        aria-checked={on}
        className="menu-item owner-option"
        onClick={onToggle}
      >
        <OwnerBadge owner={owner} size="sm" />
        <span className="owner-option-name">{owner.name}</span>
        {on && <span className="menu-check">✓</span>}
      </button>
      <QuickContacts owner={owner} />
    </div>
  );
}

/** A task's owners, top right of its card; click to change them. An empty
 * slot shows a faint "+" on hover so owners can be added in place. */
export function OwnerStack({ task, interactive = true }: { task: Task; interactive?: boolean }) {
  const ownersById = useBoardStore((s) => s.ownersById);
  const owners = activeOwnersOf(task, ownersById);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const shown = owners.slice(0, 3);
  const more = owners.length - shown.length;

  const stack = (
    <>
      {shown.map((o) => (
        <OwnerBadge key={o.id} owner={o} size="sm" />
      ))}
      {more > 0 && <span className="owner-more">+{more}</span>}
      {owners.length === 0 && interactive && (
        <span className="owner-add" aria-hidden="true">
          +
        </span>
      )}
    </>
  );

  if (!interactive) {
    return owners.length ? <span className="owner-stack">{stack}</span> : null;
  }
  return (
    <>
      <button
        type="button"
        className={`owner-stack${owners.length ? "" : " is-empty"}${anchor ? " is-open" : ""}`}
        aria-label={owners.length ? `Owners: ${owners.map((o) => o.name).join(", ")}. Change` : "Add owner"}
        title={owners.length ? owners.map((o) => o.name).join(", ") : "Add owner"}
        {...keepToControl}
        onClick={(e) => {
          e.stopPropagation();
          setAnchor(e.currentTarget.getBoundingClientRect());
        }}
      >
        {stack}
      </button>
      {anchor && <OwnerPicker task={task} anchor={anchor} onClose={() => setAnchor(null)} />}
    </>
  );
}

/** Header control: show only tasks owned by any of the chosen owners
 * (or nobody). Nothing chosen = everything shown. */
export function OwnerFilter() {
  // Only people who own something on this board are worth filtering by
  // (plus anyone already chosen, so a filter can always be undone).
  const { shortlist, others } = useBoardOwners();
  const chosenIds = useBoardStore((s) => s.ownerFilter);
  const owners = [...shortlist, ...others.filter((o) => chosenIds.includes(o.id))];
  const filter = useBoardStore((s) => s.ownerFilter);
  const setOwnerFilter = useBoardStore((s) => s.setOwnerFilter);
  const setSettingsOpen = useBoardStore((s) => s.setSettingsOpen);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const chosen = owners.filter((o) => filter.includes(o.id));
  const unassigned = filter.includes(UNASSIGNED);

  const toggle = (id: string) =>
    setOwnerFilter(filter.includes(id) ? filter.filter((f) => f !== id) : [...filter, id]);

  return (
    <>
      <button
        type="button"
        className={`filter-chip${filter.length ? " is-active" : ""}`}
        aria-haspopup="menu"
        aria-expanded={!!anchor}
        onClick={(e) => setAnchor(e.currentTarget.getBoundingClientRect())}
        title="Filter by owner"
      >
        {filter.length === 0 ? (
          <>
            <span aria-hidden="true">⚲</span> Owners
          </>
        ) : (
          <>
            {chosen.slice(0, 4).map((o) => (
              <OwnerBadge key={o.id} owner={o} size="sm" />
            ))}
            {unassigned && <span className="filter-unassigned">none</span>}
            {chosen.length > 4 && <span className="owner-more">+{chosen.length - 4}</span>}
          </>
        )}
      </button>
      {filter.length > 0 && (
        <button
          type="button"
          className="filter-clear"
          onClick={() => setOwnerFilter([])}
          aria-label="Clear owner filter"
          title="Show everyone’s tasks"
        >
          ×
        </button>
      )}
      {anchor && (
        <FloatingPanel anchor={anchor} onClose={() => setAnchor(null)} label="Filter by owner">
          <p className="menu-label">Show tasks owned by</p>
          {owners.map((owner) => (
            <button
              key={owner.id}
              type="button"
              role="menuitemcheckbox"
              aria-checked={filter.includes(owner.id)}
              className="menu-item owner-option"
              onClick={() => toggle(owner.id)}
            >
              <OwnerBadge owner={owner} size="sm" />
              <span className="owner-option-name">{owner.name}</span>
              {filter.includes(owner.id) && <span className="menu-check">✓</span>}
            </button>
          ))}
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={unassigned}
            className="menu-item owner-option"
            onClick={() => toggle(UNASSIGNED)}
          >
            <span className="owner-badge owner-sm owner-none" aria-hidden="true">
              –
            </span>
            <span className="owner-option-name">No owner</span>
            {unassigned && <span className="menu-check">✓</span>}
          </button>
          <div className="menu-divider" role="separator" />
          {filter.length > 0 ? (
            <button type="button" className="menu-item" onClick={() => setOwnerFilter([])}>
              Show everyone
            </button>
          ) : (
            <p className="owner-empty">Pick any number; tasks matching any of them show.</p>
          )}
          <button
            type="button"
            className="menu-item"
            onClick={() => {
              setAnchor(null);
              setSettingsOpen("people");
            }}
          >
            Manage people &amp; companies…
          </button>
        </FloatingPanel>
      )}
    </>
  );
}

export function SettingsButton() {
  const setSettingsOpen = useBoardStore((s) => s.setSettingsOpen);
  return (
    <button
      type="button"
      className="theme-button"
      onClick={() => setSettingsOpen("people")}
      aria-label="Settings: people & companies"
      title="Settings"
    >
      ⚙
    </button>
  );
}

const SWATCHES = [
  "#4f46e5", "#2563eb", "#0891b2", "#0f766e", "#16a34a", "#ca8a04",
  "#ea580c", "#dc2626", "#db2777", "#9333ea", "#475569", "#111827",
  "#fde68a", "#bbf7d0", "#bfdbfe", "#fbcfe8", "#e5e7eb", "#ffffff",
];

const BLANK: OwnerFields = { name: "", code: "", fg: "#ffffff", bg: "#4f46e5", emoji: "" };

/** Settings: the shared list of people, teams and companies. */
export function SettingsPanel() {
  const open = useBoardStore((s) => s.settingsOpen);
  const setSettingsOpen = useBoardStore((s) => s.setSettingsOpen);
  const owners = useActiveOwners();
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    setEditing(null);
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setSettingsOpen(false);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      opener?.focus?.();
    };
  }, [open, setSettingsOpen]);

  if (!open) return null;
  return (
    <>
      <div className="drawer-backdrop" onPointerDown={() => setSettingsOpen(false)} />
      <aside className="drawer settings" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header className="drawer-header">
          <div className="drawer-heading">
            <span className="eyebrow">Settings</span>
            <h2 id="settings-title">
              {open === "categories" ? "Categories" : open === "automations" ? "Automations" : "People & companies"}
            </h2>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="drawer-close"
            onClick={() => setSettingsOpen(false)}
            aria-label="Close settings"
          >
            ×
          </button>
        </header>
        <div className="settings-tabs segmented" role="tablist" aria-label="Settings">
          <button
            type="button"
            role="tab"
            aria-selected={open === "people"}
            aria-pressed={open === "people"}
            onClick={() => setSettingsOpen("people")}
          >
            People &amp; companies
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={open === "categories"}
            aria-pressed={open === "categories"}
            onClick={() => setSettingsOpen("categories")}
          >
            Categories
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={open === "automations"}
            aria-pressed={open === "automations"}
            onClick={() => setSettingsOpen("automations")}
          >
            Automations
          </button>
        </div>
        {open === "automations" ? (
          <div className="drawer-scroll">
            <AutomationSettings />
          </div>
        ) : open === "categories" ? (
          <div className="drawer-scroll">
            <p className="settings-intro">
              Label tasks with any number of categories. A category is either this board’s own or
              shared by every board.
            </p>
            <CategorySettings />
          </div>
        ) : (
        <div className="drawer-scroll">
          <p className="settings-intro">
            Owners show at the top right of each card, and the board can be filtered by them.
            Shared by every board.
          </p>
          {editing === "new" ? (
            <OwnerForm onDone={() => setEditing(null)} />
          ) : (
            <button type="button" className="attach-add settings-add" onClick={() => setEditing("new")}>
              + Add person or company
            </button>
          )}
          <ul className="owner-list">
            {owners.map((owner) =>
              editing === owner.id ? (
                <li key={owner.id}>
                  <OwnerForm owner={owner} onDone={() => setEditing(null)} />
                </li>
              ) : (
                <li key={owner.id} className="owner-row">
                  <OwnerBadge owner={owner} size="lg" />
                  <div className="owner-row-main">
                    <p className="attachment-title">{owner.name}</p>
                    <p className="attachment-detail">
                      {owner.code}
                      {owner.emoji && ` · shown as ${owner.emoji}`}
                    </p>
                  </div>
                  <div className="attachment-tools">
                    <button
                      type="button"
                      title="Edit"
                      aria-label={`Edit ${owner.name}`}
                      onClick={() => setEditing(owner.id)}
                    >
                      ✎
                    </button>
                  </div>
                </li>
              ),
            )}
          </ul>
          {owners.length === 0 && editing !== "new" && (
            <p className="attachments-empty">Nobody yet. Add the people, teams or companies tasks belong to.</p>
          )}
        </div>
        )}
      </aside>
    </>
  );
}

function OwnerForm({ owner, onDone }: { owner?: Owner; onDone: () => void }) {
  const [fields, setFields] = useState<OwnerFields>(
    owner ? { name: owner.name, code: owner.code, fg: owner.fg, bg: owner.bg, emoji: owner.emoji } : BLANK,
  );
  // New owners get initials suggested from the name until the code is typed.
  const [codeTouched, setCodeTouched] = useState(!!owner);
  // Text colour follows the background (for contrast) until picked by hand.
  const [fgTouched, setFgTouched] = useState(!!owner && owner.fg !== readableOn(owner.bg));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [contacts, setContacts] = useState<ContactDraft[]>(() => draftsFrom(owner?.contacts));

  const set = (patch: Partial<OwnerFields>) => setFields((f) => ({ ...f, ...patch }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      const body = { ...fields, contacts: contactsFrom(contacts) };
      const saved = owner ? await updateOwner(owner.id, body) : await createOwner(body);
      // The websocket broadcast will say the same; apply now for snappiness.
      const state = useBoardStore.getState();
      state.setOwners([...Object.values(state.ownersById).filter((o) => o.id !== saved.id), saved]);
      onDone();
    } catch (e) {
      setError((e instanceof ApiError && e.detail) || "Couldn’t save that.");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!owner) return;
    try {
      await archiveOwner(owner.id);
      const state = useBoardStore.getState();
      state.setOwners(
        Object.values(state.ownersById).map((o) => (o.id === owner.id ? { ...o, archived: true } : o)),
      );
      onDone();
    } catch {
      setError("Couldn’t remove that.");
    }
  }

  return (
    <form className="attach-form owner-form" onSubmit={submit}>
      <div className="owner-preview">
        <OwnerBadge owner={fields} size="lg" />
        <div className="owner-preview-card">
          <span className="owner-preview-title">{fields.name || "Name"}</span>
          <OwnerBadge owner={fields} size="sm" />
        </div>
      </div>
      <label className="attach-field">
        <span>Name</span>
        <input
          autoFocus
          required
          maxLength={100}
          value={fields.name}
          placeholder="Ada Lovelace, Acme Ltd, Design team…"
          onChange={(e) =>
            set({ name: e.target.value, ...(codeTouched ? {} : { code: suggestCode(e.target.value) }) })
          }
        />
      </label>
      <div className="owner-form-row">
        <label className="attach-field">
          <span>Short code</span>
          <input
            required
            maxLength={5}
            value={fields.code}
            placeholder="AL"
            onChange={(e) => {
              setCodeTouched(true);
              set({ code: e.target.value });
            }}
          />
        </label>
        <label className="attach-field">
          <span>
            Emoji<em> optional, shown instead</em>
          </span>
          <input
            maxLength={16}
            value={fields.emoji}
            placeholder="e.g. a fox or a building"
            onChange={(e) => set({ emoji: e.target.value.trim() })}
          />
        </label>
      </div>
      <fieldset className="owner-colours">
        <legend>Background</legend>
        <div className="swatches">
          {SWATCHES.map((c) => (
            <button
              key={c}
              type="button"
              className="swatch"
              style={{ background: c }}
              aria-label={`Background ${c}`}
              aria-pressed={fields.bg === c}
              onClick={() => set({ bg: c, ...(fgTouched ? {} : { fg: readableOn(c) }) })}
            />
          ))}
          <label className="swatch swatch-custom" title="Custom colour">
            <input
              type="color"
              value={fields.bg}
              aria-label="Custom background colour"
              onChange={(e) =>
                set({ bg: e.target.value, ...(fgTouched ? {} : { fg: readableOn(e.target.value) }) })
              }
            />
          </label>
        </div>
      </fieldset>
      <fieldset className="owner-colours">
        <legend>
          Text {fgTouched ? "" : <em>· automatic</em>}
        </legend>
        <div className="swatches">
          {["#ffffff", "#111827", "#fde68a", "#1e3a8a", "#7f1d1d"].map((c) => (
            <button
              key={c}
              type="button"
              className="swatch"
              style={{ background: c }}
              aria-label={`Text ${c}`}
              aria-pressed={fields.fg === c}
              onClick={() => {
                setFgTouched(true);
                set({ fg: c });
              }}
            />
          ))}
          <label className="swatch swatch-custom" title="Custom colour">
            <input
              type="color"
              value={fields.fg}
              aria-label="Custom text colour"
              onChange={(e) => {
                setFgTouched(true);
                set({ fg: e.target.value });
              }}
            />
          </label>
          {fgTouched && (
            <button
              type="button"
              className="link-button owner-auto"
              onClick={() => {
                setFgTouched(false);
                set({ fg: readableOn(fields.bg) });
              }}
            >
              automatic
            </button>
          )}
        </div>
      </fieldset>
      <ContactsEditor drafts={contacts} onChange={setContacts} />
      {error && <p className="attach-error" role="alert">{error}</p>}
      <div className="attach-form-buttons">
        {owner &&
          (confirmRemove ? (
            <button type="button" className="owner-remove is-confirm" onClick={remove}>
              Remove {owner.code}?
            </button>
          ) : (
            <button type="button" className="owner-remove" onClick={() => setConfirmRemove(true)}>
              Remove
            </button>
          ))}
        <button type="button" onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={saving}>
          {saving ? "Saving…" : owner ? "Save" : "Add"}
        </button>
      </div>
    </form>
  );
}
