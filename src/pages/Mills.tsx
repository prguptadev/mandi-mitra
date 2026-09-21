import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Factory, Pencil, Trash2, Calculator, Info } from "lucide-react";
import { api, ApiError, type Merchant, type ChargeConfig, type ParchaResult, type PctBase } from "@/lib/api.ts";
import { useI18n } from "@/lib/i18n.tsx";
import { useSort } from "@/lib/useSort.ts";
import { useSession } from "@/lib/session.tsx";
import { PageHeader } from "@/components/AppShell.tsx";
import { HindiInput } from "@/components/HindiInput.tsx";
import { NumberInput } from "@/components/NumberInput.tsx";
import { SkeletonTable, SkeletonForm } from "@/components/Skeletons.tsx";
import {
  Button, Card, CardHeader, Field, Input, Select, Table, Th, Td, Tr, Badge,
  Dialog, EmptyState, Alert, Switch, Tabs, Textarea,
} from "@/components/ui/index.tsx";
import { cn } from "@/lib/utils.ts";
import { useFormat } from "@/lib/format.tsx";

/** A charge row: on/off switch, its number, and what it is charged on. */
function ChargeRow({
  label, hint, enabled, onEnabled, children, unit,
}: {
  label: string; hint?: string; enabled: boolean; onEnabled: (v: boolean) => void;
  children: React.ReactNode; unit?: string;
}) {
  return (
    <div className={cn(
      "rounded-lg border p-3 transition-colors",
      enabled ? "border-line bg-surface" : "border-line/60 bg-raised/30",
    )}>
      <div className="flex items-start justify-between gap-3">
        <Switch checked={enabled} onChange={onEnabled} label={label} hint={hint} />
      </div>
      {enabled && (
        <div className="mt-2.5 flex flex-wrap items-end gap-2 pl-[2.9rem]">
          {children}
          {unit && <span className="pb-2 text-xs text-faint">{unit}</span>}
        </div>
      )}
    </div>
  );
}

function BaseSelect({ value, onChange }: { value: PctBase; onChange: (v: PctBase) => void }) {
  const { t } = useI18n();
  return (
    <div className="min-w-[170px]">
      <label className="mb-1 block text-[11px] text-faint">{t("merchant.chargedOn")}</label>
      <Select value={value} onChange={(e) => onChange(e.target.value as PctBase)} className="h-8 text-[13px]">
        <option value="amount">{t("merchant.base.amount")}</option>
        <option value="amount_plus_adat">{t("merchant.base.amount_plus_adat")}</option>
        <option value="total_before_charge">{t("merchant.base.total_before_charge")}</option>
      </Select>
    </div>
  );
}

type BagKind = ChargeConfig["labour1"]["appliesTo"];
function BagKindSelect({ value, onChange }: { value: BagKind; onChange: (v: BagKind) => void }) {
  const { t } = useI18n();
  return (
    <div className="min-w-[140px]">
      <label className="mb-1 block text-[11px] text-faint">{t("merchant.appliesTo")}</label>
      <Select value={value} onChange={(e) => onChange(e.target.value as BagKind)} className="h-8 text-[13px]">
        <option value="all">{t("merchant.bagKind.all")}</option>
        <option value="katte">{t("merchant.bagKind.katte")}</option>
        <option value="bore">{t("merchant.bagKind.bore")}</option>
      </Select>
    </div>
  );
}

function NumBox({ value, onChange, width = "w-24", label }: { value: number; onChange: (v: number) => void; width?: string; label?: string }) {
  return (
    <div className={width}>
      {label && <label className="mb-1 block text-[11px] text-faint">{label}</label>}
      <NumberInput value={value} emptyValue={0} onValueChange={(n) => onChange(n ?? 0)}
        className="h-8 w-full rounded-lg border bg-surface px-3 text-[13px] text-ink focus:border-brand" />
    </div>
  );
}

/** Runs the sample load through the server's own engine — the same code the parcha uses. */
function ParchaPreview({ cfg }: { cfg: ChargeConfig }) {
  const { t, pick } = useI18n();
  const f = useFormat();
  const [sample, setSample] = useState({ grossQtl: 315.3, katte: 800, bore: 0, rate: 3413.45, advanceRupees: 10000, manualDaraRupees: 3597.38 });
  const [res, setRes] = useState<ParchaResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    const id = setTimeout(() => {
      api.post<ParchaResult>("/merchants/preview", { chargeConfig: cfg, ...sample, bags: sample.katte + sample.bore })
        .then((r) => { if (!cancelled) setRes(r); })
        .catch(() => { /* preview only */ });
    }, 220);
    return () => { cancelled = true; clearTimeout(id); };
  }, [cfg, sample]);

  return (
    <Card className="sticky top-4">
      <CardHeader title={<span className="inline-flex items-center gap-1.5"><Calculator className="h-3.5 w-3.5 text-brand" />{t("merchant.preview")}</span>}
        sub={t("merchant.previewSub")} />
      <div className="grid grid-cols-3 gap-2 border-b border-line p-3">
        <NumBox label={t("merchant.previewGross")} width="" value={sample.grossQtl} onChange={(v) => setSample((p) => ({ ...p, grossQtl: v }))} />
        <NumBox label={t("merchant.previewKatte")} width="" value={sample.katte} onChange={(v) => setSample((p) => ({ ...p, katte: Math.round(v) }))} />
        <NumBox label={t("merchant.previewBore")} width="" value={sample.bore} onChange={(v) => setSample((p) => ({ ...p, bore: Math.round(v) }))} />
        <NumBox label={t("merchant.previewRate")} width="" value={sample.rate} onChange={(v) => setSample((p) => ({ ...p, rate: v }))} />
        <NumBox label={t("merchant.previewAdvance")} width="" value={sample.advanceRupees} onChange={(v) => setSample((p) => ({ ...p, advanceRupees: v }))} />
        <NumBox label={t("merchant.previewDara")} width="" value={sample.manualDaraRupees} onChange={(v) => setSample((p) => ({ ...p, manualDaraRupees: v }))} />
      </div>

      {!res ? <div className="p-3"><SkeletonForm fields={4} /></div> : (
        <div className="p-3">
          <table className="w-full text-[13px]">
            <tbody>
              {res.lines.map((l) => {
                const strong = l.kind === "total";
                const sub = l.kind === "subtotal";
                return (
                  <tr key={l.key} className={cn(
                    (strong || sub) && "border-t border-line",
                    strong && "border-t-2 border-ink/25",
                  )}>
                    <td className={cn("py-1.5 pr-2", strong && "font-semibold text-[14px]", sub && "font-medium", l.kind === "info" && "text-muted")}>
                      {pick(l.label, l.labelHi)}
                      {l.detail && <span className="ml-1.5 text-[11px] text-faint">{l.detail}</span>}
                      {l.sign === "subtract" && <span className="ml-1 text-bad">−</span>}
                    </td>
                    <td className={cn("num py-1.5 text-right whitespace-nowrap",
                      strong && "font-bold text-[15px] text-brand", sub && "font-semibold",
                      l.kind === "info" && "text-muted")}>
                      {f.money(l.amountPaise)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="mt-2.5 border-t border-line pt-2 text-[11px] leading-relaxed text-faint">
            {t("merchant.previewLine", { net: f.weight(res.netGrams, { unit: true }), katte: f.int(res.katte), bore: res.bore ? ` + ${t("merchant.boreN", { n: f.int(res.bore) })}` : "", bardana: f.weight(res.bardanaGrams, { unit: true }) })}
            {f.words(res.grandTotalPaise) && <> · {f.words(res.grandTotalPaise)}</>}
          </p>
        </div>
      )}
    </Card>
  );
}

function MillDialog({ open, onClose, editing }: { open: boolean; onClose: () => void; editing: Merchant | null }) {
  const { t, lang } = useI18n();
  const qc = useQueryClient();
  const isNew = !editing;
  const [tab, setTab] = useState<"details" | "charges" | "layout">("details");
  const [err, setErr] = useState<string | null>(null);

  const defaults = useQuery({
    queryKey: ["merchants", "defaults"],
    queryFn: () => api.get<ChargeConfig>("/merchants/defaults"),
    enabled: isNew,
  });

  const [f, setF] = useState(() => ({
    code: editing?.code ?? "", name: editing?.name ?? "", nameHi: editing?.nameHi ?? "",
    addressLine1: editing?.addressLine1 ?? "", addressLine2: editing?.addressLine2 ?? "",
    city: editing?.city ?? "", state: editing?.state ?? "", pincode: editing?.pincode ?? "",
    contactPerson: editing?.contactPerson ?? "", phone: editing?.phone ?? "",
    gstin: editing?.gstin ?? "", active: editing?.active ?? true,
    openingBalance: editing ? (editing.openingBalancePaise ?? 0) / 100 : null as number | null,
  }));
  const [cfg, setCfg] = useState<ChargeConfig | null>(editing?.chargeConfig ?? null);

  useEffect(() => { if (!cfg && defaults.data) setCfg(defaults.data); }, [defaults.data]);

  const patch = <K extends keyof ChargeConfig>(k: K, v: ChargeConfig[K]) =>
    setCfg((p) => (p ? { ...p, [k]: v } : p));

  const save = useMutation({
    mutationFn: () => {
      const { openingBalance, ...rest } = f;
      const payload = { ...rest, openingBalanceRupees: openingBalance ?? 0, chargeConfig: cfg ?? undefined };
      return isNew ? api.post("/merchants", payload) : api.put(`/merchants/${editing!.id}`, payload);
    },
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ["merchants"] }); onClose(); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });

  return (
    <Dialog
      open={open} onClose={onClose} wide
      title={isNew ? t("merchant.add") : `${t("merchant.edit")} — ${editing!.name}`}
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" loading={save.isPending}
            disabled={!f.name.trim() || !f.code.trim() || !cfg}
            onClick={() => { setErr(null); save.mutate(); }}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      {err && <Alert tone="bad" className="mb-3">{err}</Alert>}

      <Tabs value={tab} onChange={setTab} className="mb-4"
        tabs={[
          { value: "details", label: t("biz.profile") },
          { value: "charges", label: t("merchant.charges") },
          { value: "layout", label: t("merchant.parchaLayout") },
        ]} />

      {tab === "details" && (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-[120px_1fr]">
            <Field label={t("merchant.code")} hint={t("merchant.codeHelp")} required>
              <Input value={f.code} mono className="uppercase"
                onChange={(e) => setF((p) => ({ ...p, code: e.target.value.toUpperCase() }))} maxLength={12} />
            </Field>
            <Field label={t("merchant.name")} required>
              <Input value={f.name} onChange={(e) => setF((p) => ({ ...p, name: e.target.value }))}
                placeholder="Shri Laxmi Badri Agro Foods Pvt Ltd" />
            </Field>
          </div>
          <Field label={t("merchant.nameHi")}>
            <HindiInput value={f.nameHi} onChange={(v) => setF((p) => ({ ...p, nameHi: v }))} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("biz.addressLine1")}>
              <Input value={f.addressLine1} onChange={(e) => setF((p) => ({ ...p, addressLine1: e.target.value }))} />
            </Field>
            <Field label={t("biz.addressLine2")}>
              <Input value={f.addressLine2} onChange={(e) => setF((p) => ({ ...p, addressLine2: e.target.value }))} />
            </Field>
            <Field label={t("biz.city")}>
              <Input value={f.city} onChange={(e) => setF((p) => ({ ...p, city: e.target.value }))} placeholder="Kiccha" />
            </Field>
            <Field label={t("biz.state")}>
              <Input value={f.state} onChange={(e) => setF((p) => ({ ...p, state: e.target.value }))} />
            </Field>
            <Field label={t("biz.pincode")}>
              <Input value={f.pincode} onChange={(e) => setF((p) => ({ ...p, pincode: e.target.value }))} mono />
            </Field>
            <Field label={t("biz.gstin")}>
              <Input value={f.gstin} onChange={(e) => setF((p) => ({ ...p, gstin: e.target.value.toUpperCase() }))} mono className="uppercase" />
            </Field>
            <Field label={t("merchant.contactPerson")}>
              <Input value={f.contactPerson} onChange={(e) => setF((p) => ({ ...p, contactPerson: e.target.value }))} />
            </Field>
            <Field label={t("adati.phone")}>
              <Input value={f.phone} onChange={(e) => setF((p) => ({ ...p, phone: e.target.value }))} mono inputMode="tel" />
            </Field>
            <Field label={t("mm.opening")} hint={t("mm.openingHelp")} className="sm:col-span-2">
              <NumberInput value={f.openingBalance} decimals={2} allowNegative
                onValueChange={(n) => setF((p) => ({ ...p, openingBalance: n }))}
                className="h-9.5 w-full rounded-lg border bg-surface px-3 text-right font-mono text-sm tabular-nums text-ink focus:border-brand" placeholder="0.00" />
            </Field>
          </div>
          <div className="border-t border-line pt-4">
            <Switch checked={f.active} onChange={(v) => setF((p) => ({ ...p, active: v }))} label={t("common.active")} />
          </div>
        </div>
      )}

      {tab === "charges" && cfg && (
        <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
          <div className="space-y-3">
            <div className="rounded-lg border border-line bg-raised/30 p-3">
              <p className="mb-2.5 text-[13px] font-semibold text-ink">{t("merchant.weights")}</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t("merchant.katauti")} hint={t("merchant.katautiHelp")}>
                  <div className="flex gap-2">
                    <Select value={cfg.katauti.mode} className="h-8 flex-1 text-[13px]"
                      onChange={(e) => patch("katauti", { ...cfg.katauti, mode: e.target.value as ChargeConfig["katauti"]["mode"] })}>
                      <option value="per_quintal_rounded">{t("merchant.katautiMode.per_quintal_rounded")}</option>
                      <option value="per_quintal_exact">{t("merchant.katautiMode.per_quintal_exact")}</option>
                      <option value="none">{t("merchant.katautiMode.none")}</option>
                    </Select>
                    <NumberInput value={cfg.katauti.kgPerUnit} emptyValue={0}
                      onValueChange={(n) => patch("katauti", { ...cfg.katauti, kgPerUnit: n ?? 0 })}
                      className="h-8 w-20 rounded-lg border bg-surface px-3 text-[13px] text-ink focus:border-brand" />
                  </div>
                </Field>
                <Field label={t("merchant.millBardana")} hint={t("merchant.millBardanaHelp")}>
                  <NumberInput value={cfg.millBardanaKgPerBag} emptyValue={0}
                    onValueChange={(n) => patch("millBardanaKgPerBag", n ?? 0)}
                    className="h-8 w-full rounded-lg border bg-surface px-3 text-[13px] text-ink focus:border-brand" />
                </Field>
                <Field label={t("merchant.boreBardana")} hint={t("merchant.boreBardanaHelp")}>
                  <NumberInput value={cfg.millBoreBardanaKgPerBag} emptyValue={0}
                    onValueChange={(n) => patch("millBoreBardanaKgPerBag", n ?? 0)}
                    className="h-8 w-full rounded-lg border bg-surface px-3 text-[13px] text-ink focus:border-brand" />
                </Field>
              </div>
            </div>

            <ChargeRow label={t("merchant.adat")} enabled={cfg.adat.enabled}
              onEnabled={(v) => patch("adat", { ...cfg.adat, enabled: v })} unit="%">
              <NumBox value={cfg.adat.pct} onChange={(v) => patch("adat", { ...cfg.adat, pct: v })} />
            </ChargeRow>

            <ChargeRow label={t("merchant.labour1")} enabled={cfg.labour1.enabled}
              onEnabled={(v) => patch("labour1", { ...cfg.labour1, enabled: v })} unit={t("common.perBag")}>
              <NumBox value={cfg.labour1.perBagRupees} onChange={(v) => patch("labour1", { ...cfg.labour1, perBagRupees: v })} />
              <BagKindSelect value={cfg.labour1.appliesTo} onChange={(v) => patch("labour1", { ...cfg.labour1, appliesTo: v })} />
            </ChargeRow>

            <ChargeRow label={t("merchant.labour2")} enabled={cfg.labour2.enabled}
              onEnabled={(v) => patch("labour2", { ...cfg.labour2, enabled: v })} unit={t("common.perBag")}>
              <NumBox value={cfg.labour2.perBagRupees} onChange={(v) => patch("labour2", { ...cfg.labour2, perBagRupees: v })} />
              <BagKindSelect value={cfg.labour2.appliesTo} onChange={(v) => patch("labour2", { ...cfg.labour2, appliesTo: v })} />
            </ChargeRow>

            <ChargeRow label={t("merchant.sutli")} enabled={cfg.sutli.enabled}
              onEnabled={(v) => patch("sutli", { ...cfg.sutli, enabled: v })} unit={t("common.perBag")}>
              <NumBox value={cfg.sutli.perBagRupees} onChange={(v) => patch("sutli", { ...cfg.sutli, perBagRupees: v })} />
              <BagKindSelect value={cfg.sutli.appliesTo} onChange={(v) => patch("sutli", { ...cfg.sutli, appliesTo: v })} />
            </ChargeRow>

            <ChargeRow label={t("merchant.gaushala")} enabled={cfg.gaushala.enabled}
              onEnabled={(v) => patch("gaushala", { ...cfg.gaushala, enabled: v })} unit={t("common.perQtl")}>
              <NumBox value={cfg.gaushala.perQtlRupees} onChange={(v) => patch("gaushala", { ...cfg.gaushala, perQtlRupees: v })} />
              <div className="min-w-[180px]">
                <label className="mb-1 block text-[11px] text-faint">{t("merchant.chargedOn")}</label>
                <Select value={cfg.gaushala.base} className="h-8 text-[13px]"
                  onChange={(e) => patch("gaushala", { ...cfg.gaushala, base: e.target.value as "gross" | "net" })}>
                  <option value="gross">{t("merchant.weightBase.gross")}</option>
                  <option value="net">{t("merchant.weightBase.net")}</option>
                </Select>
              </div>
            </ChargeRow>

            <ChargeRow label={t("merchant.mandiTax")} enabled={cfg.mandiTax.enabled}
              onEnabled={(v) => patch("mandiTax", { ...cfg.mandiTax, enabled: v })} unit="%">
              <NumBox value={cfg.mandiTax.pct} onChange={(v) => patch("mandiTax", { ...cfg.mandiTax, pct: v })} />
              <BaseSelect value={cfg.mandiTax.base} onChange={(v) => patch("mandiTax", { ...cfg.mandiTax, base: v })} />
            </ChargeRow>

            <ChargeRow label={t("merchant.commission")} enabled={cfg.commission.enabled}
              onEnabled={(v) => patch("commission", { ...cfg.commission, enabled: v })} unit="%">
              <NumBox value={cfg.commission.pct} onChange={(v) => patch("commission", { ...cfg.commission, pct: v })} />
              <BaseSelect value={cfg.commission.base} onChange={(v) => patch("commission", { ...cfg.commission, base: v })} />
            </ChargeRow>

            <ChargeRow label={t("merchant.gatePass")} enabled={cfg.gatePass.enabled}
              onEnabled={(v) => patch("gatePass", { ...cfg.gatePass, enabled: v })} unit={t("common.perTruck")}>
              <NumBox value={cfg.gatePass.perTruckRupees} onChange={(v) => patch("gatePass", { ...cfg.gatePass, perTruckRupees: v })} />
            </ChargeRow>

            {/* dara */}
            <div className="rounded-lg border border-line bg-surface p-3">
              <p className="mb-2.5 text-[13px] font-semibold text-ink">{t("merchant.dara")}</p>
              <div className="flex flex-wrap items-end gap-2">
                <div className="min-w-[160px]">
                  <label className="mb-1 block text-[11px] text-faint">{t("merchant.dara")}</label>
                  <Select value={cfg.dara.mode} className="h-8 text-[13px]"
                    onChange={(e) => patch("dara", { ...cfg.dara, mode: e.target.value as ChargeConfig["dara"]["mode"] })}>
                    <option value="none">{t("merchant.daraMode.none")}</option>
                    <option value="per_bag">{t("merchant.daraMode.per_bag")}</option>
                    <option value="per_qtl">{t("merchant.daraMode.per_qtl")}</option>
                    <option value="pct">{t("merchant.daraMode.pct")}</option>
                    <option value="manual">{t("merchant.daraMode.manual")}</option>
                  </Select>
                </div>
                {cfg.dara.mode !== "none" && cfg.dara.mode !== "manual" && (
                  <NumBox label={t("common.rupees")} value={cfg.dara.value}
                    onChange={(v) => patch("dara", { ...cfg.dara, value: v })} />
                )}
              </div>
              {cfg.dara.mode !== "none" && (
                <div className="mt-3">
                  <Switch checked={cfg.dara.includeInGrandTotal}
                    onChange={(v) => patch("dara", { ...cfg.dara, includeInGrandTotal: v })}
                    label={t("merchant.daraInTotal")} hint={t("merchant.daraInTotalHelp")} />
                </div>
              )}
            </div>

            {/* advance + rounding */}
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("merchant.advanceTreatment")} hint={t("merchant.advanceHelp")}>
                <Select value={cfg.advance.treatment} className="h-8 text-[13px]"
                  onChange={(e) => patch("advance", { ...cfg.advance, treatment: e.target.value as ChargeConfig["advance"]["treatment"] })}>
                  <option value="add">{t("merchant.advance.add")}</option>
                  <option value="subtract">{t("merchant.advance.subtract")}</option>
                  <option value="exclude">{t("merchant.advance.exclude")}</option>
                </Select>
              </Field>
              <Field label={t("merchant.rounding")}>
                <Select value={cfg.grandTotalRounding} className="h-8 text-[13px]"
                  onChange={(e) => patch("grandTotalRounding", e.target.value as ChargeConfig["grandTotalRounding"])}>
                  <option value="none">{t("merchant.rounding.none")}</option>
                  <option value="nearest_rupee">{t("merchant.rounding.nearest_rupee")}</option>
                  <option value="up_rupee">{t("merchant.rounding.up_rupee")}</option>
                  <option value="nearest_ten">{t("merchant.rounding.nearest_ten")}</option>
                </Select>
              </Field>
            </div>
          </div>

          <ParchaPreview cfg={cfg} />
        </div>
      )}

      {tab === "layout" && cfg && (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={`${t("merchant.parchaLayout")} — ${t("common.english")}`}>
              <Input value={cfg.parcha.title} onChange={(e) => patch("parcha", { ...cfg.parcha, title: e.target.value })} />
            </Field>
            <Field label={`${t("merchant.parchaLayout")} — ${t("common.hindi")}`}>
              <HindiInput value={cfg.parcha.titleHi} onChange={(v) => patch("parcha", { ...cfg.parcha, titleHi: v })} />
            </Field>
            <Field label={t("merchant.paymentTerms")}>
              <NumberInput integer value={cfg.paymentTermsDays} emptyValue={0}
                onValueChange={(n) => patch("paymentTermsDays", n ?? 0)}
                className="h-9.5 w-full rounded-lg border bg-surface px-3 text-sm text-ink focus:border-brand" />
            </Field>
          </div>
          <div className="space-y-3 rounded-lg border border-line p-3">
            <Switch checked={cfg.parcha.showDaraRow} onChange={(v) => patch("parcha", { ...cfg.parcha, showDaraRow: v })}
              label={`${t("merchant.dara")} — ${t("merchant.enabled")}`} />
            <Switch checked={cfg.parcha.showBoreColumns} onChange={(v) => patch("parcha", { ...cfg.parcha, showBoreColumns: v })}
              label={t("merchant.boreKatteCols")} />
          </div>
          <Field label={t("adati.notes")}>
            <Textarea value={cfg.notes} lang={lang} onChange={(e) => patch("notes", e.target.value)} />
          </Field>
        </div>
      )}
    </Dialog>
  );
}

export function MillsPage() {
  const { t, pick } = useI18n();
  const f = useFormat();
  const qc = useQueryClient();
  const { can } = useSession();
  const [dialog, setDialog] = useState<{ open: boolean; editing: Merchant | null }>({ open: false, editing: null });
  const [notice, setNotice] = useState<string | null>(null);
  // a done-message fades; it must not sit there describing an older action
  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(id);
  }, [notice]);

  const list = useQuery({ queryKey: ["merchants", "all"], queryFn: () => api.get<Merchant[]>("/merchants?all=1") });

  const del = useMutation({
    mutationFn: (id: string) => api.del<{ deactivated: boolean }>(`/merchants/${id}`),
    onSuccess: async (r) => {
      setNotice(r.deactivated ? t("merchant.deactivated") : t("common.deleted"));
      await qc.invalidateQueries({ queryKey: ["merchants"] });
    },
  });

  const rows = list.data ?? [];
  const sort = useSort(rows, {
    code: (m) => m.code, name: (m) => m.name, city: (m) => m.city,
    adat: (m) => (m.chargeConfig.adat.enabled ? m.chargeConfig.adat.pct : null),
    mandiTax: (m) => (m.chargeConfig.mandiTax.enabled ? m.chargeConfig.mandiTax.pct : null),
    commission: (m) => (m.chargeConfig.commission.enabled ? m.chargeConfig.commission.pct : null),
  }, { storageKey: "mills" });

  return (
    <>
      <PageHeader
        title={t("merchant.title")} sub={t("merchant.sub")}
        action={can("merchant.write") && (
          <Button variant="primary" icon={<Plus className="h-4 w-4" />}
            onClick={() => setDialog({ open: true, editing: null })}>{t("merchant.add")}</Button>
        )}
      />

      {notice && <Alert tone="ok" className="mb-4">{notice}</Alert>}

      <Card>
        {list.isLoading ? (
          <SkeletonTable rows={4} cols={[{ w: "w-16" }, { w: "w-56" }, { w: "w-32" }, { w: "w-24", numeric: true }, { w: "w-20", numeric: true }, { w: "w-16" }]} />
        ) : rows.length === 0 ? (
          <EmptyState icon={<Factory className="h-8 w-8" />} title={t("merchant.empty")} sub={t("merchant.emptySub")}
            action={can("merchant.write") && (
              <Button variant="primary" icon={<Plus className="h-4 w-4" />}
                onClick={() => setDialog({ open: true, editing: null })}>{t("merchant.add")}</Button>
            )} />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th className="w-20" {...sort.th("code")}>{t("merchant.code")}</Th>
                <Th {...sort.th("name")}>{t("merchant.name")}</Th>
                <Th {...sort.th("city")}>{t("biz.city")}</Th>
                <Th numeric {...sort.th("adat")}>{t("merchant.adat")}</Th>
                <Th numeric {...sort.th("mandiTax")}>{t("merchant.mandiTax")}</Th>
                <Th numeric {...sort.th("commission")}>{t("merchant.commission")}</Th>
                <Th numeric>{t("merchant.labour1")}</Th>
                <Th align="center">{t("merchant.dara")}</Th>
                <Th className="w-20" />
              </tr>
            </thead>
            <tbody>
              {sort.sorted.map((m) => (
                <Tr key={m.id} className={cn(!m.active && "opacity-55")}>
                  <Td><Badge tone="brand" className="num">{m.code}</Badge></Td>
                  <Td>
                    <p className="font-medium">{pick(m.name, m.nameHi)}</p>
                    {m.contactPerson && <p className="text-[11px] text-faint">{m.contactPerson}</p>}
                  </Td>
                  <Td className="text-muted">{m.city}</Td>
                  <Td numeric>{m.chargeConfig.adat.enabled ? `${m.chargeConfig.adat.pct}%` : <span className="text-faint">—</span>}</Td>
                  <Td numeric>{m.chargeConfig.mandiTax.enabled ? `${m.chargeConfig.mandiTax.pct}%` : <span className="text-faint">—</span>}</Td>
                  <Td numeric>{m.chargeConfig.commission.enabled ? `${m.chargeConfig.commission.pct}%` : <span className="text-faint">—</span>}</Td>
                  <Td numeric>{m.chargeConfig.labour1.enabled ? f.money(Math.round(m.chargeConfig.labour1.perBagRupees * 100)) : <span className="text-faint">—</span>}</Td>
                  <Td align="center">
                    {m.chargeConfig.dara.mode === "none"
                      ? <span className="text-faint">—</span>
                      : <Badge tone={m.chargeConfig.dara.includeInGrandTotal ? "ok" : "neutral"}>
                          {t(`merchant.daraMode.${m.chargeConfig.dara.mode}` as never)}
                        </Badge>}
                  </Td>
                  <Td>
                    <div className="flex items-center justify-end gap-0.5">
                      {can("merchant.write") && (
                        <Button variant="ghost" size="icon" className="h-7 w-7"
                          onClick={() => setDialog({ open: true, editing: m })} aria-label={t("common.edit")}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      {can("merchant.delete") && (
                        <Button variant="ghost" size="icon" className="h-7 w-7"
                          onClick={() => { if (confirm(t("merchant.confirmDelete", { name: `${m.code} — ${m.name}` }))) del.mutate(m.id); }}
                          aria-label={t("common.delete")}>
                          <Trash2 className="h-3.5 w-3.5 text-bad/80" />
                        </Button>
                      )}
                    </div>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Alert tone="neutral" className="mt-4">
        <span className="inline-flex items-start gap-2">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{t("merchant.chargesSub")}. {t("merchant.daraInTotalHelp")}</span>
        </span>
      </Alert>

      {dialog.open && (
        <MillDialog key={dialog.editing?.id ?? "new"} open={dialog.open} editing={dialog.editing}
          onClose={() => setDialog({ open: false, editing: null })} />
      )}
    </>
  );
}
