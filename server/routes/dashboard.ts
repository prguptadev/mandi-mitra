import { Hono } from "hono";
import { eq, and, gte, lte, sql, inArray } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { can, bad, notFound, type Env } from "../lib/http.ts";
import { incoming, trucks, race, worstAhead, type Filter } from "../lib/tracking.ts";
import { linesWithWeights } from "../lib/parcha.ts";
import { dispatchedByPo, poLabel } from "./orders.ts";

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

const avgOf = (pricedValue: number, pricedNet: number) => (pricedNet ? Math.floor(pricedValue / pricedNet + 0.5) : 0);

export type FlagItem = Record<string, string | number | null>;
export interface Flag { code: string; level: "bad" | "warn" | "info"; items: FlagItem[] }

/** Everything that does not add up, across all dates. */
async function flags(biz: string, jinsId: string | null): Promise<Flag[]> {
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
  const all = await trucks(biz, { jinsId });
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

  // suppliers paid more than they are owed
  const suppliers = await db.select({ id: schema.adati.id, nameHi: schema.adati.nameHi, nameHinglish: schema.adati.nameHinglish, opening: schema.adati.openingBalancePaise })
    .from(schema.adati).where(eq(schema.adati.businessId, biz));
  const bought = await db.select({ adatiId: S.adatiId, p: sql<number>`sum(${S.amountPaise})` }).from(S).where(eq(S.businessId, biz)).groupBy(S.adatiId);
  const paid = await db.select({ adatiId: schema.payments.adatiId, p: sql<number>`sum(${schema.payments.amountPaise})` })
    .from(schema.payments).where(eq(schema.payments.businessId, biz)).groupBy(schema.payments.adatiId);
  const ahead = suppliers.map((s) => ({ s, bal: s.opening + (bought.find((b) => b.adatiId === s.id)?.p ?? 0) - (paid.find((p) => p.adatiId === s.id)?.p ?? 0) }))
    .filter((x) => x.bal < 0);
  out.push({ code: "paid_ahead", level: "warn", items: ahead.map((x) => ({ adatiId: x.s.id, nameHi: x.s.nameHi, name: x.s.nameHinglish, paise: -x.bal })) });

  // reads that failed or never finished
  const scans = await db.select({ id: schema.scanBatches.id, date: schema.scanBatches.slipDate, status: schema.scanBatches.status, error: schema.scanBatches.errorText })
    .from(schema.scanBatches).where(and(eq(schema.scanBatches.businessId, biz), inArray(schema.scanBatches.status, ["failed"])));
  out.push({ code: "scan_failed", level: "warn", items: scans.map((s) => ({ scanId: s.id, date: s.date, error: (s.error ?? "").slice(0, 120) })) });

  return out.filter((f) => f.items.length);
}

dashboardRoutes.get("/", can("dashboard.view"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const f = filterOf(c);
  const mills = await db.select({ id: schema.merchants.id, code: schema.merchants.code, name: schema.merchants.name, nameHi: schema.merchants.nameHi, active: schema.merchants.active })
    .from(schema.merchants).where(eq(schema.merchants.businessId, biz));

  const inRows = await incoming(biz, f);
  const outRows = await trucks(biz, f);
  const beforeIn = f.from ? await incoming(biz, { jinsId: f.jinsId, before: f.from }) : [];
  const beforeOut = f.from ? await trucks(biz, { jinsId: f.jinsId, before: f.from }) : [];

  const perMill = mills.map((m) => {
    const ins = inRows.filter((r) => r.merchantId === m.id);
    const outs = outRows.filter((r) => r.merchantId === m.id);
    const opening = {
      in: beforeIn.filter((r) => r.merchantId === m.id).reduce((s, r) => s + r.netGrams, 0),
      out: beforeOut.filter((r) => r.merchantId === m.id).reduce((s, r) => s + r.weightGrams, 0),
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
      avgBuyPaisePerQtl: avgOf(ins.reduce((s, r) => s + r.pricedValue, 0), ins.reduce((s, r) => s + r.pricedNet, 0)),
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
  const payments = await db.select({ p: sql<number>`coalesce(sum(${schema.payments.amountPaise}), 0)` }).from(schema.payments)
    .where(and(eq(schema.payments.businessId, biz), ...(f.from ? [gte(schema.payments.payDate, f.from)] : []), ...(f.to ? [lte(schema.payments.payDate, f.to)] : [])));

  const kpis = {
    slips: inRows.reduce((s, r) => s + r.slips, 0),
    boughtNetGrams: inRows.reduce((s, r) => s + r.netGrams, 0),
    boughtAmountPaise: inRows.reduce((s, r) => s + r.amountPaise, 0),
    avgBuyPaisePerQtl: avgOf(inRows.reduce((s, r) => s + r.pricedValue, 0), inRows.reduce((s, r) => s + r.pricedNet, 0)),
    noMillGrams: noMill.reduce((s, r) => s + r.netGrams, 0),
    loadedGrams: perMill.reduce((s, m) => s + m.loadedGrams, 0),
    goodsPaise: perMill.reduce((s, m) => s + m.goodsPaise, 0),
    billedPaise: perMill.reduce((s, m) => s + m.billedPaise, 0),
    trucks: outRows.length,
    drafts: outRows.filter((r) => r.status !== "billed").length,
    leftGrams: perMill.reduce((s, m) => s + m.leftGrams, 0),
    paidPaise: payments[0]?.p ?? 0,
  };
  const avgSale = kpis.loadedGrams ? Math.floor((kpis.goodsPaise * 100_000) / kpis.loadedGrams + 0.5) : 0;

  return c.json({ period: { from: f.from ?? null, to: f.to ?? null }, kpis: { ...kpis, avgSalePaisePerQtl: avgSale }, mills: perMill, flags: await flags(biz, f.jinsId ?? null) });
});

/** One mill: received, loaded (every truck, priced), left, and the race between them. */
dashboardRoutes.get("/mill/:id", can("stock.read"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const id = c.req.param("id") ?? "";
  const f = { ...filterOf(c), merchantId: id };
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
      avgBuyPaisePerQtl: avgOf(ins.reduce((s, r) => s + r.pricedValue, 0), ins.reduce((s, r) => s + r.pricedNet, 0)),
      unpriced: ins.reduce((s, r) => s + r.unpriced, 0),
      loadedGrams: loaded,
      goodsPaise: goods,
      avgSalePaisePerQtl: loaded ? Math.floor((goods * 100_000) / loaded + 0.5) : 0,
      billedPaise: outs.reduce((s, r) => s + (r.grandTotalPaise ?? 0), 0),
      trucks: outs.length,
      drafts: outs.filter((r) => r.status !== "billed").length,
      leftGrams: opening.in - opening.out + boughtNet - loaded,
    },
    series,
    worstAhead: worstAhead(series),
    trucks: outs.sort((a, b) => b.loadDate.localeCompare(a.loadDate)),
    incoming: ins.map((r) => ({ date: r.date, slips: r.slips, netGrams: r.netGrams, grossGrams: r.grossGrams, amountPaise: r.amountPaise,
      avgPaisePerQtl: avgOf(r.pricedValue, r.pricedNet), unpriced: r.unpriced })).sort((a, b) => b.date.localeCompare(a.date)),
  });
});
