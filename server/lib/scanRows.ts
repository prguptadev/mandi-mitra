import { z } from "zod";
import { deriveKatauti, type Katauti } from "./charges.ts";
import { amountPaise, GRAMS_PER_QTL } from "./money.ts";
import type { OcrRow } from "./gemini.ts";
import type { AdatiSuggestion, AdatiMatch } from "./adatiResolve.ts";

/* A reviewed row. Whatever Gemini read is kept alongside what we derived, so
 * the review screen can show both and the operator can see exactly what
 * changed. Nothing is committed until every blocking issue is cleared. */

export const ReviewRowSchema = z.object({
  id: z.string(),
  /** 1-based page of the scan this row was read from. */
  page: z.number().int().min(1).default(1),
  /** Untouched copy of what the model read. */
  ocr: z.object({
    rstNo: z.string().nullable(),
    village: z.string().nullable().default(null),
    adatiName: z.string().nullable(),
    grossQtl: z.number().nullable(),
    katauti: z.number().nullable(),
    netQtl: z.number().nullable(),
    rate: z.number().nullable(),
    confidence: z.number().nullable(),
    struckThrough: z.boolean().nullable(),
    /** The printed SR NO the reader put this row on — the anchor for row alignment. */
    srNo: z.number().nullable().optional(),
    /** Where the reader put this line on its page, 0 (top) to 1000 (bottom), when it said. */
    lineY: z.number().nullable().optional(),
    /** Number cells the reader returned that are not a number, as written ("34S0", "19-20"). */
    unreadable: z.record(z.string()).nullable().optional(),
  }),
  /** What will actually be written, after any human edit. */
  rstNo: z.string(),
  adatiId: z.string().nullable(),
  adatiRawText: z.string(),
  /** A village or place the reader saw beside the name, if any. */
  adatiRawVillage: z.string().nullable().default(null),
  grossGrams: z.number().int().nullable(),
  katautiOverride: z.number().int().nullable(),
  ratePaisePerQtl: z.number().int().nullable(),
  /** Rows the operator dropped (struck through on paper, duplicates, blanks). */
  excluded: z.boolean().default(false),
  /** Set once the operator picks a name for an unresolved reading. */
  nameCorrected: z.boolean().default(false),
  /** A name typed over the reading: saved as a supplier the moment it is sent. */
  typedName: z.string().trim().max(120).nullish(),
  /** The model's pick from the known-supplier list, exactly as it wrote it. */
  modelPick: z.string().nullable().default(null),
  /** Fields the operator has looked at and accepted or changed — no longer doubtful. */
  confirmed: z.array(z.string()).default([]),
});

export type ReviewRow = z.infer<typeof ReviewRowSchema>;

export type IssueLevel = "error" | "warn";
export interface Issue { code: string; level: IssueLevel; message: string; params?: Record<string, string | number> }

export interface CheckedRow extends ReviewRow {
  match: AdatiMatch | null;
  /** The supplier picked by hand, named — so the screen can show it. */
  chosen: { adatiId: string; nameHi: string; nameHinglish: string } | null;
  suggestions: AdatiSuggestion[];
  derivedKatautiUnits: number | null;
  derivedNetGrams: number | null;
  derivedAmountPaise: number | null;
  /** Gemini's net vs ours. Agreement is strong evidence the digits are right. */
  netAgrees: boolean | null;
  /** A gross with the decimal point moved that makes the sheet's own net agree (1920 → 19.20). */
  grossSuggestGrams: number | null;
  netDiffGrams: number | null;
  issues: Issue[];
  blocking: boolean;
}

export function qtlToGrams(q: number) { return Math.round(q * GRAMS_PER_QTL); }

/** "६२६" or "6 26" → "626": RST numbers compare as the weighbridge prints them. */
export const normRst = (v: string | null | undefined) =>
  String(v ?? "").replace(/[०-९]/g, (d) => String("०१२३४५६७८९".indexOf(d))).replace(/\s+/g, "");

/**
 * A written figure in hundredths, rounded half up on its digits as written:
 * 19.205 → 1921, never 1920 from 19.205 × 100 = 1920.4999… in binary.
 */
export function hundredths(v: number): number {
  const n = Math.round(Number(`${v}e2`));
  return Number.isFinite(n) ? n : Math.round(v * 100);
}
/** A reading finer than the 0.01 the paper and the grid work in (19.205). */
export const finerThanHundredths = (v: number) => Math.abs(Number(`${v}e2`) - hundredths(v)) > 1e-6;

export function ocrToReviewRow(r: OcrRow, i: number): ReviewRow {
  const gross = r.grossQtl ?? null;
  const unreadable = r.unreadable && Object.keys(r.unreadable).length ? r.unreadable : null;
  return {
    id: `r${i}`,
    page: r.page ?? 1,
    ocr: {
      rstNo: r.rstNo ?? null,
      adatiName: r.adatiName ?? null,
      village: r.village ?? null,
      grossQtl: gross,
      katauti: r.katauti ?? null,
      netQtl: r.netQtl ?? null,
      rate: r.rate ?? null,
      confidence: r.confidence ?? null,
      struckThrough: r.struckThrough ?? null,
      srNo: r.srNo ?? null,
      lineY: r.lineY ?? null,
      ...(unreadable ? { unreadable } : {}),
    },
    rstNo: normRst(r.rstNo),
    adatiId: null,
    adatiRawText: (r.adatiName ?? "").trim(),
    adatiRawVillage: (r.village ?? "").trim() || null,
    /* Whole kilograms, as the grid shows them and as a slip typed by hand
       is kept: a third decimal from the reader is never priced unseen. */
    grossGrams: gross === null ? null : hundredths(gross) * (GRAMS_PER_QTL / 100),
    katautiOverride: null,
    ratePaisePerQtl: r.rate == null ? null : hundredths(r.rate),
    excluded: r.struckThrough === true,
    nameCorrected: false,
    modelPick: r.supplierMatch?.trim() || null,
    confirmed: [],
  };
}

/**
 * A lost or misplaced decimal point is the commonest misread of a weight:
 * "2860" for 28.60. If moving the point makes the sheet's own net agree
 * with our arithmetic, that is almost certainly the real weight.
 */
export function decimalFix(row: ReviewRow, katauti: Katauti): number | null {
  if (row.grossGrams == null || row.ocr.netQtl == null) return null;
  const want = qtlToGrams(row.ocr.netQtl);
  for (const f of [0.01, 0.1, 10, 100]) {
    const g = Math.round(row.grossGrams * f);
    if (g < GRAMS_PER_QTL / 2 || g > 100 * GRAMS_PER_QTL) continue;
    const k = deriveKatauti(g, katauti, null);
    if (Math.abs(g - k.deductionGrams - want) <= 500) return g;
  }
  return null;
}

/** The operator accepted this field as read (one click), or edited it. */
const confirmedField = (row: { confirmed?: string[] }, f: string) => (row.confirmed ?? []).includes(f);

export function checkRow(
  row: ReviewRow,
  opts: {
    katauti: Katauti;
    resolve: (raw: string, modelPick?: string | null, village?: string | null) => { match: AdatiMatch | null; suggestions: AdatiSuggestion[] };
    byId: (id: string) => { adatiId: string; nameHi: string; nameHinglish: string } | null;
    /** RST numbers already in the database for this date. */
    existingRst: Set<string>;
    /** RST numbers appearing more than once inside this batch. */
    dupeInBatch: Set<string>;
    rateFloorPaise: number;
    rateCeilPaise: number;
    /** False when the reader found no net weight anywhere on this row's page (a sheet without a net column). */
    pageHasNet?: boolean;
    /** False when no line on this row's page has a rate: the page is asked about once, as a whole. */
    pageHasRate?: boolean;
  },
): CheckedRow {
  const issues: Issue[] = [];
  const resolved = row.adatiId
    ? { match: null as AdatiMatch | null, suggestions: [] as AdatiSuggestion[] }
    : opts.resolve(row.adatiRawText, row.modelPick, row.adatiRawVillage);
  const chosen = row.adatiId ? opts.byId(row.adatiId) : null;

  let derivedKatautiUnits: number | null = null;
  let derivedNetGrams: number | null = null;
  let derivedAmountPaise: number | null = null;
  let netAgrees: boolean | null = null;
  let netDiffGrams: number | null = null;

  if (row.grossGrams !== null) {
    const k = deriveKatauti(row.grossGrams, opts.katauti, row.katautiOverride);
    derivedKatautiUnits = k.units;
    derivedNetGrams = row.grossGrams - k.deductionGrams;
    if (row.ratePaisePerQtl !== null) {
      derivedAmountPaise = amountPaise(derivedNetGrams, row.ratePaisePerQtl);
    }
    // the cross-check that makes OCR trustworthy
    if (row.ocr.netQtl != null) {
      const ocrNet = qtlToGrams(row.ocr.netQtl);
      netDiffGrams = ocrNet - derivedNetGrams;
      netAgrees = Math.abs(netDiffGrams) <= 500; // half a kilo
      /* The net column is only a cross-check. Written without its decimal
         point ("4,000" for 40.00) it still confirms every digit of the gross,
         so it counts as agreeing rather than blocking the row. */
      if (!netAgrees && [0.01, 0.1].some((f) => Math.abs(Math.round(ocrNet * f) - derivedNetGrams!) <= 500)) {
        netAgrees = true;
        netDiffGrams = 0;
      }
    }
  }

  const grossSuggestGrams = netAgrees === false || (row.grossGrams ?? 0) > 100 * GRAMS_PER_QTL ? decimalFix(row, opts.katauti) : null;

  if (row.excluded) {
    return {
      ...row, match: resolved.match, chosen, suggestions: resolved.suggestions,
      derivedKatautiUnits, derivedNetGrams, derivedAmountPaise, netAgrees, netDiffGrams, grossSuggestGrams,
      issues: [], blocking: false,
    };
  }

  // a line the paper strikes out, put back in by hand: the operator must mean it
  if (row.ocr.struckThrough === true && !confirmedField(row, "struck")) {
    issues.push({ code: "struck_included", level: "error", message: "This line is struck out on the sheet — confirm it really belongs" });
  }

  /* A slip typed by hand cannot be saved without its RST, so neither can a
     scanned one, unless the operator says the paper really has none. */
  if (!row.rstNo) issues.push({ code: "rst_missing", level: confirmedField(row, "rst") ? "warn" : "error", message: "RST number could not be read — type it, or ✓ if the paper has none" });
  // shown red on the screen, and counted in the "are you sure" box before saving; never blocks
  else if (opts.existingRst.has(row.rstNo)) issues.push({ code: "rst_exists", level: "warn", message: `RST ${row.rstNo} is already entered for this date`, params: { rst: row.rstNo } });
  else if (opts.dupeInBatch.has(row.rstNo)) issues.push({ code: "rst_dupe", level: "warn", message: `RST ${row.rstNo} appears twice on this sheet`, params: { rst: row.rstNo } });

  if (row.adatiId && !chosen) {
    issues.push({ code: "name_unresolved", level: "error", message: "The chosen supplier no longer exists", params: { name: row.adatiRawText } });
  } else if (!row.adatiId && !resolved.match) {
    // a name nobody matches is not a stop: saving the sheet makes the supplier
    issues.push({
      code: row.adatiRawText ? "name_unresolved" : "name_missing", level: row.adatiRawText ? "warn" : "error",
      message: row.adatiRawText ? `No supplier matches "${row.adatiRawText}" — saving the sheet adds it as a new supplier` : "Supplier name could not be read",
      params: { name: row.adatiRawText },
    });
  } else if (resolved.match && resolved.match.via === "fuzzy") {
    issues.push({ code: "name_fuzzy", level: "warn", message: `Matched "${row.adatiRawText}" by similarity — check it`, params: { name: row.adatiRawText } });
  } else if (resolved.match && !confirmedField(row, "name")
    && (resolved.match.via === "normkey" || (resolved.match.via === "model" && resolved.match.confidence < 0.9))) {
    issues.push({ code: "name_close", level: "warn", message: `"${row.adatiRawText}" was matched to ${resolved.match.nameHi} by a close spelling — check it`, params: { name: row.adatiRawText, to: resolved.match.nameHi } });
  }

  const grossRead = row.ocr.unreadable?.grossQtl;
  if (row.grossGrams === null) {
    issues.push({
      code: "gross_missing", level: "error",
      message: grossRead ? `Gross read as "${grossRead}", which is not a number — type it` : "Gross weight could not be read",
      ...(grossRead ? { params: { read: grossRead } } : {}),
    });
  }
  else if (derivedNetGrams !== null && derivedNetGrams <= 0) issues.push({ code: "net_nonpositive", level: "error", message: "Net weight works out to zero or less" });
  else if (row.grossGrams > 100 * GRAMS_PER_QTL) {
    // likely a lost decimal point (1920 for 19.20): must be confirmed or fixed
    issues.push({
      code: "gross_large", level: confirmedField(row, "gross") ? "warn" : "error", message: "Gross weight looks very large for one slip — confirm it or fix it",
      ...(grossSuggestGrams ? { params: { suggest: (grossSuggestGrams / GRAMS_PER_QTL).toFixed(2) } } : {}),
    });
  }
  else if (row.grossGrams < GRAMS_PER_QTL) issues.push({ code: "gross_small", level: "warn", message: "Gross weight is under one quintal — check the decimal point" });

  // the reader gave a third decimal: it is rounded to the kilo, and the paper decides
  if (row.ocr.grossQtl != null && row.grossGrams !== null && finerThanHundredths(row.ocr.grossQtl)
    && row.grossGrams === hundredths(row.ocr.grossQtl) * (GRAMS_PER_QTL / 100) && !confirmedField(row, "gross")) {
    issues.push({
      code: "gross_rounded", level: "warn",
      message: `The reader saw ${row.ocr.grossQtl}; it is taken as ${(row.grossGrams / GRAMS_PER_QTL).toFixed(2)} — check the paper`,
      params: { read: String(row.ocr.grossQtl), taken: (row.grossGrams / GRAMS_PER_QTL).toFixed(2) },
    });
  }

  if (row.grossGrams !== null && row.ocr.netQtl == null && derivedNetGrams !== null && derivedNetGrams > 0) {
    // nothing on the sheet to check this weight against
    issues.push({
      code: "net_unchecked", level: confirmedField(row, "gross") || opts.pageHasNet === false ? "warn" : "error",
      message: "The sheet's net weight could not be read, so this gross could not be checked — compare it with the paper",
    });
  }
  if (netAgrees === false) {
    issues.push({
      // the sheet's own net disagrees: the surest sign of a misread digit
      code: "net_mismatch", level: confirmedField(row, "gross") ? "warn" : "error",
      message: `The sheet's net weight differs from the calculation by ${((netDiffGrams ?? 0) / GRAMS_PER_QTL).toFixed(2)} qtl`,
      params: { diff: ((netDiffGrams ?? 0) / GRAMS_PER_QTL).toFixed(2), ...(grossSuggestGrams ? { suggest: (grossSuggestGrams / GRAMS_PER_QTL).toFixed(2) } : {}) },
    });
  }
  if (row.ocr.katauti != null && derivedKatautiUnits !== null && row.katautiOverride === null
      && Math.abs(row.ocr.katauti - derivedKatautiUnits) > 0.001) {
    issues.push({
      code: "katauti_mismatch", level: "warn",
      message: `Sheet katauti is ${row.ocr.katauti}, calculated ${derivedKatautiUnits}`,
      params: { sheet: row.ocr.katauti, calculated: derivedKatautiUnits },
    });
  }

  const rateRead = row.ocr.unreadable?.rate;
  if (row.ratePaisePerQtl === null || row.ratePaisePerQtl === 0) {
    issues.push({
      code: "rate_missing",
      /* Never a silent ₹0. On a page that carries rates this line's rate is
         typed, or ✓'d as "not on the paper yet, price it later"; a page with
         no rate at all is asked about once, for the whole page. */
      level: confirmedField(row, "rate") || opts.pageHasRate === false ? "warn" : "error",
      message: rateRead ? `Rate read as "${rateRead}", which is not a number — type it` : "Rate could not be read — type it, or ✓ to fill it in later",
      ...(rateRead ? { params: { read: rateRead } } : {}),
    });
  } else if (row.ratePaisePerQtl < 0) issues.push({ code: "rate_negative", level: "error", message: "Rate cannot be negative" });
  else if (row.ratePaisePerQtl > 0 && (row.ratePaisePerQtl < opts.rateFloorPaise || row.ratePaisePerQtl > opts.rateCeilPaise)) {
    issues.push({
      code: "rate_range", level: confirmedField(row, "rate") ? "warn" : "error", message: "Rate is outside the usual range — confirm it or fix it",
      params: { floor: Math.round(opts.rateFloorPaise / 100), ceil: Math.round(opts.rateCeilPaise / 100) },
    });
  }

  if ((row.ocr.confidence ?? 1) < 0.6) {
    issues.push({ code: "low_confidence", level: "warn", message: "The reader was unsure about this row" });
  }

  return {
    ...row, match: resolved.match, chosen, suggestions: resolved.suggestions,
    derivedKatautiUnits, derivedNetGrams, derivedAmountPaise, netAgrees, netDiffGrams, grossSuggestGrams,
    issues,
    blocking: issues.some((i) => i.level === "error"),
  };
}

/** RST values that appear more than once in the batch. */
export function findDupes(rows: ReviewRow[]): Set<string> {
  const seen = new Map<string, number>();
  for (const r of rows) {
    if (r.excluded || !r.rstNo) continue;
    seen.set(r.rstNo, (seen.get(r.rstNo) ?? 0) + 1);
  }
  return new Set([...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k));
}


const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  "जनवरी": 1, "फरवरी": 2, "फ़रवरी": 2, "मार्च": 3, "अप्रैल": 4, "अप्रेल": 4, "मई": 5, "जून": 6, "जुलाई": 7, "अगस्त": 8,
  "सितंबर": 9, "सितम्बर": 9, "अक्टूबर": 10, "अक्तूबर": 10, "नवंबर": 11, "नवम्बर": 11, "दिसंबर": 12, "दिसम्बर": 12,
};

/**
 * The date written in a sheet's header, as YYYY-MM-DD; null when it does not
 * read as a real date. "21-09-2026", "21/9/26", "२१-०९-२०२६", "2026-09-21",
 * "21 Sept 2026", and "9/28/2026" (month first, when the day cannot be a
 * month). A year more than one ahead of today is a misread ("20/9/96" is
 * not 2096), so it is not a date either: the operator is asked instead.
 */
export function writtenDate(v: string | null | undefined, today = new Date()): string | null {
  const t = String(v ?? "").replace(/[०-९]/g, (d) => String("०१२३४५६७८९".indexOf(d))).trim();
  if (!t) return null;
  let y: number, mo: number, d: number;
  let m = t.match(/(?<!\d)(\d{4})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{1,2})(?!\d)/);
  if (m) {
    y = Number(m[1]); mo = Number(m[2]); d = Number(m[3]);
  } else if ((m = t.match(/(?<!\d)(\d{1,2})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{4}|\d{2})(?!\d)/))) {
    d = Number(m[1]); mo = Number(m[2]); y = Number(m[3]);
    if (mo > 12 && d <= 12) [d, mo] = [mo, d];
  } else if ((m = t.match(/(?<!\d)(\d{1,2})\s*[-/. ]?\s*([A-Za-z]+|[ऀ-ॿ]+)\.?\s*[-/., ]?\s*(\d{4}|\d{2})(?!\d)/))) {
    const name = m[2].toLowerCase();
    mo = MONTHS[/^[a-z]/.test(name) ? name.slice(0, 3) : name] ?? 0;
    if (!mo) return null;
    d = Number(m[1]); y = Number(m[3]);
  } else return null;
  if (y < 100) y += 2000;
  const at = new Date(Date.UTC(y, mo - 1, d));
  if (at.getUTCFullYear() !== y || at.getUTCMonth() !== mo - 1 || at.getUTCDate() !== d) return null;
  if (y < 2000 || at.getTime() > today.getTime() + 366 * 86400_000) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export interface PageMeta {
  page: number; date: string | null; millName: string | null; jins: string | null; total: number | null;
  /** Google's reply for this page was cut short: lines after the last one kept may be missing. */
  truncated?: boolean;
  /** What the operator checked against the paper for this page: "rows", "date", "total", "count", … */
  confirmed?: string[];
  /** What each tick was given for. A tick holds only while that is unchanged:
   *  a date checked for 28-09 is asked again when the scan moves to 29-09. */
  confirmedFor?: Record<string, string>;
}
export type PageCheckCode =
  | "page_total" | "page_date" | "page_rows" | "page_cut" | "page_count" | "page_struck"
  | "page_mill" | "page_jins" | "page_norate";
export type PageCheck = {
  page: number; code: PageCheckCode; params: Record<string, string | number>; confirmed: boolean;
  /** The value a tick is tied to (see PageMeta.confirmedFor). */
  stamp: string;
};
/** A mill or commodity the sheet's header names: a known one, other than what the scan is filed under. */
export interface HeaderDiffers { page: number; written: string; id: string | null; label: string; filedId: string | null; filed: string }

/**
 * Checks each page against itself and the paper: the date in its header
 * against the scan's date, any total at the bottom against its rows, lines
 * the reader may have lost (a reply cut short, no total to prove the count),
 * lines it read as crossed out, and the mill and commodity the header names.
 * Each is ticked once by the operator; a tick lasts while what it was given
 * for is unchanged.
 */
export function checkPages(
  meta: PageMeta[], rows: CheckedRow[], slipDate: string | null, marks: SlipMark[] = [],
  ctx: { mill?: HeaderDiffers | null; jins?: HeaderDiffers | null; today?: Date } = {},
) {
  const out: PageCheck[] = [];
  const add = (page: number, code: PageCheckCode, params: Record<string, string | number>, stamp: string) => {
    const m = meta.find((x) => x.page === page);
    const what = code.slice("page_".length);
    const ticked = (m?.confirmed ?? []).includes(what);
    const given = m?.confirmedFor?.[what];
    // a tick from before ticks were tied to a value stands as it was given
    out.push({ page, code, params, stamp, confirmed: ticked && (given === undefined || given === stamp) });
  };
  const onPage = (page: number) => rows.filter((r) => (r.page ?? 1) === page);
  const q = (g: number) => (g / GRAMS_PER_QTL).toFixed(2);

  for (const page of [...new Set(marks.map((m) => m.page))].sort((a, b) => a - b)) {
    const first = marks.filter((m) => m.page === page).sort((a, b) => Number(a.rowId.slice(1)) - Number(b.rowId.slice(1)))[0];
    add(page, "page_rows", { sr: first.params.sr ?? first.params.to ?? "?", why: first.code }, "");
  }

  const pages = [...meta].sort((a, b) => a.page - b.page);
  /* A total proves the lines above it. It may be the page's own, or — on the
     last page of a long sheet — the sheet's, so it is also held against the
     running sum of every page up to it. A page proved either way needs no
     count of its lines. */
  const proved = new Set<number>();
  const totalAsked = new Set<number>();
  let runNet = 0, runGross = 0;
  const near = (a: number, b: number) => Math.abs(a - b) <= 5000; // 5 kg of rounding either way
  for (const m of pages) {
    const mine = onPage(m.page).filter((r) => !r.excluded);
    const net = mine.reduce((s, r) => s + (r.derivedNetGrams ?? 0), 0);
    const gross = mine.reduce((s, r) => s + (r.grossGrams ?? 0), 0);
    runNet += net; runGross += gross;
    if (m.total == null || m.total <= 0 || !mine.length) continue;
    const written = qtlToGrams(m.total);
    if (near(written, net) || near(written, gross)) { proved.add(m.page); continue; }
    if (near(written, runNet) || near(written, runGross)) { for (const p of pages) if (p.page <= m.page) proved.add(p.page); continue; }
    totalAsked.add(m.page);
    add(m.page, "page_total", {
      written: m.total.toFixed(2), net: q(net), gross: q(gross), diff: q(written - net),
      ...(m.page !== pages[0].page ? { allNet: q(runNet), allGross: q(runGross) } : {}),
    }, `${m.total}|${net}|${gross}`);
  }

  if (slipDate) {
    const dated = pages.filter((m) => (m.date ?? "").trim());
    for (const m of dated) {
      const d = writtenDate(m.date, ctx.today);
      if (d && d !== slipDate) add(m.page, "page_date", { written: d, scan: slipDate, why: "differs" }, `${d}|${slipDate}`);
      // written, but not as a date this could be: "20/9/96"
      else if (!d) add(m.page, "page_date", { raw: m.date!.trim().slice(0, 40), scan: slipDate, why: "unread" }, `${m.date}|${slipDate}`);
    }
    // no header says the date: the scan's own date is all there is, so it is asked once
    if (pages.length && !dated.length) add(pages[0].page, "page_date", { scan: slipDate, why: "none" }, `|${slipDate}`);
  }

  for (const m of pages) {
    const mine = onPage(m.page);
    const srs = mine.map((r) => r.ocr.srNo).filter((n): n is number => n != null);
    const span: Record<string, number> = srs.length ? { first: Math.min(...srs), last: Math.max(...srs) } : {};
    // Google stopped writing part-way down the page: what came after the last whole line is not here
    if (m.truncated) add(m.page, "page_cut", { n: mine.length, ...span }, "");
    else if (mine.length && !proved.has(m.page) && !totalAsked.has(m.page)) {
      // nothing at the bottom proves the count: the operator counts the lines once
      add(m.page, "page_count", { n: mine.length, ...span }, String(mine.length));
    }

    /* A line the reader calls crossed out is left out on its word alone; one
       that still carries figures is shown, and the operator says it is so. */
    const struck = mine.filter((r) => r.excluded && r.ocr.struckThrough === true && (r.ocr.grossQtl != null || r.ocr.netQtl != null));
    if (struck.length) {
      add(m.page, "page_struck", {
        n: struck.length,
        lines: struck.map((r) => `${r.ocr.srNo ?? "?"}${r.rstNo ? ` (RST ${r.rstNo})` : ""}`).join(", "),
      }, struck.map((r) => r.id).join(","));
    }

    const live = mine.filter((r) => !r.excluded);
    if (live.length && !live.some((r) => (r.ratePaisePerQtl ?? 0) > 0)) add(m.page, "page_norate", { n: live.length }, "");
  }

  for (const [code, h] of [["page_mill", ctx.mill], ["page_jins", ctx.jins]] as const) {
    if (h) add(h.page, code, { written: h.written, id: h.id ?? "", label: h.label, filed: h.filed }, `${h.id ?? "own"}|${h.filedId ?? "own"}`);
  }
  return out;
}

/**
 * The printed SR NO is the anchor that keeps a row's name and its numbers on
 * the same line. If the numbers the reader gave jump, repeat or run backwards
 * on a page, rows may have slid: one line's name with the next line's
 * weights. Rows the reader gave no number are counted as the lines between.
 * A page whose first line is not line 1 (nor the line after the last one of
 * the page before) has lost lines at the top.
 */
export function srBreaks(rows: ReviewRow[]) {
  const out: { page: number; code: "sr_gap" | "sr_repeat" | "sr_back" | "sr_top"; rowId: string; params: Record<string, string | number> }[] = [];
  const pages = [...new Set(rows.map((r) => r.page ?? 1))].sort((a, b) => a - b);
  let lastOfPrev = null as number | null;
  for (const page of pages) {
    const mine = rows.filter((r) => (r.page ?? 1) === page).sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
    // pages read without row numbers (older reads) are simply not checked
    if (!mine.some((r) => r.ocr.srNo != null)) { lastOfPrev = null; continue; }
    let prev: number | null = null;
    let between = 0;
    for (const r of mine) {
      const n = r.ocr.srNo;
      if (n == null) { between++; continue; }
      if (prev == null) {
        const fresh = 1 + between;
        const carried: number | null = lastOfPrev != null ? lastOfPrev + 1 + between : null;
        if (n > fresh && n !== carried) out.push({ page, code: "sr_top", rowId: r.id, params: { sr: n, missing: n - fresh } });
      } else if (n === prev) out.push({ page, code: "sr_repeat", rowId: r.id, params: { sr: n } });
      else if (n < prev) out.push({ page, code: "sr_back", rowId: r.id, params: { sr: n, prev } });
      // a jump the unnumbered rows in between account for is no gap
      else if (n > prev + 1 + between) out.push({ page, code: "sr_gap", rowId: r.id, params: { from: prev, to: n, missing: n - prev - 1 - between } });
      prev = n;
      between = 0;
    }
    lastOfPrev = prev == null ? null : prev + between;
  }
  return out;
}

export type SlipMark = { page: number; rowId: string; code: "sr_gap" | "sr_repeat" | "sr_back" | "sr_top" | "name_only" | "figures_only"; params: Record<string, string | number> };

/**
 * Where a page's rows may have slid against each other. Besides breaks in
 * the numbering, the surest sign is a line with a name and no weight, or a
 * weight and no name, that the paper does not strike out: when a crossed-out
 * line is skipped for its figures but not its name, every name below it sits
 * on the next line's weights and the last name is left over. Such a page is
 * checked line by line against the paper once, as a whole.
 */
export function slipMarks(rows: ReviewRow[]): SlipMark[] {
  const marks: SlipMark[] = srBreaks(rows).map((b) => ({ ...b }));
  for (const r of rows) {
    if (r.ocr.struckThrough === true) continue;
    const name = Boolean((r.ocr.adatiName ?? "").trim());
    // a weight that came back but is not a number ("19-20") is still a weight on this line
    const figures = r.ocr.grossQtl != null || r.ocr.netQtl != null || Boolean(r.ocr.unreadable?.grossQtl || r.ocr.unreadable?.netQtl);
    const sr = r.ocr.srNo ?? "?";
    if (name && !figures) marks.push({ page: r.page ?? 1, rowId: r.id, code: "name_only", params: { sr, name: r.ocr.adatiName ?? "" } });
    else if (!name && r.ocr.grossQtl != null) marks.push({ page: r.page ?? 1, rowId: r.id, code: "figures_only", params: { sr } });
  }
  return marks;
}
