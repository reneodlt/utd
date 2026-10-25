/** Deadlines written in a quick-add line: "Send invoice due friday",
 * "Book venue by 3 oct", "call Jim tomorrow". The phrase is taken out of
 * the title and returned as a date (YYYY-MM-DD, local).
 *
 * Needs a keyword (due / by / before) — except today, tonight, tomorrow,
 * next week and "in N days/weeks" at the end of the line — so "Friday
 * drinks" stays a title.
 * Dates are UK-style (26/9 = 26 September). */

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september",
  "october", "november", "december"];

const WD = "(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day|nesday|rsday|urday)?";
const MON = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*";
const WHEN = [
  "today", "tonight", "tomorrow", "tmrw", "tmr",
  `next\\s+${WD}`, WD,
  "next\\s+week", "end\\s+of\\s+(?:the\\s+)?week", "eow",
  "end\\s+of\\s+(?:the\\s+)?month", "eom",
  "in\\s+\\d{1,3}\\s+(?:days?|weeks?)",
  `\\d{1,2}(?:st|nd|rd|th)?\\s+${MON}(?:\\s+\\d{4})?`,
  `${MON}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?`,
  "\\d{4}-\\d{2}-\\d{2}",
  "\\d{1,2}\\/\\d{1,2}(?:\\/\\d{2,4})?",
].join("|");

const WITH_KEYWORD = new RegExp(`(?:^|\\s)(?:due|by|before)\\s+(?:on\\s+)?(${WHEN})(?=$|[\\s.,;!?)])`, "i");
const BARE_AT_END = /(?:^|\s)(today|tonight|tomorrow|tmrw|next\s+week|in\s+\d{1,3}\s+(?:days?|weeks?))[.!]?\s*$/i;

function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function weekdayIndex(word: string): number {
  const w = word.toLowerCase().slice(0, 3);
  return WEEKDAYS.findIndex((d) => d.startsWith(w));
}

function monthIndex(word: string): number {
  const m = word.toLowerCase().slice(0, 3);
  return MONTHS.findIndex((x) => x.startsWith(m));
}

/** A date this year, or next year if it has already gone by. */
function upcoming(month: number, day: number, year: number | undefined, today: Date): Date | null {
  const y = year ?? today.getFullYear();
  const d = new Date(y, month, day);
  if (d.getMonth() !== month) return null; // 31 Feb etc.
  if (year === undefined && d < new Date(today.getFullYear(), today.getMonth(), today.getDate())) {
    d.setFullYear(y + 1);
  }
  return d;
}

export function resolveWhen(phrase: string, today = new Date()): string | null {
  const p = phrase.toLowerCase().replace(/\s+/g, " ").trim();
  const base = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  if (p === "today" || p === "tonight") return iso(base);
  if (["tomorrow", "tmrw", "tmr"].includes(p)) return iso(addDays(base, 1));
  if (p === "next week") return iso(addDays(base, 7));
  if (p === "eow" || /^end of (the )?week$/.test(p)) {
    // This Friday; at the weekend, next Friday.
    const ahead = (5 - base.getDay() + 7) % 7;
    return iso(addDays(base, base.getDay() === 6 ? 6 : ahead));
  }
  if (p === "eom" || /^end of (the )?month$/.test(p)) {
    return iso(new Date(base.getFullYear(), base.getMonth() + 1, 0));
  }
  let m = p.match(/^in (\d{1,3}) (day|week)s?$/);
  if (m) return iso(addDays(base, Number(m[1]) * (m[2] === "week" ? 7 : 1)));
  m = p.match(/^(next )?([a-z]+)$/);
  if (m && weekdayIndex(m[2]) >= 0) {
    // "friday" = the coming Friday (today if it is Friday);
    // "next friday" = the Friday of next week.
    let ahead = (weekdayIndex(m[2]) - base.getDay() + 7) % 7;
    if (m[1]) ahead += 7;
    return iso(addDays(base, ahead));
  }
  m = p.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return iso(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  m = p.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (m) {
    const year = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : undefined;
    const d = upcoming(Number(m[2]) - 1, Number(m[1]), year, base);
    return d ? iso(d) : null;
  }
  m = p.match(/^(\d{1,2})(?:st|nd|rd|th)? ([a-z]+)(?: (\d{4}))?$/);
  if (m && monthIndex(m[2]) >= 0) {
    const d = upcoming(monthIndex(m[2]), Number(m[1]), m[3] ? Number(m[3]) : undefined, base);
    return d ? iso(d) : null;
  }
  m = p.match(/^([a-z]+) (\d{1,2})(?:st|nd|rd|th)?(?:,? (\d{4}))?$/);
  if (m && monthIndex(m[1]) >= 0) {
    const d = upcoming(monthIndex(m[1]), Number(m[2]), m[3] ? Number(m[3]) : undefined, base);
    return d ? iso(d) : null;
  }
  return null;
}

/** Pull a deadline out of a line: the rest of the line, and the date. */
export function extractDue(line: string, today = new Date()): { rest: string; due?: string } {
  for (const pattern of [WITH_KEYWORD, BARE_AT_END]) {
    const m = line.match(pattern);
    if (!m) continue;
    const due = resolveWhen(m[1], today);
    if (!due) continue;
    const rest = (line.slice(0, m.index) + line.slice((m.index ?? 0) + m[0].length))
      .replace(/\s+/g, " ")
      .replace(/[\s,;:–—-]+$/, "")
      .trim();
    return { rest: rest || line, due };
  }
  return { rest: line };
}
