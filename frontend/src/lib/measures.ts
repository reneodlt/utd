/** What a category can let its tasks carry a figure for. Each value type
 * knows how to read what you type, show a figure, and roll figures up.
 * Add a type here and in backend/boards/measures.py.
 *
 * Figures are stored in one unit per type: money in pounds (etc.),
 * durations in minutes, numbers as given, percentages 0–100. */

import type { Category, ValueConfig, ValueType } from "../types";

export interface MeasureContext {
  config: ValueConfig;
  /** For durations: how many hours make a day. */
  hoursPerDay: number;
}

export interface Measure {
  label: string;
  /** What the settings screen says about it. */
  hint: string;
  placeholder: (ctx: MeasureContext) => string;
  /** null when it can't be read. */
  parse: (text: string, ctx: MeasureContext) => number | null;
  /** `compact` for chips: fewer digits, fewer units. */
  format: (value: number, ctx: MeasureContext, compact?: boolean) => string;
  rollup: "sum" | "average";
  /** Categories with the same key add together in totals (all £ costs,
   * all times); otherwise each category totals on its own. */
  groupKey: (category: Category) => string;
}

export const CURRENCIES: { code: string; symbol: string }[] = [
  { code: "GBP", symbol: "£" },
  { code: "EUR", symbol: "€" },
  { code: "USD", symbol: "$" },
];

const currencyOf = (config: ValueConfig) => config.currency || "GBP";

function plainNumber(text: string): number | null {
  const t = text.trim().replace(/,/g, "");
  if (!/^-?\d*\.?\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

const money: Measure = {
  label: "Money",
  hint: "A £ figure per task, e.g. cost or budget. Adds up on parents and the board.",
  placeholder: (ctx) => `${CURRENCIES.find((c) => c.code === currencyOf(ctx.config))?.symbol ?? ""}0`,
  parse(text) {
    const t = text.trim().replace(/[£€$]|GBP|EUR|USD/gi, "").replace(/,/g, "").trim();
    const m = /^(-?\d*\.?\d+)\s*(k|m)?$/i.exec(t);
    if (!m) return null;
    const scale = m[2]?.toLowerCase() === "k" ? 1e3 : m[2]?.toLowerCase() === "m" ? 1e6 : 1;
    return Math.round(Number(m[1]) * scale * 100) / 100;
  },
  format(value, ctx, compact) {
    const currency = currencyOf(ctx.config);
    const whole = Number.isInteger(value);
    if (compact && Math.abs(value) >= 10_000) {
      return new Intl.NumberFormat("en-GB", {
        style: "currency", currency, notation: "compact", maximumFractionDigits: 1,
      }).format(value);
    }
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency,
      minimumFractionDigits: whole ? 0 : 2,
      maximumFractionDigits: whole ? 0 : 2,
    }).format(value);
  },
  rollup: "sum",
  groupKey: (c) => `money:${currencyOf(c.value_config)}`,
};

/** "2h", "90m", "1d 4h", "1.5d", "2h30", "2:30", or a bare number of hours. */
export function parseDuration(text: string, hoursPerDay: number): number | null {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  const clock = /^(\d+):([0-5]\d)$/.exec(t);
  if (clock) return Number(clock[1]) * 60 + Number(clock[2]);
  const bare = plainNumber(t);
  if (bare !== null) return bare < 0 ? null : Math.round(bare * 60);
  const unit = { d: hoursPerDay * 60, h: 60, m: 1 } as const;
  let minutes = 0;
  let rest = t.replace(/\s+/g, "");
  // "2h30" → trailing minutes after hours
  rest = rest.replace(/h(\d+)$/, "h$1m");
  const part = /^(\d*\.?\d+)(d|h|m)/;
  let matched = false;
  while (rest) {
    const m = part.exec(rest);
    if (!m) return null;
    minutes += Number(m[1]) * unit[m[2] as keyof typeof unit];
    rest = rest.slice(m[0].length);
    matched = true;
  }
  return matched ? Math.round(minutes) : null;
}

export function formatDuration(minutes: number, hoursPerDay: number, compact = false): string {
  if (minutes <= 0) return "0h";
  const perDay = Math.round(hoursPerDay * 60);
  let rest = Math.round(minutes);
  const days = Math.floor(rest / perDay);
  rest -= days * perDay;
  const hours = Math.floor(rest / 60);
  const mins = rest - hours * 60;
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (mins) parts.push(`${mins}m`);
  return (compact ? parts.slice(0, 2) : parts).join(" ");
}

const duration: Measure = {
  label: "Time",
  hint: "A time estimate per task, like 2h, 1d 4h or 90m. Adds up on parents and the board.",
  placeholder: () => "e.g. 2h, 1d 4h",
  parse: (text, ctx) => parseDuration(text, ctx.hoursPerDay),
  format: (value, ctx, compact) => formatDuration(value, ctx.hoursPerDay, compact),
  rollup: "sum",
  groupKey: () => "duration",
};

const number: Measure = {
  label: "Number",
  hint: "Any figure, with an optional unit (points, miles…). Adds up on parents and the board.",
  placeholder: (ctx) => (ctx.config.unit ? `0 ${ctx.config.unit}` : "0"),
  parse(text, ctx) {
    const unit = ctx.config.unit?.trim();
    const t = unit ? text.replace(new RegExp(`\\s*${unit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i"), "") : text;
    return plainNumber(t);
  },
  format(value, ctx, compact) {
    const n = new Intl.NumberFormat("en-GB", {
      maximumFractionDigits: 2,
      notation: compact && Math.abs(value) >= 10_000 ? "compact" : "standard",
    }).format(value);
    return ctx.config.unit ? `${n} ${ctx.config.unit}` : n;
  },
  rollup: "sum",
  groupKey: (c) => `number:${c.id}`,
};

const percent: Measure = {
  label: "Percentage",
  hint: "0–100% per task, e.g. how far along. Parents and the board show the average.",
  placeholder: () => "0%",
  parse(text) {
    const n = plainNumber(text.replace(/%\s*$/, ""));
    return n === null || n < 0 || n > 100 ? null : Math.round(n * 100) / 100;
  },
  format: (value) => `${Math.round(value)}%`,
  rollup: "average",
  groupKey: (c) => `percent:${c.id}`,
};

/** Types that are figures (add up, average); a location isn't one. */
export type FigureType = Exclude<ValueType, "location">;

export const MEASURES: Record<FigureType, Measure> = { money, duration, number, percent };

/** Everything a category can carry, for the settings screen. */
export const VALUE_TYPES: ValueType[] = ["money", "duration", "number", "percent", "location"];

export const TYPE_INFO: Record<ValueType, { label: string; hint: string }> = {
  money: MEASURES.money,
  duration: MEASURES.duration,
  number: MEASURES.number,
  percent: MEASURES.percent,
  location: {
    label: "Location",
    hint: "A place per task (search an address, paste a maps link, or use where you are). The board gets a Map view.",
  },
};

export function measureOf(category: Category | undefined): Measure | null {
  const type = category?.value_type;
  return type && type !== "location" ? MEASURES[type] : null;
}

export function contextOf(category: Category, hoursPerDay: number): MeasureContext {
  return { config: category.value_config ?? {}, hoursPerDay };
}

/** Show a category's figure. */
export function formatValue(category: Category, value: number, hoursPerDay: number, compact = false): string {
  const m = measureOf(category);
  return m ? m.format(value, contextOf(category, hoursPerDay), compact) : String(value);
}
