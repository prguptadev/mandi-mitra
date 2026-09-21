import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Receipt } from "lucide-react";
import { api, ApiError } from "@/lib/api.ts";
import { useI18n } from "@/lib/i18n.tsx";
import { useFormat } from "@/lib/format.tsx";
import { useSession } from "@/lib/session.tsx";
import { useConfirm } from "@/components/Confirm.tsx";
import { NumberInput } from "@/components/NumberInput.tsx";
import { Alert, Button, Card, CardHeader, Field, Input } from "@/components/ui/index.tsx";
import { slipCharges, defaultSupplierCharges, type SupplierCharges } from "@server/lib/supplierTerms.ts";

/* What each supplier adds to their receipt — commission on the amount and
   gaushala on the net weight — and what those columns are called on screen
   and in downloads. New slips take these; slips already entered keep theirs. */

const NUM = "h-9.5 w-full rounded-lg border bg-surface px-3 text-right font-mono text-sm tabular-nums text-ink focus:border-brand";
// the worked example: 20.00 qtl gross, 20 kg katauti, ₹3,400 a quintal
const EX = { netGrams: 1_980_000, ratePaise: 340_000, amountPaise: 6_732_000 };

export function SupplierChargesCard() {
  const { t } = useI18n();
  const f = useFormat();
  const { can } = useSession();
  const qc = useQueryClient();
  const ask = useConfirm();
  const q = useQuery({ queryKey: ["settings", "supplier-charges"], queryFn: () => api.get<SupplierCharges>("/settings/supplier-charges") });
  const [v, setV] = useState<SupplierCharges>(defaultSupplierCharges());
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  useEffect(() => { if (q.data) setV(q.data); }, [q.data]);
  const editable = can("settings.write");
  const save = useMutation({
    mutationFn: () => api.put<SupplierCharges>("/settings/supplier-charges", v),
    onSuccess: async () => { setErr(null); setOk(true); await qc.invalidateQueries({ queryKey: ["settings", "supplier-charges"] }); await qc.invalidateQueries({ queryKey: ["slips"] }); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });
  const ex = slipCharges(EX.amountPaise, EX.netGrams, EX.ratePaise, v);
  const label = (k: keyof SupplierCharges["labels"]) => (
    <Input value={v.labels[k]} disabled={!editable} maxLength={40}
      onChange={(e) => { setOk(false); setV((p) => ({ ...p, labels: { ...p.labels, [k]: e.target.value } })); }} />
  );
  const changed = JSON.stringify(v) !== JSON.stringify(q.data ?? defaultSupplierCharges());

  return (
    <Card>
      <CardHeader title={t("sc.title")} sub={t("sc.sub")} />
      <div className="space-y-4 p-4">
        {err && <Alert tone="bad">{err}</Alert>}
        {ok && !changed && <Alert tone="ok">{t("common.saved")}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("sc.commissionPct")} hint={t("sc.commissionPctHint")}>
            <NumberInput value={v.commissionPct} decimals={3} disabled={!editable} className={NUM}
              onValueChange={(n) => { setOk(false); setV((p) => ({ ...p, commissionPct: n ?? 0 })); }} />
          </Field>
          <Field label={t("sc.gaushalaPerQtl")} hint={t("sc.gaushalaPerQtlHint")}>
            <NumberInput value={v.gaushalaPerQtl} decimals={3} disabled={!editable} className={NUM}
              onValueChange={(n) => { setOk(false); setV((p) => ({ ...p, gaushalaPerQtl: n ?? 0 })); }} />
          </Field>
        </div>
        <div className="rounded-lg border border-line bg-raised/40 p-3 text-[13px]">
          <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">{t("sc.example")}</p>
          <p className="num leading-relaxed">
            {f.weight(EX.netGrams, { unit: true })} × {f.rate(EX.ratePaise)} = {f.money(EX.amountPaise)}
            {" + "}{v.labels.commission} {f.money(ex.commissionPaise)}
            {" + "}{v.labels.gaushala} {f.money(ex.gaushalaPaise)}
            {" = "}<b>{f.money(ex.payablePaise)}</b>
          </p>
        </div>
        <div>
          <p className="mb-2 text-[12px] font-medium text-ink">{t("sc.names")}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("sc.nameCommission")}>{label("commission")}</Field>
            <Field label={t("sc.nameCommissionHi")}>{label("commissionHi")}</Field>
            <Field label={t("sc.nameGaushala")}>{label("gaushala")}</Field>
            <Field label={t("sc.nameGaushalaHi")}>{label("gaushalaHi")}</Field>
            <Field label={t("sc.namePayable")}>{label("payable")}</Field>
            <Field label={t("sc.namePayableHi")}>{label("payableHi")}</Field>
          </div>
        </div>
        <p className="text-[11px] leading-snug text-faint">{t("sc.oldSlips")}</p>
        {editable && (
          <Button variant="primary" loading={save.isPending} disabled={!changed}
            onClick={async () => {
              setErr(null);
              if (await ask({
                title: t("sc.confirmTitle"),
                rows: [
                  { label: t("sc.commissionPct"), value: `${v.commissionPct}%` },
                  { label: t("sc.gaushalaPerQtl"), value: `₹${v.gaushalaPerQtl}` },
                  { label: t("sc.example"), value: f.money(ex.payablePaise), big: true },
                ],
                warnings: [t("sc.oldSlips")],
              })) save.mutate();
            }}>{t("common.save")}</Button>
        )}
      </div>
    </Card>
  );
}
