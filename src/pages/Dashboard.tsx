import { useEffect, useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  PackageOpen, Truck, Warehouse, Wallet, CircleAlert, AlertTriangle, Info, CheckCircle2, ChevronRight, ArrowRight,
} from "lucide-react";
import { api, type Jins } from "@/lib/api.ts";
import { useI18n } from "@/lib/i18n.tsx";
import { useSession } from "@/lib/session.tsx";
import { useFormat } from "@/lib/format.tsx";
import { PageHeader } from "@/components/AppShell.tsx";
import { SkeletonStats, SkeletonTable } from "@/components/Skeletons.tsx";
import { LoadError } from "@/components/LoadError.tsx";
import { useFY } from "@/lib/fy.tsx";
import { AttentionStrip } from "@/components/AttentionStrip.tsx";
import { DayAveragesCard } from "@/components/DayAveragesCard.tsx";
import { PortalRatesCard } from "@/components/PortalRatesCard.tsx";
import { RaceChart, type RacePoint } from "@/components/RaceChart.tsx";
import { Card, CardHeader, Badge, Select, Input, Button } from "@/components/ui/index.tsx";
import { cn, todayISO } from "@/lib/utils.ts";
import { notAfterToday, suppliersNow } from "@/lib/asOfToday.ts";
import { moneyTiles, moneyWords } from "@/lib/moneyFigures.ts";
import { dmy } from "@server/lib/parchaLabels.ts";

/* One picture of the business: what came in, what went out to each mill,
   what is left, what is owed — and everything that does not add up. */

type FlagItem = Record<string, string | number | null>;
interface Flag { code: string; level: "bad" | "warn" | "info"; items: FlagItem[] }
interface MillSummary {
  merchantId: string; code: string; name: string; nameHi: string | null;
  slips: number; boughtNetGrams: number; boughtAmountPaise: number; avgBuyPaisePerQtl: number;
  loadedGrams: number; goodsPaise: number; avgSalePaisePerQtl: number; billedPaise: number;
  trucks: number; drafts: number; openingGrams: number; leftGrams: number;
  series: RacePoint[]; worstAhead: { date: string; grams: number } | null;
  /** All time, and only for those who may see money. */
  owedPaise: number | null; receivedPaise: number | null;
}
interface MoneyData {
  cash: { receivedFromMillsPaise: number; paidToSuppliersPaise: number };
  stock: { valuePaise: number; leftGrams: number; unpricedGrams: number; unbilledGoodsPaise: number; draftTrucks: number };
  suppliers: { openingPaise: number; purchasesPaise: number; slips: number; paidPaise: number; payments: number; toPayPaise: number; paidAheadPaise: number;
    allTime: { openingPaise: number; purchasesPaise: number; paidPaise: number } };
  mills: { billedPaise: number; parchas: number; shortagePaise: number; receivedPaise: number; deductedPaise: number; receipts: number; toReceivePaise: number; paidAheadPaise: number;
    allTime: { openingPaise: number; billedPaise: number; shortagePaise: number; receivedPaise: number; deductedPaise: number } };
  billed: { goodsPaise: number; adatPaise: number; parts: { key: string; label: string; labelHi: string | null; amountPaise: number }[]; grandTotalPaise: number; otherPaise: number };
}
interface DashboardData {
  period: { from: string | null; to: string | null };
  kpis: {
    slips: number; boughtNetGrams: number; boughtAmountPaise: number; avgBuyPaisePerQtl: number; noMillGrams: number;
    loadedGrams: number; goodsPaise: number; billedPaise: number; trucks: number; drafts: number;
    leftGrams: number; paidPaise: number; avgSalePaisePerQtl: number;
    toReceivePaise: number | null; unbilledGoodsPaise: number;
  };
  mills: MillSummary[];
  flags: Flag[];
}
interface LedgerTop { rows: { id: string; nameHi: string; nameHinglish: string; slips: number; balancePaise: number }[]; totals: { toPayPaise: number; paidAheadPaise: number } }

type Period = "fy" | "all" | "today" | "week" | "month" | "custom";

function periodRange(p: Period, from: string, to: string, fy: { from: string; to: string }): { from?: string; to?: string } {
  const today = todayISO();
  // the year so far (a year already over: to its 31 March), as the ledger page counts it
  if (p === "fy") return { from: fy.from, to: notAfterToday(fy.to, today) };
  const d = new Date(today + "T00:00:00Z");
  if (p === "today") return { from: today, to: today };
  if (p === "week") { d.setUTCDate(d.getUTCDate() - 6); return { from: d.toISOString().slice(0, 10), to: today }; }
  if (p === "month") return { from: today.slice(0, 8) + "01", to: today };
  if (p === "custom") return { from: from || undefined, to: to || undefined };
  return {};
}

function Kpi({ icon: Icon, label, value, lines, tone, href }: {
  icon: typeof Truck; label: string; value: React.ReactNode; lines: React.ReactNode[]; tone?: "bad"; href?: string;
}) {
  const body = (
    <div className={cn("h-full rounded-xl border bg-surface p-4 shadow-card transition-colors hover:border-faint/60", tone === "bad" ? "border-bad/50" : "border-line")}>
      <div className="mb-1.5 flex items-center gap-2">
        <Icon className={cn("h-4 w-4", tone === "bad" ? "text-bad" : "text-brand")} />
        <p className="text-[12px] font-medium uppercase tracking-wide text-muted">{label}</p>
      </div>
      <p className={cn("num text-2xl font-semibold tracking-tight", tone === "bad" ? "text-bad" : "text-ink")}>{value}</p>
      <div className="mt-1 space-y-0.5 text-[12px] text-muted">{lines.map((l, i) => <p key={i}>{l}</p>)}</div>
    </div>
  );
  return href ? <Link href={href}>{body}</Link> : body;
}

/** One line of a flag, in words, with where to go to fix it. */
function useFlagText() {
  const { t } = useI18n();
  const { can } = useSession();
  const f = useFormat();
  const q = (g: unknown) => f.weight(Number(g ?? 0));
  return (code: string, x: FlagItem): { text: string; href?: string } => {
    switch (code) {
      case "loaded_more": return { text: t("flag.loaded_more.item", { mill: String(x.mill), jins: String(x.jins), out: q(x.outGrams), in: q(x.inGrams), over: q(x.overGrams) }), href: `/stock/${x.millId}` };
      case "ran_ahead": return { text: t("flag.ran_ahead.item", { mill: String(x.mill), jins: String(x.jins), d: dmy(String(x.date)), q: q(x.grams) }), href: `/stock/${x.millId}` };
      case "day_negative": return { text: t("flag.day_negative.item", { mill: String(x.mill), d: dmy(String(x.date)), taken: q(x.takenGrams), bought: q(x.boughtGrams), over: q(x.overGrams) }), href: `/stock/${x.millId}` };
      case "truck_mismatch": return { text: t("flag.truck_mismatch.item", { truck: String(x.truck ?? "—"), mill: String(x.mill), d: dmy(String(x.date)), rows: q(x.rowsGrams), net: q(x.netGrams) }), href: `/loads/${x.loadId}` };
      case "truck_incomplete": return { text: t("flag.truck_incomplete.item", { truck: String(x.truck ?? "—"), mill: String(x.mill), d: dmy(String(x.date)) }), href: `/loads/${x.loadId}` };
      case "truck_unbilled": return { text: t("flag.truck_unbilled.item", { truck: String(x.truck ?? "—"), mill: String(x.mill), d: dmy(String(x.date)), q: q(x.grams) }), href: `/loads/${x.loadId}` };
      case "rate_far": return { text: t("flag.rate_far.item", { truck: String(x.truck ?? "—"), d: dmy(String(x.date)), rate: f.rate(Number(x.rate)), avg: f.rate(Number(x.avg)) }), href: `/loads/${x.loadId}` };
      case "slips_no_rate": return { text: t("flag.slips_no_rate.item", { d: dmy(String(x.date)), n: Number(x.n), q: q(x.grams) }), href: `/daily?date=${x.date}` };
      case "slips_no_mill": return { text: t("flag.slips_no_mill.item", { d: dmy(String(x.date)), n: Number(x.n), q: q(x.grams) }), href: `/daily?date=${x.date}` };
      case "po_over": return { text: t("flag.po_over.item", { po: String(x.po), mill: String(x.mill), q: q(x.overGrams) }), href: "/orders" };
      case "paid_ahead": return { text: t("flag.paid_ahead.item", { name: String(x.nameHi), amt: f.money(Number(x.paise)) }), href: `/ledger?adati=${x.adatiId}` };
      case "parcha_stale": return { text: t("flag.parcha_stale.item", { no: String(x.parchaNo), mill: String(x.mill), truck: String(x.truck ?? "—"), d: dmy(String(x.date)), was: f.rate(Number(x.was)), now: f.rate(Number(x.now)) }), href: `/loads/${x.loadId}` };
      case "scan_failed": return { text: t("flag.scan_failed.item", { d: x.date ? dmy(String(x.date)) : "—" }), href: can("scan.review") ? `/scan/${x.scanId}` : undefined };
      default: return { text: code };
    }
  };
}

function FlagsCard({ flags }: { flags: Flag[] }) {
  const { t } = useI18n();
  const text = useFlagText();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const bad = flags.filter((x) => x.level === "bad").reduce((s, x) => s + x.items.length, 0);
  const warn = flags.filter((x) => x.level === "warn").reduce((s, x) => s + x.items.length, 0);
  const Icon = { bad: CircleAlert, warn: AlertTriangle, info: Info };
  return (
    <Card>
      <CardHeader title={t("dash.attention")} sub={t("dash.attentionSub")}
        action={<div className="flex gap-1.5">{bad > 0 && <Badge tone="bad">{bad}</Badge>}{warn > 0 && <Badge tone="warn">{warn}</Badge>}</div>} />
      {!flags.length ? (
        <p className="flex items-center gap-2 p-4 text-[14px] text-ok"><CheckCircle2 className="h-4 w-4" />{t("dash.allGood")}</p>
      ) : (
        <div className="divide-y divide-line">
          {flags.map((fl) => {
            const I = Icon[fl.level];
            const shown = open[fl.code] ? fl.items : fl.items.slice(0, 3);
            return (
              <div key={fl.code} className="px-4 py-3">
                <p className={cn("flex items-center gap-2 text-[13px] font-semibold",
                  fl.level === "bad" ? "text-bad" : fl.level === "warn" ? "text-warn" : "text-muted")}>
                  <I className="h-4 w-4 shrink-0" />{t(`flag.${fl.code}` as never)}
                  <Badge tone={fl.level === "bad" ? "bad" : fl.level === "warn" ? "warn" : "neutral"}>{fl.items.length}</Badge>
                </p>
                <ul className="mt-1.5 space-y-1 pl-6 text-[13px]">
                  {shown.map((it, i) => {
                    const x = text(fl.code, it);
                    return (
                      <li key={i}>
                        {x.href ? <Link href={x.href} className="group inline-flex items-start gap-1 text-ink hover:text-brand">
                          <span>{x.text}</span><ArrowRight className="mt-1 h-3 w-3 shrink-0 opacity-0 group-hover:opacity-100" /></Link> : x.text}
                      </li>
                    );
                  })}
                </ul>
                {fl.items.length > 3 && (
                  <button type="button" className="mt-1 pl-6 text-[12px] text-brand hover:underline"
                    onClick={() => setOpen((p) => ({ ...p, [fl.code]: !p[fl.code] }))}>
                    {open[fl.code] ? t("dash.showLess") : t("dash.showAll", { n: fl.items.length })}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

/**
 * Where the money stands, and where the billed money comes from. Balances
 * are as of the period's end, never after today ("who owes whom today": a
 * post-dated slip, payment or cheque does not count yet); flows (paid,
 * received, billed) follow the period chosen up to that day.
 */
function MoneyCard({ qs }: { qs: string }) {
  const { t, pick } = useI18n();
  const f = useFormat();
  const q = useQuery({ queryKey: ["dashboard", "money", qs], queryFn: () => api.get<MoneyData>(`/dashboard/money?${qs}`) });
  const m = q.data;
  if (q.isError) return <Card className="mt-5"><LoadError error={q.error} onRetry={() => void q.refetch()} /></Card>;
  if (!m) return <Card className="mt-5"><SkeletonTable rows={3} /></Card>;
  const { millsOwe: toReceive, weOwe: toPay, cash, net } = moneyTiles(m);
  const words = moneyWords(t, new URLSearchParams(qs).get("to") ?? todayISO(), todayISO());
  // goods in hand and unbilled trucks, valued on the server as of the period's end
  const stockPaise = m.stock.valuePaise;
  const unbilledPaise = m.stock.unbilledGoodsPaise;
  const grand = m.billed.grandTotalPaise;
  const parts = [
    { key: "goods", label: t("dash.goodsPart"), amountPaise: m.billed.goodsPaise, tone: "bg-brand" },
    ...m.billed.parts.map((p, i) => ({ key: p.key, label: pick(p.label, p.labelHi), amountPaise: p.amountPaise, tone: ["bg-ok", "bg-warn", "bg-sky-500", "bg-violet-500", "bg-rose-400", "bg-amber-600", "bg-teal-500", "bg-fuchsia-500"][i % 8] })),
    ...(m.billed.otherPaise ? [{ key: "other", label: t("dash.otherPart"), amountPaise: m.billed.otherPaise, tone: "bg-faint" }] : []),
  ];
  const tile = (label: string, value: number, sub: string, href?: string, tone?: string) => {
    const body = (
      <div className="h-full rounded-lg border border-line bg-surface px-3 py-2.5 transition-colors hover:border-faint/60">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted">{label}</p>
        <p className={cn("num text-xl font-semibold", tone)}>{f.money(value)}</p>
        <p className="text-[11px] text-faint">{sub}</p>
      </div>
    );
    return href ? <Link href={href}>{body}</Link> : body;
  };
  return (
    <Card className="mt-5">
      <CardHeader title={t("dash.money")} sub={words.sub} />
      <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-5">
        {/* each balance is up to the period's end, as Mill accounts and the ledger show it; its explanation
            (opening + bills − cuts − received − held back) adds up to it less the paid ahead its note names */}
        {tile(t("dash.millsOwe"), toReceive, t("dash.millsOweSub", { o: f.money(m.mills.allTime.openingPaise), b: f.money(m.mills.allTime.billedPaise), c: f.money(m.mills.allTime.shortagePaise), r: f.money(m.mills.allTime.receivedPaise), h: f.money(m.mills.allTime.deductedPaise), w: words.span })
          + (m.mills.paidAheadPaise ? ` · ${t("dash.millsAhead", { a: f.money(m.mills.paidAheadPaise) })}` : ""), "/mill-accounts", "text-brand")}
        {tile(t("dash.weOwe"), toPay, t("dash.weOweSub", { o: f.money(m.suppliers.allTime.openingPaise), p: f.money(m.suppliers.allTime.purchasesPaise), d: f.money(m.suppliers.allTime.paidPaise), w: words.span })
          + (m.suppliers.paidAheadPaise ? ` · ${t("dash.supAhead", { a: f.money(m.suppliers.paidAheadPaise) })}` : ""), "/ledger")}
        {tile(t("dash.stockValue"), stockPaise + unbilledPaise,
          (unbilledPaise ? t("dash.stockValueSub2", { u: f.money(unbilledPaise) }) : t("dash.stockValueSub"))
            + (m.stock.unpricedGrams > 0 ? ` · ${t("dash.unpricedStock", { q: f.weight(m.stock.unpricedGrams) })}` : ""), "/stock")}
        {tile(t("dash.cash"), cash, t("dash.cashSub", { r: f.money(m.cash.receivedFromMillsPaise), p: f.money(m.cash.paidToSuppliersPaise), w: words.span }), undefined, cash < 0 ? "text-warn" : undefined)}
        {tile(t("dash.net"), net, t("dash.netSub"), undefined, net < 0 ? "text-bad" : "text-ok")}
      </div>
      {grand > 0 && (
        <div className="border-t border-line p-4">
          <p className="mb-2 text-[13px] font-medium text-ink">{t("dash.billedMadeOf", { amt: f.money(grand), n: m.mills.parchas })}</p>
          <div className="flex h-3 overflow-hidden rounded-full bg-raised">
            {parts.filter((x) => x.amountPaise > 0).map((x) => (
              <div key={x.key} className={x.tone} style={{ width: `${(x.amountPaise / grand) * 100}%` }} title={`${x.label}: ${f.money(x.amountPaise)}`} />
            ))}
          </div>
          <div className="mt-2.5 grid gap-x-6 gap-y-1 text-[12px] sm:grid-cols-2 lg:grid-cols-3">
            {parts.map((x) => (
              <p key={x.key} className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-muted"><span className={cn("h-2 w-2 rounded-full", x.tone)} />{x.label}</span>
                <span className="num text-ink">{f.money(x.amountPaise)} <span className="text-faint">{grand ? `${((x.amountPaise / grand) * 100).toFixed(1)}%` : ""}</span></span>
              </p>
            ))}
          </div>
          {m.mills.shortagePaise > 0 && <p className="mt-2 text-[12px] text-warn">{t("dash.cutsNote", { amt: f.money(m.mills.shortagePaise) })}</p>}
        </div>
      )}
    </Card>
  );
}

function MillCard({ m }: { m: MillSummary }) {
  const { t, pick } = useI18n();
  const f = useFormat();
  return (
    <Card>
      <Link href={`/stock/${m.merchantId}`} className="flex items-center justify-between gap-2 border-b border-line px-4 py-3 hover:bg-raised/40">
        <span className="min-w-0">
          <span className="flex items-center gap-2">
            <Badge tone="brand" className="num">{m.code}</Badge>
            <span className="truncate text-[14px] font-semibold text-ink">{pick(m.name, m.nameHi)}</span>
          </span>
        </span>
        <span className="flex items-center gap-2">
          {m.leftGrams < 0 && <Badge tone="bad">{t("dash.loadedMore")}</Badge>}
          <ChevronRight className="h-4 w-4 text-faint" />
        </span>
      </Link>
      <div className="grid grid-cols-3 gap-px border-b border-line bg-line text-[12px]">
        <div className="bg-surface px-3 py-2">
          <p className="text-faint">{t("dash.received")}</p>
          <p className="num text-[15px] font-semibold text-ink">{f.weight(m.boughtNetGrams)}</p>
          <p className="text-muted">{m.slips} {t("ledger.slips")} · {t("load.avgShort", { r: m.avgBuyPaisePerQtl ? f.rate(m.avgBuyPaisePerQtl) : "—" })}</p>
        </div>
        <div className="bg-surface px-3 py-2">
          <p className="text-faint">{t("dash.loaded")}</p>
          <p className="num text-[15px] font-semibold text-ink">{f.weight(m.loadedGrams)}</p>
          <p className="text-muted">{m.trucks} {t("stock.trucks")}{m.drafts ? ` (${m.drafts} ${t("load.status.draft")})` : ""} · {t("load.avgShort", { r: m.avgSalePaisePerQtl ? f.rate(m.avgSalePaisePerQtl) : "—" })}</p>
        </div>
        <div className="bg-surface px-3 py-2">
          <p className="text-faint">{t("dash.left")}</p>
          <p className={cn("num text-[15px] font-semibold", m.leftGrams < 0 ? "text-bad" : "text-ink")}>{f.weight(m.leftGrams)}</p>
          <p className="text-muted">
            {m.openingGrams ? t("dash.openingQ", { q: f.weight(m.openingGrams) }) : m.billedPaise ? t("dash.billed", { amt: f.money(m.billedPaise) }) : " "}
          </p>
          {m.owedPaise != null && (m.owedPaise !== 0 || m.billedPaise > 0) && (
            <Link href={`/mill-accounts/${m.merchantId}`} className={cn("num block font-medium hover:underline", m.owedPaise < 0 ? "text-warn" : "text-brand")}>
              {t("dash.millOwes", { amt: f.money(m.owedPaise) })}
            </Link>
          )}
        </div>
      </div>
      <div className="px-2 pt-3 pb-2">
        <RaceChart points={m.series} height={190} />
      </div>
      {m.worstAhead && (
        <p className="border-t border-line px-4 py-2 text-[12px] text-bad">
          {t("dash.worstAhead", { d: dmy(m.worstAhead.date), q: f.weight(m.worstAhead.grams) })}
        </p>
      )}
    </Card>
  );
}

export function DashboardPage() {
  const { t, pick, lang } = useI18n();
  const f = useFormat();
  const { me, can } = useSession();
  const [period, setPeriod] = useState<Period>(() => {
    try { return (localStorage.getItem("mandi.dash.period") as Period) || "fy"; } catch { return "fy"; }
  });
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [jinsId, setJinsId] = useState("");
  useEffect(() => { try { localStorage.setItem("mandi.dash.period", period); } catch { /* ignore */ } }, [period]);

  const jins = useQuery({ queryKey: ["jins"], queryFn: () => api.get<Jins[]>("/jins"), enabled: can("jins.read") });
  const { fy } = useFY();
  const r = periodRange(period, from, to, fy);
  const qs = new URLSearchParams();
  if (r.from) qs.set("from", r.from);
  if (r.to) qs.set("to", r.to);
  if (jinsId) qs.set("jinsId", jinsId);
  // what each mill owes is as of today, whatever the period, like "to pay suppliers today"
  const dashQs = new URLSearchParams(qs);
  dashQs.set("asOf", todayISO());
  const dash = useQuery({ queryKey: ["dashboard", dashQs.toString()], queryFn: () => api.get<DashboardData>(`/dashboard?${dashQs}`) });
  // the money card: who owes whom as of the period's end, never after today
  const moneyQs = new URLSearchParams(qs);
  moneyQs.set("to", notAfterToday(r.to));
  if (r.from && r.from > moneyQs.get("to")!) moneyQs.set("from", moneyQs.get("to")!);
  // owed as of today, as the ledger page shows it: an entry dated ahead is not owed yet
  const ledger = useQuery({ queryKey: ["ledger", "asOf", todayISO()], queryFn: () => api.get<LedgerTop>(suppliersNow()), enabled: can("ledger.read") });
  const d = dash.data;
  const k = d?.kpis;
  const top = (ledger.data?.rows ?? []).filter((x) => x.balancePaise > 0).slice(0, 8);

  return (
    <>
      <PageHeader
        title={t("dash.title")}
        sub={me?.business ? pick(me.business.name, me.business.nameHi) : undefined}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Select value={period} onChange={(e) => setPeriod(e.target.value as Period)} className="h-8 w-36 text-[13px]">
              <option value="fy">{t("dash.p.fy", { y: fy.label })}</option>
              <option value="all">{t("dash.p.all")}</option>
              <option value="today">{t("dash.p.today")}</option>
              <option value="week">{t("dash.p.week")}</option>
              <option value="month">{t("dash.p.month")}</option>
              <option value="custom">{t("dash.p.custom")}</option>
            </Select>
            {period === "custom" && (
              <>
                <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8 w-36 text-[13px]" aria-label={t("common.from")} title={t("common.from")} />
                <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-8 w-36 text-[13px]" aria-label={t("common.to")} title={t("common.to")} />
              </>
            )}
            <Select value={jinsId} onChange={(e) => setJinsId(e.target.value)} className="h-8 w-40 text-[13px]">
              <option value="">{t("dash.allJins")}</option>
              {jins.data?.map((j) => <option key={j.id} value={j.id}>{j.code} — {pick(j.name, j.nameHi)}</option>)}
            </Select>
          </div>
        } />

      <AttentionStrip />
      <DayAveragesCard />
      <PortalRatesCard />
      {dash.isError ? <Card><LoadError error={dash.error} onRetry={() => void dash.refetch()} /></Card> : !k ? <SkeletonStats /> : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Kpi icon={PackageOpen} label={t("dash.received")} value={<>{f.weight(k.boughtNetGrams)} <span className="text-[13px] font-normal text-muted">{f.unit}</span></>}
            href="/daily"
            lines={[
              `${k.slips} ${t("ledger.slips")} · ${f.money(k.boughtAmountPaise)}`,
              t("dash.avgBuy", { r: k.avgBuyPaisePerQtl ? f.rate(k.avgBuyPaisePerQtl) : "—" }),
            ]} />
          <Kpi icon={Truck} label={t("dash.loaded")} value={<>{f.weight(k.loadedGrams)} <span className="text-[13px] font-normal text-muted">{f.unit}</span></>}
            href="/loads"
            lines={[
              `${k.trucks} ${t("stock.trucks")}${k.drafts ? ` · ${k.drafts} ${t("dash.withoutParcha")}` : ""}`,
              `${t("dash.avgSale", { r: k.avgSalePaisePerQtl ? f.rate(k.avgSalePaisePerQtl) : "—" })} · ${t("dash.billed", { amt: f.money(k.billedPaise) })}`,
            ]} />
          <Kpi icon={Warehouse} label={t("dash.left")} tone={k.leftGrams < 0 ? "bad" : undefined}
            value={<>{f.weight(k.leftGrams)} <span className="text-[13px] font-normal text-muted">{f.unit}</span></>}
            href="/stock"
            lines={[
              t("dash.leftHelp"),
              k.noMillGrams ? t("dash.noMillQ", { q: f.weight(k.noMillGrams) }) : " ",
            ]} />
          {can("ledger.read") ? (
            <Kpi icon={Wallet} label={t("dash.toPay")} value={f.money(ledger.data?.totals.toPayPaise ?? 0)} href="/ledger"
              lines={[
                t("dash.paidInPeriod", { amt: f.money(k.paidPaise) }),
                ledger.data?.totals.paidAheadPaise ? t("dash.paidAheadAmt", { amt: f.money(ledger.data.totals.paidAheadPaise) }) : " ",
              ]} />
          ) : <div />}
        </div>
      )}

      {can("ledger.read") && can("millledger.read") && k && <MoneyCard qs={moneyQs.toString()} />}

      <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        {d ? <FlagsCard flags={d.flags} /> : dash.isError ? null : <Card><SkeletonTable rows={4} /></Card>}
        {can("ledger.read") && (
          <Card className="self-start">
            <CardHeader title={t("dash.topToPay")} action={<Link href="/ledger"><Button size="sm" variant="ghost">{t("dash.seeAll")}</Button></Link>} />
            {!top.length ? <p className="p-4 text-[13px] text-muted">{t("dash.nothingToPay")}</p> : (
              <div className="divide-y divide-line">
                {top.map((s) => (
                  <Link key={s.id} href={`/ledger?adati=${s.id}`} className="flex items-center justify-between gap-2 px-4 py-2 hover:bg-raised/50">
                    <span className="min-w-0">
                      <span lang={lang === "hi" ? "hi" : undefined} className="block truncate text-[13px] text-ink">{lang === "hi" ? s.nameHi : s.nameHinglish || s.nameHi}</span>
                      <span className="text-[11px] text-faint">{s.slips} {t("ledger.slips")}</span>
                    </span>
                    <span className="num whitespace-nowrap text-[13px] font-medium">{f.money(s.balancePaise)}</span>
                  </Link>
                ))}
              </div>
            )}
          </Card>
        )}
      </div>

      <h2 className="mt-7 mb-3 text-[15px] font-semibold text-ink">{t("dash.perMill")}</h2>
      {!d ? (dash.isError ? null : <Card><SkeletonTable rows={6} /></Card>) : !d.mills.length ? (
        <Card><p className="p-6 text-center text-[13px] text-muted">{t("dash.noMills")}</p></Card>
      ) : (
        <div className="grid gap-5 xl:grid-cols-2">
          {d.mills.map((m) => <MillCard key={m.merchantId} m={m} />)}
        </div>
      )}
    </>
  );
}

export function AddBusinessDialogBody() { return null; }
