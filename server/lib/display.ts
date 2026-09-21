import { z } from "zod";

/** How every number in the app is rendered. Per business, editable in Settings. */
export const DisplayConfigSchema = z.object({
  /** indian = 10,81,909.36  ·  international = 1,081,909.36  ·  plain = 1081909.36 */
  numberFormat: z.enum(["indian", "international", "plain"]).default("indian"),
  showCurrencySymbol: z.boolean().default(true),
  currencySymbol: z.string().max(4).default("₹"),
  /** Space between the symbol and the figure. */
  symbolSpacing: z.boolean().default(false),
  moneyDecimals: z.union([z.literal(0), z.literal(2)]).default(2),
  weightDecimals: z.union([z.literal(2), z.literal(3)]).default(2),
  rateDecimals: z.union([z.literal(0), z.literal(2)]).default(2),
  negativeStyle: z.enum(["minus", "brackets"]).default("minus"),
  /** Show a lakh/crore hint next to large totals. */
  showWordAmount: z.boolean().default(true),
  weightUnitLabel: z.string().max(8).default("qtl"),
  /** Katauti used on the daily list when no mill is chosen. */
  katautiMode: z.enum(["per_quintal_rounded", "per_quintal_exact", "per_bag", "none"])
    .default("per_quintal_rounded"),
  katautiKgPerUnit: z.number().min(0).max(5).default(1),
  katautiRounding: z.enum(["half_up", "up", "down", "half_even"]).default("half_up"),
});

export type DisplayConfig = z.infer<typeof DisplayConfigSchema>;
export const defaultDisplayConfig = (): DisplayConfig => DisplayConfigSchema.parse({});

export const GeminiConfigSchema = z.object({
  model: z.string().default("gemini-2.5-flash"),
  fallbackModel: z.string().default("gemini-2.5-pro"),
  /** Tried in order when a model's free reads for the day are used up (or it
   *  is not free on this key). Each model has its own daily allowance, so a
   *  short list multiplies the pages that can be read in a day. */
  backupModels: z.array(z.string().min(1).max(80)).max(6).default([]),
  /** Retry a page on the stronger model when mean confidence is below this. */
  fallbackBelowConfidence: z.number().min(0).max(1).default(0.8),
  /** A 30-row sheet needs ~6k; the ceiling is generous because truncation
   *  loses the whole page and a retry costs more than the unused headroom. */
  maxOutputTokens: z.number().int().min(4096).max(65536).default(32768),
  temperature: z.number().min(0).max(1).default(0),
});

export type GeminiConfig = z.infer<typeof GeminiConfigSchema>;
export const defaultGeminiConfig = (): GeminiConfig => GeminiConfigSchema.parse({});

/* Models that read a picture and answer in a fixed JSON shape. Which of them
   are free, and how many pages a day, depends on the key's Google project —
   Settings › "Check models" asks Google and tries them on a real page. */
export const GEMINI_MODELS = [
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", note: "Proven on these sheets. Small free allowance per day.", noteHi: "इन पर्चियों पर परखा हुआ। रोज़ की मुफ़्त पढ़ाई कम।" },
  { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash-Lite", note: "Cheapest 2.5. Check it on a page before relying on it.", noteHi: "2.5 का सबसे सस्ता। भरोसा करने से पहले एक पन्ने पर आज़माएँ।" },
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", note: "Slow, strong on messy writing. Often not free.", noteHi: "धीमा, बिगड़ी लिखावट पर मज़बूत। अक्सर मुफ़्त नहीं।" },
  { id: "gemini-3-flash-preview", label: "Gemini 3 Flash (preview)", note: "Newer Flash. Preview: may change or stop.", noteHi: "नया Flash। प्रीव्यू: बदल या बंद हो सकता है।" },
  { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite", note: "Light and fast, larger free allowance.", noteHi: "हल्का और तेज़, ज़्यादा मुफ़्त पढ़ाई।" },
  { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite", note: "Light and fast, larger free allowance.", noteHi: "हल्का और तेज़, ज़्यादा मुफ़्त पढ़ाई।" },
  { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash", note: "Newer Flash.", noteHi: "नया Flash।" },
  { id: "gemini-3.6-flash", label: "Gemini 3.6 Flash", note: "Newer Flash.", noteHi: "नया Flash।" },
  { id: "gemini-3.7-flash", label: "Gemini 3.7 Flash", note: "Newer Flash.", noteHi: "नया Flash।" },
  { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", note: "Newest Flash.", noteHi: "सबसे नया Flash।" },
] as const;
