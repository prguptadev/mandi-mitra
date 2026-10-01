import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { toHinglish } from "@server/lib/translit.ts";

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));

export const GRAMS_PER_QTL = 100_000;
/** "310.74": to the kg, half up, in integers — the same figure the screen and the parcha show. */
export const fmtQtl = (g: number) => {
  const kg = Math.round(Math.abs(g) / 1000);
  return `${g < 0 ? "-" : ""}${Math.floor(kg / 100)}.${String(kg % 100).padStart(2, "0")}`;
};

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

/** "2026-09-21" → "21-09-2026", as dates are written in the office. */
export const dmy = (iso: string) => iso.split("-").reverse().join("-");
/** "Mon" / "सोम" for a YYYY-MM-DD date. */
export const weekday = (iso: string, lang: string) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString(lang === "hi" ? "hi-IN" : "en-IN", { weekday: "short" });

/** Today's date where the office is (not UTC: before 05:30 IST that would still be yesterday). */
export const todayISO = () => new Date().toLocaleDateString("en-CA");

export type FirmMatch = "same" | "different" | "unknown";

/* Words that say what kind of firm it is, not which one: "Enterprises",
   "Dal Mill", "Trading Company", "Shri", "M/S". Two firms sharing one of these
   are no more alike than two sharing a street. */
const GENERIC = /^(?:SHRI+|SHREE|SRI|SIRI|THE|AND|ENT\w*|INTER?PRI\w*|TRAD\w*|TRED\w*|CO|COS|CORP\w*|COMP\w*|KAMP\w*|CMPNY|PVT|PRIVATE|LTD|LIMITED|LLP|INC|MILLS?|MIL|MILLERS?|DAA?LL?|DHAA?L|RICE|FLOUR|ATTA|OILS?|AGRO|AGRI\w*|FOODS?|INDUSTR\w*|INDS?|UDYOG|BHANDAR|STORES?|GENERAL|MERCHANTS?|COMMISSION|AGENTS?|AGENC\w*|AA?DHAT|ARHAT|KIRANA|GRAINS?|ANAJ|PULSES?|PROCESS\w*|EXPORTS?|IMPORTS?|SONS?|BROTHERS|BROS?|FIRM|GROUP)$/;
/* A Hindi name spells initials out: "वी सी" is V C. */
const LETTER_NAMES: Record<string, string> = {
  E: "A", BI: "B", SI: "C", DI: "D", I: "E", EF: "F", JI: "G", ECH: "H", AI: "I", JE: "J", KE: "K", EL: "L", EM: "M",
  EN: "N", O: "O", PI: "P", KYU: "Q", AR: "R", ES: "S", TI: "T", YU: "U", VI: "V", DABLYU: "W", EKS: "X", VAI: "Y", JED: "Z",
};
/* One spelling of a word, whichever way it was written: LAXMI and LAKSHMI,
   DALL and DAL, VIJAY and VIJAI come out the same. The first letter stays; the
   vowels after it are where spellings differ, so they go. */
const sound = (w: string) => {
  const x = w.replace(/KSH|KS/g, "X").replace(/SH/g, "S").replace(/PH/g, "F").replace(/W/g, "V").replace(/Z/g, "J")
    .replace(/Q|CK/g, "K").replace(/([TDBGKC])H/g, "$1");
  return (x[0] + x.slice(1).replace(/[AEIOUY]/g, "")).replace(/(.)\1+/g, "$1");
};

/* The kind of trade a generic word names, so "Ent." and "ENTERPRISES", or
   "DAL" and "DHAAL", read as one kind. Titles (Shri, The) name no trade. */
const TITLE = /^(?:SHRI+|SHREE|SRI|SIRI|THE|AND)$/;
const KINDS: [RegExp, string][] = [[/^(?:ENT|INTER?P)/, "E"], [/^(?:TRAD|TRED)/, "T"], [/^(?:CO|KAMP|CMPNY)/, "C"], [/^MIL/, "M"], [/^DH?A/, "D"]];
const tradeKind = (w: string) => KINDS.find(([re]) => re.test(w))?.[1] ?? w[0];

function firmWords(name: string) {
  const hindi = /[ऀ-ॿ]/.test(name);
  const latin = (hindi ? toHinglish(name) : name).toUpperCase()
    .replace(/\bM\s*\/\s*S\b\.?/g, " ") // "M/S Vijay Laxmi…"
    .replace(/&/g, " AND ").replace(/[^A-Z]+/g, " ").trim();
  const all = latin ? latin.split(" ").map((w) => (hindi ? LETTER_NAMES[w] ?? w : w)) : [];
  const generic = all.filter((w) => GENERIC.test(w));
  return { all, distinct: all.filter((w) => !GENERIC.test(w)), trades: new Set(generic.filter((w) => !TITLE.test(w)).map(tradeKind)) };
}

/**
 * Do two firm names look like the same firm? The portal shouts in English
 * ("VIJAY LAXMI DALL MILL") where the office writes "Vijay Laxmi Dal Mill",
 * "VLDM" or "विजय लक्ष्मी दाल मिल", so spelling, case, script and initials
 * must not matter — but "V C Enterprise" against "R K ENTERPRISES" shares only
 * a word every firm has, and that is worth saying.
 *
 * "unknown" when the names give nothing to go on (only generic words, or one
 * name a part of the other) — never a guess that they are the same.
 */
export function looksLikeSameFirm(a: string, b: string): FirmMatch {
  const A = firmWords(a), B = firmWords(b);
  if (!A.all.length || !B.all.length) return "unknown";
  const set = (ws: string[]) => new Set(ws.map(sound));
  const sa = set(A.distinct), sb = set(B.distinct);
  const [small, big] = sa.size <= sb.size ? [sa, sb] : [sb, sa];
  const within = [...small].every((w) => big.has(w));
  if (small.size && within && (small.size === big.size || small.size >= 2)) return "same";
  // written together or apart — "Vijaylaxmi" is "Vijay Laxmi"
  if (sa.size && sb.size && sound(A.distinct.join("")) === sound(B.distinct.join(""))) return "same";

  /* Initials: "VLDM" is Vijay Laxmi Dal Mill, "VCE" or "VC Ent." is
     V C Enterprises. A name of short pieces only is read as initials, and
     must match the other name's initials exactly. When the initials leave the
     trade out ("VK" of Vijay Kumar), the trade words must not disagree: VK
     Traders is not plainly Vijay Kumar Dal Mill — that is asked, not assumed. */
  const initials = (x: { all: string[]; distinct: string[] }) =>
    [x.all.map((w) => w[0]).join(""), x.distinct.map((w) => w[0]).join(""), x.distinct.filter((w) => w.length === 1).join("")];
  const asInitials = (x: { distinct: string[] }) => (x.distinct.length && x.distinct.every((w) => w.length <= 5) ? x.distinct.join("") : null);
  const ia = asInitials(A), ib = asInitials(B);
  const tradesAgree = !A.trades.size || !B.trades.size || [...A.trades].some((k) => B.trades.has(k));
  if ((ia && initials(B)[0] === ia) || (ib && initials(A)[0] === ib)) return "same";
  if ((ia && initials(B).includes(ia)) || (ib && initials(A).includes(ib))) return tradesAgree ? "same" : "unknown";

  if (!sa.size || !sb.size) return "unknown";
  // "Vijay Traders" and "Vijay Laxmi Dal Mill": one name inside the other is not enough either way
  return within ? "unknown" : "different";
}

/**
 * One licence however it is written: "L/2016/75/17121983", "l-2016-075-17121983.",
 * "2016/75/17121983". Letters and numbers only, a number without its leading
 * zeros, and the "L" in front left out. The same rule is in server/lib/emandi.ts.
 */
export const licenceKey = (l: string | null | undefined) => {
  const parts = ((l ?? "").toUpperCase().match(/[A-Z]+|\d+/g) ?? []).map((p) => (/^\d/.test(p) ? p.replace(/^0+(?=\d)/, "") : p));
  if (parts[0] === "L" && parts.length > 1) parts.shift();
  return parts.join("/");
};

/**
 * Is the e-Mandi login the firm open here? The licence decides when both
 * sides have one — it is exact. Otherwise the names, English and Hindi.
 * `by: null` when the portal has said nothing about whose login it is.
 */
export function sameFirm(portal: { firm: string | null; licence: string | null },
  here: { name?: string | null; nameHi?: string | null; licence?: string | null }): { match: FirmMatch; by: "licence" | "name" | null } {
  const pl = licenceKey(portal.licence), hl = licenceKey(here.licence);
  if (pl && hl) return { match: pl === hl ? "same" : "different", by: "licence" };
  if (!portal.firm) return { match: "unknown", by: null };
  const tries = [here.name, here.nameHi].filter(Boolean).map((n) => looksLikeSameFirm(portal.firm!, n!));
  const match = tries.includes("same") ? "same" : tries.includes("different") ? "different" : "unknown";
  return { match, by: "name" };
}
