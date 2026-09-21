import { useMemo, useState } from "react";

/* Click-to-sort for any table: click a heading for low→high, again for
   high→low, a third time to go back to the table's own order. Text sorts
   the way the office reads it (Hindi alphabetical, numbers inside text by
   value: RST 99 before RST 630). Blanks always go last. The choice is kept
   per table in this browser. */

export type SortDir = "asc" | "desc";
export type SortState = { key: string; dir: SortDir } | null;
type Value = string | number | null | undefined;

const collator = new Intl.Collator(["hi", "en"], { sensitivity: "base", numeric: true });

function compare(a: Value, b: Value): number {
  const blankA = a === null || a === undefined || a === "";
  const blankB = b === null || b === undefined || b === "";
  if (blankA || blankB) return blankA === blankB ? 0 : blankA ? 1 : -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return collator.compare(String(a), String(b));
}

function read(storageKey?: string): SortState {
  if (!storageKey) return null;
  try {
    const raw = localStorage.getItem(`mandi.sort.${storageKey}`);
    return raw ? (JSON.parse(raw) as SortState) : null;
  } catch { return null; }
}

export function useSort<T>(
  rows: T[],
  accessors: Record<string, (r: T) => Value>,
  opts: { storageKey?: string } = {},
) {
  const [sort, setSortState] = useState<SortState>(() => read(opts.storageKey));
  const setSort = (s: SortState) => {
    setSortState(s);
    if (opts.storageKey) {
      try {
        if (s) localStorage.setItem(`mandi.sort.${opts.storageKey}`, JSON.stringify(s));
        else localStorage.removeItem(`mandi.sort.${opts.storageKey}`);
      } catch { /* ignore */ }
    }
  };

  const sorted = useMemo(() => {
    if (!sort || !accessors[sort.key]) return rows;
    const get = accessors[sort.key];
    const sign = sort.dir === "asc" ? 1 : -1;
    // blanks stay last in both directions; ties keep their original order
    return rows
      .map((r, i) => ({ r, i, v: get(r) }))
      .sort((x, y) => {
        const blankX = x.v === null || x.v === undefined || x.v === "";
        const blankY = y.v === null || y.v === undefined || y.v === "";
        if (blankX !== blankY) return blankX ? 1 : -1;
        return sign * compare(x.v, y.v) || x.i - y.i;
      })
      .map((x) => x.r);
  }, [rows, sort?.key, sort?.dir]);

  /** Spread onto a sortable <Th>. */
  const th = (key: string) => ({
    sortDir: sort?.key === key ? sort.dir : null,
    onSort: () => setSort(sort?.key !== key ? { key, dir: "asc" } : sort.dir === "asc" ? { key, dir: "desc" } : null),
  });

  return { sorted, sort, setSort, th };
}
