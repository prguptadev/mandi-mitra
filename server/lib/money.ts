/** Weight is grams, money is paise, everything integer. 1 qtl = 100_000 g. */
export const GRAMS_PER_QTL = 100_000;

export const qtlToGrams = (q: number) => Math.round(q * GRAMS_PER_QTL);
export const gramsToQtl = (g: number) => g / GRAMS_PER_QTL;
export const rupeesToPaise = (r: number) => Math.round(r * 100);
export const paiseToRupees = (p: number) => p / 100;

/** Banker-free half-up rounding — matches what a munshi does with a calculator. */
export const roundHalfUp = (n: number) => Math.sign(n) * Math.round(Math.abs(n));

/** amount(paise) = weight(g) / 100_000 * rate(paise per qtl) */
export function amountPaise(grams: number, ratePaisePerQtl: number): number {
  return roundHalfUp((grams * ratePaisePerQtl) / GRAMS_PER_QTL);
}

export function pctPaise(basePaise: number, pct: number): number {
  return roundHalfUp((basePaise * pct) / 100);
}

/** Weighted average rate over slips: sum(net*rate) / sum(net). */
export function weightedAvgRate(rows: { netGrams: number; ratePaisePerQtl: number }[]): number {
  const totalNet = rows.reduce((s, r) => s + r.netGrams, 0);
  if (totalNet === 0) return 0;
  const totalValue = rows.reduce((s, r) => s + r.netGrams * r.ratePaisePerQtl, 0);
  return roundHalfUp(totalValue / totalNet);
}

export function fmtQtl(grams: number): string {
  return (grams / GRAMS_PER_QTL).toFixed(2);
}

export function fmtINR(paise: number, opts: { paise?: boolean } = {}): string {
  const showPaise = opts.paise !== false;
  const v = Math.abs(paise) / 100;
  const s = v.toLocaleString("en-IN", {
    minimumFractionDigits: showPaise ? 2 : 0,
    maximumFractionDigits: showPaise ? 2 : 0,
  });
  return (paise < 0 ? "-" : "") + s;
}
