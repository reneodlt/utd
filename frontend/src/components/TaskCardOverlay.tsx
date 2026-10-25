import { useBoardStore } from "../store/boardStore";
import type { Task } from "../types";
import { CardBody, useSubtaskRows } from "./TaskCard";

/** The floating card that follows the pointer while dragging. */
export default function TaskCardOverlay({ task }: { task: Task }) {
  const subtasks = useSubtaskRows(task.id);
  const view = useBoardStore((s) => s.subtaskViews[task.id] ?? "list");
  const blockers = useBoardStore((s) => s.dropBlock?.blockers);
  const parentTitle = useBoardStore((s) =>
    task.parent_id ? s.tasksById[task.parent_id]?.title : undefined,
  );
  return (
    <div className={`card card-overlay${blockers ? " is-blocked" : ""}`}>
      {blockers && (
        <span className="overlay-no-drop" aria-hidden="true">
          ⊘
        </span>
      )}
      <CardBody
        task={task}
        subtasks={subtasks}
        parentTitle={parentTitle}
        view={view}
        blockingIds={blockers}
      />
    </div>
  );
}
