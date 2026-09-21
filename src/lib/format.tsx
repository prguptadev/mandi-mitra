import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api.ts";

export interface DisplayConfig {
  numberFormat: "indian" | "international" | "plain";
  showCurrencySymbol: boolean;
  currencySymbol: string;
  symbolSpacing: boolean;
  moneyDecimals: 0 | 2;
  weightDecimals: 2 | 3;
  rateDecimals: 0 | 2;
  negativeStyle: "minus" | "brackets";
  showWordAmount: boolean;
  weightUnitLabel: string;
  katautiMode: "per_quintal_rounded" | "per_quintal_exact" | "per_bag" | "none";
  katautiKgPerUnit: number;
}

export const DEFAULT_DISPLAY: DisplayConfig = {
  numberFormat: "indian",
  showCurrencySymbol: true,
  currencySymbol: "₹",
  symbolSpacing: false,
  moneyDecimals: 2,
  weightDecimals: 2,
  rateDecimals: 2,
  negativeStyle: "minus",
  showWordAmount: true,
  weightUnitLabel: "qtl",
  katautiMode: "per_quintal_rounded",
  katautiKgPerUnit: 1,
};

export const GRAMS_PER_QTL = 100_000;

/** Indian grouping: last three digits, then pairs. 1081909.36 -> 10,81,909.36 */
function groupIndian(intPart: string): string {
  if (intPart.length <= 3) return intPart;
  const last3 = intPart.slice(-3);
  const rest = intPart.slice(0, -3);
  return rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + last3;
}

function groupInternational(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatNumber(value: number, decimals: number, cfg: DisplayConfig): string {
  const fixed = Math.abs(value).toFixed(decimals);
  const [intPart, frac] = fixed.split(".");
  const grouped =
    cfg.numberFormat === "indian" ? groupIndian(intPart)
    : cfg.numberFormat === "international" ? groupInternational(intPart)
    : intPart;
  return frac ? `${grouped}.${frac}` : grouped;
}

function wrapNegative(body: string, negative: boolean, cfg: DisplayConfig): string {
  if (!negative) return body;
  return cfg.negativeStyle === "brackets" ? `(${body})` : `-${body}`;
}

/** 11,27,851.22 -> "11.28 lakh". Written for a reader who thinks in lakh/crore. */
export function wordAmount(paise: number, cfg: DisplayConfig): string | null {
  if (!cfg.showWordAmount) return null;
  const rupees = Math.abs(paise) / 100;
  if (rupees < 1000) return null;
  const sign = paise < 0 ? "-" : "";
  if (rupees >= 10_000_000) return `${sign}${(rupees / 10_000_000).toFixed(2)} crore`;
  if (rupees >= 100_000) return `${sign}${(rupees / 100_000).toFixed(2)} lakh`;
  return `${sign}${(rupees / 1000).toFixed(2)} thousand`;
}

export interface Formatter {
  cfg: DisplayConfig;
  /** Money from paise, with the currency symbol when enabled. */
  /** A hidden or unknown amount (null) shows as a dash, never as ₹0.00. */
  money: (paise: number | null | undefined, opts?: { symbol?: boolean; decimals?: number }) => string;
  /** Money with no symbol — for table columns that carry the symbol in the header. */
  amount: (paise: number, opts?: { decimals?: number }) => string;
  /** Rate per quintal, from paise. */
  rate: (paise: number) => string;
  /** Weight from grams, in quintal. */
  weight: (grams: number, opts?: { unit?: boolean }) => string;
  /** Bare integer, grouped. */
  int: (n: number) => string;
  words: (paise: number) => string | null;
  symbol: string;
  unit: string;
}

function build(cfg: DisplayConfig): Formatter {
  const symbolPrefix = cfg.showCurrencySymbol
    ? cfg.currencySymbol + (cfg.symbolSpacing ? " " : "")
    : "";

  const amount = (paise: number, opts?: { decimals?: number }) =>
    wrapNegative(formatNumber(paise / 100, opts?.decimals ?? cfg.moneyDecimals, cfg), paise < 0, cfg);

  return {
    cfg,
    amount,
    money: (paise, opts) => {
      if (paise == null) return "—";
      const body = formatNumber(paise / 100, opts?.decimals ?? cfg.moneyDecimals, cfg);
      const withSymbol = (opts?.symbol ?? true) ? symbolPrefix + body : body;
      return wrapNegative(withSymbol, paise < 0, cfg);
    },
    rate: (paise) => formatNumber(paise / 100, cfg.rateDecimals, cfg),
    weight: (grams, opts) => {
      // to the kg, half up, in integers — so screen, print and Excel never differ by a kilo
      const kg = Math.sign(grams) * Math.round(Math.abs(grams) / 1000);
      const body = formatNumber(cfg.weightDecimals <= 2 ? kg / 100 : grams / GRAMS_PER_QTL, cfg.weightDecimals, cfg);
      const signed = wrapNegative(body, grams < 0, cfg);
      return opts?.unit ? `${signed} ${cfg.weightUnitLabel}` : signed;
    },
    int: (n) => wrapNegative(formatNumber(n, 0, cfg), n < 0, cfg),
    words: (paise) => wordAmount(paise, cfg),
    symbol: cfg.showCurrencySymbol ? cfg.currencySymbol : "",
    unit: cfg.weightUnitLabel,
  };
}

const FormatCtx = createContext<Formatter>(build(DEFAULT_DISPLAY));

export function FormatProvider({ children }: { children: ReactNode }) {
  const q = useQuery({
    queryKey: ["settings", "display"],
    queryFn: () => api.get<DisplayConfig>("/settings/display"),
    staleTime: 60_000,
    retry: 1,
  });
  const cfg = q.data ?? DEFAULT_DISPLAY;
  const value = useMemo(() => build(cfg), [cfg]);
  return <FormatCtx.Provider value={value}>{children}</FormatCtx.Provider>;
}

export const useFormat = () => useContext(FormatCtx);

/* ------------------------------------------------------- parsing user input */

/** Accepts "1,08,190.36", "108190.36", "१०८" — returns paise. */
export function parseRupeesToPaise(input: string): number | null {
  const n = parseLooseNumber(input);
  return n === null ? null : Math.round(n * 100);
}

export function parseQtlToGrams(input: string): number | null {
  const n = parseLooseNumber(input);
  return n === null ? null : Math.round(n * GRAMS_PER_QTL);
}

const DEVANAGARI_DIGITS = "०१२३४५६७८९";

export function parseLooseNumber(input: string): number | null {
  if (input == null) return null;
  let s = String(input).trim();
  if (!s) return null;
  // Devanagari digits, in case the operator has a Hindi keypad on
  s = s.replace(/[०-९]/g, (d) => String(DEVANAGARI_DIGITS.indexOf(d)));
  s = s.replace(/[,\s ₹]/g, "");
  if (s === "" || s === "-" || s === ".") return null;
  if (!/^-?\d*\.?\d*$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
