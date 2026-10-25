import { useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import {
  addAttachment,
  ApiError,
  removeAttachment,
  updateAttachment,
  type AttachmentResult,
  type MutationMeta,
} from "../api/client";
import {
  detect,
  iconOf,
  pluginFor,
  PLUGINS,
  type AttachmentAction,
  type AttachmentData,
  type AttachmentPlugin,
} from "../attachments/registry";
import { isImage, mediaOf } from "../attachments/file";
import { copyText, newOpId } from "../lib/compat";
import { attachFiles, filesFrom } from "../lib/uploads";
import { useBoardStore } from "../store/boardStore";
import type { Attachment, Task } from "../types";
import { keepToControl } from "../lib/controls";
import { AudioRow, EditableLabel, VideoRow, speakerIcon } from "./MediaRows";

const CHIP_LIMIT = 3;

export function titleOf(attachment: Attachment): string {
  return attachment.label || pluginFor(attachment.kind).summary(attachment.data);
}

function ActionLink({
  action,
  className,
  children,
  onClick,
}: {
  action: AttachmentAction;
  className: string;
  children: React.ReactNode;
  onClick?: (e: React.MouseEvent) => void;
}) {
  return (
    <a
      className={className}
      href={action.href}
      download={action.download}
      target={action.newTab ? "_blank" : undefined}
      rel={action.newTab ? "noreferrer" : undefined}
      onClick={onClick}
    >
      {children}
    </a>
  );
}

/** A card's attachments as compact chips; clicking one does its primary
 * action (open the page, call the number, add the event...). */
/** Photos among a task's attachments (shown as images, not chips). */
export const photosOf = (attachments: Attachment[]) =>
  attachments.filter((a) => a.kind === "file" && isImage(a.data) && a.data.thumb_url);

/** Uploaded sound clips among a task's attachments (a speaker badge on the
 * card; the drawer plays them). */
export const audioOf = (attachments: Attachment[]) =>
  attachments.filter((a) => a.kind === "file" && mediaOf(a.data) === "audio");

/** The card's speaker badge: how many sound clips it carries. A plain
 * badge, so a click opens the task like anywhere else on the card. */
export function AudioBadge({ attachments }: { attachments: Attachment[] }) {
  const n = audioOf(attachments).length;
  if (n === 0) return null;
  return (
    <span className="badge badge-audio" title={`${n} sound clip${n === 1 ? "" : "s"}`}>
      {speakerIcon}
      <span>{n}</span>
    </span>
  );
}

/** Save an attachment's label (audited like any edit). Resolves to an error
 * message, or null when it saved. */
export function saveLabel(taskId: string, attachmentId: string, label: string): Promise<string | null> {
  return mutate((meta) => updateAttachment(taskId, attachmentId, { label, meta }));
}

/** A clip as it plays in the drawer and the log. */
export function MediaClip({ taskId, attachment, onRemove }: { taskId: string; attachment: Attachment; onRemove?: () => void }) {
  const onLabel = (label: string) => saveLabel(taskId, attachment.id, label);
  return mediaOf(attachment.data) === "video" ? (
    <VideoRow attachment={attachment} onLabel={onLabel} onRemove={onRemove} />
  ) : (
    <AudioRow attachment={attachment} onLabel={onLabel} onRemove={onRemove} />
  );
}

/** Audio and video play in rows of their own, not as chips or photos. */
export const isClip = (a: Attachment) => a.kind === "file" && ["audio", "video"].includes(mediaOf(a.data));

/** A card's first photo as a cover, "+N" if there are more; opens the
 * photo viewer. */
export function CardPhoto({ attachments }: { attachments: Attachment[] }) {
  const photos = photosOf(attachments);
  const [viewing, setViewing] = useState<number | null>(null);
  if (photos.length === 0) return null;
  return (
    <>
      <button
        type="button"
        className="card-photo"
        aria-label={`View photo${photos.length > 1 ? `s (${photos.length})` : ""}`}
        onClick={(e) => {
          e.stopPropagation();
          setViewing(0);
        }}
        {...keepToControl}
      >
        <img src={photos[0].data.thumb_url} alt="" loading="lazy" draggable={false} />
        {photos.length > 1 && <span className="card-photo-more">+{photos.length - 1}</span>}
      </button>
      {viewing !== null && <PhotoViewer photos={photos} start={viewing} onClose={() => setViewing(null)} />}
    </>
  );
}

/** Full-size photos, one at a time; ←/→ between them, Esc closes. */
export function PhotoViewer({ photos, start, onClose }: { photos: Attachment[]; start: number; onClose: () => void }) {
  const [i, setI] = useState(start);
  const photo = photos[i];
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      } else if (e.key === "ArrowRight") setI((n) => (n + 1) % photos.length);
      else if (e.key === "ArrowLeft") setI((n) => (n - 1 + photos.length) % photos.length);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [photos.length, onClose]);
  if (!photo) return null;
  return createPortal(
    <div
      className="photo-viewer"
      role="dialog"
      aria-modal="true"
      aria-label={photo.data.name}
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <img src={photo.data.url} alt={photo.label || photo.data.name} onClick={(e) => e.stopPropagation()} />
      <div className="photo-viewer-bar" onClick={(e) => e.stopPropagation()}>
        <span>
          {photo.label || photo.data.name}
          {photos.length > 1 && ` · ${i + 1} of ${photos.length}`}
        </span>
        {photos.length > 1 && (
          <>
            <button type="button" onClick={() => setI((i - 1 + photos.length) % photos.length)} aria-label="Previous">
              ‹
            </button>
            <button type="button" onClick={() => setI((i + 1) % photos.length)} aria-label="Next">
              ›
            </button>
          </>
        )}
        <a href={`${photo.data.url}?download=1`} download={photo.data.name}>
          Download
        </a>
        <button type="button" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
    </div>,
    document.body,
  );
}

export function AttachmentChips({ attachments: all }: { attachments: Attachment[] }) {
  // Photos show as the card's cover instead.
  // Sound clips show as the speaker badge.
  const photos = new Set(photosOf(all).map((a) => a.id));
  const attachments = all.filter((a) => !photos.has(a.id) && !audioOf([a]).length);
  const shown = attachments.slice(0, CHIP_LIMIT);
  const more = attachments.length - shown.length;
  return (
    <>
      {shown.map((a) => {
        const plugin = pluginFor(a.kind);
        const [primary] = plugin.actions(a.data, a.label);
        const text = titleOf(a);
        const content = (
          <>
            <span className="chip-icon" aria-hidden="true">
              {iconOf(plugin, a.data)}
            </span>
            <span className="chip-text">{text}</span>
          </>
        );
        return primary ? (
          <span key={a.id} {...keepToControl} className="chip-wrap">
            <ActionLink
              action={primary}
              className={`badge badge-attachment kind-${a.kind}`}
              onClick={(e) => e.stopPropagation()}
            >
              <span title={`${primary.label}: ${text}`}>{content}</span>
            </ActionLink>
          </span>
        ) : (
          <span key={a.id} className={`badge badge-attachment kind-${a.kind}`} title={text}>
            {content}
          </span>
        );
      })}
      {more > 0 && (
        <span className="badge" title={attachments.slice(CHIP_LIMIT).map(titleOf).join("\n")}>
          +{more}
        </span>
      )}
    </>
  );
}

/** Run an attachment mutation with op-id bookkeeping; the answer carries
 * the updated task. Resolves to an error message, or null on success. */
async function mutate(run: (meta: MutationMeta) => Promise<AttachmentResult>): Promise<string | null> {
  const store = useBoardStore.getState();
  const opId = newOpId();
  store.registerOp(opId);
  try {
    const result = await run({ op_id: opId, actor: "board-user" });
    useBoardStore.getState().upsertTask(result.task);
    return null;
  } catch (error) {
    useBoardStore.getState().resolveOp(opId);
    return (error instanceof ApiError && error.detail) || "Couldn’t save that. Try again?";
  }
}

type Mode =
  | { type: "idle" }
  | { type: "choose" }
  | { type: "form"; plugin: AttachmentPlugin; data: AttachmentData; label: string; editing?: string };

/** The drawer's "Attached" section: everything the task carries, with
 * actions, and the "Add…" flow. Kinds come from the plugin registry. */
export function AttachmentsSection({ task }: { task: Task }) {
  const [mode, setMode] = useState<Mode>({ type: "idle" });
  const [error, setError] = useState<string | null>(null);
  const { attachments } = task;
  const photos = photosOf(attachments);
  const [viewing, setViewing] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function upload(files: File[]) {
    if (!files.length) return;
    setUploading(true);
    setError(await attachFiles(task.id, files));
    setUploading(false);
  }

  function open(next: Mode) {
    setError(null);
    setMode(next);
  }

  async function remove(a: Attachment) {
    const failed = await mutate((meta) => removeAttachment(task.id, a.id, meta));
    setError(failed);
    if (!failed) {
      useBoardStore.getState().offerUndo(`Removed ${titleOf(a)}`, async () => {
        const again = await mutate((meta) => addAttachment(task.id, { kind: a.kind, data: a.data, label: a.label, meta }));
        if (again) throw new Error(again);
      });
    }
  }

  return (
    <section
      className={`attachments${dragOver ? " is-drop" : ""}`}
      aria-labelledby="attachments-title"
      onDragOver={(e) => {
        if (Array.from(e.dataTransfer.types).includes("Files")) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        const files = filesFrom(e.dataTransfer);
        setDragOver(false);
        if (files.length) {
          e.preventDefault();
          upload(files);
        }
      }}
    >
      <div className="attachments-bar">
        <h3 id="attachments-title">
          Attached
          {attachments.length > 0 && <span className="history-count">{attachments.length}</span>}
        </h3>
        {mode.type === "idle" && (
          <span className="attach-buttons">
            <button type="button" className="attach-add" onClick={() => fileRef.current?.click()} disabled={uploading}>
              {uploading ? "Uploading…" : "+ Photo / audio / file"}
            </button>
            <button type="button" className="attach-add" onClick={() => open({ type: "choose" })}>
              + Add…
            </button>
          </span>
        )}
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            upload(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
      </div>

      {photos.length > 0 && (
        <div className="photo-grid">
          {photos.map((p, i) => (
            <button key={p.id} type="button" className="photo-thumb" onClick={() => setViewing(i)} aria-label={`View ${p.data.name}`}>
              <img src={p.data.thumb_url} alt="" loading="lazy" />
            </button>
          ))}
        </div>
      )}
      {viewing !== null && <PhotoViewer photos={photos} start={viewing} onClose={() => setViewing(null)} />}

      {mode.type === "choose" && (
        <KindChooser
          taskId={task.id}
          onPick={(plugin, data = {}) => open({ type: "form", plugin, data, label: "" })}
          onDone={() => open({ type: "idle" })}
        />
      )}

      {mode.type === "form" && (
        <AttachmentForm
          key={mode.editing ?? mode.plugin.kind}
          plugin={mode.plugin}
          initial={mode.data}
          initialLabel={mode.label}
          editing={!!mode.editing}
          onCancel={() => open({ type: mode.editing ? "idle" : "choose" })}
          onSave={async (data, label) => {
            const failed = await mutate((meta) =>
              mode.editing
                ? updateAttachment(task.id, mode.editing, { data, label, meta })
                : addAttachment(task.id, { kind: mode.plugin.kind, data, label, meta }),
            );
            if (!failed) open({ type: "idle" });
            return failed;
          }}
        />
      )}

      {error && <p className="attach-error" role="alert">{error}</p>}

      {attachments.length === 0 && mode.type === "idle" && (
        <p className="attachments-empty">
          Links, phone numbers, email addresses, places and calendar entries for this task.
        </p>
      )}

      {attachments.length > 0 && (
        <ul className="attachment-list">
          {attachments.map((a) =>
            isClip(a) ? (
              <li key={a.id} className={`attachment-row is-clip kind-file`}>
                <MediaClip taskId={task.id} attachment={a} onRemove={() => remove(a)} />
              </li>
            ) : (
            <AttachmentRow
              key={a.id}
              taskId={task.id}
              attachment={a}
              onEdit={(plugin) =>
                open({ type: "form", plugin, data: a.data, label: a.label, editing: a.id })
              }
              onRemove={() => remove(a)}
            />
            ),
          )}
        </ul>
      )}
    </section>
  );
}

function AttachmentRow({
  taskId,
  attachment,
  onEdit,
  onRemove,
}: {
  taskId: string;
  attachment: Attachment;
  onEdit: (plugin: AttachmentPlugin) => void;
  onRemove: () => void;
}) {
  const plugin = pluginFor(attachment.kind);
  const actions = plugin.actions(attachment.data, attachment.label);
  const summary = plugin.summary(attachment.data);
  const detail = plugin.detail?.(attachment.data) ?? (attachment.label ? summary : undefined);
  const [copied, setCopied] = useState(false);
  const copyValue = plugin.copy?.(attachment.data);

  return (
    <li className={`attachment-row kind-${attachment.kind}`}>
      <span className="attachment-icon" aria-hidden="true">
        {iconOf(plugin, attachment.data)}
      </span>
      <div className="attachment-main">
        <p className="attachment-title">
          <EditableLabel
            label={attachment.label}
            fallback={summary}
            placeholder="+ label"
            onSave={(label) => saveLabel(taskId, attachment.id, label)}
          />
        </p>
        {detail && detail !== titleOf(attachment) && <p className="attachment-detail">{detail}</p>}
        {actions.length > 0 && (
          <div className="attachment-actions">
            {actions.map((action) => (
              <ActionLink key={action.label} action={action} className="attachment-action">
                {action.label}
                {action.newTab && <span aria-hidden="true"> ↗</span>}
              </ActionLink>
            ))}
          </div>
        )}
      </div>
      <div className="attachment-tools">
        {copyValue && (
          <button
            type="button"
            title={copied ? "Copied" : "Copy"}
            aria-label={`Copy ${titleOf(attachment)}`}
            onClick={() => {
              copyText(copyValue);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1200);
            }}
          >
            {copied ? "✓" : "⧉"}
          </button>
        )}
        {plugin.fields.length > 0 && (
          <button
            type="button"
            title="Edit"
            aria-label={`Edit ${titleOf(attachment)}`}
            onClick={() => onEdit(plugin)}
          >
            ✎
          </button>
        )}
        <button
          type="button"
          className="attachment-remove"
          title="Remove"
          aria-label={`Remove ${titleOf(attachment)}`}
          onClick={onRemove}
        >
          ×
        </button>
      </div>
    </li>
  );
}

/** Pick a kind, or paste anything and let the plugins recognise it. */
function KindChooser({
  taskId,
  onPick,
  onDone,
}: {
  taskId: string;
  onPick: (plugin: AttachmentPlugin, data?: AttachmentData) => void;
  onDone: () => void;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const found = text.trim() ? detect(text) : null;

  async function quickAdd(event: FormEvent) {
    event.preventDefault();
    if (!found || saving) return;
    setSaving(true);
    const failed = await mutate((meta) =>
      addAttachment(taskId, { kind: found.plugin.kind, data: found.data, meta }),
    );
    setSaving(false);
    if (failed) setError(failed);
    else onDone();
  }

  return (
    <div className="attach-chooser">
      <form onSubmit={quickAdd} className="attach-paste">
        <input
          autoFocus
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), onDone())}
          placeholder="Paste a link, email, phone number or map link"
          aria-label="Paste something to attach"
        />
        <p className="attach-hint" aria-live="polite">
          {error ? (
            <span className="attach-error">{error}</span>
          ) : found ? (
            <>
              <span aria-hidden="true">{iconOf(found.plugin, found.data)}</span> {found.plugin.name}:{" "}
              <strong>{found.plugin.summary(found.data)}</strong> · Enter to add, or{" "}
              <button
                type="button"
                className="link-button"
                onClick={() => onPick(found.plugin, found.data)}
              >
                add details
              </button>
            </>
          ) : text.trim() ? (
            "Not sure what that is. Pick a kind below."
          ) : (
            "…or choose what to add:"
          )}
        </p>
      </form>
      <div className="attach-kinds" role="group" aria-label="Kinds of attachment">
        {PLUGINS.map((plugin) => (
          <button key={plugin.kind} type="button" onClick={() => onPick(plugin)}>
            <span className="chip-icon" aria-hidden="true">
              {plugin.icon}
            </span>
            {plugin.name}
          </button>
        ))}
        <button type="button" className="attach-cancel" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** A kind's fields plus an optional label, built from its plugin. */
function AttachmentForm({
  plugin,
  initial,
  initialLabel,
  editing,
  onSave,
  onCancel,
}: {
  plugin: AttachmentPlugin;
  initial: AttachmentData;
  initialLabel: string;
  editing: boolean;
  onSave: (data: AttachmentData, label: string) => Promise<string | null>;
  onCancel: () => void;
}) {
  const [data, setData] = useState<AttachmentData>(initial);
  const [label, setLabel] = useState(initialLabel);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    const cleaned = Object.fromEntries(
      Object.entries(data).filter(([, v]) => v.trim() !== ""),
    );
    const failed = await onSave(cleaned, label.trim());
    setSaving(false);
    setError(failed);
  }

  return (
    <form
      className="attach-form"
      onSubmit={submit}
      onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), onCancel())}
    >
      <p className="attach-form-title">
        <span className="chip-icon" aria-hidden="true">
          {plugin.icon}
        </span>
        {editing ? `Edit ${plugin.name.toLowerCase()}` : plugin.name}
      </p>
      {plugin.fields.map((field, i) => (
        <label key={field.name} className="attach-field">
          <span>
            {field.label}
            {!field.required && <em> optional</em>}
          </span>
          <input
            autoFocus={i === 0}
            type={field.input}
            required={field.required}
            placeholder={field.placeholder}
            value={data[field.name] ?? ""}
            onChange={(e) => setData((d) => ({ ...d, [field.name]: e.target.value }))}
          />
        </label>
      ))}
      <label className="attach-field">
        <span>
          Label<em> optional</em>
        </span>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={`Shown instead of the ${plugin.fields[0]?.label.toLowerCase() ?? "value"}`}
          maxLength={200}
        />
      </label>
      {error && <p className="attach-error" role="alert">{error}</p>}
      <div className="attach-form-buttons">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={saving}>
          {saving ? "Saving…" : editing ? "Save" : "Attach"}
        </button>
      </div>
    </form>
  );
}
