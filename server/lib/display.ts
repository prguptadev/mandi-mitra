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
  /** Retry a page on the stronger model when mean confidence is below this. */
  fallbackBelowConfidence: z.number().min(0).max(1).default(0.8),
  maxOutputTokens: z.number().int().min(256).max(32768).default(8192),
  temperature: z.number().min(0).max(1).default(0),
});

export type GeminiConfig = z.infer<typeof GeminiConfigSchema>;
export const defaultGeminiConfig = (): GeminiConfig => GeminiConfigSchema.parse({});

export const GEMINI_MODELS = [
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", note: "Fast and cheap. Right for most sheets." },
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", note: "Slower, better on faint or messy handwriting." },
  { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite", note: "Cheapest. Try only on very clean scans." },
] as const;
