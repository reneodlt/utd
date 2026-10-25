/** Quick add figures: "Buy timber £45" or "Paint fence ~3h" carry a cost
 * or a time estimate. Each lands in the highest-priority category of that
 * kind (right currency, for money) the board can use; the task joins that
 * category. Only taken out of the title when such a category exists. */

import { useBoardStore } from "../store/boardStore";
import type { Category } from "../types";
import { CURRENCIES, MEASURES, parseDuration } from "./measures";

export interface DraftFigure {
  type: "money" | "duration";
  /** As typed, for the preview and for putting back. */
  token: string;
  /** Money: the amount; durations are read at create time (hours per day). */
  amount?: number;
  currency?: string;
  text?: string;
}

const MONEY = /(^|\s)([£€$])\s?(\d[\d,]*(?:\.\d{1,2})?\s?[km]?)(?=$|[\s,.;!?])/i;
const TIME = /(^|\s)~\s?(\d[\d.:]*\s?[dhm]?(?:\s?\d[\d.]*\s?[dhm])*)(?=$|[\s,.;!?])/i;

function usable(type: "money" | "duration", currency?: string, boardId?: string): Category[] {
  const { categoriesById, board } = useBoardStore.getState();
  const on = boardId ?? board?.id;
  return Object.values(categoriesById)
    .filter(
      (c) =>
        !c.archived &&
        c.value_type === type &&
        (type !== "money" || (c.value_config?.currency ?? "GBP") === currency) &&
        (boardId === undefined || c.board_id === null || c.board_id === on),
    )
    .sort((a, b) => a.position - b.position);
}

/** Take figures out of a line: what's left, and what was found. */
export function extractFigures(line: string): { rest: string; figures: DraftFigure[] } {
  const figures: DraftFigure[] = [];
  let rest = line;
  const money = MONEY.exec(rest);
  if (money) {
    const currency = CURRENCIES.find((c) => c.symbol === money[2])?.code ?? "GBP";
    const amount = MEASURES.money.parse(money[3], { config: {}, hoursPerDay: 7.5 });
    if (amount !== null && usable("money", currency).length) {
      figures.push({ type: "money", token: `${money[2]}${money[3]}`, amount, currency });
      rest = rest.replace(money[0], money[1]);
    }
  }
  const time = TIME.exec(rest);
  if (time && parseDuration(time[2], 7.5) !== null && usable("duration").length) {
    figures.push({ type: "duration", token: `~${time[2].trim()}`, text: time[2] });
    rest = rest.replace(time[0], time[1]);
  }
  return { rest: rest.replace(/\s+/g, " ").trim(), figures };
}

/** The create-task fields for a draft's figures on a board; figures with no
 * category there go back into the title. */
export function figureFields(
  title: string,
  figures: DraftFigure[] | undefined,
  boardId: string,
): { title: string; category_ids?: string[]; values?: Record<string, number> } {
  if (!figures?.length) return { title };
  const hoursPerDay = useBoardStore.getState().board?.hours_per_day ?? 7.5;
  const values: Record<string, number> = {};
  const leftOver: string[] = [];
  for (const f of figures) {
    const category = usable(f.type, f.currency, boardId)[0];
    const amount = f.type === "money" ? f.amount : parseDuration(f.text ?? "", hoursPerDay);
    if (category && amount !== null && amount !== undefined && !(category.id in values)) values[category.id] = amount;
    else leftOver.push(f.token);
  }
  const ids = Object.keys(values);
  return {
    title: [title, ...leftOver].join(" ").trim(),
    ...(ids.length ? { category_ids: ids, values } : {}),
  };
}
