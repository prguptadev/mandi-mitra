import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { todayISO } from "@/lib/utils.ts";

/*
 * The financial year, as in Tally: 1 April to 31 March ("2026-27"). Chosen in
 * the top bar and remembered on this computer. List pages open on it — dates
 * from its first to its last day — and a ledger opened on it starts from the
 * balance brought forward to 1 April.
 */

export interface FinancialYear {
  /** The calendar year it starts in: 2026 for 2026-27. */
  start: number;
  from: string;
  to: string;
  /** "2026-27" */
  label: string;
  /** The year today falls in. */
  current: boolean;
}

/** The financial year a date falls in: April onwards belongs to that year's, Jan–Mar to the one before. */
export const fyStartOf = (iso: string) => { const y = Number(iso.slice(0, 4)); return Number(iso.slice(5, 7)) >= 4 ? y : y - 1; };
export function financialYear(start: number): FinancialYear {
  return {
    start, from: `${start}-04-01`, to: `${start + 1}-03-31`,
    label: `${start}-${String(start + 1).slice(2)}`, current: start === fyStartOf(todayISO()),
  };
}

const KEY = "mandi.fy";
interface Ctx { fy: FinancialYear; years: FinancialYear[]; setStart: (start: number) => void }
const FYCtx = createContext<Ctx | null>(null);

export function FinancialYearProvider({ children }: { children: ReactNode }) {
  const now = fyStartOf(todayISO());
  const [start, setStartState] = useState<number>(() => {
    try { const v = Number(localStorage.getItem(KEY)); return v >= 2000 && v <= now + 1 ? v : now; } catch { return now; }
  });
  const setStart = (s: number) => { setStartState(s); try { localStorage.setItem(KEY, String(s)); } catch { /* this computer forgets; the current year is used */ } };
  // from the year the app began to the one after this
  const years = useMemo(() => Array.from({ length: now + 2 - 2024 }, (_, i) => financialYear(now + 1 - i)), [now]);
  return <FYCtx.Provider value={{ fy: financialYear(start), years, setStart }}>{children}</FYCtx.Provider>;
}

export function useFY() {
  const c = useContext(FYCtx);
  if (!c) throw new Error("useFY outside FinancialYearProvider");
  return c;
}

/** A page's from/to dates: the chosen financial year, reset whenever another year is chosen. */
export function useFYRange() {
  const { fy } = useFY();
  const [from, setFrom] = useState(fy.from);
  const [to, setTo] = useState(fy.to);
  useEffect(() => { setFrom(fy.from); setTo(fy.to); }, [fy.start]);
  return { from, setFrom, to, setTo, fy };
}
