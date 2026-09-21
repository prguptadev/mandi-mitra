import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearch } from "wouter";
import { Download, CheckCircle2, Wrench, ChevronDown, CalendarDays } from "lucide-react";
import { api, ApiError } from "@/lib/api.ts";
import { useI18n } from "@/lib/i18n.tsx";
import { useSession } from "@/lib/session.tsx";
import { useFYRange } from "@/lib/fy.tsx";
import { useConfirm } from "@/components/Confirm.tsx";
import { PageHeader } from "@/components/AppShell.tsx";
import { Alert, Badge, Button, Card, CardHeader, Checkbox, Field, Input, Select, Switch, Table, Td, Th, Tr } from "@/components/ui/index.tsx";
import { SupplierPicker } from "@/components/SupplierPicker.tsx";
import { TallyBadge } from "@/pages/DayClose.tsx";
import { dmy, weekday } from "@/lib/utils.ts";
import type { Merchant } from "@/lib/api.ts";
import { defaultTallySettings, type TallySettings } from "@server/lib/tally.ts";

/* Sending the books to Tally Prime. The app writes two files — the ledgers
   (suppliers, mills, accounts) and the vouchers — which Tally reads through
   Gateway of Tally › Import. What went is remembered, so the next file holds
   only what is new, and anything changed here afterwards is listed. */

const KINDS = ["slip", "payment", "parcha", "receipt", "cut"] as const;
type Kind = (typeof KINDS)[number];
interface Preview {
  vouchers: number; entries: Record<Kind, number>; unpriced: number; alreadySent: number;
  ledgers: string[]; charges: { key: string; label: string }[];
  changed: { kind: Kind; id: string; sent: string; now: string | null; exportedAt: number }[];
}
interface ExportResult { ledgersXml: string; vouchersXml: string; entries: { kind: Kind; id: string; fp: string }[]; vouchers: number; ledgers: number }
type T4 = { new: number; sent: number; changed: number; unpriced: number };
interface TallyDay { day: string; all: T4; kinds: Partial<Record<Kind, T4>> }
type Body = { from: string; to: string; kinds: Kind[]; onlyNew: boolean; adatiId?: string | null; merchantId?: string | null };

const save = (text: string, name: string) => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "application/xml;charset=utf-8" }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};

export function TallyPage() {
  const { t, pick, lang } = useI18n();
  const { can } = useSession();
  const qc = useQueryClient();
  const ask = useConfirm();
  const { from, setFrom, to, setTo, fy } = useFYRange();
  // whose entries: everyone's, one supplier's (purchases, payments), or one mill's (sales, cuts, money, purchases for it)
  const [whose, setWhose] = useState<"all" | "supplier" | "mill">("all");
  const [adatiId, setAdatiId] = useState<string | null>(null);
  const [merchantId, setMerchantId] = useState<string>("");
  const mills = useQuery({ queryKey: ["merchants"], queryFn: () => api.get<Merchant[]>("/merchants") });
  // opened from a day's Tally mark (/tally?day=2026-09-20): just that day
  const day = new URLSearchParams(useSearch()).get("day");
  useEffect(() => { if (day && /^\d{4}-\d{2}-\d{2}$/.test(day)) { setFrom(day); setTo(day); } }, [day]);
  const [kinds, setKinds] = useState<Kind[]>([...KINDS]);
  const [onlyNew, setOnlyNew] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const party = whose === "supplier" && adatiId ? { adatiId } : whose === "mill" && merchantId ? { merchantId } : {};
  const partyTag = whose === "supplier" && adatiId ? "-supplier" : whose === "mill" && merchantId ? `-${mills.data?.find((m) => m.id === merchantId)?.code ?? "mill"}` : "";
  const body: Body = { from, to, kinds, onlyNew, ...party };
  const dq = useQuery({
    queryKey: ["tally", "days", body],
    queryFn: () => api.post<{ days: TallyDay[] }>("/tally/days", body),
    enabled: Boolean(from && to && kinds.length),
  });
  const pv = useQuery({
    queryKey: ["tally", "preview", body],
    queryFn: () => api.post<Preview>("/tally/preview", body),
    enabled: Boolean(from && to && kinds.length),
  });
  const p = pv.data;

  const mark = useMutation({
    mutationFn: (entries: ExportResult["entries"]) => api.post<{ marked: number }>("/tally/mark", { entries }),
    onSuccess: async (r) => { setDone(t("tally.marked", { n: r.marked })); await qc.invalidateQueries({ queryKey: ["tally"] }); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });
  const exp = useMutation({
    mutationFn: (b: Body) => api.post<ExportResult>("/tally/export", b),
    onSuccess: async (r, b) => {
      setErr(null);
      const span = (b.from === b.to ? b.from : `${b.from}-to-${b.to}`) + partyTag;
      save(r.ledgersXml, `tally-1-ledgers-${span}.xml`);
      setTimeout(() => save(r.vouchersXml, `tally-2-vouchers-${span}.xml`), 400);
      // only once Tally has taken them are they counted as sent
      if (await ask({
        title: t("tally.didImport"),
        message: t("tally.didImportSub"),
        rows: [{ label: t("tally.vouchers"), value: String(r.vouchers) }, { label: t("tally.ledgerCount"), value: String(r.ledgers) }],
        confirmLabel: t("tally.yesImported"),
      })) mark.mutate(r.entries);
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });
  const fixed = useMutation({
    mutationFn: (x: Preview["changed"][number]) => api.post("/tally/fixed", { kind: x.kind, id: x.id, now: x.now }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ["tally"] }); },
  });

  const toggle = (k: Kind) => setKinds((ks) => (ks.includes(k) ? ks.filter((x) => x !== k) : [...ks, k]));

  return (
    <div>
      <PageHeader title={t("tally.title")} sub={t("tally.sub")} />
      {err && <Alert tone="bad" className="mb-3">{err}</Alert>}
      {done && <Alert tone="ok" className="mb-3">{done}</Alert>}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="space-y-5">
          <Card>
            <CardHeader title={t("tally.what")} sub={t("tally.fyNote", { y: fy.label })} />
            <div className="space-y-4 p-4">
              <div className="flex flex-wrap items-end gap-3">
                <Field label={t("common.from")}><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-9 w-40" /></Field>
                <Field label={t("common.to")}><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-9 w-40" /></Field>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {KINDS.map((k) => (
                  <Checkbox key={k} checked={kinds.includes(k)} onChange={() => toggle(k)}
                    label={`${t(`tally.kind.${k}`)}${p ? ` — ${p.entries[k] ?? 0}` : ""}`} />
                ))}
              </div>
              <div className="space-y-2">
                <p className="text-[12px] font-semibold text-ink">{t("tally.whose")}</p>
                <div className="inline-flex rounded-lg border border-line bg-raised/50 p-0.5">
                  {(["all", "supplier", "mill"] as const).map((w) => (
                    <button key={w} type="button" onClick={() => setWhose(w)}
                      className={"rounded-md px-3 py-1.5 text-[13px] font-medium " + (whose === w ? "bg-surface text-ink shadow-card" : "text-muted hover:text-ink")}>
                      {t(`tally.whose.${w}`)}
                    </button>
                  ))}
                </div>
                {whose === "supplier" && (
                  <div className="max-w-sm"><SupplierPicker value={adatiId} onChange={setAdatiId} placeholder={t("tally.pickSupplier")} /></div>
                )}
                {whose === "mill" && (
                  <Select value={merchantId} onChange={(e) => setMerchantId(e.target.value)} className="max-w-sm">
                    <option value="">{t("tally.pickMill")}</option>
                    {mills.data?.map((m) => <option key={m.id} value={m.id}>{m.code} — {pick(m.name, m.nameHi)}</option>)}
                  </Select>
                )}
                {whose !== "all" && <p className="text-[12px] text-muted">{t(whose === "supplier" ? "tally.whoseSupplierSub" : "tally.whoseMillSub")}</p>}
              </div>
              <Switch checked={onlyNew} onChange={setOnlyNew} label={t("tally.onlyNew")} />
              {p && (
                <div className="space-y-1 rounded-lg border border-line bg-raised/40 p-3 text-[13px]">
                  <p><b>{p.vouchers}</b> {t("tally.vouchersGo")} · <b>{p.ledgers.length}</b> {t("tally.ledgersGo")}</p>
                  {onlyNew && p.alreadySent > 0 && <p className="text-muted">{t("tally.alreadySent", { n: p.alreadySent })}</p>}
                  {p.unpriced > 0 && <p className="text-warn">{t("tally.unpriced", { n: p.unpriced })}</p>}
                </div>
              )}
              <Button variant="primary" size="lg" icon={<Download className="h-4 w-4" />} loading={exp.isPending}
                disabled={!p || p.vouchers === 0 || !can("export.data")}
                onClick={() => { setErr(null); setDone(null); exp.mutate(body); }}>
                {t("tally.download")}
              </Button>
            </div>
          </Card>

          <Card>
            <CardHeader title={t("tally.daysTitle")} sub={t("tally.daysSub")} />
            {!dq.data?.days.length ? (
              <p className="p-4 text-[13px] text-muted">{dq.isLoading ? "…" : t("tally.daysNone")}</p>
            ) : (
              <div className="max-h-[480px] overflow-y-auto">
                <Table>
                  <thead>
                    <tr>
                      <Th>{t("dc.day")}</Th>
                      {KINDS.filter((k) => kinds.includes(k)).map((k) => <Th key={k} numeric>{t(`tally.short.${k}`)}</Th>)}
                      <Th>{t("dc.tally")}</Th>
                      <Th />
                    </tr>
                  </thead>
                  <tbody>
                    {dq.data.days.map((d) => (
                      <Tr key={d.day}>
                        <Td className="whitespace-nowrap"><span className="num font-medium text-ink">{dmy(d.day)}</span><span className="ml-1.5 text-[11px] text-faint">{weekday(d.day, lang)}</span></Td>
                        {KINDS.filter((k) => kinds.includes(k)).map((k) => {
                          const c = d.kinds[k];
                          const n = c ? c.new + c.sent + c.changed : 0;
                          return (
                            <Td key={k} numeric>
                              {!n ? <span className="text-faint">—</span> : (
                                <span title={t("tally.cellTip", { sent: c!.sent, fresh: c!.new, changed: c!.changed })}>
                                  <span className={c!.new || c!.changed ? "font-semibold text-ink" : "text-ok"}>{c!.sent}/{n}</span>
                                  {c!.unpriced ? <span className="ml-1 text-[11px] text-warn">+{c!.unpriced}</span> : null}
                                </span>
                              )}
                            </Td>
                          );
                        })}
                        <Td><TallyBadge s={d.all} /></Td>
                        <Td align="right">
                          {d.all.new > 0 && can("export.data") && (
                            <Button size="sm" variant="secondary" icon={<Download className="h-3.5 w-3.5" />} loading={exp.isPending && exp.variables?.from === d.day && exp.variables?.to === d.day}
                              onClick={() => { setErr(null); setDone(null); exp.mutate({ ...body, from: d.day, to: d.day, onlyNew: true }); }}>
                              {t("tally.sendDay")}
                            </Button>
                          )}
                        </Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            )}
            <p className="flex items-center gap-1.5 border-t border-line px-4 py-2 text-[12px] text-muted"><CalendarDays className="h-3.5 w-3.5" />{t("tally.daysHint")}</p>
          </Card>

          {p && p.changed.length > 0 && (
            <Card>
              <CardHeader title={t("tally.changedTitle", { n: p.changed.length })} sub={t("tally.changedSub")} />
              <div className="divide-y divide-line">
                {p.changed.map((x) => (
                  <div key={`${x.kind}-${x.id}`} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-[13px]">
                    <Badge tone={x.now ? "warn" : "bad"}>{t(`tally.kind.${x.kind}`)}</Badge>
                    <span className="num min-w-0 flex-1 break-all text-muted">
                      {x.now ? t("tally.wasNow", { was: x.sent.split("|").join(" · "), now: x.now.split("|").join(" · ") }) : t("tally.goneHere", { was: x.sent.split("|").join(" · ") })}
                    </span>
                    <Button size="sm" variant="secondary" icon={<Wrench className="h-3.5 w-3.5" />} loading={fixed.isPending}
                      onClick={async () => { if (await ask({ title: t("tally.fixedTitle"), message: t("tally.fixedSub") })) fixed.mutate(x); }}>
                      {t("tally.fixedBtn")}
                    </Button>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>

        <div className="space-y-5">
          <Card>
            <CardHeader title={t("tally.howTitle")} />
            <ol className="list-decimal space-y-2 p-4 pl-8 text-[13px] leading-relaxed text-ink">
              <li>{t("tally.how1")}</li>
              <li>{t("tally.how2")}</li>
              <li>{t("tally.how3")}</li>
              <li>{t("tally.how4")}</li>
              <li>{t("tally.how5")}</li>
            </ol>
            <p className="px-4 pb-4 text-[12px] leading-snug text-muted">{t("tally.cloud")}</p>
          </Card>
          <TallyNamesCard charges={p?.charges ?? []} />
        </div>
      </div>
    </div>
  );
}

/** The names Tally knows things by: the company, the groups, and every ledger the file uses. */
function TallyNamesCard({ charges }: { charges: { key: string; label: string }[] }) {
  const { t } = useI18n();
  const { can } = useSession();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["tally", "settings"], queryFn: () => api.get<TallySettings>("/tally/settings") });
  const [v, setV] = useState<TallySettings>(defaultTallySettings());
  const [open, setOpen] = useState(false);
  const [ok, setOk] = useState(false);
  useEffect(() => { if (q.data) setV(q.data); }, [q.data]);
  const editable = can("settings.write");
  const saveM = useMutation({
    mutationFn: () => api.put<TallySettings>("/tally/settings", v),
    onSuccess: async () => { setOk(true); await qc.invalidateQueries({ queryKey: ["tally"] }); },
  });
  const led = (k: keyof TallySettings["ledgers"], label: string) => (
    <Field label={label}><Input value={v.ledgers[k]} disabled={!editable} onChange={(e) => { setOk(false); setV((p) => ({ ...p, ledgers: { ...p.ledgers, [k]: e.target.value } })); }} /></Field>
  );
  return (
    <Card>
      <button type="button" className="flex w-full items-center justify-between px-4 py-3 text-left" onClick={() => setOpen((o) => !o)}>
        <span><span className="block text-[14px] font-semibold text-ink">{t("tally.namesTitle")}</span><span className="block text-[12px] text-muted">{t("tally.namesSub")}</span></span>
        <ChevronDown className={"h-4 w-4 text-faint transition-transform " + (open ? "rotate-180" : "")} />
      </button>
      {open && (
        <div className="space-y-3 border-t border-line p-4">
          {ok && <Alert tone="ok">{t("common.saved")}</Alert>}
          <Field label={t("tally.company")} hint={t("tally.companyHint")}>
            <Input value={v.companyName} disabled={!editable} onChange={(e) => { setOk(false); setV((p) => ({ ...p, companyName: e.target.value })); }} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("tally.supplierGroup")}><Input value={v.supplierGroup} disabled={!editable} onChange={(e) => setV((p) => ({ ...p, supplierGroup: e.target.value }))} /></Field>
            <Field label={t("tally.millGroup")}><Input value={v.millGroup} disabled={!editable} onChange={(e) => setV((p) => ({ ...p, millGroup: e.target.value }))} /></Field>
            <Field label={t("tally.partyNames")}>
              <Select value={v.partyNames} disabled={!editable} onChange={(e) => setV((p) => ({ ...p, partyNames: e.target.value as TallySettings["partyNames"] }))}>
                <option value="hinglish">{t("common.hinglish")}</option><option value="hindi">{t("common.hindi")}</option>
              </Select>
            </Field>
            <Field label={t("tally.purchasePer")}>
              <Select value={v.purchasePer} disabled={!editable} onChange={(e) => setV((p) => ({ ...p, purchasePer: e.target.value as TallySettings["purchasePer"] }))}>
                <option value="slip">{t("tally.perSlip")}</option><option value="supplierDay">{t("tally.perSupplierDay")}</option>
              </Select>
            </Field>
          </div>
          <p className="pt-1 text-[12px] font-semibold text-ink">{t("tally.ledgerNames")}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {led("purchase", t("tally.l.purchase"))}{led("commissionPaid", t("tally.l.commissionPaid"))}
            {led("gaushalaPaid", t("tally.l.gaushalaPaid"))}{led("sales", t("tally.l.sales"))}
            {led("cash", t("tally.l.cash"))}{led("bank", t("tally.l.bank"))}
            {led("millDeductions", t("tally.l.millDeductions"))}{led("weightShortage", t("tally.l.weightShortage"))}
            {led("advance", t("tally.l.advance"))}{led("dara", t("tally.l.dara"))}{led("roundOff", t("tally.l.roundOff"))}
          </div>
          {charges.length > 0 && (
            <>
              <p className="pt-1 text-[12px] font-semibold text-ink">{t("tally.chargeNames")}</p>
              <div className="grid gap-3 sm:grid-cols-2">
                {charges.map((ch) => (
                  <Field key={ch.key} label={ch.label}>
                    <Input value={v.chargeLedgers[ch.key] ?? ""} placeholder={ch.label} disabled={!editable}
                      onChange={(e) => setV((p) => ({ ...p, chargeLedgers: { ...p.chargeLedgers, [ch.key]: e.target.value } }))} />
                  </Field>
                ))}
              </div>
            </>
          )}
          {editable && <Button variant="primary" loading={saveM.isPending} icon={<CheckCircle2 className="h-4 w-4" />} onClick={() => saveM.mutate()}>{t("common.save")}</Button>}
        </div>
      )}
    </Card>
  );
}
