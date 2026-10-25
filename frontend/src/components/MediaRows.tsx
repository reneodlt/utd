import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { claimPlayback, clock, releasePlayback, useMediaPrefs } from "../lib/mediaPlayer";
import type { Attachment } from "../types";

/** Saves a label; resolves to an error message, or null when it saved. */
export type SaveLabel = (label: string) => Promise<string | null>;

/** The attachment's label, edited in place: click, type, Enter saves, Esc
 * cancels (so a clip can be marked "chosen" or "runner-up"). Leaving the
 * field saves too, so a half-typed label isn't lost. */
export function EditableLabel({
  label,
  placeholder,
  fallback,
  onSave,
  className = "",
}: {
  label: string;
  placeholder: string;
  /** Shown (as ordinary text) when there is no label, e.g. a link's address. */
  fallback?: string;
  onSave: SaveLabel;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(label);
  const [error, setError] = useState<string | null>(null);
  const done = useRef(false);

  async function finish(save: boolean) {
    if (done.current) return;
    done.current = true;
    const next = draft.trim();
    if (save && next !== label) {
      const failed = await onSave(next);
      if (failed) {
        setError(failed);
        done.current = false;
        return;
      }
    }
    setError(null);
    setEditing(false);
  }

  if (!editing) {
    return (
      <button
        type="button"
        className={`label-edit${label || fallback ? "" : " is-empty"} ${className}`}
        title="Click to edit the label"
        onClick={() => {
          done.current = false;
          setDraft(label);
          setEditing(true);
        }}
      >
        {label || fallback || placeholder}
      </button>
    );
  }
  return (
    <span className={`label-editing ${className}`}>
      <input
        autoFocus
        value={draft}
        maxLength={200}
        aria-label="Label"
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={() => finish(true)}
        onKeyDown={(e) => {
          e.stopPropagation(); // Esc must not close the drawer, space must not play a clip
          if (e.key === "Enter") {
            e.preventDefault();
            finish(true);
          } else if (e.key === "Escape") {
            e.preventDefault();
            finish(false);
          }
        }}
      />
      {error && <span className="label-error" role="alert">{error}</span>}
    </span>
  );
}

const Speaker = ({ muted }: { muted: boolean }) => (
  <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2.5 6h2.4L8.5 3v10L4.9 10H2.5z" fill="currentColor" />
    {muted ? <path d="M11 6l3 4M14 6l-3 4" /> : <path d="M11 5.8a3.2 3.2 0 0 1 0 4.4M12.8 4a5.6 5.6 0 0 1 0 8" />}
  </svg>
);

export const speakerIcon = <Speaker muted={false} />;

/** A sound clip you can play where it sits: play/pause, a seek bar, time,
 * mute and volume. One clip (or video) plays at a time across the page;
 * space plays and pauses while the row has focus. */
export function AudioRow({
  attachment,
  onLabel,
  onRemove,
}: {
  attachment: Attachment;
  onLabel: SaveLabel;
  onRemove?: () => void;
}) {
  const { data } = attachment;
  const ref = useRef<HTMLAudioElement>(null);
  const known = Number(data.duration) || undefined;
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [length, setLength] = useState<number | undefined>(known);
  const [failed, setFailed] = useState(false);
  const { volume, muted, set } = useMediaPrefs();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.volume = volume;
    el.muted = muted;
  }, [volume, muted]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const on = (name: string, fn: () => void) => el.addEventListener(name, fn);
    on("play", () => {
      claimPlayback(el);
      setPlaying(true);
    });
    on("pause", () => setPlaying(false));
    on("ended", () => {
      setPlaying(false);
      setTime(0);
    });
    on("timeupdate", () => setTime(el.currentTime));
    const measured = () => Number.isFinite(el.duration) && setLength(el.duration);
    on("loadedmetadata", measured);
    on("durationchange", measured);
    on("error", () => setFailed(true));
    return () => {
      el.pause();
      releasePlayback(el);
    };
  }, []);

  function toggle() {
    const el = ref.current;
    if (!el) return;
    if (el.paused) el.play().catch(() => setFailed(true));
    else el.pause();
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== " ") return;
    const target = e.target as HTMLElement;
    // Buttons and text fields keep what space already means for them.
    if (target.tagName === "BUTTON" || target.tagName === "INPUT" && (target as HTMLInputElement).type !== "range") return;
    e.preventDefault();
    e.stopPropagation();
    toggle();
  }

  if (!data.url) return null;
  const name = data.name ?? "audio";
  return (
    <div className={`audio-row${playing ? " is-playing" : ""}${failed ? " is-failed" : ""}`} tabIndex={0} onKeyDown={onKeyDown} aria-label={`Audio clip ${attachment.label || name}`}>
      <audio ref={ref} src={data.url} preload={known ? "none" : "metadata"} />
      <button
        type="button"
        className="audio-play"
        onClick={toggle}
        aria-label={playing ? "Pause" : "Play"}
        title={playing ? "Pause (space)" : "Play (space)"}
        disabled={failed}
      >
        {playing ? (
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 2.5h2.8v11H4zM9.2 2.5H12v11H9.2z" fill="currentColor" /></svg>
        ) : (
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4.5 2.5l9 5.5-9 5.5z" fill="currentColor" /></svg>
        )}
      </button>
      <div className="audio-main">
        <div className="audio-head">
          <EditableLabel label={attachment.label} placeholder="+ label" onSave={onLabel} className="audio-label" />
          <span className="audio-file" title={name}>{name}</span>
        </div>
        {failed ? (
          <p className="audio-failed">
            This browser can’t play that file. <a href={`${data.url}?download=1`} download={name}>Download it</a>
          </p>
        ) : (
          <div className="audio-controls">
            <input
              type="range"
              className="audio-seek"
              min={0}
              max={length ?? 0}
              step={0.1}
              value={Math.min(time, length ?? 0)}
              disabled={!length}
              aria-label="Seek"
              aria-valuetext={`${clock(time)} of ${clock(length)}`}
              onChange={(e) => {
                const at = Number(e.target.value);
                setTime(at);
                if (ref.current) ref.current.currentTime = at;
              }}
            />
            <span className="audio-time">
              {clock(time)} / {clock(length)}
            </span>
            <button
              type="button"
              className="audio-mute"
              onClick={() => set({ muted: !muted })}
              aria-label={muted ? "Unmute" : "Mute"}
              aria-pressed={muted}
              title={muted ? "Unmute" : "Mute"}
            >
              <Speaker muted={muted || volume === 0} />
            </button>
            <input
              type="range"
              className="audio-volume"
              min={0}
              max={1}
              step={0.05}
              value={muted ? 0 : volume}
              aria-label="Volume"
              onChange={(e) => set({ volume: Number(e.target.value), muted: false })}
            />
          </div>
        )}
      </div>
      {onRemove && (
        <button type="button" className="audio-remove" title="Remove" aria-label={`Remove ${attachment.label || name}`} onClick={onRemove}>
          ×
        </button>
      )}
    </div>
  );
}

/** A video at the width of its card or drawer, with its poster frame and
 * the browser's own controls. Starting it stops any other clip. */
export function VideoRow({
  attachment,
  onLabel,
  onRemove,
}: {
  attachment: Attachment;
  onLabel: SaveLabel;
  onRemove?: () => void;
}) {
  const { data } = attachment;
  const ref = useRef<HTMLVideoElement>(null);
  const { volume, muted, set } = useMediaPrefs();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.volume = volume;
    el.muted = muted;
  }, [volume, muted]);
  useEffect(() => {
    const el = ref.current;
    return () => {
      if (el) {
        el.pause();
        releasePlayback(el);
      }
    };
  }, []);

  if (!data.url) return null;
  const name = data.name ?? "video";
  const ratio = Number(data.width) > 0 && Number(data.height) > 0 ? `${data.width} / ${data.height}` : "16 / 9";
  return (
    <div className="video-row">
      <video
        ref={ref}
        src={data.url}
        poster={data.thumb_url}
        controls
        playsInline
        preload="metadata"
        style={{ aspectRatio: ratio }}
        aria-label={`Video ${attachment.label || name}`}
        onPlay={(e) => claimPlayback(e.currentTarget)}
        onVolumeChange={(e) => set({ volume: e.currentTarget.volume, muted: e.currentTarget.muted })}
      />
      <div className="video-meta">
        <EditableLabel label={attachment.label} placeholder="+ label" onSave={onLabel} className="audio-label" />
        <span className="audio-file" title={name}>
          {name}
          {data.duration ? ` · ${clock(Number(data.duration))}` : ""}
        </span>
        {onRemove && (
          <button type="button" className="audio-remove" title="Remove" aria-label={`Remove ${attachment.label || name}`} onClick={onRemove}>
            ×
          </button>
        )}
      </div>
    </div>
  );
}
