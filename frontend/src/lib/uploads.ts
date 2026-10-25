/** Photos and files from the phone or desktop: new tasks from photos, or
 * attached to an existing task. */

import { ApiError, createFileTask, uploadFiles } from "../api/client";
import { useBoardStore } from "../store/boardStore";

/** Camera/screenshot names say nothing ("IMG_1234.JPG", "image.png"). */
const GENERIC = /^(img|image|photo|pxl|dsc|dscn|screenshot|screen shot|scan|capture)[\s_-]*[\d\s_.:-]*$/i;

const kindWord = (file: File) =>
  file.type.startsWith("image/") ? "Photo"
  : file.type.startsWith("audio/") || /\.(opus|ogg|mp3|m4a|wav|flac|aac|weba)$/i.test(file.name) ? "Sound"
  : file.type.startsWith("video/") ? "Video"
  : "File";

export function titleForFile(file: File, when = new Date()): string {
  const base = file.name.replace(/\.[a-z0-9]{1,5}$/i, "").trim();
  if (base && !GENERIC.test(base)) return base;
  const stamp = when.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  return `${kindWord(file)} · ${stamp}`;
}

const message = (e: unknown) => (e instanceof ApiError && e.detail) || "Couldn’t upload that.";

/** One new task per file in `laneId` (a lane of the board being viewed).
 * `title` names a single upload (typed alongside it). */
export async function tasksFromFiles(files: File[], laneId: string, title?: string): Promise<{ created: string[]; errors: string[] }> {
  const s = useBoardStore.getState();
  const board = s.board;
  if (!board) return { created: [], errors: ["No board"] };
  const created: string[] = [];
  const errors: string[] = [];
  for (const file of files) {
    try {
      const task = await createFileTask(board.id, file, {
        lane_id: laneId,
        title: files.length === 1 && title?.trim() ? title.trim() : titleForFile(file),
      });
      useBoardStore.getState().upsertTask(task);
      created.push(task.id);
    } catch (e) {
      errors.push(`${file.name}: ${message(e)}`);
    }
  }
  useBoardStore.getState().flashTasks(created, "pulse");
  return { created, errors };
}

/** Attach files to an existing task. Resolves to an error message or null. */
export async function attachFiles(taskId: string, files: File[]): Promise<string | null> {
  try {
    const { task } = await uploadFiles(taskId, files);
    useBoardStore.getState().upsertTask(task);
    return null;
  } catch (e) {
    return message(e);
  }
}

/** Files (not text) from a paste or drop, if any. */
export function filesFrom(data: DataTransfer | null): File[] {
  return data ? Array.from(data.files ?? []) : [];
}
