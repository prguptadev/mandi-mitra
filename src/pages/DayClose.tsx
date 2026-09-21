import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Lock, LockOpen, CalendarCheck } from "lucide-react";
import { api } from "@/lib/api.ts";
import { useI18n } from "@/lib/i18n.tsx";
import { useFormat } from "@/lib/format.tsx";
import { useSession } from "@/lib/session.tsx";
import { useFYRange } from "@/lib/fy.tsx";
import { useDayActions, type DayRow } from "@/lib/dayClose.tsx";
import { PageHeader } from "@/components/AppShell.tsx";
import { LoadError } from "@/components/LoadError.tsx";
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input, Spinner, Table, Td, Th, Tr } from "@/components/ui/index.tsx";
import { dmy, todayISO, weekday } from "@/lib/utils.ts";

/* Day close: every day with work on it, what it came to, whether it is in
   Tally, and whether it is closed. A closed day cannot be changed by anyone
   until it is reopened (with a reason), so the books agreed at the end of a
   day stay as they were. */

interface DaysResp { days: DayRow[]; emptyClosed: number; lastClosed: string | null; first: string | null; today: string }
type T4 = { new: number; sent: number; changed: number; unpriced: number };
interface TallyDay { day: string; all: T4 }
const KINDS = ["slip", "payment", "parcha", "receipt", "cut"];

const yesterday = () => { const d = new Date(); d.setDate(d.getDate() - 1); return d.toLocaleDateString("en-CA"); };

export function DayClosePage() {
  const { t, lang } = useI18n();
  const f = useFormat();
  const { can } = useSession();
  const { from, setFrom, to, setTo, fy } = useFYRange();
  const q = useQuery({ queryKey: ["days", "list", from, to], queryFn: () => api.get<DaysResp>(`/days?from=${from}&to=${to}`), enabled: Boolean(from && to && from <= to) });
  const canTally = can("export.data") && can("ledger.read") && can("millledger.read");
  const tq = useQuery({
    queryKey: ["tally", "days", from, to, "all"],
    queryFn: () => api.post<{ days: TallyDay[] }>("/tally/days", { from, to, kinds: KINDS }),
    enabled: canTally && Boolean(from && to && from <= to),
  });
  const tallyOf = useMemo(() => new Map((tq.data?.days ?? []).map((d) => [d.day, d.all])), [tq.data]);
  const act = useDayActions();
  const [upto, setUpto] = useState(yesterday);
  const today = todayISO();

  const rows = q.data?.days ?? [];
  const openBefore = rows.filter((r) => !r.closed && r.day <= upto).length;
  const openOld = rows.filter((r) => !r.closed && r.day < today).length;
  const sum = (k: keyof DayRow) => rows.reduce((s, r) => s + (r[k] as number), 0);

  return (
    <div>
      <PageHeader title={t("dc.title")} sub={t("dc.sub")} />
      {act.dialog}

      <div className="mb-5 grid gap-4 lg:grid-cols-3">
        <Card>
          <div className="p-4">
            <p className="text-[12px] font-medium uppercase tracking-wide text-muted">{t("dc.lastClosed")}</p>
            <p className="num mt-1 text-2xl font-semibold text-ink">{q.data?.lastClosed ? dmy(q.data.lastClosed) : "—"}</p>
            <p className="mt-1 text-[12px] text-muted">{t("dc.lastClosedSub")}</p>
          </div>
        </Card>
        <Card>
          <div className="p-4">
            <p className="text-[12px] font-medium uppercase tracking-wide text-muted">{t("dc.openOld")}</p>
            <p className={"num mt-1 text-2xl font-semibold " + (openOld ? "text-warn" : "text-ok")}>{openOld}</p>
            <p className="mt-1 text-[12px] text-muted">{t("dc.openOldSub", { y: fy.label })}</p>
          </div>
        </Card>
        {can("day.close") && (
          <Card>
            <div className="space-y-2 p-4">
              <p className="text-[12px] font-medium uppercase tracking-wide text-muted">{t("dc.upto")}</p>
              <div className="flex flex-wrap items-end gap-2">
                <Input type="date" value={upto} max={today} onChange={(e) => setUpto(e.target.value)} className="h-9 w-40" />
                <Button variant="primary" icon={<Lock className="h-4 w-4" />} loading={act.busy} disabled={!upto || upto > today}
                  onClick={() => void act.closeUpTo(upto, openBefore)}>
                  {t("dc.uptoBtn")}
                </Button>
              </div>
              <p className="text-[12px] text-muted">{t("dc.uptoHint")}</p>
            </div>
          </Card>
        )}
      </div>

      <Card>
        <CardHeader title={t("dc.listTitle")} sub={q.data?.emptyClosed ? t("dc.emptyClosed", { n: q.data.emptyClosed }) : t("dc.listSub")}
          action={
            <div className="flex flex-wrap items-end gap-2">
              <Field label={t("common.from")}><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8 w-36" /></Field>
              <Field label={t("common.to")}><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-8 w-36" /></Field>
            </div>
          } />
        {q.isError ? <LoadError error={q.error} onRetry={() => q.refetch()} /> : q.isLoading ? (
          <div className="flex justify-center p-10"><Spinner /></div>
        ) : !rows.length ? (
          <EmptyState icon={<CalendarCheck className="h-8 w-8" />} title={t("dc.none")} />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>{t("dc.day")}</Th>
                <Th numeric>{t("dc.slips")}</Th>
                <Th numeric>{t("dc.weight")}</Th>
                <Th numeric>{t("dc.payable")}</Th>
                <Th numeric>{t("dc.paid")}</Th>
                <Th numeric>{t("dc.billed")}</Th>
                <Th numeric>{t("dc.received")}</Th>
                <Th>{t("dc.look")}</Th>
                {canTally && <Th>{t("dc.tally")}</Th>}
                <Th>{t("dc.status")}</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const tl = tallyOf.get(r.day);
                const warn = act.warningsOf(r);
                return (
                  <Tr key={r.day}>
                    <Td className="whitespace-nowrap">
                      <Link href={`/daily?date=${r.day}`} className="num font-medium text-ink hover:text-brand hover:underline">{dmy(r.day)}</Link>
                      <span className="ml-1.5 text-[11px] text-faint">{weekday(r.day, lang)}</span>
                    </Td>
                    <Td numeric>{r.slips || "—"}</Td>
                    <Td numeric>{r.netGrams ? f.weight(r.netGrams) : "—"}</Td>
                    <Td numeric>{r.payablePaise ? f.money(r.payablePaise) : "—"}</Td>
                    <Td numeric>{r.paidPaise ? f.money(r.paidPaise) : "—"}</Td>
                    <Td numeric>{r.billedPaise ? f.money(r.billedPaise) : "—"}</Td>
                    <Td numeric>{r.receivedPaise ? f.money(r.receivedPaise) : "—"}</Td>
                    <Td>
                      <div className="flex flex-wrap gap-1">
                        {r.unpriced > 0 && <Badge tone="warn">{t("dc.bUnpriced", { n: r.unpriced })}</Badge>}
                        {r.scansPending > 0 && <Badge tone="warn">{t("dc.bScans", { n: r.scansPending })}</Badge>}
                        {r.draftTrucks > 0 && <Badge>{t("dc.bDrafts", { n: r.draftTrucks })}</Badge>}
                        {!warn.length && <span className="text-faint">—</span>}
                      </div>
                    </Td>
                    {canTally && <Td><TallyBadge s={tl} day={r.day} /></Td>}
                    <Td className="whitespace-nowrap">
                      {r.closed ? (
                        <span className="inline-flex flex-wrap items-center gap-1">
                          <Badge tone="ok" title={t("dc.closedBy", { by: r.closed.by ?? "—", at: new Date(r.closed.at * 1000).toLocaleString(lang === "hi" ? "hi-IN" : "en-IN") })}>
                            <Lock className="h-3 w-3" />{t("dc.closed")}
                          </Badge>
                          {r.closed.changed && <Badge tone="bad" title={t("dc.changedAfterSub")}>{t("dc.changedAfter")}</Badge>}
                        </span>
                      ) : <Badge><LockOpen className="h-3 w-3" />{t("dc.open")}</Badge>}
                    </Td>
                    <Td align="right">
                      {r.closed
                        ? can("day.reopen") && <Button size="sm" variant="ghost" onClick={() => act.reopen(r.day)}>{t("dc.reopenBtn")}</Button>
                        : can("day.close") && r.day <= today && <Button size="sm" variant="secondary" icon={<Lock className="h-3.5 w-3.5" />} loading={act.busy} onClick={() => void act.close(r)}>{t("dc.closeBtn")}</Button>}
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="bg-raised/60 font-semibold">
                <Td>{t("dc.total", { n: rows.length })}</Td>
                <Td numeric>{sum("slips")}</Td>
                <Td numeric>{f.weight(sum("netGrams"))}</Td>
                <Td numeric>{f.money(sum("payablePaise"))}</Td>
                <Td numeric>{f.money(sum("paidPaise"))}</Td>
                <Td numeric>{f.money(sum("billedPaise"))}</Td>
                <Td numeric>{f.money(sum("receivedPaise"))}</Td>
                <Td colSpan={canTally ? 4 : 3} />
              </tr>
            </tfoot>
          </Table>
        )}
      </Card>
    </div>
  );
}

/** Where a day stands in Tally: all in, some to send, or changed since sending. */
export function TallyBadge({ s, day }: { s: T4 | undefined; day?: string }) {
  const { t } = useI18n();
  if (!s || s.new + s.sent + s.changed === 0) return <span className="text-faint">—</span>;
  const b = s.changed ? <Badge tone="bad">{t("tally.bChanged", { n: s.changed })}</Badge>
    : s.new ? <Badge tone="brand">{t("tally.bNew", { n: s.new })}</Badge>
    : <Badge tone="ok">{t("tally.bAllIn")}</Badge>;
  return day ? <Link href={`/tally?day=${day}`} className="hover:opacity-80">{b}</Link> : b;
}
