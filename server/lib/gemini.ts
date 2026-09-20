import { z } from "zod";

/* Reading a handwritten mandi sheet with Gemini.
 *
 * The prompt asks for what is WRITTEN, not for what is correct. We do not ask
 * the model to compute anything — net weight and amount are re-derived from
 * gross by our own code, and the model's reading of them is used only as a
 * cross-check. A row where the model's net matches our arithmetic is almost
 * certainly read correctly; a row where it does not gets flagged for a human.
 */

export const OcrRowSchema = z.object({
  srNo: z.number().nullable().optional(),
  rstNo: z.string().nullable().optional(),
  /** Exactly as written, in Devanagari. No transliteration, no correction. */
  adatiName: z.string().nullable().optional(),
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
          srNo: { type: "INTEGER", nullable: true },
          rstNo: { type: "STRING", nullable: true },
          adatiName: { type: "STRING", nullable: true },
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
        required: ["rstNo", "adatiName", "grossQtl", "katauti", "netQtl", "rate", "confidence", "struckThrough"],
      },
    },
  },
  required: ["rows"],
} as const;

const PROMPT = `You are reading a handwritten daily purchase register from a grain commission agent (arhtiya) in Uttar Pradesh, India. The form is printed in English; every entry is handwritten, mostly in Devanagari with some Latin digits.

Read the table and return one object per data row, in the order they appear.

Columns, left to right:
- SR NO — printed row number.
- ADATI NAME — the supplier's name, handwritten in Hindi. Always return it in Devanagari, never in Latin letters. Copy the spelling as written; do not correct it.
  One exception: a trailing "T.C", "ट.C", "टी.सी" or "TC" is the abbreviation for Trading Company. Write it out as "ट्रेडिंग कंपनी". For example "शिवम T.C" becomes "शिवम ट्रेडिंग कंपनी".
  This column is never blank on a real row. If the name is hard to read, give your best reading in Devanagari and lower the confidence for that row rather than returning null.
- RST NO — a 3 or 4 digit slip number.
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
export function explainGeminiError(status: number, message: string, apiKey?: string): string {
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
    return "Google's rate limit was hit. Wait a minute and read the sheet again.";
  }
  if (status === 404) {
    return "That model name is not available on this key. Pick a different model in Settings.";
  }
  if (status >= 500) {
    return "Google's service had a problem. Try reading the sheet again in a moment.";
  }
  return message;
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
  finishReason?: string;
}

export async function readSheet(opts: {
  apiKey: string;
  model: string;
  images: { base64: string; mimeType: string }[];
  maxOutputTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}): Promise<GeminiCallResult> {
  /* A 30-row sheet needs roughly 5–6k tokens of JSON. Gemini 2.5 also spends
     "thinking" tokens out of the same budget, which is what truncated the
     first real sheet at 8192. Copying a table needs no deliberation, so
     thinking is switched off and the ceiling raised. */
  const maxOutputTokens = Math.max(opts.maxOutputTokens ?? 32768, 32768);
  const started = Date.now();
  const parts: unknown[] = [{ text: PROMPT }];
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
      return {
        ok: false, model: opts.model, ms, tokensIn, tokensOut, raw: json,
        error: explainGeminiError(res.status, json?.error?.message ?? `HTTP ${res.status}`, opts.apiKey),
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
    return {
      ok: false, model: opts.model, ms: Date.now() - started,
      error: err instanceof Error ? err.message : "Request failed",
    };
  }
}
