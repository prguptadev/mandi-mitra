import { Hono } from "hono";
import { and, eq, gte, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { can, bad, notFound, HttpError, type Env } from "../lib/http.ts";
import { incoming, trucks, race, worstAhead, dayAverages, type Filter, type TruckSummary } from "../lib/tracking.ts";
import { linesWithWeights } from "../lib/parcha.ts";
import { dispatchedByPo, poLabel } from "./orders.ts";
import { amountPaise, avgFromSums } from "../lib/money.ts";
import { millBalances } from "./millAccounts.ts";
import type { ParchaDoc } from "../lib/parcha.ts";

/* The owner's control panel: what came in, what went out, what is left per
   mill, how the two raced each other, and a list of everything that does not
   add up — each item linking to the screen where it can be fixed. */

export const dashboardRoutes = new Hono<Env>();

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function filterOf(c: { req: { query: (k: string) => string | undefined } }): Filter {
  const from = c.req.query("from") || undefined;
  const to = c.req.query("to") || undefined;
  if ((from && !ISO_DATE.test(from)) || (to && !ISO_DATE.test(to))) throw bad("Date must be YYYY-MM-DD");
  if (from && to && from > to) throw bad("The from date is after the to date", "bad_range");
  return { from, to, jinsId: c.req.query("jinsId") || null };
}

/** Weighted average over grouped rows whose Σ(net × rate) came back as text (kept exact in BigInt). */
const avgOver = (rows: { pricedValue: string | number | null; pricedNet: number }[]) => {
  const value = rows.reduce((s, r) => s + BigInt(String(r.pricedValue ?? 0).split(".")[0]), 0n);
  return avgFromSums(value.toString(), rows.reduce((s, r) => s + r.pricedNet, 0));
};

export type FlagItem = Record<string, string | number | null>;
export interface Flag { code: string; level: "bad" | "warn" | "info"; items: FlagItem[] }

/** Everything that does not add up, across all dates (money owed as of `asOf`, when given). */
async function flags(biz: string, jinsId: string | null, opts: { all: TruckSummary[]; canLedger: boolean; asOf?: string }): Promise<Flag[]> {
  const out: Flag[] = [];
  const mills = await db.select({ id: schema.merchants.id, code: schema.merchants.code }).from(schema.merchants)
    .where(eq(schema.merchants.businessId, biz));
  const code = (id: string | null) => mills.find((m) => m.id === id)?.code ?? "—";
  const jinsRows = await db.select({ id: schema.jins.id, code: schema.jins.code }).from(schema.jins).where(eq(schema.jins.businessId, biz));
  const jcode = (id: string) => jinsRows.find((j) => j.id === id)?.code ?? "";

  // per mill and commodity: received vs loaded, all time
  const S = schema.purchaseSlips;
  const sw = [eq(S.businessId, biz)];
  if (jinsId) sw.push(eq(S.jinsId, jinsId));
  const inDays = await db.select({
    merchantId: S.merchantId, jinsId: S.jinsId, date: S.slipDate, netGrams: sql<number>`sum(${S.netGrams})`,
  }).from(S).where(and(...sw)).groupBy(S.merchantId, S.jinsId, S.slipDate);
  const lw = [eq(schema.loadLines.businessId, biz)];
  if (jinsId) lw.push(eq(schema.loadLines.jinsId, jinsId));
  const rows = await linesWithWeights(and(...lw));

  const pairs = new Set([...inDays.filter((d) => d.merchantId).map((d) => `${d.merchantId}|${d.jinsId}`), ...rows.map((r) => `${r.merchantId}|${r.jinsId}`)]);
  const loadedMore: FlagItem[] = [];
  const ranAhead: FlagItem[] = [];
  const dayNeg: FlagItem[] = [];
  for (const pair of pairs) {
    const [mid, jid] = pair.split("|");
    const ins = inDays.filter((d) => d.merchantId === mid && d.jinsId === jid);
    const outs = rows.filter((r) => r.merchantId === mid && r.jinsId === jid);
    const pts = race(ins.map((d) => ({ date: d.date, netGrams: d.netGrams })), outs.map((r) => ({ loadDate: r.loadDate, weightGrams: r.weightGrams })));
    const last = pts[pts.length - 1];
    if (last && last.cumOut > last.cumIn) {
      loadedMore.push({ mill: code(mid), millId: mid, jins: jcode(jid), inGrams: last.cumIn, outGrams: last.cumOut, overGrams: last.cumOut - last.cumIn });
    } else {
      const w = worstAhead(pts);
      if (w) ranAhead.push({ mill: code(mid), millId: mid, jins: jcode(jid), date: w.date, grams: w.grams });
    }
    // a purchase day that trucks took more from than was bought
    const taken = new Map<string, number>();
    for (const r of outs) taken.set(r.stockDate, (taken.get(r.stockDate) ?? 0) + r.weightGrams);
    for (const [date, g] of taken) {
      const bought = ins.find((d) => d.date === date)?.netGrams ?? 0;
      if (g > bought) dayNeg.push({ mill: code(mid), millId: mid, jins: jcode(jid), date, boughtGrams: bought, takenGrams: g, overGrams: g - bought });
    }
  }
  out.push({ code: "loaded_more", level: "bad", items: loadedMore });
  out.push({ code: "ran_ahead", level: "warn", items: ranAhead });
  out.push({ code: "day_negative", level: "warn", items: dayNeg.sort((a, b) => String(b.date).localeCompare(String(a.date))) });

  // trucks
  const all = opts.all;
  out.push({ code: "truck_mismatch", level: "bad", items: all.filter((x) => x.mismatch).map((x) => ({
    loadId: x.loadId, truck: x.truckNo, mill: code(x.merchantId), date: x.loadDate,
    rowsGrams: x.rows.reduce((s, r) => s + r.weightGrams, 0), netGrams: x.millNetGrams })) });
  out.push({ code: "truck_incomplete", level: "warn", items: all.filter((x) => x.incomplete).map((x) => ({
    loadId: x.loadId, truck: x.truckNo, mill: code(x.merchantId), date: x.loadDate })) });
  out.push({ code: "truck_unbilled", level: "info", items: all.filter((x) => x.status !== "billed" && !x.incomplete && !x.mismatch).map((x) => ({
    loadId: x.loadId, truck: x.truckNo, mill: code(x.merchantId), date: x.loadDate, grams: x.weightGrams })) });
  const far: FlagItem[] = [];
  for (const x of all) for (const r of x.rows) {
    if (r.typed && r.dayAvgPaisePerQtl && Math.abs(r.ratePaisePerQtl - r.dayAvgPaisePerQtl) / r.dayAvgPaisePerQtl > 0.02) {
      far.push({ loadId: x.loadId, truck: x.truckNo, mill: code(x.merchantId), date: r.stockDate, rate: r.ratePaisePerQtl, avg: r.dayAvgPaisePerQtl });
    }
  }
  out.push({ code: "rate_far", level: "info", items: far });

  // slips
  const noRate = await db.select({ date: S.slipDate, n: sql<number>`count(*)`, grams: sql<number>`sum(${S.netGrams})` })
    .from(S).where(and(...sw, eq(S.ratePaisePerQtl, 0))).groupBy(S.slipDate);
  out.push({ code: "slips_no_rate", level: "warn", items: noRate.sort((a, b) => b.date.localeCompare(a.date)).map((r) => ({ date: r.date, n: r.n, grams: r.grams })) });
  const noMill = await db.select({ date: S.slipDate, n: sql<number>`count(*)`, grams: sql<number>`sum(${S.netGrams})` })
    .from(S).where(and(...sw, sql`${S.merchantId} is null`)).groupBy(S.slipDate);
  out.push({ code: "slips_no_mill", level: "warn", items: noMill.sort((a, b) => b.date.localeCompare(a.date)).map((r) => ({ date: r.date, n: r.n, grams: r.grams })) });

  // POs sent over
  const pos = await db.select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.businessId, biz));
  const sent = await dispatchedByPo(pos.map((p) => p.id));
  out.push({ code: "po_over", level: "warn", items: pos.filter((p) => (sent.get(p.id)?.grams ?? 0) > p.qtyGrams).map((p) => ({
    po: poLabel(p), mill: code(p.merchantId), overGrams: (sent.get(p.id)?.grams ?? 0) - p.qtyGrams })) });

  /* suppliers paid more than they are owed — only for those allowed to see the
     ledger. As of `asOf` (the screen asks for today), like the ledger it links
     to: a post-dated payment has not paid anyone ahead yet. */
  if (opts.canLedger) {
  const suppliers = await db.select({ id: schema.adati.id, nameHi: schema.adati.nameHi, nameHinglish: schema.adati.nameHinglish, opening: schema.adati.openingBalancePaise })
    .from(schema.adati).where(eq(schema.adati.businessId, biz));
  const bought = await db.select({ adatiId: S.adatiId, p: sql<number>`sum(${S.payablePaise})` }).from(S)
    .where(and(eq(S.businessId, biz), ...(opts.asOf ? [lte(S.slipDate, opts.asOf)] : []))).groupBy(S.adatiId);
  const paid = await db.select({ adatiId: schema.payments.adatiId, p: sql<number>`sum(${schema.payments.amountPaise})` })
    .from(schema.payments).where(and(eq(schema.payments.businessId, biz), isNull(schema.payments.voidedAt),
      ...(opts.asOf ? [lte(schema.payments.payDate, opts.asOf)] : []))).groupBy(schema.payments.adatiId);
  const ahead = suppliers.map((s) => ({ s, bal: s.opening + (bought.find((b) => b.adatiId === s.id)?.p ?? 0) - (paid.find((p) => p.adatiId === s.id)?.p ?? 0) }))
    .filter((x) => x.bal < 0);
  out.push({ code: "paid_ahead", level: "warn", items: ahead.map((x) => ({ adatiId: x.s.id, nameHi: x.s.nameHi, name: x.s.nameHinglish, paise: -x.bal })) });
  }

  /* approved parchas whose purchase days' average has moved since: a slip
     on one of those days was priced or changed after the parcha was frozen */
  {
    const P = schema.parchas;
    const L2 = schema.loads;
    const approved = await db.select({ loadId: P.loadId, parchaNo: P.parchaNo, snapshot: P.snapshot, merchantId: L2.merchantId, jinsId: L2.jinsId, truckNo: L2.truckNo })
      .from(P).innerJoin(L2, eq(L2.id, P.loadId))
      .where(and(eq(P.businessId, biz), eq(P.status, "approved"), ...(jinsId ? [eq(L2.jinsId, jinsId)] : [])));
    if (approved.length) {
      const typed = await db.select({ loadId: schema.loadLines.loadId, date: schema.loadLines.stockDate, rate: schema.loadLines.ratePaisePerQtl })
        .from(schema.loadLines).where(inArray(schema.loadLines.loadId, approved.map((a) => a.loadId)));
      const avg = await dayAverages(biz);
      const stale: FlagItem[] = [];
      for (const a of approved) {
        const doc = JSON.parse(a.snapshot) as ParchaDoc;
        let moved: { date: string; was: number } | undefined;
        if (doc.stock?.length) {
          // each day whose average the parcha used (some row on it took the average), as it stood then
          const used = doc.stock.filter((st) => doc.lines.some((l) => l.date === st.date && l.ratePaisePerQtl === st.avgRatePaisePerQtl));
          const d = used.find((st) => avg(a.merchantId, a.jinsId, st.date) !== st.avgRatePaisePerQtl);
          if (d) moved = { date: d.date, was: d.avgRatePaisePerQtl };
        } else {
          // older parchas: a row is typed only if a typed row on that day carries exactly its rate
          const l = doc.lines.find((x) => !typed.some((tl) => tl.loadId === a.loadId && tl.date === x.date && tl.rate === x.ratePaisePerQtl)
            && avg(a.merchantId, a.jinsId, x.date) !== x.ratePaisePerQtl);
          if (l) moved = { date: l.date, was: l.ratePaisePerQtl };
        }
        if (moved) stale.push({ loadId: a.loadId, parchaNo: a.parchaNo, truck: a.truckNo, mill: code(a.merchantId), date: moved.date, was: moved.was, now: avg(a.merchantId, a.jinsId, moved.date) });
      }
      out.push({ code: "parcha_stale", level: "warn", items: stale });
    }
  }

  // reads that failed or never finished
  const scans = await db.select({ id: schema.scanBatches.id, date: schema.scanBatches.slipDate, status: schema.scanBatches.status, error: schema.scanBatches.errorText })
    .from(schema.scanBatches).where(and(eq(schema.scanBatches.businessId, biz), inArray(schema.scanBatches.status, ["failed"])));
  out.push({ code: "scan_failed", level: "warn", items: scans.map((s) => ({ scanId: s.id, date: s.date, error: (s.error ?? "").slice(0, 120) })) });

  return out.filter((f) => f.items.length);
}

dashboardRoutes.get("/", can("dashboard.view"), async (c) => {
  const auth = c.get("auth")!;
  const biz = auth.businessId!;
  const f = filterOf(c);
  const mills = await db.select({ id: schema.merchants.id, code: schema.merchants.code, name: schema.merchants.name, nameHi: schema.merchants.nameHi, active: schema.merchants.active })
    .from(schema.merchants).where(eq(schema.merchants.businessId, biz));

  // everything once, then split by date in memory
  const allIn = await incoming(biz, { jinsId: f.jinsId });
  const allOut = await trucks(biz, { jinsId: f.jinsId });
  const inRange = (d: string) => (!f.from || d >= f.from) && (!f.to || d <= f.to);
  const inRows = allIn.filter((r) => inRange(r.date));
  const outRows = allOut.filter((r) => inRange(r.loadDate));
  const beforeIn = f.from ? allIn.filter((r) => r.date < f.from!) : [];
  const beforeOut = f.from ? allOut.filter((r) => r.loadDate < f.from!) : [];
  const group = <T,>(rows: T[], key: (r: T) => string | null) => {
    const m = new Map<string, T[]>();
    for (const r of rows) { const k = key(r) ?? "-"; m.set(k, [...(m.get(k) ?? []), r]); }
    return m;
  };
  const inBy = group(inRows, (r) => r.merchantId);
  const outBy = group(outRows, (r) => r.merchantId);
  const bInBy = group(beforeIn, (r) => r.merchantId);
  const bOutBy = group(beforeOut, (r) => r.merchantId);

  const perMill = mills.map((m) => {
    const ins = inBy.get(m.id) ?? [];
    const outs = outBy.get(m.id) ?? [];
    const opening = {
      in: (bInBy.get(m.id) ?? []).reduce((s, r) => s + r.netGrams, 0),
      out: (bOutBy.get(m.id) ?? []).reduce((s, r) => s + r.weightGrams, 0),
    };
    const series = race(ins.map((r) => ({ date: r.date, netGrams: r.netGrams })), outs, opening);
    const boughtNet = ins.reduce((s, r) => s + r.netGrams, 0);
    const loaded = outs.reduce((s, r) => s + r.weightGrams, 0);
    const goods = outs.reduce((s, r) => s + r.goodsPaise, 0);
    return {
      merchantId: m.id, code: m.code, name: m.name, nameHi: m.nameHi,
      slips: ins.reduce((s, r) => s + r.slips, 0),
      boughtNetGrams: boughtNet,
      boughtAmountPaise: ins.reduce((s, r) => s + r.amountPaise, 0),
      avgBuyPaisePerQtl: avgOver(ins),
      loadedGrams: loaded,
      goodsPaise: goods,
      avgSalePaisePerQtl: loaded ? Math.floor((goods * 100_000) / loaded + 0.5) : 0,
      billedPaise: outs.reduce((s, r) => s + (r.grandTotalPaise ?? 0), 0),
      trucks: outs.length,
      drafts: outs.filter((r) => r.status !== "billed").length,
      openingGrams: opening.in - opening.out,
      leftGrams: opening.in - opening.out + boughtNet - loaded,
      series,
      worstAhead: worstAhead(series),
    };
  }).filter((m) => m.slips || m.trucks || m.openingGrams);

  const noMill = inRows.filter((r) => !r.merchantId);
  /* what each mill still owes us, whatever the period: as of ?asOf= (the
     screen asks for today, so a post-dated cheque is not received yet), else
     every date — money is shown only to those who may see it */
  const asOf = c.req.query("asOf") || undefined;
  if (asOf && !ISO_DATE.test(asOf)) throw bad("Date must be YYYY-MM-DD");
  const canMoney = auth.permissions.has("millledger.read");
  const owed = canMoney ? await millBalances(biz, asOf) : null;
  const payments = await db.select({ p: sql<number>`coalesce(sum(${schema.payments.amountPaise}), 0)` }).from(schema.payments)
    .where(and(eq(schema.payments.businessId, biz), isNull(schema.payments.voidedAt), ...(f.from ? [gte(schema.payments.payDate, f.from)] : []), ...(f.to ? [lte(schema.payments.payDate, f.to)] : [])));

  const kpis = {
    slips: inRows.reduce((s, r) => s + r.slips, 0),
    boughtNetGrams: inRows.reduce((s, r) => s + r.netGrams, 0),
    boughtAmountPaise: inRows.reduce((s, r) => s + r.amountPaise, 0),
    avgBuyPaisePerQtl: avgOver(inRows),
    noMillGrams: noMill.reduce((s, r) => s + r.netGrams, 0),
    loadedGrams: perMill.reduce((s, m) => s + m.loadedGrams, 0),
    goodsPaise: perMill.reduce((s, m) => s + m.goodsPaise, 0),
    billedPaise: perMill.reduce((s, m) => s + m.billedPaise, 0),
    trucks: outRows.length,
    drafts: outRows.filter((r) => r.status !== "billed").length,
    leftGrams: perMill.reduce((s, m) => s + m.leftGrams, 0),
    // payments are shown only to those who may see them
    paidPaise: auth.permissions.has("payment.read") || auth.permissions.has("ledger.read") ? (payments[0]?.p ?? 0) : null,
    toReceivePaise: owed ? owed.totals.toReceivePaise : null,
    /** Goods on trucks whose parcha is not approved yet: not billed, so not owed yet. */
    unbilledGoodsPaise: outRows.filter((r) => r.status !== "billed").reduce((s, r) => s + r.goodsPaise, 0),
  };
  const avgSale = kpis.loadedGrams ? Math.floor((kpis.goodsPaise * 100_000) / kpis.loadedGrams + 0.5) : 0;

  const owedBy = new Map((owed?.rows ?? []).map((r) => [r.id, r]));
  const millsOut = perMill.map((m) => ({
    ...m,
    // as of ?asOf= (else all time), whatever the period: a mill's balance does not reset with the filter
    owedPaise: owed ? owedBy.get(m.merchantId)?.balancePaise ?? 0 : null,
    receivedPaise: owed ? owedBy.get(m.merchantId)?.receivedPaise ?? 0 : null,
  }));
  // what was billed on parchas is for those who may read parchas
  const bills = auth.permissions.has("parcha.read");
  return c.json({
    period: { from: f.from ?? null, to: f.to ?? null },
    kpis: { ...kpis, avgSalePaisePerQtl: avgSale, billedPaise: bills ? kpis.billedPaise : null },
    mills: millsOut.map((m) => (bills ? m : { ...m, billedPaise: null })),
    flags: await flags(biz, f.jinsId ?? null, { all: allOut, canLedger: auth.permissions.has("ledger.read"), asOf }),
  });
});

/** One mill: received, loaded (every truck, priced), left, and the race between them. */
/* The day's rate, mill by mill and commodity by commodity — the figure the
   office calls the dara. Σ(net × rate) / Σ net over the slips that carry a
   rate, so it is the same number the parcha and the mill report print. A mill
   that took two commodities that day gets a line for each. A line whose slips
   have no rate yet has no average to show, so it is left out and counted.
   Net on a line is the priced net — the weight the average is taken over — so
   net × average is the amount beside it; weight still without a rate is
   given on its own. */
dashboardRoutes.get("/day-averages", can("dashboard.view"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const f = filterOf(c);
  const days = Math.min(Math.max(Number(c.req.query("days") ?? 7) || 7, 1), 60);
  const S = schema.purchaseSlips;
  const w = [eq(S.businessId, biz)];
  if (f.jinsId) w.push(eq(S.jinsId, f.jinsId));
  if (f.from) w.push(gte(S.slipDate, f.from));
  if (f.to) w.push(lte(S.slipDate, f.to));
  /* "Added mills only" leaves out what the firm bought for itself — the slips
     with no mill on them — so the day's average is the mills' average alone. */
  if (c.req.query("mills") === "added") w.push(isNotNull(S.merchantId));
  const rows = await db.select({
    date: S.slipDate, merchantId: S.merchantId, jinsId: S.jinsId,
    slips: sql<number>`count(*)`,
    bags: sql<number>`sum(coalesce(${S.bagsCount}, 0))`,
    grossGrams: sql<number>`sum(${S.grossGrams})`,
    netGrams: sql<number>`sum(${S.netGrams})`,
    amountPaise: sql<number>`sum(${S.amountPaise})`,
    payablePaise: sql<number>`sum(${S.payablePaise})`,
    pricedSlips: sql<number>`sum(case when ${S.ratePaisePerQtl} > 0 then 1 else 0 end)`,
    pricedNet: sql<number>`sum(case when ${S.ratePaisePerQtl} > 0 then ${S.netGrams} else 0 end)`,
    pricedValue: sql<string>`cast(sum(case when ${S.ratePaisePerQtl} > 0 then ${S.netGrams} * ${S.ratePaisePerQtl} else 0 end) as text)`,
  }).from(S).where(and(...w)).groupBy(S.slipDate, S.merchantId, S.jinsId);
  if (!rows.length) return c.json({ days: [] });

  const mills = await db.select({ id: schema.merchants.id, code: schema.merchants.code, name: schema.merchants.name, nameHi: schema.merchants.nameHi })
    .from(schema.merchants).where(eq(schema.merchants.businessId, biz));
  const jinsRows = await db.select({ id: schema.jins.id, code: schema.jins.code, name: schema.jins.name, nameHi: schema.jins.nameHi })
    .from(schema.jins).where(eq(schema.jins.businessId, biz));
  const mill = (id: string | null) => mills.find((m) => m.id === id) ?? null;
  const jins = (id: string) => jinsRows.find((j) => j.id === id) ?? null;

  const dates = [...new Set(rows.map((r) => r.date))].sort((a, b) => b.localeCompare(a)).slice(0, days);
  const out = dates.map((date) => {
    const mine = rows.filter((r) => r.date === date);
    const lines = mine
      .filter((r) => r.pricedNet > 0)
      .map((r) => ({
        millId: r.merchantId, millCode: mill(r.merchantId)?.code ?? null,
        millName: mill(r.merchantId)?.name ?? null, millNameHi: mill(r.merchantId)?.nameHi ?? null,
        jinsId: r.jinsId, jinsCode: jins(r.jinsId)?.code ?? "", jinsName: jins(r.jinsId)?.name ?? "", jinsNameHi: jins(r.jinsId)?.nameHi ?? null,
        slips: r.slips, bags: r.bags, grossGrams: r.grossGrams, netGrams: r.pricedNet,
        amountPaise: r.amountPaise, payablePaise: r.payablePaise,
        avgRatePaisePerQtl: avgOver([r]),
        waiting: r.slips - r.pricedSlips,
        /** Net of this line's slips still without a rate: not in the net, the average or the amount. */
        unpricedNetGrams: r.netGrams - r.pricedNet,
      }))
      .sort((a, b) => (a.millCode ?? "~").localeCompare(b.millCode ?? "~") || a.jinsCode.localeCompare(b.jinsCode));
    const priced = mine.filter((r) => r.pricedNet > 0);
    return {
      date,
      lines,
      // the whole day across mills, for the line under the table
      total: priced.length ? {
        slips: priced.reduce((s, r) => s + r.pricedSlips, 0),
        bags: priced.reduce((s, r) => s + r.bags, 0),
        grossGrams: priced.reduce((s, r) => s + r.grossGrams, 0),
        netGrams: priced.reduce((s, r) => s + r.pricedNet, 0),
        amountPaise: priced.reduce((s, r) => s + r.amountPaise, 0),
        payablePaise: priced.reduce((s, r) => s + r.payablePaise, 0),
        avgRatePaisePerQtl: avgOver(priced),
      } : null,
      /** Slips of that day still without a rate: no average can be worked out for them. */
      waiting: mine.reduce((s, r) => s + (r.slips - r.pricedSlips), 0),
      /** …and their net, every mill: the day's net is the total's net plus this. */
      unpricedNetGrams: mine.reduce((s, r) => s + (r.netGrams - r.pricedNet), 0),
    };
  }).filter((d) => d.lines.length > 0 || d.waiting > 0);
  return c.json({ days: out });
});

dashboardRoutes.get("/mill/:id", can("stock.read"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const id = c.req.param("id") ?? "";
  const f = { ...filterOf(c), merchantId: id };
  const bills = c.get("auth")!.permissions.has("parcha.read");
  const [m] = await db.select().from(schema.merchants).where(and(eq(schema.merchants.id, id), eq(schema.merchants.businessId, biz))).limit(1);
  if (!m) throw notFound("Mill not found");
  const ins = await incoming(biz, f);
  const outs = await trucks(biz, f);
  const beforeIn = f.from ? await incoming(biz, { ...f, from: undefined, to: undefined, before: f.from }) : [];
  const beforeOut = f.from ? await trucks(biz, { ...f, from: undefined, to: undefined, before: f.from }) : [];
  const opening = { in: beforeIn.reduce((s, r) => s + r.netGrams, 0), out: beforeOut.reduce((s, r) => s + r.weightGrams, 0) };
  const series = race(ins.map((r) => ({ date: r.date, netGrams: r.netGrams })), outs, opening);
  const boughtNet = ins.reduce((s, r) => s + r.netGrams, 0);
  const loaded = outs.reduce((s, r) => s + r.weightGrams, 0);
  const goods = outs.reduce((s, r) => s + r.goodsPaise, 0);
  return c.json({
    mill: { id: m.id, code: m.code, name: m.name, nameHi: m.nameHi, city: m.city },
    summary: {
      openingGrams: opening.in - opening.out,
      slips: ins.reduce((s, r) => s + r.slips, 0),
      boughtNetGrams: boughtNet,
      boughtGrossGrams: ins.reduce((s, r) => s + r.grossGrams, 0),
      boughtAmountPaise: ins.reduce((s, r) => s + r.amountPaise, 0),
      avgBuyPaisePerQtl: avgOver(ins),
      unpriced: ins.reduce((s, r) => s + r.unpriced, 0),
      loadedGrams: loaded,
      goodsPaise: goods,
      avgSalePaisePerQtl: loaded ? Math.floor((goods * 100_000) / loaded + 0.5) : 0,
      billedPaise: bills ? outs.reduce((s, r) => s + (r.grandTotalPaise ?? 0), 0) : null,
      trucks: outs.length,
      drafts: outs.filter((r) => r.status !== "billed").length,
      leftGrams: opening.in - opening.out + boughtNet - loaded,
    },
    series,
    worstAhead: worstAhead(series),
    trucks: outs.sort((a, b) => b.loadDate.localeCompare(a.loadDate)).map((t) => (bills ? t : { ...t, grandTotalPaise: null })),
    incoming: ins.map((r) => ({ date: r.date, slips: r.slips, netGrams: r.netGrams, grossGrams: r.grossGrams, amountPaise: r.amountPaise,
      avgPaisePerQtl: avgFromSums(r.pricedValue, r.pricedNet), unpriced: r.unpriced })).sort((a, b) => b.date.localeCompare(a.date)),
  });
});

/**
 * The whole money picture: what suppliers are owed, what mills owe, and where
 * the money on the approved parchas goes (goods, adat and each charge).
 * Balances are as of `to` (every date when none is given; the money card
 * asks for today at the latest); flows are within the period.
 */
dashboardRoutes.get("/money", can("ledger.read"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  // it shows both sides: what suppliers are owed and what mills owe
  if (!c.get("auth")!.permissions.has("millledger.read")) throw new HttpError(403, "You do not have permission: millledger.read", "forbidden");
  const f = filterOf(c);
  const S = schema.purchaseSlips;
  const P = schema.payments;

  // suppliers, as of `to`
  const sup = await db.select({ opening: sql<number>`coalesce(sum(${schema.adati.openingBalancePaise}), 0)` })
    .from(schema.adati).where(eq(schema.adati.businessId, biz));
  const bought = await db.select({ adatiId: S.adatiId, p: sql<number>`sum(${S.payablePaise})` }).from(S)
    .where(and(eq(S.businessId, biz), ...(f.to ? [lte(S.slipDate, f.to)] : []))).groupBy(S.adatiId);
  const paidBy = await db.select({ adatiId: P.adatiId, p: sql<number>`sum(${P.amountPaise})` }).from(P)
    .where(and(eq(P.businessId, biz), isNull(P.voidedAt), ...(f.to ? [lte(P.payDate, f.to)] : []))).groupBy(P.adatiId);
  const openings = await db.select({ id: schema.adati.id, o: schema.adati.openingBalancePaise }).from(schema.adati).where(eq(schema.adati.businessId, biz));
  const bal = openings.map((a) => a.o + (bought.find((b) => b.adatiId === a.id)?.p ?? 0) - (paidBy.find((p) => p.adatiId === a.id)?.p ?? 0));

  // flows in the period
  const inPeriod = <T,>(col: T) => [...(f.from ? [gte(col as never, f.from)] : []), ...(f.to ? [lte(col as never, f.to)] : [])];
  const [purchases] = await db.select({ p: sql<number>`coalesce(sum(${S.payablePaise}), 0)`, n: sql<number>`count(*)` })
    .from(S).where(and(eq(S.businessId, biz), ...inPeriod(S.slipDate)));
  const [paid] = await db.select({ p: sql<number>`coalesce(sum(${P.amountPaise}), 0)`, n: sql<number>`count(*)` })
    .from(P).where(and(eq(P.businessId, biz), isNull(P.voidedAt), ...inPeriod(P.payDate)));

  // mills
  const mills = await millBalances(biz, f.to);
  const { billed, receipts } = await import("./millAccounts.ts");
  const bills = await billed(biz, { from: f.from, to: f.to });
  const recs = await receipts(biz, { from: f.from, to: f.to });

  // what the approved parchas are made of, line by line, from their frozen copies
  const docs = bills.length
    ? await db.select({ snapshot: schema.parchas.snapshot }).from(schema.parchas).where(inArray(schema.parchas.id, bills.map((b) => b.id)))
    : [];
  const parts = new Map<string, { key: string; label: string; labelHi: string | null; amountPaise: number; sign: string }>();
  let goods = 0, grand = 0;
  for (const d of docs) {
    const doc = JSON.parse(d.snapshot) as ParchaDoc;
    grand += doc.result.grandTotalPaise;
    for (const l of doc.result.lines) {
      if (l.kind === "goods") { goods += l.amountPaise; continue; }
      if (l.kind !== "charge" && l.kind !== "adjust") continue;
      const signed = l.sign === "subtract" ? -l.amountPaise : l.amountPaise;
      const p = parts.get(l.key) ?? { key: l.key, label: l.label, labelHi: l.labelHi ?? null, amountPaise: 0, sign: "add" };
      p.amountPaise += signed;
      parts.set(l.key, p);
    }
  }
  // adat is one of the charge lines; it is the arhat's own share, so it is also named on its own
  const adat = parts.get("adat")?.amountPaise ?? 0;
  const listed = goods + [...parts.values()].reduce((s, p) => s + p.amountPaise, 0);

  /* Goods in hand as of `to` (whatever the period and commodity): every
     purchase day's net that no truck has taken yet, valued at that day's own
     average rate — slips with no mill included. Trucks loaded but not yet
     billed (drafts, of any date up to `to`) are counted at their goods value. */
  const upTo = f.to ? [lte(S.slipDate, f.to)] : [];
  const days = await db.select({
    m: S.merchantId, j: S.jinsId, d: S.slipDate, net: sql<number>`sum(${S.netGrams})`,
    pricedNet: sql<number>`sum(case when ${S.ratePaisePerQtl} > 0 then ${S.netGrams} else 0 end)`,
    pricedValue: sql<string>`cast(sum(case when ${S.ratePaisePerQtl} > 0 then ${S.netGrams} * ${S.ratePaisePerQtl} else 0 end) as text)`,
  }).from(S).where(and(eq(S.businessId, biz), ...upTo)).groupBy(S.merchantId, S.jinsId, S.slipDate);
  /* Trucks billed as of `to` (their parcha's date). A parcha can be dated
     before its truck was loaded; from that date the mill owes it, so its
     goods are off stock from then too — never in hand and owed at once. */
  const billedBy = f.to ? new Set((await billed(biz, { upTo: f.to })).map((b) => b.loadId)) : null;
  const loadedLines = (await linesWithWeights(eq(schema.loads.businessId, biz)))
    .filter((l) => !f.to || l.loadDate <= f.to || billedBy!.has(l.loadId));
  const dayKey = (m: string | null, j: string, d: string) => `${m ?? "-"}|${j}|${d}`;
  const loaded = new Map<string, number>();
  for (const l of loadedLines) loaded.set(dayKey(l.merchantId, l.jinsId, l.stockDate), (loaded.get(dayKey(l.merchantId, l.jinsId, l.stockDate)) ?? 0) + l.weightGrams);
  let stockValue = 0, stockLeft = 0, unpricedLeft = 0;
  for (const x of days) {
    const left = x.net - (loaded.get(dayKey(x.m, x.j, x.d)) ?? 0);
    if (left === 0) continue;
    stockLeft += left;
    if (!x.pricedNet) { unpricedLeft += left; continue; }
    stockValue += amountPaise(left, avgFromSums(x.pricedValue, x.pricedNet));
  }
  /* A truck row taken from a day with no purchases (loaded before its slips
     were entered, or while they sit under no mill) is stock gone out that was
     never counted in: take it off too — at the row's own typed rate, else as
     unpriced — or the same goods would count again among the unbilled trucks. */
  const boughtDays = new Set(days.map((x) => dayKey(x.m, x.j, x.d)));
  for (const l of loadedLines) {
    if (boughtDays.has(dayKey(l.merchantId, l.jinsId, l.stockDate)) || !l.weightGrams) continue;
    stockLeft -= l.weightGrams;
    if (l.ratePaisePerQtl) stockValue -= amountPaise(l.weightGrams, l.ratePaisePerQtl);
    else unpricedLeft -= l.weightGrams;
  }
  /* Not billed as of `to`: a draft, or a truck whose parcha is dated after
     `to` — loaded, off stock, and not yet in what the mill owes, so it counts
     here at its frozen parcha goods. */
  const drafts = (await trucks(biz, { to: f.to })).filter((t) => t.status !== "billed" || (billedBy != null && !billedBy.has(t.loadId)));

  // what the supplier ledger is made of, all time up to `to` (the "we owe" figure is all time)
  const [boughtAll] = await db.select({ p: sql<number>`coalesce(sum(${S.payablePaise}), 0)` }).from(S)
    .where(and(eq(S.businessId, biz), ...upTo));
  const [openingAll] = await db.select({ p: sql<number>`coalesce(sum(${schema.adati.openingBalancePaise}), 0)` }).from(schema.adati)
    .where(eq(schema.adati.businessId, biz));
  // cash that has actually moved, all time up to `to`: in from mills, out to suppliers
  const [paidAll] = await db.select({ p: sql<number>`coalesce(sum(${P.amountPaise}), 0)` }).from(P)
    .where(and(eq(P.businessId, biz), isNull(P.voidedAt), ...(f.to ? [lte(P.payDate, f.to)] : [])));
  const recAll = await receipts(biz, { upTo: f.to });

  return c.json({
    period: { from: f.from ?? null, to: f.to ?? null },
    cash: { receivedFromMillsPaise: recAll.reduce((s, r) => s + r.amountPaise, 0), paidToSuppliersPaise: paidAll.p },
    stock: {
      valuePaise: stockValue, leftGrams: stockLeft, unpricedGrams: unpricedLeft,
      unbilledGoodsPaise: drafts.reduce((s, t) => s + t.goodsPaise, 0), draftTrucks: drafts.length,
    },
    suppliers: {
      openingPaise: sup[0]?.opening ?? 0,
      purchasesPaise: purchases.p, slips: purchases.n,
      paidPaise: paid.p, payments: paid.n,
      toPayPaise: bal.filter((b) => b > 0).reduce((s, b) => s + b, 0),
      paidAheadPaise: bal.filter((b) => b < 0).reduce((s, b) => s - b, 0),
      /** All time up to the period's end: opening + purchases − paid = the balance the tile shows. */
      allTime: { openingPaise: openingAll.p, purchasesPaise: boughtAll.p, paidPaise: paidAll.p },
    },
    mills: {
      billedPaise: bills.reduce((s, b) => s + b.grandTotalPaise, 0), parchas: bills.length,
      shortagePaise: bills.reduce((s, b) => s + b.shortagePaise, 0),
      receivedPaise: recs.reduce((s, r) => s + r.amountPaise, 0),
      deductedPaise: recs.reduce((s, r) => s + r.deductionPaise, 0), receipts: recs.length,
      toReceivePaise: mills.totals.toReceivePaise,
      paidAheadPaise: mills.totals.paidAheadPaise,
      /** All time up to the period's end: opening + billed − cuts − received − held back = the balance the tile shows. */
      allTime: { openingPaise: mills.totals.openingPaise, billedPaise: mills.totals.billedPaise, shortagePaise: mills.totals.shortagePaise, receivedPaise: mills.totals.receivedPaise, deductedPaise: mills.totals.deductedPaise },
    },
    /** Grand totals of the approved parchas in the period, split into what they are made of. */
    billed: {
      goodsPaise: goods, adatPaise: adat,
      parts: [...parts.values()].filter((p) => p.amountPaise !== 0),
      grandTotalPaise: grand,
      // grand-total rounding (and a dara added to the total, if a mill does that)
      otherPaise: grand - listed,
    },
  });
});
