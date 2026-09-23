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

export function ocrToReviewRow(r: OcrRow, i: number): ReviewRow {
  const gross = r.grossQtl ?? null;
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
    },
    rstNo: normRst(r.rstNo),
    adatiId: null,
    adatiRawText: (r.adatiName ?? "").trim(),
    adatiRawVillage: (r.village ?? "").trim() || null,
    grossGrams: gross === null ? null : qtlToGrams(gross),
    katautiOverride: null,
    ratePaisePerQtl: r.rate == null ? null : Math.round(r.rate * 100),
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

  if (!row.rstNo) issues.push({ code: "rst_missing", level: "warn", message: "RST number could not be read" });
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

  if (row.grossGrams === null) issues.push({ code: "gross_missing", level: "error", message: "Gross weight could not be read" });
  else if (derivedNetGrams !== null && derivedNetGrams <= 0) issues.push({ code: "net_nonpositive", level: "error", message: "Net weight works out to zero or less" });
  else if (row.grossGrams > 100 * GRAMS_PER_QTL) {
    // likely a lost decimal point (1920 for 19.20): must be confirmed or fixed
    issues.push({
      code: "gross_large", level: confirmedField(row, "gross") ? "warn" : "error", message: "Gross weight looks very large for one slip — confirm it or fix it",
      ...(grossSuggestGrams ? { params: { suggest: (grossSuggestGrams / GRAMS_PER_QTL).toFixed(2) } } : {}),
    });
  }
  else if (row.grossGrams < GRAMS_PER_QTL) issues.push({ code: "gross_small", level: "warn", message: "Gross weight is under one quintal — check the decimal point" });

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

  if (row.ratePaisePerQtl === null || row.ratePaisePerQtl === 0) issues.push({ code: "rate_missing", level: "warn", message: "Rate could not be read — it can be filled in later" });
  else if (row.ratePaisePerQtl < 0) issues.push({ code: "rate_negative", level: "error", message: "Rate cannot be negative" });
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

/** "21-09-2026", "21/9/26", "२१-०९-२०२६" → "2026-09-21"; null when it does not read as a date. */
export function writtenDate(v: string | null | undefined): string | null {
  const t = String(v ?? "").replace(/[०-९]/g, (d) => String("०१२३४५६७८९".indexOf(d))).trim();
  const m = t.match(/(\d{1,2})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{2,4})/);
  if (!m) return null;
  const d = Number(m[1]), mo = Number(m[2]);
  let y = Number(m[3]);
  if (y < 100) y += 2000;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export interface PageMeta {
  page: number; date: string | null; millName: string | null; jins: string | null; total: number | null;
  /** What the operator checked against the paper for this page: "rows", "date", "total". */
  confirmed?: string[];
}
export type PageCheck = { page: number; code: "page_total" | "page_date" | "page_rows"; params: Record<string, string | number>; confirmed: boolean };

/**
 * Checks a whole page against itself: the date written in its header against
 * the scan's date, and any total written at the bottom against its rows —
 * a row missed by the reader shows up here even when every row looks fine.
 */
export function checkPages(meta: PageMeta[], rows: CheckedRow[], slipDate: string | null, marks: SlipMark[] = []) {
  const out: PageCheck[] = [];
  const done = (page: number, what: string) => (meta.find((m) => m.page === page)?.confirmed ?? []).includes(what);
  for (const page of [...new Set(marks.map((m) => m.page))].sort((a, b) => a - b)) {
    const first = marks.filter((m) => m.page === page).sort((a, b) => Number(a.rowId.slice(1)) - Number(b.rowId.slice(1)))[0];
    out.push({ page, code: "page_rows", params: { sr: first.params.sr ?? first.params.to ?? "?", why: first.code }, confirmed: done(page, "rows") });
  }
  for (const m of meta) {
    const mine = rows.filter((r) => (r.page ?? 1) === m.page && !r.excluded);
    if (m.total != null && m.total > 0 && mine.length) {
      const written = qtlToGrams(m.total);
      const net = mine.reduce((s, r) => s + (r.derivedNetGrams ?? 0), 0);
      const gross = mine.reduce((s, r) => s + (r.grossGrams ?? 0), 0);
      // the sheet may total net or gross; 5 kg of rounding either way is fine
      if (Math.abs(written - net) > 5000 && Math.abs(written - gross) > 5000) {
        out.push({ page: m.page, code: "page_total", params: {
          written: m.total.toFixed(2), net: (net / GRAMS_PER_QTL).toFixed(2), gross: (gross / GRAMS_PER_QTL).toFixed(2),
          diff: ((written - net) / GRAMS_PER_QTL).toFixed(2),
        }, confirmed: done(m.page, "total") });
      }
    }
    const d = writtenDate(m.date);
    if (d && slipDate && d !== slipDate) out.push({ page: m.page, code: "page_date", params: { written: d, scan: slipDate }, confirmed: done(m.page, "date") });
  }
  return out;
}

/**
 * The printed SR NO is the anchor that keeps a row's name and its numbers on
 * the same line. If the numbers the reader gave jump, repeat or run backwards
 * on a page, rows may have slid: one line's name with the next line's
 * weights. Rows the reader gave no number are counted as the lines between.
 */
export function srBreaks(rows: ReviewRow[]) {
  const out: { page: number; code: "sr_gap" | "sr_repeat" | "sr_back"; rowId: string; params: Record<string, string | number> }[] = [];
  const pages = [...new Set(rows.map((r) => r.page ?? 1))];
  for (const page of pages) {
    const mine = rows.filter((r) => (r.page ?? 1) === page).sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
    // pages read without row numbers (older reads) are simply not checked
    if (!mine.some((r) => r.ocr.srNo != null)) continue;
    let prev: number | null = null;
    let between = 0;
    for (const r of mine) {
      const n = r.ocr.srNo;
      if (n == null) { between++; continue; }
      if (prev != null) {
        if (n === prev) out.push({ page, code: "sr_repeat", rowId: r.id, params: { sr: n } });
        else if (n < prev) out.push({ page, code: "sr_back", rowId: r.id, params: { sr: n, prev } });
        // a jump the unnumbered rows in between account for is no gap
        else if (n > prev + 1 + between) out.push({ page, code: "sr_gap", rowId: r.id, params: { from: prev, to: n, missing: n - prev - 1 - between } });
      }
      prev = n;
      between = 0;
    }
  }
  return out;
}

export type SlipMark = { page: number; rowId: string; code: "sr_gap" | "sr_repeat" | "sr_back" | "name_only" | "figures_only"; params: Record<string, string | number> };

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
    const figures = r.ocr.grossQtl != null || r.ocr.netQtl != null;
    const sr = r.ocr.srNo ?? "?";
    if (name && !figures) marks.push({ page: r.page ?? 1, rowId: r.id, code: "name_only", params: { sr, name: r.ocr.adatiName ?? "" } });
    else if (!name && r.ocr.grossQtl != null) marks.push({ page: r.page ?? 1, rowId: r.id, code: "figures_only", params: { sr } });
  }
  return marks;
}
