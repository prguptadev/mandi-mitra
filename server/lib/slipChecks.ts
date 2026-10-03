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

/** Loose packets: every packet but the last weighs this much. */
export const LOOSE_PACKET_KG = 50;
/** Past these, "N+K" is not read as loose packets (a slip number, or a misread). */
export const LOOSE_MAX_PACKETS = 50;
export const LOOSE_MAX_LAST_KG = 100;

export interface LooseRst {
  /** How many packets came. */
  packets: number;
  /** What the last packet weighs, in kg. */
  lastKg: number;
  /** 50 kg for each packet but the last, plus the last: 2+45 is 95 kg. */
  netGrams: number;
  /** How it is kept and shown: "2+45", "1-64". */
  text: string;
}

/**
 * Loose packets that came without a weighbridge slip are written in the RST
 * box as "N+K" or "N-K": N packets, the last of them K kg, every other one
 * 50 kg. "2+45" is 95 kg, "1-64" is 64 kg, "3+40" 140 kg. Spaces, Hindi
 * digits and a trailing "kg" are allowed ("२ + ४५ kg"), and so is any dash
 * a keyboard or a phone puts in (the minus sign "1−64", "1–64", "1－64").
 * Anything else — an ordinary slip number, N outside 1–50, K outside
 * 1–100 — is null.
 */
export function looseRst(v: string | null | undefined): LooseRst | null {
  const s = String(v ?? "")
    .replace(/[०-९]/g, (d) => String(HINDI_DIGITS.indexOf(d)))
    .replace(/\s+/g, "")
    .replace(/(kgs?|किलो|कि\.?ग्रा)\.?$/i, "")
    // hyphens and dashes (U+2010–2015), the minus sign, their small and full-width forms; a full-width plus
    .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, "-")
    .replace(/[\uFE62\uFF0B]/g, "+");
  const m = s.match(/^(\d{1,2})([+-])(\d{1,3})$/);
  if (!m) return null;
  const packets = Number(m[1]), lastKg = Number(m[3]);
  if (packets < 1 || packets > LOOSE_MAX_PACKETS || lastKg < 1 || lastKg > LOOSE_MAX_LAST_KG) return null;
  return {
    packets, lastKg,
    netGrams: (LOOSE_PACKET_KG * (packets - 1) + lastKg) * 1000,
    text: `${packets}${m[2]}${lastKg}`,
  };
}

/**
 * The weight of a line once its RST box changes from `was` to `now`, in
 * grams — one rule for the daily list and the sheet screen. A weight that
 * is the old loose packets' own (2+45: 95 kg) came from the RST box and
 * follows it: to the new packets' weight (2+40: 90 kg) or, once the RST is
 * no longer loose packets, back to the dharam kanta read for the line
 * (`kanta`; null when none was read, and the weight is to be typed). An
 * empty weight takes the packets' weight. Any other weight was typed, and
 * stays.
 */
export function rstWeight(was: string | null | undefined, now: string | null | undefined, grams: number | null, kanta: number | null = null): number | null {
  const before = looseRst(was), after = looseRst(now);
  const fromRst = before !== null && grams === before.netGrams;
  if (after) return grams === null || fromRst ? after.netGrams : grams;
  return fromRst ? kanta : grams;
}

/**
 * Loose packets carry no katauti — while the weight is theirs, or is still
 * to come from the RST box. A weight that is not ("12-43" with 11.90 typed:
 * RST 1243 with a stray dash) is some other slip: the mill's katauti
 * stands, and the difference is flagged.
 */
export function looseNoKatauti(rstNo: string | null | undefined, grams: number | null | undefined): boolean {
  const loose = looseRst(rstNo);
  return loose !== null && (grams == null || grams === loose.netGrams);
}

/**
 * A written figure in hundredths, rounded half up on its digits as written:
 * 19.205 → 1921, never 1920 from 19.205 × 100 = 1920.4999… in binary.
 */
export function hundredths(v: number): number {
  const n = Math.round(Number(`${v}e2`));
  return Number.isFinite(n) ? n : Math.round(v * 100);
}

/** The dharam kanta read for a line (quintal, as written) in grams, to the kilo, as a read line keeps it. */
export const kantaGrams = (q: number | null | undefined) => q == null ? null : hundredths(q) * (GRAMS_PER_QTL / 100);

/**
 * What a number box keeps of what was typed or pasted: digits (Hindi digits
 * become English ones) and one decimal point. Letters, "/-", "₹", commas and
 * spaces never reach the box, so a rate is always a number.
 */
export function numberOnly(v: string, opts: { decimal?: boolean } = {}): string {
  const decimal = opts.decimal !== false;
  let s = String(v ?? "").replace(/[०-९]/g, (d) => String(HINDI_DIGITS.indexOf(d)));
  // a word's own dot ("Rs.", "Qtl.", "रु.") goes with it: it is never a decimal point
  s = s.replace(/[\p{L}\p{M}]+\.?/gu, "");
  s = s.replace(decimal ? /[^0-9.]/g : /[^0-9]/g, "");
  const dot = s.indexOf(".");
  if (dot >= 0) s = s.slice(0, dot + 1) + s.slice(dot + 1).replace(/\./g, "");
  return s;
}

/** The same rule the scan check uses: past these, a lost or extra decimal point is likely. */
export const GROSS_LARGE_GRAMS = 100 * GRAMS_PER_QTL;
export const GROSS_SMALL_GRAMS = GRAMS_PER_QTL;

export type GrossOdd = "large" | "small" | null;
/** A loose-packet slip (rstNo "2+45") is small by nature: never "small". */
export function grossOdd(grossGrams: number | null | undefined, rstNo?: string | null): GrossOdd {
  if (grossGrams == null || grossGrams <= 0) return null;
  if (looseRst(rstNo)) return null;
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
