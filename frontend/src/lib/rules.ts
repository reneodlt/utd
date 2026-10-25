/** Automations in plain English: the sentence a rule reads as, the choices
 * the editor offers, and turning a subtask list typed like quick add into
 * a rule's subtasks (deadlines become "N days after it runs"). */

import type { Rule, RuleAction, RuleCondition, RuleSubtaskItem, RuleTrigger, RuleWhen } from "../types";
import { figureFields } from "./figureParse";
import { parseQuickAdd } from "./quickAdd";

export const WHEN_CHOICES: { value: RuleWhen; label: string; hint?: string }[] = [
  { value: "moved", label: "a card moves into…" },
  { value: "created", label: "a card is added" },
  { value: "unblocked", label: "a card becomes unblocked", hint: "its last blocker is done" },
  { value: "subtasks_done", label: "all of a card’s subtasks are done", hint: "acts on the parent" },
  { value: "archived", label: "a card is archived" },
  { value: "deleted", label: "a card is deleted" },
];

export const CONDITION_CHOICES: { value: string; label: string }[] = [
  { value: "title_contains", label: "its title contains…" },
  { value: "has_category", label: "it has the category…" },
  { value: "lacks_category", label: "it doesn’t have the category…" },
  { value: "has_owner", label: "it’s owned by…" },
  { value: "no_owner", label: "it has no owner" },
  { value: "is_subtask", label: "it’s a subtask" },
  { value: "is_parent", label: "it has subtasks" },
  { value: "by_person", label: "a person did it (not an automation)" },
];

export const ACTION_CHOICES: { value: RuleAction["type"]; label: string }[] = [
  { value: "set_animation", label: "play an animation" },
  { value: "create_subtasks", label: "add subtasks" },
  { value: "move", label: "move it to…" },
  { value: "set_due", label: "set its deadline" },
  { value: "add_category", label: "add the category…" },
  { value: "remove_category", label: "remove the category…" },
  { value: "owners", label: "change its owners" },
  { value: "archive", label: "archive it" },
];

export interface Names {
  /** id → name for lanes, categories, owners. */
  of: (id: string | undefined) => string;
}

const q = (s: string) => `“${s}”`;

export function describeTrigger(t: RuleTrigger, n: Names): string {
  switch (t.when) {
    case "moved": {
      const into = t.final ? "a final lane" : t.lane ? n.of(t.lane) : "another lane";
      return `a card moves into ${into}${t.from_lane ? ` from ${n.of(t.from_lane)}` : ""}`;
    }
    case "created":
      return `a card is added${t.lane ? ` in ${n.of(t.lane)}` : ""}`;
    case "unblocked":
      return "a card becomes unblocked";
    case "subtasks_done":
      return "all of a card’s subtasks are done";
    case "archived":
      return "a card is archived";
    case "deleted":
      return "a card is deleted";
    default:
      return "something happens";
  }
}

export function describeCondition(c: RuleCondition, n: Names): string {
  switch (c.type) {
    case "title_contains":
      return `its title contains ${q(c.text)}`;
    case "has_category":
      return c.negate ? `it isn’t in ${n.of(c.category)}` : `it’s in ${n.of(c.category)}`;
    case "has_owner":
      return `${n.of(c.owner)} owns it`;
    case "no_owner":
      return "it has no owner";
    case "is_subtask":
      return "it’s a subtask";
    case "is_parent":
      return "it has subtasks";
    case "by_person":
      return "a person did it";
  }
}

export function describeDays(days: number | null): string {
  if (days === null) return "clear its deadline";
  if (days === 0) return "make it due today";
  if (days === 1) return "make it due tomorrow";
  if (days < 0) return `make it due ${-days} day${days === -1 ? "" : "s"} ago`;
  return `make it due in ${days} days`;
}

export function describeAction(a: RuleAction, n: Names): string {
  switch (a.type) {
    case "set_animation":
      return a.name === "celebrate" ? "celebrate" : `play ${q(a.name)}`;
    case "create_subtasks": {
      const titles = a.items.map((i) => q(i.title));
      const list = titles.length > 3 ? `${titles.slice(0, 3).join(", ")} and ${titles.length - 3} more` : titles.join(", ");
      return `add subtask${a.items.length > 1 ? "s" : ""} ${list}${a.lane ? ` in ${n.of(a.lane)}` : ""}`;
    }
    case "move":
      return a.final ? "move it to the final lane" : `move it to ${n.of(a.lane)}`;
    case "set_due":
      return describeDays(a.days);
    case "add_category":
      return `add ${n.of(a.category)}`;
    case "remove_category":
      return `remove ${n.of(a.category)}`;
    case "owners":
      if (a.mode === "clear") return "clear its owners";
      return `${a.mode === "add" ? "add" : "hand it to"} ${a.owners.map((id) => n.of(id)).join(" and ")}`;
    case "archive":
      return "archive it";
  }
}

export function describeRule(
  rule: Pick<Rule, "trigger" | "conditions" | "actions">,
  n: Names,
): { when: string; onlyIf: string; then: string } {
  const actions = rule.actions.map((a) => describeAction(a, n)).join(", then ");
  return {
    when: `When ${describeTrigger(rule.trigger, n)}`,
    onlyIf: rule.conditions.length ? `only if ${rule.conditions.map((c) => describeCondition(c, n)).join(" and ")}` : "",
    // That trigger acts on the parent, not the subtask that finished.
    then: rule.trigger.when === "subtasks_done" && actions ? `for the parent: ${actions}` : actions,
  };
}

/** A subtask list typed like quick add → the rule's subtasks. Deadlines
 * are kept relative ("due tomorrow" = 1 day after the rule runs); £ and
 * ~time go to the board's categories as usual. */
export function itemsFromText(text: string, boardId: string, previous: RuleSubtaskItem[] = []): RuleSubtaskItem[] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return parseQuickAdd(text).flatMap((d) => {
    const fields = figureFields(d.title, d.figures, boardId);
    const title = fields.title.trim();
    if (!title) return [];
    const item: RuleSubtaskItem = { title };
    if (d.due) {
      const [y, m, day] = d.due.split("-").map(Number);
      item.due_days = Math.round((new Date(y, m - 1, day).getTime() - today.getTime()) / 86_400_000);
    }
    if (fields.category_ids?.length) {
      item.category_ids = fields.category_ids;
      item.values = fields.values;
    } else {
      // Editing: keep figures a line had before (the text only shows titles).
      const before = previous.find((p) => p.title === title);
      if (before?.category_ids) {
        item.category_ids = before.category_ids;
        item.values = before.values;
      }
    }
    return [item];
  });
}

/** The editor's text for a rule's subtasks. */
export function textFromItems(items: RuleSubtaskItem[]): string {
  return items
    .map((i) =>
      i.due_days === undefined
        ? i.title
        : `${i.title} ${i.due_days === 0 ? "due today" : i.due_days === 1 ? "due tomorrow" : `in ${i.due_days} days`}`,
    )
    .join("\n");
}

/** Starting points for a new rule. */
export const TEMPLATES: { label: string; rule: Pick<Rule, "name" | "trigger" | "conditions" | "actions"> }[] = [
  {
    label: "Celebrate when a card is done",
    rule: {
      name: "celebrate-done",
      trigger: { when: "moved", final: true },
      conditions: [],
      actions: [{ type: "set_animation", name: "celebrate" }],
    },
  },
  {
    label: "Finish the parent when its subtasks are done",
    rule: { name: "finish-parent", trigger: { when: "subtasks_done" }, conditions: [], actions: [{ type: "move", final: true }] },
  },
  {
    label: "A checklist when a card reaches a lane",
    rule: {
      name: "checklist",
      trigger: { when: "moved" },
      conditions: [],
      actions: [{ type: "create_subtasks", items: [{ title: "Check it over" }] }],
    },
  },
  {
    label: "Due today when work starts",
    rule: { name: "due-when-started", trigger: { when: "moved" }, conditions: [], actions: [{ type: "set_due", days: 0 }] },
  },
];
