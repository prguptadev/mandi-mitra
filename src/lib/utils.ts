import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));

export const GRAMS_PER_QTL = 100_000;
export const fmtQtl = (g: number) => (g / GRAMS_PER_QTL).toFixed(2);

export function fmtINR(paise: number, showPaise = true) {
  const v = Math.abs(paise) / 100;
  return (paise < 0 ? "-" : "") + v.toLocaleString("en-IN", {
    minimumFractionDigits: showPaise ? 2 : 0,
    maximumFractionDigits: showPaise ? 2 : 0,
  });
}

export function fmtDateTime(sec: number, lang: string) {
  return new Date(sec * 1000).toLocaleString(lang === "hi" ? "hi-IN" : "en-IN", {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

export function relTime(sec: number, lang: string) {
  const diff = Math.floor(Date.now() / 1000) - sec;
  const rtf = new Intl.RelativeTimeFormat(lang === "hi" ? "hi" : "en", { numeric: "auto" });
  if (diff < 60) return rtf.format(-diff, "second");
  if (diff < 3600) return rtf.format(-Math.floor(diff / 60), "minute");
  if (diff < 86400) return rtf.format(-Math.floor(diff / 3600), "hour");
  if (diff < 2592000) return rtf.format(-Math.floor(diff / 86400), "day");
  return rtf.format(-Math.floor(diff / 2592000), "month");
}

/** Today's date where the office is (not UTC: before 05:30 IST that would still be yesterday). */
export const todayISO = () => new Date().toLocaleDateString("en-CA");
