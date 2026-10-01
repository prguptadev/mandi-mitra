import { GRAMS_PER_QTL } from "./money.ts";

/* The plain checks a slip gets wherever it is typed or read: the screen
   while typing, the server when it is saved. Each one is a flag for a person
   to look at; none of them stops a save. Pure functions, shared with the
   browser so both sides say the same thing. */

const HINDI_DIGITS = "०१२३४५६७८९";

/**
 * "६३०", " 0630", "6 30", "630" all name the same weighbridge slip. Used to
 * compare RST numbers, never to change what is stored or shown.
 */
export function rstKey(v: string | null | undefined): string {
  const s = String(v ?? "")
    .replace(/[०-९]/g, (d) => String(HINDI_DIGITS.indexOf(d)))
    .replace(/\s+/g, "")
    .toUpperCase();
  // leading zeros are how some kantas print; "000" is still a number
  return s.replace(/^0+(?=\d)/, "");
}

/**
 * What a number box keeps of what was typed or pasted: digits (Hindi digits
 * become English ones) and one decimal point. Letters, "/-", "₹", commas and
 * spaces never reach the box, so a rate is always a number.
 */
export function numberOnly(v: string, opts: { decimal?: boolean } = {}): string {
  const decimal = opts.decimal !== false;
  let s = String(v ?? "").replace(/[०-९]/g, (d) => String(HINDI_DIGITS.indexOf(d)));
  s = s.replace(decimal ? /[^0-9.]/g : /[^0-9]/g, "");
  const dot = s.indexOf(".");
  if (dot >= 0) s = s.slice(0, dot + 1) + s.slice(dot + 1).replace(/\./g, "");
  return s;
}

/** The same rule the scan check uses: past these, a lost or extra decimal point is likely. */
export const GROSS_LARGE_GRAMS = 100 * GRAMS_PER_QTL;
export const GROSS_SMALL_GRAMS = GRAMS_PER_QTL;

export type GrossOdd = "large" | "small" | null;
export function grossOdd(grossGrams: number | null | undefined): GrossOdd {
  if (grossGrams == null || grossGrams <= 0) return null;
  if (grossGrams > GROSS_LARGE_GRAMS) return "large";
  if (grossGrams < GROSS_SMALL_GRAMS) return "small";
  return null;
}

export interface RateRange { floorPaise: number; ceilPaise: number; medianPaise: number | null }

/** Too few priced slips that day to judge from: a wide range that still catches 345 or 34,500 for 3,450. */
export const DEFAULT_RATE_RANGE: RateRange = { floorPaise: 100_000, ceilPaise: 1_000_000, medianPaise: null };

/**
 * The day's usual rate for one commodity: 70%–140% of the median of that
 * day's priced slips (every mill), as the scan check does. A missing or
 * extra decimal point lands far outside it; an ordinary day's spread does not.
 */
export function usualRate(ratesPaise: number[]): RateRange {
  const priced = ratesPaise.filter((r) => r > 0).sort((a, b) => a - b);
  if (priced.length < 5) return DEFAULT_RATE_RANGE;
  const median = priced[Math.floor(priced.length / 2)];
  return { floorPaise: Math.round(median * 0.7), ceilPaise: Math.round(median * 1.4), medianPaise: median };
}

export function rateOdd(ratePaise: number | null | undefined, range: RateRange): boolean {
  return ratePaise != null && ratePaise > 0 && (ratePaise < range.floorPaise || ratePaise > range.ceilPaise);
}

/** Whole days between two ISO dates, whatever the computer's time zone. */
export function dayGap(a: string, b: string): number {
  const t = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
  return Math.round((t(b) - t(a)) / 86_400_000);
}

/** How far either side of a slip's date the same RST and weight are looked for. */
export const RST_WINDOW_DAYS = 30;
