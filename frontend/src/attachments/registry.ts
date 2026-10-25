/** Every attachment kind the board knows how to show and add.
 *
 * To add a kind:
 *   1. register it on the server (backend/boards/attachments.py);
 *   2. write a plugin file here implementing AttachmentPlugin (./types.ts);
 *   3. list it in PLUGINS (the "Add…" menu order) and, if it detects pasted
 *      text, in DETECT_ORDER — specific detectors (maps links) before
 *      general ones (any web address). */

import email from "./email";
import event from "./event";
import file from "./file";
import github from "./github";
import link from "./link";
import phone from "./phone";
import place from "./place";
import type { AttachmentData, AttachmentPlugin } from "./types";

export const PLUGINS: AttachmentPlugin[] = [link, github, phone, email, place, event];

const DETECT_ORDER: AttachmentPlugin[] = [place, github, email, phone, link];

// Uploads have a plugin (how they show) but aren't added from the menu.
const byKind = new Map([...PLUGINS, file].map((p) => [p.kind, p]));

/** Shown for kinds the server knows but this build doesn't (e.g. added by
 * an API caller on a newer server): still listed, just not actionable. */
const unknown = (kind: string): AttachmentPlugin => ({
  kind,
  name: kind,
  icon: "•",
  fields: [],
  summary: (data) => Object.values(data)[0] ?? kind,
  actions: () => [],
});

export function iconOf(plugin: AttachmentPlugin, data: AttachmentData): string {
  return plugin.iconFor?.(data) ?? plugin.icon;
}

export function pluginFor(kind: string): AttachmentPlugin {
  return byKind.get(kind) ?? unknown(kind);
}

/** The first plugin that recognises pasted text, with its data. */
export function detect(text: string): { plugin: AttachmentPlugin; data: AttachmentData } | null {
  for (const plugin of DETECT_ORDER) {
    const data = plugin.detect?.(text);
    if (data) return { plugin, data };
  }
  return null;
}

export type { AttachmentAction, AttachmentData, AttachmentPlugin, FieldSpec } from "./types";
