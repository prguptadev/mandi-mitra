import { useEffect, useRef, useState } from "react";
import { useFYRange } from "@/lib/fy.tsx";
import { Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ClipboardCheck, Download, Search } from "lucide-react";
import { api, ApiError, type Jins, type Merchant } from "@/lib/api.ts";
import { useI18n } from "@/lib/i18n.tsx";
import { useSession } from "@/lib/session.tsx";
import { useFormat, GRAMS_PER_QTL } from "@/lib/format.tsx";
import { useSort } from "@/lib/useSort.ts";
import { PageHeader } from "@/components/AppShell.tsx";
import { SkeletonTable } from "@/components/Skeletons.tsx";
import { NumCell } from "@/pages/Loads.tsx";
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Select, Table, Td, Th, Tr } from "@/components/ui/index.tsx";
import { LoadError } from "@/components/LoadError.tsx";
import { useConfirm } from "@/components/Confirm.tsx";
import { cn, fmtQtl } from "@/lib/utils.ts";
import { dmy } from "@server/lib/parchaLabels.ts";

/* The challan register: every truck with its full details, and the weight
   the mill cut on arrival. Type the cut and the final weight, the final value
   and the final bill follow at once; the mill account takes the cut off what
   the mill owes. The parcha itself never changes. */

interface ChallanRow {
  loadId: string; loadDate: string; truckNo: string | null; status: string;
  merchantId: string; millCode: string; millName: string; millNameHi: string | null;
  jinsId: string; jinsCode: string; stockDates: string[];
  millGrossGrams: number | null; millNetGrams: number | null; bags: number | null;
  weightGrams: number; ratePaisePerQtl: number; goodsPaise: number;
  parchaNo: string | null; grandTotalPaise: number | null; advancePaise: number | null;
  deductionGrams: number; deductionNote: string | null; deductionValuePaise: number;
  finalNetGrams: number; finalGoodsPaise: number; finalTotalPaise: number | null;
  incomplete: boolean; mismatch: boolean;
}
interface ChallanList {
  rows: ChallanRow[];
  totals: {
    trucks: number; billed: number; weightGrams: number; deductionGrams: number; finalNetGrams: number;
    goodsPaise: number; deductionValuePaise: number; finalGoodsPaise: number; grandTotalPaise: number; finalTotalPaise: number; advancePaise: number | null;
  };
}

function NoteCell({ value, onCommit, disabled }: { value: string; onCommit: (v: string) => void; disabled?: boolean }) {
  const [v, setV] = useState(value);
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setV(value); }, [value]);
  return (
    <input value={v} disabled={disabled} maxLength={200}
      className="h-8 w-full min-w-[8rem] rounded-md border border-line bg-surface px-2 text-[12px] text-ink placeholder:text-faint focus:border-brand disabled:opacity-60"
      onFocus={() => { focused.current = true; }}
      onChange={(e) => setV(e.target.value)}
      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
      onBlur={() => { focused.current = false; if (v.trim() !== value) onCommit(v.trim()); }} />
  );
}

export function ChallanPage() {
  const { t, pick } = useI18n();
  const f = useFormat();
  const ask = useConfirm();
  /** Bumped when a cut is not confirmed, so the box shows the saved figure again. */
  const [undo, setUndo] = useState(0);
  const { can } = useSession();
  const qc = useQueryClient();
  const [merchantId, setMerchantId] = useState("");
  const [jinsId, setJinsId] = useState("");
  // the chosen financial year, until other dates are picked
  const { from, setFrom, to, setTo } = useFYRange();
  const [q, setQ] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const mills = useQuery({ queryKey: ["merchants"], queryFn: () => api.get<Merchant[]>("/merchants") });
  const jins = useQuery({ queryKey: ["jins"], queryFn: () => api.get<Jins[]>("/jins") });
  const qs = new URLSearchParams();
  if (merchantId) qs.set("merchantId", merchantId);
  if (jinsId) qs.set("jinsId", jinsId);
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);
  if (q.trim()) qs.set("q", q.trim());
  const list = useQuery({ queryKey: ["challan", qs.toString()], queryFn: () => api.get<ChallanList>(`/challan?${qs}`) });
  const save = useMutation({
    mutationFn: ({ loadId, deductionGrams, note }: { loadId: string; deductionGrams: number; note: string | null }) =>
      api.put(`/challan/${loadId}`, { deductionGrams, note }),
    onSuccess: async () => {
      setErr(null);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["challan"] }), qc.invalidateQueries({ queryKey: ["mill-ledger"] }),
        qc.invalidateQueries({ queryKey: ["parchas"] }), qc.invalidateQueries({ queryKey: ["dashboard"] }),
      ]);
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });
  const rows = list.data?.rows ?? [];
  const s = useSort(rows, {
    date: (r) => r.loadDate, truck: (r) => r.truckNo, mill: (r) => r.millCode, jins: (r) => r.jinsCode,
    gross: (r) => r.millGrossGrams, loaded: (r) => r.weightGrams, rate: (r) => r.ratePaisePerQtl, goods: (r) => r.goodsPaise,
    cut: (r) => r.deductionGrams, finalNet: (r) => r.finalNetGrams, cutValue: (r) => r.deductionValuePaise,
    finalGoods: (r) => r.finalGoodsPaise, parcha: (r) => r.parchaNo, advance: (r) => r.advancePaise, grand: (r) => r.grandTotalPaise, finalTotal: (r) => r.finalTotalPaise,
  }, { storageKey: "challan" });
  const editable = can("challan.write");
  const T = list.data?.totals;

  const download = () => {
    const esc = (v: unknown) => { const x = String(v ?? ""); return /[",\n]/.test(x) ? `"${x.replaceAll('"', '""')}"` : x; };
    const q2 = (g: number | null) => (g == null ? "" : fmtQtl(g));
    const rs = (p: number | null) => (p == null ? "" : (p / 100).toFixed(2));
    const lines = [
      ["Date", "Truck", "Mill", "Commodity", "Mill gross qtl", "Loaded qtl", "Rate", "Goods value", "Cut qtl", "Cut reason", "Final qtl", "Cut value", "Final value", "Parcha", "Advance", "Grand total", "Final bill"],
      ...s.sorted.map((r) => [dmy(r.loadDate), r.truckNo ?? "", r.millCode, r.jinsCode, q2(r.millGrossGrams), q2(r.weightGrams), rs(r.ratePaisePerQtl),
        rs(r.goodsPaise), q2(r.deductionGrams), r.deductionNote ?? "", q2(r.finalNetGrams), rs(r.deductionValuePaise), rs(r.finalGoodsPaise),
        r.parchaNo ?? "", rs(r.advancePaise), rs(r.grandTotalPaise), rs(r.finalTotalPaise)]),
      ...(T ? [["Total", `${T.trucks} trucks`, "", "", "", q2(T.weightGrams), "", rs(T.goodsPaise), q2(T.deductionGrams), "", q2(T.finalNetGrams), rs(T.deductionValuePaise), rs(T.finalGoodsPaise), "", rs(T.advancePaise), rs(T.grandTotalPaise), rs(T.finalTotalPaise)]] : []),
    ];
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["﻿" + lines.map((l) => l.map(esc).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" }));
    a.download = `challan${from ? `-${from}` : ""}${to ? `-to-${to}` : ""}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  return (
    <div>
      <PageHeader title={t("ch.title")} sub={t("ch.sub")}
        action={can("export.data") && rows.length > 0 && <Button icon={<Download className="h-4 w-4" />} onClick={download}>CSV</Button>} />
      {err && <Alert tone="bad" className="mb-3">{err}</Alert>}
      <Card>
        <div className="flex flex-wrap items-end gap-3 border-b border-line p-3">
          <Field label={t("load.mill")} className="w-56">
            <Select value={merchantId} onChange={(e) => setMerchantId(e.target.value)} className="h-8 text-[13px]">
              <option value="">{t("daily.allMills")}</option>
              {mills.data?.map((m) => <option key={m.id} value={m.id}>{m.code} — {pick(m.name, m.nameHi)}</option>)}
            </Select>
          </Field>
          <Field label={t("load.jins")} className="w-48">
            <Select value={jinsId} onChange={(e) => setJinsId(e.target.value)} className="h-8 text-[13px]">
              <option value="">{t("daily.allJins")}</option>
              {jins.data?.map((j) => <option key={j.id} value={j.id}>{j.code} — {pick(j.name, j.nameHi)}</option>)}
            </Select>
          </Field>
          <Field label={t("load.from")} className="w-40"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8 text-[13px]" /></Field>
          <Field label={t("load.to")} className="w-40"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-8 text-[13px]" /></Field>
          <Field label={t("ch.search")} className="w-56">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("ch.searchPh")} className="h-8 pl-8 text-[13px]" />
            </div>
          </Field>
          {(merchantId || jinsId || from || to || q) && (
            <Button size="sm" variant="ghost" className="mb-0.5" onClick={() => { setMerchantId(""); setJinsId(""); setFrom(""); setTo(""); setQ(""); }}>{t("ch.clear")}</Button>
          )}
        </div>
        {list.isPending ? <SkeletonTable rows={6} /> : list.isError ? <LoadError error={list.error} onRetry={() => void list.refetch()} /> : !rows.length ? (
          <EmptyState icon={<ClipboardCheck className="h-5 w-5" />} title={t("ch.empty")} sub={t("ch.emptySub")} />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <thead>
                <tr>
                  <Th {...s.th("date")}>{t("load.date")}</Th>
                  <Th {...s.th("truck")}>{t("load.truckNo")}</Th>
                  <Th {...s.th("mill")}>{t("load.mill")}</Th>
                  <Th {...s.th("jins")}>{t("load.jins")}</Th>
                  <Th numeric {...s.th("gross")} title={t("ch.grossHint")}>{t("ch.gross")}</Th>
                  <Th numeric {...s.th("loaded")}>{t("load.loaded")}</Th>
                  <Th numeric {...s.th("rate")}>{t("load.rate")}</Th>
                  <Th numeric {...s.th("goods")}>{t("stock.goodsValue")}</Th>
                  <Th numeric {...s.th("cut")} title={t("ch.cutHint")}>{t("ch.cut")}</Th>
                  <Th>{t("ch.cutNote")}</Th>
                  <Th numeric {...s.th("finalNet")}>{t("ch.finalNet")}</Th>
                  <Th numeric {...s.th("cutValue")}>{t("ch.cutValue")}</Th>
                  <Th numeric {...s.th("finalGoods")}>{t("ch.finalGoods")}</Th>
                  <Th {...s.th("parcha")}>{t("load.parchaNo")}</Th>
                  <Th numeric {...s.th("advance")} title={t("ch.advanceHint")}>{t("ch.advance")}</Th>
                  <Th numeric {...s.th("grand")}>{t("load.grandTotal")}</Th>
                  <Th numeric {...s.th("finalTotal")} title={t("ch.finalTotalHint")}>{t("ch.finalTotal")}</Th>
                </tr>
              </thead>
              <tbody>
                {s.sorted.map((r) => (
                  <Tr key={r.loadId} className={cn(r.mismatch && "bg-bad-soft/30")}>
                    <Td className="whitespace-nowrap">{dmy(r.loadDate)}</Td>
                    <Td className="whitespace-nowrap font-mono"><Link href={`/loads/${r.loadId}`} className="text-brand hover:underline">{r.truckNo ?? "—"}</Link>
                      {r.stockDates.length > 0 && <span className="block font-sans text-[10px] text-faint">{t("ch.fromDays", { d: r.stockDates.map((d) => dmy(d).slice(0, 5)).join(", ") })}</span>}</Td>
                    <Td className="whitespace-nowrap"><Badge className="num">{r.millCode}</Badge> <span className="text-[12px] text-muted">{pick(r.millName, r.millNameHi)}</span></Td>
                    <Td className="text-muted">{r.jinsCode}</Td>
                    <Td numeric className="text-muted">{r.millGrossGrams != null ? f.weight(r.millGrossGrams) : "—"}</Td>
                    <Td numeric>{f.weight(r.weightGrams)}</Td>
                    <Td numeric>{r.ratePaisePerQtl ? f.rate(r.ratePaisePerQtl) : "—"}</Td>
                    <Td numeric>{f.amount(r.goodsPaise)}</Td>
                    <Td numeric className="w-28">
                      {editable ? (
                        <NumCell key={`${r.loadId}-${undo}`} value={r.deductionGrams || null} scale={GRAMS_PER_QTL} decimals={2} placeholder="0.00" className="h-8 w-24 text-[13px]"
                          onCommit={async (v) => {
                            const cut = v ?? 0;
                            // a cut changes what the mill owes: say how much before saving
                            const ok = await ask({
                              title: t("ch.confirmTitle"),
                              rows: [
                                { label: t("load.truckNo"), value: `${r.truckNo ?? "—"} · ${r.millCode}` },
                                ...(r.parchaNo ? [{ label: t("parcha.no"), value: `#${r.parchaNo}` }] : []),
                                { label: t("ch.cutWas"), value: f.weight(r.deductionGrams, { unit: true }) },
                                { label: t("ch.cutNow"), value: f.weight(cut, { unit: true }), big: true },
                                ...(r.ratePaisePerQtl ? [{ label: t("ch.cutOffBill"), value: f.money(Math.round(cut * r.ratePaisePerQtl / GRAMS_PER_QTL)) }] : []),
                              ],
                            });
                            if (ok) save.mutate({ loadId: r.loadId, deductionGrams: cut, note: r.deductionNote });
                            else setUndo((n) => n + 1);
                          }} />
                      ) : r.deductionGrams ? f.weight(r.deductionGrams) : "—"}
                    </Td>
                    <Td>
                      {editable ? <NoteCell value={r.deductionNote ?? ""} onCommit={(v) => save.mutate({ loadId: r.loadId, deductionGrams: r.deductionGrams, note: v || null })} />
                        : <span className="text-[12px] text-muted">{r.deductionNote ?? ""}</span>}
                    </Td>
                    <Td numeric className={cn("font-semibold", r.deductionGrams > 0 && "text-warn")}>{f.weight(r.finalNetGrams)}</Td>
                    <Td numeric className="whitespace-nowrap text-muted">{r.deductionValuePaise ? `− ${f.amount(r.deductionValuePaise)}` : "—"}</Td>
                    <Td numeric className="font-semibold">{f.amount(r.finalGoodsPaise)}</Td>
                    <Td>{r.parchaNo ? <Badge tone="ok">#{r.parchaNo}</Badge>
                      : <Badge tone={r.incomplete || r.mismatch ? "warn" : "neutral"}>{r.incomplete ? t("stock.truckIncomplete") : r.mismatch ? t("stock.truckMismatch") : t("load.status.draft")}</Badge>}</Td>
                    <Td numeric className="text-muted">{r.advancePaise == null ? <span className="text-faint">—</span> : r.advancePaise ? f.money(r.advancePaise) : "—"}</Td>
                    <Td numeric>{r.grandTotalPaise != null ? f.money(r.grandTotalPaise) : <span className="text-faint">—</span>}</Td>
                    <Td numeric className="font-semibold text-brand">{r.finalTotalPaise != null ? f.money(r.finalTotalPaise) : <span className="text-faint">—</span>}</Td>
                  </Tr>
                ))}
              </tbody>
              {T && (
                <tfoot>
                  <tr className="bg-raised/50 text-[13px] font-semibold">
                    <td className="px-3 py-2" colSpan={5}>{t("ch.totalN", { n: T.trucks, b: T.billed })}</td>
                    <td className="num px-3 py-2 text-right">{f.weight(T.weightGrams)}</td>
                    <td className="num px-3 py-2 text-right" title={t("stock.avgSaleHelp")}>{T.weightGrams ? f.rate(Math.floor((T.goodsPaise * 100_000) / T.weightGrams + 0.5)) : "—"}</td>
                    <td className="num px-3 py-2 text-right">{f.amount(T.goodsPaise)}</td>
                    <td className="num px-3 py-2 text-right text-warn">{T.deductionGrams ? f.weight(T.deductionGrams) : "—"}</td>
                    <td />
                    <td className="num px-3 py-2 text-right">{f.weight(T.finalNetGrams)}</td>
                    <td className="num whitespace-nowrap px-3 py-2 text-right">{T.deductionValuePaise ? `− ${f.amount(T.deductionValuePaise)}` : "—"}</td>
                    <td className="num px-3 py-2 text-right">{f.amount(T.finalGoodsPaise)}</td>
                    <td />
                    <td className="num px-3 py-2 text-right">{T.advancePaise ? f.money(T.advancePaise) : "—"}</td>
                    <td className="num px-3 py-2 text-right">{f.money(T.grandTotalPaise)}</td>
                    <td className="num px-3 py-2 text-right text-brand">{f.money(T.finalTotalPaise)}</td>
                  </tr>
                </tfoot>
              )}
            </Table>
          </div>
        )}
      </Card>
    </div>
  );
}
