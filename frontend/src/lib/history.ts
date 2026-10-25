/** Turns audit rows into plain-language history lines for the card drawer.
 * Pure functions only: the component supplies the lookups. */

import type { EventSource, RelatedTask, TaskEventRecord, TaskLink } from "../types";
import { mediaOf } from "../attachments/file";
import { pluginFor } from "../attachments/registry";
import { formatDuration, secondsSince } from "./time";

export type ActorKind = "person" | "integration" | "rule" | "automatic" | "admin";

export interface ActorInfo {
  kind: ActorKind;
  /** Display name: the rule's name without its "rule:" prefix. */
  name: string;
  /** What the kind means, for the tag beside the name. */
  label: string;
}

/** Who did it. Rules are named "rule:<name>"; source says how the rest
 * arrived. "system" rows (unblock ripples, the seed command) keep a real
 * actor name, so it is shown with an "automatic" tag. */
export function describeActor(actor: string, source: EventSource): ActorInfo {
  if (actor.startsWith("rule:")) {
    return { kind: "rule", name: actor.slice("rule:".length), label: "rule" };
  }
  switch (source) {
    case "ui":
      return { kind: "person", name: actor, label: "board" };
    case "system":
      return { kind: "automatic", name: actor, label: "automatic" };
    case "admin":
      return { kind: "admin", name: actor, label: "admin" };
    default:
      return { kind: "integration", name: actor, label: "API" };
  }
}

/** Title lookup that never fails: "this card", a quoted title, or a short id. */
export type TitleOf = (taskId: string | null | undefined) => string;

export function makeTitleOf(
  selfId: string,
  related: Record<string, RelatedTask>,
  live: Record<string, { title: string }>,
): TitleOf {
  return (taskId) => {
    if (!taskId) return "no task";
    if (taskId === selfId) return "this card";
    const title = live[taskId]?.title ?? related[taskId]?.title;
    if (!title) return `task ${taskId.slice(0, 8)}`;
    const archived = !live[taskId] && related[taskId]?.archived;
    return `“${title}”${archived ? " (archived)" : ""}`;
  };
}

/** Link sentences from this card's point of view: [as source, as target]. */
const LINK_PHRASES: Record<TaskLink["link_type"], [string, string]> = {
  blocks: ["marked this card as blocking", "marked this card as blocked by"],
  relates_to: ["linked this card as related to", "linked this card as related to"],
  similar_to: ["marked this card as similar to", "marked this card as similar to"],
  milestone_of: ["made this card a milestone of", "added the milestone"],
  duplicates: ["marked this card as a duplicate of", "marked this card as duplicated by"],
};

const UNLINK_PHRASES: Record<TaskLink["link_type"], [string, string]> = {
  blocks: ["stopped this card blocking", "stopped this card being blocked by"],
  relates_to: ["unlinked this card from", "unlinked this card from"],
  similar_to: ["removed the similar-to link with", "removed the similar-to link with"],
  milestone_of: ["removed this card as a milestone of", "removed the milestone"],
  duplicates: ["unmarked this card as a duplicate of", "unmarked this card as duplicated by"],
};

const FIELD_NAMES: Record<string, string> = {
  title: "title",
  description: "details",
  metadata: "metadata",
  parent: "parent",
  external_links: "links",
  owners: "owners",
  due_date: "deadline",
  categories: "categories",
  attachments: "attachments",
  blocked_by: "blocked state",
  hide_subtasks: "subtasks-on-the-board setting",
  owner_follows_next: "owners-follow-the-next-subtask setting",
};

/** "Tue 30 Sep 14:10" for a log entry's time. */
export function whenLabel(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** One changed value, for the expandable detail under an edit. */
export interface ChangeDetail {
  field: string;
  from: string;
  to: string;
}

export interface HistoryLine {
  /** The sentence after the actor's name, e.g. "moved it from Backlog to Review". */
  text: string;
  /** Before/after values to show on demand. Empty when the text says it all. */
  details: ChangeDetail[];
  /** Short tag for filtering and the row marker. */
  kind: "create" | "move" | "edit" | "link" | "block" | "archive";
}

function show(value: unknown): string {
  if (value === null || value === undefined || value === "") return "(empty)";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function describeUpdate(event: TaskEventRecord, titleOf: TitleOf, names: NameLookups): HistoryLine {
  const { payload } = event;
  if (payload.unblocked_by) {
    return {
      kind: "block",
      text: `unblocked it, since ${titleOf(payload.unblocked_by)} no longer blocks it`,
      details: [],
    };
  }
  if (payload.reblocked_by) {
    return {
      kind: "block",
      text: `blocked it again by ${titleOf(payload.reblocked_by)}`,
      details: [],
    };
  }
  if (payload.comment) {
    const { comment, action } = payload;
    const who = comment.about ? ` with ${names.owner(comment.about)}` : "";
    const before = payload.before as unknown as { body?: string; happened_at?: string | null } | undefined;
    const moved = action === "edited" && before?.happened_at && comment.happened_at && before.happened_at !== comment.happened_at;
    const verb = moved
      ? `moved a log entry from ${whenLabel(before!.happened_at!)} to ${whenLabel(comment.happened_at!)}`
      : action === "edited"
        ? "edited a log entry"
        : action === "removed"
          ? "removed a log entry"
          : action === "restored"
            ? "brought back a log entry"
            : "added to the log";
    const short = comment.body.length > 120 ? `${comment.body.slice(0, 120)}…` : comment.body;
    return {
      kind: "edit",
      text: `${verb}${who}: “${short}”`,
      details:
        action === "edited" && before?.body && before.body !== comment.body
          ? [{ field: "log entry", from: before.body, to: comment.body }]
          : [],
    };
  }
  if (payload.attachment) {
    const { attachment, action, before } = payload;
    const plugin = pluginFor(attachment.kind);
    const name = attachment.label || plugin.summary(attachment.data);
    const noun =
      attachment.kind === "file"
        ? { audio: "sound clip", video: "video", image: "photo", file: "file" }[mediaOf(attachment.data)]
        : plugin.name.toLowerCase();
    const what = `${noun} “${name}”`;
    const verb = action === "removed" ? "removed the" : action === "edited" ? "edited the" : "attached a";
    const details: ChangeDetail[] =
      action === "edited" && before
        ? [{ field: noun, from: show(before), to: show({ label: attachment.label, data: attachment.data }) }]
        : [];
    return { kind: "link", text: `${verb} ${what}`, details };
  }
  // Rows written before attachments replaced external links.
  if (payload.external_link) {
    const link = payload.external_link;
    return {
      kind: "link",
      text: `attached ${link.label ? `“${link.label}”` : link.provider.replace("_", " ")}`,
      details: [{ field: "url", from: "", to: link.url }],
    };
  }

  const changes = payload.changes;
  if (!changes) {
    // Rows written before before/after values were recorded.
    const fields = (payload.changed_fields ?? []).map((f) => FIELD_NAMES[f] ?? f);
    return {
      kind: "edit",
      text: fields.length ? `changed the ${fields.join(", ")}` : "updated it",
      details: [],
    };
  }

  const parts: string[] = [];
  const details: ChangeDetail[] = [];
  for (const [field, change] of Object.entries(changes)) {
    if (field === "title") {
      parts.push(`renamed it from “${show(change.from)}” to “${show(change.to)}”`);
    } else if (field === "owners" || field === "categories") {
      const before = (change.from as string[]) ?? [];
      const after = (change.to as string[]) ?? [];
      const added = after.filter((id) => !before.includes(id));
      const removed = before.filter((id) => !after.includes(id));
      if (field === "owners" && event.payload.owners_from_subtask) {
        const list = (ids: string[]) => ids.map(names.owner).join(", ") || "nobody";
        parts.push(`handed it to ${list(after)}, owner of the next subtask ${titleOf(event.payload.owners_from_subtask)}`);
      } else if (field === "owners") {
        const list = (ids: string[]) => ids.map(names.owner).join(", ");
        if (added.length) parts.push(`made ${list(added)} ${added.length > 1 ? "owners" : "an owner"}`);
        if (removed.length) parts.push(`removed ${list(removed)} as ${removed.length > 1 ? "owners" : "owner"}`);
      } else {
        const list = (ids: string[]) => ids.map((id) => `“${names.category(id)}”`).join(", ");
        const noun = (n: number) => (n > 1 ? "categories" : "category");
        if (added.length) parts.push(`added the ${list(added)} ${noun(added.length)}`);
        if (removed.length) parts.push(`removed the ${list(removed)} ${noun(removed.length)}`);
      }
    } else if (field === "hide_subtasks") {
      parts.push(change.to ? "kept its subtasks off the board" : "put its subtasks back on the board");
    } else if (field === "owner_follows_next") {
      parts.push(change.to ? "set its owners to follow the next subtask" : "set its owners by hand");
    } else if (field === "values") {
      for (const [id, c] of Object.entries(change as unknown as Record<string, FigureChange>)) {
        const figure = (_: string, amount: string) => names.figure?.(id, amount, c.type) ?? amount;
        const name = `“${c.name}”`;
        if (c.from === null && c.to !== null) parts.push(`set ${name} to ${figure(id, c.to)}`);
        else if (c.to === null && c.from !== null) parts.push(`cleared ${name} (was ${figure(id, c.from)})`);
        else if (c.from !== null && c.to !== null)
          parts.push(
            `changed ${name} from ${figure(id, c.from)} to ${figure(id, c.to)}${
              c.estimate ? ` (actual; estimate ${figure(id, c.estimate)})` : ""
            }`,
          );
      }
    } else if (field === "parent") {
      parts.push(
        change.to
          ? `made it a subtask of ${titleOf(change.to as string)}`
          : `detached it from ${titleOf(change.from as string)}`,
      );
    } else {
      parts.push(`edited the ${FIELD_NAMES[field] ?? field}`);
      details.push({ field: FIELD_NAMES[field] ?? field, from: show(change.from), to: show(change.to) });
    }
  }
  return { kind: "edit", text: parts.join(", and ") || "updated it", details };
}

function describeLink(event: TaskEventRecord, selfId: string, titleOf: TitleOf): HistoryLine {
  const { payload } = event;
  const type = payload.link_type ?? "relates_to";
  const outgoing = payload.from_task_id === selfId;
  const other = outgoing ? payload.to_task_id : payload.from_task_id;
  const phrases = event.event_type === "task.linked" ? LINK_PHRASES : UNLINK_PHRASES;
  const phrase = (phrases[type] ?? [`${type}`, `${type}`])[outgoing ? 0 : 1];
  return { kind: "link", text: `${phrase} ${titleOf(other)}`, details: [] };
}

/** Display names for ids in owner/category changes (archived included). */
export interface NameLookups {
  owner: (id: string) => string;
  category: (id: string) => string;
  /** A category figure as the category shows it (e.g. "£200", "1d 2h"). */
  figure?: (categoryId: string, amount: string, type: string) => string;
}

const UNKNOWN_NAMES: NameLookups = { owner: () => "someone", category: () => "a category" };

interface FigureChange {
  name: string;
  type: string;
  from: string | null;
  to: string | null;
  /** Kept when a done task's figure changed: the estimate. */
  estimate?: string;
}

export function describeEvent(
  event: TaskEventRecord,
  selfId: string,
  titleOf: TitleOf,
  names: NameLookups = UNKNOWN_NAMES,
): HistoryLine {
  const from = event.from_lane_name ?? "a removed lane";
  const to = event.to_lane_name ?? "a removed lane";
  switch (event.event_type) {
    case "task.created":
      if (event.task_id !== selfId) {
        return { kind: "create", text: `added subtask ${titleOf(event.task_id)} in ${to}`, details: [] };
      }
      return { kind: "create", text: `created this card in ${to}`, details: [] };
    case "task.moved":
      if (event.payload.to_board) {
        return {
          kind: "move",
          text: `moved it from the ${event.payload.from_board} board (${from}) to the ${event.payload.to_board} board (${to})${
            event.payload.left_parent ? `, leaving its parent ${titleOf(event.payload.left_parent)}` : ""
          }`,
          details: [],
        };
      }
      if (event.from_lane_id === event.to_lane_id) {
        return { kind: "move", text: `reordered it within ${to}`, details: [] };
      }
      return { kind: "move", text: `moved it from ${from} to ${to}`, details: [] };
    case "task.archived":
      return { kind: "archive", text: `archived it from ${from}`, details: [] };
    case "task.deleted":
      return {
        kind: "archive",
        text: event.payload.from === "archive" ? "moved it from the archive to the bin" : `deleted it from ${from}`,
        details: [],
      };
    case "task.restored":
      return {
        kind: "create",
        text: `restored it from the ${event.payload.from === "bin" ? "bin" : "archive"} to ${to}`,
        details: [],
      };
    case "task.linked":
    case "task.unlinked":
      return describeLink(event, selfId, titleOf);
    case "task.updated":
      return describeUpdate(event, titleOf, names);
    default:
      return { kind: "edit", text: String(event.event_type), details: [] };
  }
}

const CAUSE_VERBS: Record<string, string> = {
  "task.created": "created",
  "task.moved": "moved",
  "task.updated": "updated",
  "task.archived": "archived",
  "task.deleted": "deleted",
  "task.restored": "restored",
  "task.linked": "linked",
  "task.unlinked": "unlinked",
};

/** "because rich moved this card to Review" — the reason for an automatic
 * or rule-driven event. */
export function describeCause(event: TaskEventRecord, titleOf: TitleOf): string | null {
  const cause = event.caused_by;
  if (!cause) return null;
  const whoText = describeActor(cause.actor, cause.source).name;
  const verb = CAUSE_VERBS[cause.event_type] ?? cause.event_type;
  const where = cause.event_type === "task.moved" && cause.to_lane_name ? ` to ${cause.to_lane_name}` : "";
  return `because ${whoText} ${verb} ${titleOf(cause.task_id)}${where}`;
}

export function relativeTime(iso: string): string {
  const seconds = secondsSince(iso);
  if (seconds < 45) return "just now";
  return `${formatDuration(seconds)} ago`;
}

/** Day heading for a group of rows: Today, Yesterday, or a date. */
export function dayLabel(iso: string, now = new Date()): string {
  const date = new Date(iso);
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(date)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}
