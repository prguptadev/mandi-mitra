/* The daily list: the links that open it from other screens, what it asks the
   server for, and the commodity its dara starts on. Worked out here rather
   than inside the pages, so the checks (scripts/e2e-math-fixes.ts) follow
   exactly the link a screen draws and ask exactly what the list asks. */

import { looseNoKatauti, rstWeight } from "@server/lib/slipChecks.ts";
import type { KatautiConfig } from "@/lib/api.ts";

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The RST box keeps what was typed, with Hindi digits as English ones and no spaces. */
export const rstTyped = (s: string) => s.replace(/[०-९]/g, (d) => String("०१२३४५६७८९".indexOf(d))).replace(/\s+/g, "");

/**
 * The RST box as typed — on a new row and on a saved one being edited.
 * Loose packets ("2+45": 2 packets, the last 45 kg, the others 50 kg) fill
 * an empty weight box with their weight; a weight that is the packets' own
 * follows the RST while it is typed (2+45 → 2+40: 0.95 → 0.90), and goes
 * when the RST stops being loose packets (2+45 → 1245: to be typed). A
 * weight typed by hand is never changed, and neither is the katauti box:
 * the packets' 0 is the rule (suggestedKatauti), never typed in for them.
 * The same rule as the sheet screen (rstWeight).
 */
export function withRst<D extends { rstNo: string; gross: string }>(p: D, typed: string): D {
  const rstNo = rstTyped(typed);
  const n = p.gross.trim() === "" ? null : Number(p.gross);
  // something in the box that is not a number yet (".") is the operator's
  if (n !== null && !Number.isFinite(n)) return { ...p, rstNo };
  const grams = n === null ? null : Math.round(n * 100_000);
  const next = rstWeight(p.rstNo, rstNo, grams);
  return next === grams ? { ...p, rstNo } : { ...p, rstNo, gross: next === null ? "" : (next / 100_000).toFixed(2) };
}

const halfUp = (n: number) => Math.sign(n) * Math.round(Math.abs(n));

/**
 * The katauti the box suggests for a weight (grams), when none is typed:
 * none for loose packets at their own weight (2+45 at 0.95), else the
 * mill's rule — "12-43" with 11.90 typed is RST 1243 with a stray dash, not
 * 593 kg of packets, and keeps the mill's 12. The server does the same.
 */
export function suggestedKatauti(rstNo: string, grossGrams: number | null, cfg: KatautiConfig): number | null {
  if (grossGrams === null) return null;
  if (looseNoKatauti(rstNo, grossGrams)) return 0;
  return cfg.mode === "none" ? null
    : cfg.mode === "per_quintal_rounded" ? halfUp(grossGrams / 100_000)
    : cfg.mode === "per_quintal_exact" ? grossGrams / 100_000
    : 0;
}

/**
 * The katauti box of a saved slip opened for editing: the katauti typed on
 * it, or empty (the rule, shown faint). The 0 of loose packets at their own
 * weight is their rule, not a figure typed, so it follows the RST and the
 * weight like a new row's does.
 */
export function katautiBox(r: { rstNo: string; grossGrams: number; katautiUnits: number; katautiOverride: boolean }): string {
  return r.katautiOverride && !(r.katautiUnits === 0 && looseNoKatauti(r.rstNo, r.grossGrams)) ? String(r.katautiUnits) : "";
}

const link = (date: string, mill: string, jins: string) =>
  `/daily?${new URLSearchParams({ date, ...(mill ? { mill } : {}), ...(jins ? { jins } : {}) })}`;

/**
 * A line of the dashboard's day's-rate card: one mill, one commodity, one day.
 * The list it opens is that mill's slips of that commodity, so its net,
 * average and amount are the line's.
 */
export const dayRateLink = (date: string, line: { millId: string | null; jinsId: string }) => link(date, line.millId ?? "", line.jinsId);

/**
 * A day row on a mill's stock page, with the commodity picked there ("" = all):
 * the list it opens is that mill's slips of that day and commodity, the row's
 * own. Slips with no mill (id "none") cannot be picked on the list, so that
 * row opens the whole day for the commodity.
 */
export const stockDayLink = (date: string, millId: string, jinsId: string) => link(date, millId === "none" ? "" : millId, jinsId);

/** What the daily list opens on, from its address: the day, the mill and the commodity ("" = all). */
export function dailyListFrom(search: string) {
  const p = new URLSearchParams(search);
  const d = p.get("date");
  return { date: d && ISO_DAY.test(d) ? d : null, mill: p.get("mill") ?? "", jins: p.get("jins") ?? "" };
}

/** The slips the daily list shows for a day, a mill ("" = all) and a commodity ("" = all). */
export const dailyListQuery = (date: string, merchantId: string, jinsId: string) =>
  `/slips?${new URLSearchParams({ date, ...(merchantId ? { merchantId } : {}), ...(jinsId ? { jinsId } : {}) })}`;

/** What the dara dialog asks: the commodities a mill bought in the period. */
export const daraJinsQuery = (merchantId: string, from: string, to: string) =>
  `/reports/mill?${new URLSearchParams({ merchantId, from, to, format: "jins" })}`;

/**
 * The commodity a dara starts on when the list shows every commodity: a dara
 * is one commodity's rate, never a blend of paddy and wheat. 1509 when the
 * mill bought it in the period, else the first commodity it did buy; with
 * nothing bought (or not known yet), 1509 as before.
 */
export function daraStartJins(jinsList: { id: string; code: string }[], bought?: string[] | null) {
  const usual = jinsList.find((j) => j.code === "1509") ?? jinsList[0];
  const has = new Set(bought ?? []);
  if (!has.size || (usual && has.has(usual.id))) return usual?.id ?? "";
  return jinsList.find((j) => has.has(j.id))?.id ?? usual?.id ?? "";
}
