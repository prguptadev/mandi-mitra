import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { CalendarDays, ChevronLeft, ChevronRight, X } from "lucide-react";
import { api } from "@/lib/api.ts";
import { useI18n } from "@/lib/i18n.tsx";
import { useFormat } from "@/lib/format.tsx";
import { Card, CardHeader, Badge, Button, Input } from "@/components/ui/index.tsx";
import { SkeletonTable } from "@/components/Skeletons.tsx";
import { cn } from "@/lib/utils.ts";
import { dmy } from "@server/lib/parchaLabels.ts";

/** "Sunday" / "रविवार", from the browser itself. */
const weekday = (iso: string, lang: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString(lang === "hi" ? "hi-IN" : "en-IN", { weekday: "long" });

/* The day's rate at the top of the dashboard: one table per day, a line for
   each mill and commodity — a mill that took two commodities that day has two
   lines. The rate is Σ(net × rate) / Σ net over the slips that carry a rate,
   the same figure the parcha and the mill report print, so the three agree.
   A line whose slips have no rate yet has no rate to show: it is left out and
   counted at the foot instead. */

interface Line {
  millId: string | null; millCode: string | null; millName: string | null; millNameHi: string | null;
  jinsId: string; jinsCode: string; jinsName: string; jinsNameHi: string | null;
  slips: number; bags: number; grossGrams: number; netGrams: number;
  amountPaise: number; payablePaise: number; avgRatePaisePerQtl: number; waiting: number;
}
interface Day {
  date: string;
  lines: Line[];
  total: { slips: number; bags: number; grossGrams: number; netGrams: number; amountPaise: number; payablePaise: number; avgRatePaisePerQtl: number } | null;
  waiting: number;
}

/** One day, or the latest days the period holds. */
const shift = (iso: string, by: number) => {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + by);
  return d.toISOString().slice(0, 10);
};

export function DayAveragesCard({ qs }: { qs: string }) {
  const { t, pick, lang } = useI18n();
  const f = useFormat();
  /** Empty = the latest days of the period; a date = only that day. */
  const [day, setDay] = useState("");
  const query = day ? new URLSearchParams({ from: day, to: day, days: "1" }).toString() : qs;
  const q = useQuery({
    queryKey: ["dashboard", "day-averages", query],
    queryFn: () => api.get<{ days: Day[] }>(`/dashboard/day-averages?${query}`),
  });

  const picker = (
    <div className="flex items-center gap-1">
      {day && (
        <Button size="sm" variant="ghost" icon={<ChevronLeft className="h-3.5 w-3.5" />}
          onClick={() => setDay(shift(day, -1))} aria-label={t("daily.prevDay")} title={t("daily.prevDay")} />
      )}
      <Input type="date" value={day} onChange={(e) => setDay(e.target.value)}
        className="h-8 w-36 text-[13px]" aria-label={t("dash.dayPick")} title={t("dash.dayPick")} />
      {day && (
        <>
          <Button size="sm" variant="ghost" icon={<ChevronRight className="h-3.5 w-3.5" />}
            onClick={() => setDay(shift(day, 1))} aria-label={t("daily.nextDay")} title={t("daily.nextDay")} />
          <Button size="sm" variant="ghost" icon={<X className="h-3.5 w-3.5" />}
            onClick={() => setDay("")} aria-label={t("dash.dayLatest")} title={t("dash.dayLatest")}>{t("dash.dayLatest")}</Button>
        </>
      )}
    </div>
  );

  // nothing to show yet, or the figures are not in: the card stays away
  if (q.isLoading) return <Card className="mb-5"><SkeletonTable rows={3} /></Card>;
  const days = q.data?.days ?? [];
  // a day picked by hand keeps the card there even when that day is empty, so
  // the answer "nothing that day" is visible instead of the card vanishing
  if (!days.length && !day) return null;

  const th = "px-2 py-1.5 text-left text-[11px] font-medium uppercase tracking-wide text-muted";
  const thNum = cn(th, "text-right");
  const td = "whitespace-nowrap px-2 py-1.5 text-[13px]";
  const tdNum = cn(td, "num text-right");

  return (
    <Card className="mb-5">
      <CardHeader title={t("dash.dayRate")} sub={t("dash.dayRateSub")} action={picker} />
      <div className="space-y-4 p-3">
        {!days.length && (
          <p className="px-1 text-[13px] text-faint">{t("dash.dayEmpty", { date: dmy(day) })}</p>
        )}
        {days.map((d) => (
          <div key={d.date}>
            <p className="mb-1.5 flex items-center gap-2 text-[13px] font-semibold text-ink">
              <CalendarDays className="h-3.5 w-3.5 text-faint" />
              <Link href={`/daily?date=${d.date}`} className="num hover:underline">{dmy(d.date)}</Link>
              <span className="text-[12px] font-normal text-faint">{weekday(d.date, lang)}</span>
              {d.waiting > 0 && <Badge tone="warn">{t("dash.dayWaiting", { n: d.waiting })}</Badge>}
            </p>
            {d.lines.length === 0 ? (
              <p className="px-2 text-[12px] text-faint">{t("dash.dayNoRate")}</p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-line">
                <table className="min-w-full">
                  <thead className="bg-raised/60">
                    <tr>
                      <th className={th}>{t("load.mill")}</th>
                      <th className={th}>{t("daily.jins")}</th>
                      <th className={thNum}>{t("dash.slips")}</th>
                      <th className={thNum}>{t("dash.dayBags")}</th>
                      <th className={thNum}>{t("daily.net")}</th>
                      <th className={thNum}>{t("dash.dayAvg")}</th>
                      <th className={thNum}>{t("daily.amount")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.lines.map((l) => (
                      <tr key={`${l.millId ?? "none"}|${l.jinsId}`} className="border-t border-line/70">
                        <td className={td}>
                          {l.millCode
                            ? <Link href={`/daily?date=${d.date}&mill=${l.millId}`} className="inline-flex items-center gap-1.5 hover:underline">
                                <Badge tone="neutral" className="num">{l.millCode}</Badge>
                                <span className="text-muted">{pick(l.millName ?? "", l.millNameHi ?? "")}</span>
                              </Link>
                            : <span className="text-faint">{t("daily.noMill")}</span>}
                        </td>
                        <td className={td}><span className="num">{l.jinsCode}</span></td>
                        <td className={tdNum}>{l.slips}</td>
                        <td className={cn(tdNum, !l.bags && "text-faint")}>{l.bags || "—"}</td>
                        <td className={tdNum}>{f.weight(l.netGrams)}</td>
                        <td className={cn(tdNum, "font-semibold text-brand")}>{f.rate(l.avgRatePaisePerQtl)}</td>
                        <td className={tdNum}>{f.amount(l.amountPaise)}</td>
                      </tr>
                    ))}
                    {d.total && d.lines.length > 1 && (
                      <tr className="border-t-2 border-line bg-raised/40 font-semibold">
                        <td className={td} colSpan={2}>{t("dash.dayAll")}</td>
                        <td className={tdNum}>{d.total.slips}</td>
                        <td className={cn(tdNum, !d.total.bags && "text-faint")}>{d.total.bags || "—"}</td>
                        <td className={tdNum}>{f.weight(d.total.netGrams)}</td>
                        <td className={cn(tdNum, "text-brand")}>{f.rate(d.total.avgRatePaisePerQtl)}</td>
                        <td className={tdNum}>{f.amount(d.total.amountPaise)}</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}
