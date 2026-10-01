import { useEffect, useMemo, useRef, useState } from "react";
import { useFYRange } from "@/lib/fy.tsx";
import { TallyMark, useTallyFlags } from "@/components/TallyMark.tsx";
import { Link, useLocation, useSearch } from "wouter";
import { useQuery, useQueries, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Plus, Truck, ArrowLeft, Printer, FileSpreadsheet, CheckCircle2, Ban, Trash2, X, AlertTriangle,
  CircleAlert, FileText, Scale, PackagePlus, Eye,
} from "lucide-react";
import {
  api, ApiError, apiStatus, type Merchant, type Jins, type OrderRow, type LoadListRow, type LoadState,
  type ParchaRegisterRow, type LoadBlocker, type LoadWarning, type ParchaDoc, type StockDay, type StockMillDay,
} from "@/lib/api.ts";
import { useI18n } from "@/lib/i18n.tsx";
import { useSort } from "@/lib/useSort.ts";
import { useSession } from "@/lib/session.tsx";
import { useFormat } from "@/lib/format.tsx";
import { PageHeader } from "@/components/AppShell.tsx";
import { NumberInput } from "@/components/NumberInput.tsx";
import { ParchaPaper } from "@/components/ParchaPaper.tsx";
import { SkeletonTable, SkeletonForm } from "@/components/Skeletons.tsx";
import { Button, Card, CardHeader, Field, Input, Select, Table, Th, Td, Tr, Badge, Dialog, EmptyState, Alert, Checkbox, Textarea, Switch } from "@/components/ui/index.tsx";
import { LoadError } from "@/components/LoadError.tsx";
import { useConfirm } from "@/components/Confirm.tsx";
import { cn, todayISO } from "@/lib/utils.ts";
import { dmy, screenLines } from "@server/lib/parchaLabels.ts";
import { PoProgress, poName } from "@/pages/Orders.tsx";

const Q = 100_000;
const CELL = "h-9 w-full rounded-lg border bg-surface px-2.5 text-sm text-ink focus:border-brand disabled:bg-raised disabled:opacity-70";
const NUMCELL = cn(CELL, "text-right tabular-nums");

/* ------------------------------------------------------------ new load */

/** A day of the mill's stock, as the pickers show it. */
function dayLabel(f: ReturnType<typeof useFormat>, t: ReturnType<typeof useI18n>["t"], d: { date: string; leftGrams: number; avgRatePaisePerQtl: number }) {
  return `${dmy(d.date)} — ${t("load.leftShort", { q: f.weight(d.leftGrams) })}${d.avgRatePaisePerQtl ? ` · ${t("load.avgShort", { r: f.rate(d.avgRatePaisePerQtl) })}` : ""}`;
}

export function NewLoadDialog({ open, onClose, preset }: {
  open: boolean; onClose: () => void;
  preset?: { merchantId?: string | null; jinsId?: string; stockDate?: string };
}) {
  const { t, pick } = useI18n();
  const f = useFormat();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const mills = useQuery({ queryKey: ["merchants"], queryFn: () => api.get<Merchant[]>("/merchants") });
  const jins = useQuery({ queryKey: ["jins"], queryFn: () => api.get<Jins[]>("/jins") });
  const [v, setV] = useState(() => ({
    loadDate: todayISO(),
    merchantId: preset?.merchantId ?? "",
    jinsId: preset?.jinsId ?? "",
    stockDate: preset?.stockDate ?? "",
    poId: "",
    truckNo: "", transporter: "", driverPhone: "",
  }));
  const jinsId = v.jinsId || jins.data?.find((j) => j.code === "1509")?.id || jins.data?.[0]?.id || "";
  const pos = useQuery({
    queryKey: ["orders", v.merchantId, "open", jinsId],
    queryFn: () => api.get<OrderRow[]>(`/orders?merchantId=${v.merchantId}&status=open&jinsId=${jinsId}`),
    enabled: Boolean(v.merchantId && jinsId),
  });
  const stock = useQuery({
    queryKey: ["stock", v.merchantId, jinsId],
    queryFn: () => api.get<{ days: StockMillDay[] }>(`/stock/${v.merchantId}?jinsId=${jinsId}`),
    enabled: Boolean(v.merchantId && jinsId),
  });
  const days = (stock.data?.days ?? []).map((d) => ({ date: d.date, leftGrams: d.stockNet, avgRatePaisePerQtl: d.avgRatePaisePerQtl }));
  // the newest day with stock left is almost always the one being loaded
  useEffect(() => {
    if (!v.stockDate && days.length) setV((p) => ({ ...p, stockDate: (days.find((d) => d.leftGrams > 0) ?? days[0]).date }));
  }, [stock.data]);
  useEffect(() => {
    if (!v.poId && pos.data?.length === 1) setV((p) => ({ ...p, poId: pos.data![0].id }));
  }, [pos.data]);
  const [err, setErr] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => api.post<{ id: string }>("/loads", {
      loadDate: v.loadDate, merchantId: v.merchantId, jinsId, poId: v.poId || null,
      stockDate: v.stockDate || undefined,
      truckNo: v.truckNo || null, transporter: v.transporter || null, driverPhone: v.driverPhone || null,
    }),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ["loads"] });
      await qc.invalidateQueries({ queryKey: ["stock"] });
      onClose();
      navigate(`/loads/${r.id}`);
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });

  return (
    <Dialog open={open} onClose={onClose} title={t("load.new")} sub={t("load.newSub")}
      footer={<>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant="primary" loading={create.isPending} disabled={!v.merchantId || !jinsId}
          onClick={() => { setErr(null); create.mutate(); }}>{t("load.create")}</Button>
      </>}>
      {err && <Alert tone="bad" className="mb-3">{err}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("load.date")} required>
          <Input type="date" value={v.loadDate} onChange={(e) => setV((p) => ({ ...p, loadDate: e.target.value }))} />
        </Field>
        <Field label={t("load.truckNo")}>
          <Input value={v.truckNo} mono className="uppercase" placeholder="UP25CT5038" autoFocus
            onChange={(e) => setV((p) => ({ ...p, truckNo: e.target.value.toUpperCase() }))} />
        </Field>
        <Field label={t("load.mill")} required>
          <Select value={v.merchantId} onChange={(e) => setV((p) => ({ ...p, merchantId: e.target.value, poId: "", stockDate: "" }))}>
            <option value="">{t("load.pickMill")}</option>
            {mills.data?.map((m) => <option key={m.id} value={m.id}>{m.code} — {pick(m.name, m.nameHi)}</option>)}
          </Select>
        </Field>
        <Field label={t("load.jins")} required>
          <Select value={jinsId} onChange={(e) => setV((p) => ({ ...p, jinsId: e.target.value, poId: "", stockDate: "" }))}>
            {jins.data?.map((j) => <option key={j.id} value={j.id}>{j.code} — {pick(j.name, j.nameHi)}</option>)}
          </Select>
        </Field>
        <Field label={t("load.fromDay")} hint={t("load.fromDayHelp")} className="sm:col-span-2">
          <Select value={v.stockDate} disabled={!v.merchantId} onChange={(e) => setV((p) => ({ ...p, stockDate: e.target.value }))}>
            {!days.length && <option value="">{v.merchantId ? t("load.noStockYet") : t("load.pickMill")}</option>}
            {days.map((d) => <option key={d.date} value={d.date}>{dayLabel(f, t, d)}</option>)}
          </Select>
        </Field>
        <Field label={t("load.po")} hint={v.merchantId && pos.data && !pos.data.length ? t("load.noOpenPo") : t("common.optional")} className="sm:col-span-2">
          <Select value={v.poId} disabled={!v.merchantId} onChange={(e) => setV((p) => ({ ...p, poId: e.target.value }))}>
            <option value="">{t("load.noPo")}</option>
            {pos.data?.map((o) => (
              <option key={o.id} value={o.id}>
                {o.poNo ? `PO ${o.poNo} · ${dmy(o.poDate)}` : poName(t, o)} · {t("po.balance")} {f.weight(o.balanceGrams)} {f.unit}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("load.transporter")}>
          <Input value={v.transporter} onChange={(e) => setV((p) => ({ ...p, transporter: e.target.value }))} />
        </Field>
        <Field label={t("load.driverPhone")}>
          <Input value={v.driverPhone} mono inputMode="tel" onChange={(e) => setV((p) => ({ ...p, driverPhone: e.target.value }))} />
        </Field>
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------------------ list */

export function LoadsPage() {
  const { t, pick } = useI18n();
  const f = useFormat();
  const { can } = useSession();
  const [, navigate] = useLocation();
  const search = new URLSearchParams(useSearch());
  const poId = search.get("poId") ?? "";
  const [mill, setMill] = useState("");
  const [status, setStatus] = useState<"" | "draft" | "billed">("");
  // the chosen financial year, until other dates are picked
  const { from, setFrom, to, setTo } = useFYRange();
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);

  const mills = useQuery({ queryKey: ["merchants"], queryFn: () => api.get<Merchant[]>("/merchants") });
  const qs = new URLSearchParams();
  if (mill) qs.set("merchantId", mill);
  if (status) qs.set("status", status);
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);
  if (q.trim()) qs.set("q", q.trim());
  if (poId) qs.set("poId", poId);
  const loads = useQuery({ queryKey: ["loads", qs.toString()], queryFn: () => api.get<LoadListRow[]>(`/loads?${qs}`) });
  const rows = loads.data ?? [];
  const sort = useSort(rows, {
    date: (r) => r.loadDate, truck: (r) => r.truckNo, mill: (r) => r.millCode, jins: (r) => r.jinsCode,
    from: (r) => r.stockDates[0], loaded: (r) => r.loadedGrams, net: (r) => r.millNetGrams,
    parcha: (r) => r.parcha?.parchaNo, total: (r) => r.parcha?.grandTotalPaise,
  }, { storageKey: "loads" });
  const billed = rows.filter((r) => r.parcha);
  // hidden from roles that may not read parchas (the server sends no totals then): a dash, not ₹0
  const totalBilled = can("parcha.read") ? billed.reduce((s, r) => s + (r.parcha?.grandTotalPaise ?? 0), 0) : null;

  return (
    <div>
      <PageHeader title={t("load.title")} sub={t("load.sub")}
        action={can("load.write") && (
          <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>{t("load.new")}</Button>
        )} />

      <Card>
        <div className="flex flex-wrap items-end gap-3 border-b border-line p-3">
          <Field label={t("load.from")} className="w-40">
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8 text-[13px]" />
          </Field>
          <Field label={t("load.to")} className="w-40">
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-8 text-[13px]" />
          </Field>
          <Field label={t("load.mill")} className="w-52">
            <Select value={mill} onChange={(e) => setMill(e.target.value)} className="h-8 text-[13px]">
              <option value="">{t("common.all")}</option>
              {mills.data?.map((m) => <option key={m.id} value={m.id}>{m.code} — {pick(m.name, m.nameHi)}</option>)}
            </Select>
          </Field>
          <Field label={t("load.status")} className="w-40">
            <Select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} className="h-8 text-[13px]">
              <option value="">{t("common.all")}</option>
              <option value="draft">{t("load.status.draft")}</option>
              <option value="billed">{t("load.status.billed")}</option>
            </Select>
          </Field>
          <Field label={t("common.search")} className="w-48">
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("load.searchHint")} className="h-8 text-[13px]" />
          </Field>
          {poId && (
            <Button size="sm" variant="subtle" icon={<X className="h-3.5 w-3.5" />} onClick={() => navigate("/loads")}>
              {t("load.clearPo")}
            </Button>
          )}
        </div>

        {loads.isPending ? <SkeletonTable rows={6} /> : loads.isError ? <LoadError error={loads.error} onRetry={() => void loads.refetch()} /> : !rows.length ? (
          <EmptyState icon={<Truck className="h-5 w-5" />} title={t("load.empty")} sub={t("load.emptySub")}
            action={can("load.write") && <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>{t("load.new")}</Button>} />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th {...sort.th("date")}>{t("load.date")}</Th><Th {...sort.th("truck")}>{t("load.truckNo")}</Th>
                <Th {...sort.th("mill")}>{t("load.mill")}</Th><Th {...sort.th("jins")}>{t("load.jins")}</Th>
                <Th {...sort.th("from")}>{t("load.fromDays")}</Th><Th numeric {...sort.th("loaded")}>{t("load.loaded")}</Th>
                <Th numeric {...sort.th("net")}>{t("load.millNet")}</Th>
                <Th {...sort.th("parcha")}>{t("load.parchaNo")}</Th><Th numeric {...sort.th("total")}>{t("load.grandTotal")}</Th>
              </tr>
            </thead>
            <tbody>
              {sort.sorted.map((r) => (
                <Tr key={r.id} onClick={() => navigate(`/loads/${r.id}`)}>
                  <Td className="whitespace-nowrap">{dmy(r.loadDate)}</Td>
                  <Td className="font-mono font-medium">{r.truckNo ?? <span className="text-faint">—</span>}</Td>
                  <Td><Badge tone="brand" className="num">{r.millCode}</Badge></Td>
                  <Td>{(r.jinsCodes ?? [r.jinsCode]).join(" + ")}</Td>
                  <Td className="whitespace-nowrap text-muted">{r.stockDates.map(dmy).join(", ") || "—"}</Td>
                  <Td numeric>{r.loadedGrams ? f.weight(r.loadedGrams) : <span className="text-faint">—</span>}</Td>
                  <Td numeric>{r.millNetGrams == null ? <span className="text-faint">—</span> : f.weight(r.millNetGrams)}</Td>
                  <Td>
                    {r.parcha
                      ? <Badge tone="ok">#{r.parcha.parchaNo}{r.parcha.revision > 1 ? ` · ${t("parcha.revised", { n: r.parcha.revision })}` : ""}</Badge>
                      : <Badge tone="neutral">{t("load.status.draft")}</Badge>}
                  </Td>
                  <Td numeric className="font-medium">{r.parcha ? f.money(r.parcha.grandTotalPaise) : <span className="text-faint">—</span>}</Td>
                </Tr>
              ))}
            </tbody>
            {billed.length > 0 && (
              <tfoot>
                <tr className="bg-raised/50 text-[13px] font-medium">
                  <td colSpan={8} className="px-3 py-2 text-right text-muted">{t("load.billedTotal", { n: billed.length })}</td>
                  <td className="num px-3 py-2 text-right">{f.money(totalBilled)}</td>
                </tr>
              </tfoot>
            )}
          </Table>
        )}
      </Card>
      {creating && <NewLoadDialog open onClose={() => setCreating(false)} />}
    </div>
  );
}

/* ------------------------------------------------------------ small editors */

/** A text box that saves when it is left, not on every key. */
function TextCell({ value, onCommit, disabled, placeholder, mono, upper, className }: {
  value: string | null; onCommit: (v: string | null) => void; disabled?: boolean;
  placeholder?: string; mono?: boolean; upper?: boolean; className?: string;
}) {
  const [text, setText] = useState(value ?? "");
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setText(value ?? ""); }, [value]);
  return (
    <input value={text} disabled={disabled} placeholder={placeholder}
      className={cn(CELL, mono && "font-mono", upper && "uppercase", className)}
      onFocus={() => { focused.current = true; }}
      onChange={(e) => setText(upper ? e.target.value.toUpperCase() : e.target.value)}
      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
      onBlur={() => {
        focused.current = false;
        const next = text.trim() || null;
        if (next !== (value ?? null)) onCommit(next);
      }} />
  );
}

/** A date box that saves once, when it is left — not on every keystroke of the year. */
function DateCell({ value, onCommit, disabled }: { value: string; onCommit: (v: string) => void; disabled?: boolean }) {
  const [v, setV] = useState(value);
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setV(value); }, [value]);
  const ok = (d: string) => /^(20\d{2}|2100)-\d{2}-\d{2}$/.test(d);
  return (
    <input type="date" value={v} disabled={disabled} className={CELL}
      onFocus={() => { focused.current = true; }}
      onChange={(e) => setV(e.target.value)}
      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
      onBlur={() => {
        focused.current = false;
        if (v !== value && ok(v)) onCommit(v); else setV(value);
      }} />
  );
}

/** A number box in display units that saves in storage units when it is left. */
export function NumCell({ value, scale, integer, decimals, onCommit, disabled, placeholder, className }: {
  value: number | null; scale: number; integer?: boolean; decimals?: number;
  onCommit: (v: number | null) => void; disabled?: boolean; placeholder?: string; className?: string;
}) {
  const [n, setN] = useState<number | null>(value == null ? null : value / scale);
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setN(value == null ? null : value / scale); }, [value, scale]);
  return (
    <NumberInput value={n} integer={integer} decimals={decimals} disabled={disabled} placeholder={placeholder}
      className={cn(NUMCELL, className)}
      onValueChange={setN}
      onFocus={() => { focused.current = true; }}
      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
      onBlur={() => {
        focused.current = false;
        const stored = n == null ? null : Math.round(n * scale);
        if (stored !== value) onCommit(stored);
      }} />
  );
}

/* ------------------------------------------------------------ messages */

function useLoadMessages() {
  const { t } = useI18n();
  const f = useFormat();
  const blocker = (b: LoadBlocker) => {
    switch (b.code) {
      case "line_no_rate": return t("load.b.line_no_rate", { d: dmy(b.date) });
      case "line_not_positive": return t("load.b.line_not_positive", { d: dmy(b.date), q: f.weight(b.grams) });
      case "lines_mismatch": return t("load.b.lines_mismatch", { rows: f.weight(b.linesGrams), net: f.weight(b.millNetGrams) });
      default: return t(`load.b.${b.code}`);
    }
  };
  const warning = (w: LoadWarning) => {
    switch (w.code) {
      case "stock_negative": return t("load.w.stock_negative", { d: dmy(w.date), q: f.weight(w.grams) });
      case "po_over": return t("load.w.po_over", { po: w.po, q: f.weight(w.overGrams) });
      case "po_closed": return t("load.w.po_closed", { po: w.po });
      case "po_expired": return t("load.w.po_expired", { po: w.po, d: dmy(w.validTill) });
      case "day_unpriced": return t("load.w.day_unpriced", { d: dmy(w.date), jins: w.jinsCode, n: w.slips });
      case "invoice_repeated": return t("load.w.invoice_repeated", { no: w.parchaNo, trucks: w.others.map((o) => o.truckNo ?? "—").join(", ") });
      default: return t(`load.w.${w.code}`);
    }
  };
  return { blocker, warning };
}

/* ------------------------------------------------------------ print */

function printParcha() {
  document.body.classList.add("print-parcha");
  const done = () => { document.body.classList.remove("print-parcha"); window.removeEventListener("afterprint", done); };
  window.addEventListener("afterprint", done);
  window.print();
  setTimeout(done, 1000);
}

function PaperDialog({ doc, draft, loadId, onClose }: { doc: ParchaDoc; draft: boolean; loadId: string; onClose: () => void }) {
  const { t } = useI18n();
  return (
    <Dialog open onClose={onClose} wide title={draft ? t("parcha.previewDraft") : t("parcha.previewApproved", { no: doc.invoiceNo ?? "" })}
      sub={t("parcha.previewSub")}
      footer={<>
        <a href={`/api/loads/${loadId}/parcha.xlsx`} download className="mr-auto">
          <Button icon={<FileSpreadsheet className="h-4 w-4" />}>{t("parcha.excel")}</Button>
        </a>
        <Button onClick={onClose}>{t("common.close")}</Button>
        <Button variant="primary" icon={<Printer className="h-4 w-4" />} onClick={printParcha}>{t("parcha.print")}</Button>
      </>}>
      <div className="print-area overflow-x-auto rounded-lg border border-line bg-white">
        <ParchaPaper doc={doc} draft={draft} />
      </div>
    </Dialog>
  );
}

/** Any parcha version exactly as it was frozen — a voided one stamped VOID — to see, print or download again. */
export function ParchaVersionDialog({ parchaId, onClose }: { parchaId: string; onClose: () => void }) {
  const { t, lang } = useI18n();
  const f = useFormat();
  const q = useQuery({
    queryKey: ["parcha", parchaId],
    queryFn: () => api.get<{ id: string; parchaNo: string; version: number; revision: number; status: "approved" | "void"; voidReason: string | null; voidedAt: number | null; voidedByName: string | null; doc: ParchaDoc }>(`/parchas/${parchaId}`),
  });
  const v = q.data;
  const isVoid = v?.status === "void";
  return (
    <Dialog open onClose={onClose} wide
      title={v ? t(isVoid ? "parcha.viewVoid" : "parcha.previewApproved", { no: `${v.parchaNo}${v.revision > 1 ? ` · ${t("parcha.revised", { n: v.revision })}` : ""}` }) : "…"}
      sub={isVoid ? t("parcha.voidedBecause", { why: v?.voidReason ?? "", who: v?.voidedByName ?? "", when: v?.voidedAt ? new Date(v.voidedAt * 1000).toLocaleString(lang === "hi" ? "hi-IN" : "en-IN", { dateStyle: "medium", timeStyle: "short" }) : "" }) : t("parcha.previewSub")}
      footer={<>
        <a href={`/api/parchas/${parchaId}/parcha.xlsx`} download className="mr-auto">
          <Button icon={<FileSpreadsheet className="h-4 w-4" />}>{t("parcha.excel")}</Button>
        </a>
        <Button onClick={onClose}>{t("common.close")}</Button>
        <Button variant="primary" icon={<Printer className="h-4 w-4" />} onClick={printParcha} disabled={!v}>{t("parcha.print")}</Button>
      </>}>
      {q.isError ? <LoadError error={q.error} onRetry={() => void q.refetch()} /> : !v ? <SkeletonTable rows={6} /> : (
        <>
          {isVoid && <Alert tone="bad" className="mb-3">{t("parcha.voidNote", { amt: f.money(v.doc.result.grandTotalPaise) })}</Alert>}
          <div className="print-area overflow-x-auto rounded-lg border border-line bg-white">
            <ParchaPaper doc={v.doc} voided={isVoid} />
          </div>
        </>
      )}
    </Dialog>
  );
}

/* ------------------------------------------------------------ detail */

export function LoadDetailPage({ id }: { id: string }) {
  const { t, pick } = useI18n();
  const f = useFormat();
  const { can } = useSession();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const msg = useLoadMessages();
  const [paper, setPaper] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);
  const ask = useConfirm();
  const [voiding, setVoiding] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["load", id],
    queryFn: () => api.get<LoadState>(`/loads/${id}`),
    retry: (n, e) => apiStatus(e) !== 404 && n < 2,
  });
  const mills = useQuery({ queryKey: ["merchants"], queryFn: () => api.get<Merchant[]>("/merchants") });
  const st = q.data;
  const pos = useQuery({
    queryKey: ["orders", st?.load.merchantId, "for-load", st?.load.jinsId],
    queryFn: () => api.get<OrderRow[]>(`/orders?merchantId=${st!.load.merchantId}&jinsId=${st!.load.jinsId}`),
    enabled: Boolean(st),
  });
  const days = useQuery({
    queryKey: ["load", id, "stock-days", st?.load.merchantId, st?.load.jinsId],
    queryFn: () => api.get<StockDay[]>(`/loads/${id}/stock-days`),
    enabled: Boolean(st),
  });
  /* Two or three commodities on one truck: a row may carry another commodity
     than the truck's own, and takes its purchase days and POs from that one. */
  const jinsAll = useQuery({ queryKey: ["jins"], queryFn: () => api.get<Jins[]>("/jins") });
  const extraJins = useMemo(() => [...new Set((st?.lines ?? []).map((x) => x.jinsId).filter((j) => j !== st?.load.jinsId))], [st]);
  const extraDays = useQueries({ queries: extraJins.map((j) => ({
    queryKey: ["load", id, "stock-days", st?.load.merchantId, j],
    queryFn: () => api.get<StockDay[]>(`/loads/${id}/stock-days?jinsId=${j}`), enabled: Boolean(st),
  })) });
  const extraPos = useQueries({ queries: extraJins.map((j) => ({
    queryKey: ["orders", st?.load.merchantId, "for-load", j],
    queryFn: () => api.get<OrderRow[]>(`/orders?merchantId=${st!.load.merchantId}&jinsId=${j}`), enabled: Boolean(st),
  })) });
  const [multiOn, setMultiOn] = useState(false);
  const multi = multiOn || extraJins.length > 0;
  const daysFor = (j: string): StockDay[] => (j === st?.load.jinsId ? days.data : extraDays[extraJins.indexOf(j)]?.data) ?? [];
  const posFor = (j: string): OrderRow[] => ((j === st?.load.jinsId ? pos.data : extraPos[extraJins.indexOf(j)]?.data) ?? [])
    .filter((o) => o.status === "open" || (st?.lines ?? []).some((x) => x.poId === o.id));

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ["load", id] });
    await qc.invalidateQueries({ queryKey: ["loads"] });
    await qc.invalidateQueries({ queryKey: ["orders"] });
    await qc.invalidateQueries({ queryKey: ["stock"] });
  };
  // a refused edit remounts the boxes, so they show what is saved, not what was typed
  const [rev, setRev] = useState(0);
  const onErr = (e: unknown) => { setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")); setRev((r) => r + 1); };
  const save = useMutation({ mutationFn: (patch: Record<string, unknown>) => api.put(`/loads/${id}`, patch), onSuccess: refresh, onError: onErr });
  const commit = (patch: Record<string, unknown>) => { setErr(null); save.mutate(patch); };
  const lineSave = useMutation({
    mutationFn: ({ lineId, patch }: { lineId: string; patch: Record<string, unknown> }) => api.put(`/loads/${id}/lines/${lineId}`, patch),
    onSuccess: refresh, onError: onErr,
  });
  const lineAdd = useMutation({ mutationFn: (body: Record<string, unknown>) => api.post(`/loads/${id}/lines`, body), onSuccess: refresh, onError: onErr });
  const lineDel = useMutation({ mutationFn: (lineId: string) => api.del(`/loads/${id}/lines/${lineId}`), onSuccess: refresh, onError: onErr });
  const del = useMutation({
    mutationFn: () => api.del(`/loads/${id}`),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ["loads"] }); await qc.invalidateQueries({ queryKey: ["stock"] }); navigate("/loads"); },
    onError: onErr,
  });

  // the invoice number the owner sees: typed, else the next in the series
  const [invoice, setInvoice] = useState<string>("");
  useEffect(() => {
    if (st) setInvoice(st.load.invoiceNo ?? st.suggestedInvoiceNo ?? "");
  }, [st?.load.invoiceNo, st?.suggestedInvoiceNo]);

  const approve = useMutation({
    mutationFn: (opts: { acceptRepeatedNo?: boolean } = {}) => api.post<{ parchaNo: string; version: number; revision: number }>(`/loads/${id}/approve`, {
      invoiceNo: invoice.trim() || undefined,
      expectedGrandTotalPaise: (st!.approved?.doc ?? st!.doc)?.result.grandTotalPaise,
      acceptRepeatedNo: opts.acceptRepeatedNo,
    }),
    onSuccess: async () => { await refresh(); await qc.invalidateQueries({ queryKey: ["parchas"] }); },
    onError: async (e) => {
      await refresh();
      if (e instanceof ApiError && e.code === "offline") { setErr(t("parcha.needsInternet")); return; }
      /* the number is already on another parcha this year: a warning, not a refusal —
         say where, and let the approver keep it or go back and type the next one */
      if (e instanceof ApiError && e.code === "number_repeated") {
        const no = invoice.trim();
        const others = ((e.data as { others?: { truckNo: string | null; date: string | null }[] } | undefined)?.others ?? [])
          .map((o) => `${o.truckNo ?? "—"}${o.date ? ` · ${dmy(o.date)}` : ""}`);
        const keep = await ask({
          title: t("parcha.repeatTitle", { no }),
          message: t("parcha.repeatBody", { where: others.length ? others.join(", ") : t("parcha.repeatElsewhere") }),
          confirmLabel: t("parcha.repeatKeep", { no }),
        });
        if (keep) { setErr(null); approve.mutate({ acceptRepeatedNo: true }); }
        return;
      }
      onErr(e);
    },
  });

  if (q.isPending) return <div className="space-y-4"><SkeletonForm fields={4} /><SkeletonTable rows={6} /></div>;
  if (q.isError || !st) {
    return (
      <Card>
        <EmptyState icon={<Truck className="h-5 w-5" />}
          title={apiStatus(q.error) === 404 ? t("load.notFound") : t("common.somethingWrong")}
          action={<Link href="/loads"><Button icon={<ArrowLeft className="h-4 w-4" />}>{t("load.backToLoads")}</Button></Link>} />
      </Card>
    );
  }

  const l = st.load;
  const billed = l.status === "billed";
  const canEdit = can("load.write") && !billed;
  const canParcha = can("parcha.create") && !billed;
  const w = st.weighment;
  const cfg = st.config;
  const blockers = st.blockers.filter((b) => !(b.code === "no_invoice_no" && invoice.trim()));
  const doc = st.approved?.doc ?? st.doc;
  const shownDoc = doc && !st.approved ? { ...doc, invoiceNo: invoice.trim() || doc.invoiceNo } : doc;
  const autoKatte = Math.round(w.katte * cfg.millBardanaKgPerBag * 1000);
  const autoBore = Math.round(w.bore * cfg.millBoreBardanaKgPerBag * 1000);
  const linesTotal = st.lines.reduce((s, x) => s + x.weightGrams, 0);
  const goodsTotal = st.lines.reduce((s, x) => s + x.amountPaise, 0);
  const dayOptions = days.data ?? [];
  const nextDay = dayOptions.find((d) => d.leftGrams > 0 && !st.lines.some((x) => x.stockDate === d.date))?.date
    ?? dayOptions[0]?.date ?? l.loadDate;

  return (
    <div>
      <div className="mb-2">
        <Link href="/loads" className="inline-flex items-center gap-1 text-[13px] text-muted hover:text-ink">
          <ArrowLeft className="h-3.5 w-3.5" />{t("load.backToLoads")}
        </Link>
      </div>
      <PageHeader
        title={<span className="flex flex-wrap items-center gap-2">
          <Truck className="h-5 w-5 text-brand" />
          <span className="font-mono">{l.truckNo ?? t("load.noTruck")}</span>
          <span className="text-muted">→</span>
          <span>{st.mill.code}</span>
          {billed
            ? <Badge tone="ok">{t("load.approvedNo", { no: st.approved?.parchaNo ?? "", v: st.approved && st.approved.revision > 1 ? ` · ${t("parcha.revised", { n: st.approved.revision })}` : "" })}</Badge>
            : <Badge tone="neutral">{t("load.status.draft")}</Badge>}
        </span>}
        sub={`${dmy(l.loadDate)} · ${pick(st.mill.name, st.mill.nameHi)} · ${st.jinsList.length > 1 ? st.jinsList.map((j) => j.code).join(" + ") : `${st.jins.code} ${pick(st.jins.name, st.jins.nameHi)}`}`}
        action={
          <div className="flex flex-wrap gap-2">
            {doc && can("parcha.read") && (
              <Button icon={<FileText className="h-4 w-4" />} onClick={() => setPaper(true)}>{t("parcha.see")}</Button>
            )}
            {billed && can("parcha.void") && st.approved && (
              <Button icon={<Ban className="h-4 w-4" />} onClick={() => setVoiding(true)}>{t("parcha.void")}</Button>
            )}
            {!billed && can("load.delete") && !st.history.length && (
              <Button variant="ghost" icon={<Trash2 className="h-4 w-4 text-bad" />}
                onClick={async () => { if (await ask({ title: t("load.confirmDelete"), rows: [{ label: t("load.truckNo"), value: l.truckNo ?? "—" }, { label: t("load.mill"), value: st.mill.code }, { label: t("load.date"), value: dmy(l.loadDate) }], danger: true, confirmLabel: t("confirm.yesDelete") })) del.mutate(); }}>
                {t("common.delete")}
              </Button>
            )}
          </div>
        } />

      {err && <Alert tone="bad" className="mb-4">{err}</Alert>}
      {billed && st.approved && (
        <Alert tone="ok" className="mb-4" title={t("load.lockedTitle", { no: st.approved.parchaNo })}>
          {t("load.lockedSub")}
        </Alert>
      )}
      {billed && st.approved && st.stale && (
        <Alert tone="warn" className="mb-4" title={t("parcha.staleTitle", { no: st.approved.parchaNo })}>
          <p>{t("parcha.staleBody", { was: f.money(st.stale.wasGrandTotalPaise), now: f.money(st.stale.nowGrandTotalPaise) })}</p>
          {st.stale.days.map((d) => (
            <p key={d.date} className="text-[12px]">{t("parcha.staleDay", { d: dmy(d.date), was: f.rate(d.wasRate), now: f.rate(d.nowRate) })}</p>
          ))}
          <p className="mt-1 text-[12px]">{t("parcha.staleWhat")}</p>
        </Alert>
      )}

      <div key={rev} className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="min-w-0 space-y-5">
          {/* truck */}
          <Card>
            <CardHeader title={t("load.truck")} />
            <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label={t("load.date")}>
                <DateCell value={l.loadDate} disabled={!canEdit} onCommit={(v) => commit({ loadDate: v })} />
              </Field>
              <Field label={t("load.truckNo")}>
                <TextCell value={l.truckNo} mono upper disabled={!canEdit} placeholder="UP25CT5038" onCommit={(v) => commit({ truckNo: v })} />
              </Field>
              <Field label={t("load.mill")}>
                <select value={l.merchantId} disabled={!canEdit} className={CELL}
                  onChange={async (e) => {
                    const to = e.target.value;
                    const m = mills.data?.find((x) => x.id === to);
                    if (await ask({ title: t("load.confirmMillTitle"), message: t("load.confirmMill"), rows: [{ label: t("load.mill"), value: `${st.mill.code} → ${m?.code ?? "?"}` }] })) commit({ merchantId: to });
                  }}>
                  {mills.data?.map((m) => <option key={m.id} value={m.id}>{m.code} — {pick(m.name, m.nameHi)}</option>)}
                </select>
              </Field>
              <Field label={t("load.transporter")}>
                <TextCell value={l.transporter} disabled={!canEdit} onCommit={(v) => commit({ transporter: v })} />
              </Field>
              <Field label={t("load.driverPhone")}>
                <TextCell value={l.driverPhone} mono disabled={!canEdit} onCommit={(v) => commit({ driverPhone: v })} />
              </Field>
              <Field label={t("load.eway")} hint={t("common.optional")}>
                <TextCell value={l.ewayBillNo} mono disabled={!canEdit} onCommit={(v) => commit({ ewayBillNo: v })} />
              </Field>
              <Field label={t("adati.notes")} className="lg:col-span-2">
                <TextCell value={l.notes} disabled={!canEdit} onCommit={(v) => commit({ notes: v })} />
              </Field>
            </div>
          </Card>

          {/* mill weighbridge */}
          <Card>
            <CardHeader title={<span className="inline-flex items-center gap-1.5"><Scale className="h-4 w-4 text-brand" />{t("load.millWeight")}</span>}
              sub={t("load.millWeightSub", { mill: st.mill.code })} />
            <div className="grid gap-3 p-4 sm:grid-cols-3 2xl:grid-cols-6">
              <Field label={t("load.dharamKanta")}>
                <NumCell value={l.millGrossGrams} scale={Q} decimals={2} disabled={!canEdit} placeholder="315.30"
                  onCommit={(v) => commit({ millGrossGrams: v })}
                  className={cn(!l.millGrossGrams && !billed && "border-warn")} />
              </Field>
              <Field label={t("load.katte")}>
                <NumCell value={l.katteCount} scale={1} integer disabled={!canEdit} placeholder="800"
                  onCommit={(v) => commit({ katteCount: v })}
                  className={cn(w.bags === 0 && !billed && "border-warn")} />
              </Field>
              <Field label={t("load.bore")}>
                <NumCell value={l.boreCount} scale={1} integer disabled={!canEdit} placeholder="0" onCommit={(v) => commit({ boreCount: v })} />
              </Field>
              <Field label={t("load.katteBardana")} hint={l.katteBardanaGrams == null ? t("load.autoKg", { kg: cfg.millBardanaKgPerBag }) : t("load.typed")}>
                <NumCell value={l.katteBardanaGrams} scale={Q} decimals={2} disabled={!canEdit}
                  placeholder={(autoKatte / Q).toFixed(2)} onCommit={(v) => commit({ katteBardanaGrams: v })} />
              </Field>
              <Field label={t("load.boreBardana")} hint={l.boreBardanaGrams == null ? t("load.autoKg", { kg: cfg.millBoreBardanaKgPerBag }) : t("load.typed")}>
                <NumCell value={l.boreBardanaGrams} scale={Q} decimals={2} disabled={!canEdit}
                  placeholder={(autoBore / Q).toFixed(2)} onCommit={(v) => commit({ boreBardanaGrams: v })} />
              </Field>
              <Field label={t("load.millNetShort")}>
                <div className={cn(NUMCELL, "flex items-center justify-end bg-raised font-semibold")}>
                  {w.netGrams == null ? <span className="text-faint">—</span> : f.weight(w.netGrams)}
                </div>
              </Field>
            </div>
          </Card>

          {/* goods loaded: weight rows against the mill's stock */}
          <Card>
            <CardHeader
              title={<span className="inline-flex items-center gap-1.5"><PackagePlus className="h-4 w-4 text-brand" />{t("load.goods")}</span>}
              sub={t("load.goodsSub", { mill: st.mill.code })}
              action={canEdit && (
                <div className="flex flex-wrap items-center gap-3">
                  <Switch checked={multi} onChange={setMultiOn} disabled={extraJins.length > 0} label={t("load.multi")} />
                  <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} loading={lineAdd.isPending}
                    onClick={() => { setErr(null); lineAdd.mutate({ stockDate: nextDay }); }}>{t("load.addRow")}</Button>
                </div>
              )} />
            <Table>
              <thead>
                <tr>
                  {multi && <Th>{t("daily.jins")}</Th>}
                  <Th>{t("load.fromDay")}</Th><Th>PO</Th><Th numeric>{t("load.weightQtl")}</Th>
                  <Th numeric>{t("load.rate")}</Th><Th numeric>{t("load.amount")}</Th><Th numeric>{t("load.dayLeft")}</Th>
                  {canEdit && <Th className="w-10" />}
                </tr>
              </thead>
              <tbody>
                {st.lines.map((x) => {
                  const rowDays = daysFor(x.jinsId);
                  const rowPos = posFor(x.jinsId);
                  return (
                  <tr key={x.id} className="border-b border-line/70">
                    {multi && (
                      <td className="px-2 py-1.5">
                        <select value={x.jinsId} disabled={!canEdit} className={cn(CELL, "min-w-[110px]")}
                          onChange={(e) => lineSave.mutate({ lineId: x.id, patch: { jinsId: e.target.value } })}>
                          {jinsAll.data?.map((j) => <option key={j.id} value={j.id}>{j.code}</option>)}
                        </select>
                      </td>
                    )}
                    <td className="px-2 py-1.5">
                      <select value={x.stockDate} disabled={!canEdit} className={cn(CELL, "min-w-[210px]")}
                        onChange={(e) => lineSave.mutate({ lineId: x.id, patch: { stockDate: e.target.value } })}>
                        {!rowDays.some((d) => d.date === x.stockDate) && <option value={x.stockDate}>{dmy(x.stockDate)}</option>}
                        {rowDays.map((d) => <option key={d.date} value={d.date}>{dayLabel(f, t, d)}</option>)}
                      </select>
                    </td>
                    <td className="px-2 py-1.5">
                      <select value={x.poId ?? ""} disabled={!canEdit} className={cn(CELL, "min-w-[120px]")}
                        onChange={(e) => lineSave.mutate({ lineId: x.id, patch: { poId: e.target.value || null } })}>
                        <option value="">—</option>
                        {rowPos.map((o) => <option key={o.id} value={o.id}>{o.poNo ? `PO ${o.poNo}` : poName(t, o)}</option>)}
                      </select>
                    </td>
                    <td className="w-36 px-2 py-1.5">
                      <NumCell value={x.netGrams} scale={Q} decimals={2} disabled={!canEdit}
                        placeholder={x.weightIsRest ? (x.weightGrams / Q).toFixed(2) : ""}
                        onCommit={(v) => lineSave.mutate({ lineId: x.id, patch: { netGrams: v } })} />
                      {x.weightIsRest && <p className="mt-0.5 text-right text-[10px] text-faint">{t("load.restOfNet")}</p>}
                    </td>
                    <td className="w-32 px-2 py-1.5">
                      <NumCell value={x.ratePaisePerQtl} scale={100} decimals={2} disabled={!canEdit}
                        placeholder={x.dayAvgRatePaisePerQtl ? (x.dayAvgRatePaisePerQtl / 100).toFixed(2) : "—"}
                        onCommit={(v) => lineSave.mutate({ lineId: x.id, patch: { ratePaisePerQtl: v } })}
                        className={cn(!x.ratePaisePerQtlUsed && !billed && "border-warn")} />
                      <p className="mt-0.5 text-right text-[10px] text-faint">{x.rateTyped ? t("load.typed") : t("load.dayAverage")}</p>
                    </td>
                    <td className="num px-3 py-1.5 text-right">{f.amount(x.amountPaise)}</td>
                    <td className={cn("num px-3 py-1.5 text-right", x.day.leftGrams < 0 && "font-medium text-warn")}
                      title={t("load.dayLeftHelp", { bought: f.weight(x.day.boughtNetGrams), other: f.weight(x.day.otherTrucksGrams), mine: f.weight(x.day.thisTruckGrams) })}>
                      {f.weight(x.day.leftGrams)}
                    </td>
                    {canEdit && (
                      <td className="px-1 text-right">
                        {st.lines.length > 1 && (
                          <Button variant="ghost" size="icon" title={t("load.removeRow")} aria-label={t("load.removeRow")} disabled={lineDel.isPending}
                            onClick={async () => { if (await ask({ title: t("load.removeRowTitle"), rows: [{ label: t("load.stockDate"), value: dmy(x.stockDate) }, { label: t("parcha.confirmNet"), value: f.weight(x.weightGrams, { unit: true }) }], danger: true, confirmLabel: t("confirm.yesDelete") })) { setErr(null); lineDel.mutate(x.id); } }}>
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </td>
                    )}
                  </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="bg-raised/50 text-[13px] font-semibold">
                  <td className="px-3 py-2" colSpan={multi ? 3 : 2}>{t("load.total")}</td>
                  <td className={cn("num px-3 py-2 text-right", w.netGrams != null && linesTotal !== w.netGrams && "text-bad")}>
                    {f.weight(linesTotal)}
                    {w.netGrams != null && linesTotal !== w.netGrams && <span className="block text-[10px] font-normal">{t("load.millNetIs", { q: f.weight(w.netGrams) })}</span>}
                  </td>
                  <td className="num px-3 py-2 text-right">{linesTotal ? f.rate(Math.round((goodsTotal * Q) / linesTotal)) : "—"}</td>
                  <td className="num px-3 py-2 text-right">{f.amount(goodsTotal)}</td>
                  <td colSpan={canEdit ? 2 : 1} />
                </tr>
              </tfoot>
            </Table>
            {st.stockByJins.map((sj) => (
              <div key={sj.jinsId} className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line px-4 py-2.5 text-[13px]">
                <span className="text-muted">{t("load.millStock", { mill: st.mill.code, jins: sj.jinsCode })}</span>
                <span>{t("load.stockBought")} <b className="num">{f.weight(sj.boughtNetGrams)}</b></span>
                <span>{t("load.stockOthers")} <b className="num">{f.weight(sj.otherTrucksGrams)}</b></span>
                <span>{t("load.stockThis")} <b className="num">{f.weight(sj.thisTruckGrams)}</b></span>
                <span className={cn(sj.leftGrams < 0 && "text-warn")}>{t("load.stockLeft")} <b className="num">{f.weight(sj.leftGrams)}</b></span>
                <Link href={`/stock/${st.mill.id}?jinsId=${sj.jinsId}`} className="text-brand hover:underline">{t("load.seeStock")}</Link>
              </div>
            ))}
            {st.pos.map((p) => (
              <div key={p.id} className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-2 text-[13px]">
                <span className="text-muted">{p.poNo ? `PO ${p.poNo}` : poName(t, p)}</span>
                <span>{t("po.ordered")} <b className="num">{f.weight(p.qtyGrams)}</b></span>
                <span>{t("load.poOthers")} <b className="num">{f.weight(p.otherLoadsGrams)}</b></span>
                <span>{t("load.poThis")} <b className="num">{f.weight(p.thisLoadGrams)}</b></span>
                <span className={cn(p.balanceGrams < 0 && "font-medium text-warn")}>
                  {p.balanceGrams < 0 ? t("po.over", { q: f.weight(-p.balanceGrams) }) : <>{t("po.balance")} <b className="num">{f.weight(p.balanceGrams)}</b></>}
                </span>
                <div className="w-32"><PoProgress sent={p.otherLoadsGrams + p.thisLoadGrams} qty={p.qtyGrams} /></div>
              </div>
            ))}
          </Card>
        </div>

        {/* parcha */}
        <div className="space-y-4">
          <Card className="xl:sticky xl:top-4">
            <CardHeader title={<span className="inline-flex items-center gap-1.5"><FileText className="h-4 w-4 text-brand" />{t("parcha.title")}</span>}
              sub={billed ? t("parcha.approvedSub") : t("parcha.draftSub")} />
            <div className="grid grid-cols-2 gap-3 border-b border-line p-4">
              <Field label={t("parcha.invoiceNo")} hint={!l.invoiceNo && st.suggestedInvoiceNo ? t("parcha.suggested") : !l.invoiceNo ? t("parcha.firstNo") : undefined}>
                <input value={invoice} disabled={!canParcha} className={cn(CELL, "font-mono", !invoice.trim() && !billed && "border-warn")}
                  onChange={(e) => setInvoice(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
                  onBlur={() => { if ((l.invoiceNo ?? "") !== invoice.trim()) commit({ invoiceNo: invoice.trim() || null }); }} />
              </Field>
              <Field label={t("parcha.invoiceDate")}>
                <DateCell value={l.invoiceDate ?? l.loadDate} disabled={!canParcha} onCommit={(v) => commit({ invoiceDate: v })} />
              </Field>
              <Field label={t("parcha.advance")} hint={t(`merchant.advance.${cfg.advance.treatment}`)}>
                <NumCell value={l.advancePaise} scale={100} decimals={2} disabled={!canParcha} placeholder="0.00"
                  onCommit={(v) => commit({ advancePaise: v ?? 0 })} />
              </Field>
              <Field label={t("parcha.dara")} hint={cfg.dara.includeInGrandTotal ? t("parcha.daraIn") : t("parcha.daraOut")}>
                <NumCell value={l.daraPaise} scale={100} decimals={2} disabled={!canParcha || cfg.dara.mode !== "manual"} placeholder="0.00"
                  onCommit={(v) => commit({ daraPaise: v ?? 0 })} />
              </Field>
            </div>

            {(blockers.length > 0 || st.warnings.length > 0) && !billed && (
              <div className="space-y-1.5 border-b border-line p-4 text-[13px]">
                {blockers.map((b, i) => (
                  <p key={`b${i}`} className="flex items-start gap-2 text-bad">
                    <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>{msg.blocker(b)}</span>
                  </p>
                ))}
                {st.warnings.map((wn, i) => (
                  <p key={`w${i}`} className="flex items-start gap-2 text-warn">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>{msg.warning(wn)}{wn.code === "invoice_repeated" && wn.others.map((o) => (
                      <span key={o.loadId}> · <Link href={`/loads/${o.loadId}`} className="underline">{o.truckNo ?? t("load.open")}</Link></span>
                    ))}</span>
                  </p>
                ))}
              </div>
            )}

            {shownDoc ? (
              <div className="p-4">
                <table className="w-full text-[13px]">
                  <tbody>
                    <tr>
                      <td className="py-1 pr-2">
                        {t("parcha.goods")}
                        <span className="ml-1.5 text-[11px] text-faint">{f.weight(shownDoc.totals.netGrams)} × {f.rate(shownDoc.totals.ratePaisePerQtl)}</span>
                      </td>
                      <td className="num py-1 text-right">{f.money(shownDoc.totals.goodsPaise)}</td>
                    </tr>
                    {/* what the paper prints, so the column re-adds to the grand total (a hidden dara inside it, the round-off) */}
                    {screenLines(shownDoc.result, shownDoc.config, t("parcha.roundOff")).map((x) => {
                      const strong = x.kind === "total";
                      const sub = x.kind === "subtotal";
                      return (
                        <tr key={x.key} className={cn((strong || sub) && "border-t border-line", strong && "border-t-2 border-ink/25")}>
                          <td className={cn("py-1 pr-2", strong && "text-[14px] font-semibold", sub && "font-medium", x.kind === "info" && "text-muted")}>
                            {pick(x.label, x.labelHi)}
                            {x.detail && x.kind !== "info" && <span className="ml-1.5 text-[11px] text-faint">{x.per === "pct" ? `${x.rate}%` : x.detail}</span>}
                            {x.kind === "info" && !shownDoc.config.dara.includeInGrandTotal && <span className="ml-1.5 text-[11px] text-faint">{t("parcha.daraOut")}</span>}
                            {x.key === "dara" && shownDoc.config.dara.includeInGrandTotal && <span className="ml-1.5 text-[11px] text-faint">{t("parcha.daraIn")}</span>}
                          </td>
                          <td className={cn("num py-1 text-right whitespace-nowrap", strong && "text-[15px] font-bold text-brand", sub && "font-semibold", x.kind === "info" && "text-muted")}>
                            {x.sign === "subtract" ? "−" : ""}{f.money(x.amountPaise)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {f.words(shownDoc.result.grandTotalPaise) && (
                  <p className="mt-2 border-t border-line pt-2 text-[11px] text-faint">{f.words(shownDoc.result.grandTotalPaise)}</p>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" icon={<Printer className="h-3.5 w-3.5" />} onClick={() => setPaper(true)}>{t("parcha.printOrSee")}</Button>
                  <a href={`/api/loads/${id}/parcha.xlsx`} download>
                    <Button size="sm" icon={<FileSpreadsheet className="h-3.5 w-3.5" />}>{t("parcha.excel")}</Button>
                  </a>
                </div>
              </div>
            ) : (
              <p className="p-4 text-[13px] text-muted">{t("parcha.notYet")}</p>
            )}

            {!billed && can("parcha.approve") && (
              <div className="border-t border-line p-4">
                <Button variant="primary" className="w-full" icon={<CheckCircle2 className="h-4 w-4" />}
                  disabled={blockers.length > 0 || !shownDoc || save.isPending || lineSave.isPending}
                  loading={approve.isPending}
                  onClick={async () => {
                    if (!shownDoc) return;
                    const d = shownDoc;
                    const days = [...new Set(d.lines.map((x) => dmy(x.date)))].join(", ");
                    const ok = await ask({
                      title: t("parcha.approveTitle", { no: invoice.trim() }),
                      message: t("parcha.approveCheck"),
                      rows: [
                        { label: t("parcha.no"), value: invoice.trim() || "—" },
                        { label: t("parcha.date"), value: dmy(d.invoiceDate) },
                        { label: t("load.mill"), value: `${st.mill.code} — ${pick(st.mill.name, st.mill.nameHi)}` },
                        { label: t("daily.jins"), value: st.jinsList.length > 1 ? st.jinsList.map((j) => j.code).join(" + ") : pick(st.jins.name, st.jins.nameHi) },
                        { label: t("load.truckNo"), value: l.truckNo ?? "—" },
                        { label: t("parcha.confirmLines"), value: t("parcha.confirmLinesOf", { n: d.lines.length, days }) },
                        { label: t("parcha.confirmBags"), value: `${f.int(d.weights.katte)}${d.weights.bore ? ` + ${f.int(d.weights.bore)}` : ""}` },
                        { label: t("parcha.confirmNet"), value: f.weight(d.totals.netGrams, { unit: true }) },
                        { label: t("parcha.confirmRate"), value: f.rate(d.totals.ratePaisePerQtl) },
                        { label: t("parcha.confirmGoods"), value: f.money(d.totals.goodsPaise) },
                        ...(d.result.advancePaise ? [{ label: t("parcha.confirmAdvance"), value: f.money(d.result.advancePaise) }] : []),
                        { label: t("parcha.confirmGrand"), value: f.money(d.result.grandTotalPaise), big: true },
                      ],
                      warnings: [t("parcha.approveLocks"), ...(!l.truckNo ? [t("parcha.warnNoTruck")] : []),
                        ...((d.revision ?? 1) > 1 ? [t("parcha.revisedWillPrint", { n: d.revision ?? 1 })] : []),
                        ...st.warnings.map((wn) => msg.warning(wn))],
                      confirmLabel: t("parcha.approveConfirm"),
                    });
                    // a repeated number was shown in the box above and approved anyway: that is the answer to it
                    const seen = st.warnings.some((wn) => wn.code === "invoice_repeated" && wn.parchaNo === invoice.trim());
                    if (ok) { setErr(null); approve.mutate({ acceptRepeatedNo: seen }); }
                  }}>
                  {t("parcha.approve")}
                </Button>
                {blockers.length > 0 && <p className="mt-1.5 text-center text-[11px] text-faint">{t("parcha.approveBlocked", { n: blockers.length })}</p>}
              </div>
            )}
          </Card>

          {st.history.length > 0 && (
            <Card>
              <CardHeader title={t("parcha.history")} />
              <div className="divide-y divide-line text-[13px]">
                {st.history.map((p) => (
                  <div key={p.id} className="flex items-start justify-between gap-2 px-4 py-2">
                    <div>
                      <span className="font-mono font-medium">#{p.parchaNo}</span>
                      {p.revision > 1 && <span className="ml-1.5 text-[12px] text-muted">{t("parcha.revised", { n: p.revision })}</span>}
                      <Badge tone={p.status === "approved" ? "ok" : "bad"} className="ml-2">{t(p.status === "void" ? "parcha.status.void" : "parcha.status.approved")}</Badge>
                      {p.voidReason && <p className="mt-0.5 text-[12px] text-muted">{p.voidReason}</p>}
                    </div>
                    <span className="flex items-center gap-1">
                      <span className={cn("num whitespace-nowrap", p.status === "void" && "line-through")}>{f.money(p.grandTotalPaise)}</span>
                      <Button size="icon" variant="ghost" title={t("parcha.view")} onClick={() => setViewing(p.id)}><Eye className="h-3.5 w-3.5" /></Button>
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      </div>

      {paper && shownDoc && <PaperDialog doc={shownDoc} draft={!billed} loadId={id} onClose={() => setPaper(false)} />}
      {viewing && <ParchaVersionDialog parchaId={viewing} onClose={() => setViewing(null)} />}
      {voiding && st.approved && (
        <VoidDialog parchaId={st.approved.id} no={st.approved.parchaNo} onClose={() => setVoiding(false)} onDone={refresh} />
      )}
    </div>
  );
}

function VoidDialog({ parchaId, no, onClose, onDone }: { parchaId: string; no: string; onClose: () => void; onDone: () => Promise<void> }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () => api.post(`/parchas/${parchaId}/void`, { reason }),
    onSuccess: async () => { await onDone(); await qc.invalidateQueries({ queryKey: ["parchas"] }); await qc.invalidateQueries({ queryKey: ["slips"] }); onClose(); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });
  return (
    <Dialog open onClose={onClose} title={t("parcha.voidTitle", { no })} sub={t("parcha.voidSub")}
      footer={<>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant="danger" loading={m.isPending} disabled={reason.trim().length < 3} onClick={() => m.mutate()}>{t("parcha.void")}</Button>
      </>}>
      {err && <Alert tone="bad" className="mb-3">{err}</Alert>}
      <Field label={t("parcha.voidReason")} required>
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} autoFocus />
      </Field>
    </Dialog>
  );
}

/* ------------------------------------------------------------ register */

export function ParchaRegisterPage() {
  const { t, pick } = useI18n();
  const f = useFormat();
  const [, navigate] = useLocation();
  // the chosen financial year, until other dates are picked
  const { from, setFrom, to, setTo } = useFYRange();
  const [showVoid, setShowVoid] = useState(false);
  const qs = new URLSearchParams();
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);
  const list = useQuery({ queryKey: ["parchas", qs.toString()], queryFn: () => api.get<ParchaRegisterRow[]>(`/parchas?${qs}`) });
  const parchaFlags = useTallyFlags("parcha", from || "2000-01-01", to || "2099-12-31");
  const rows = useMemo(() => (list.data ?? []).filter((r) => showVoid || r.status === "approved"), [list.data, showVoid]);
  const approved = rows.filter((r) => r.status === "approved");
  const total = approved.reduce((s, r) => s + r.grandTotalPaise, 0);
  // each row re-adds: grand total − mill cut − paid on it = due (the mill statement's rule, from the server)
  const cutTotal = approved.reduce((s, r) => s + (r.shortagePaise ?? 0), 0);
  const paidTotal = approved.reduce((s, r) => s + (r.receivedPaise ?? 0), 0);
  const dueTotal = approved.reduce((s, r) => s + (r.duePaise ?? 0), 0);
  const [viewing, setViewing] = useState<string | null>(null);
  const { can } = useSession();
  const money = can("millledger.read");
  const sort = useSort(rows, {
    no: (r) => r.parchaNo, date: (r) => r.invoiceDate, mill: (r) => r.millCode, truck: (r) => r.truckNo,
    status: (r) => r.status, total: (r) => r.grandTotalPaise, cut: (r) => r.shortagePaise, received: (r) => r.receivedPaise, due: (r) => r.duePaise,
  }, { storageKey: "parcha-register" });

  return (
    <div>
      <PageHeader title={t("parcha.register")} sub={t("parcha.registerSub")} />
      <Card>
        <div className="flex flex-wrap items-end gap-3 border-b border-line p-3">
          <Field label={t("load.from")} className="w-40">
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8 text-[13px]" />
          </Field>
          <Field label={t("load.to")} className="w-40">
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-8 text-[13px]" />
          </Field>
          <div className="pb-1.5"><Checkbox checked={showVoid} onChange={setShowVoid} label={t("parcha.showVoid")} /></div>
        </div>
        {list.isPending ? <SkeletonTable rows={5} /> : list.isError ? <LoadError error={list.error} onRetry={() => void list.refetch()} /> : !rows.length ? (
          <EmptyState icon={<FileText className="h-5 w-5" />} title={t("parcha.registerEmpty")} sub={t("parcha.registerEmptySub")}
            action={<Link href="/loads"><Button>{t("nav.loads")}</Button></Link>} />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th {...sort.th("no")}>{t("parcha.invoiceNo")}</Th><Th {...sort.th("date")}>{t("parcha.invoiceDate")}</Th>
                <Th {...sort.th("mill")}>{t("load.mill")}</Th><Th {...sort.th("truck")}>{t("load.truckNo")}</Th>
                <Th {...sort.th("status")}>{t("po.status")}</Th><Th numeric {...sort.th("total")}>{t("load.grandTotal")}</Th>
                {money && <>
                  <Th numeric {...sort.th("cut")}>{t("mm.cutShort")}</Th>
                  <Th numeric {...sort.th("received")} title={t("parcha.paidOnHint")}>{t("parcha.paidOn")}</Th>
                  <Th numeric {...sort.th("due")}>{t("parcha.due")}</Th>
                </>}
                <Th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {sort.sorted.map((r) => (
                <Tr key={r.id} onClick={() => navigate(`/loads/${r.loadId}`)} className={cn(r.status === "void" && "opacity-60")}>
                  <Td className="font-medium">
                    <span className="font-mono">{r.parchaNo}</span> <TallyMark flag={parchaFlags[r.id]} />
                    {r.revision > 1 && (
                      <span className="block text-[11px] font-normal text-muted">
                        {t("parcha.revisedOn", { n: r.revision, d: r.approvedAt ? dmy(new Date(r.approvedAt * 1000).toLocaleDateString("en-CA")) : "" })}
                        {r.previousId && <> · <button type="button" className="underline hover:text-ink" onClick={(e) => { e.stopPropagation(); setViewing(r.previousId); }}>{t("parcha.seeEarlier")}</button></>}
                      </span>
                    )}
                    {r.numberRepeated && <Badge tone="warn" className="mt-0.5">{t("parcha.numberRepeated")}</Badge>}
                  </Td>
                  <Td className="whitespace-nowrap">{r.invoiceDate ? dmy(r.invoiceDate) : "—"}</Td>
                  <Td><Badge tone="brand" className="num">{r.millCode}</Badge> <span className="text-muted">{pick(r.millName, r.millNameHi)}</span></Td>
                  <Td className="font-mono">{r.truckNo ?? "—"}</Td>
                  <Td>
                    <Badge tone={r.status === "approved" ? "ok" : "bad"}>{t(`parcha.status.${r.status}`)}</Badge>
                    {r.voidReason && <span className="ml-2 text-[12px] text-muted">{r.voidReason}</span>}
                  </Td>
                  <Td numeric className={cn("font-medium", r.status === "void" && "line-through")}>{f.money(r.grandTotalPaise)}</Td>
                  {money && <>
                    <Td numeric className="whitespace-nowrap text-warn">{r.shortagePaise ? `− ${f.money(r.shortagePaise)}` : r.status === "approved" ? "—" : ""}</Td>
                    <Td numeric className="text-ok">
                      {r.receivedPaise ? f.money(r.receivedPaise) : r.status === "approved" ? "—" : ""}
                      {r.fromAccountPaise ? <span className="block text-[10px] text-muted">{t("parcha.paidSplit", { a: f.money(r.againstPaise ?? 0), b: f.money(r.fromAccountPaise) })}</span> : null}
                    </Td>
                    <Td numeric className="font-medium">{r.duePaise == null ? "" : r.duePaise <= 0 ? <Badge tone="ok">{t("mm.paid")}</Badge> : f.money(r.duePaise)}</Td>
                  </>}
                  <Td className="text-right">
                    <span onClick={(e) => e.stopPropagation()}>
                      <Button size="icon" variant="ghost" title={t("parcha.view")} onClick={() => setViewing(r.id)}><Eye className="h-3.5 w-3.5" /></Button>
                    </span>
                  </Td>
                </Tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-raised/50 text-[13px] font-semibold">
                <td colSpan={5} className="px-3 py-2 text-right text-muted">{t("parcha.registerTotal", { n: approved.length })}</td>
                <td className="num px-3 py-2 text-right">{f.money(total)}</td>
                {money && <>
                  <td className="num px-3 py-2 text-right text-warn">{cutTotal ? `− ${f.money(cutTotal)}` : "—"}</td>
                  <td className="num px-3 py-2 text-right text-ok">{f.money(paidTotal)}</td>
                  <td className="num px-3 py-2 text-right">{f.money(dueTotal)}</td>
                </>}
                <td />
              </tr>
            </tfoot>
          </Table>
        )}
        {money && rows.length > 0 && <p className="border-t border-line px-3 py-2 text-[11px] text-faint">{t("parcha.dueRule")}</p>}
      </Card>
      {viewing && <ParchaVersionDialog parchaId={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}
