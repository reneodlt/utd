import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { ApiError, createRule, getRuleRuns, getRules, updateRule, type RuleDraft } from "../api/client";
import { relativeTime } from "../lib/history";
import { navigateToTask } from "../lib/route";
import {
  ACTION_CHOICES,
  CONDITION_CHOICES,
  TEMPLATES,
  WHEN_CHOICES,
  describeRule,
  itemsFromText,
  textFromItems,
  type Names,
} from "../lib/rules";
import { useBoardStore } from "../store/boardStore";
import type { Rule, RuleAction, RuleCondition, RuleRunRecord, RuleTrigger } from "../types";
import { useActiveCategories } from "./Categories";
import { useBoardOwners } from "../lib/boardOwners";

type Draft = RuleDraft;

/** Settings tab: this board's automations as plain sentences — switch
 * them on and off, see what they did, edit or add them. */
export function AutomationSettings() {
  const board = useBoardStore((s) => s.board);
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ rule?: Rule; draft: Draft } | null>(null);
  const [choosing, setChoosing] = useState(false);
  const names = useNames(rules);

  const load = useCallback(() => {
    if (!board) return;
    getRules(board.id)
      .then((list) => {
        setRules(list);
        setError(null);
      })
      .catch(() => setError("Couldn’t load the automations."));
  }, [board]);
  useEffect(load, [load]);

  if (!board) return null;
  const own = (rules ?? []).filter((r) => !r.inherited);
  const inherited = (rules ?? []).filter((r) => r.inherited);

  async function toggle(rule: Rule) {
    setRules((list) => list?.map((r) => (r.id === rule.id ? { ...r, enabled: !r.enabled } : r)) ?? null);
    try {
      await updateRule(rule.id, { enabled: !rule.enabled });
    } catch {
      setError("Couldn’t switch that.");
      load();
    }
  }

  if (editing) {
    return (
      <RuleEditor
        rule={editing.rule}
        initial={editing.draft}
        names={names}
        onDone={() => {
          setEditing(null);
          load();
        }}
      />
    );
  }

  return (
    <div className="automations">
      <p className="settings-intro">
        When something happens on {board.name}, do something for you. Automations act like a person would: it all shows
        in the card’s history, and can be undone.
      </p>
      {choosing ? (
        <div className="rule-templates">
          <p className="menu-label">Start from…</p>
          {TEMPLATES.map((t) => (
            <button
              key={t.label}
              type="button"
              className="rule-template"
              onClick={() => {
                setChoosing(false);
                setEditing({ draft: { ...t.rule, scope: "board" } });
              }}
            >
              {t.label}
            </button>
          ))}
          <button
            type="button"
            className="rule-template"
            onClick={() => {
              setChoosing(false);
              setEditing({
                draft: { name: "", scope: "board", trigger: { when: "moved" }, conditions: [], actions: [] },
              });
            }}
          >
            A blank automation
          </button>
          <button type="button" className="link-button" onClick={() => setChoosing(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <button type="button" className="attach-add settings-add" onClick={() => setChoosing(true)}>
          + New automation
        </button>
      )}
      {error && <p className="attach-error">{error}</p>}
      {rules === null && !error && <p className="history-empty">Loading…</p>}
      {rules !== null && own.length === 0 && <p className="attachments-empty">No automations on this board yet.</p>}
      <ul className="rule-list">
        {own.map((rule) => (
          <RuleRow
            key={rule.id}
            rule={rule}
            names={names}
            onToggle={() => toggle(rule)}
            onEdit={() =>
              setEditing({
                rule,
                draft: {
                  name: rule.name,
                  scope: rule.scope,
                  trigger: rule.trigger,
                  conditions: rule.conditions,
                  actions: rule.actions,
                },
              })
            }
          />
        ))}
      </ul>
      {inherited.length > 0 && (
        <>
          <h3 className="rule-group">From parent boards</h3>
          <ul className="rule-list">
            {inherited.map((rule) => (
              <RuleRow key={rule.id} rule={rule} names={names} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** Names for lanes, categories and owners: this board's, plus what each
 * rule brought with it (a parent board's lanes, removed things). */
function useNames(rules: Rule[] | null): Names {
  const lanes = useBoardStore((s) => s.lanes);
  const categoriesById = useBoardStore((s) => s.categoriesById);
  const ownersById = useBoardStore((s) => s.ownersById);
  return useMemo(() => {
    const map: Record<string, string> = {};
    for (const r of rules ?? []) Object.assign(map, r.names);
    for (const l of lanes) map[l.id] = l.name;
    for (const c of Object.values(categoriesById)) map[c.id] = c.name;
    for (const o of Object.values(ownersById)) map[o.id] = o.name;
    return { of: (id) => (id ? (map[id] ?? "something removed") : "—") };
  }, [rules, lanes, categoriesById, ownersById]);
}

function RuleRow({
  rule,
  names,
  onToggle,
  onEdit,
}: {
  rule: Rule;
  names: Names;
  onToggle?: () => void;
  onEdit?: () => void;
}) {
  const [showRuns, setShowRuns] = useState(false);
  const text = describeRule(rule, names);
  return (
    <li className={`rule-row${rule.enabled ? "" : " is-off"}${rule.problems.length ? " has-problems" : ""}`}>
      <div className="rule-sentence">
        <span className="rule-when">{text.when}</span>
        {text.onlyIf && <span className="rule-if">{text.onlyIf}</span>}
        <span className="rule-then">→ {text.then}</span>
      </div>
      <div className="rule-meta">
        <span className="rule-name">{rule.name}</span>
        {rule.scope === "family" && <span className="rule-tag">+ sub-boards</span>}
        {rule.inherited && <span className="rule-tag">from {rule.board_name}</span>}
        <button type="button" className="link-button rule-runs-link" onClick={() => setShowRuns((v) => !v)}>
          {rule.runs === 0
            ? "hasn’t run yet"
            : `ran ${rule.runs} time${rule.runs === 1 ? "" : "s"}${rule.last_run ? ` · last ${relativeTime(rule.last_run)}` : ""}`}
          {rule.failed_runs > 0 && ` · ${rule.failed_runs} with problems`}
        </button>
        <span className="rule-tools">
          {onToggle && (
            <label className="switch" title={rule.enabled ? "On: click to pause" : "Paused: click to switch on"}>
              <input type="checkbox" checked={rule.enabled} onChange={onToggle} aria-label={`${rule.name} on`} />
              <span aria-hidden="true" />
            </label>
          )}
          {onEdit && (
            <button type="button" className="rule-edit" onClick={onEdit} aria-label={`Edit ${rule.name}`} title="Edit">
              ✎
            </button>
          )}
        </span>
      </div>
      {rule.problems.length > 0 && (
        <ul className="rule-problems">
          {rule.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {showRuns && <RunsList ruleId={rule.id} />}
    </li>
  );
}

function RunsList({ ruleId }: { ruleId: string }) {
  const [runs, setRuns] = useState<RuleRunRecord[] | null>(null);
  const boardSlug = useBoardStore((s) => s.board?.slug);
  const openDetail = useBoardStore((s) => s.openDetail);
  useEffect(() => {
    getRuleRuns(ruleId)
      .then((r) => setRuns(r.runs))
      .catch(() => setRuns([]));
  }, [ruleId]);
  if (runs === null) return <p className="history-empty">Loading…</p>;
  if (runs.length === 0) return <p className="attachments-empty">Nothing yet.</p>;
  return (
    <ol className="rule-runs">
      {runs.map((run, i) => (
        <li key={`${run.task_id}-${i}`} className={run.error ? "has-error" : undefined}>
          <button
            type="button"
            className="link-button"
            onClick={() => {
              const s = useBoardStore.getState();
              s.setSettingsOpen(false);
              if (s.tasksById[run.task_id]) openDetail(run.task_id);
              else navigateToTask(run.board_slug, run.task_id);
            }}
          >
            {run.task_title}
          </button>
          {run.board_slug !== boardSlug && <span className="rule-run-board">{run.board_name}</span>}
          <span className="rule-run-when">{relativeTime(run.created_at)}</span>
          {run.error && <span className="rule-run-error">{run.error}</span>}
        </li>
      ))}
    </ol>
  );
}

// ---------- the editor ----------

function RuleEditor({
  rule,
  initial,
  names,
  onDone,
}: {
  rule?: Rule;
  initial: Draft;
  names: Names;
  onDone: () => void;
}) {
  const board = useBoardStore((s) => s.board)!;
  const lanes = useBoardStore((s) => s.lanes);
  const hasFamily = useBoardStore((s) => Object.keys(s.familyById).length > 0);
  const categories = useActiveCategories().filter((c) => c.board_id === null || c.board_id === board.id);
  const { shortlist, others } = useBoardOwners();
  const owners = [...shortlist, ...others];
  const ownerOptions = (
    <>
      {shortlist.length > 0 && (
        <optgroup label="On this board">
          {shortlist.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </optgroup>
      )}
      {others.length > 0 && (
        <optgroup label="Everyone else">
          {others.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </optgroup>
      )}
    </>
  );
  const animations = board.animation_catalogue.enabled ?? ["celebrate"];
  const [draft, setDraft] = useState<Draft>(initial);
  // Subtask lists are typed like quick add; kept as text while editing.
  const [texts, setTexts] = useState<Record<number, string>>(() =>
    Object.fromEntries(
      initial.actions.flatMap((a, i) => (a.type === "create_subtasks" ? [[i, textFromItems(a.items)]] : [])),
    ),
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const setTrigger = (t: Partial<RuleTrigger>) => setDraft((d) => ({ ...d, trigger: { ...d.trigger, ...t } }));
  const setCondition = (i: number, c: RuleCondition | null) =>
    setDraft((d) => ({
      ...d,
      conditions: c === null ? d.conditions.filter((_, j) => j !== i) : d.conditions.map((x, j) => (j === i ? c : x)),
    }));
  const setAction = (i: number, a: RuleAction | null) => {
    setDraft((d) => ({
      ...d,
      actions: a === null ? d.actions.filter((_, j) => j !== i) : d.actions.map((x, j) => (j === i ? a : x)),
    }));
    // Subtask texts are kept by position: close the gap a removal leaves.
    if (a === null)
      setTexts((t) =>
        Object.fromEntries(
          Object.entries(t).flatMap(([k, v]) => {
            const j = Number(k);
            return j === i ? [] : [[j > i ? j - 1 : j, v]];
          }),
        ),
      );
  };

  /** The draft with subtask texts turned into items, ready to save/preview. */
  const resolved = (): Draft => ({
    ...draft,
    actions: draft.actions.map((a, i) =>
      a.type === "create_subtasks" ? { ...a, items: itemsFromText(texts[i] ?? "", board.id, a.items) } : a,
    ),
  });
  const preview = describeRule(resolved(), names);

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const body = resolved();
      if (rule) await updateRule(rule.id, body);
      else await createRule(board.id, body);
      onDone();
    } catch (err) {
      const detail = err instanceof ApiError && err.detail;
      setError(detail ? detail.charAt(0).toUpperCase() + detail.slice(1) + "." : "Couldn’t save that.");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!rule) return;
    try {
      await updateRule(rule.id, { archived: true });
      useBoardStore.getState().offerUndo(`Removed the automation “${rule.name}”`, () =>
        updateRule(rule.id, { archived: false }),
      );
      onDone();
    } catch {
      setError("Couldn’t remove it.");
    }
  }

  const laneOptions = lanes.map((l) => (
    <option key={l.id} value={l.id}>
      {l.name}
      {l.is_final ? " (final)" : ""}
    </option>
  ));
  const categoryOptions = categories.map((c) => (
    <option key={c.id} value={c.id}>
      {c.name}
    </option>
  ));

  return (
    <form className="rule-editor" onSubmit={save}>
      <div className="rule-preview" aria-live="polite">
        <span className="rule-when">{preview.when}</span>
        {preview.onlyIf && <span className="rule-if">{preview.onlyIf}</span>}
        <span className="rule-then">→ {preview.then || "…"}</span>
      </div>

      <label className="attach-field">
        <span>Name</span>
        <input
          required
          maxLength={100}
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          placeholder="e.g. review-checklist"
        />
      </label>

      <fieldset className="rule-part">
        <legend>When</legend>
        <select
          value={draft.trigger.when}
          onChange={(e) => setDraft({ ...draft, trigger: { when: e.target.value as RuleTrigger["when"] } })}
          aria-label="When"
        >
          {WHEN_CHOICES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
        {draft.trigger.when === "moved" && (
          <>
            <select
              value={draft.trigger.final ? "final" : (draft.trigger.lane ?? "")}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  trigger: {
                    when: "moved",
                    ...(e.target.value === "final" ? { final: true } : e.target.value ? { lane: e.target.value } : {}),
                    ...(draft.trigger.from_lane ? { from_lane: draft.trigger.from_lane } : {}),
                  },
                })
              }
              aria-label="Into"
            >
              <option value="">any lane</option>
              <option value="final">a final lane (whichever is final)</option>
              {laneOptions}
            </select>
            <label className="rule-inline">
              from
              <select
                value={draft.trigger.from_lane ?? ""}
                onChange={(e) => setTrigger({ from_lane: e.target.value || undefined })}
                aria-label="From"
              >
                <option value="">anywhere</option>
                {laneOptions}
              </select>
            </label>
          </>
        )}
        {draft.trigger.when === "created" && (
          <select
            value={draft.trigger.lane ?? ""}
            onChange={(e) => setDraft({ ...draft, trigger: { when: "created", ...(e.target.value ? { lane: e.target.value } : {}) } })}
            aria-label="In"
          >
            <option value="">in any lane</option>
            {laneOptions}
          </select>
        )}
        {WHEN_CHOICES.find((c) => c.value === draft.trigger.when)?.hint && (
          <p className="attachments-empty">{WHEN_CHOICES.find((c) => c.value === draft.trigger.when)?.hint}.</p>
        )}
      </fieldset>

      <fieldset className="rule-part">
        <legend>Only if</legend>
        {draft.conditions.length === 0 && <p className="attachments-empty">Always (add a condition to narrow it down).</p>}
        {draft.conditions.map((c, i) => (
          <div key={i} className="rule-line">
            <select
              value={c.type === "has_category" && c.negate ? "lacks_category" : c.type}
              onChange={(e) => setCondition(i, blankCondition(e.target.value, categories[0]?.id, owners[0]?.id))}
              aria-label="Condition"
            >
              {CONDITION_CHOICES.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            {c.type === "title_contains" && (
              <input
                value={c.text}
                onChange={(e) => setCondition(i, { ...c, text: e.target.value })}
                placeholder="text"
                aria-label="Title contains"
              />
            )}
            {c.type === "has_category" && (
              <select value={c.category} onChange={(e) => setCondition(i, { ...c, category: e.target.value })} aria-label="Category">
                {categoryOptions}
              </select>
            )}
            {c.type === "has_owner" && (
              <select value={c.owner} onChange={(e) => setCondition(i, { ...c, owner: e.target.value })} aria-label="Owner">
                {ownerOptions}
              </select>
            )}
            <button type="button" className="rule-remove-line" onClick={() => setCondition(i, null)} aria-label="Remove condition">
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          className="link-button"
          onClick={() => setDraft({ ...draft, conditions: [...draft.conditions, { type: "by_person" }] })}
        >
          + condition
        </button>
      </fieldset>

      <fieldset className="rule-part">
        <legend>Then</legend>
        {draft.actions.map((a, i) => (
          <div key={i} className="rule-line rule-action">
            <select
              value={a.type}
              onChange={(e) => {
                const next = blankAction(e.target.value as RuleAction["type"], {
                  animation: animations.includes("celebrate") ? "celebrate" : animations[0],
                  lane: lanes[0]?.id,
                  category: categories[0]?.id,
                });
                setAction(i, next);
                if (next.type === "create_subtasks") setTexts((t) => ({ ...t, [i]: "" }));
              }}
              aria-label="Action"
            >
              {ACTION_CHOICES.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            {a.type === "set_animation" && (
              <select value={a.name} onChange={(e) => setAction(i, { ...a, name: e.target.value })} aria-label="Animation">
                {animations.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            )}
            {a.type === "move" && (
              <select
                value={a.final ? "final" : (a.lane ?? "")}
                onChange={(e) => setAction(i, e.target.value === "final" ? { type: "move", final: true } : { type: "move", lane: e.target.value })}
                aria-label="Lane"
              >
                <option value="final">the final lane</option>
                {laneOptions}
              </select>
            )}
            {a.type === "set_due" && (
              <span className="rule-inline">
                <select
                  value={a.days === null ? "clear" : a.days <= 1 && a.days >= 0 ? String(a.days) : "n"}
                  onChange={(e) =>
                    setAction(i, {
                      type: "set_due",
                      days: e.target.value === "clear" ? null : e.target.value === "n" ? 3 : Number(e.target.value),
                    })
                  }
                  aria-label="Deadline"
                >
                  <option value="0">due today</option>
                  <option value="1">due tomorrow</option>
                  <option value="n">due in … days</option>
                  <option value="clear">no deadline</option>
                </select>
                {a.days !== null && (a.days > 1 || a.days < 0) && (
                  <input
                    type="number"
                    min={-365}
                    max={3650}
                    className="rule-days"
                    value={a.days}
                    onChange={(e) => setAction(i, { ...a, days: Number(e.target.value) })}
                    aria-label="Days"
                  />
                )}
              </span>
            )}
            {(a.type === "add_category" || a.type === "remove_category") && (
              <select value={a.category} onChange={(e) => setAction(i, { ...a, category: e.target.value })} aria-label="Category">
                {categoryOptions}
              </select>
            )}
            {a.type === "owners" && (
              <span className="rule-owners">
                <select
                  value={a.mode}
                  onChange={(e) => setAction(i, { ...a, mode: e.target.value as "set" | "add" | "clear" })}
                  aria-label="How"
                >
                  <option value="set">hand it to</option>
                  <option value="add">add</option>
                  <option value="clear">clear its owners</option>
                </select>
                {a.mode !== "clear" &&
                  owners
                    .filter((o) => shortlist.includes(o) || a.owners.includes(o.id))
                    .map((o) => (
                      <label key={o.id} className="rule-owner">
                        <input
                          type="checkbox"
                          checked={a.owners.includes(o.id)}
                          onChange={(e) =>
                            setAction(i, {
                              ...a,
                              owners: e.target.checked ? [...a.owners, o.id] : a.owners.filter((x) => x !== o.id),
                            })
                          }
                        />
                        {o.name}
                      </label>
                    ))}
                {a.mode !== "clear" && others.some((o) => !a.owners.includes(o.id)) && (
                  <select
                    value=""
                    onChange={(e) => e.target.value && setAction(i, { ...a, owners: [...a.owners, e.target.value] })}
                    aria-label="Add someone else"
                  >
                    <option value="">+ someone else…</option>
                    {others
                      .filter((o) => !a.owners.includes(o.id))
                      .map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name}
                        </option>
                      ))}
                  </select>
                )}
              </span>
            )}
            {a.type === "create_subtasks" && (
              <div className="rule-subtasks">
                <textarea
                  rows={3}
                  value={texts[i] ?? ""}
                  onChange={(e) => setTexts((t) => ({ ...t, [i]: e.target.value }))}
                  placeholder={"One per line, like quick add:\nWrite release notes due tomorrow\nCheck links ~30m"}
                  aria-label="Subtasks"
                />
                <select
                  value={a.lane ?? ""}
                  onChange={(e) => setAction(i, { ...a, lane: e.target.value || undefined })}
                  aria-label="Subtasks go in"
                >
                  <option value="">in the card’s lane</option>
                  {laneOptions}
                </select>
              </div>
            )}
            <button type="button" className="rule-remove-line" onClick={() => setAction(i, null)} aria-label="Remove action">
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          className="link-button"
          onClick={() => {
            setDraft({ ...draft, actions: [...draft.actions, { type: "set_due", days: 0 }] });
          }}
        >
          + action
        </button>
      </fieldset>

      <fieldset className="owner-colours">
        <legend>Applies to</legend>
        <div className="segmented scope-switch" role="group" aria-label="Applies to">
          <button type="button" aria-pressed={draft.scope === "board"} onClick={() => setDraft({ ...draft, scope: "board" })}>
            {board.name} only
          </button>
          <button type="button" aria-pressed={draft.scope === "family"} onClick={() => setDraft({ ...draft, scope: "family" })}>
            {board.name} and its sub-boards
          </button>
        </div>
        {draft.scope === "family" && (
          <p className="attachments-empty">
            {hasFamily
              ? "On sub-boards, lanes are matched by name."
              : "No sub-boards yet; it’ll apply to any you add."}
          </p>
        )}
      </fieldset>

      {error && (
        <p className="attach-error" role="alert">
          {error}
        </p>
      )}
      <div className="attach-form-buttons">
        {rule &&
          (confirmRemove ? (
            <button type="button" className="owner-remove is-confirm" onClick={remove}>
              Remove {rule.name}?
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
          {saving ? "Saving…" : rule ? "Save" : "Add automation"}
        </button>
      </div>
    </form>
  );
}

function blankCondition(kind: string, categoryId?: string, ownerId?: string): RuleCondition {
  switch (kind) {
    case "title_contains":
      return { type: "title_contains", text: "" };
    case "has_category":
      return { type: "has_category", category: categoryId ?? "" };
    case "lacks_category":
      return { type: "has_category", category: categoryId ?? "", negate: true };
    case "has_owner":
      return { type: "has_owner", owner: ownerId ?? "" };
    case "no_owner":
      return { type: "no_owner" };
    case "is_subtask":
      return { type: "is_subtask" };
    case "is_parent":
      return { type: "is_parent" };
    default:
      return { type: "by_person" };
  }
}

function blankAction(
  kind: RuleAction["type"],
  d: { animation?: string; lane?: string; category?: string },
): RuleAction {
  switch (kind) {
    case "set_animation":
      return { type: "set_animation", name: d.animation ?? "celebrate" };
    case "create_subtasks":
      return { type: "create_subtasks", items: [] };
    case "move":
      return { type: "move", final: true };
    case "set_due":
      return { type: "set_due", days: 0 };
    case "add_category":
      return { type: "add_category", category: d.category ?? "" };
    case "remove_category":
      return { type: "remove_category", category: d.category ?? "" };
    case "owners":
      return { type: "owners", mode: "set", owners: [] };
    default:
      return { type: "archive" };
  }
}
