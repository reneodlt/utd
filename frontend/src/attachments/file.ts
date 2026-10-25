import { clock } from "../lib/mediaPlayer";
import type { AttachmentData, AttachmentPlugin } from "./types";

export const isImage = (data: AttachmentData) => (data.content_type ?? "").startsWith("image/");

/** What the bytes are. The server says (`media`); rows from before that
 * existed are told apart by their content type. */
export const mediaOf = (data: AttachmentData): "audio" | "video" | "image" | "file" =>
  (["audio", "video", "image", "file"] as const).find((m) => m === data.media) ?? (isImage(data) ? "image" : "file");

function size(bytes: string | undefined): string {
  const n = Number(bytes);
  if (!n) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Uploaded photos and files (stored by the server). Not in the "Add…"
 * menu — they arrive by upload (camera button, file picker, paste). */
const file: AttachmentPlugin = {
  kind: "file",
  name: "Photo or file",
  icon: "⎙",
  fields: [],

  iconFor: (data) => ({ image: "◩", audio: "♪", video: "▶", file: "⎙" })[mediaOf(data)],

  summary: (data) => data.name ?? "file",

  detail: (data) =>
    [
      mediaOf(data) !== "audio" && data.width ? `${data.width}×${data.height}` : "",
      data.duration ? clock(Number(data.duration)) : "",
      size(data.size),
    ]
      .filter(Boolean)
      .join(" · ") ||
    undefined,

  actions: (data) =>
    data.url
      ? [
          { label: "Open", href: data.url, newTab: true },
          { label: "Download", href: `${data.url}?download=1`, download: data.name ?? "file" },
        ]
      : [],
};

export default file;
