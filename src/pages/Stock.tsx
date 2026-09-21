import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Boxes, Truck, FileSpreadsheet, ChevronRight, ArrowLeft, PackageOpen, Warehouse } from "lucide-react";
import { api, ApiError, type Jins, type StockRow, type StockMillDay } from "@/lib/api.ts";
import { useI18n } from "@/lib/i18n.tsx";
import { useSession } from "@/lib/session.tsx";
import { useFormat } from "@/lib/format.tsx";
import { usePrefs, MILL_REPORT_COLUMNS } from "@/lib/prefs.tsx";
import { PageHeader } from "@/components/AppShell.tsx";
import { SkeletonTable, SkeletonStats } from "@/components/Skeletons.tsx";
import { downloadDara } from "@/components/DownloadDialog.tsx";
import { RaceChart, type RacePoint } from "@/components/RaceChart.tsx";
import { Button, Card, CardHeader, Field, Input, Select, Table, Th, Td, Tr, Badge, EmptyState, Alert } from "@/components/ui/index.tsx";
import { NewLoadDialog } from "@/pages/Loads.tsx";
import { cn } from "@/lib/utils.ts";
import { dmy } from "@server/lib/parchaLabels.ts";

/* Stock per mill = what was bought for it − what trucks took from it. Every
   figure is a sum of slips and truck rows, so the pages are their own proof:
   the list adds up down its columns, and each mill's page shows the race
   between received and loaded, every truck with its price, and each day's
   purchases with the trucks that took from them. Negative is allowed. */

function useStockFilters() {
  const [jinsId, setJinsId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const jins = useQuery({ queryKey: ["jins"], queryFn: () => api.get<Jins[]>("/jins") });
  useEffect(() => {
    if (!jinsId && jins.data?.length) setJinsId(jins.data.find((j) => j.code === "1509")?.id ?? jins.data[0].id);
  }, [jins.data]);
  const qs = new URLSearchParams();
  if (jinsId) qs.set("jinsId", jinsId);
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);
  return { jins, jinsId, setJinsId, from, setFrom, to, setTo, qs };
}

function Filters({ s }: { s: ReturnType<typeof useStockFilters> }) {
  const { t, pick } = useI18n();
  return (
    <div className="flex flex-wrap items-end gap-3 border-b border-line p-3">
      <Field label={t("load.jins")} className="w-52">
        <Select value={s.jinsId} onChange={(e) => s.setJinsId(e.target.value)} className="h-8 text-[13px]">
          {s.jins.data?.map((j) => <option key={j.id} value={j.id}>{j.code} — {pick(j.name, j.nameHi)}</option>)}
        </Select>
      </Field>
      <Field label={t("load.from")} className="w-40">
        <Input type="date" value={s.from} onChange={(e) => s.setFrom(e.target.value)} className="h-8 text-[13px]" />
      </Field>
      <Field label={t("load.to")} className="w-40">
        <Input type="date" value={s.to} onChange={(e) => s.setTo(e.target.value)} className="h-8 text-[13px]" />
      </Field>
      <p className="pb-1.5 text-[12px] text-faint">{s.from || s.to ? t("stock.rangeNote") : t("stock.allTime")}</p>
    </div>
  );
}

/* ------------------------------------------------------------ all mills */

export function StockPage() {
  const { t } = useI18n();
  const f = useFormat();
  const [, navigate] = useLocation();
  const s = useStockFilters();
  const list = useQuery({ queryKey: ["stock", "all", s.qs.toString()], queryFn: () => api.get<StockRow[]>(`/stock?${s.qs}`), enabled: Boolean(s.jinsId) });
  const rows = list.data ?? [];
  const total = {
    bought: rows.reduce((x, r) => x + r.boughtNet, 0),
    loaded: rows.reduce((x, r) => x + r.loadedNet, 0),
    left: rows.reduce((x, r) => x + r.stockNet, 0),
  };

  return (
    <div>
      <PageHeader title={t("stock.title")} sub={t("stock.sub")} />
      <Card>
        <Filters s={s} />
        {list.isPending ? <SkeletonTable rows={4} /> : !rows.length ? (
          <EmptyState icon={<Boxes className="h-5 w-5" />} title={t("stock.empty")} sub={t("stock.emptySub")} />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>{t("load.mill")}</Th><Th numeric>{t("load.slips")}</Th><Th numeric>{t("stock.bought")}</Th>
                <Th numeric>{t("stock.avgRate")}</Th><Th numeric>{t("stock.onTrucks")}</Th><Th numeric>{t("stock.trucks")}</Th>
                <Th numeric>{t("stock.left")}</Th><Th className="w-8" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const key = r.merchantId ?? "none";
                return (
                  <Tr key={key} onClick={() => navigate(`/stock/${key}`)}>
                    <Td className="whitespace-nowrap">
                      {r.millCode ? <><Badge tone="brand" className="num">{r.millCode}</Badge> <span className="text-muted">{r.millName}</span></>
                        : <span className="text-warn">{t("stock.noMill")}</span>}
                    </Td>
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
                <td className="px-3 py-2" colSpan={2}>{t("load.total")}</td>
                <td className="num px-3 py-2 text-right">{f.weight(total.bought)}</td>
                <td />
                <td className="num px-3 py-2 text-right">{f.weight(total.loaded)}</td>
                <td />
                <td className={cn("num px-3 py-2 text-right", total.left < 0 && "text-bad")}>{f.weight(total.left)}</td>
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
  const isNone = id === "none";

  const acct = useQuery({
    queryKey: ["mill-account", id, s.qs.toString()],
    queryFn: () => api.get<MillAccount>(`/dashboard/mill/${id}?${s.qs}`),
    enabled: !isNone && Boolean(s.jinsId),
  });
  const days = useQuery({
    queryKey: ["stock", id, s.qs.toString()],
    queryFn: () => api.get<{ days: StockMillDay[]; totals: { slips: number; boughtNet: number; loadedNet: number; stockNet: number } }>(`/stock/${id}?${s.qs}`),
    enabled: Boolean(s.jinsId),
  });

  const dara = async (date: string) => {
    setErr(null);
    try {
      await downloadDara({
        merchantId: id, from: date, to: date, names: prefs.dailyList.exportNameLang, sort: prefs.dailyList.sortOrder,
        format: "xlsx", columns: MILL_REPORT_COLUMNS.filter((c) => prefs.dailyList.millReportColumns[c.key]).map((c) => c.key),
      });
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : t("common.somethingWrong"));
    }
  };

  const a = acct.data;
  const sm = a?.summary;
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
        title={isNone ? t("stock.noMill") : a ? <span className="flex items-center gap-2"><Badge tone="brand" className="num">{a.mill.code}</Badge>{pick(a.mill.name, a.mill.nameHi)}</span> : "…"}
        sub={isNone ? t("stock.noMillHelp") : t("stock.millSub")}
        action={!isNone && can("load.write") && (
          <Button variant="primary" icon={<Truck className="h-4 w-4" />} onClick={() => setTruckFrom("")}>{t("load.new")}</Button>
        )} />
      {err && <Alert tone="bad" className="mb-3">{err}</Alert>}

      <Card className="mb-5"><Filters s={s} /></Card>

      {!isNone && (!a || !sm ? <SkeletonStats /> : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
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
          </div>

          <Card className="mt-5">
            <CardHeader title={t("stock.race")} sub={t("stock.raceSub")} />
            <div className="px-3 pt-3 pb-2"><RaceChart points={a.series} height={260} /></div>
            {a.worstAhead && <p className="border-t border-line px-4 py-2 text-[12px] text-bad">{t("dash.worstAhead", { d: dmy(a.worstAhead.date), q: f.weight(a.worstAhead.grams) })}</p>}
          </Card>

          <Card className="mt-5">
            <CardHeader title={t("stock.trucksTitle", { n: a.trucks.length })} sub={t("stock.trucksSub")} />
            {!a.trucks.length || !trucksTotal ? <EmptyState title={t("stock.noTrucks")} /> : (
              <Table>
                <thead>
                  <tr>
                    <Th>{t("load.date")}</Th><Th>{t("load.truckNo")}</Th><Th>{t("load.fromDays")}</Th>
                    <Th numeric>{t("load.loaded")}</Th><Th numeric>{t("load.rate")}</Th><Th numeric>{t("stock.goodsValue")}</Th>
                    <Th>{t("load.parchaNo")}</Th><Th numeric>{t("load.grandTotal")}</Th>
                  </tr>
                </thead>
                <tbody>
                  {a.trucks.map((x) => (
                    <Tr key={x.loadId} className={cn(x.mismatch && "bg-bad-soft/40")}>
                      <Td className="whitespace-nowrap">{dmy(x.loadDate)}</Td>
                      <Td className="font-mono"><Link href={`/loads/${x.loadId}`} className="text-brand hover:underline">{x.truckNo ?? "—"}</Link></Td>
                      <Td className="whitespace-nowrap text-muted">{x.stockDates.map(dmy).join(", ") || "—"}</Td>
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
                </tbody>
                <tfoot>
                  <tr className="bg-raised/50 text-[13px] font-semibold">
                    <td className="px-3 py-2" colSpan={3}>{t("load.total")}</td>
                    <td className="num px-3 py-2 text-right">{f.weight(trucksTotal.weight)}</td>
                    <td className="num px-3 py-2 text-right" title={t("stock.avgSaleHelp")}>{trucksTotal.weight ? f.rate(Math.floor((trucksTotal.goods * 100_000) / trucksTotal.weight + 0.5)) : "—"}</td>
                    <td className="num px-3 py-2 text-right">{f.amount(trucksTotal.goods)}</td>
                    <td />
                    <td className="num px-3 py-2 text-right">{f.money(trucksTotal.billed)}</td>
                  </tr>
                </tfoot>
              </Table>
            )}
          </Card>
        </>
      ))}

      <Card className="mt-5">
        <CardHeader title={t("stock.byDay")}
          sub={days.data ? t("stock.proof", {
            bought: f.weight(days.data.totals.boughtNet), loaded: f.weight(days.data.totals.loadedNet), left: f.weight(days.data.totals.stockNet),
          }) : undefined} />
        {days.isPending ? <SkeletonTable rows={5} /> : !days.data?.days.length ? (
          <EmptyState title={t("stock.noDays")} />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>{t("daily.date")}</Th><Th numeric>{t("load.slips")}</Th><Th numeric>{t("stock.bought")}</Th>
                <Th numeric>{t("stock.dayAvg")}</Th><Th>{t("stock.trucksThatDay")}</Th><Th numeric>{t("stock.onTrucks")}</Th>
                <Th numeric>{t("stock.leftThatDay")}</Th><Th numeric>{t("stock.running")}</Th><Th />
              </tr>
            </thead>
            <tbody>
              {days.data.days.map((d) => (
                <tr key={d.date} className="border-b border-line/70 align-top">
                  <td className="whitespace-nowrap px-3 py-2"><Link href={`/daily?date=${d.date}`} className="hover:text-brand">{dmy(d.date)}</Link></td>
                  <td className="num px-3 py-2 text-right">{d.slips}</td>
                  <td className="num px-3 py-2 text-right">{f.weight(d.boughtNet)}</td>
                  <td className="num px-3 py-2 text-right">
                    {d.avgRatePaisePerQtl ? f.rate(d.avgRatePaisePerQtl) : "—"}
                    {d.unpriced > 0 && <span className="block text-[10px] text-warn">{t("stock.unpriced", { n: d.unpriced })}</span>}
                  </td>
                  <td className="px-3 py-2">
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
                  <td className="num px-3 py-2 text-right">{f.weight(d.loadedNet)}</td>
                  <td className={cn("num px-3 py-2 text-right font-semibold", d.stockNet < 0 && "text-bad")}>{f.weight(d.stockNet)}</td>
                  <td className={cn("num px-3 py-2 text-right text-muted", d.runningNet < 0 && "text-bad")}>{f.weight(d.runningNet)}</td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-right">
                    {!isNone && can("load.write") && (
                      <Button size="sm" variant="ghost" icon={<Truck className="h-3.5 w-3.5" />} title={t("stock.truckFromDay")}
                        onClick={() => setTruckFrom(d.date)} />
                    )}
                    {!isNone && can("export.data") && d.slips > 0 && (
                      <Button size="sm" variant="ghost" icon={<FileSpreadsheet className="h-3.5 w-3.5" />} title={t("dl.dara")}
                        onClick={() => dara(d.date)} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-raised/50 text-[13px] font-semibold">
                <td className="px-3 py-2">{t("load.total")}</td>
                <td className="num px-3 py-2 text-right">{days.data.totals.slips}</td>
                <td className="num px-3 py-2 text-right">{f.weight(days.data.totals.boughtNet)}</td>
                <td colSpan={2} />
                <td className="num px-3 py-2 text-right">{f.weight(days.data.totals.loadedNet)}</td>
                <td className={cn("num px-3 py-2 text-right", days.data.totals.stockNet < 0 && "text-bad")}>{f.weight(days.data.totals.stockNet)}</td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          </Table>
        )}
      </Card>

      {truckFrom !== null && !isNone && (
        <NewLoadDialog open onClose={() => setTruckFrom(null)}
          preset={{ merchantId: id, jinsId: s.jinsId, stockDate: truckFrom || undefined }} />
      )}
    </div>
  );
}
