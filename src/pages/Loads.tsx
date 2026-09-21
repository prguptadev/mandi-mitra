import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Plus, Truck, ArrowLeft, Printer, FileSpreadsheet, CheckCircle2, Ban, Trash2, X, AlertTriangle,
  CircleAlert, FileText, Scale, PackagePlus,
} from "lucide-react";
import {
  api, ApiError, apiStatus, type Merchant, type Jins, type OrderRow, type LoadListRow, type LoadState,
  type CandidateSlip, type ParchaRegisterRow, type LoadBlocker, type LoadWarning, type ParchaDoc,
} from "@/lib/api.ts";
import { useI18n } from "@/lib/i18n.tsx";
import { useSession } from "@/lib/session.tsx";
import { useFormat } from "@/lib/format.tsx";
import { PageHeader } from "@/components/AppShell.tsx";
import { NumberInput } from "@/components/NumberInput.tsx";
import { ParchaPaper } from "@/components/ParchaPaper.tsx";
import { SkeletonTable, SkeletonForm } from "@/components/Skeletons.tsx";
import {
  Button, Card, CardHeader, Field, Input, Select, Table, Th, Td, Tr, Badge, Dialog, EmptyState, Alert, Checkbox, Textarea,
} from "@/components/ui/index.tsx";
import { cn, todayISO } from "@/lib/utils.ts";
import { dmy } from "@server/lib/parchaLabels.ts";
import { PoProgress } from "@/pages/Orders.tsx";

const Q = 100_000;
const CELL = "h-9 w-full rounded-lg border bg-surface px-2.5 text-sm text-ink focus:border-brand disabled:bg-raised disabled:opacity-70";
const NUMCELL = cn(CELL, "text-right tabular-nums");

/* ------------------------------------------------------------ new load */

export function NewLoadDialog({ open, onClose, preset }: {
  open: boolean; onClose: () => void;
  preset?: { slipIds?: string[]; merchantId?: string | null; jinsId?: string; date?: string; netGrams?: number };
}) {
  const { t, pick } = useI18n();
  const f = useFormat();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const mills = useQuery({ queryKey: ["merchants"], queryFn: () => api.get<Merchant[]>("/merchants") });
  const jins = useQuery({ queryKey: ["jins"], queryFn: () => api.get<Jins[]>("/jins") });
  const [v, setV] = useState(() => ({
    loadDate: preset?.date ?? todayISO(),
    merchantId: preset?.merchantId ?? "",
    jinsId: preset?.jinsId ?? "",
    poId: "",
    truckNo: "", transporter: "", driverPhone: "",
  }));
  const jinsId = v.jinsId || jins.data?.find((j) => j.code === "1509")?.id || jins.data?.[0]?.id || "";
  const pos = useQuery({
    queryKey: ["orders", v.merchantId, "open", jinsId],
    queryFn: () => api.get<OrderRow[]>(`/orders?merchantId=${v.merchantId}&status=open&jinsId=${jinsId}`),
    enabled: Boolean(v.merchantId && jinsId),
  });
  // one open PO for this mill and commodity: that is almost certainly the one
  useEffect(() => {
    if (!v.poId && pos.data?.length === 1) setV((p) => ({ ...p, poId: pos.data![0].id }));
  }, [pos.data]);
  const [err, setErr] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => api.post<{ id: string }>("/loads", {
      loadDate: v.loadDate, merchantId: v.merchantId, jinsId, poId: v.poId || null,
      truckNo: v.truckNo || null, transporter: v.transporter || null, driverPhone: v.driverPhone || null,
      slipIds: preset?.slipIds,
    }),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ["loads"] });
      await qc.invalidateQueries({ queryKey: ["slips"] });
      onClose();
      navigate(`/loads/${r.id}`);
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });

  return (
    <Dialog open={open} onClose={onClose} title={t("load.new")}
      sub={preset?.slipIds?.length
        ? t("load.newWithSlips", { n: preset.slipIds.length, q: f.weight(preset.netGrams ?? 0) })
        : t("load.newSub")}
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
          <Select value={v.merchantId} onChange={(e) => setV((p) => ({ ...p, merchantId: e.target.value, poId: "" }))}>
            <option value="">{t("load.pickMill")}</option>
            {mills.data?.map((m) => <option key={m.id} value={m.id}>{m.code} — {m.name}</option>)}
          </Select>
        </Field>
        <Field label={t("load.jins")} required>
          <Select value={jinsId} disabled={Boolean(preset?.jinsId)} onChange={(e) => setV((p) => ({ ...p, jinsId: e.target.value, poId: "" }))}>
            {jins.data?.map((j) => <option key={j.id} value={j.id}>{j.code} — {pick(j.name, j.nameHi)}</option>)}
          </Select>
        </Field>
        <Field label={t("load.po")} hint={v.merchantId && pos.data && !pos.data.length ? t("load.noOpenPo") : t("common.optional")} className="sm:col-span-2">
          <Select value={v.poId} disabled={!v.merchantId} onChange={(e) => setV((p) => ({ ...p, poId: e.target.value }))}>
            <option value="">{t("load.noPo")}</option>
            {pos.data?.map((o) => (
              <option key={o.id} value={o.id}>
                PO {o.poNo} · {dmy(o.poDate)} · {t("po.balance")} {f.weight(o.balanceGrams)} {f.unit}
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
  const { t } = useI18n();
  const f = useFormat();
  const { can } = useSession();
  const [, navigate] = useLocation();
  const search = new URLSearchParams(useSearch());
  const poId = search.get("poId") ?? "";
  const [mill, setMill] = useState("");
  const [status, setStatus] = useState<"" | "draft" | "billed">("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
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
  const billed = rows.filter((r) => r.parcha);
  const totalBilled = billed.reduce((s, r) => s + (r.parcha?.grandTotalPaise ?? 0), 0);

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
              {mills.data?.map((m) => <option key={m.id} value={m.id}>{m.code} — {m.name}</option>)}
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

        {loads.isPending ? <SkeletonTable rows={6} /> : !rows.length ? (
          <EmptyState icon={<Truck className="h-5 w-5" />} title={t("load.empty")} sub={t("load.emptySub")}
            action={can("load.write") && <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>{t("load.new")}</Button>} />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>{t("load.date")}</Th><Th>{t("load.truckNo")}</Th><Th>{t("load.mill")}</Th><Th>{t("load.jins")}</Th>
                <Th>PO</Th><Th numeric>{t("load.slips")}</Th><Th numeric>{t("load.ourNet")}</Th>
                <Th numeric>{t("load.millNet")}</Th><Th numeric>{t("load.diff")}</Th><Th numeric>{t("load.rate")}</Th>
                <Th>{t("load.parchaNo")}</Th><Th numeric>{t("load.grandTotal")}</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Tr key={r.id} onClick={() => navigate(`/loads/${r.id}`)}>
                  <Td className="whitespace-nowrap">{dmy(r.loadDate)}</Td>
                  <Td className="font-mono font-medium">{r.truckNo ?? <span className="text-faint">—</span>}</Td>
                  <Td><Badge tone="brand" className="num">{r.millCode}</Badge></Td>
                  <Td>{r.jinsCode}</Td>
                  <Td className="font-mono text-muted">{r.poNo ?? "—"}</Td>
                  <Td numeric>{r.slips}</Td>
                  <Td numeric>{f.weight(r.slipNetGrams)}</Td>
                  <Td numeric>{r.millNetGrams == null ? <span className="text-faint">—</span> : f.weight(r.millNetGrams)}</Td>
                  <Td numeric className={cn(r.diffGrams != null && Math.abs(r.diffGrams) >= r.slipNetGrams * 0.02 && "text-warn")}>
                    {r.diffGrams == null ? <span className="text-faint">—</span> : f.weight(r.diffGrams)}
                  </Td>
                  <Td numeric>{r.avgRatePaisePerQtl ? f.rate(r.avgRatePaisePerQtl) : <span className="text-faint">—</span>}</Td>
                  <Td>
                    {r.parcha
                      ? <Badge tone="ok">#{r.parcha.parchaNo}{r.parcha.version > 1 ? ` v${r.parcha.version}` : ""}</Badge>
                      : <Badge tone="neutral">{t("load.status.draft")}</Badge>}
                  </Td>
                  <Td numeric className="font-medium">{r.parcha ? f.money(r.parcha.grandTotalPaise) : <span className="text-faint">—</span>}</Td>
                </Tr>
              ))}
            </tbody>
            {billed.length > 0 && (
              <tfoot>
                <tr className="bg-raised/50 text-[13px] font-medium">
                  <td colSpan={11} className="px-3 py-2 text-right text-muted">{t("load.billedTotal", { n: billed.length })}</td>
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

/** A number box in display units that saves in storage units when it is left. */
function NumCell({ value, scale, integer, decimals, onCommit, disabled, placeholder, className }: {
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
      case "invoice_taken": return t("load.b.invoice_taken", { truck: b.truckNo ?? "—" });
      default: return t(`load.b.${b.code}`);
    }
  };
  const warning = (w: LoadWarning) => {
    switch (w.code) {
      case "rate_pending": return t("load.w.rate_pending", { n: w.n });
      case "weight_diff": return w.grams > 0
        ? t("load.w.weight_less", { q: f.weight(w.grams), pct: w.pct })
        : t("load.w.weight_more", { q: f.weight(-w.grams), pct: -w.pct });
      case "po_over": return t("load.w.po_over", { q: f.weight(w.overGrams) });
      case "po_expired": return t("load.w.po_expired", { d: dmy(w.validTill) });
      case "mixed_jins": return t("load.w.mixed_jins", { n: w.n });
      default: return t(`load.w.${w.code}`);
    }
  };
  return { blocker, warning };
}

/* ------------------------------------------------------------ add slips */

function AddSlipsDialog({ st, onClose }: { st: LoadState; onClose: () => void }) {
  const { t } = useI18n();
  const f = useFormat();
  const qc = useQueryClient();
  const [date, setDate] = useState<string>(st.load.loadDate);
  const [mill, setMill] = useState<"this" | "all" | "none">("this");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [err, setErr] = useState<string | null>(null);

  const cand = useQuery({
    queryKey: ["load", st.load.id, "candidates", date, mill],
    queryFn: () => api.get<{ rows: CandidateSlip[]; days: { slipDate: string; n: number }[] }>(
      `/loads/${st.load.id}/candidates?${new URLSearchParams({ date, mill })}`),
  });
  // the load's own date may have no free slips; fall back to the latest day that has some
  useEffect(() => {
    const days = cand.data?.days;
    if (date && days?.length && !days.some((d) => d.slipDate === date) && cand.data?.rows.length === 0) setDate(days[0].slipDate);
  }, [cand.data]);

  const rows = cand.data?.rows ?? [];
  const sel = rows.filter((r) => picked.has(r.id));
  const allOn = rows.length > 0 && sel.length === rows.length;
  const add = useMutation({
    mutationFn: () => api.post<{ added: number; elsewhere: { rstNo: string; truckNo: string | null }[] }>(
      `/loads/${st.load.id}/slips`, { slipIds: [...picked] }),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ["load", st.load.id] });
      await qc.invalidateQueries({ queryKey: ["loads"] });
      await qc.invalidateQueries({ queryKey: ["slips"] });
      if (r.elsewhere.length) setErr(t("load.alreadyElsewhere", { rst: r.elsewhere.map((e) => e.rstNo).join(", ") }));
      else onClose();
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });

  return (
    <Dialog open onClose={onClose} wide title={t("load.addSlips")} sub={t("load.addSlipsSub", { jins: st.jins.code, mill: st.mill.code })}
      footer={<>
        <span className="mr-auto text-[13px] text-muted">
          {sel.length ? t("load.selected", { n: sel.length, q: f.weight(sel.reduce((s, r) => s + r.netGrams, 0)) }) : t("load.pickSlips")}
        </span>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant="primary" loading={add.isPending} disabled={!sel.length}
          onClick={() => { setErr(null); add.mutate(); }}>{t("load.addN", { n: sel.length })}</Button>
      </>}>
      {err && <Alert tone="warn" className="mb-3">{err}</Alert>}
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <Field label={t("load.slipDay")} className="w-52">
          <Select value={date} onChange={(e) => { setDate(e.target.value); setPicked(new Set()); }} className="h-8 text-[13px]">
            <option value="">{t("load.allDays")}</option>
            {!cand.data?.days.some((d) => d.slipDate === date) && date && <option value={date}>{dmy(date)} (0)</option>}
            {cand.data?.days.map((d) => <option key={d.slipDate} value={d.slipDate}>{dmy(d.slipDate)} ({d.n})</option>)}
          </Select>
        </Field>
        <Field label={t("load.fromSheet")} className="w-56">
          <Select value={mill} onChange={(e) => { setMill(e.target.value as typeof mill); setPicked(new Set()); }} className="h-8 text-[13px]">
            <option value="this">{t("load.sheetThis", { mill: st.mill.code })}</option>
            <option value="all">{t("load.sheetAll")}</option>
            <option value="none">{t("load.sheetNone")}</option>
          </Select>
        </Field>
      </div>
      <div className="max-h-[52vh] overflow-y-auto rounded-lg border border-line">
        {cand.isPending ? <SkeletonTable rows={6} /> : !rows.length ? (
          <EmptyState title={t("load.noFreeSlips")} sub={t("load.noFreeSlipsSub")} />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th className="w-9"><Checkbox checked={allOn} onChange={(v) => setPicked(v ? new Set(rows.map((r) => r.id)) : new Set())} /></Th>
                <Th>{t("daily.rst")}</Th><Th>{t("load.date")}</Th><Th>{t("daily.supplier")}</Th><Th>{t("load.sheet")}</Th>
                <Th numeric>{t("daily.gross")}</Th><Th numeric>{t("load.net")}</Th><Th numeric>{t("load.rate")}</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Tr key={r.id} className={cn(picked.has(r.id) && "bg-brand/5")}
                  onClick={() => setPicked((p) => { const n = new Set(p); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); return n; })}>
                  <Td><Checkbox checked={picked.has(r.id)} onChange={() => { /* row click toggles */ }} /></Td>
                  <Td className="font-mono">{r.rstNo}</Td>
                  <Td className="whitespace-nowrap text-muted">{dmy(r.slipDate)}</Td>
                  <Td className="whitespace-nowrap"><span lang="hi">{r.adatiNameHi}</span></Td>
                  <Td>{r.merchantCode ? <Badge tone={r.merchantId === st.mill.id ? "brand" : "neutral"}>{r.merchantCode}</Badge> : <span className="text-faint">—</span>}</Td>
                  <Td numeric>{f.weight(r.grossGrams)}</Td>
                  <Td numeric>{f.weight(r.netGrams)}</Td>
                  <Td numeric>{r.ratePaisePerQtl ? f.rate(r.ratePaisePerQtl) : <span className="text-warn">{t("load.noRate")}</span>}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </div>
      {mill !== "this" && sel.some((r) => r.merchantId !== st.mill.id) && (
        <p className="mt-2 text-[12px] text-muted">{t("load.willMove", { mill: st.mill.code })}</p>
      )}
    </Dialog>
  );
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

/* ------------------------------------------------------------ detail */

export function LoadDetailPage({ id }: { id: string }) {
  const { t, pick, lang } = useI18n();
  const f = useFormat();
  const { can } = useSession();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const msg = useLoadMessages();
  const [adding, setAdding] = useState(false);
  const [paper, setPaper] = useState(false);
  const [approving, setApproving] = useState(false);
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

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ["load", id] });
    await qc.invalidateQueries({ queryKey: ["loads"] });
    await qc.invalidateQueries({ queryKey: ["orders"] });
  };
  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) => api.put(`/loads/${id}`, patch),
    onSuccess: refresh,
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });
  const commit = (patch: Record<string, unknown>) => { setErr(null); save.mutate(patch); };

  const removeSlips = useMutation({
    mutationFn: (slipIds: string[]) => api.del(`/loads/${id}/slips`, { slipIds }),
    onSuccess: async () => { await refresh(); await qc.invalidateQueries({ queryKey: ["slips"] }); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });

  const del = useMutation({
    mutationFn: () => api.del(`/loads/${id}`),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ["loads"] }); await qc.invalidateQueries({ queryKey: ["slips"] }); navigate("/loads"); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });

  // the invoice number the owner sees: typed, else the next in the series
  const [invoice, setInvoice] = useState<string>("");
  useEffect(() => {
    if (st) setInvoice(st.load.invoiceNo ?? st.suggestedInvoiceNo ?? "");
  }, [st?.load.invoiceNo, st?.suggestedInvoiceNo]);

  const approve = useMutation({
    mutationFn: async () => {
      if ((st!.load.invoiceNo ?? "") !== invoice.trim()) await api.put(`/loads/${id}`, { invoiceNo: invoice.trim() || null });
      return api.post<{ parchaNo: string; version: number }>(`/loads/${id}/approve`);
    },
    onSuccess: async () => { setApproving(false); await refresh(); await qc.invalidateQueries({ queryKey: ["parchas"] }); await qc.invalidateQueries({ queryKey: ["slips"] }); },
    onError: async (e) => {
      setApproving(false);
      await refresh();
      setErr(e instanceof ApiError ? e.message : t("common.somethingWrong"));
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
            ? <Badge tone="ok">{t("load.approvedNo", { no: st.approved?.parchaNo ?? "", v: st.approved && st.approved.version > 1 ? ` v${st.approved.version}` : "" })}</Badge>
            : <Badge tone="neutral">{t("load.status.draft")}</Badge>}
        </span>}
        sub={`${dmy(l.loadDate)} · ${pick(st.mill.name, st.mill.nameHi)} · ${st.jins.code} ${pick(st.jins.name, st.jins.nameHi)}`}
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
                onClick={() => { if (confirm(t("load.confirmDelete", { n: st.slips.length }))) del.mutate(); }}>
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

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="min-w-0 space-y-5">
          {/* truck */}
          <Card>
            <CardHeader title={t("load.truck")} />
            <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label={t("load.date")}>
                <input type="date" value={l.loadDate} disabled={!canEdit} className={CELL}
                  onChange={(e) => e.target.value && commit({ loadDate: e.target.value })} />
              </Field>
              <Field label={t("load.truckNo")}>
                <TextCell value={l.truckNo} mono upper disabled={!canEdit} placeholder="UP25CT5038" onCommit={(v) => commit({ truckNo: v })} />
              </Field>
              <Field label={t("load.mill")}>
                <select value={l.merchantId} disabled={!canEdit} className={CELL}
                  onChange={(e) => {
                    if (st.slips.length && !confirm(t("load.confirmMill", { n: st.slips.length }))) return;
                    commit({ merchantId: e.target.value, poId: null });
                  }}>
                  {mills.data?.map((m) => <option key={m.id} value={m.id}>{m.code} — {m.name}</option>)}
                </select>
              </Field>
              <Field label={t("load.po")}>
                <select value={l.poId ?? ""} disabled={!canEdit} className={CELL}
                  onChange={(e) => commit({ poId: e.target.value || null })}>
                  <option value="">{t("load.noPo")}</option>
                  {pos.data?.filter((o) => o.status === "open" || o.id === l.poId).map((o) => (
                    <option key={o.id} value={o.id}>PO {o.poNo} · {dmy(o.poDate)} · {f.weight(o.qtyGrams)} {f.unit}</option>
                  ))}
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
              <Field label={t("adati.notes")}>
                <TextCell value={l.notes} disabled={!canEdit} onCommit={(v) => commit({ notes: v })} />
              </Field>
            </div>
            {st.po && (
              <div className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-2.5 text-[13px]">
                <span className="text-muted">PO {st.po.poNo}</span>
                <span>{t("po.ordered")} <b className="num">{f.weight(st.po.qtyGrams)}</b></span>
                <span>{t("load.poOthers")} <b className="num">{f.weight(st.po.otherLoadsGrams)}</b></span>
                <span>{t("load.poThis")} <b className="num">{f.weight(st.po.thisLoadGrams)}</b></span>
                <span className={cn(st.po.balanceGrams < 0 && "text-warn font-medium")}>
                  {st.po.balanceGrams < 0 ? t("po.over", { q: f.weight(-st.po.balanceGrams) }) : <>{t("po.balance")} <b className="num">{f.weight(st.po.balanceGrams)}</b></>}
                </span>
                <div className="w-32"><PoProgress sent={st.po.otherLoadsGrams + st.po.thisLoadGrams} qty={st.po.qtyGrams} /></div>
              </div>
            )}
          </Card>

          {/* slips */}
          <Card>
            <CardHeader
              title={t("load.slipsOn", { n: st.slips.length })}
              sub={t("load.slipsSub")}
              action={canEdit && (
                <Button size="sm" variant="primary" icon={<PackagePlus className="h-4 w-4" />} onClick={() => setAdding(true)}>{t("load.addSlips")}</Button>
              )} />
            {!st.slips.length ? (
              <EmptyState icon={<PackagePlus className="h-5 w-5" />} title={t("load.noSlips")} sub={t("load.noSlipsSub")}
                action={canEdit && <Button variant="primary" onClick={() => setAdding(true)}>{t("load.addSlips")}</Button>} />
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>{t("daily.rst")}</Th><Th>{t("load.date")}</Th><Th>{t("daily.supplier")}</Th>
                    <Th numeric>{t("daily.gross")}</Th><Th numeric>{t("load.katauti")}</Th><Th numeric>{t("load.net")}</Th>
                    <Th numeric>{t("load.rate")}</Th><Th numeric>{t("load.amount")}</Th>{canEdit && <Th className="w-10" />}
                  </tr>
                </thead>
                <tbody>
                  {st.slips.map((s) => (
                    <Tr key={s.id}>
                      <Td className="font-mono">{s.rstNo}</Td>
                      <Td className="whitespace-nowrap text-muted">{dmy(s.slipDate)}</Td>
                      <Td className="whitespace-nowrap">{lang === "hi" ? <span lang="hi">{s.adatiNameHi}</span> : s.adatiNameHinglish || s.adatiNameHi}</Td>
                      <Td numeric>{f.weight(s.grossGrams)}</Td>
                      <Td numeric className="text-muted">{s.katautiUnits}</Td>
                      <Td numeric>{f.weight(s.netGrams)}</Td>
                      <Td numeric>{s.ratePaisePerQtl ? f.rate(s.ratePaisePerQtl) : <span className="rounded border border-warn px-1 text-warn">{t("load.noRate")}</span>}</Td>
                      <Td numeric>{f.amount(s.amountPaise)}</Td>
                      {canEdit && (
                        <Td className="text-right">
                          <Button variant="ghost" size="icon" title={t("load.takeOff")} onClick={() => { setErr(null); removeSlips.mutate([s.id]); }}>
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        </Td>
                      )}
                    </Tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-raised/50 text-[13px] font-semibold">
                    <td className="px-3 py-2" colSpan={3}>{t("load.total")}</td>
                    <td className="num px-3 py-2 text-right">{f.weight(st.slipTotals.grossGrams)}</td>
                    <td className="num px-3 py-2 text-right text-muted">{st.slipTotals.katautiUnits}</td>
                    <td className="num px-3 py-2 text-right">{f.weight(st.slipTotals.netGrams)}</td>
                    <td className="num px-3 py-2 text-right" title={t("load.avgRateHelp")}>{st.slipTotals.avgRatePaisePerQtl ? f.rate(st.slipTotals.avgRatePaisePerQtl) : "—"}</td>
                    <td className="num px-3 py-2 text-right">{f.amount(st.slipTotals.amountPaise)}</td>
                    {canEdit && <td />}
                  </tr>
                </tfoot>
              </Table>
            )}
          </Card>

          {/* mill weighbridge */}
          <Card>
            <CardHeader title={<span className="inline-flex items-center gap-1.5"><Scale className="h-4 w-4 text-brand" />{t("load.millWeight")}</span>}
              sub={t("load.millWeightSub", { mill: st.mill.code })} />
            <div className="grid gap-3 p-4 sm:grid-cols-3 2xl:grid-cols-6">
              <Field label={t("load.dharamKanta")}>
                <NumCell value={l.millGrossGrams} scale={Q} decimals={2} disabled={!canEdit} placeholder="315.30"
                  onCommit={(v) => commit({ millGrossGrams: v })}
                  className={cn(!l.millGrossGrams && st.slips.length > 0 && !billed && "border-warn")} />
              </Field>
              <Field label={t("load.katte")}>
                <NumCell value={l.katteCount} scale={1} integer disabled={!canEdit} placeholder="800"
                  onCommit={(v) => commit({ katteCount: v })}
                  className={cn(w.bags === 0 && st.slips.length > 0 && !billed && "border-warn")} />
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
            {w.netGrams != null && st.slipTotals.netGrams > 0 && (
              <div className="border-t border-line px-4 py-2.5 text-[13px] text-muted">
                {t("load.compare", {
                  ours: f.weight(st.slipTotals.netGrams), mill: f.weight(w.netGrams),
                  diff: f.weight(Math.abs(st.slipTotals.netGrams - w.netGrams)),
                  dir: st.slipTotals.netGrams >= w.netGrams ? t("load.less") : t("load.more"),
                })}
              </div>
            )}
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
                <input type="date" value={l.invoiceDate ?? l.loadDate} disabled={!canParcha} className={CELL}
                  onChange={(e) => e.target.value && commit({ invoiceDate: e.target.value })} />
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
                    <span>{msg.blocker(b)}{b.code === "invoice_taken" && <> · <Link href={`/loads/${b.loadId}`} className="underline">{t("load.open")}</Link></>}</span>
                  </p>
                ))}
                {st.warnings.map((wn, i) => (
                  <p key={`w${i}`} className="flex items-start gap-2 text-warn">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span>{msg.warning(wn)}</span>
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
                    {shownDoc.result.lines.filter((x) => x.kind !== "goods").map((x) => {
                      const strong = x.kind === "total";
                      const sub = x.kind === "subtotal";
                      return (
                        <tr key={x.key} className={cn((strong || sub) && "border-t border-line", strong && "border-t-2 border-ink/25")}>
                          <td className={cn("py-1 pr-2", strong && "text-[14px] font-semibold", sub && "font-medium", x.kind === "info" && "text-muted")}>
                            {pick(x.label, x.labelHi)}
                            {x.detail && x.kind !== "info" && <span className="ml-1.5 text-[11px] text-faint">{x.per === "pct" ? `${x.rate}%` : x.detail}</span>}
                            {x.kind === "info" && !cfg.dara.includeInGrandTotal && <span className="ml-1.5 text-[11px] text-faint">{t("parcha.daraOut")}</span>}
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
                  disabled={blockers.length > 0 || !shownDoc || save.isPending}
                  onClick={() => setApproving(true)}>
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
                      <span className="font-mono font-medium">#{p.parchaNo}{p.version > 1 ? ` v${p.version}` : ""}</span>
                      <Badge tone={p.status === "approved" ? "ok" : "bad"} className="ml-2">{t(p.status === "void" ? "parcha.status.void" : "parcha.status.approved")}</Badge>
                      {p.voidReason && <p className="mt-0.5 text-[12px] text-muted">{p.voidReason}</p>}
                    </div>
                    <span className="num whitespace-nowrap">{f.money(p.grandTotalPaise)}</span>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      </div>

      {adding && <AddSlipsDialog st={st} onClose={() => setAdding(false)} />}
      {paper && shownDoc && <PaperDialog doc={shownDoc} draft={!billed} loadId={id} onClose={() => setPaper(false)} />}
      {approving && shownDoc && (
        <Dialog open onClose={() => setApproving(false)} title={t("parcha.approveTitle", { no: invoice.trim() })}
          footer={<>
            <Button onClick={() => setApproving(false)}>{t("common.cancel")}</Button>
            <Button variant="primary" loading={approve.isPending} icon={<CheckCircle2 className="h-4 w-4" />}
              onClick={() => approve.mutate()}>{t("parcha.approveConfirm")}</Button>
          </>}>
          <p className="text-[14px]">{t("parcha.approveBody", {
            total: f.money(shownDoc.result.grandTotalPaise), mill: st.mill.code, n: st.slips.length,
          })}</p>
        </Dialog>
      )}
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
  const { t } = useI18n();
  const f = useFormat();
  const [, navigate] = useLocation();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [showVoid, setShowVoid] = useState(false);
  const qs = new URLSearchParams();
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);
  const list = useQuery({ queryKey: ["parchas", qs.toString()], queryFn: () => api.get<ParchaRegisterRow[]>(`/parchas?${qs}`) });
  const rows = useMemo(() => (list.data ?? []).filter((r) => showVoid || r.status === "approved"), [list.data, showVoid]);
  const approved = rows.filter((r) => r.status === "approved");
  const total = approved.reduce((s, r) => s + r.grandTotalPaise, 0);

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
        {list.isPending ? <SkeletonTable rows={5} /> : !rows.length ? (
          <EmptyState icon={<FileText className="h-5 w-5" />} title={t("parcha.registerEmpty")} sub={t("parcha.registerEmptySub")}
            action={<Link href="/loads"><Button>{t("nav.loads")}</Button></Link>} />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>{t("parcha.invoiceNo")}</Th><Th>{t("parcha.invoiceDate")}</Th><Th>{t("load.mill")}</Th>
                <Th>{t("load.truckNo")}</Th><Th>{t("po.status")}</Th><Th numeric>{t("load.grandTotal")}</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Tr key={r.id} onClick={() => navigate(`/loads/${r.loadId}`)} className={cn(r.status === "void" && "opacity-60")}>
                  <Td className="font-mono font-medium">{r.parchaNo}{r.version > 1 ? ` v${r.version}` : ""}</Td>
                  <Td className="whitespace-nowrap">{r.invoiceDate ? dmy(r.invoiceDate) : "—"}</Td>
                  <Td><Badge tone="brand" className="num">{r.millCode}</Badge> <span className="text-muted">{r.millName}</span></Td>
                  <Td className="font-mono">{r.truckNo ?? "—"}</Td>
                  <Td>
                    <Badge tone={r.status === "approved" ? "ok" : "bad"}>{t(`parcha.status.${r.status}`)}</Badge>
                    {r.voidReason && <span className="ml-2 text-[12px] text-muted">{r.voidReason}</span>}
                  </Td>
                  <Td numeric className={cn("font-medium", r.status === "void" && "line-through")}>{f.money(r.grandTotalPaise)}</Td>
                </Tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-raised/50 text-[13px] font-semibold">
                <td colSpan={5} className="px-3 py-2 text-right text-muted">{t("parcha.registerTotal", { n: approved.length })}</td>
                <td className="num px-3 py-2 text-right">{f.money(total)}</td>
              </tr>
            </tfoot>
          </Table>
        )}
      </Card>
    </div>
  );
}
