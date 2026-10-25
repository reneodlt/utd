/** A parent task's subtasks as a flow: stages from the "blocks" links
 * between them, each subtask done / ready / waiting, and which ready one
 * to tackle next. Unlinked subtasks run in parallel (stage 1). */

import { useMemo } from "react";
import { useBoardStore } from "../store/boardStore";
import type { Lane, Task } from "../types";

export type FlowState = "done" | "ready" | "waiting";

export interface FlowNode {
  id: string;
  /** 0-based: how many "blocks" steps (among siblings) lead to it. */
  stage: number;
  state: FlowState;
  /** Unfinished tasks blocking it (any on the board, not just siblings). */
  waitingOn: string[];
  /** Unfinished siblings it blocks. */
  unblocks: string[];
}

export interface Flow {
  nodes: Record<string, FlowNode>;
  /** Subtask ids per stage, furthest-along first. */
  stages: string[][];
  /** Ready subtask to tackle next: furthest-along lane, then highest in it. */
  next: string | null;
  /** Sibling "blocks" links, for drawing arrows. */
  links: { id: string; from: string; to: string }[];
}

interface FlowInput {
  tasksById: Record<string, Task>;
  childrenByParent: Record<string, string[]>;
  taskIdsByLane: Record<string, string[]>;
  lanes: Lane[];
}

export function flowOf(parentId: string, s: FlowInput): Flow {
  const childIds = (s.childrenByParent[parentId] ?? []).filter((id) => s.tasksById[id]);
  const siblings = new Set(childIds);
  const laneOf = (id: string) => s.lanes.find((l) => l.id === s.tasksById[id].lane_id);
  const laneRank = (id: string) => laneOf(id)?.order ?? 0;
  const posIn = (id: string) => (s.taskIdsByLane[s.tasksById[id].lane_id] ?? []).indexOf(id);
  // Furthest along first (done work leads), then top to bottom in a lane.
  const boardOrder = (a: string, b: string) => laneRank(b) - laneRank(a) || posIn(a) - posIn(b);

  const links = childIds.flatMap((from) =>
    s.tasksById[from].links
      .filter((l) => l.link_type === "blocks" && siblings.has(l.to_task_id))
      .map((l) => ({ id: l.id, from, to: l.to_task_id })),
  );
  const blockersOf = (id: string) => links.filter((l) => l.to === id).map((l) => l.from);

  // Longest chain of blockers; the server refuses loops, but a guard keeps
  // a stray one from recursing forever.
  const depth: Record<string, number> = {};
  const visiting = new Set<string>();
  const stageOf = (id: string): number => {
    if (id in depth) return depth[id];
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const d = Math.max(-1, ...blockersOf(id).map(stageOf)) + 1;
    visiting.delete(id);
    return (depth[id] = d);
  };

  const nodes: Record<string, FlowNode> = {};
  for (const id of childIds) {
    const task = s.tasksById[id];
    const done = !!laneOf(id)?.is_final;
    nodes[id] = {
      id,
      stage: stageOf(id),
      state: done ? "done" : task.blocked_by.length ? "waiting" : "ready",
      waitingOn: done ? [] : task.blocked_by,
      unblocks: links.filter((l) => l.from === id && !laneOf(l.to)?.is_final).map((l) => l.to),
    };
  }

  const ready = childIds.filter((id) => nodes[id].state === "ready");
  ready.sort((a, b) => laneRank(b) - laneRank(a) || posIn(a) - posIn(b));

  const stages: string[][] = [];
  for (const id of childIds) (stages[nodes[id].stage] ??= []).push(id);
  return {
    nodes,
    stages: stages.filter(Boolean).map((ids) => ids.sort(boardOrder)),
    next: ready[0] ?? null,
    links,
  };
}

/** The subtask to tackle next under `parentId`, if it has two or more
 * subtasks (with only one there's nothing to choose). */
export function nextSubtaskOf(parentId: string, s: FlowInput): string | null {
  if ((s.childrenByParent[parentId]?.length ?? 0) < 2) return null;
  return flowOf(parentId, s).next;
}

/** "ready · unblocks 2", "waiting on Build the pages", … */
export function describeNode(node: FlowNode, next: boolean, titleOf: (id: string) => string): string {
  if (node.state === "done") return "done";
  if (node.state === "waiting") return `waiting on ${node.waitingOn.map(titleOf).join(", ")}`;
  const n = node.unblocks.length;
  return `${next ? "★ next" : "ready"}${n ? ` · unblocks ${n}` : ""}`;
}

/** The live flow under a parent task. */
export function useFlow(parentId: string): Flow {
  const tasksById = useBoardStore((s) => s.tasksById);
  const childrenByParent = useBoardStore((s) => s.childrenByParent);
  const taskIdsByLane = useBoardStore((s) => s.taskIdsByLane);
  const lanes = useBoardStore((s) => s.lanes);
  return useMemo(
    () => flowOf(parentId, { tasksById, childrenByParent, taskIdsByLane, lanes }),
    [parentId, tasksById, childrenByParent, taskIdsByLane, lanes],
  );
}
