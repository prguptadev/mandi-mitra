import { z } from "zod";
import crypto from "node:crypto";
import { and, eq, gte } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { newId } from "./ids.ts";

/* Reading a handwritten mandi sheet with Gemini.
 *
 * The prompt asks for what is WRITTEN, not for what is correct. We do not ask
 * the model to compute anything — net weight and amount are re-derived from
 * gross by our own code, and the model's reading of them is used only as a
 * cross-check. A row where the model's net matches our arithmetic is almost
 * certainly read correctly; a row where it does not gets flagged for a human.
 */

/* The model's reply is read loosely: "28.60" as a string, a confidence of 95
   meaning 0.95, a page number of 0. One odd value must not throw away a
   whole page that cost a read; a row that still cannot be read comes through
   empty, flagged, so the operator sees it on the screen. */
const toNum = (v: unknown) => {
  if (typeof v !== "string") return v;
  const t = v.replace(/[०-९]/g, (d) => String("०१२३४५६७८९".indexOf(d)))
    // "₹3450/-", "Rs. 3450", "49.85 qtl": the figure, without the money or weight marks written round it
    .replace(/^\s*(₹|rs\.?|रु\.?)\s*/i, "")
    .replace(/\s*(\/-|\/=|=\/|-\/|qtl\.?|q\.?|क्विं?\.?|क्वि०?)\s*$/i, "")
    .replace(/[,\s]/g, "");
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : v;
};
const looseNum = () => z.preprocess(toNum, z.number().nullable()).optional();
const looseStr = () => z.preprocess((v) => (typeof v === "number" ? String(v) : v), z.string().nullable()).optional();

export const OcrRowSchema = z.object({
  /** 1-based: which of the images this row was read from. */
  page: z.preprocess((v) => { const n = toNum(v); return typeof n === "number" && n >= 1 ? Math.round(n) : null; }, z.number().int().min(1).nullable()).optional(),
  srNo: looseNum(),
  rstNo: looseStr(),
  /** Exactly as written, in Devanagari. No transliteration, no correction. */
  adatiName: looseStr(),
  /** The known supplier the model thinks this is, copied exactly from the list. */
  supplierMatch: looseStr(),
  /** A village or place written beside the name, in Devanagari; not part of the name. */
  village: looseStr(),
  /** DHARAM KANTA column, in quintal. */
  grossQtl: looseNum(),
  /** KATAUTI column, as written. */
  katauti: looseNum(),
  /** NET WEIGHT column as written — our cross-check, never trusted directly. */
  netQtl: looseNum(),
  /** RATE column, rupees per quintal. */
  rate: looseNum(),
  /** 0..1, the model's own certainty for this row (95 is taken as 0.95). */
  confidence: z.preprocess((v) => {
    const n = toNum(v);
    if (typeof n !== "number") return n ?? null;
    return n > 1 && n <= 100 ? n / 100 : Math.min(1, Math.max(0, n));
  }, z.number().min(0).max(1).nullable()).optional(),
  /** true when the row is struck through on the paper. */
  struckThrough: z.preprocess((v) => (v === "true" ? true : v === "false" ? false : v), z.boolean().nullable()).optional(),
  /** How far down the picture this ruled line sits: 0 (top edge) to 1000 (bottom edge). Only to point at it on screen. */
  lineY: z.preprocess((v) => { const n = toNum(v); return typeof n === "number" && n >= 0 && n <= 1000 ? n : null; }, z.number().nullable()).optional(),
  notes: looseStr(),
  /** Ours, never the model's: cells that came back but are not a number, as written ("34S0", "19-20"). */
  unreadable: z.record(z.string()).optional(),
});

type OcrRowIn = z.infer<typeof OcrRowSchema>;
export const OcrPageSchema = z.object({
  date: looseStr(),
  millName: looseStr(),
  jins: looseStr(),
  totalWeightWritten: looseNum(),
  rows: z.array(z.unknown()).default([]).transform((rows) => rows.map((r): OcrRowIn => {
    const p = OcrRowSchema.safeParse(r);
    if (p.success) return p.data;
    /* One odd cell must not cost the rest of the line: each field is read on
       its own, a field that fails comes through empty, and what was written
       in it is kept so the screen can show it next to the empty box. */
    const o = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    const unreadable: Record<string, string> = {};
    for (const [k, field] of Object.entries(OcrRowSchema.shape)) {
      if (k === "unreadable" || !(k in o)) continue;
      const f = (field as z.ZodTypeAny).safeParse(o[k]);
      if (f.success) out[k] = f.data;
      else unreadable[k] = String(o[k]).slice(0, 40);
    }
    return {
      ...(out as OcrRowIn), unreadable,
      confidence: Math.min(typeof out.confidence === "number" ? out.confidence : 0, 0.5),
      notes: (out.notes as string | null | undefined) ?? "This row could not be read cleanly",
    };
  })),
});

export type OcrRow = z.infer<typeof OcrRowSchema>;
export type OcrPage = z.infer<typeof OcrPageSchema>;

/** Gemini's responseSchema dialect — a restricted subset of OpenAPI. */
const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    date: { type: "STRING", nullable: true, description: "Date in the header, as written" },
    millName: { type: "STRING", nullable: true, description: "MILL NAME in the header" },
    jins: { type: "STRING", nullable: true, description: "JINS in the header, e.g. 1509" },
    totalWeightWritten: { type: "NUMBER", nullable: true, description: "Any total written at the bottom" },
    rows: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          page: { type: "INTEGER", description: "1-based number of the image this row is on" },
          srNo: { type: "INTEGER", nullable: true, description: "The printed SR NO of the ruled line this row is on" },
          rstNo: { type: "STRING", nullable: true, description: "Weighbridge slip number in Latin digits; loose packets exactly as written with their + or - (2+45, 1-64)" },
          adatiName: { type: "STRING", nullable: true },
          supplierMatch: { type: "STRING", nullable: true, description: "Exact name from KNOWN SUPPLIERS (the part before any bracket), or null" },
          village: { type: "STRING", nullable: true, description: "Village or place written beside the name, in Devanagari; null when none" },
          grossQtl: { type: "NUMBER", nullable: true },
          katauti: { type: "NUMBER", nullable: true },
          netQtl: { type: "NUMBER", nullable: true, description: "NET WEIGHT as written (quintal; kilograms on a loose-packet line)" },
          rate: { type: "NUMBER", nullable: true },
          confidence: { type: "NUMBER", nullable: true },
          struckThrough: { type: "BOOLEAN", nullable: true },
          lineY: { type: "INTEGER", nullable: true, description: "How far down the image this ruled line is: 0 at the top edge, 1000 at the bottom edge" },
          notes: { type: "STRING", nullable: true },
        },
        /* netQtl and struckThrough must be REQUIRED. They are the two fields
           we rely on but never compute from: the written net is the arithmetic
           cross-check, and a struck-through row must not silently become a
           purchase. Left optional, the model skips them to save tokens. */
        required: ["page", "srNo", "rstNo", "adatiName", "grossQtl", "katauti", "netQtl", "rate", "confidence", "struckThrough"],
        /* Without an explicit order the API fills fields alphabetically, so the
           model would state its confidence before reading a single digit. */
        /* lineY comes after the figures: where the line sits is a pointer for
           the screen, and must not come between the model and the reading. */
        propertyOrdering: ["page", "srNo", "rstNo", "adatiName", "village", "supplierMatch", "grossQtl", "katauti", "netQtl", "rate", "struckThrough", "lineY", "notes", "confidence"],
      },
    },
  },
  required: ["rows"],
  propertyOrdering: ["date", "millName", "jins", "rows", "totalWeightWritten"],
} as const;

export const PROMPT = `You are reading a handwritten daily purchase register from a grain commission agent (arhtiya) in Uttar Pradesh, India. The form is printed in English; every entry is handwritten, mostly in Devanagari with some Latin digits.

You are given ONE page of the sheet. Set "page" to 1 on every row.

READ THE TABLE ONE PRINTED LINE AT A TIME. This matters more than anything else:
- The SR NO column on the left is printed (1, 2, 3 …). It is your anchor. For every printed line that has ANY handwriting on it — including a line that is crossed out — return exactly one object, with srNo set to that printed number, in SR NO order.
- Read each line straight across, left to right, staying on that one ruled line: the name, RST, weight, katauti, net and rate of an object must all come from the SAME printed line as its srNo.
- NEVER take a value from the line above or below to fill a gap. A cell that is empty, crossed out or scribbled over is null for that line. The lines after it keep their own values; nothing moves up or down.
- A crossed-out line still gets its own object (struckThrough true, whatever is legible, null for the rest). Leaving it out, or giving its name to the next line's numbers, shifts every line below it — the worst possible error.
- Handwriting often leans over the ruled lines. Decide which line a value belongs to by the line it sits on and by the SR NO beside it, not by the nearest text. The same supplier on two consecutive lines is normal: give each line its own object.

Columns, left to right:
- SR NO — printed row number: return it as srNo on every row.
- ADATI NAME — the supplier's name, handwritten in Hindi. Always return it in Devanagari, never in Latin letters. Copy the spelling as written; do not correct it.
  One exception: a trailing "T.C", "ट.C", "टी.सी" or "TC" is the abbreviation for Trading Company. Write it out as "ट्रेडिंग कंपनी". For example "शिवम T.C" becomes "शिवम ट्रेडिंग कंपनी".
  Firm words stay part of the name: ट्रेडर्स, ट्रेडिंग, एंटरप्राइजेज, एण्ड संस, इंडस्ट्रीज, ब्रदर्स. "एन्ड" and "एण्ड" are the same word: write "एण्ड".
  A village or place name is often written after the person's name — after a comma, a dash, in brackets, on a second line in the same cell, or in smaller writing (e.g. "रामपाल सिंह — नगला", "सूर्य प्रकाश वर्मा (जलेसर)"). That is NOT part of the name: return it in "village" (Devanagari, as written) and keep adatiName as the name alone. Leave "village" null when nothing of the kind is written.
  Honorifics are part of what is written: keep "श्री", "जी" or "साहब" if they are on the paper; do not add them.
  Common confusions in this hand: व/ब, न/ण, श/स/ष, ड/ड़, र/ट and a missing anusvara — when a stroke is ambiguous, prefer the reading that is a real Hindi name or a name in KNOWN SUPPLIERS below, and lower the confidence.
  This column is never blank on a real row. If the name is hard to read, give your best reading in Devanagari and lower the confidence for that row rather than returning null.
- RST NO — the weighbridge (dharam kanta) slip number. It is NOT a row count and is not in sequence. It can be 3 or 4 digits, and one sheet often mixes both, e.g. 626, 627, 1474, 629, 1471. Read every digit; do not drop a leading "1" or "14". Write it with Latin digits 0-9 only, even if it is written in Devanagari digits (६२६ → 626).
  One exception — LOOSE PACKETS: a few packets that came without a weighbridge slip are written in the RST box as two small numbers joined by "+" or "-", e.g. "2+45" or "1-64" (number of packets, then the last packet's weight in kg). Return rstNo exactly as written with its "+" or "-" ("2+45", "1-64"), in Latin digits (२+४५ → 2+45); never join it into one number like 245 or 2745. Such a line has no DHARAM KANTA and no KATAUTI: return null for both. Its NET WEIGHT is written in kilograms (e.g. 95 or 64): copy it exactly as written, without converting it. Only a "+" or "-" between two numbers makes a line loose packets; every other RST is digits only.
- DHARAM KANTA — gross weight in quintal, normally two decimal places (e.g. 19.20, 46.95).
- KATAUTI — a whole number, normally close to the gross weight rounded off.
- NET WEIGHT — weight in quintal, slightly less than the gross (in kilograms on a loose-packet line, as above). Always copy this column; it is how the entry is checked. If the column is blank on the paper, return null.
- RATE — rupees per quintal, normally a 4 digit number between 2800 and 4200.

Rules:
- Report what is WRITTEN. Do not calculate, correct or reconcile anything. If the net weight on the paper looks wrong, still report what is written.
- A digit you cannot read: return null for that field rather than guessing.
- struckThrough is required on every row: true if the row is struck through or crossed out on the paper, false otherwise. Never leave it out. A line whose name or RST is crossed out and that has no weight written is a struck line.
- Skip printed headers and blank ruled lines with no handwriting at all. Every line with handwriting is returned, even a crossed-out one.
- confidence is YOUR certainty about that whole row, 0 to 1. Be strict: use below 0.6 when any digit or letter is genuinely unclear. An honest low score is more useful than a confident guess, because low-confidence pages are read again with a stronger model.
- A ditto mark (〃, ", ,, or "do") actually written in a cell means "same as the row above": return the value from the row above. This is the ONLY case where a value comes from another line.
- One cell crossed out and rewritten is NOT a struck-through row: return the rewritten value and set struckThrough false. Only a line through the whole row means struckThrough true.
- Decimal points in this handwriting are often faint. A gross weight is nearly always between 1 and 60 quintal with two decimals, so 1920 almost certainly means 19.20. A worked example of an ordinary line: RST 1243, DHARAM KANTA written 1190 means 11.90 quintal, KATAUTI 12, NET 11.78.
- Numbers only in the number columns: a weight or rate is a plain number like 19.20 or 3450, never with "/-", "Rs" or a unit. A cell you cannot read as a number is null.
- lineY is where the ruled line sits on the image, from 0 at the top edge to 1000 at the bottom edge. An estimate is fine; it only points the operator to the line.

Return only the structured object.`;

/**
 * Pull whole row objects out of a reply that was cut off mid-stream.
 *
 * A 30-row sheet can be read perfectly and still get truncated on the closing
 * brace. Throwing all 30 rows away because the last two characters are missing
 * would be the wrong trade: the operator reviews every row anyway.
 */
export function salvageRows(text: string): unknown[] {
  const key = text.indexOf('"rows"');
  if (key === -1) return [];
  const arrayStart = text.indexOf("[", key);
  if (arrayStart === -1) return [];

  const out: unknown[] = [];
  let i = arrayStart + 1;
  while (i < text.length) {
    while (i < text.length && /[\s,]/.test(text[i])) i++;
    if (text[i] !== "{") break;

    let depth = 0, inString = false, escaped = false, j = i;
    for (; j < text.length; j++) {
      const ch = text[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) break;
    }
    if (depth !== 0 || j >= text.length) break; // this object is incomplete
    try {
      out.push(JSON.parse(text.slice(i, j + 1)));
    } catch {
      break;
    }
    i = j + 1;
  }
  return out;
}

/**
 * The header of a reply that was cut off: date, mill and commodity come
 * before the rows, so they are whole even when the rows are not. Without
 * them a cut page would also lose its date check.
 */
export function salvageHeader(text: string): { date: string | null; millName: string | null; jins: string | null } {
  const rowsAt = text.indexOf('"rows"');
  const head = rowsAt === -1 ? "" : text.slice(0, rowsAt);
  const str = (k: string) => {
    const m = head.match(new RegExp(`"${k}"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")`));
    if (!m) return null;
    try { return JSON.parse(m[1]) as string; } catch { return null; }
  };
  return { date: str("date"), millName: str("millName"), jins: str("jins") };
}

/** Models sometimes wrap JSON in a markdown fence despite responseMimeType. */
function stripFence(text: string): string {
  const t = text.trim();
  if (!t.startsWith("```")) return t;
  return t.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
}

/**
 * Google's errors are aimed at API developers, not at a munshi in Etah.
 * Translate the ones that actually happen into something actionable.
 *
 * The 401 in particular: an AI Studio API key starts with "AIza" and never
 * expires. A value starting with "AQ." is a short-lived OAuth token, which
 * works for a while and then stops — the confusing failure this maps.
 */
export interface QuotaInfo {
  /** per_day: waiting a minute will not help; per_minute: it will. */
  kind: "per_day" | "per_minute" | "spend_cap" | "unknown";
  limit: number | null;
  freeTier: boolean;
  model: string | null;
  retryAfterSec: number | null;
  /** Google allows 0 reads: this model has no free use on this key at all. */
  notFree?: boolean;
  /** The Google project's monthly spend cap in AI Studio is used up: no model helps. */
  spendCap?: boolean;
}

/** Pulls the quota details out of a 429 so the message can be accurate. */
export function parseQuota(json: any): QuotaInfo | null {
  const e = json?.error;
  if (!e || (e.code !== 429 && e.status !== "RESOURCE_EXHAUSTED")) return null;
  let quotaId = "", limit: number | null = null, model: string | null = null, retry: number | null = null;
  let zero = false;
  for (const d of e.details ?? []) {
    const t = String(d?.["@type"] ?? "");
    if (t.includes("QuotaFailure")) {
      /* Google lists every limit that was hit, per minute and per day. The
         daily one decides whether waiting helps, so it wins. */
      for (const v of d.violations ?? []) {
        const id = String(v?.quotaId ?? "");
        const lim = v?.quotaValue != null && v.quotaValue !== "" ? Number(v.quotaValue) : null;
        if (lim === 0) zero = true;
        if (!quotaId || (/PerDay/i.test(id) && !/PerDay/i.test(quotaId))) {
          quotaId = id; limit = lim; model = v?.quotaDimensions?.model ?? null;
        }
      }
    }
    if (t.includes("RetryInfo")) retry = parseFloat(String(d.retryDelay ?? "").replace("s", "")) || null;
  }
  /* Not a quota at all: the Google project has a monthly spend cap in AI
     Studio and it is used up. No model and no waiting helps — the cap has to
     be raised — so it is told apart from a daily allowance. */
  const spendCap = /spend(ing)? cap/i.test(String(e.message ?? ""));
  return {
    // an allowance of 0 never refills by waiting: the model is simply not free on this key
    kind: spendCap ? "spend_cap" : zero || /PerDay/i.test(quotaId) ? "per_day" : /PerMinute/i.test(quotaId) ? "per_minute" : "unknown",
    limit: zero ? 0 : limit, model, retryAfterSec: retry,
    freeTier: /FreeTier/i.test(quotaId),
    notFree: zero,
    spendCap,
  };
}

/** Daily quotas reset at midnight US Pacific time; say when that is locally. */
export function nextQuotaReset(now = new Date()): Date {
  const pt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(now);
  const get = (k: string) => Number(pt.find((x) => x.type === k)?.value);
  const secsIntoPtDay = get("hour") % 24 * 3600 + get("minute") * 60 + get("second");
  return new Date(now.getTime() + (86400 - secsIntoPtDay) * 1000);
}

export function explainGeminiError(status: number, message: string, apiKey?: string, raw?: unknown): string {
  const q = parseQuota(raw);
  if (q) {
    if (q.notFree) {
      return `${q.model ?? "This model"} has no free reads on this key (Google allows 0). Pick another model in Settings, or enable billing on the Google project that owns this key.`;
    }
    if (q.kind === "per_day") {
      const reset = nextQuotaReset().toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
      return q.freeTier
        ? `Today's free Gemini limit is used up (${q.limit ?? 20} reads a day on ${q.model ?? "this model"}). Every page is one read. It resets at about ${reset} IST. To remove the limit, enable billing on the Google project that owns this key.`
        : `Today's Gemini limit for this key is used up (${q.limit ?? "?"} a day). It resets at about ${reset} IST.`;
    }
    if (q.kind === "per_minute") {
      return `Too many reads in one minute (${q.limit ?? "?"} a minute${q.freeTier ? " on the free tier" : ""}). Wait ${Math.ceil(q.retryAfterSec ?? 60)} seconds and read again.`;
    }
  }
  const looksLikeToken = Boolean(apiKey) && !apiKey!.startsWith("AIza");
  if (status === 401 || /UNAUTHENTICATED|invalid authentication/i.test(message)) {
    return looksLikeToken
      ? "Google rejected the key. It does not look like an API key — an AI Studio key starts with \"AIza\". A temporary sign-in token works for a short while and then stops. Create a proper API key at aistudio.google.com/apikey and save it in Settings."
      : "Google rejected the API key. Check it in Settings, or create a new one at aistudio.google.com/apikey.";
  }
  if (status === 403 && /denied access|contact support|billing account|suspend/i.test(message)) {
    // the whole project is stopped (seen when its billing account is closed): no model or retry helps
    return "Google has stopped this key's project: its billing account is closed or out of balance. Open Google Cloud › Billing for that project, or save a key from another project.";
  }
  if (status === 403) {
    return "Google refused the request. The key may not have access to this model, or billing is not enabled on that Google project.";
  }
  if (status === 429) {
    if (/spend(ing)? cap/i.test(message)) {
      return "The Google project's monthly spending limit is used up, so Google is refusing every read — no other model will work either. Raise the limit at ai.studio/spend for the project this key belongs to, then read the sheet again.";
    }
    return "Google's Gemini limit was reached. Check the quota at ai.dev/rate-limit.";
  }
  if (status === 404) {
    return "That model name is not available on this key. Pick a different model in Settings.";
  }
  if (status >= 500) {
    return "Google's Gemini service is overloaded or down at the moment.";
  }
  return message;
}

/**
 * Builds the known-supplier block. Seeing the real candidates next to the
 * handwriting lets the model tell "फूलसिंह वर्मा" from a guess like "डोलार राम",
 * which fuzzy matching after the fact cannot do — it only ever sees the guess.
 */
export function knownSuppliersBlock(names: string[]): string {
  if (!names.length) return "";
  return `

KNOWN SUPPLIERS — this business already buys from these, so the handwritten name is very likely one of them. A village in brackets after a name is where that supplier is from; it helps tell two suppliers with the same name apart, and it is not part of the name:
${names.map((n, i) => `${i + 1}. ${n}`).join("\n")}

For every row:
- set "adatiName" to what is actually written, in Devanagari, as above (the person's or firm's name only; a village goes in "village");
- set "supplierMatch" to the name from this list — the part before any bracket — copied EXACTLY character for character, ONLY when the handwriting clearly is that name. If you are unsure, or it could be one of two names, return null — a wrong pick is worse than none, because the operator then does not look. A trailing T.C / ट्रेडिंग कंपनी on the paper matches a listed name ending in ट्रेडिंग. When two listed names are the same and the paper carries a village, pick the one whose bracket says that village.`;
}

export interface GeminiCallResult {
  ok: boolean;
  page?: OcrPage;
  raw?: unknown;
  error?: string;
  model: string;
  ms: number;
  tokensIn?: number;
  tokensOut?: number;
  /** Set when the reply was truncated and rows were recovered from the fragment. */
  truncated?: boolean;
  /** Present when Google refused for quota; tells us whether retrying is pointless. */
  quota?: QuotaInfo;
  finishReason?: string;
  /** HTTP status of Google's reply, when there was one. */
  status?: number;
  /** A failure that the same request may well not hit again: busy, network, a garbled reply. */
  transient?: boolean;
}

/* Tests point this at a local stand-in for Google (see scripts/test-e2e.ts).
   Only a local address is accepted, so a setting can never send the key elsewhere. */
export const GEMINI_BASE = /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(process.env.MANDI_GEMINI_BASE ?? "")
  ? process.env.MANDI_GEMINI_BASE!
  : "https://generativelanguage.googleapis.com";

/**
 * Copying a table needs no deliberation, and thinking tokens come out of the
 * same output budget, so each family gets the least thinking it allows:
 * 2.5 Flash / Flash-Lite switch it off, 2.5 Pro's minimum is 128, and the
 * Gemini 3 family takes a level instead of a budget.
 */
/** Models that refused a thinking setting once: sent without it from then on. */
const noThinking = new Set<string>();

export function thinkingFor(model: string): Record<string, unknown> | undefined {
  const m = model.toLowerCase();
  if (/^gemini-2\.5-pro/.test(m)) return { thinkingBudget: 128 };
  if (/^gemini-2\.5/.test(m)) return { thinkingBudget: 0 };
  if (/^gemini-([3-9]|\d{2,})/.test(m)) return { thinkingLevel: "low" };
  return undefined;
}

export async function readSheet(opts: {
  apiKey: string;
  model: string;
  images: { base64: string; mimeType: string }[];
  maxOutputTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  /** Supplier names already in the master, offered to the model as candidates. */
  knownSuppliers?: string[];
}): Promise<GeminiCallResult> {
  /* A 30-row sheet needs roughly 5–6k tokens of JSON. Gemini 2.5 also spends
     "thinking" tokens out of the same budget, which is what truncated the
     first real sheet at 8192. Copying a table needs no deliberation, so
     thinking is switched off and the ceiling raised. */
  const maxOutputTokens = Math.max(opts.maxOutputTokens ?? 32768, 32768);
  const started = Date.now();
  const parts: unknown[] = [{ text: PROMPT + knownSuppliersBlock(opts.knownSuppliers ?? []) }];
  for (const img of opts.images) {
    parts.push({ inlineData: { mimeType: img.mimeType, data: img.base64 } });
  }

  try {
    const send = (thinkingConfig: Record<string, unknown> | undefined) => fetch(
      `${GEMINI_BASE}/v1beta/models/${encodeURIComponent(opts.model)}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": opts.apiKey },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: {
            temperature: opts.temperature ?? 0,
            maxOutputTokens,
            responseMimeType: "application/json",
            responseSchema: RESPONSE_SCHEMA,
            ...(thinkingConfig ? { thinkingConfig } : {}),
          },
        }),
        signal: opts.signal ?? AbortSignal.timeout(180_000),
      },
    );
    const thinking = noThinking.has(opts.model) ? undefined : thinkingFor(opts.model);
    let res = await send(thinking);
    let json = await res.json().catch(() => null) as any;
    /* A newer model that does not take our thinking setting answers 400 about
       it; the same request without the setting is then the right one, and is
       remembered. Nothing was read, so nothing is spent. */
    if (res.status === 400 && thinking && /thinking/i.test(String(json?.error?.message ?? ""))) {
      noThinking.add(opts.model);
      res = await send(undefined);
      json = await res.json().catch(() => null) as any;
    }
    const ms = Date.now() - started;

    const tokensIn = json?.usageMetadata?.promptTokenCount;
    const tokensOut = json?.usageMetadata?.candidatesTokenCount;
    const finishReason: string | undefined = json?.candidates?.[0]?.finishReason;

    if (!res.ok) {
      const quota = parseQuota(json) ?? undefined;
      return {
        ok: false, model: opts.model, ms, tokensIn, tokensOut, raw: json, status: res.status,
        error: explainGeminiError(res.status, json?.error?.message ?? `HTTP ${res.status}`, opts.apiKey, json),
        quota,
        // busy (5xx) and per-minute limits pass; a daily limit or a bad key does not
        /* A daily allowance and a spent-up project cap both refuse again a
           second later: asking four times only wastes reads. */
        transient: res.status >= 500 || (res.status === 429 && quota?.kind !== "per_day" && quota?.kind !== "spend_cap"),
      };
    }

    const text = stripFence(json?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text ?? "").join("") ?? "");
    if (!text.trim()) {
      return {
        ok: false, model: opts.model, ms, raw: json, tokensIn, tokensOut, finishReason,
        error: finishReason === "MAX_TOKENS"
          ? "The reply hit the length limit before any rows came back. Scan one page at a time."
          : finishReason === "SAFETY" || finishReason === "PROHIBITED_CONTENT"
          ? "The image was refused by the model. Try a clearer scan."
          : `The model returned nothing${finishReason ? ` (${finishReason})` : ""}.`,
        status: 200,
        transient: finishReason !== "SAFETY" && finishReason !== "PROHIBITED_CONTENT",
      };
    }

    let parsedJson: unknown;
    let truncated = false;
    try {
      parsedJson = JSON.parse(text);
    } catch {
      // Cut off mid-stream. Recover whatever whole rows made it through.
      const rows = salvageRows(text);
      if (!rows.length) {
        return {
          ok: false, model: opts.model, ms, raw: text, tokensIn, tokensOut, finishReason,
          error: finishReason === "MAX_TOKENS"
            ? "The reply was cut short before a single complete row. Scan one page at a time."
            : "The model's reply was not valid JSON.",
          status: 200,
          transient: finishReason !== "MAX_TOKENS",
        };
      }
      truncated = true;
      parsedJson = { ...salvageHeader(text), rows };
    }

    const parsed = OcrPageSchema.safeParse(parsedJson);
    if (!parsed.success) {
      return {
        ok: false, model: opts.model, ms, raw: parsedJson, tokensIn, tokensOut, finishReason,
        error: `Unexpected shape: ${parsed.error.errors[0]?.message}`,
      };
    }

    return {
      ok: true, model: opts.model, ms, page: parsed.data, raw: parsedJson,
      tokensIn, tokensOut, truncated, finishReason,
    };
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return {
      ok: false, model: opts.model, ms: Date.now() - started,
      error: timedOut ? "Google took too long to answer." : "Could not reach Google (network).",
      transient: true,
    };
  }
}

/** Waits between attempts after a busy or network failure: about 40 s in all. */
export const RETRY_WAITS_MS = [4_000, 10_000, 25_000];

/**
 * readSheet, but a busy Google, a dropped connection or a per-minute limit
 * does not fail the page: it waits and tries again (up to 4 times). A garbled
 * reply gets one more try. A daily limit, a bad key or a refused image stop
 * at once — retrying those only spends reads. Every attempt is recorded.
 */
export async function readSheetReliably(
  opts: Parameters<typeof readSheet>[0],
  record: (r: GeminiCallResult) => Promise<void>,
  hooks: { onRetry?: (attempt: number, waitMs: number, r: GeminiCallResult) => Promise<void> | void; sleep?: (ms: number) => Promise<void> } = {},
): Promise<GeminiCallResult & { attempts: number }> {
  const sleep = hooks.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let attempt = 0;
  for (;;) {
    const r = await readSheet(opts);
    attempt++;
    await record(r);
    if (r.ok || !r.transient) return { ...r, attempts: attempt };
    // a garbled 200 reply is the model, not the service: one more try is enough
    const max = r.status === 200 ? 2 : RETRY_WAITS_MS.length + 1;
    if (attempt >= max) return { ...r, attempts: attempt };
    const wait = r.quota?.retryAfterSec
      ? Math.min(60_000, r.quota.retryAfterSec * 1000 + 500)
      : RETRY_WAITS_MS[attempt - 1] + Math.floor(Math.random() * 1000);
    await hooks.onRetry?.(attempt, wait, r);
    await sleep(wait);
  }
}


/* ------------------------------------------------------------ usage count */

export const keyHash = (key: string) => crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);

export async function recordCall(opts: { businessId: string; apiKey: string; result: GeminiCallResult }) {
  if (opts.result.quota?.kind === "per_day") markSpent(opts.apiKey, opts.result.model);
  await db.insert(schema.geminiCalls).values({
    id: newId(), businessId: opts.businessId, keyHash: keyHash(opts.apiKey),
    model: opts.result.model, ok: opts.result.ok,
    refused: Boolean(opts.result.quota),
    reportedLimit: opts.result.quota?.kind === "per_day" ? opts.result.quota.limit : null,
  });
}

/** Reads sent with this key since the last Pacific midnight, per model. */
export async function usageToday(apiKey: string, model: string) {
  const reset = nextQuotaReset();
  const dayStart = Math.floor(reset.getTime() / 1000) - 86400;
  const rows = await db.select().from(schema.geminiCalls).where(and(
    eq(schema.geminiCalls.keyHash, keyHash(apiKey)),
    eq(schema.geminiCalls.model, model),
    gte(schema.geminiCalls.at, dayStart),
  ));
  const used = rows.filter((r) => !r.refused).length;
  /* Used up for the day only on a daily refusal: a spend cap or a per-minute
     limit is not "today's free reads", and reads work again once it clears. */
  const refusedToday = await spentToday(apiKey, model);
  const known = [...rows].reverse().find((r) => r.reportedLimit != null)?.reportedLimit ?? null;
  const allTime = await db.select({ l: schema.geminiCalls.reportedLimit }).from(schema.geminiCalls)
    .where(and(eq(schema.geminiCalls.keyHash, keyHash(apiKey)), eq(schema.geminiCalls.model, model)));
  const everLimit = allTime.find((r) => r.l != null)?.l ?? null;
  return {
    model, used,
    /** From Google's own refusal; null until the key has been refused once. */
    dailyLimit: known ?? everLimit,
    exhausted: refusedToday,
    resetsAt: reset.toISOString(),
  };
}

/* ------------------------------------------------------ spent for today */

/* A daily refusal whose limit Google did not state leaves no number in the
   call log, so it is also remembered here until the next Pacific midnight. */
const spentUntil = new Map<string, number>();

export function markSpent(apiKey: string, model: string) {
  spentUntil.set(`${keyHash(apiKey)}|${model}`, nextQuotaReset().getTime());
}

/** True when this model already refused this key for the day (or is not free at all). */
export async function spentToday(apiKey: string, model: string): Promise<boolean> {
  const until = spentUntil.get(`${keyHash(apiKey)}|${model}`);
  if (until && until > Date.now()) return true;
  const dayStart = Math.floor(nextQuotaReset().getTime() / 1000) - 86400;
  const rows = await db.select({ refused: schema.geminiCalls.refused, limit: schema.geminiCalls.reportedLimit })
    .from(schema.geminiCalls).where(and(
      eq(schema.geminiCalls.keyHash, keyHash(apiKey)),
      eq(schema.geminiCalls.model, model),
      gte(schema.geminiCalls.at, dayStart),
    ));
  return rows.some((r) => r.refused && r.limit != null);
}

/* ------------------------------------------------------- models on key */

export interface KeyModel { id: string; displayName: string; inputTokenLimit: number | null }

/* Not for reading a sheet: pictures, speech, video, embeddings, agents. */
const NOT_FOR_SHEETS = /image|tts|audio|live|embed|computer-use|robotics|transcribe|translate|omni|veo|lyria|imagen|research|antigravity|aqa|learnlm/i;

/**
 * The models this key can call, from Google's own list. Listing is free: it
 * spends none of the day's reads. It does not say which ones are free —
 * only a real read (or AI Studio's rate-limit page) shows that.
 */
export async function listModels(apiKey: string): Promise<{ ok: true; models: KeyModel[] } | { ok: false; error: string; status?: number }> {
  const out: KeyModel[] = [];
  let pageToken = "";
  try {
    for (let i = 0; i < 10; i++) {
      const url = `${GEMINI_BASE}/v1beta/models?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
      const res = await fetch(url, { headers: { "x-goog-api-key": apiKey }, signal: AbortSignal.timeout(20_000) });
      const json = await res.json().catch(() => null) as any;
      if (!res.ok) {
        return { ok: false, status: res.status, error: explainGeminiError(res.status, json?.error?.message ?? `HTTP ${res.status}`, apiKey, json) };
      }
      for (const m of json?.models ?? []) {
        const id = String(m?.name ?? "").replace(/^models\//, "");
        if (!/^gemini-/i.test(id) || NOT_FOR_SHEETS.test(id)) continue;
        if (!(m?.supportedGenerationMethods ?? []).includes("generateContent")) continue;
        out.push({ id, displayName: String(m?.displayName ?? id), inputTokenLimit: m?.inputTokenLimit ?? null });
      }
      pageToken = json?.nextPageToken ?? "";
      if (!pageToken) break;
    }
  } catch {
    return { ok: false, error: "Could not reach Google (network)." };
  }
  out.sort((a, b) => b.id.localeCompare(a.id, "en", { numeric: true }));
  return { ok: true, models: out };
}
