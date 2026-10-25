import { useMemo, useState, type CSSProperties } from "react";
import { SubtaskExtras } from "./TaskCard";
import { checkOffSubtask } from "../lib/subtasks";
import { useBoardStore } from "../store/boardStore";
import type { Task } from "../types";
import { SubtaskQuickAdd } from "./TaskCard";

const NO_CHILDREN: string[] = [];

/** "Grandparent ▸ Parent ▸" above a task's title; each opens its details.
 * Walks up through the board; `titleOf` names ancestors that have left it
 * (archived), and the walk stops there. */
export function Ancestry({
  task,
  parentId,
  titleOf,
}: {
  task?: Task;
  parentId?: string | null;
  titleOf: (id: string) => string;
}) {
  const tasksById = useBoardStore((s) => s.tasksById);
  const openDetail = useBoardStore((s) => s.openDetail);
  const chain = useMemo(() => {
    const out: string[] = [];
    const seen = new Set<string>(task ? [task.id] : []);
    let id = task?.parent_id ?? parentId ?? null;
    while (id && !seen.has(id) && out.length < 12) {
      out.unshift(id);
      seen.add(id);
      id = tasksById[id]?.parent_id ?? null;
    }
    return out;
  }, [task, parentId, tasksById]);

  if (chain.length === 0) return null;
  return (
    <nav className="drawer-ancestry" aria-label="Parent tasks">
      {chain.map((id) => (
        <span key={id} className="ancestry-step">
          <button type="button" onClick={() => openDetail(id)} title="Open this task">
            {tasksById[id]?.title ?? titleOf(id)}
          </button>
          <span aria-hidden="true" className="ancestry-sep">
            ▸
          </span>
        </span>
      ))}
    </nav>
  );
}

interface Node {
  task: Task;
  depth: number;
  done: boolean;
  laneName: string;
  laneColor: string;
}

/** Every subtask below `taskId`, any depth, in tree order. */
function useSubtree(taskId: string): Node[] {
  const childrenByParent = useBoardStore((s) => s.childrenByParent);
  const tasksById = useBoardStore((s) => s.tasksById);
  const lanes = useBoardStore((s) => s.lanes);
  return useMemo(() => {
    const out: Node[] = [];
    const seen = new Set<string>([taskId]);
    const walk = (id: string, depth: number) => {
      for (const childId of childrenByParent[id] ?? NO_CHILDREN) {
        const task = tasksById[childId];
        if (!task || seen.has(childId)) continue;
        seen.add(childId);
        const lane = lanes.find((l) => l.id === task.lane_id);
        out.push({
          task,
          depth,
          done: !!lane?.is_final,
          laneName: lane?.name ?? "",
          laneColor: lane?.color ?? "#6b7280",
        });
        walk(childId, depth + 1);
      }
    };
    walk(taskId, 0);
    return out;
  }, [taskId, childrenByParent, tasksById, lanes]);
}

/** The drawer's subtask tree: everything below this task, tick unfinished
 * ones off, open any of them, and add more at the top level. */
export function SubtaskTree({ task }: { task: Task }) {
  const nodes = useSubtree(task.id);
  const openDetail = useBoardStore((s) => s.openDetail);
  const [ticking, setTicking] = useState<Record<string, true>>({});
  const done = nodes.filter((n) => n.done).length;

  async function tick(id: string) {
    setTicking((t) => ({ ...t, [id]: true }));
    const ok = await checkOffSubtask(id);
    if (!ok)
      setTicking((t) => {
        const next = { ...t };
        delete next[id];
        return next;
      });
  }

  return (
    <section className="subtask-tree" aria-labelledby="subtask-tree-title">
      <div className="attachments-bar">
        <h3 id="subtask-tree-title">
          Subtasks
          {nodes.length > 0 && (
            <span className="history-count">
              {done}/{nodes.length} done
            </span>
          )}
        </h3>
      </div>
      {nodes.length > 0 && (
        <ul className="tree-list" role="tree" aria-label="Subtasks">
          {nodes.map((n) => {
            const checked = n.done || !!ticking[n.task.id];
            return (
              <li
                key={n.task.id}
                role="treeitem"
                aria-level={n.depth + 1}
                className={`tree-row${checked ? " is-done" : ""}`}
                style={{ "--depth": n.depth, "--lane-color": n.laneColor } as CSSProperties}
              >
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={checked}
                  aria-label={checked ? `${n.task.title} is done` : `Mark ${n.task.title} done`}
                  className={`subtask-check${checked ? " is-checked" : ""}`}
                  disabled={checked}
                  onClick={() => tick(n.task.id)}
                >
                  {checked ? "✓" : ""}
                </button>
                <button type="button" className="tree-title" onClick={() => openDetail(n.task.id)}>
                  {n.task.title}
                </button>
                <span className="tree-lane" title={n.laneName}>
                  <span className="subtask-dot" style={{ background: n.laneColor }} />
                  {n.laneName}
                </span>
                <SubtaskExtras taskId={n.task.id} interactive />
              </li>
            );
          })}
        </ul>
      )}
      <SubtaskQuickAdd parentId={task.id} />
    </section>
  );
}
