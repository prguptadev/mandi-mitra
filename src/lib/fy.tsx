import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api.ts";
import { useSession } from "@/lib/session.tsx";
import { todayISO } from "@/lib/utils.ts";

/*
 * The financial year, as in Tally: 1 April to 31 March ("2026-27"). Picked in
 * the top bar. The app always opens on the year today falls in; an older year
 * picked by hand lasts until the app is closed. On 1 April the new year opens
 * by itself, even with the app left running overnight. Only years up to this
 * one are offered — this year, the one before, and any older year with
 * entries — so the list grows by itself every April, with nothing to update.
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
export function financialYear(start: number, currentStart = fyStartOf(todayISO())): FinancialYear {
  return {
    start, from: `${start}-04-01`, to: `${start + 1}-03-31`,
    label: `${start}-${String(start + 1).slice(2)}`, current: start === currentStart,
  };
}

/** Held for this sitting only: the next start of the app is on the current year again. */
const KEY = "mandi.fy";
interface Ctx { fy: FinancialYear; thisYear: FinancialYear; setStart: (start: number) => void }
const FYCtx = createContext<Ctx | null>(null);

export function FinancialYearProvider({ children }: { children: ReactNode }) {
  // the date moves on by itself: looked at every minute and whenever the window comes back
  const [today, setToday] = useState(todayISO);
  useEffect(() => {
    const tick = () => setToday(todayISO());
    const id = window.setInterval(tick, 60_000);
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", tick);
    return () => { window.clearInterval(id); window.removeEventListener("focus", tick); document.removeEventListener("visibilitychange", tick); };
  }, []);
  const current = fyStartOf(today);

  const [start, setStartState] = useState<number>(() => {
    try { const v = Number(sessionStorage.getItem(KEY)); return v >= 2000 && v <= current ? v : current; } catch { return current; }
  });
  const forget = () => { try { sessionStorage.removeItem(KEY); } catch { /* nothing kept */ } };
  // 1 April: the new year is picked for everyone, whatever was picked before
  const seen = useRef(current);
  useEffect(() => {
    if (seen.current === current) return;
    seen.current = current;
    setStartState(current);
    forget();
  }, [current]);

  const value = useMemo<Ctx>(() => ({
    fy: financialYear(Math.min(start, current), current),
    thisYear: financialYear(current, current),
    setStart: (s: number) => {
      const v = Math.min(s, current);
      setStartState(v);
      try { if (v === current) sessionStorage.removeItem(KEY); else sessionStorage.setItem(KEY, String(v)); } catch { /* this sitting only anyway */ }
    },
  }), [start, current]);
  return <FYCtx.Provider value={value}>{children}</FYCtx.Provider>;
}

export function useFY() {
  const c = useContext(FYCtx);
  if (!c) throw new Error("useFY outside FinancialYearProvider");
  return c;
}

/** The years the top bar offers, newest first: this one, the one before, and older ones only if they have entries. */
export function useFYYears(): FinancialYear[] {
  const { thisYear, fy } = useFY();
  const { me } = useSession();
  const span = useQuery({
    queryKey: ["days", "span", me?.activeBusinessId],
    queryFn: () => api.get<{ first: string | null }>("/days/span"),
    enabled: Boolean(me?.activeBusinessId),
    staleTime: 10 * 60_000,
  });
  const first = span.data?.first ? fyStartOf(span.data.first) : thisYear.start;
  // the year on screen is always in the list, even one picked before its entries came
  const oldest = Math.min(first, thisYear.start - 1, fy.start);
  return Array.from({ length: thisYear.start - oldest + 1 }, (_, i) => financialYear(thisYear.start - i, thisYear.start));
}

/** A page's from/to dates: the chosen financial year, reset whenever another year is chosen. */
export function useFYRange() {
  const { fy } = useFY();
  const [from, setFrom] = useState(fy.from);
  const [to, setTo] = useState(fy.to);
  useEffect(() => { setFrom(fy.from); setTo(fy.to); }, [fy.start]);
  return { from, setFrom, to, setTo, fy };
}
