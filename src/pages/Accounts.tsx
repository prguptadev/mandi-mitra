import { useMemo, useState } from "react";
import { useFYRange } from "@/lib/fy.tsx";
import { useFYRangeToToday } from "@/lib/fyToday.ts";
import { findSuppliers, searchKeys, sortSuppliers, nextLedgerSort, ledgerSortOf, type LedgerSort } from "@/lib/ledgerList.ts";
import { SheetViewer, type ScannedSheet } from "@/components/SheetViewer.tsx";
import { TallyMark, useTallyFlags } from "@/components/TallyMark.tsx";
import { useSearch } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { BookOpen, Wallet, Plus, Pencil, Ban, Download, Printer, Search } from "lucide-react";
import { api, ApiError, type Adati } from "@/lib/api.ts";
import { useI18n } from "@/lib/i18n.tsx";
import { useSession } from "@/lib/session.tsx";
import { useFormat } from "@/lib/format.tsx";
import { PageHeader } from "@/components/AppShell.tsx";
import { NumberInput } from "@/components/NumberInput.tsx";
import { SupplierPicker } from "@/components/SupplierPicker.tsx";
import { SkeletonTable } from "@/components/Skeletons.tsx";
import { ReasonDialog } from "@/components/ReasonDialog.tsx";
import { PaySheetDialog } from "@/components/PaySheetDialog.tsx";
import { useSort } from "@/lib/useSort.ts";
import { useRowWindow, RowSpacer } from "@/lib/useRowWindow.tsx";
import {
  Button, Card, CardHeader, Field, Input, Select, Table, Th, Td, Tr, Badge, Dialog, EmptyState, Alert, Textarea, Checkbox,
} from "@/components/ui/index.tsx";
import { LoadError } from "@/components/LoadError.tsx";
import { useConfirm } from "@/components/Confirm.tsx";
import { defaultSupplierCharges, type SupplierCharges } from "@server/lib/supplierTerms.ts";
import { cn, todayISO, fmtQtl } from "@/lib/utils.ts";
import { owedBeforePayment, suppliersNow } from "@/lib/asOfToday.ts";
import { dmy } from "@server/lib/parchaLabels.ts";

/* Supplier ledger and payments. What is owed to a supplier is always
   opening + purchases − payments, summed from the slips and payments
   themselves; nothing is kept as a stored balance that could drift. */

const MODES = ["cash", "bank", "upi", "cheque"] as const;
type Mode = (typeof MODES)[number];

interface LedgerRow {
  id: string; nameHi: string; nameHinglish: string; village: string | null; phone: string | null;
  openingBalancePaise: number; slips: number; netGrams: number; unpriced: number;
  goodsPaise: number; commissionPaise: number; gaushalaPaise: number;
  purchasesPaise: number; paymentsPaise: number; balancePaise: number; lastActivity: string | null;
}
interface LedgerList {
  rows: LedgerRow[];
  totals: { openingPaise: number; broughtForwardPaise: number; goodsPaise: number; commissionPaise: number; gaushalaPaise: number; purchasesPaise: number; paymentsPaise: number; balancePaise: number; toPayPaise: number; paidAheadPaise: number };
}
interface Entry {
  kind: "purchase" | "payment"; id: string; date: string;
  rstNo?: string; jinsCode?: string; millCode?: string | null; netGrams?: number; ratePaisePerQtl?: number;
  grossGrams?: number; katautiUnits?: number;
  mode?: Mode; reference?: string | null; notes?: string | null; voucherNo?: number | null;
  voided?: boolean; voidReason?: string | null;
  creditPaise: number; debitPaise: number; balancePaise: number; amountPaise?: number;
  /** A purchase: goods value and what the supplier adds; creditPaise is their sum. */
  goodsPaise?: number; commissionPaise?: number; gaushalaPaise?: number;
}
interface Statement {
  supplier: { id: string; nameHi: string; nameHinglish: string; village: string | null; phone: string | null; accountNo: string | null; ifsc: string | null; openingBalancePaise: number };
  from: string | null; to: string | null; broughtForwardPaise: number; entries: Entry[];
  totals: { goodsPaise: number; commissionPaise: number; gaushalaPaise: number; purchasesPaise: number; paymentsPaise: number; netGrams: number; grossGrams: number; katautiUnits: number; avgRatePaisePerQtl: number; slips: number; unpriced: number; closingPaise: number };
}
interface PaymentRow {
  id: string; adatiId: string; payDate: string; amountPaise: number; mode: Mode; reference: string | null; notes: string | null; voucherNo?: number | null;
  adatiNameHi: string; adatiNameHinglish: string; createdByName: string | null;
  voidedAt?: number | null; voidReason?: string | null;
}

/** "₹12,500.00 to pay" / "₹2,000.00 paid ahead" — the sign in words, as a munshi says it. */
function Balance({ paise, className }: { paise: number; className?: string }) {
  const { t } = useI18n();
  const f = useFormat();
  if (paise === 0) return <span className={cn("num text-muted", className)}>{f.money(0)}</span>;
  return (
    <span className={cn("num whitespace-nowrap", paise < 0 && "text-warn", className)}>
      {f.money(Math.abs(paise))} <span className="text-[11px] font-normal text-muted">{paise > 0 ? t("ledger.toPay") : t("ledger.paidAhead")}</span>
    </span>
  );
}

const invalidateAccounts = (qc: ReturnType<typeof useQueryClient>) => Promise.all([
  qc.invalidateQueries({ queryKey: ["ledger"] }),
  qc.invalidateQueries({ queryKey: ["payments"] }),
]);

/* ------------------------------------------------------------ payment form */

export function PaymentDialog({ onClose, editing, adatiId: presetAdati, adatiLabel }: {
  onClose: () => void; editing?: PaymentRow | null; adatiId?: string; adatiLabel?: { nameHi: string; nameHinglish?: string };
}) {
  const { t } = useI18n();
  const f = useFormat();
  const qc = useQueryClient();
  const ask = useConfirm();
  const [v, setV] = useState(() => ({
    adatiId: editing?.adatiId ?? presetAdati ?? null as string | null,
    payDate: editing?.payDate ?? todayISO(),
    amount: editing ? editing.amountPaise / 100 : null as number | null,
    mode: (editing?.mode ?? "cash") as Mode,
    reference: editing?.reference ?? "",
    notes: editing?.notes ?? "",
  }));
  const [err, setErr] = useState<string | null>(null);
  // owed as of today, as the ledger page shows it: a slip or payment dated after today does not count yet
  const ledger = useQuery({ queryKey: ["ledger", "asOf", todayISO()], queryFn: () => api.get<LedgerList>(suppliersNow()) });
  const row = ledger.data?.rows.find((r) => r.id === v.adatiId);
  const amountPaise = v.amount == null ? 0 : Math.round(v.amount * 100);
  // what is owed now, not counting this payment if it is the one being edited
  const before = row ? owedBeforePayment(row, editing, v.adatiId) : null;
  const now = before ? before.owedPaise : null;

  const save = useMutation({
    mutationFn: () => {
      const body = {
        adatiId: v.adatiId, payDate: v.payDate, amountPaise, mode: v.mode,
        reference: v.reference.trim() || null, notes: v.notes.trim() || null,
      };
      return editing ? api.put(`/payments/${editing.id}`, body) : api.post("/payments", body);
    },
    onSuccess: async () => { await invalidateAccounts(qc); onClose(); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });

  return (
    <Dialog open onClose={onClose} title={editing ? t("pay.edit") : t("pay.add")} sub={t("pay.addSub")}
      footer={<>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant="primary" loading={save.isPending} disabled={!v.adatiId || !v.payDate || amountPaise <= 0}
          onClick={async () => {
            setErr(null);
            // money leaves the business: say exactly what, to whom, before it is written
            const who = await qc.fetchQuery({ queryKey: ["adati", "one", v.adatiId], queryFn: () => api.get<Adati>(`/adati/${v.adatiId}`), staleTime: 60_000 }).catch(() => null);
            if (await ask({
              title: editing ? t("pay.confirmEditTitle") : t("pay.confirmTitle"),
              rows: [
                { label: t("daily.supplier"), value: <span lang="hi">{who?.nameHi ?? adatiLabel?.nameHi ?? "—"}</span> },
                { label: t("pay.date"), value: v.payDate.split("-").reverse().join("-") },
                { label: t("pay.mode"), value: t(`pay.mode.${v.mode}` as "pay.mode.cash") },
                ...(v.reference.trim() ? [{ label: t("pay.reference"), value: v.reference.trim() }] : []),
                { label: t("pay.amount"), value: f.money(amountPaise), big: true },
              ],
            })) save.mutate();
          }}>{t("common.save")}</Button>
      </>}>
      {err && <Alert tone="bad" className="mb-3">{err}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("daily.supplier")} required className="sm:col-span-2">
          <SupplierPicker value={v.adatiId} onChange={(id) => setV((p) => ({ ...p, adatiId: id }))}
            selectedLabel={editing ? { nameHi: editing.adatiNameHi, nameHinglish: editing.adatiNameHinglish } : adatiLabel ?? null}
            autoFocus={!v.adatiId} />
        </Field>
        <Field label={t("pay.date")} required>
          <Input type="date" value={v.payDate} onChange={(e) => setV((p) => ({ ...p, payDate: e.target.value }))} />
        </Field>
        <Field label={t("pay.amount")} required>
          <NumberInput value={v.amount} decimals={2} onValueChange={(n) => setV((p) => ({ ...p, amount: n }))} autoFocus={Boolean(v.adatiId)}
            className="h-9.5 w-full rounded-lg border bg-surface px-3 text-right text-sm tabular-nums text-ink focus:border-brand" placeholder="0.00" />
        </Field>
        <Field label={t("pay.mode")}>
          <Select value={v.mode} onChange={(e) => setV((p) => ({ ...p, mode: e.target.value as Mode }))}>
            {MODES.map((m) => <option key={m} value={m}>{t(`pay.mode.${m}`)}</option>)}
          </Select>
        </Field>
        <Field label={t("pay.reference")} hint={t("pay.referenceHelp")}>
          <Input value={v.reference} onChange={(e) => setV((p) => ({ ...p, reference: e.target.value }))} />
        </Field>
      </div>
      <Field label={t("adati.notes")} className="mt-4">
        <Textarea value={v.notes} rows={2} onChange={(e) => setV((p) => ({ ...p, notes: e.target.value }))} />
      </Field>
      {now != null && (
        <div className="mt-4 grid grid-cols-3 gap-2 rounded-lg border border-line bg-raised/40 p-3 text-[13px]">
          <div><p className="text-[11px] text-faint">{t("pay.owedNow")}</p><Balance paise={now} /></div>
          <div><p className="text-[11px] text-faint">{t("pay.thisPayment")}</p><span className="num">− {f.money(amountPaise)}</span></div>
          <div><p className="text-[11px] text-faint">{t("pay.owedAfter")}</p><Balance paise={now - amountPaise} className="font-semibold" /></div>
          {row && (
            /* where "owed now" comes from, part by part */
            <p className="num col-span-3 border-t border-line pt-2 text-[11px] leading-relaxed text-muted">
              {t("pay.owedMadeOf", {
                opening: f.money(row.openingBalancePaise), amount: f.money(row.goodsPaise), commission: f.money(row.commissionPaise),
                gaushala: f.money(row.gaushalaPaise), paid: f.money(before ? before.paidPaise : row.paymentsPaise),
              })}
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}

/* ------------------------------------------------------------ ledger */

function csvOf(lines: (string | number)[][]) {
  const esc = (v: unknown) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return "﻿" + lines.map((l) => l.map(esc).join(",")).join("\r\n");
}

function save(text: string, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function LedgerPage() {
  const { t, lang, pick } = useI18n();
  const f = useFormat();
  // the names of the supplier-charge columns, as set in Settings
  const scq = useQuery({ queryKey: ["settings", "supplier-charges"], queryFn: () => api.get<SupplierCharges>("/settings/supplier-charges") });
  const L = (scq.data ?? defaultSupplierCharges()).labels;
  const { can } = useSession();
  const qc = useQueryClient();
  const search = new URLSearchParams(useSearch());
  const [selected, setSelected] = useState<string | null>(search.get("adati"));
  const [q, setQ] = useState("");
  // the chosen financial year from 1 April up to today, until other dates are picked
  const { from, setFrom, to, setTo, fy } = useFYRangeToToday();
  const [paying, setPaying] = useState<null | { editing?: PaymentRow | null }>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  // a purchase line's paper: the scanned sheet it came from, or that mill's sheet of the day
  const seesSheets = can("scan.review") || can("scan.create");
  const [paperOf, setPaperOf] = useState<string | null>(null);
  const paper = useQuery({
    queryKey: ["scans", "for-slip", paperOf],
    queryFn: () => api.get<{ how: "slip" | "day"; sheets: ScannedSheet[] }>(`/scans/for-slip/${paperOf}`),
    enabled: Boolean(paperOf),
  });

  /* The year's figures from 1 April up to today (or a past year's 31 March) —
     the same period the pay sheet's "Till date" uses, so the two agree, and an
     entry dated after today is not counted as owed yet. */
  const asOf = fy.current ? todayISO() : fy.to;
  const list = useQuery({
    queryKey: ["ledger", "list", fy.from, asOf],
    queryFn: () => api.get<LedgerList>(`/ledger?from=${fy.from}&asOf=${asOf}`),
  });
  const qs = new URLSearchParams();
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);
  const st = useQuery({
    queryKey: ["ledger", selected, qs.toString()],
    queryFn: () => api.get<Statement>(`/ledger/${selected}?${qs}`),
    enabled: Boolean(selected),
  });

  const nameOf = (r: { nameHi: string; nameHinglish: string }) => (lang === "hi" ? r.nameHi : r.nameHinglish || r.nameHi);
  // the list: a name and what is to pay, found by name in Hindi or Hinglish, sorted by either column
  const [order, setOrderNow] = useState<LedgerSort>(() => {
    try { return ledgerSortOf(localStorage.getItem("mandi.sort.ledger-names")); } catch { return ledgerSortOf(null); }
  });
  const sortBy = (key: LedgerSort["key"]) => {
    const next = nextLedgerSort(order, key);
    setOrderNow(next);
    try { localStorage.setItem("mandi.sort.ledger-names", JSON.stringify(next)); } catch { /* this sitting only */ }
  };
  const keys = useMemo(() => searchKeys(list.data?.rows ?? []), [list.data]);
  const rows = useMemo(() => sortSuppliers(findSuppliers(list.data?.rows ?? [], q, keys), order, lang), [list.data, keys, q, order, lang]);
  const win = useRowWindow(rows);

  const [voiding, setVoiding] = useState<{ id: string; amountPaise: number } | null>(null);
  const del = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => api.post(`/payments/${id}/void`, { reason }),
    onSuccess: async () => { setVoiding(null); await invalidateAccounts(qc); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });

  const s = st.data;
  const downloadCsv = () => {
    if (!s) return;
    const lines: (string | number)[][] = [
      [`Ledger: ${s.supplier.nameHinglish || s.supplier.nameHi} (${s.supplier.nameHi})`],
      [s.from || s.to ? `Period: ${s.from ? dmy(s.from) : "start"} to ${s.to ? dmy(s.to) : "today"}` : "All time"],
      [],
      ["Date", "Particulars", "Net qtl", "Rate", "Amount", L.commission, L.gaushala, L.payable, "Paid", "Balance"],
      ["", s.from ? "Brought forward" : "Opening balance", "", "", "", "", "", "", "", (s.broughtForwardPaise / 100).toFixed(2)],
      ...s.entries.map((e) => [
        dmy(e.date),
        e.kind === "purchase" ? `RST ${e.rstNo} · ${e.jinsCode}${e.millCode ? ` · ${e.millCode}` : ""}` : `${e.voucherNo ? `PV-${e.voucherNo} · ` : ""}Payment · ${e.mode}${e.reference ? ` · ${e.reference}` : ""}${e.voided ? ` · CANCELLED (${e.voidReason ?? ""})` : ""}`,
        e.netGrams != null ? fmtQtl(e.netGrams) : "",
        e.ratePaisePerQtl ? (e.ratePaisePerQtl / 100).toFixed(2) : "",
        e.kind === "purchase" && e.ratePaisePerQtl ? ((e.goodsPaise ?? 0) / 100).toFixed(2) : "",
        e.kind === "purchase" && e.ratePaisePerQtl ? ((e.commissionPaise ?? 0) / 100).toFixed(2) : "",
        e.kind === "purchase" && e.ratePaisePerQtl ? ((e.gaushalaPaise ?? 0) / 100).toFixed(2) : "",
        e.creditPaise ? (e.creditPaise / 100).toFixed(2) : "",
        e.debitPaise ? (e.debitPaise / 100).toFixed(2) : "",
        (e.balancePaise / 100).toFixed(2),
      ]),
      ["", "Total", fmtQtl(s.totals.netGrams), "", (s.totals.goodsPaise / 100).toFixed(2), (s.totals.commissionPaise / 100).toFixed(2), (s.totals.gaushalaPaise / 100).toFixed(2),
        (s.totals.purchasesPaise / 100).toFixed(2), (s.totals.paymentsPaise / 100).toFixed(2), (s.totals.closingPaise / 100).toFixed(2)],
    ];
    save(csvOf(lines), `ledger-${(s.supplier.nameHinglish || "supplier").replace(/\s+/g, "-")}${s.from ? `-${s.from}` : ""}${s.to ? `-to-${s.to}` : ""}.csv`);
  };

  const printStatement = () => {
    document.body.classList.add("print-parcha");
    const done = () => { document.body.classList.remove("print-parcha"); window.removeEventListener("afterprint", done); };
    window.addEventListener("afterprint", done);
    window.print();
    setTimeout(done, 1000);
  };

  return (
    <div>
      <PageHeader title={t("ledger.title")} sub={t("ledger.sub")}
        action={can("payment.write") && (
          <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setPaying({})}>{t("pay.add")}</Button>
        )} />
      {err && <Alert tone="bad" className="mb-3">{err}</Alert>}

      {list.data && (
        <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <Card className="flex items-start justify-between gap-2 p-3">
            <div className="min-w-0"><p className="text-[12px] text-muted">{t("ledger.totalToPay")}</p><p className="num break-all text-lg font-semibold">{f.money(list.data.totals.toPayPaise)}</p></div>
            {/* the pay sheet: who is to be paid what, as Excel or CSV */}
            {can("export.data") && (
              <Button size="sm" icon={<Download className="h-3.5 w-3.5" />} title={t("sheet.title")} onClick={() => setSheetOpen(true)}>{t("dl.button")}</Button>
            )}
          </Card>
          <Card className="p-3"><p className="text-[12px] text-muted">{t("ledger.totalPaidAhead")}</p><p className="num break-all text-lg font-semibold text-warn">{f.money(list.data.totals.paidAheadPaise)}</p></Card>
          {/* the sum written out line by line: large figures stay readable on any screen */}
          <Card className="p-3 sm:col-span-2 xl:col-span-1">
            <p className="mb-1 text-[12px] text-muted">{t("ledger.proof")}</p>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-[13px]">
              <dt className="text-muted">{t("ledger.broughtForward")}</dt><dd className="num break-all text-right">{f.money(list.data.totals.broughtForwardPaise)}</dd>
              <dt className="text-muted">+ {pick(L.payable, L.payableHi)}</dt><dd className="num break-all text-right">{f.money(list.data.totals.purchasesPaise)}</dd>
              <dt className="text-muted">− {t("ledger.payments")}</dt><dd className="num break-all text-right">{f.money(list.data.totals.paymentsPaise)}</dd>
              <dt className="border-t border-line pt-0.5 font-semibold text-ink">= {t("ledger.closing")}</dt>
              <dd className="num break-all border-t border-line pt-0.5 text-right font-semibold">{f.money(list.data.totals.balancePaise)}</dd>
            </dl>
            <p className="num mt-1.5 break-words text-[11px] leading-snug text-faint">{t("sc.purchasesAre", { amount: f.money(list.data.totals.goodsPaise), commission: f.money(list.data.totals.commissionPaise), gaushala: f.money(list.data.totals.gaushalaPaise) })}</p>
          </Card>
        </div>
      )}

      <div className="grid gap-5 xl:grid-cols-[380px_minmax(0,1fr)]">
        <Card className="self-start">
          <div className="border-b border-line p-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("ledger.searchName")} className="h-8 pl-8 text-[13px]" />
            </div>
          </div>
          {list.isPending ? <SkeletonTable rows={8} /> : list.isError ? <LoadError error={list.error} onRetry={() => void list.refetch()} /> : !rows.length ? (
            <EmptyState icon={<BookOpen className="h-5 w-5" />} title={q.trim() ? t("common.noResults") : t("ledger.empty")} />
          ) : (
            <div className="max-h-[40vh] overflow-y-auto xl:max-h-[70vh]">
              <table className="w-full border-collapse text-[13px]">
                <thead>
                  <tr>
                    <Th sortDir={order.key === "name" ? order.dir : null} onSort={() => sortBy("name")}>{t("daily.supplier")}</Th>
                    <Th numeric sortDir={order.key === "amount" ? order.dir : null} onSort={() => sortBy("amount")}>{t("ledger.colToPay")}</Th>
                  </tr>
                </thead>
                <tbody ref={win.bodyRef}>
                  <RowSpacer at="top" height={win.topHeight} cols={2} />
                  {win.rows.map((r) => (
                    <tr key={r.id} tabIndex={0} onClick={() => setSelected(r.id)}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelected(r.id); } }}
                      className={cn("cursor-pointer border-b border-line/70 transition-colors hover:bg-raised/60 focus-visible:bg-raised/60 focus-visible:outline-none", selected === r.id && "bg-brand/5")}>
                      <td className="px-3 py-2"><span lang={lang === "hi" ? "hi" : undefined} className="block break-words text-[14px] leading-snug text-ink">{nameOf(r)}</span></td>
                      {/* paid ahead shows as a minus, in orange */}
                      <td className={cn("num whitespace-nowrap px-3 py-2 text-right", r.balancePaise < 0 ? "text-warn" : r.balancePaise === 0 && "text-muted")}
                        title={r.balancePaise < 0 ? t("ledger.paidAhead") : undefined}>{f.money(r.balancePaise)}</td>
                    </tr>
                  ))}
                  <RowSpacer at="bottom" height={win.bottomHeight} cols={2} />
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <div className="min-w-0">
          {!selected ? (
            <Card><EmptyState icon={<BookOpen className="h-5 w-5" />} title={t("ledger.pick")} sub={t("ledger.pickSub")} /></Card>
          ) : st.isPending ? <Card><SkeletonTable rows={8} /></Card> : !s ? (
            <Card><EmptyState title={t("common.somethingWrong")} /></Card>
          ) : (
            <Card>
              <CardHeader
                title={<span lang={lang === "hi" ? "hi" : undefined}>{nameOf(s.supplier)}</span>}
                sub={[s.supplier.village, s.supplier.phone, s.supplier.accountNo && `A/c ${s.supplier.accountNo}${s.supplier.ifsc ? ` · ${s.supplier.ifsc}` : ""}`].filter(Boolean).join(" · ") || undefined}
                action={
                  <div className="no-print flex flex-wrap gap-2">
                    {can("payment.write") && (
                      <Button size="sm" variant="primary" icon={<Wallet className="h-3.5 w-3.5" />} onClick={() => setPaying({})}>{t("pay.add")}</Button>
                    )}
                    {can("export.data") && <Button size="sm" icon={<Download className="h-3.5 w-3.5" />} onClick={downloadCsv}>CSV</Button>}
                    <Button size="sm" icon={<Printer className="h-3.5 w-3.5" />} onClick={printStatement}>{t("parcha.print")}</Button>
                  </div>
                } />
              <div className="no-print flex flex-wrap items-end gap-3 border-b border-line p-3">
                <Field label={t("load.from")} className="w-40">
                  <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8 text-[13px]" />
                </Field>
                <Field label={t("load.to")} className="w-40">
                  <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-8 text-[13px]" />
                </Field>
                {(from || to) && <Button size="sm" variant="ghost" onClick={() => { setFrom(""); setTo(""); }}>{t("ledger.allTime")}</Button>}
              </div>

              <div className="print-area bg-surface">
                <div className="hidden px-4 pt-4 print:block">
                  <p className="text-[16px] font-bold">{s.supplier.nameHinglish} ({s.supplier.nameHi})</p>
                  <p className="text-[12px]">{s.from || s.to ? `${s.from ? dmy(s.from) : "…"} – ${s.to ? dmy(s.to) : dmy(todayISO())}` : t("ledger.allTime")}</p>
                </div>
                <div className="grid grid-cols-2 gap-px border-b border-line bg-line 2xl:grid-cols-4">
                  {[
                    [s.from ? t("ledger.broughtForward") : t("ledger.opening"), <Balance key="a" paise={s.broughtForwardPaise} />],
                    [t("ledger.purchases", { n: s.totals.slips }), <span key="b" className="num" title={t("sc.madeOf", { amount: f.money(s.totals.goodsPaise), commission: f.money(s.totals.commissionPaise), gaushala: f.money(s.totals.gaushalaPaise) })}>
                      {f.money(s.totals.purchasesPaise)}
                      <span className="block text-[11px] font-normal text-faint">{t("sc.madeOf", { amount: f.money(s.totals.goodsPaise), commission: f.money(s.totals.commissionPaise), gaushala: f.money(s.totals.gaushalaPaise) })}</span>
                    </span>],
                    [t("ledger.payments"), <span key="c" className="num">{f.money(s.totals.paymentsPaise)}</span>],
                    [t("ledger.closing"), <Balance key="d" paise={s.totals.closingPaise} className="font-semibold" />],
                  ].map(([label, value], i) => (
                    <div key={i} className="bg-surface px-4 py-2.5">
                      <p className="text-[11px] text-faint">{label}</p>
                      <p className="text-[14px]">{value}</p>
                    </div>
                  ))}
                </div>
                {s.totals.unpriced > 0 && <Alert tone="warn" className="m-3">{t("ledger.unpriced", { n: s.totals.unpriced })}</Alert>}
                <Table>
                  <thead>
                    <tr>
                      <Th>{t("daily.date")}</Th><Th>{t("daily.rst")}</Th><Th>{t("load.mill")}</Th><Th>{t("load.jins")}</Th>
                      <Th numeric>{t("daily.gross")}</Th><Th numeric>{t("load.katauti")}</Th><Th numeric>{t("load.net")}</Th>
                      <Th numeric>{t("load.rate")}</Th><Th numeric>{t("daily.amount")}</Th>
                      <Th numeric>{pick(L.commission, L.commissionHi)}</Th><Th numeric>{pick(L.gaushala, L.gaushalaHi)}</Th>
                      <Th numeric>{pick(L.payable, L.payableHi)}</Th><Th numeric>{t("ledger.paid")}</Th>
                      <Th numeric>{t("ledger.balance")}</Th><Th className="no-print w-16" />
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-b border-line/70 bg-raised/30 text-[13px]">
                      <td className="px-3 py-1.5" />
                      <td className="px-3 py-1.5 text-muted" colSpan={3}>{s.from ? t("ledger.broughtForward") : t("ledger.opening")}</td>
                      <td colSpan={9} />
                      <td className="px-3 py-1.5 text-right"><Balance paise={s.broughtForwardPaise} /></td>
                      <td className="no-print" />
                    </tr>
                    {s.entries.map((e) => (
                      <Tr key={`${e.kind}-${e.id}`} className={cn(e.voided && "opacity-60")}>
                        <Td className="whitespace-nowrap">
                          {e.kind === "purchase" && seesSheets ? (
                            <button type="button" title={t("viewer.open")} onClick={() => setPaperOf(e.id)}
                              className="text-brand underline decoration-dotted underline-offset-2 hover:decoration-solid print:text-ink print:no-underline">{dmy(e.date)}</button>
                          ) : dmy(e.date)}
                        </Td>
                        {e.kind === "purchase" ? (
                          <>
                            <Td className="whitespace-nowrap font-mono">{e.rstNo}{!e.ratePaisePerQtl && <Badge tone="warn" className="ml-1.5 font-sans">{t("daily.ratePending")}</Badge>}</Td>
                            <Td>{e.millCode ? <Badge className="num">{e.millCode}</Badge> : <span className="text-faint">—</span>}</Td>
                            <Td className="text-muted">{e.jinsCode}</Td>
                            <Td numeric>{e.grossGrams != null ? f.weight(e.grossGrams) : ""}</Td>
                            <Td numeric className="text-muted">{e.katautiUnits ?? ""}</Td>
                            <Td numeric>{e.netGrams != null ? f.weight(e.netGrams) : ""}</Td>
                            <Td numeric>{e.ratePaisePerQtl ? f.rate(e.ratePaisePerQtl) : ""}</Td>
                            <Td numeric>{e.ratePaisePerQtl ? f.amount(e.goodsPaise ?? 0) : ""}</Td>
                            <Td numeric className="text-muted">{e.ratePaisePerQtl ? f.amount(e.commissionPaise ?? 0) : ""}</Td>
                            <Td numeric className="text-muted">{e.ratePaisePerQtl ? f.amount(e.gaushalaPaise ?? 0) : ""}</Td>
                          </>
                        ) : (
                          <Td className={cn("whitespace-nowrap text-ok", e.voided && "line-through")} colSpan={10}>
                            {e.voucherNo ? <span className="num">PV-{e.voucherNo} · </span> : null}{t("ledger.payment")} · {t(`pay.mode.${e.mode ?? "cash"}`)}{e.reference ? <span className="text-muted"> · {e.reference}</span> : null}
                            {e.notes ? <span className="text-faint"> · {e.notes}</span> : null}
                            {e.voided && <span className="ml-2 text-[11px] text-bad">{t("money.cancelledBecause", { why: e.voidReason ?? "" })}</span>}
                          </Td>
                        )}
                        <Td numeric>{e.creditPaise ? f.amount(e.creditPaise) : ""}</Td>
                        <Td numeric className="text-ok">{e.debitPaise ? f.amount(e.debitPaise) : ""}</Td>
                        <Td numeric><Balance paise={e.balancePaise} /></Td>
                        <Td className="no-print whitespace-nowrap text-right">
                          {e.voided && <Badge tone="bad">{t("money.cancelled")}</Badge>}
                          {e.kind === "payment" && !e.voided && can("payment.write") && (
                            <>
                              <Button variant="ghost" size="icon" title={t("common.edit")} onClick={() => setPaying({
                                editing: { id: e.id, adatiId: s.supplier.id, payDate: e.date, amountPaise: e.debitPaise, mode: e.mode ?? "cash",
                                  reference: e.reference ?? null, notes: e.notes ?? null, adatiNameHi: s.supplier.nameHi,
                                  adatiNameHinglish: s.supplier.nameHinglish, createdByName: null },
                              })}><Pencil className="h-3.5 w-3.5" /></Button>
                              <Button variant="ghost" size="icon" title={t("money.cancel")}
                                onClick={() => { setErr(null); setVoiding({ id: e.id, amountPaise: e.debitPaise }); }}>
                                <Ban className="h-3.5 w-3.5 text-bad" />
                              </Button>
                            </>
                          )}
                        </Td>
                      </Tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="bg-raised/50 text-[13px] font-semibold">
                      <td className="px-3 py-2" colSpan={4}>{t("load.total")} · {s.totals.slips} {t("ledger.slips")}</td>
                      <td className="num px-3 py-2 text-right">{f.weight(s.totals.grossGrams)}</td>
                      <td className="num px-3 py-2 text-right text-muted">{s.totals.katautiUnits}</td>
                      <td className="num px-3 py-2 text-right">{f.weight(s.totals.netGrams)}</td>
                      <td className="num px-3 py-2 text-right" title={t("load.avgRateHelp")}>{s.totals.avgRatePaisePerQtl ? f.rate(s.totals.avgRatePaisePerQtl) : ""}</td>
                      <td className="num px-3 py-2 text-right">{f.amount(s.totals.goodsPaise)}</td>
                      <td className="num px-3 py-2 text-right text-muted">{f.amount(s.totals.commissionPaise)}</td>
                      <td className="num px-3 py-2 text-right text-muted">{f.amount(s.totals.gaushalaPaise)}</td>
                      <td className="num px-3 py-2 text-right">{f.amount(s.totals.purchasesPaise)}</td>
                      <td className="num px-3 py-2 text-right">{f.amount(s.totals.paymentsPaise)}</td>
                      <td className="px-3 py-2 text-right"><Balance paise={s.totals.closingPaise} /></td>
                      <td className="no-print" />
                    </tr>
                  </tfoot>
                </Table>
              </div>
            </Card>
          )}
        </div>
      </div>

      {voiding && (
        <ReasonDialog title={t("pay.cancelTitle", { amt: f.money(voiding.amountPaise) })} sub={t("pay.cancelSub")}
          confirmLabel={t("money.confirmCancel")} busy={del.isPending} error={err}
          onClose={() => setVoiding(null)} onConfirm={(reason) => del.mutate({ id: voiding.id, reason })} />
      )}
      {/* a past financial year: the sheet as it stood on its 31 March */}
      {sheetOpen && <PaySheetDialog onClose={() => setSheetOpen(false)} date={asOf} />}
      {paperOf && (
        <SheetViewer sheets={paper.data?.sheets} loading={paper.isPending} error={paper.error ?? undefined} onRetry={() => void paper.refetch()}
          note={paper.data?.how === "day" && paper.data.sheets.length ? t("viewer.sameDay") : undefined} onClose={() => setPaperOf(null)} />
      )}
      {paying && (
        <PaymentDialog onClose={() => setPaying(null)} editing={paying.editing ?? null}
          adatiId={selected ?? undefined}
          adatiLabel={s && s.supplier.id === selected ? { nameHi: s.supplier.nameHi, nameHinglish: s.supplier.nameHinglish } : undefined} />
      )}
    </div>
  );
}

/* ------------------------------------------------------------ payments */

export function PaymentsPage() {
  const { t, lang } = useI18n();
  const f = useFormat();
  const { can } = useSession();
  const qc = useQueryClient();
  // the chosen financial year, until other dates are picked
  const { from, setFrom, to, setTo } = useFYRange();
  const [mode, setMode] = useState<"" | Mode>("");
  const [adati, setAdati] = useState<string | null>(null);
  const [paying, setPaying] = useState<null | { editing?: PaymentRow | null }>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showVoid, setShowVoid] = useState(false);
  const [voiding, setVoiding] = useState<PaymentRow | null>(null);

  const qs = new URLSearchParams();
  if (showVoid) qs.set("showVoid", "1");
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);
  if (mode) qs.set("mode", mode);
  if (adati) qs.set("adatiId", adati);
  const payFlags = useTallyFlags("payment", from || "2000-01-01", to || "2099-12-31");
  const list = useQuery({
    queryKey: ["payments", qs.toString()],
    queryFn: () => api.get<{ rows: PaymentRow[]; truncated?: boolean; totals: { count: number; amountPaise: number; byMode: Record<Mode, number> } }>(`/payments?${qs}`),
  });
  const del = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => api.post(`/payments/${id}/void`, { reason }),
    onSuccess: async () => { setVoiding(null); await invalidateAccounts(qc); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });
  const rows = list.data?.rows ?? [];
  const sort = useSort(rows, {
    date: (p) => p.payDate, supplier: (p) => (lang === "hi" ? p.adatiNameHi : p.adatiNameHinglish || p.adatiNameHi),
    mode: (p) => p.mode, reference: (p) => p.reference, amount: (p) => p.amountPaise, by: (p) => p.createdByName,
  }, { storageKey: "payments" });
  const win = useRowWindow(sort.sorted);

  return (
    <div>
      <PageHeader title={t("pay.title")} sub={t("pay.sub")}
        action={can("payment.write") && (
          <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setPaying({})}>{t("pay.add")}</Button>
        )} />
      {err && <Alert tone="bad" className="mb-3">{err}</Alert>}
      <Card>
        <div className="flex flex-wrap items-end gap-3 border-b border-line p-3">
          <Field label={t("load.from")} className="w-40">
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8 text-[13px]" />
          </Field>
          <Field label={t("load.to")} className="w-40">
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-8 text-[13px]" />
          </Field>
          <Field label={t("pay.mode")} className="w-36">
            <Select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)} className="h-8 text-[13px]">
              <option value="">{t("common.all")}</option>
              {MODES.map((m) => <option key={m} value={m}>{t(`pay.mode.${m}`)}</option>)}
            </Select>
          </Field>
          <Field label={t("daily.supplier")} className="w-64">
            <SupplierPicker value={adati} onChange={setAdati} className="h-8 text-[13px]" placeholder={t("common.all")} />
          </Field>
          <div className="pb-1.5"><Checkbox checked={showVoid} onChange={setShowVoid} label={t("money.showCancelled")} /></div>
        </div>
        {list.isPending ? <SkeletonTable rows={6} /> : list.isError ? <LoadError error={list.error} onRetry={() => void list.refetch()} /> : !rows.length ? (
          <EmptyState icon={<Wallet className="h-5 w-5" />} title={t("pay.empty")} sub={t("pay.emptySub")}
            action={can("payment.write") && <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setPaying({})}>{t("pay.add")}</Button>} />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th {...sort.th("date")}>{t("pay.date")}</Th><Th>{t("pay.voucherNo")}</Th><Th {...sort.th("supplier")}>{t("daily.supplier")}</Th>
                <Th {...sort.th("mode")}>{t("pay.mode")}</Th><Th {...sort.th("reference")}>{t("pay.reference")}</Th>
                <Th numeric {...sort.th("amount")}>{t("pay.amount")}</Th><Th {...sort.th("by")}>{t("pay.by")}</Th><Th className="w-20" />
              </tr>
            </thead>
            <tbody ref={win.bodyRef}>
              <RowSpacer at="top" height={win.topHeight} cols={8} />
              {win.rows.map((p) => (
                <Tr key={p.id} className={cn(p.voidedAt && "opacity-60")}>
                  <Td className={cn("whitespace-nowrap", p.voidedAt && "line-through")}>{dmy(p.payDate)} <TallyMark flag={payFlags[p.id]} /></Td>
                  <Td className="num whitespace-nowrap text-muted">{p.voucherNo ? `PV-${p.voucherNo}` : "—"}</Td>
                  <Td><span lang={lang === "hi" ? "hi" : undefined}>{lang === "hi" ? p.adatiNameHi : p.adatiNameHinglish || p.adatiNameHi}</span></Td>
                  <Td><Badge>{t(`pay.mode.${p.mode}`)}</Badge></Td>
                  <Td className="text-muted">{p.reference ?? ""}{p.notes ? <span className="block text-[11px] text-faint">{p.notes}</span> : null}
                    {p.voidedAt && <span className="block text-[11px] text-bad">{t("money.cancelledBecause", { why: p.voidReason ?? "" })}</span>}</Td>
                  <Td numeric className={cn("font-medium", p.voidedAt && "line-through")}>{f.money(p.amountPaise)}</Td>
                  <Td className="text-[12px] text-muted">{p.createdByName ?? ""}</Td>
                  <Td className="whitespace-nowrap text-right">
                    {p.voidedAt ? <Badge tone="bad">{t("money.cancelled")}</Badge> : can("payment.write") && (
                      <>
                        <Button variant="ghost" size="icon" title={t("common.edit")} onClick={() => setPaying({ editing: p })}><Pencil className="h-3.5 w-3.5" /></Button>
                        <Button variant="ghost" size="icon" title={t("money.cancel")}
                          onClick={() => { setErr(null); setVoiding(p); }}>
                          <Ban className="h-3.5 w-3.5 text-bad" />
                        </Button>
                      </>
                    )}
                  </Td>
                </Tr>
              ))}
              <RowSpacer at="bottom" height={win.bottomHeight} cols={8} />
            </tbody>
            <tfoot>
              <tr className="bg-raised/50 text-[13px] font-semibold">
                <td className="px-3 py-2" colSpan={4}>
                  {t("pay.totalN", { n: list.data!.totals.count })}
                  <span className="ml-3 font-normal text-muted">
                    {MODES.filter((m) => list.data!.totals.byMode[m]).map((m) => `${t(`pay.mode.${m}`)} ${f.money(list.data!.totals.byMode[m])}`).join(" · ")}
                  </span>
                </td>
                <td className="num px-3 py-2 text-right">{f.money(list.data!.totals.amountPaise)}</td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          </Table>
        )}
        {list.data?.truncated && <p className="border-t border-line px-3 py-2 text-[11px] text-faint">{t("common.truncated", { n: list.data.rows.length })}</p>}
      </Card>
      {paying && <PaymentDialog onClose={() => setPaying(null)} editing={paying.editing ?? null} adatiId={adati ?? undefined} />}
      {voiding && (
        <ReasonDialog title={t("pay.cancelTitle", { amt: f.money(voiding.amountPaise) })} sub={t("pay.cancelSub")}
          confirmLabel={t("money.confirmCancel")} busy={del.isPending} error={err}
          onClose={() => setVoiding(null)} onConfirm={(reason) => del.mutate({ id: voiding.id, reason })} />
      )}
    </div>
  );
}
