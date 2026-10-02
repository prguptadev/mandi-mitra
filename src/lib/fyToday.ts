import { useEffect, useState } from "react";
import { useFY } from "@/lib/fy.tsx";
import { todayISO } from "@/lib/utils.ts";

/**
 * A page's from/to dates: the chosen financial year from its 1 April up to
 * today by this computer's clock — or to its 31 March for a year already
 * over. Until a "to" date is picked by hand it follows the clock, so a screen
 * left open overnight moves on to the new day by itself.
 */
export function useFYRangeToToday() {
  const { fy } = useFY();
  const [today, setToday] = useState(todayISO);
  useEffect(() => {
    const tick = () => setToday(todayISO());
    const id = window.setInterval(tick, 60_000);
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", tick);
    return () => { window.clearInterval(id); window.removeEventListener("focus", tick); document.removeEventListener("visibilitychange", tick); };
  }, []);
  const [from, setFrom] = useState(fy.from);
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => { setFrom(fy.from); setPicked(null); }, [fy.start]);
  const to = picked ?? (fy.to < today ? fy.to : today);
  return {
    from, setFrom, to, setTo: (v: string) => setPicked(v), fy,
    /** Still the year's own dates. */
    isDefault: from === fy.from && picked === null,
    reset: () => { setFrom(fy.from); setPicked(null); },
  };
}
