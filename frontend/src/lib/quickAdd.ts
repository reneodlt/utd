/** Quick add: turn whatever was typed or pasted into draft tasks. One per
 * non-empty line (list markers stripped). A line with a link or contact
 * becomes a task of that kind: the attachment plugins decide what it is
 * (GitHub PR/issue, web page, map, email, phone), the task carries it, and
 * a bare link gets its real title looked up. */

import { getLinkTitle } from "../api/client";
import { detect, pluginFor } from "../attachments/registry";
import { extractDue } from "./dueParse";
import { extractFigures, type DraftFigure } from "./figureParse";
import type { AttachmentData } from "../attachments/types";

export interface Draft {
  title: string;
  attachment?: { kind: string; data: AttachmentData; label?: string };
  /** A bare link: fetch its real title before creating (else keep `title`). */
  lookup?: string;
  /** "… due friday": the deadline, YYYY-MM-DD. */
  due?: string;
  /** "£45", "~3h": figures for the board's cost / time categories. */
  figures?: DraftFigure[];
}

const URL_IN_TEXT = /\b((?:https?:\/\/|www\.)[^\s<>"']+)/i;
const LIST_MARKER = /^\s*(?:[-*+•]\s+)?(?:\d+[.)]\s+)?(?:\[[ xX]?\]\s+)?/;

function cleanLine(line: string): string {
  return line.replace(LIST_MARKER, "").trim();
}

/** Trailing punctuation that's sentence, not URL: "see https://x.com/a." */
function trimUrl(url: string): string {
  return url.replace(/[.,;:!?)\]}>'"]+$/, "");
}

/** A readable title for a kind when there's no text and no lookup. */
function titleFor(kind: string, data: AttachmentData): string {
  const summary = pluginFor(kind).summary(data);
  if (kind === "email") return `Email ${summary}`;
  if (kind === "phone") return `Call ${summary}`;
  if (kind === "place") return `Visit ${summary}`;
  return summary;
}

const EMAIL_IN_TEXT = /[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[a-z]{2,}/i;
// Starts with + / 0 / tel: so dates, times and versions don't count.
const PHONE_IN_TEXT = /(?:tel:)?(?:\+|\b0)\d[\d\s().-]{5,}\d/;
// "call Jim at …", "ring Mum on …", "email Sarah: …" → Jim / Mum / Sarah
const WHO = /^(?:please\s+)?(?:call|ring|phone|text|message|whatsapp|email|e-mail|mail|contact)\s+(.+?)(?:\s+(?:at|on|via|using))?[\s:,-]*$/i;

function contactIn(line: string): { kind: string; data: AttachmentData; label?: string } | null {
  for (const [kind, pattern] of [["email", EMAIL_IN_TEXT], ["phone", PHONE_IN_TEXT]] as const) {
    const m = line.match(pattern);
    if (!m) continue;
    const found = detect(m[0]);
    if (!found || found.plugin.kind !== kind) continue;
    const before = line.slice(0, m.index).trim();
    const who = before.match(WHO)?.[1]?.trim();
    return { kind, data: found.data, ...(who && who.length <= 40 ? { label: who } : {}) };
  }
  return null;
}

export function parseQuickAdd(text: string): Draft[] {
  return text
    .split(/\r?\n/)
    .map(cleanLine)
    .filter(Boolean)
    .map((raw): Draft => {
      const { rest: dueless, due } = extractDue(raw);
      const { rest: line, figures } = extractFigures(dueless);
      return { ...parseLine(line || dueless), ...(due ? { due } : {}), ...(figures.length ? { figures } : {}) };
    });
}

/** One line (deadline already taken out) → a draft task. */
function parseLine(line: string): Draft {
  const m = line.match(URL_IN_TEXT);
  if (m) {
    const url = trimUrl(m[1]);
    const found = detect(url);
    // The rest of the line, minus separators around where the URL was.
    const rest = line
      .replace(m[1], " ")
      .replace(/\s+/g, " ")
      .replace(/^[\s:–—|-]+|[\s:–—|-]+$/g, "")
      .trim();
    if (!found) return { title: line };
    const attachment = { kind: found.plugin.kind, data: found.data };
    return rest
      ? { title: rest, attachment }
      : {
          title: titleFor(attachment.kind, attachment.data),
          attachment,
          // Pages and GitHub have real titles worth fetching; a maps
          // link's title is just "Google Maps" — the place name is better.
          lookup: attachment.kind === "link" || attachment.kind === "github" ? found.data.url ?? url : undefined,
        };
  }
  // Whole line is a contact (email address, phone number)?
  const found = detect(line);
  if (found && (found.plugin.kind === "email" || found.plugin.kind === "phone")) {
    const attachment = { kind: found.plugin.kind, data: found.data };
    return { title: titleFor(attachment.kind, attachment.data), attachment };
  }
  // A contact inside a sentence: "call Jim at +44 20 7946 0958". The
  // sentence stays the title; the contact is attached, named if the
  // line says who.
  const contact = contactIn(line);
  if (contact) return { title: line, attachment: contact };
  return { title: line };
}

const LOOKUP_TIMEOUT_MS = 5000;

/** A link's real title, or null (slow, unknown, or offline). */
export async function lookUpTitle(url: string): Promise<string | null> {
  const timeout = new Promise<null>((resolve) => window.setTimeout(() => resolve(null), LOOKUP_TIMEOUT_MS));
  const found = getLinkTitle(url).then((r) => r.title?.trim() || null).catch(() => null);
  return Promise.race([found, timeout]);
}

/** Drafts with their looked-up titles filled in. */
export function resolveDrafts(drafts: Draft[]): Promise<Draft[]> {
  return Promise.all(
    drafts.map(async (d) => {
      const title = d.lookup ? await lookUpTitle(d.lookup) : null;
      return title ? { ...d, title } : d;
    }),
  );
}
