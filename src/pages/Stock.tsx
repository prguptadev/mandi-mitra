import { useEffect, useState } from "react";
import { Link, useSearch } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Boxes, Truck, FileSpreadsheet, ChevronRight } from "lucide-react";
import { api, ApiError, type Jins, type StockRow, type StockMillDay } from "@/lib/api.ts";
import { useI18n } from "@/lib/i18n.tsx";
import { useSession } from "@/lib/session.tsx";
import { useFormat } from "@/lib/format.tsx";
import { usePrefs, MILL_REPORT_COLUMNS } from "@/lib/prefs.tsx";
import { PageHeader } from "@/components/AppShell.tsx";
import { SkeletonTable } from "@/components/Skeletons.tsx";
import { downloadDara } from "@/components/DownloadDialog.tsx";
import { Button, Card, CardHeader, Field, Input, Select, Table, Th, Td, Tr, Badge, EmptyState, Alert } from "@/components/ui/index.tsx";
import { NewLoadDialog } from "@/pages/Loads.tsx";
import { cn } from "@/lib/utils.ts";
import { dmy } from "@server/lib/parchaLabels.ts";

/* Stock per mill = what was bought for it − what trucks took from it. Every
   figure is a sum of slips and truck rows, so the page is its own proof:
   each day shows its purchases, the trucks that took from it, and what is
   left, and the columns add up across and down. Negative is allowed. */

export function StockPage() {
  const { t, pick } = useI18n();
  const f = useFormat();
  const { can } = useSession();
  const { prefs } = usePrefs();
  const search = new URLSearchParams(useSearch());
  const [mill, setMill] = useState<string | null>(search.get("mill"));
  const [jinsId, setJinsId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [truckFrom, setTruckFrom] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const jins = useQuery({ queryKey: ["jins"], queryFn: () => api.get<Jins[]>("/jins") });
  useEffect(() => {
    if (!jinsId && jins.data?.length) setJinsId(jins.data.find((j) => j.code === "1509")?.id ?? jins.data[0].id);
  }, [jins.data]);

  const qs = new URLSearchParams();
  if (jinsId) qs.set("jinsId", jinsId);
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);
  const list = useQuery({ queryKey: ["stock", "all", qs.toString()], queryFn: () => api.get<StockRow[]>(`/stock?${qs}`), enabled: Boolean(jinsId) });
  const rows = list.data ?? [];
  const selected = rows.find((r) => (r.merchantId ?? "none") === mill) ?? null;
  const detail = useQuery({
    queryKey: ["stock", mill, qs.toString()],
    queryFn: () => api.get<{ days: StockMillDay[]; totals: { slips: number; boughtNet: number; loadedNet: number; stockNet: number } }>(`/stock/${mill}?${qs}`),
    enabled: Boolean(mill && jinsId),
  });

  const total = {
    bought: rows.reduce((s, r) => s + r.boughtNet, 0),
    loaded: rows.reduce((s, r) => s + r.loadedNet, 0),
    left: rows.reduce((s, r) => s + r.stockNet, 0),
  };

  const dara = async (date: string) => {
    setErr(null);
    try {
      await downloadDara({
        merchantId: mill!, from: date, to: date, names: prefs.dailyList.exportNameLang, sort: prefs.dailyList.sortOrder,
        format: "xlsx", columns: MILL_REPORT_COLUMNS.filter((c) => prefs.dailyList.millReportColumns[c.key]).map((c) => c.key),
      });
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : t("common.somethingWrong"));
    }
  };

  return (
    <div>
      <PageHeader title={t("stock.title")} sub={t("stock.sub")} />
      {err && <Alert tone="bad" className="mb-3">{err}</Alert>}

      <Card className="mb-5">
        <div className="flex flex-wrap items-end gap-3 border-b border-line p-3">
          <Field label={t("load.jins")} className="w-52">
            <Select value={jinsId} onChange={(e) => setJinsId(e.target.value)} className="h-8 text-[13px]">
              {jins.data?.map((j) => <option key={j.id} value={j.id}>{j.code} — {pick(j.name, j.nameHi)}</option>)}
            </Select>
          </Field>
          <Field label={t("load.from")} className="w-40">
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8 text-[13px]" />
          </Field>
          <Field label={t("load.to")} className="w-40">
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-8 text-[13px]" />
          </Field>
          <p className="pb-1.5 text-[12px] text-faint">{from || to ? t("stock.rangeNote") : t("stock.allTime")}</p>
        </div>
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
                  <Tr key={key} onClick={() => setMill(key)} className={cn(mill === key && "bg-brand/5")}>
                    <Td className="whitespace-nowrap">
                      {r.millCode ? <><Badge tone="brand" className="num">{r.millCode}</Badge> <span className="text-muted">{r.millName}</span></>
                        : <span className="text-warn">{t("stock.noMill")}</span>}
                    </Td>
                    <Td numeric>{r.slips}</Td>
                    <Td numeric>{f.weight(r.boughtNet)}</Td>
                    <Td numeric>{r.avgRatePaisePerQtl ? f.rate(r.avgRatePaisePerQtl) : "—"}</Td>
                    <Td numeric>{f.weight(r.loadedNet)}</Td>
                    <Td numeric>{r.trucks}</Td>
                    <Td numeric className={cn("font-semibold", r.stockNet < 0 && "text-warn")}>{f.weight(r.stockNet)}</Td>
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
                <td className={cn("num px-3 py-2 text-right", total.left < 0 && "text-warn")}>{f.weight(total.left)}</td>
                <td />
              </tr>
            </tfoot>
          </Table>
        )}
      </Card>

      {mill && (
        <Card>
          <CardHeader
            title={selected?.millCode ? `${selected.millCode} — ${selected.millName}` : t("stock.noMill")}
            sub={detail.data ? t("stock.proof", {
              bought: f.weight(detail.data.totals.boughtNet), loaded: f.weight(detail.data.totals.loadedNet), left: f.weight(detail.data.totals.stockNet),
            }) : undefined}
            action={mill !== "none" && can("load.write") && (
              <Button size="sm" variant="primary" icon={<Truck className="h-3.5 w-3.5" />} onClick={() => setTruckFrom("")}>{t("load.new")}</Button>
            )} />
          {mill === "none" && <Alert tone="warn" className="m-3">{t("stock.noMillHelp")}</Alert>}
          {detail.isPending ? <SkeletonTable rows={5} /> : !detail.data?.days.length ? (
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
                {detail.data.days.map((d) => (
                  <tr key={d.date} className="border-b border-line/70 align-top">
                    <td className="whitespace-nowrap px-3 py-2">{dmy(d.date)}</td>
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
                    <td className={cn("num px-3 py-2 text-right font-semibold", d.stockNet < 0 && "text-warn")}>{f.weight(d.stockNet)}</td>
                    <td className={cn("num px-3 py-2 text-right text-muted", d.runningNet < 0 && "text-warn")}>{f.weight(d.runningNet)}</td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-right">
                      {mill !== "none" && can("load.write") && (
                        <Button size="sm" variant="ghost" icon={<Truck className="h-3.5 w-3.5" />} title={t("stock.truckFromDay")}
                          onClick={() => setTruckFrom(d.date)} />
                      )}
                      {mill !== "none" && can("export.data") && d.slips > 0 && (
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
                  <td className="num px-3 py-2 text-right">{detail.data.totals.slips}</td>
                  <td className="num px-3 py-2 text-right">{f.weight(detail.data.totals.boughtNet)}</td>
                  <td colSpan={2} />
                  <td className="num px-3 py-2 text-right">{f.weight(detail.data.totals.loadedNet)}</td>
                  <td className={cn("num px-3 py-2 text-right", detail.data.totals.stockNet < 0 && "text-warn")}>{f.weight(detail.data.totals.stockNet)}</td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            </Table>
          )}
        </Card>
      )}

      {truckFrom !== null && mill && mill !== "none" && (
        <NewLoadDialog open onClose={() => setTruckFrom(null)}
          preset={{ merchantId: mill, jinsId, stockDate: truckFrom || undefined }} />
      )}
    </div>
  );
}
