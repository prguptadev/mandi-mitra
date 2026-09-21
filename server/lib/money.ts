/** Weight is grams, money is paise, everything integer. 1 qtl = 100_000 g. */
export const GRAMS_PER_QTL = 100_000;

export const qtlToGrams = (q: number) => Math.round(q * GRAMS_PER_QTL);
export const gramsToQtl = (g: number) => g / GRAMS_PER_QTL;
export const rupeesToPaise = (r: number) => Math.round(r * 100);
export const paiseToRupees = (p: number) => p / 100;

/** Banker-free half-up rounding — matches what a munshi does with a calculator. */
export const roundHalfUp = (n: number) => Math.sign(n) * Math.round(Math.abs(n));

/** a / b rounded half up (away from zero), exactly, in BigInt. */
export function divHalfUp(a: bigint, b: bigint): bigint {
  if (b === 0n) return 0n;
  const neg = (a < 0n) !== (b < 0n);
  const x = a < 0n ? -a : a;
  const y = b < 0n ? -b : b;
  const q = (2n * x + y) / (2n * y);
  return neg ? -q : q;
}

/** amount(paise) = weight(g) / 100_000 × rate(paise per qtl), exact at any size. */
export function amountPaise(grams: number, ratePaisePerQtl: number): number {
  return Number(divHalfUp(BigInt(grams) * BigInt(ratePaisePerQtl), BigInt(GRAMS_PER_QTL)));
}

/** pct % of an amount, exact: 0.7% of ₹55.00 is 39 paise (half up), not 38. */
export function pctPaise(basePaise: number, pct: number): number {
  const bp = BigInt(Math.round(pct * 10_000)); // pct in millionths of the whole
  return Number(divHalfUp(BigInt(basePaise) * bp, 1_000_000n));
}

/**
 * ₹ per unit × units, in paise, without float drift (₹1.25 × 200.42 qtl = ₹250.53).
 * The rate is kept to 1/100 paise, so ₹0.125 a quintal is not first rounded to 13 paise.
 */
export function perUnitPaise(unitsScaled: number, scale: number, rupeesPerUnit: number): number {
  return Number(divHalfUp(BigInt(unitsScaled) * BigInt(Math.round(rupeesPerUnit * 10_000)), BigInt(scale) * 100n));
}

/** Σ(net × rate) / Σ net, half up. Summed in BigInt: a season's worth overflows 2^53. */
export function weightedAvgRate(rows: { netGrams: number; ratePaisePerQtl: number }[]): number {
  let net = 0n, value = 0n;
  for (const r of rows) { net += BigInt(r.netGrams); value += BigInt(r.netGrams) * BigInt(r.ratePaisePerQtl); }
  return net === 0n ? 0 : Number(divHalfUp(value, net));
}

/** The same average from SQL sums, where Σ(net × rate) comes back as text to keep every digit. */
export function avgFromSums(valueText: string | number | null | undefined, net: number | null | undefined): number {
  if (!net || valueText == null) return 0;
  return Number(divHalfUp(BigInt(String(valueText).split(".")[0]), BigInt(net)));
}

/** "310.74": to the kg, half up, in integers — the same figure the screen and the parcha show. */
export function fmtQtl(grams: number): string {
  const kg = Math.round(Math.abs(grams) / 1000);
  return `${grams < 0 ? "-" : ""}${Math.floor(kg / 100)}.${String(kg % 100).padStart(2, "0")}`;
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
