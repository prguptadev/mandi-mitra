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
        required: ["rstNo", "adatiName", "grossQtl", "katauti", "rate", "confidence"],
      },
    },
  },
  required: ["rows"],
} as const;

const PROMPT = `You are reading a handwritten daily purchase register from a grain commission agent (arhtiya) in Uttar Pradesh, India. The form is printed in English; every entry is handwritten, mostly in Devanagari with some Latin digits.

Read the table and return one object per data row, in the order they appear.

Columns, left to right:
- SR NO — printed row number.
- ADATI NAME — the supplier's name, handwritten in Hindi. Copy the Devanagari EXACTLY as written. Do NOT transliterate it, do NOT correct the spelling, do NOT expand abbreviations. If it ends with something like "T.C" or "ट.C", keep that too.
- RST NO — a 3 or 4 digit slip number.
- DHARAM KANTA — gross weight in quintal, normally two decimal places (e.g. 19.20, 46.95).
- KATAUTI — a whole number, normally close to the gross weight rounded off.
- NET WEIGHT — weight in quintal, slightly less than the gross.
- RATE — rupees per quintal, normally a 4 digit number between 2800 and 4200.

Rules:
- Report what is WRITTEN. Do not calculate, correct or reconcile anything. If the net weight on the paper looks wrong, still report what is written.
- A digit you cannot read: return null for that field rather than guessing.
- If a row is struck through or crossed out, still include it and set struckThrough to true.
- Skip printed headers and blank ruled rows. Only rows with handwriting.
- confidence is YOUR certainty about that whole row, 0 to 1. Be strict: use below 0.6 when any digit is genuinely unclear.
- Decimal points in this handwriting are often faint. A gross weight is nearly always between 1 and 60 quintal with two decimals, so 1920 almost certainly means 19.20.

Return only the structured object.`;

export interface GeminiCallResult {
  ok: boolean;
  page?: OcrPage;
  raw?: unknown;
  error?: string;
  model: string;
  ms: number;
  tokensIn?: number;
  tokensOut?: number;
}

export async function readSheet(opts: {
  apiKey: string;
  model: string;
  images: { base64: string; mimeType: string }[];
  maxOutputTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}): Promise<GeminiCallResult> {
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
            maxOutputTokens: opts.maxOutputTokens ?? 8192,
            responseMimeType: "application/json",
            responseSchema: RESPONSE_SCHEMA,
          },
        }),
        signal: opts.signal ?? AbortSignal.timeout(180_000),
      },
    );

    const ms = Date.now() - started;
    const json = await res.json().catch(() => null) as any;

    if (!res.ok) {
      return { ok: false, model: opts.model, ms, error: json?.error?.message ?? `HTTP ${res.status}`, raw: json };
    }

    const text = json?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text ?? "").join("") ?? "";
    if (!text.trim()) {
      const reason = json?.candidates?.[0]?.finishReason;
      return {
        ok: false, model: opts.model, ms, raw: json,
        error: reason === "MAX_TOKENS"
          ? "The sheet was too long for one response. Split the scan into two pages."
          : `The model returned nothing${reason ? ` (${reason})` : ""}.`,
      };
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(text);
    } catch {
      return { ok: false, model: opts.model, ms, raw: text, error: "The model's reply was not valid JSON." };
    }

    const parsed = OcrPageSchema.safeParse(parsedJson);
    if (!parsed.success) {
      return { ok: false, model: opts.model, ms, raw: parsedJson, error: `Unexpected shape: ${parsed.error.errors[0]?.message}` };
    }

    return {
      ok: true, model: opts.model, ms, page: parsed.data, raw: parsedJson,
      tokensIn: json?.usageMetadata?.promptTokenCount,
      tokensOut: json?.usageMetadata?.candidatesTokenCount,
    };
  } catch (err) {
    return {
      ok: false, model: opts.model, ms: Date.now() - started,
      error: err instanceof Error ? err.message : "Request failed",
    };
  }
}
