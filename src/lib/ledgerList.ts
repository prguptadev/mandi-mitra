import { normKey, toHinglish } from "@server/lib/translit.ts";
import { toDevanagari, hasDevanagari, looksLatin } from "@server/lib/devanagari.ts";

/* The supplier list beside the ledger: found by name the way the rest of the
   app finds a supplier — Hindi or Hinglish, spelt loosely — and sorted by
   either of its two columns. Pure, so the checks run it on the real list
   without a browser. */

export interface LedgerListRow {
  id: string; nameHi: string; nameHinglish: string; balancePaise: number;
}

/** "Raam  Lal" and "RAMLAL" are one name: letters only, a long vowel written once, "ph" heard as "f". */
const latinKey = (s: string) => s.toLowerCase().replace(/ph/g, "f").replace(/[^a-z0-9]/g, "").replace(/([aeiou])\1+/g, "$1");
/** The consonants only: "dharmpal", "radhey" and "ramvir" still find DHARAMPAL, RADHE and RAMVEER. */
const skeleton = (s: string) => s.toLowerCase().replace(/ph/g, "f").replace(/y\b/g, "").replace(/[^a-z]/g, "").replace(/[aeiou]/g, "");
/** From each word of the name to its end, so a loose spelling is only matched from the start of a word. */
const fromEachWord = (name: string, key: (w: string) => string) => {
  const words = name.split(/\s+/).map(key);
  return words.map((_, i) => words.slice(i).join("")).filter(Boolean);
};

/** What a row is found by, worked out once per list rather than on every key. */
export function searchKeys<T extends LedgerListRow>(rows: T[]) {
  return new Map(rows.map((r) => {
    const latin = (r.nameHinglish || toHinglish(r.nameHi)).toLowerCase();
    return [r.id, { hi: r.nameHi.normalize("NFC"), hiKey: fromEachWord(r.nameHi, normKey), latin, latinKey: latinKey(latin), skel: fromEachWord(latin, skeleton) }];
  }));
}

/** The rows whose name matches what was typed, in either script. */
export function findSuppliers<T extends LedgerListRow>(rows: T[], query: string, keys = searchKeys(rows)): T[] {
  const q = query.trim().normalize("NFC");
  if (!q) return rows;
  const lower = q.toLowerCase().replace(/\s+/g, " ");
  const qLatinKey = latinKey(q);
  const qSkel = skeleton(q);
  // a Latin query is also looked for in Hindi, and a Hindi one in Hinglish
  const asHindi = looksLatin(q) ? toDevanagari(q) : hasDevanagari(q) ? q : "";
  const hiKey = asHindi ? normKey(asHindi) : "";
  const asLatin = hasDevanagari(q) ? latinKey(toHinglish(q)) : "";
  const typedHindi = hasDevanagari(q);
  const keyOf = (r: T) => keys.get(r.id) ?? searchKeys([r]).get(r.id)!;
  // the name as written, in either script, or its Hindi key when Hindi was typed
  const close = rows.filter((r) => {
    const k = keyOf(r);
    return k.hi.includes(q) || k.latin.includes(lower)
      || (qLatinKey.length > 0 && k.latinKey.includes(qLatinKey))
      || (asHindi.length > 0 && k.hi.includes(asHindi))
      || (typedHindi && hiKey.length > 2 && k.hiKey.some((w) => w.startsWith(hiKey)))
      || (asLatin.length > 2 && k.latinKey.includes(asLatin));
  });
  if (close.length) return close;
  /* Nothing written that way: then the loose match, consonants only, which
     finds "dharmpal" for DHARAMPAL but alone would also find SINGH NISHAD for "sohan". */
  return rows.filter((r) => {
    const k = keyOf(r);
    return (qSkel.length > 2 && k.skel.some((w) => w.startsWith(qSkel)))
      || (hiKey.length > 2 && k.hiKey.some((w) => w.startsWith(hiKey)));
  });
}

/** The list is sorted by one of its two columns; most owed first until a heading is clicked. */
export type LedgerSort = { key: "name" | "amount"; dir: "asc" | "desc" };
export const DEFAULT_LEDGER_SORT: LedgerSort = { key: "amount", dir: "desc" };

/** By name in the screen's script, or by the amount to pay (ties by name). */
export function sortSuppliers<T extends LedgerListRow>(rows: T[], sort: LedgerSort, lang: string): T[] {
  const coll = new Intl.Collator(lang === "hi" ? "hi" : "en", { sensitivity: "base", numeric: true });
  const name = (r: T) => (lang === "hi" ? r.nameHi : r.nameHinglish || r.nameHi);
  const byName = (a: T, b: T) => coll.compare(name(a), name(b));
  const sign = sort.dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => sort.key === "name" ? sign * byName(a, b)
    : sign * (a.balancePaise - b.balancePaise) || byName(a, b));
}

/** A heading clicked: another column starts the way it is mostly wanted, the same one turns round. */
export const nextLedgerSort = (cur: LedgerSort, key: LedgerSort["key"]): LedgerSort =>
  cur.key !== key ? { key, dir: key === "amount" ? "desc" : "asc" } : { key, dir: cur.dir === "asc" ? "desc" : "asc" };

/** What this browser kept; anything else (an older choice) is most owed first. */
export function ledgerSortOf(raw: string | null): LedgerSort {
  try {
    const v = JSON.parse(raw ?? "") as Partial<LedgerSort> | null;
    if (v && (v.key === "name" || v.key === "amount") && (v.dir === "asc" || v.dir === "desc")) return { key: v.key, dir: v.dir };
  } catch { /* an older plain choice */ }
  return DEFAULT_LEDGER_SORT;
}
