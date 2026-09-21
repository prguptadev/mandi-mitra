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
    adatiName: z.string().nullable(),
    grossQtl: z.number().nullable(),
    katauti: z.number().nullable(),
    netQtl: z.number().nullable(),
    rate: z.number().nullable(),
    confidence: z.number().nullable(),
    struckThrough: z.boolean().nullable(),
  }),
  /** What will actually be written, after any human edit. */
  rstNo: z.string(),
  adatiId: z.string().nullable(),
  adatiRawText: z.string(),
  grossGrams: z.number().int().nullable(),
  katautiOverride: z.number().int().nullable(),
  ratePaisePerQtl: z.number().int().nullable(),
  /** Rows the operator dropped (struck through on paper, duplicates, blanks). */
  excluded: z.boolean().default(false),
  /** Set once the operator picks a name for an unresolved reading. */
  nameCorrected: z.boolean().default(false),
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
  netDiffGrams: number | null;
  issues: Issue[];
  blocking: boolean;
}

export function qtlToGrams(q: number) { return Math.round(q * GRAMS_PER_QTL); }

export function ocrToReviewRow(r: OcrRow, i: number): ReviewRow {
  const gross = r.grossQtl ?? null;
  return {
    id: `r${i}`,
    page: r.page ?? 1,
    ocr: {
      rstNo: r.rstNo ?? null,
      adatiName: r.adatiName ?? null,
      grossQtl: gross,
      katauti: r.katauti ?? null,
      netQtl: r.netQtl ?? null,
      rate: r.rate ?? null,
      confidence: r.confidence ?? null,
      struckThrough: r.struckThrough ?? null,
    },
    rstNo: (r.rstNo ?? "").trim(),
    adatiId: null,
    adatiRawText: (r.adatiName ?? "").trim(),
    grossGrams: gross === null ? null : qtlToGrams(gross),
    katautiOverride: null,
    ratePaisePerQtl: r.rate == null ? null : Math.round(r.rate * 100),
    excluded: r.struckThrough === true,
    nameCorrected: false,
    modelPick: r.supplierMatch?.trim() || null,
    confirmed: [],
  };
}

export function checkRow(
  row: ReviewRow,
  opts: {
    katauti: Katauti;
    resolve: (raw: string, modelPick?: string | null) => { match: AdatiMatch | null; suggestions: AdatiSuggestion[] };
    byId: (id: string) => { adatiId: string; nameHi: string; nameHinglish: string } | null;
    /** RST numbers already in the database for this date. */
    existingRst: Set<string>;
    /** RST numbers appearing more than once inside this batch. */
    dupeInBatch: Set<string>;
    rateFloorPaise: number;
    rateCeilPaise: number;
  },
): CheckedRow {
  const issues: Issue[] = [];
  const resolved = row.adatiId
    ? { match: null as AdatiMatch | null, suggestions: [] as AdatiSuggestion[] }
    : opts.resolve(row.adatiRawText, row.modelPick);
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
    }
  }

  if (row.excluded) {
    return {
      ...row, match: resolved.match, chosen, suggestions: resolved.suggestions,
      derivedKatautiUnits, derivedNetGrams, derivedAmountPaise, netAgrees, netDiffGrams,
      issues: [], blocking: false,
    };
  }

  if (!row.rstNo) issues.push({ code: "rst_missing", level: "warn", message: "RST number could not be read" });
  else if (opts.existingRst.has(row.rstNo)) issues.push({ code: "rst_exists", level: "warn", message: `RST ${row.rstNo} is already entered for this date`, params: { rst: row.rstNo } });
  else if (opts.dupeInBatch.has(row.rstNo)) issues.push({ code: "rst_dupe", level: "warn", message: `RST ${row.rstNo} appears twice on this sheet`, params: { rst: row.rstNo } });

  if (row.adatiId && !chosen) {
    issues.push({ code: "name_unresolved", level: "error", message: "The chosen supplier no longer exists", params: { name: row.adatiRawText } });
  } else if (!row.adatiId && !resolved.match) {
    issues.push({
      code: row.adatiRawText ? "name_unresolved" : "name_missing", level: "error",
      message: row.adatiRawText ? `No supplier matches "${row.adatiRawText}"` : "Supplier name could not be read",
      params: { name: row.adatiRawText },
    });
  } else if (resolved.match && resolved.match.via === "fuzzy") {
    issues.push({ code: "name_fuzzy", level: "warn", message: `Matched "${row.adatiRawText}" by similarity — check it`, params: { name: row.adatiRawText } });
  }

  if (row.grossGrams === null) issues.push({ code: "gross_missing", level: "error", message: "Gross weight could not be read" });
  else if (derivedNetGrams !== null && derivedNetGrams <= 0) issues.push({ code: "net_nonpositive", level: "error", message: "Net weight works out to zero or less" });
  else if (row.grossGrams > 200 * GRAMS_PER_QTL) issues.push({ code: "gross_large", level: "warn", message: "Gross weight looks very large for one slip" });
  else if (row.grossGrams < GRAMS_PER_QTL) issues.push({ code: "gross_small", level: "warn", message: "Gross weight is under one quintal — check the decimal point" });

  if (netAgrees === false) {
    issues.push({
      code: "net_mismatch", level: "warn",
      message: `The sheet's net weight differs from the calculation by ${((netDiffGrams ?? 0) / GRAMS_PER_QTL).toFixed(2)} qtl`,
      params: { diff: ((netDiffGrams ?? 0) / GRAMS_PER_QTL).toFixed(2) },
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

  if (row.ratePaisePerQtl === null) issues.push({ code: "rate_missing", level: "warn", message: "Rate could not be read — it can be filled in later" });
  else if (row.ratePaisePerQtl < opts.rateFloorPaise || row.ratePaisePerQtl > opts.rateCeilPaise) {
    issues.push({ code: "rate_range", level: "warn", message: "Rate is outside the usual range — check it" });
  }

  if ((row.ocr.confidence ?? 1) < 0.6) {
    issues.push({ code: "low_confidence", level: "warn", message: "The reader was unsure about this row" });
  }

  return {
    ...row, match: resolved.match, chosen, suggestions: resolved.suggestions,
    derivedKatautiUnits, derivedNetGrams, derivedAmountPaise, netAgrees, netDiffGrams,
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
