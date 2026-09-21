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

export const OcrRowSchema = z.object({
  /** 1-based: which of the images this row was read from. */
  page: z.number().int().min(1).nullable().optional(),
  srNo: z.number().nullable().optional(),
  rstNo: z.string().nullable().optional(),
  /** Exactly as written, in Devanagari. No transliteration, no correction. */
  adatiName: z.string().nullable().optional(),
  /** The known supplier the model thinks this is, copied exactly from the list. */
  supplierMatch: z.string().nullable().optional(),
  /** DHARAM KANTA column, in quintal. */
  grossQtl: z.number().nullable().optional(),
  /** KATAUTI column, as written. */
  katauti: z.number().nullable().optional(),
  /** NET WEIGHT column as written — our cross-check, never trusted directly. */
  netQtl: z.number().nullable().optional(),
  /** RATE column, rupees per quintal. */
  rate: z.number().nullable().optional(),
  /** 0..1, the model's own certainty for this row. */
  confidence: z.number().min(0).max(1).nullable().optional(),
  /** true when the row is struck through on the paper. */
  struckThrough: z.boolean().nullable().optional(),
  notes: z.string().nullable().optional(),
});

export const OcrPageSchema = z.object({
  date: z.string().nullable().optional(),
  millName: z.string().nullable().optional(),
  jins: z.string().nullable().optional(),
  totalWeightWritten: z.number().nullable().optional(),
  rows: z.array(OcrRowSchema).default([]),
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
          srNo: { type: "INTEGER", nullable: true },
          rstNo: { type: "STRING", nullable: true },
          adatiName: { type: "STRING", nullable: true },
          supplierMatch: { type: "STRING", nullable: true, description: "Exact name from KNOWN SUPPLIERS, or null" },
          grossQtl: { type: "NUMBER", nullable: true },
          katauti: { type: "NUMBER", nullable: true },
          netQtl: { type: "NUMBER", nullable: true },
          rate: { type: "NUMBER", nullable: true },
          confidence: { type: "NUMBER", nullable: true },
          struckThrough: { type: "BOOLEAN", nullable: true },
          notes: { type: "STRING", nullable: true },
        },
        /* netQtl and struckThrough must be REQUIRED. They are the two fields
           we rely on but never compute from: the written net is the arithmetic
           cross-check, and a struck-through row must not silently become a
           purchase. Left optional, the model skips them to save tokens. */
        required: ["page", "rstNo", "adatiName", "grossQtl", "katauti", "netQtl", "rate", "confidence", "struckThrough"],
      },
    },
  },
  required: ["rows"],
} as const;

const PROMPT = `You are reading a handwritten daily purchase register from a grain commission agent (arhtiya) in Uttar Pradesh, India. The form is printed in English; every entry is handwritten, mostly in Devanagari with some Latin digits.

Read the table and return one object per data row, in the order they appear.

You are given ONE page of the sheet. Read every handwritten row on it, top to bottom. Set "page" to 1 on every row.

Columns, left to right:
- SR NO — printed row number.
- ADATI NAME — the supplier's name, handwritten in Hindi. Always return it in Devanagari, never in Latin letters. Copy the spelling as written; do not correct it.
  One exception: a trailing "T.C", "ट.C", "टी.सी" or "TC" is the abbreviation for Trading Company. Write it out as "ट्रेडिंग कंपनी". For example "शिवम T.C" becomes "शिवम ट्रेडिंग कंपनी".
  This column is never blank on a real row. If the name is hard to read, give your best reading in Devanagari and lower the confidence for that row rather than returning null.
- RST NO — the weighbridge (dharam kanta) slip number. It is NOT a row count and is not in sequence. It can be 3 or 4 digits, and one sheet often mixes both, e.g. 626, 627, 1474, 629, 1471. Read every digit; do not drop a leading "1" or "14".
- DHARAM KANTA — gross weight in quintal, normally two decimal places (e.g. 19.20, 46.95).
- KATAUTI — a whole number, normally close to the gross weight rounded off.
- NET WEIGHT — weight in quintal, slightly less than the gross. Always copy this column; it is how the entry is checked. If the column is blank on the paper, return null.
- RATE — rupees per quintal, normally a 4 digit number between 2800 and 4200.

Rules:
- Report what is WRITTEN. Do not calculate, correct or reconcile anything. If the net weight on the paper looks wrong, still report what is written.
- A digit you cannot read: return null for that field rather than guessing.
- struckThrough is required on every row: true if the row is struck through or crossed out on the paper, false otherwise. Never leave it out.
- Skip printed headers and blank ruled rows. Only rows with handwriting.
- confidence is YOUR certainty about that whole row, 0 to 1. Be strict: use below 0.6 when any digit or letter is genuinely unclear. An honest low score is more useful than a confident guess, because low-confidence pages are read again with a stronger model.
- Decimal points in this handwriting are often faint. A gross weight is nearly always between 1 and 60 quintal with two decimals, so 1920 almost certainly means 19.20.

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
  kind: "per_day" | "per_minute" | "unknown";
  limit: number | null;
  freeTier: boolean;
  model: string | null;
  retryAfterSec: number | null;
}

/** Pulls the quota details out of a 429 so the message can be accurate. */
export function parseQuota(json: any): QuotaInfo | null {
  const e = json?.error;
  if (!e || (e.code !== 429 && e.status !== "RESOURCE_EXHAUSTED")) return null;
  let quotaId = "", limit: number | null = null, model: string | null = null, retry: number | null = null;
  for (const d of e.details ?? []) {
    const t = String(d?.["@type"] ?? "");
    if (t.includes("QuotaFailure")) {
      const v = d.violations?.[0];
      quotaId = String(v?.quotaId ?? "");
      limit = v?.quotaValue != null ? Number(v.quotaValue) : null;
      model = v?.quotaDimensions?.model ?? null;
    }
    if (t.includes("RetryInfo")) retry = parseFloat(String(d.retryDelay ?? "").replace("s", "")) || null;
  }
  return {
    kind: /PerDay/i.test(quotaId) ? "per_day" : /PerMinute/i.test(quotaId) ? "per_minute" : "unknown",
    limit, model, retryAfterSec: retry,
    freeTier: /FreeTier/i.test(quotaId),
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
  if (status === 403) {
    return "Google refused the request. The key may not have access to this model, or billing is not enabled on that Google project.";
  }
  if (status === 429) {
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

KNOWN SUPPLIERS — this business already buys from these, so the handwritten name is very likely one of them:
${names.map((n, i) => `${i + 1}. ${n}`).join("\n")}

For every row:
- set "adatiName" to what is actually written, in Devanagari, as above;
- set "supplierMatch" to the name from this list, copied EXACTLY character for character, that the handwriting most likely is. Only use null if it is clearly none of them. A trailing T.C / ट्रेडिंग कंपनी on the paper matches a listed name ending in ट्रेडिंग.`;
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
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(opts.model)}:generateContent`,
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
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
        signal: opts.signal ?? AbortSignal.timeout(180_000),
      },
    );

    const ms = Date.now() - started;
    const json = await res.json().catch(() => null) as any;

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
        transient: res.status >= 500 || (res.status === 429 && quota?.kind !== "per_day"),
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
      parsedJson = { rows };
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
  const refusedToday = rows.some((r) => r.refused);
  const known = [...rows].reverse().find((r) => r.reportedLimit)?.reportedLimit ?? null;
  const allTime = await db.select({ l: schema.geminiCalls.reportedLimit }).from(schema.geminiCalls)
    .where(eq(schema.geminiCalls.keyHash, keyHash(apiKey)));
  const everLimit = allTime.find((r) => r.l)?.l ?? null;
  return {
    model, used,
    /** From Google's own refusal; null until the key has been refused once. */
    dailyLimit: known ?? everLimit,
    exhausted: refusedToday,
    resetsAt: reset.toISOString(),
  };
}
