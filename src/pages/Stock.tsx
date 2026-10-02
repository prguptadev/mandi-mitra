import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Boxes, Truck, FileSpreadsheet, ChevronRight, ArrowLeft, PackageOpen, Warehouse, Landmark } from "lucide-react";
import { useSort } from "@/lib/useSort.ts";
import { useRowWindow, RowSpacer } from "@/lib/useRowWindow.tsx";
import { ReceiptDialog, type MillLedgerList } from "@/pages/MillMoney.tsx";
import { api, ApiError, type Jins, type StockRow, type StockMillDay } from "@/lib/api.ts";
import { useI18n } from "@/lib/i18n.tsx";
import { useSession } from "@/lib/session.tsx";
import { useFormat } from "@/lib/format.tsx";
import { usePrefs, MILL_REPORT_COLUMNS } from "@/lib/prefs.tsx";
import { PageHeader } from "@/components/AppShell.tsx";
import { SkeletonTable, SkeletonStats } from "@/components/Skeletons.tsx";
import { downloadDara } from "@/components/DownloadDialog.tsx";
import { RaceChart, type RacePoint } from "@/components/RaceChart.tsx";
import { Button, Card, CardHeader, DateList, Field, Input, Select, Table, Th, Td, Tr, Badge, EmptyState, Alert } from "@/components/ui/index.tsx";
import { OwnFirm } from "@/components/OwnFirm.tsx";
import { NewLoadDialog } from "@/pages/Loads.tsx";
import { LoadError } from "@/components/LoadError.tsx";
import { cn, todayISO } from "@/lib/utils.ts";
import { millNow, millsNow, stockRange } from "@/lib/asOfToday.ts";
import { stockDayLink } from "@/lib/dailyList.ts";
import { dmy } from "@server/lib/parchaLabels.ts";

/* Stock per mill = what was bought for it − what trucks took from it. Every
   figure is a sum of slips and truck rows, so the pages are their own proof:
   the list adds up down its columns, and each mill's page shows the race
   between received and loaded, every truck with its price, and each day's
   purchases with the trucks that took from them. Negative is allowed. */

function useStockFilters() {
  // "" = every commodity, so no mill is hidden behind a filter
  const [jinsId, setJinsId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const jins = useQuery({ queryKey: ["jins"], queryFn: () => api.get<Jins[]>("/jins") });
  const qs = stockRange({ jinsId, from, to });
  return { jins, jinsId, setJinsId, from, setFrom, to, setTo, qs };
}

function Filters({ s }: { s: ReturnType<typeof useStockFilters> }) {
  const { t, pick } = useI18n();
  return (
    <div className="flex flex-wrap items-end gap-3 border-b border-line p-3">
      <Field label={t("load.jins")} className="w-52">
        <Select value={s.jinsId} onChange={(e) => s.setJinsId(e.target.value)} className="h-8 text-[13px]">
          <option value="">{t("daily.allJins")}</option>
          {s.jins.data?.map((j) => <option key={j.id} value={j.id}>{j.code} — {pick(j.name, j.nameHi)}</option>)}
        </Select>
      </Field>
      <Field label={t("load.from")} className="w-40">
        <Input type="date" value={s.from} onChange={(e) => s.setFrom(e.target.value)} className="h-8 text-[13px]" />
      </Field>
      <Field label={t("load.to")} className="w-40">
        <Input type="date" value={s.to} onChange={(e) => s.setTo(e.target.value)} className="h-8 text-[13px]" />
      </Field>
      <p className="pb-1.5 text-[12px] text-faint">{s.from || s.to ? t("stock.rangeNoteEnd") : t("stock.allTime")}</p>
    </div>
  );
}

/* ------------------------------------------------------------ all mills */

export function StockPage() {
  const { t, pick } = useI18n();
  const f = useFormat();
  const [, navigate] = useLocation();
  const s = useStockFilters();
  const { can } = useSession();
  const list = useQuery({ queryKey: ["stock", "all", s.qs.toString()], queryFn: () => api.get<StockRow[]>(`/stock?${s.qs}`) });
  // what each mill owes us today, for its card — only for those who may see money
  const money = useQuery({ queryKey: ["mill-ledger", "all", todayISO()], queryFn: () => api.get<MillLedgerList>(millsNow()), enabled: can("millledger.read") });
  const owed = new Map((money.data?.rows ?? []).map((r) => [r.id, r]));
  const rows = list.data ?? [];
  const sort = useSort(rows, {
    mill: (r) => r.millCode, slips: (r) => r.slips, bought: (r) => r.boughtNet, avg: (r) => r.avgRatePaisePerQtl,
    loaded: (r) => r.loadedNet, trucks: (r) => r.trucks, left: (r) => r.stockNet,
  }, { storageKey: "stock" });
  // slips with no mill are in no mill's stock: shown as their own row, left out of the total
  const milled = rows.filter((r) => r.merchantId);
  const total = {
    opening: milled.reduce((x, r) => x + r.openingNet, 0),
    bought: milled.reduce((x, r) => x + r.boughtNet, 0),
    loaded: milled.reduce((x, r) => x + r.loadedNet, 0),
    left: milled.reduce((x, r) => x + r.stockNet, 0),
  };
  // with a from date the stock already in hand that morning is a column of its own, so each row re-adds
  const withOpening = Boolean(s.from);

  return (
    <div>
      <PageHeader title={t("stock.title")} sub={t("stock.sub")} />
      <Card className="mb-4"><Filters s={s} /></Card>
      {milled.length > 0 && (
        <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {milled.map((r) => {
            const m = owed.get(r.merchantId!);
            const pct = r.boughtNet > 0 ? Math.min(100, Math.max(0, (r.loadedNet / r.boughtNet) * 100)) : r.loadedNet > 0 ? 100 : 0;
            return (
              <Link key={r.merchantId} href={`/stock/${r.merchantId}`}
                className="block rounded-xl border border-line bg-surface p-4 shadow-card transition-colors hover:border-brand/60">
                <div className="mb-3 flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-2"><Badge tone="brand" className="num">{r.millCode}</Badge>
                    <span className="truncate text-[14px] font-medium text-ink">{pick(r.millName, r.millNameHi)}</span></span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-faint" />
                </div>
                <div className="grid grid-cols-3 gap-2 text-[12px]">
                  <div><p className="text-faint">{t("dash.received")}</p><p className="num text-[15px] font-semibold">{f.weight(r.boughtNet)}</p><p className="text-faint">{r.slips} {t("ledger.slips")}</p></div>
                  <div><p className="text-faint">{t("dash.loaded")}</p><p className="num text-[15px] font-semibold">{f.weight(r.loadedNet)}</p><p className="text-faint">{r.trucks} {t("stock.trucks")}</p></div>
                  <div><p className="text-faint">{t("dash.left")}</p><p className={cn("num text-[15px] font-semibold", r.stockNet < 0 && "text-bad")}>{f.weight(r.stockNet)}</p><p className="text-faint">{withOpening ? `${t("stock.atStart")} ${f.weight(r.openingNet)}` : f.unit}</p></div>
                </div>
                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-raised" title={t("stock.loadedShare", { p: Math.round(pct) })}>
                  <div className={cn("h-full rounded-full", r.stockNet < 0 ? "bg-bad" : "bg-brand")} style={{ width: `${pct}%` }} />
                </div>
                {m && (
                  <div className="mt-3 grid grid-cols-3 gap-2 border-t border-line pt-2.5 text-[12px]">
                    <div><p className="text-faint">{t("mm.billed")}</p><p className="num">{f.money(m.billedPaise)}</p></div>
                    <div><p className="text-faint">{t("mm.received")}</p><p className="num text-ok">{f.money(m.receivedPaise)}</p></div>
                    <div><p className="text-faint">{t("mm.owes")}</p><p className={cn("num font-semibold", m.balancePaise < 0 ? "text-warn" : "text-brand")}>{f.money(m.balancePaise)}</p></div>
                    {(m.openingBalancePaise !== 0 || m.shortagePaise !== 0 || m.deductedPaise !== 0) && (
                      <p className="col-span-3 text-[11px] text-faint">{t("mm.owesAlso", { o: f.money(m.openingBalancePaise), c: f.money(m.shortagePaise), h: f.money(m.deductedPaise) })}</p>
                    )}
                  </div>
                )}
              </Link>
            );
          })}
        </div>
      )}
      <Card>
        {list.isPending ? <SkeletonTable rows={4} /> : list.isError ? <LoadError error={list.error} onRetry={() => void list.refetch()} /> : !rows.length ? (
          <EmptyState icon={<Boxes className="h-5 w-5" />} title={t("stock.empty")} sub={t("stock.emptySub")} />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th {...sort.th("mill")}>{t("load.mill")}</Th>
                {withOpening && <Th numeric>{t("stock.atStart")}</Th>}
                <Th numeric {...sort.th("slips")}>{t("load.slips")}</Th>
                <Th numeric {...sort.th("bought")}>{t("stock.bought")}</Th><Th numeric {...sort.th("avg")}>{t("stock.avgRate")}</Th>
                <Th numeric {...sort.th("loaded")}>{t("stock.onTrucks")}</Th><Th numeric {...sort.th("trucks")}>{t("stock.trucks")}</Th>
                <Th numeric {...sort.th("left")}>{t("stock.left")}</Th><Th className="w-8" />
              </tr>
            </thead>
            <tbody>
              {sort.sorted.map((r) => {
                const key = r.merchantId ?? "none";
                return (
                  <Tr key={key} onClick={() => navigate(`/stock/${key}`)}>
                    <Td className="whitespace-nowrap">
                      {r.millCode ? <><Badge tone="brand" className="num">{r.millCode}</Badge> <span className="text-muted">{pick(r.millName, r.millNameHi)}</span></>
                        : <OwnFirm withName />}
                    </Td>
                    {withOpening && <Td numeric className="text-muted">{f.weight(r.openingNet)}</Td>}
                    <Td numeric>{r.slips}</Td>
                    <Td numeric>{f.weight(r.boughtNet)}</Td>
                    <Td numeric>{r.avgRatePaisePerQtl ? f.rate(r.avgRatePaisePerQtl) : "—"}</Td>
                    <Td numeric>{f.weight(r.loadedNet)}</Td>
                    <Td numeric>{r.trucks}</Td>
                    <Td numeric className={cn("font-semibold", r.stockNet < 0 && "text-bad")}>{f.weight(r.stockNet)}</Td>
                    <Td><ChevronRight className="h-4 w-4 text-faint" /></Td>
                  </Tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="bg-raised/50 text-[13px] font-semibold">
                <td className="px-2 py-2">{t("load.total")}</td>
                {withOpening && <td className="num px-2 py-2 text-right">{f.weight(total.opening)}</td>}
                <td />
                <td className="num px-2 py-2 text-right">{f.weight(total.bought)}</td>
                <td />
                <td className="num px-2 py-2 text-right">{f.weight(total.loaded)}</td>
                <td />
                <td className={cn("num px-2 py-2 text-right", total.left < 0 && "text-bad")}>{f.weight(total.left)}</td>
                <td />
              </tr>
            </tfoot>
          </Table>
        )}
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------ one mill */

interface TruckRow {
  loadId: string; loadDate: string; truckNo: string | null; status: string;
  millNetGrams: number | null; weightGrams: number; goodsPaise: number; ratePaisePerQtl: number;
  stockDates: string[]; parchaNo: string | null; grandTotalPaise: number | null; mismatch: boolean; incomplete: boolean;
}
interface MillAccount {
  mill: { id: string; code: string; name: string; nameHi: string | null; city: string | null };
  summary: {
    openingGrams: number; slips: number; boughtNetGrams: number; boughtGrossGrams: number; boughtAmountPaise: number;
    avgBuyPaisePerQtl: number; unpriced: number; loadedGrams: number; goodsPaise: number; avgSalePaisePerQtl: number;
    billedPaise: number; trucks: number; drafts: number; leftGrams: number;
  };
  series: RacePoint[];
  worstAhead: { date: string; grams: number } | null;
  trucks: TruckRow[];
}

export function MillAccountPage({ id }: { id: string }) {
  const { t, pick } = useI18n();
  const f = useFormat();
  const { can } = useSession();
  const { prefs } = usePrefs();
  const s = useStockFilters();
  const [truckFrom, setTruckFrom] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // the received-against-loaded graph starts folded; one click opens it
  const [showRace, setShowRace] = useState(false);
  const isNone = id === "none";

  const acct = useQuery({
    queryKey: ["mill-account", id, s.qs.toString()],
    queryFn: () => api.get<MillAccount>(`/dashboard/mill/${id}?${s.qs}`),
    enabled: !isNone,
  });
  // what the mill owes today, as the mills list shows it
  const money = useQuery({
    queryKey: ["mill-ledger", id, "card", todayISO()],
    queryFn: () => api.get<{ mill: { openingBalancePaise: number }; totals: { billedPaise: number; shortagePaise: number; receivedPaise: number; deductedPaise: number; closingPaise: number } }>(millNow(id)),
    enabled: !isNone && can("millledger.read"),
  });
  const [receiving, setReceiving] = useState(false);
  const days = useQuery({
    queryKey: ["stock", id, s.qs.toString()],
    queryFn: () => api.get<{ days: StockMillDay[]; totals: { slips: number; boughtNet: number; loadedNet: number; stockNet: number; openingNet: number; closingNet: number } }>(`/stock/${id}?${s.qs}`),
  });

  const dara = async (date: string) => {
    setErr(null);
    try {
      await downloadDara({
        merchantId: id, from: date, to: date, jinsId: s.jinsId, names: prefs.dailyList.exportNameLang, sort: prefs.dailyList.sortOrder,
        format: "xlsx", columns: MILL_REPORT_COLUMNS.filter((c) => prefs.dailyList.millReportColumns[c.key]).map((c) => c.key),
      });
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : t("common.somethingWrong"));
    }
  };

  const a = acct.data;
  const sm = a?.summary;
  const truckSort = useSort(a?.trucks ?? [], {
    date: (x) => x.loadDate, truck: (x) => x.truckNo, from: (x) => x.stockDates[0], loaded: (x) => x.weightGrams,
    rate: (x) => x.ratePaisePerQtl, goods: (x) => x.goodsPaise, parcha: (x) => x.parchaNo, total: (x) => x.grandTotalPaise,
  }, { storageKey: "mill-trucks" });
  const daySort = useSort(days.data?.days ?? [], {
    date: (d) => d.date, slips: (d) => d.slips, bought: (d) => d.boughtNet, avg: (d) => d.avgRatePaisePerQtl,
    loaded: (d) => d.loadedNet, left: (d) => d.stockNet, running: (d) => d.runningNet,
  }, { storageKey: "mill-days" });
  const truckWin = useRowWindow(truckSort.sorted);
  const dayWin = useRowWindow(daySort.sorted);
  const trucksTotal = a ? {
    weight: a.trucks.reduce((x, r) => x + r.weightGrams, 0),
    goods: a.trucks.reduce((x, r) => x + r.goodsPaise, 0),
    billed: a.trucks.reduce((x, r) => x + (r.grandTotalPaise ?? 0), 0),
  } : null;

  return (
    <div>
      <div className="mb-2">
        <Link href="/stock" className="inline-flex items-center gap-1 text-[13px] text-muted hover:text-ink">
          <ArrowLeft className="h-3.5 w-3.5" />{t("stock.allMills")}
        </Link>
      </div>
      <PageHeader
        title={isNone ? <OwnFirm withName /> : a ? <span className="flex items-center gap-2"><Badge tone="brand" className="num">{a.mill.code}</Badge>{pick(a.mill.name, a.mill.nameHi)}</span> : "…"}
        sub={isNone ? t("stock.noMillHelp") : t("stock.millSub")}
        action={!isNone && (
          <div className="flex flex-wrap gap-2">
            {can("millledger.read") && <Link href={`/mill-accounts/${id}`}><Button icon={<Landmark className="h-4 w-4" />}>{t("mm.title")}</Button></Link>}
            {can("load.write") && <Button variant="primary" icon={<Truck className="h-4 w-4" />} onClick={() => setTruckFrom("")}>{t("load.new")}</Button>}
          </div>
        )} />
      {err && <Alert tone="bad" className="mb-3">{err}</Alert>}

      <Card className="mb-5"><Filters s={s} /></Card>

      {!isNone && acct.isError && <Card className="mb-5"><LoadError error={acct.error} onRetry={() => void acct.refetch()} /></Card>}
      {!isNone && !acct.isError && (!a || !sm ? <SkeletonStats /> : (
        <>
          <div className={cn("grid gap-3 sm:grid-cols-3", money.data && "xl:grid-cols-4")}>
            <div className="rounded-xl border border-line bg-surface p-4 shadow-card">
              <p className="mb-1 flex items-center gap-2 text-[12px] font-medium uppercase tracking-wide text-muted"><PackageOpen className="h-4 w-4 text-brand" />{t("dash.received")}</p>
              <p className="num text-2xl font-semibold">{f.weight(sm.boughtNetGrams)} <span className="text-[13px] font-normal text-muted">{f.unit}</span></p>
              <p className="text-[12px] text-muted">{sm.slips} {t("ledger.slips")} · {f.money(sm.boughtAmountPaise)}</p>
              <p className="text-[12px] text-muted">{t("dash.avgBuy", { r: sm.avgBuyPaisePerQtl ? f.rate(sm.avgBuyPaisePerQtl) : "—" })}{sm.unpriced ? ` · ${t("stock.unpriced", { n: sm.unpriced })}` : ""}</p>
            </div>
            <div className="rounded-xl border border-line bg-surface p-4 shadow-card">
              <p className="mb-1 flex items-center gap-2 text-[12px] font-medium uppercase tracking-wide text-muted"><Truck className="h-4 w-4 text-brand" />{t("dash.loaded")}</p>
              <p className="num text-2xl font-semibold">{f.weight(sm.loadedGrams)} <span className="text-[13px] font-normal text-muted">{f.unit}</span></p>
              <p className="text-[12px] text-muted">{sm.trucks} {t("stock.trucks")}{sm.drafts ? ` · ${sm.drafts} ${t("dash.withoutParcha")}` : ""}</p>
              <p className="text-[12px] text-muted">{t("dash.avgSale", { r: sm.avgSalePaisePerQtl ? f.rate(sm.avgSalePaisePerQtl) : "—" })} · {t("dash.billed", { amt: f.money(sm.billedPaise) })}</p>
            </div>
            <div className={cn("rounded-xl border bg-surface p-4 shadow-card", sm.leftGrams < 0 ? "border-bad/50" : "border-line")}>
              <p className="mb-1 flex items-center gap-2 text-[12px] font-medium uppercase tracking-wide text-muted"><Warehouse className={cn("h-4 w-4", sm.leftGrams < 0 ? "text-bad" : "text-brand")} />{t("dash.left")}</p>
              <p className={cn("num text-2xl font-semibold", sm.leftGrams < 0 && "text-bad")}>{f.weight(sm.leftGrams)} <span className="text-[13px] font-normal text-muted">{f.unit}</span></p>
              <p className="text-[12px] text-muted">
                {sm.openingGrams ? `${f.weight(sm.openingGrams)} + ` : ""}{f.weight(sm.boughtNetGrams)} − {f.weight(sm.loadedGrams)} = <b>{f.weight(sm.leftGrams)}</b>
              </p>
              {sm.leftGrams < 0 && <p className="text-[12px] font-medium text-bad">{t("stock.loadedMoreHelp", { q: f.weight(-sm.leftGrams) })}</p>}
            </div>
            {money.data && (
              <div className="rounded-xl border border-line bg-surface p-4 shadow-card">
                <p className="mb-1 flex items-center gap-2 text-[12px] font-medium uppercase tracking-wide text-muted"><Landmark className="h-4 w-4 text-brand" />{t("mm.owes")}</p>
                <p className={cn("num text-2xl font-semibold", money.data.totals.closingPaise < 0 ? "text-warn" : "text-brand")}>{f.money(money.data.totals.closingPaise)}</p>
                <p className="text-[12px] text-muted">
                  {money.data.mill.openingBalancePaise ? `${t("mm.openingShort")} ${f.money(money.data.mill.openingBalancePaise)} + ` : ""}
                  {t("mm.billed")} {f.money(money.data.totals.billedPaise)}
                  {money.data.totals.shortagePaise ? ` − ${t("mm.cutShort")} ${f.money(money.data.totals.shortagePaise)}` : ""}
                  {` − ${t("mm.received")} ${f.money(money.data.totals.receivedPaise)}`}
                  {money.data.totals.deductedPaise ? ` − ${t("mm.heldShort")} ${f.money(money.data.totals.deductedPaise)}` : ""}
                </p>
                <p className="text-[11px] text-faint">{t("mm.allTimeNote")}</p>
                {can("millreceipt.write") && <Button size="sm" variant="secondary" className="mt-2" onClick={() => setReceiving(true)}>{t("mm.receive")}</Button>}
              </div>
            )}
          </div>

          <Card className="mt-5">
            <CardHeader title={t("stock.race")} sub={showRace ? t("stock.raceSub") : undefined}
              className={cn(!showRace && !a.worstAhead && "border-b-0")}
              action={<Button size="sm" variant="ghost" aria-expanded={showRace} onClick={() => setShowRace((v) => !v)}>{t(showRace ? "stock.raceHide" : "stock.raceShow")}</Button>} />
            {showRace && <div className="px-3 pt-3 pb-2"><RaceChart points={a.series} height={260} /></div>}
            {a.worstAhead && <p className="border-t border-line px-4 py-2 text-[12px] text-bad">{t("dash.worstAhead", { d: dmy(a.worstAhead.date), q: f.weight(a.worstAhead.grams) })}</p>}
          </Card>

          <Card className="mt-5">
            <CardHeader title={t("stock.trucksTitle", { n: a.trucks.length })} sub={t("stock.trucksSub")} />
            {!a.trucks.length || !trucksTotal ? <EmptyState title={t("stock.noTrucks")} /> : (
              <Table>
                <thead>
                  <tr>
                    <Th {...truckSort.th("date")}>{t("load.date")}</Th><Th {...truckSort.th("truck")}>{t("load.truckNo")}</Th>
                    <Th {...truckSort.th("from")}>{t("load.fromDays")}</Th>
                    <Th numeric {...truckSort.th("loaded")}>{t("load.loaded")}</Th><Th numeric {...truckSort.th("rate")}>{t("load.rate")}</Th>
                    <Th numeric {...truckSort.th("goods")}>{t("stock.goodsValue")}</Th>
                    <Th {...truckSort.th("parcha")}>{t("load.parchaNo")}</Th><Th numeric {...truckSort.th("total")}>{t("load.grandTotal")}</Th>
                  </tr>
                </thead>
                <tbody ref={truckWin.bodyRef}>
                  <RowSpacer at="top" height={truckWin.topHeight} cols={8} />
                  {truckWin.rows.map((x) => (
                    <Tr key={x.loadId} className={cn(x.mismatch && "bg-bad-soft/40")}>
                      <Td className="whitespace-nowrap">{dmy(x.loadDate)}</Td>
                      <Td className="font-mono"><Link href={`/loads/${x.loadId}`} className="text-brand hover:underline">{x.truckNo ?? "—"}</Link></Td>
                      <Td className="text-muted">{x.stockDates.length ? <DateList dates={x.stockDates.map(dmy)} /> : "—"}</Td>
                      <Td numeric>{f.weight(x.weightGrams)}</Td>
                      <Td numeric>{x.ratePaisePerQtl ? f.rate(x.ratePaisePerQtl) : "—"}</Td>
                      <Td numeric>{f.amount(x.goodsPaise)}</Td>
                      <Td>
                        {x.parchaNo ? <Badge tone="ok">#{x.parchaNo}</Badge>
                          : <Badge tone={x.incomplete || x.mismatch ? "warn" : "neutral"}>{x.incomplete ? t("stock.truckIncomplete") : x.mismatch ? t("stock.truckMismatch") : t("load.status.draft")}</Badge>}
                      </Td>
                      <Td numeric className="font-medium">{x.grandTotalPaise != null ? f.money(x.grandTotalPaise) : <span className="text-faint">—</span>}</Td>
                    </Tr>
                  ))}
                  <RowSpacer at="bottom" height={truckWin.bottomHeight} cols={8} />
                </tbody>
                <tfoot>
                  <tr className="bg-raised/50 text-[13px] font-semibold">
                    <td className="px-2 py-2" colSpan={3}>{t("load.total")}</td>
                    <td className="num px-2 py-2 text-right">{f.weight(trucksTotal.weight)}</td>
                    <td className="num px-2 py-2 text-right" title={t("stock.avgSaleHelp")}>{trucksTotal.weight ? f.rate(Math.floor((trucksTotal.goods * 100_000) / trucksTotal.weight + 0.5)) : "—"}</td>
                    <td className="num px-2 py-2 text-right">{f.amount(trucksTotal.goods)}</td>
                    <td />
                    <td className="num px-2 py-2 text-right">{f.money(trucksTotal.billed)}</td>
                  </tr>
                </tfoot>
              </Table>
            )}
          </Card>
        </>
      ))}

      <Card className="mt-5">
        <CardHeader title={t("stock.byDay")}
          sub={days.data ? <>
            {t("stock.proofDays", { bought: f.weight(days.data.totals.boughtNet), loaded: f.weight(days.data.totals.loadedNet), left: f.weight(days.data.totals.stockNet) })}
            <span className="block">{t("stock.inHandEnd", { q: f.weight(days.data.totals.closingNet) })}</span>
          </> : undefined} />
        {days.isPending ? <SkeletonTable rows={5} /> : days.isError ? <LoadError error={days.error} onRetry={() => void days.refetch()} /> : !days.data?.days.length ? (
          <EmptyState title={t("stock.noDays")} />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th {...daySort.th("date")}>{t("daily.date")}</Th><Th numeric {...daySort.th("slips")}>{t("load.slips")}</Th>
                <Th numeric {...daySort.th("bought")}>{t("stock.bought")}</Th>
                <Th numeric {...daySort.th("avg")} title={!s.jinsId ? t("stock.pickJinsForDara") : undefined}>{t("stock.dayAvg")}</Th><Th>{t("stock.trucksThatDay")}</Th>
                <Th numeric {...daySort.th("loaded")}>{t("stock.onTrucks")}</Th>
                <Th numeric {...daySort.th("left")} title={t("stock.leftOfDayHint")}>{t("stock.leftOfDay")}</Th><Th numeric {...daySort.th("running")} title={t("stock.runningHint")}>{t("stock.running")}</Th><Th />
              </tr>
            </thead>
            <tbody ref={dayWin.bodyRef}>
              <RowSpacer at="top" height={dayWin.topHeight} cols={9} />
              {dayWin.rows.map((d) => (
                <tr key={d.date} className="border-b border-line/70 align-top">
                  <td className="whitespace-nowrap px-2 py-2"><Link href={stockDayLink(d.date, id, s.jinsId)} className="hover:text-brand">{dmy(d.date)}</Link></td>
                  <td className="num px-2 py-2 text-right">{d.slips}</td>
                  <td className="num px-2 py-2 text-right">{f.weight(d.boughtNet)}</td>
                  <td className="num px-2 py-2 text-right">
                    {!s.jinsId ? <span className="text-faint" title={t("stock.pickJinsForDara")}>—</span> : d.avgRatePaisePerQtl ? f.rate(d.avgRatePaisePerQtl) : "—"}
                    {d.unpriced > 0 && <span className="block text-[10px] text-warn">{t("stock.unpriced", { n: d.unpriced })}</span>}
                  </td>
                  <td className="px-2 py-2">
                    <div className="flex flex-wrap gap-1">
                      {d.trucks.map((x) => (
                        <Link key={x.loadId} href={`/loads/${x.loadId}`}>
                          <Badge tone={x.status === "billed" ? "ok" : "neutral"}>
                            <span className="font-mono">{x.truckNo ?? "—"}</span> · {f.weight(x.grams)}{x.parchaNo ? ` · #${x.parchaNo}` : ""}
                          </Badge>
                        </Link>
                      ))}
                      {!d.trucks.length && <span className="text-faint">—</span>}
                    </div>
                  </td>
                  <td className="num px-2 py-2 text-right">{f.weight(d.loadedNet)}</td>
                  <td className={cn("num px-2 py-2 text-right font-semibold", d.stockNet < 0 && "text-bad")}>{f.weight(d.stockNet)}</td>
                  <td className={cn("num px-2 py-2 text-right text-muted", d.runningNet < 0 && "text-bad")}>{f.weight(d.runningNet)}</td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-right">
                    {!isNone && can("load.write") && (
                      <Button size="sm" variant="ghost" icon={<Truck className="h-3.5 w-3.5" />} title={t("stock.truckFromDay")}
                        onClick={() => setTruckFrom(d.date)} />
                    )}
                    {!isNone && can("export.data") && d.slips > 0 && s.jinsId && (
                      <Button size="sm" variant="ghost" icon={<FileSpreadsheet className="h-3.5 w-3.5" />} title={t("dl.dara")}
                        onClick={() => dara(d.date)} />
                    )}
                  </td>
                </tr>
              ))}
              <RowSpacer at="bottom" height={dayWin.bottomHeight} cols={9} />
            </tbody>
            <tfoot>
              <tr className="bg-raised/50 text-[13px] font-semibold">
                <td className="px-2 py-2">{t("load.total")}</td>
                <td className="num px-2 py-2 text-right">{days.data.totals.slips}</td>
                <td className="num px-2 py-2 text-right">{f.weight(days.data.totals.boughtNet)}</td>
                <td colSpan={2} />
                <td className="num px-2 py-2 text-right">{f.weight(days.data.totals.loadedNet)}</td>
                <td className={cn("num px-2 py-2 text-right", days.data.totals.stockNet < 0 && "text-bad")}>{f.weight(days.data.totals.stockNet)}</td>
                {/* the running column ends at what is in hand on the last day, the card's figure */}
                <td className={cn("num px-2 py-2 text-right text-muted", days.data.totals.closingNet < 0 && "text-bad")} title={t("stock.runningHint")}>{f.weight(days.data.totals.closingNet)}</td>
                <td />
              </tr>
            </tfoot>
          </Table>
        )}
      </Card>

      {truckFrom !== null && !isNone && (
        <NewLoadDialog open onClose={() => setTruckFrom(null)}
          preset={{ merchantId: id, jinsId: s.jinsId || undefined, stockDate: truckFrom || undefined }} />
      )}
      {receiving && <ReceiptDialog onClose={() => setReceiving(false)} merchantId={id} />}
    </div>
  );
}
