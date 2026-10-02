/* Row order for the daily list and everything downloaded from it. Pure, so
   the screen and the server-made reports sort the same way. Several days
   always read oldest day first; the chosen order applies within a day.
   Last of all the id: rows entered in the same second (on two computers, or
   the lines of one sheet, whose ids keep the paper's order) read the same
   on every computer. */

export type SlipSortOrder = "entry" | "rstAsc" | "rstDesc" | "newestFirst" | "nameAsc" | "nameDesc";

const rstNum = (s: string) => {
  const n = Number(s);
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
};

const collator = new Intl.Collator(["hi", "en"], { sensitivity: "base", numeric: true });

export function sortSlips<T extends { id: string; slipDate: string; rstNo: string; createdAt: number }>(
  rows: T[], order: SlipSortOrder, name: (r: T) => string,
): T[] {
  const byId = (a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const within = (a: T, b: T): number => {
    switch (order) {
      case "rstAsc": return rstNum(a.rstNo) - rstNum(b.rstNo) || a.createdAt - b.createdAt || byId(a, b);
      case "rstDesc": return rstNum(b.rstNo) - rstNum(a.rstNo) || a.createdAt - b.createdAt || byId(a, b);
      case "newestFirst": return b.createdAt - a.createdAt || byId(a, b);
      case "nameAsc": return collator.compare(name(a), name(b)) || rstNum(a.rstNo) - rstNum(b.rstNo) || a.createdAt - b.createdAt || byId(a, b);
      case "nameDesc": return collator.compare(name(b), name(a)) || rstNum(a.rstNo) - rstNum(b.rstNo) || a.createdAt - b.createdAt || byId(a, b);
      default: return a.createdAt - b.createdAt || byId(a, b);
    }
  };
  return [...rows].sort((a, b) => (a.slipDate < b.slipDate ? -1 : a.slipDate > b.slipDate ? 1 : within(a, b)));
}
