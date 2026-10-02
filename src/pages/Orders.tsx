import { useState } from "react";
import { useConfirm } from "@/components/Confirm.tsx";
import { Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, ClipboardList, Pencil, Trash2, Lock, LockOpen } from "lucide-react";
import { api, ApiError, type Merchant, type Jins, type OrderRow } from "@/lib/api.ts";
import { useI18n } from "@/lib/i18n.tsx";
import { useSort } from "@/lib/useSort.ts";
import { useSession } from "@/lib/session.tsx";
import { useFormat } from "@/lib/format.tsx";
import { PageHeader } from "@/components/AppShell.tsx";
import { NumberInput } from "@/components/NumberInput.tsx";
import { SkeletonTable } from "@/components/Skeletons.tsx";
import {
  Button, Card, Field, Input, Select, Table, Th, Td, Tr, Badge, Dialog, EmptyState, Alert, Textarea,
} from "@/components/ui/index.tsx";
import { LoadError } from "@/components/LoadError.tsx";
import { cn, todayISO } from "@/lib/utils.ts";
import { dmy } from "@server/lib/parchaLabels.ts";

const NUM = "h-9.5 w-full rounded-lg border bg-surface px-3 text-sm text-ink tabular-nums focus:border-brand disabled:opacity-60";

/** A PO is named by its number, or by its date when the mill gave none. */
export const poName = (t: (k: "po.ofDate", v?: Record<string, string>) => string, o: { poNo: string | null; poDate: string | null }) =>
  o.poNo ? `PO ${o.poNo}` : t("po.ofDate", { d: o.poDate ? dmy(o.poDate) : "—" });

/** Sent against ordered, as a bar that turns orange once the mill has had more than it asked for. */
export function PoProgress({ sent, qty }: { sent: number; qty: number }) {
  const pct = qty > 0 ? Math.min(100, (sent / qty) * 100) : 0;
  const over = sent > qty;
  return (
    <div className="h-1.5 w-full min-w-[80px] overflow-hidden rounded-full bg-line/70">
      <div className={cn("h-full rounded-full", over ? "bg-warn" : pct >= 100 ? "bg-ok" : "bg-brand")} style={{ width: `${over ? 100 : pct}%` }} />
    </div>
  );
}

function OrderDialog({ open, onClose, editing }: { open: boolean; onClose: () => void; editing: OrderRow | null }) {
  const { t, pick } = useI18n();
  const qc = useQueryClient();
  const mills = useQuery({ queryKey: ["merchants"], queryFn: () => api.get<Merchant[]>("/merchants") });
  const jins = useQuery({ queryKey: ["jins"], queryFn: () => api.get<Jins[]>("/jins") });
  const [f, setF] = useState(() => ({
    merchantId: editing?.merchantId ?? "",
    jinsId: editing?.jinsId ?? "",
    poNo: editing?.poNo ?? "",
    poDate: editing?.poDate ?? todayISO(),
    qtyQtl: editing ? editing.qtyGrams / 100_000 : null as number | null,
    rate: editing?.ratePaisePerQtl != null ? editing.ratePaisePerQtl / 100 : null as number | null,
    validTill: editing?.validTill ?? "",
    notes: editing?.notes ?? "",
  }));
  const [err, setErr] = useState<string | null>(null);
  const jinsId = f.jinsId || jins.data?.find((j) => j.code === "1509")?.id || jins.data?.[0]?.id || "";

  const save = useMutation({
    mutationFn: () => {
      const body = {
        merchantId: f.merchantId, jinsId, poNo: f.poNo.trim(), poDate: f.poDate,
        qtyGrams: Math.round((f.qtyQtl ?? 0) * 100_000),
        ratePaisePerQtl: f.rate == null ? null : Math.round(f.rate * 100),
        validTill: f.validTill || null, notes: f.notes.trim() || null,
      };
      return editing ? api.put(`/orders/${editing.id}`, body) : api.post("/orders", body);
    },
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ["orders"] }); onClose(); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });

  return (
    <Dialog open={open} onClose={onClose} title={editing ? `${t("po.edit")} — ${poName(t, editing)}` : t("po.add")} sub={t("po.addSub")}
      footer={<>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant="primary" loading={save.isPending}
          disabled={!f.merchantId || !jinsId || !f.poDate || !f.qtyQtl}
          onClick={() => { setErr(null); save.mutate(); }}>{t("common.save")}</Button>
      </>}>
      {err && <Alert tone="bad" className="mb-3">{err}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("load.mill")} required>
          <Select value={f.merchantId} onChange={(e) => setF((p) => ({ ...p, merchantId: e.target.value }))} autoFocus={!editing}>
            <option value="">{t("load.pickMill")}</option>
            {mills.data?.map((m) => <option key={m.id} value={m.id}>{m.code} — {pick(m.name, m.nameHi)}</option>)}
          </Select>
        </Field>
        <Field label={t("load.jins")} required>
          <Select value={jinsId} onChange={(e) => setF((p) => ({ ...p, jinsId: e.target.value }))}>
            {jins.data?.map((j) => <option key={j.id} value={j.id}>{j.code} — {pick(j.name, j.nameHi)}</option>)}
          </Select>
        </Field>
        <Field label={t("po.no")} hint={t("po.noHelp")}>
          <Input value={f.poNo} mono onChange={(e) => setF((p) => ({ ...p, poNo: e.target.value }))} placeholder={t("common.optional")} />
        </Field>
        <Field label={t("po.date")} required>
          <Input type="date" value={f.poDate} onChange={(e) => setF((p) => ({ ...p, poDate: e.target.value }))} />
        </Field>
        <Field label={t("po.qty")} hint={t("po.qtyHelp")} required>
          <NumberInput value={f.qtyQtl} decimals={2} onValueChange={(n) => setF((p) => ({ ...p, qtyQtl: n }))} className={NUM} placeholder="500.00" />
        </Field>
        <Field label={t("po.rate")} hint={t("po.rateHelp")}>
          <NumberInput value={f.rate} decimals={2} onValueChange={(n) => setF((p) => ({ ...p, rate: n }))} className={NUM} />
        </Field>
        <Field label={t("po.validTill")} hint={t("common.optional")}>
          <Input type="date" value={f.validTill} onChange={(e) => setF((p) => ({ ...p, validTill: e.target.value }))} />
        </Field>
      </div>
      <Field label={t("adati.notes")} className="mt-4">
        <Textarea value={f.notes} onChange={(e) => setF((p) => ({ ...p, notes: e.target.value }))} rows={2} />
      </Field>
    </Dialog>
  );
}

export function OrdersPage() {
  const { t, pick } = useI18n();
  const ask = useConfirm();
  const f = useFormat();
  const { can } = useSession();
  const qc = useQueryClient();
  const [mill, setMill] = useState("");
  const [status, setStatus] = useState<"open" | "closed" | "">("open");
  const [dialog, setDialog] = useState<{ editing: OrderRow | null } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const mills = useQuery({ queryKey: ["merchants"], queryFn: () => api.get<Merchant[]>("/merchants") });
  const q = new URLSearchParams();
  if (mill) q.set("merchantId", mill);
  if (status) q.set("status", status);
  const orders = useQuery({ queryKey: ["orders", mill, status], queryFn: () => api.get<OrderRow[]>(`/orders?${q}`) });

  const act = useMutation({
    mutationFn: (x: { id: string; kind: "close" | "reopen" | "delete" }) =>
      x.kind === "delete" ? api.del(`/orders/${x.id}`) : api.put(`/orders/${x.id}`, { status: x.kind === "close" ? "closed" : "open" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["orders"] }),
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });

  const rows = orders.data ?? [];
  const sort = useSort(rows, {
    no: (o) => o.poNo, date: (o) => o.poDate, mill: (o) => o.millCode, jins: (o) => o.jinsCode,
    ordered: (o) => o.qtyGrams, sent: (o) => o.sentGrams, balance: (o) => o.balanceGrams, loads: (o) => o.loads, status: (o) => o.status,
  }, { storageKey: "orders" });
  return (
    <div>
      <PageHeader title={t("po.title")} sub={t("po.sub")}
        action={can("po.write") && (
          <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setDialog({ editing: null })}>{t("po.add")}</Button>
        )} />
      {err && <Alert tone="bad" className="mb-3">{err}</Alert>}

      <Card>
        <div className="flex flex-wrap items-end gap-3 border-b border-line p-3">
          <Field label={t("load.mill")} className="w-56">
            <Select value={mill} onChange={(e) => setMill(e.target.value)} className="h-8 text-[13px]">
              <option value="">{t("common.all")}</option>
              {mills.data?.map((m) => <option key={m.id} value={m.id}>{m.code} — {pick(m.name, m.nameHi)}</option>)}
            </Select>
          </Field>
          <Field label={t("po.status")} className="w-40">
            <Select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} className="h-8 text-[13px]">
              <option value="open">{t("po.status.open")}</option>
              <option value="closed">{t("po.status.closed")}</option>
              <option value="">{t("common.all")}</option>
            </Select>
          </Field>
        </div>

        {orders.isPending ? <SkeletonTable rows={5} /> : orders.isError ? <LoadError error={orders.error} onRetry={() => void orders.refetch()} /> : !rows.length ? (
          <EmptyState icon={<ClipboardList className="h-5 w-5" />}
            // with a filter on, "no POs yet" would be wrong: there may be closed ones
            title={status || mill ? t("common.noResults") : t("po.empty")} sub={status || mill ? undefined : t("po.emptySub")}
            action={can("po.write") && <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setDialog({ editing: null })}>{t("po.add")}</Button>} />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th {...sort.th("no")}>{t("po.no")}</Th><Th {...sort.th("date")}>{t("po.date")}</Th>
                <Th {...sort.th("mill")}>{t("load.mill")}</Th><Th {...sort.th("jins")}>{t("load.jins")}</Th>
                <Th numeric {...sort.th("ordered")}>{t("po.ordered")}</Th><Th numeric {...sort.th("sent")}>{t("po.sent")}</Th>
                <Th numeric {...sort.th("balance")}>{t("po.balance")}</Th>
                <Th className="w-32" /><Th numeric {...sort.th("loads")}>{t("po.loads")}</Th><Th {...sort.th("status")}>{t("po.status")}</Th><Th />
              </tr>
            </thead>
            <tbody>
              {sort.sorted.map((o) => (
                <Tr key={o.id}>
                  <Td className="font-mono font-medium">{o.poNo || <span className="font-sans font-normal text-faint">{t("po.noNumber")}</span>}</Td>
                  <Td className="whitespace-nowrap">{dmy(o.poDate)}</Td>
                  {/* a long mill name goes onto a second line rather than being cut short */}
                  <Td>
                    <Badge tone="brand" className="num">{o.millCode}</Badge>
                    <span className="ml-1.5 text-muted">{pick(o.millName, o.millNameHi)}</span>
                  </Td>
                  <Td className="whitespace-nowrap"><span title={pick(o.jinsName, o.jinsNameHi)}>{o.jinsCode}</span></Td>
                  <Td numeric>{f.weight(o.qtyGrams)}</Td>
                  <Td numeric>{f.weight(o.sentGrams)}</Td>
                  <Td numeric className={cn(o.balanceGrams < 0 && "text-warn font-medium")}>
                    {o.balanceGrams < 0 ? t("po.over", { q: f.weight(-o.balanceGrams) }) : f.weight(o.balanceGrams)}
                  </Td>
                  <Td><PoProgress sent={o.sentGrams} qty={o.qtyGrams} /></Td>
                  <Td numeric>
                    {o.loads ? <Link href={`/loads?poId=${o.id}`} className="text-brand hover:underline">{o.loads}</Link> : <span className="text-faint">0</span>}
                  </Td>
                  <Td>
                    <Badge tone={o.status === "open" ? "ok" : "neutral"}>{t(`po.status.${o.status}`)}</Badge>
                    {o.validTill && <span className="ml-1.5 inline-block whitespace-nowrap text-[11px] text-faint">{t("po.till", { d: dmy(o.validTill) })}</span>}
                  </Td>
                  <Td className="whitespace-nowrap text-right">
                    {can("po.write") && (
                      <>
                        <Button variant="ghost" size="icon" title={t("common.edit")} onClick={() => setDialog({ editing: o })}><Pencil className="h-3.5 w-3.5" /></Button>
                        <Button variant="ghost" size="icon" title={o.status === "open" ? t("po.close") : t("po.reopen")} disabled={act.isPending}
                          onClick={() => { setErr(null); act.mutate({ id: o.id, kind: o.status === "open" ? "close" : "reopen" }); }}>
                          {o.status === "open" ? <Lock className="h-3.5 w-3.5" /> : <LockOpen className="h-3.5 w-3.5" />}
                        </Button>
                        {o.loads === 0 && (
                          <Button variant="ghost" size="icon" title={t("common.delete")} disabled={act.isPending}
                            onClick={async () => { if (await ask({ title: t("po.confirmDelete", { no: poName(t, o) }), danger: true, confirmLabel: t("confirm.yesDelete") })) { setErr(null); act.mutate({ id: o.id, kind: "delete" }); } }}>
                            <Trash2 className="h-3.5 w-3.5 text-bad" />
                          </Button>
                        )}
                      </>
                    )}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {dialog && <OrderDialog open onClose={() => setDialog(null)} editing={dialog.editing} />}
    </div>
  );
}
