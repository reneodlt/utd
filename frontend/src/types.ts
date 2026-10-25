export interface Board {
  id: string;
  name: string;
  slug: string;
  /** Boards nest; a board also shows its descendants' tasks. */
  parent_id: string | null;
  animation_catalogue: { enabled?: string[]; default?: string };
  metadata: Record<string, unknown>;
  /** Working day for time figures (own setting, or inherited). */
  hours_per_day: number;
  kind?: string;
}

/** Shape returned by GET /api/boards/ — the switcher's list. */
export interface BoardSummary {
  id: string;
  name: string;
  slug: string;
  parent_id: string | null;
  /** "inbox" for the catch-all board of not-yet-placed notes. */
  kind?: string;
  /** The inbox only: how many notes are waiting. */
  open_count?: number | null;
}

/** A board and its lanes, for choosing where a task goes. */
export interface BoardWithLanes extends BoardSummary {
  lanes: { id: string; name: string; color: string; is_final: boolean }[];
}

/** One stretch of a task's ownership. */
export interface OwnerPeriod {
  owner_ids: string[];
  start: string;
  end: string | null;
  /** Who set it: a person, or "auto" (following the next subtask). */
  set_by: string;
  via_subtask: string | null;
  lanes: string[];
}

export interface Lane {
  id: string;
  board_id: string;
  name: string;
  order: number;
  color: string;
  wip_limit: number | null;
  /** A "done" lane: tasks here count as resolved; offers "Archive all". */
  is_final: boolean;
}

export interface TaskLink {
  id: string;
  from_task_id: string;
  to_task_id: string;
  link_type: "blocks" | "relates_to" | "similar_to" | "milestone_of" | "duplicates";
}

/** A person, team or company tasks can belong to. Shared across boards. */
export interface Owner {
  id: string;
  name: string;
  /** 1–5 characters, shown when there's no emoji. */
  code: string;
  fg: string;
  bg: string;
  emoji: string;
  /** Ways to reach them (phone, email, website, address). */
  contacts?: OwnerContact[];
  position: number;
  /** Hidden from cards and pickers; kept so history can still name them. */
  archived: boolean;
}

export interface OwnerContact {
  kind: "phone" | "email" | "link" | "place";
  data: Record<string, string>;
  label?: string;
}

/** A place on the map, for a location category. */
export interface Place {
  lat: number;
  lng: number;
  label?: string;
}

/** A log entry on a task. */
export interface TaskComment {
  id: string;
  task_id: string;
  body: string;
  /** The owner it's about or with, if any. */
  about_id: string | null;
  actor: string;
  /** When it happened (settable); created_at is when it was typed. */
  happened_at: string;
  created_at: string;
  edited_at: string | null;
}

/** A label for tasks: shared by every board (board_id null) or one
 * board's own. */
export interface Category {
  id: string;
  board_id: string | null;
  name: string;
  color: string;
  position: number;
  /** What its tasks can carry a figure for ("" = nothing); see lib/measures. */
  value_type: ValueType | "";
  value_config: ValueConfig;
  archived: boolean;
}

export type ValueType = "money" | "duration" | "number" | "percent" | "location";

export interface ValueConfig {
  /** money: GBP, EUR or USD. */
  currency?: string;
  /** number: a short unit label, e.g. "mi". */
  unit?: string;
}

/** A figure on an archived task, for totals: it rolls up into `anchor_id`
 * (its nearest open ancestor), or only into the board total. */
export interface ArchivedValue {
  task_id: string;
  board_id: string;
  category_id: string;
  amount: number;
  /** The figure before it was changed after completion, if it was. */
  estimate: number | null;
  title: string;
  /** The archived task's owners and categories, for the board's filters. */
  owner_ids?: string[];
  category_ids?: string[];
  anchor_id: string | null;
}

/** A reference the task carries; `kind` picks the plugin in
 * src/attachments that knows how to show and open it. */
export interface Attachment {
  id: string;
  kind: string;
  label: string;
  data: Record<string, string>;
  position: number;
  created_at: string;
}

export interface Task {
  id: string;
  board_id: string;
  lane_id: string;
  parent_id: string | null;
  title: string;
  description: string;
  position: number;
  metadata: Record<string, unknown>;
  subtask_count: number;
  blocked_by: string[];
  links: TaskLink[];
  attachments: Attachment[];
  owner_ids: string[];
  category_ids: string[];
  /** {category_id: figure} for categories that take one. */
  values: Record<string, number>;
  /** {category_id: estimate} for figures changed after the task was done;
   * `values` then holds the actual. */
  estimates?: Record<string, number>;
  /** {category_id: place} for location categories. */
  locations?: Record<string, Place>;
  /** How many log entries it has. */
  comment_count?: number;
  /** Optional deadline, YYYY-MM-DD. */
  due_date: string | null;
  /** Keep its subtasks off the board (they stay on this card). */
  hide_subtasks?: boolean;
  /** Its owners follow the next-up subtask's (off once set by hand). */
  owner_follows_next?: boolean;
  lane_entered_at: string;
  archived_at: string | null;
  /** Set when binned; a deleted task is always archived too. */
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Which tasks the board shows: on it, archived, or in the bin. */
export type BoardView = "open" | "archived" | "deleted" | "today" | "map";

export interface Snapshot {
  board: Board & { lanes: Lane[] };
  lanes: Lane[];
  tasks: Task[];
  owners: Owner[];
  categories: Category[];
  /** Descendant boards whose tasks this board also shows. */
  family: BoardSummary[];
  /** A descendant's lane id → the lane of this board it shows in. */
  lane_map: Record<string, string>;
  /** Per descendant board: this board's lane id → its lane a drop lands in. */
  lane_back: Record<string, Record<string, string>>;
  archived_values: ArchivedValue[];
  /** Owners of tasks on this board (and sub-boards), most recent first. */
  used_owner_ids?: string[];
  last_event_id: number;
}

export interface EventMeta {
  actor: string;
  source: string;
  animation: string;
  op_id: string;
  event_id: number;
  ts: string;
  from_lane_id?: string;
  to_lane_id?: string;
  changed_fields?: string[];
  /** Present on blocked-state ripple events: true = unblocked, false = re-blocked. */
  unblocked?: boolean;
}

export type EventType =
  | "task.created"
  | "task.moved"
  | "task.updated"
  | "task.archived"
  | "task.deleted"
  | "task.restored"
  | "task.linked"
  | "task.unlinked";

export type EventSource = "ui" | "api" | "system" | "admin";

export interface FieldChange {
  from: unknown;
  to: unknown;
}

/** One audit row from GET /api/tasks/<id>/events/. */
export interface TaskEventRecord {
  id: number;
  task_id: string;
  event_type: EventType;
  actor: string;
  source: EventSource;
  from_lane_id: string | null;
  from_lane_name: string | null;
  to_lane_id: string | null;
  to_lane_name: string | null;
  payload: {
    title?: string;
    parent_id?: string | null;
    changed_fields?: string[];
    changes?: Record<string, FieldChange>;
    /** Pre-attachments rows only. */
    external_link?: { id: string; provider: string; url: string; label: string };
    attachment?: { id: string; kind: string; label: string; data: Record<string, string> };
    action?: "added" | "edited" | "removed" | "restored";
    /** task.deleted: "board" | "archive"; task.restored: "archive" | "bin". */
    from?: string;
    before?: { label: string; data: Record<string, string> };
    link_type?: TaskLink["link_type"];
    from_task_id?: string;
    to_task_id?: string;
    unblocked_by?: string;
    reblocked_by?: string;
    /** Log entries: what was added / edited / removed. */
    comment?: { id: string; body: string; about: string | null; happened_at?: string | null };
    /** Owners handed on automatically from this (next-up) subtask. */
    owners_from_subtask?: string;
    /** task.moved across boards. */
    from_board?: string;
    to_board?: string;
    left_parent?: string;
  };
  animation: string;
  op_id: string;
  /** The event that set this one off (automation rule, unblock ripple). */
  caused_by: {
    id: number;
    task_id: string;
    event_type: EventType;
    actor: string;
    source: EventSource;
    to_lane_name: string | null;
  } | null;
  created_at: string;
}

export interface RelatedTask {
  title: string;
  archived: boolean;
  parent_id: string | null;
}

export interface TaskHistoryPage {
  count: number;
  next: string | null;
  results: TaskEventRecord[];
  related_tasks: Record<string, RelatedTask>;
}

export interface Analytics {
  board_id: string;
  generated_at: string;
  cycle_time: {
    completed: number;
    p50_seconds: number | null;
    p85_seconds: number | null;
    avg_seconds: number | null;
  };
  throughput: { last_7d: number; last_30d: number };
  lanes: {
    lane_id: string;
    name: string;
    active_tasks: number;
    avg_residency_seconds: number | null;
    completed_spans: number;
  }[];
}

export type WsEvent =
  | { type: "sync.hello"; board_id: string; last_event_id: number; ts: string }
  | {
      type: EventType;
      board_id: string;
      task: Task;
      meta: EventMeta;
    }
  | { type: "lane.rebalanced"; board_id: string; lane_id: string; positions: Record<string, number> }
  | { type: "owners.changed"; owners: Owner[] }
  | { type: "category.changed"; category: Category }
  | { type: "boards.changed" }
  | { type: "lanes.changed"; board_id: string }
  | { type: "pong"; ts: string }
  | { type: "error"; detail: string; meta: { op_id?: string } };

export type ConnectionStatus = "connecting" | "open" | "reconnecting";

// ---------- automations ----------

export type RuleWhen = "moved" | "created" | "archived" | "deleted" | "unblocked" | "subtasks_done";

export interface RuleTrigger {
  when: RuleWhen;
  /** moved: into this lane; created: in this lane. */
  lane?: string;
  from_lane?: string;
  /** moved: into any final lane. */
  final?: boolean;
}

export type RuleCondition =
  | { type: "title_contains"; text: string }
  | { type: "has_category"; category: string; negate?: boolean }
  | { type: "has_owner"; owner: string }
  | { type: "no_owner" }
  | { type: "is_subtask" }
  | { type: "is_parent" }
  | { type: "by_person" };

export interface RuleSubtaskItem {
  title: string;
  due_days?: number;
  category_ids?: string[];
  values?: Record<string, number>;
}

export type RuleAction =
  | { type: "set_animation"; name: string }
  | { type: "create_subtasks"; items: RuleSubtaskItem[]; lane?: string }
  | { type: "move"; lane?: string; final?: boolean }
  | { type: "set_due"; days: number | null }
  | { type: "add_category"; category: string }
  | { type: "remove_category"; category: string }
  | { type: "owners"; mode: "set" | "add" | "clear"; owners: string[] }
  | { type: "archive" };

export interface Rule {
  id: string;
  board_id: string;
  board_name: string;
  name: string;
  enabled: boolean;
  scope: "board" | "family";
  trigger: RuleTrigger;
  conditions: RuleCondition[];
  actions: RuleAction[];
  position: number;
  runs: number;
  failed_runs: number;
  last_run: string | null;
  /** References that no longer work. */
  problems: string[];
  /** A parent board's rule that applies here too. */
  inherited: boolean;
  archived: boolean;
  /** Names of the lanes, categories and owners it mentions. */
  names: Record<string, string>;
}

export interface RuleRunRecord {
  task_id: string;
  task_title: string;
  board_slug: string;
  board_name: string;
  created_at: string;
  error: string;
}
