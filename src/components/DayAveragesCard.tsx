import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { api } from "@/lib/api.ts";
import { useI18n } from "@/lib/i18n.tsx";
import { useFormat } from "@/lib/format.tsx";
import { Card, CardHeader, Badge, Button, Input, Select } from "@/components/ui/index.tsx";
import { SkeletonTable } from "@/components/Skeletons.tsx";
import { OwnFirm } from "@/components/OwnFirm.tsx";
import { cn, todayISO } from "@/lib/utils.ts";
import { dmy, shiftDay } from "@server/lib/parchaLabels.ts";
import { dayRateLink } from "@/lib/dailyList.ts";

/** "Sunday" / "रविवार", from the browser itself. */
const weekday = (iso: string, lang: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString(lang === "hi" ? "hi-IN" : "en-IN", { weekday: "long" });

/* The day's rate at the top of the dashboard: one day at a time, starting on
   today, with a line for each mill and commodity — a mill that took two
   commodities that day has two lines. The arrows step to yesterday and
   tomorrow. The rate is Σ(net × rate) / Σ net over the slips that carry a rate,
   the same figure the parcha and the mill report print, so the three agree.
   A line whose slips have no rate yet has no rate to show: it is left out and
   counted at the foot instead. Net is the priced net, so net × average is the
   amount on the same line; weight still without a rate is shown apart. */

interface Line {
  millId: string | null; millCode: string | null; millName: string | null; millNameHi: string | null;
  jinsId: string; jinsCode: string; jinsName: string; jinsNameHi: string | null;
  slips: number; bags: number; grossGrams: number; netGrams: number;
  amountPaise: number; payablePaise: number; avgRatePaisePerQtl: number; waiting: number;
  /** Net of this line's slips with no rate yet: in none of net, average or amount. */
  unpricedNetGrams?: number;
}
interface Day {
  date: string;
  lines: Line[];
  total: { slips: number; bags: number; grossGrams: number; netGrams: number; amountPaise: number; payablePaise: number; avgRatePaisePerQtl: number } | null;
  waiting: number;
  unpricedNetGrams?: number;
}

export function DayAveragesCard() {
  const { t, pick, lang } = useI18n();
  const f = useFormat();
  /** One day, today to begin with; the arrows and the box move it. */
  const [day, setDay] = useState(todayISO());
  /** "all" counts what the firm bought itself; "added" is the mills alone. */
  const [mills, setMills] = useState<"all" | "added">("all");
  const query = new URLSearchParams({ from: day, to: day, days: "1", mills }).toString();
  const q = useQuery({
    queryKey: ["dashboard", "day-averages", query],
    queryFn: () => api.get<{ days: Day[] }>(`/dashboard/day-averages?${query}`),
  });

  const waiting = q.data?.days?.[0]?.waiting ?? 0;
  const picker = (
    <div className="flex flex-wrap items-center gap-1 border-b border-line px-3 py-2">
      <span className="mr-1 text-[12px] text-faint">{weekday(day, lang)}</span>
      <Button size="sm" variant="ghost" icon={<ChevronLeft className="h-3.5 w-3.5" />}
        onClick={() => setDay(shiftDay(day, -1))} aria-label={t("daily.prevDay")} title={t("daily.prevDay")} />
      <Input type="date" value={day} onChange={(e) => setDay(e.target.value || todayISO())}
        className="h-8 w-36 text-[13px]" aria-label={t("dash.dayPick")} title={t("dash.dayPick")} />
      <Button size="sm" variant="ghost" icon={<ChevronRight className="h-3.5 w-3.5" />}
        onClick={() => setDay(shiftDay(day, 1))} aria-label={t("daily.nextDay")} title={t("daily.nextDay")} />
      {day !== todayISO() && (
        <Button size="sm" variant="ghost" onClick={() => setDay(todayISO())}
          title={t("dash.dayToday")}>{t("dash.dayToday")}</Button>
      )}
      {waiting > 0 && <Badge tone="warn">{t("dash.dayWaiting", { n: waiting })}</Badge>}
      <Select value={mills} onChange={(e) => setMills(e.target.value as "all" | "added")}
        className="h-8 w-36 text-[13px]" title={t("dash.millsHint")} aria-label={t("daily.mill")}>
        <option value="all">{t("daily.allMills")}</option>
        <option value="added">{t("dash.millsAdded")}</option>
      </Select>
    </div>
  );

  // nothing to show yet, or the figures are not in: the card stays away
  if (q.isLoading) return <Card className="mb-5"><SkeletonTable rows={3} /></Card>;
  const days = q.data?.days ?? [];

  const th = "px-2 py-1.5 text-left text-[11px] font-medium uppercase tracking-wide text-muted";
  const thNum = cn(th, "text-right");
  const td = "whitespace-nowrap px-2 py-1.5 text-[13px]";
  const tdNum = cn(td, "num text-right");

  return (
    <Card className="mb-5">
      <CardHeader title={t("dash.dayRate")} sub={t("dash.dayRateSub")} />
      {picker}
      <div className="space-y-4 p-3">
        {!days.length && (
          <p className="px-1 text-[13px] text-faint">{t("dash.dayEmpty", { date: dmy(day) })}</p>
        )}
        {days.map((d) => (
          <div key={d.date}>
            {d.lines.length === 0 ? (
              <p className="px-2 text-[12px] text-faint">{t("dash.dayNoRate")}</p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-line">
                <table className="min-w-full">
                  <thead className="bg-raised/60">
                    <tr>
                      <th className={th}>{t("load.mill")}</th>
                      <th className={th}>{t("daily.jins")}</th>
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
                            ? <Link href={dayRateLink(d.date, l)} className="inline-flex items-center gap-1.5 hover:underline">
                                <Badge tone="neutral" className="num">{l.millCode}</Badge>
                                <span className="text-muted">{pick(l.millName ?? "", l.millNameHi ?? "")}</span>
                              </Link>
                            : <OwnFirm withName />}
                        </td>
                        <td className={td}><span className="num">{l.jinsCode}</span></td>
                        <td className={tdNum}>
                          {f.weight(l.netGrams)}
                          {(l.unpricedNetGrams ?? 0) > 0 && (
                            <span className="block text-[11px] font-normal text-warn">{t("dash.dayUnpricedLine", { q: f.weight(l.unpricedNetGrams ?? 0) })}</span>
                          )}
                        </td>
                        <td className={cn(tdNum, "font-semibold text-brand")}>{f.rate(l.avgRatePaisePerQtl)}</td>
                        <td className={tdNum}>{f.amount(l.amountPaise)}</td>
                      </tr>
                    ))}
                    {d.total && d.lines.length > 1 && (
                      <tr className="border-t-2 border-line bg-raised/40 font-semibold">
                        <td className={td} colSpan={2}>{t("dash.dayAll")}</td>
                        <td className={tdNum}>{f.weight(d.total.netGrams)}</td>
                        <td className={cn(tdNum, "text-brand")}>{f.rate(d.total.avgRatePaisePerQtl)}</td>
                        <td className={tdNum}>{f.amount(d.total.amountPaise)}</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
            {(d.unpricedNetGrams ?? 0) > 0 && (
              <p className="mt-1.5 px-2 text-[12px] text-warn">{t("dash.dayUnpricedNote", { q: f.weight(d.unpricedNetGrams ?? 0), n: d.waiting })}</p>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}
