import { useMemo, useState } from "react";
import { useFYRange } from "@/lib/fy.tsx";
import { TallyMark, useTallyFlags } from "@/components/TallyMark.tsx";
import { Link, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Download, Landmark, Pencil, Plus, Printer, Ban } from "lucide-react";
import { api, ApiError, type Merchant } from "@/lib/api.ts";
import { useI18n } from "@/lib/i18n.tsx";
import { useSession } from "@/lib/session.tsx";
import { useFormat } from "@/lib/format.tsx";
import { useSort } from "@/lib/useSort.ts";
import { PageHeader } from "@/components/AppShell.tsx";
import { NumberInput } from "@/components/NumberInput.tsx";
import { SkeletonTable } from "@/components/Skeletons.tsx";
import { ReasonDialog } from "@/components/ReasonDialog.tsx";
import {
  Alert, Badge, Button, Card, CardHeader, Checkbox, Dialog, EmptyState, Field, Input, Select, Table, Tabs, Td, Textarea, Th, Tr,
} from "@/components/ui/index.tsx";
import { LoadError } from "@/components/LoadError.tsx";
import { useConfirm } from "@/components/Confirm.tsx";
import { cn, todayISO, fmtQtl } from "@/lib/utils.ts";
import { dmy } from "@server/lib/parchaLabels.ts";

/* The mill side of the money. What a mill owes us is always
     opening + approved kaccha parchas − receipts (money + anything held back),
   summed from the parchas and receipts themselves; nothing is a stored
   balance. A voided parcha or a cancelled receipt counts for nothing. */

export const RECEIPT_MODES = ["bank", "rtgs", "cheque", "upi", "cash"] as const;
type Mode = (typeof RECEIPT_MODES)[number];

export interface MillLedgerRow {
  id: string; code: string; name: string; nameHi: string | null; active: boolean; openingBalancePaise: number;
  parchas: number; billedPaise: number; shortagePaise: number; receipts: number; receivedPaise: number; deductedPaise: number;
  balancePaise: number; lastBill: string | null; lastReceipt: string | null;
}
export interface MillLedgerList {
  rows: MillLedgerRow[];
  totals: { openingPaise: number; billedPaise: number; shortagePaise: number; receivedPaise: number; deductedPaise: number; balancePaise: number; toReceivePaise: number; paidAheadPaise: number };
}
interface MillEntry {
  kind: "parcha" | "shortage" | "receipt"; id: string; date: string; deductionGrams?: number;
  parchaNo?: string; version?: number; truckNo?: string | null; netGrams?: number | null; loadId?: string | null;
  mode?: Mode; reference?: string | null; notes?: string | null; deductionNote?: string | null; voucherNo?: number | null;
  amountPaise?: number; deductionPaise?: number; voided?: boolean; voidReason?: string | null;
  debitPaise: number; creditPaise: number; balancePaise: number;
}
interface MillBill { loadId: string; parchaNo: string; date: string; truckNo: string | null; grandTotalPaise: number; shortagePaise: number; receivedPaise: number; duePaise: number }
interface MillStatement {
  mill: { id: string; code: string; name: string; nameHi: string | null; openingBalancePaise: number };
  from: string | null; to: string | null; broughtForwardPaise: number; entries: MillEntry[];
  totals: { billedPaise: number; shortagePaise: number; receivedPaise: number; deductedPaise: number; closingPaise: number };
  bills: MillBill[];
}
export interface ReceiptRow {
  id: string; merchantId: string; loadId: string | null; receiptDate: string; amountPaise: number; deductionPaise: number; voucherNo?: number | null;
  deductionNote: string | null; mode: Mode; reference: string | null; notes: string | null;
  voidedAt: number | null; voidReason: string | null;
  millCode: string; millName: string; millNameHi: string | null; truckNo: string | null; parchaNo: string | null; createdByName: string | null;
}

/** "₹12,500.00 to receive" / "₹2,000.00 received ahead". */
export function MillBalance({ paise, className }: { paise: number; className?: string }) {
  const { t } = useI18n();
  const f = useFormat();
  if (paise === 0) return <span className={cn("num text-muted", className)}>{f.money(0)}</span>;
  return (
    <span className={cn("num whitespace-nowrap", paise < 0 && "text-warn", className)}>
      {f.money(Math.abs(paise))} <span className="text-[11px] font-normal text-muted">{paise > 0 ? t("mm.toReceive") : t("mm.receivedAhead")}</span>
    </span>
  );
}

export const invalidateMillMoney = (qc: ReturnType<typeof useQueryClient>) => Promise.all([
  qc.invalidateQueries({ queryKey: ["mill-ledger"] }),
  qc.invalidateQueries({ queryKey: ["mill-receipts"] }),
  qc.invalidateQueries({ queryKey: ["parchas"] }),
  qc.invalidateQueries({ queryKey: ["dashboard"] }),
]);

function csv(lines: (string | number)[][], name: string) {
  const esc = (v: unknown) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s; };
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["﻿" + lines.map((l) => l.map(esc).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ------------------------------------------------------------ receipt form */

export function ReceiptDialog({ onClose, merchantId: presetMill, loadId: presetLoad, editing }: {
  onClose: () => void; merchantId?: string; loadId?: string; editing?: ReceiptRow | null;
}) {
  const { t, pick } = useI18n();
  const f = useFormat();
  const qc = useQueryClient();
  const ask = useConfirm();
  const mills = useQuery({ queryKey: ["merchants"], queryFn: () => api.get<Merchant[]>("/merchants") });
  const [v, setV] = useState(() => ({
    merchantId: editing?.merchantId ?? presetMill ?? "",
    receiptDate: editing?.receiptDate ?? todayISO(),
    amount: editing ? editing.amountPaise / 100 : null as number | null,
    held: editing ? (editing.deductionPaise ? editing.deductionPaise / 100 : null) : null as number | null,
    heldNote: editing?.deductionNote ?? "",
    mode: (editing?.mode ?? "bank") as Mode,
    reference: editing?.reference ?? "",
    notes: editing?.notes ?? "",
    loadId: editing?.loadId ?? presetLoad ?? "",
  }));
  const [err, setErr] = useState<string | null>(null);
  const st = useQuery({
    queryKey: ["mill-ledger", v.merchantId, "for-receipt"],
    queryFn: () => api.get<MillStatement>(`/mill-ledger/${v.merchantId}`),
    enabled: Boolean(v.merchantId),
  });
  const amountPaise = v.amount == null ? 0 : Math.round(v.amount * 100);
  const heldPaise = v.held == null ? 0 : Math.round(v.held * 100);
  // what is owed now, not counting this receipt if it is the one being edited
  const back = editing && editing.merchantId === v.merchantId ? editing.amountPaise + editing.deductionPaise : 0;
  const now = st.data ? st.data.totals.closingPaise + back : null;
  const bill = st.data?.bills.find((b) => b.loadId === v.loadId);

  const save = useMutation({
    mutationFn: () => {
      const body = {
        merchantId: v.merchantId, receiptDate: v.receiptDate, amountPaise, deductionPaise: heldPaise,
        deductionNote: v.heldNote.trim() || null, mode: v.mode, reference: v.reference.trim() || null,
        notes: v.notes.trim() || null, loadId: v.loadId || null,
      };
      return editing ? api.put(`/mill-receipts/${editing.id}`, body) : api.post("/mill-receipts", body);
    },
    onSuccess: async () => { await invalidateMillMoney(qc); onClose(); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });

  return (
    <Dialog open wide onClose={onClose} title={editing ? t("mm.editReceipt") : t("mm.receive")} sub={t("mm.receiveSub")}
      footer={<>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant="primary" loading={save.isPending}
          disabled={!v.merchantId || !v.receiptDate || amountPaise < 0 || heldPaise < 0 || amountPaise + heldPaise <= 0}
          onClick={async () => {
            setErr(null);
            const m = mills.data?.find((x) => x.id === v.merchantId);
            if (await ask({
              title: editing ? t("mm.confirmEditTitle") : t("mm.confirmTitle"),
              rows: [
                { label: t("load.mill"), value: m ? `${m.code} — ${pick(m.name, m.nameHi)}` : "—" },
                { label: t("pay.date"), value: v.receiptDate.split("-").reverse().join("-") },
                { label: t("pay.mode"), value: t(`mm.mode.${v.mode}` as "mm.mode.bank") },
                ...(bill ? [{ label: t("parcha.no"), value: `#${bill.parchaNo}${bill.truckNo ? ` · ${bill.truckNo}` : ""}` }] : []),
                ...(heldPaise ? [{ label: t("mm.heldShort"), value: f.money(heldPaise) }] : []),
                { label: t("mm.amountIn"), value: f.money(amountPaise), big: true },
              ],
            })) save.mutate();
          }}>{t("common.save")}</Button>
      </>}>
      {err && <Alert tone="bad" className="mb-3">{err}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("load.mill")} required>
          <Select value={v.merchantId} autoFocus={!v.merchantId}
            onChange={(e) => setV((p) => ({ ...p, merchantId: e.target.value, loadId: "" }))}>
            <option value="">—</option>
            {mills.data?.map((m) => <option key={m.id} value={m.id}>{m.code} — {pick(m.name, m.nameHi)}</option>)}
          </Select>
        </Field>
        <Field label={t("pay.date")} required>
          <Input type="date" value={v.receiptDate} onChange={(e) => setV((p) => ({ ...p, receiptDate: e.target.value }))} />
        </Field>
        <Field label={t("mm.amountIn")} required hint={t("mm.amountInHint")}>
          <NumberInput value={v.amount} decimals={2} onValueChange={(n) => setV((p) => ({ ...p, amount: n }))} autoFocus={Boolean(v.merchantId)}
            className="h-9.5 w-full rounded-lg border bg-surface px-3 text-right text-sm tabular-nums text-ink focus:border-brand" placeholder="0.00" />
        </Field>
        <Field label={t("pay.mode")}>
          <Select value={v.mode} onChange={(e) => setV((p) => ({ ...p, mode: e.target.value as Mode }))}>
            {RECEIPT_MODES.map((m) => <option key={m} value={m}>{t(`mm.mode.${m}`)}</option>)}
          </Select>
        </Field>
        <Field label={t("mm.held")} hint={t("mm.heldHint")}>
          <NumberInput value={v.held} decimals={2} onValueChange={(n) => setV((p) => ({ ...p, held: n }))}
            className="h-9.5 w-full rounded-lg border bg-surface px-3 text-right text-sm tabular-nums text-ink focus:border-brand" placeholder="0.00" />
        </Field>
        <Field label={t("mm.heldNote")}>
          <Input value={v.heldNote} placeholder={t("mm.heldNotePh")} onChange={(e) => setV((p) => ({ ...p, heldNote: e.target.value }))} />
        </Field>
        <Field label={t("mm.against")} hint={t("mm.againstHint")} className="sm:col-span-2">
          <Select value={v.loadId} disabled={!st.data} onChange={(e) => setV((p) => ({ ...p, loadId: e.target.value }))}>
            <option value="">{t("mm.againstNone")}</option>
            {st.data?.bills.map((b) => (
              <option key={b.loadId} value={b.loadId}>
                #{b.parchaNo} · {dmy(b.date)}{b.truckNo ? ` · ${b.truckNo}` : ""} · {t("mm.dueOn", { amt: f.money(b.duePaise + (editing?.loadId === b.loadId ? back : 0)) })}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("pay.reference")} hint={t("pay.referenceHelp")}>
          <Input value={v.reference} onChange={(e) => setV((p) => ({ ...p, reference: e.target.value }))} />
        </Field>
        <Field label={t("adati.notes")}>
          <Textarea value={v.notes} rows={1} onChange={(e) => setV((p) => ({ ...p, notes: e.target.value }))} />
        </Field>
      </div>
      {now != null && (
        <div className="mt-4 grid grid-cols-3 gap-2 rounded-lg border border-line bg-raised/40 p-3 text-[13px]">
          <div><p className="text-[11px] text-faint">{t("mm.owesNow")}</p><MillBalance paise={now} /></div>
          <div><p className="text-[11px] text-faint">{t("mm.thisReceipt")}</p><span className="num">− {f.money(amountPaise + heldPaise)}</span></div>
          <div><p className="text-[11px] text-faint">{t("mm.owesAfter")}</p><MillBalance paise={now - amountPaise - heldPaise} className="font-semibold" /></div>
          {bill && (
            <p className="col-span-3 text-[12px] text-muted">
              {t("mm.billAfter", { no: bill.parchaNo, amt: f.money(bill.duePaise + (editing?.loadId === bill.loadId ? back : 0) - amountPaise - heldPaise) })}
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}

/* ------------------------------------------------------------ list page */

export function MillLedgerPage() {
  const { t, pick } = useI18n();
  const f = useFormat();
  const { can } = useSession();
  const [, navigate] = useLocation();
  const [tab, setTab] = useState<"balances" | "receipts">("balances");
  const [receiving, setReceiving] = useState(false);
  const list = useQuery({ queryKey: ["mill-ledger", "all"], queryFn: () => api.get<MillLedgerList>("/mill-ledger") });
  const rows = list.data?.rows ?? [];
  const s = useSort(rows, {
    mill: (r) => r.code, opening: (r) => r.openingBalancePaise, parchas: (r) => r.parchas, billed: (r) => r.billedPaise,
    received: (r) => r.receivedPaise, held: (r) => r.deductedPaise + r.shortagePaise, owes: (r) => r.balancePaise, last: (r) => r.lastReceipt,
  }, { storageKey: "mill-ledger" });

  return (
    <div>
      <PageHeader title={t("mm.title")} sub={t("mm.sub")}
        action={can("millreceipt.write") && (
          <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setReceiving(true)}>{t("mm.receive")}</Button>
        )} />
      {list.data && (
        <div className="mb-4 grid gap-3 sm:grid-cols-3">
          <Card className="p-3"><p className="text-[12px] text-muted">{t("mm.totalToReceive")}</p><p className="num text-lg font-semibold text-brand">{f.money(list.data.totals.toReceivePaise)}</p></Card>
          <Card className="p-3"><p className="text-[12px] text-muted">{t("mm.totalAhead")}</p><p className="num text-lg font-semibold text-warn">{f.money(list.data.totals.paidAheadPaise)}</p></Card>
          <Card className="p-3"><p className="text-[12px] text-muted">{t("mm.proof")}</p>
            <p className="num text-[13px]">{f.money(list.data.totals.openingPaise)} + {f.money(list.data.totals.billedPaise)} − {f.money(list.data.totals.shortagePaise)} − {f.money(list.data.totals.receivedPaise)} − {f.money(list.data.totals.deductedPaise)} = <b>{f.money(list.data.totals.balancePaise)}</b></p></Card>
        </div>
      )}
      <Tabs value={tab} onChange={setTab} className="mb-3"
        tabs={[{ value: "balances", label: t("mm.tabBalances") }, { value: "receipts", label: t("mm.tabReceipts") }]} />
      {tab === "balances" ? (
        <Card>
          {list.isPending ? <SkeletonTable rows={5} /> : list.isError ? <LoadError error={list.error} onRetry={() => void list.refetch()} /> : !rows.length ? (
            <EmptyState icon={<Landmark className="h-5 w-5" />} title={t("mm.empty")} sub={t("mm.emptySub")} />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th {...s.th("mill")}>{t("load.mill")}</Th>
                  <Th numeric {...s.th("opening")}>{t("ledger.opening")}</Th>
                  <Th numeric {...s.th("parchas")}>{t("mm.parchas")}</Th>
                  <Th numeric {...s.th("billed")}>{t("mm.billed")}</Th>
                  <Th numeric {...s.th("received")}>{t("mm.received")}</Th>
                  <Th numeric {...s.th("held")} title={t("mm.cutAndHeldHint")}>{t("mm.cutAndHeld")}</Th>
                  <Th numeric {...s.th("owes")}>{t("mm.owes")}</Th>
                  <Th {...s.th("last")}>{t("mm.lastReceipt")}</Th>
                </tr>
              </thead>
              <tbody>
                {s.sorted.map((r) => (
                  <Tr key={r.id} onClick={() => navigate(`/mill-accounts/${r.id}`)}>
                    <Td><span className="flex items-center gap-2"><Badge tone="brand" className="num">{r.code}</Badge>{pick(r.name, r.nameHi)}</span></Td>
                    <Td numeric className="text-muted">{r.openingBalancePaise ? f.money(r.openingBalancePaise) : "—"}</Td>
                    <Td numeric>{r.parchas}</Td>
                    <Td numeric>{f.money(r.billedPaise)}</Td>
                    <Td numeric className="text-ok">{f.money(r.receivedPaise)}</Td>
                    <Td numeric className="text-muted">{r.deductedPaise + r.shortagePaise ? f.money(r.deductedPaise + r.shortagePaise) : "—"}</Td>
                    <Td numeric><MillBalance paise={r.balancePaise} className="font-semibold" /></Td>
                    <Td className="text-[12px] text-muted">{r.lastReceipt ? dmy(r.lastReceipt) : "—"}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      ) : <ReceiptsList />}
      {receiving && <ReceiptDialog onClose={() => setReceiving(false)} />}
    </div>
  );
}

export function ReceiptsList({ merchantId }: { merchantId?: string }) {
  const { t, pick } = useI18n();
  const f = useFormat();
  const { can } = useSession();
  const qc = useQueryClient();
  // the chosen financial year, until other dates are picked
  const { from, setFrom, to, setTo } = useFYRange();
  const [showVoid, setShowVoid] = useState(false);
  const [editing, setEditing] = useState<ReceiptRow | null>(null);
  const [voiding, setVoiding] = useState<ReceiptRow | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const qs = new URLSearchParams();
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);
  if (merchantId) qs.set("merchantId", merchantId);
  if (showVoid) qs.set("showVoid", "1");
  const recFlags = useTallyFlags("receipt", from || "2000-01-01", to || "2099-12-31");
  const list = useQuery({
    queryKey: ["mill-receipts", qs.toString()],
    queryFn: () => api.get<{ rows: ReceiptRow[]; truncated?: boolean; totals: { count: number; amountPaise: number; deductionPaise: number } }>(`/mill-receipts?${qs}`),
  });
  const voidIt = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => api.post(`/mill-receipts/${id}/void`, { reason }),
    onSuccess: async () => { setVoiding(null); setErr(null); await invalidateMillMoney(qc); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });
  const rows = list.data?.rows ?? [];
  const s = useSort(rows, {
    date: (r) => r.receiptDate, mill: (r) => r.millCode, parcha: (r) => r.parchaNo, mode: (r) => r.mode,
    amount: (r) => r.amountPaise, held: (r) => r.deductionPaise, by: (r) => r.createdByName,
  }, { storageKey: "mill-receipts" });

  return (
    <Card>
      <div className="flex flex-wrap items-end gap-3 border-b border-line p-3">
        <Field label={t("load.from")} className="w-40"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8 text-[13px]" /></Field>
        <Field label={t("load.to")} className="w-40"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-8 text-[13px]" /></Field>
        <div className="pb-1.5"><Checkbox checked={showVoid} onChange={setShowVoid} label={t("money.showCancelled")} /></div>
      </div>
      {err && <Alert tone="bad" className="m-3">{err}</Alert>}
      {list.isPending ? <SkeletonTable rows={5} /> : list.isError ? <LoadError error={list.error} onRetry={() => void list.refetch()} /> : !rows.length ? (
        <EmptyState icon={<Landmark className="h-5 w-5" />} title={t("mm.noReceipts")} />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th {...s.th("date")}>{t("pay.date")}</Th>
              <Th>{t("pay.voucherNo")}</Th>
              {!merchantId && <Th {...s.th("mill")}>{t("load.mill")}</Th>}
              <Th {...s.th("parcha")}>{t("mm.against")}</Th>
              <Th {...s.th("mode")}>{t("pay.mode")}</Th>
              <Th>{t("pay.reference")}</Th>
              <Th numeric {...s.th("amount")}>{t("mm.received")}</Th>
              <Th numeric {...s.th("held")}>{t("mm.heldShort")}</Th>
              <Th {...s.th("by")}>{t("pay.by")}</Th>
              <Th className="w-20" />
            </tr>
          </thead>
          <tbody>
            {s.sorted.map((r) => (
              <Tr key={r.id} className={cn(r.voidedAt && "opacity-60")}>
                <Td className={cn("whitespace-nowrap", r.voidedAt && "line-through")}>{dmy(r.receiptDate)} <TallyMark flag={recFlags[r.id]} /></Td>
                <Td className="num whitespace-nowrap text-muted">{r.voucherNo ? `RV-${r.voucherNo}` : "—"}</Td>
                {!merchantId && <Td><span className="flex items-center gap-2"><Badge className="num">{r.millCode}</Badge>{pick(r.millName, r.millNameHi)}</span></Td>}
                <Td className="text-[12px]">{r.parchaNo ? <>#{r.parchaNo}{r.truckNo ? <span className="text-muted"> · {r.truckNo}</span> : null}</> : <span className="text-faint">{t("mm.onAccount")}</span>}</Td>
                <Td><Badge>{t(`mm.mode.${r.mode}`)}</Badge></Td>
                <Td className="text-muted">{r.reference ?? ""}{r.notes ? <span className="block text-[11px] text-faint">{r.notes}</span> : null}
                  {r.voidedAt && <span className="block text-[11px] text-bad">{t("money.cancelledBecause", { why: r.voidReason ?? "" })}</span>}</Td>
                <Td numeric className={cn("font-medium", r.voidedAt && "line-through")}>{f.money(r.amountPaise)}</Td>
                <Td numeric className="text-muted" title={r.deductionNote ?? undefined}>{r.deductionPaise ? f.money(r.deductionPaise) : "—"}{r.deductionNote ? <span className="block text-[10px]">{r.deductionNote}</span> : null}</Td>
                <Td className="text-[12px] text-muted">{r.createdByName ?? ""}</Td>
                <Td className="whitespace-nowrap text-right">
                  {r.voidedAt ? <Badge tone="bad">{t("money.cancelled")}</Badge> : can("millreceipt.write") && (
                    <>
                      <Button variant="ghost" size="icon" title={t("common.edit")} onClick={() => setEditing(r)}><Pencil className="h-3.5 w-3.5" /></Button>
                      <Button variant="ghost" size="icon" title={t("money.cancel")} onClick={() => { setErr(null); setVoiding(r); }}><Ban className="h-3.5 w-3.5 text-bad" /></Button>
                    </>
                  )}
                </Td>
              </Tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="bg-raised/50 text-[13px] font-semibold">
              <td className="px-3 py-2" colSpan={merchantId ? 4 : 5}>{t("mm.totalN", { n: list.data!.totals.count })}</td>
              <td className="num px-3 py-2 text-right">{f.money(list.data!.totals.amountPaise)}</td>
              <td className="num px-3 py-2 text-right">{f.money(list.data!.totals.deductionPaise)}</td>
              <td colSpan={2} />
            </tr>
          </tfoot>
        </Table>
      )}
      {list.data?.truncated && <p className="border-t border-line px-3 py-2 text-[11px] text-faint">{t("common.truncated", { n: list.data.rows.length })}</p>}
      {editing && <ReceiptDialog onClose={() => setEditing(null)} editing={editing} />}
      {voiding && (
        <ReasonDialog title={t("mm.cancelTitle", { amt: f.money(voiding.amountPaise + voiding.deductionPaise) })} sub={t("mm.cancelSub")}
          confirmLabel={t("money.confirmCancel")} busy={voidIt.isPending} error={err}
          onClose={() => setVoiding(null)} onConfirm={(reason) => voidIt.mutate({ id: voiding.id, reason })} />
      )}
    </Card>
  );
}

/* ------------------------------------------------------------ one mill */

export function MillStatementPage({ id }: { id: string }) {
  const { t, pick } = useI18n();
  const f = useFormat();
  const { can } = useSession();
  const qc = useQueryClient();
  // the chosen financial year, until other dates are picked
  const { from, setFrom, to, setTo } = useFYRange();
  const [receiving, setReceiving] = useState<null | { loadId?: string; editing?: ReceiptRow }>(null);
  const [voiding, setVoiding] = useState<MillEntry | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const qs = new URLSearchParams();
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);
  const st = useQuery({ queryKey: ["mill-ledger", id, qs.toString()], queryFn: () => api.get<MillStatement>(`/mill-ledger/${id}?${qs}`) });
  const voidIt = useMutation({
    mutationFn: ({ rid, reason }: { rid: string; reason: string }) => api.post(`/mill-receipts/${rid}/void`, { reason }),
    onSuccess: async () => { setVoiding(null); setErr(null); await invalidateMillMoney(qc); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });
  const s = st.data;
  const bills = useSort(s?.bills ?? [], {
    no: (b) => b.parchaNo, date: (b) => b.date, truck: (b) => b.truckNo, total: (b) => b.grandTotalPaise,
    received: (b) => b.receivedPaise, due: (b) => b.duePaise,
  }, { storageKey: "mill-bills" });
  const dueTotal = useMemo(() => (s?.bills ?? []).reduce((x, b) => x + Math.max(0, b.duePaise), 0), [s]);

  const asRow = (e: MillEntry): ReceiptRow => ({
    id: e.id, merchantId: id, loadId: e.loadId ?? null, receiptDate: e.date, amountPaise: e.amountPaise ?? 0,
    deductionPaise: e.deductionPaise ?? 0, deductionNote: e.deductionNote ?? null, mode: e.mode ?? "bank",
    reference: e.reference ?? null, notes: e.notes ?? null, voidedAt: null, voidReason: null,
    millCode: s?.mill.code ?? "", millName: s?.mill.name ?? "", millNameHi: s?.mill.nameHi ?? null,
    truckNo: e.truckNo ?? null, parchaNo: e.parchaNo ?? null, createdByName: null,
  });

  const download = () => {
    if (!s) return;
    csv([
      [`Mill account: ${s.mill.code} ${s.mill.name}`],
      [s.from || s.to ? `Period: ${s.from ? dmy(s.from) : "start"} to ${s.to ? dmy(s.to) : "today"}` : "All time"],
      [],
      ["Date", "Particulars", "Net qtl", "Billed", "Received", "Cut / held back", "Balance (mill owes)"],
      ["", s.from ? "Brought forward" : "Opening balance", "", "", "", "", (s.broughtForwardPaise / 100).toFixed(2)],
      ...s.entries.map((e) => [
        dmy(e.date),
        e.kind === "parcha" ? `Parcha #${e.parchaNo}${e.truckNo ? ` · ${e.truckNo}` : ""}`
          : e.kind === "shortage" ? `Mill cut on #${e.parchaNo} · ${fmtQtl(e.deductionGrams ?? 0)} qtl${e.deductionNote ? ` · ${e.deductionNote}` : ""}`
          : `${e.voucherNo ? `RV-${e.voucherNo} · ` : ""}Receipt · ${e.mode}${e.reference ? ` · ${e.reference}` : ""}${e.parchaNo ? ` · for #${e.parchaNo}` : ""}${e.voided ? ` · CANCELLED (${e.voidReason ?? ""})` : ""}`,
        e.netGrams != null ? fmtQtl(e.netGrams) : "",
        e.debitPaise ? (e.debitPaise / 100).toFixed(2) : "",
        e.kind === "receipt" && !e.voided ? ((e.amountPaise ?? 0) / 100).toFixed(2) : "",
        e.kind === "receipt" && !e.voided && e.deductionPaise ? (e.deductionPaise / 100).toFixed(2) : e.kind === "shortage" ? (e.creditPaise / 100).toFixed(2) : "",
        (e.balancePaise / 100).toFixed(2),
      ]),
      ["", "Total", "", (s.totals.billedPaise / 100).toFixed(2), (s.totals.receivedPaise / 100).toFixed(2), ((s.totals.deductedPaise + s.totals.shortagePaise) / 100).toFixed(2), (s.totals.closingPaise / 100).toFixed(2)],
    ], `mill-${s.mill.code}${s.from ? `-${s.from}` : ""}${s.to ? `-to-${s.to}` : ""}.csv`);
  };
  const print = () => {
    document.body.classList.add("print-parcha");
    const done = () => { document.body.classList.remove("print-parcha"); window.removeEventListener("afterprint", done); };
    window.addEventListener("afterprint", done);
    window.print();
    setTimeout(done, 1000);
  };

  return (
    <div>
      <Link href="/mill-accounts" className="mb-2 inline-flex items-center gap-1 text-[12px] text-muted hover:text-ink">
        <ArrowLeft className="h-3.5 w-3.5" />{t("mm.allMills")}
      </Link>
      <PageHeader
        title={s ? <span className="flex items-center gap-2"><Badge tone="brand" className="num">{s.mill.code}</Badge>{pick(s.mill.name, s.mill.nameHi)}</span> : "…"}
        sub={t("mm.statementSub")}
        action={
          <div className="no-print flex flex-wrap gap-2">
            <Link href={`/stock/${id}`}><Button size="sm">{t("mm.stockLink")}</Button></Link>
            {can("export.data") && <Button size="sm" icon={<Download className="h-3.5 w-3.5" />} onClick={download} disabled={!s}>CSV</Button>}
            <Button size="sm" icon={<Printer className="h-3.5 w-3.5" />} onClick={print} disabled={!s}>{t("parcha.print")}</Button>
            {can("millreceipt.write") && <Button size="sm" variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setReceiving({})}>{t("mm.receive")}</Button>}
          </div>
        } />
      {err && <Alert tone="bad" className="mb-3">{err}</Alert>}
      {st.isPending ? <Card><SkeletonTable rows={8} /></Card> : !s ? <Card><EmptyState title={t("common.somethingWrong")} /></Card> : (
        <>
          <Card className="mb-4">
            <div className="no-print flex flex-wrap items-end gap-3 border-b border-line p-3">
              <Field label={t("load.from")} className="w-40"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8 text-[13px]" /></Field>
              <Field label={t("load.to")} className="w-40"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-8 text-[13px]" /></Field>
              {(from || to) && <Button size="sm" variant="ghost" onClick={() => { setFrom(""); setTo(""); }}>{t("ledger.allTime")}</Button>}
            </div>
            <div className="print-area bg-surface">
              <div className="hidden px-4 pt-4 print:block">
                <p className="text-[16px] font-bold">{s.mill.code} — {s.mill.name}</p>
                <p className="text-[12px]">{s.from || s.to ? `${s.from ? dmy(s.from) : "…"} – ${s.to ? dmy(s.to) : dmy(todayISO())}` : t("ledger.allTime")}</p>
              </div>
              <div className="grid grid-cols-2 gap-px border-b border-line bg-line lg:grid-cols-5">
                {[
                  [s.from ? t("ledger.broughtForward") : t("ledger.opening"), <MillBalance key="a" paise={s.broughtForwardPaise} />],
                  [t("mm.billed"), <span key="b" className="num">{f.money(s.totals.billedPaise)}</span>],
                  [t("mm.received"), <span key="c" className="num text-ok">{f.money(s.totals.receivedPaise)}</span>],
                  [t("mm.cutAndHeld"), <span key="d" className="num">{f.money(s.totals.deductedPaise + s.totals.shortagePaise)}</span>],
                  [t("mm.owes"), <MillBalance key="e" paise={s.totals.closingPaise} className="font-semibold" />],
                ].map(([label, value], i) => (
                  <div key={i} className="bg-surface px-4 py-2.5"><p className="text-[11px] text-faint">{label}</p><p className="text-[14px]">{value}</p></div>
                ))}
              </div>
              <Table>
                <thead>
                  <tr>
                    <Th>{t("daily.date")}</Th><Th className="min-w-[18rem]">{t("ledger.particulars")}</Th><Th numeric>{t("load.net")}</Th>
                    <Th numeric>{t("mm.billed")}</Th><Th numeric>{t("mm.received")}</Th><Th numeric>{t("mm.cutAndHeld")}</Th>
                    <Th numeric>{t("ledger.balance")}</Th><Th className="no-print w-16" />
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b border-line/70 bg-raised/30 text-[13px]">
                    <td className="px-3 py-1.5" />
                    <td className="px-3 py-1.5 text-muted">{s.from ? t("ledger.broughtForward") : t("ledger.opening")}</td>
                    <td colSpan={4} />
                    <td className="px-3 py-1.5 text-right"><MillBalance paise={s.broughtForwardPaise} /></td>
                    <td className="no-print" />
                  </tr>
                  {s.entries.map((e) => (
                    <Tr key={`${e.kind}-${e.id}`} className={cn(e.voided && "opacity-60")}>
                      <Td className="whitespace-nowrap">{dmy(e.date)}</Td>
                      {e.kind === "parcha" ? (
                        <Td><Link href="/parcha" className="font-medium text-ink hover:text-brand">{t("mm.parchaN", { no: e.parchaNo ?? "" })}</Link>
                          {e.version && e.version > 1 ? <span className="text-faint"> v{e.version}</span> : null}
                          {e.truckNo ? <span className="text-muted"> · {e.truckNo}</span> : null}</Td>
                      ) : e.kind === "shortage" ? (
                        <Td className="text-warn"><Link href="/challan" className="hover:underline">{t("mm.cutOn", { no: e.parchaNo ?? "", q: f.weight(e.deductionGrams ?? 0) })}</Link>
                          {e.deductionNote ? <span className="text-faint"> · {e.deductionNote}</span> : null}</Td>
                      ) : (
                        <Td className="text-ok">
                          <span className={cn(e.voided && "line-through")}>
                            {e.voucherNo ? <span className="num">RV-{e.voucherNo} · </span> : null}{t("mm.receipt")} · {t(`mm.mode.${e.mode ?? "bank"}`)}{e.reference ? <span className="text-muted"> · {e.reference}</span> : null}
                            {e.parchaNo ? <span className="text-muted"> · {t("mm.forParcha", { no: e.parchaNo })}</span> : null}
                            {e.deductionNote ? <span className="text-faint"> · {e.deductionNote}</span> : null}
                          </span>
                          {e.voided && <span className="block text-[11px] text-bad">{t("money.cancelledBecause", { why: e.voidReason ?? "" })}</span>}
                        </Td>
                      )}
                      <Td numeric className="text-muted">{e.netGrams ? f.weight(e.netGrams) : ""}</Td>
                      <Td numeric>{e.debitPaise ? f.amount(e.debitPaise) : ""}</Td>
                      <Td numeric className={cn("text-ok", e.voided && "line-through")}>{e.kind === "receipt" && e.amountPaise ? f.amount(e.amountPaise) : ""}</Td>
                      <Td numeric className={cn("text-muted", e.voided && "line-through")}>{e.kind === "receipt" && e.deductionPaise ? f.amount(e.deductionPaise) : e.kind === "shortage" ? f.amount(e.creditPaise) : ""}</Td>
                      <Td numeric><MillBalance paise={e.balancePaise} /></Td>
                      <Td className="no-print whitespace-nowrap text-right">
                        {e.kind === "receipt" && !e.voided && can("millreceipt.write") && (
                          <>
                            <Button variant="ghost" size="icon" title={t("common.edit")} onClick={() => setReceiving({ editing: asRow(e) })}><Pencil className="h-3.5 w-3.5" /></Button>
                            <Button variant="ghost" size="icon" title={t("money.cancel")} onClick={() => { setErr(null); setVoiding(e); }}><Ban className="h-3.5 w-3.5 text-bad" /></Button>
                          </>
                        )}
                        {e.voided && <Badge tone="bad">{t("money.cancelled")}</Badge>}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-raised/50 text-[13px] font-semibold">
                    <td className="px-3 py-2" colSpan={3}>{t("load.total")}</td>
                    <td className="num px-3 py-2 text-right">{f.amount(s.totals.billedPaise)}</td>
                    <td className="num px-3 py-2 text-right">{f.amount(s.totals.receivedPaise)}</td>
                    <td className="num px-3 py-2 text-right">{f.amount(s.totals.deductedPaise + s.totals.shortagePaise)}</td>
                    <td className="px-3 py-2 text-right"><MillBalance paise={s.totals.closingPaise} /></td>
                    <td className="no-print" />
                  </tr>
                </tfoot>
              </Table>
            </div>
          </Card>

          <Card>
            <CardHeader title={t("mm.billsTitle", { n: s.bills.length })} sub={t("mm.billsSub", { amt: f.money(dueTotal) })} />
            {!s.bills.length ? <EmptyState title={t("mm.noBills")} /> : (
              <Table>
                <thead>
                  <tr>
                    <Th {...bills.th("no")}>{t("load.parchaNo")}</Th><Th {...bills.th("date")}>{t("daily.date")}</Th>
                    <Th {...bills.th("truck")}>{t("load.truckNo")}</Th><Th numeric {...bills.th("total")}>{t("load.grandTotal")}</Th>
                    <Th numeric>{t("mm.cutShort")}</Th>
                    <Th numeric {...bills.th("received")} title={t("mm.settledHint")}>{t("mm.settled")}</Th><Th numeric {...bills.th("due")}>{t("mm.due")}</Th>
                    <Th className="w-28" />
                  </tr>
                </thead>
                <tbody>
                  {bills.sorted.map((b) => (
                    <Tr key={b.loadId}>
                      <Td className="font-medium">#{b.parchaNo}</Td>
                      <Td className="whitespace-nowrap">{dmy(b.date)}</Td>
                      <Td className="text-muted">{b.truckNo ?? ""}</Td>
                      <Td numeric>{f.money(b.grandTotalPaise)}</Td>
                      <Td numeric className="whitespace-nowrap text-warn">{b.shortagePaise ? `− ${f.money(b.shortagePaise)}` : "—"}</Td>
                      <Td numeric className="text-ok">{b.receivedPaise ? f.money(b.receivedPaise) : "—"}</Td>
                      <Td numeric className="font-semibold">
                        {b.duePaise <= 0 ? <Badge tone="ok">{b.duePaise < 0 ? t("mm.overpaid", { amt: f.money(-b.duePaise) }) : t("mm.paid")}</Badge>
                          : <span className={cn(b.receivedPaise > 0 && "text-warn")}>{f.money(b.duePaise)}</span>}
                      </Td>
                      <Td className="text-right">
                        {b.duePaise > 0 && can("millreceipt.write") && (
                          <Button size="sm" variant="ghost" onClick={() => setReceiving({ loadId: b.loadId })}>{t("mm.receiveShort")}</Button>
                        )}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </>
      )}
      {receiving && <ReceiptDialog onClose={() => setReceiving(null)} merchantId={id} loadId={receiving.loadId} editing={receiving.editing ?? null} />}
      {voiding && (
        <ReasonDialog title={t("mm.cancelTitle", { amt: f.money((voiding.amountPaise ?? 0) + (voiding.deductionPaise ?? 0)) })} sub={t("mm.cancelSub")}
          confirmLabel={t("money.confirmCancel")} busy={voidIt.isPending} error={err}
          onClose={() => setVoiding(null)} onConfirm={(reason) => voidIt.mutate({ rid: voiding.id, reason })} />
      )}
    </div>
  );
}
