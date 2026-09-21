import { eq, and, gte, lte, lt, inArray, sql, type SQL } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { amountPaise, avgFromSums } from "./money.ts";
import { linesWithWeights, rateOf, type ParchaDoc } from "./parcha.ts";

/* Reconciliation: what came in for each mill against what went out to it.
   Incoming is the slips (by purchase date); outgoing is the truck rows (by
   the truck's date). Every figure is a sum of those rows, so any mismatch —
   more loaded than received, a truck whose rows do not add up — shows up as
   a difference rather than hiding inside a stored total. */

export interface Filter { jinsId?: string | null; from?: string; to?: string; merchantId?: string }

const key = (mill: string | null, jins: string, date: string) => `${mill ?? "-"}|${jins}|${date}`;

/** The day's average rate for a mill and commodity: Σ net × rate / Σ net over priced slips. */
export async function dayAverages(businessId: string) {
  const S = schema.purchaseSlips;
  const rows = await db.select({
    merchantId: S.merchantId, jinsId: S.jinsId, date: S.slipDate,
    pricedNet: sql<number>`sum(case when ${S.ratePaisePerQtl} > 0 then ${S.netGrams} else 0 end)`,
    pricedValue: sql<string>`cast(sum(case when ${S.ratePaisePerQtl} > 0 then ${S.netGrams} * ${S.ratePaisePerQtl} else 0 end) as text)`,
  }).from(S).where(eq(S.businessId, businessId)).groupBy(S.merchantId, S.jinsId, S.slipDate);
  const m = new Map<string, number>();
  for (const r of rows) if (r.pricedNet) m.set(key(r.merchantId, r.jinsId, r.date), avgFromSums(r.pricedValue, r.pricedNet));
  return (mill: string | null, jins: string, date: string) => m.get(key(mill, jins, date)) ?? 0;
}

/** Slips in, by mill and date. */
export async function incoming(businessId: string, f: Filter & { before?: string }) {
  const S = schema.purchaseSlips;
  const w: SQL[] = [eq(S.businessId, businessId)];
  if (f.jinsId) w.push(eq(S.jinsId, f.jinsId));
  if (f.merchantId) w.push(eq(S.merchantId, f.merchantId));
  if (f.from) w.push(gte(S.slipDate, f.from));
  if (f.to) w.push(lte(S.slipDate, f.to));
  if (f.before) w.push(lt(S.slipDate, f.before));
  return db.select({
    merchantId: S.merchantId, date: S.slipDate,
    slips: sql<number>`count(*)`,
    netGrams: sql<number>`sum(${S.netGrams})`,
    grossGrams: sql<number>`sum(${S.grossGrams})`,
    amountPaise: sql<number>`sum(${S.amountPaise})`,
    pricedNet: sql<number>`sum(case when ${S.ratePaisePerQtl} > 0 then ${S.netGrams} else 0 end)`,
    pricedValue: sql<string>`cast(sum(case when ${S.ratePaisePerQtl} > 0 then ${S.netGrams} * ${S.ratePaisePerQtl} else 0 end) as text)`,
    unpriced: sql<number>`sum(case when ${S.ratePaisePerQtl} > 0 then 0 else 1 end)`,
  }).from(S).where(and(...w)).groupBy(S.merchantId, S.slipDate);
}

export interface TruckSummary {
  loadId: string; merchantId: string; jinsId: string; loadDate: string; truckNo: string | null; status: string;
  millGrossGrams: number | null; millNetGrams: number | null; bags: number | null;
  weightGrams: number; goodsPaise: number; ratePaisePerQtl: number;
  stockDates: string[]; parchaNo: string | null; grandTotalPaise: number | null;
  mismatch: boolean; incomplete: boolean;
  /** Weight the mill cut on arrival, and its note (see loads.millDeductionGrams). */
  deductionGrams: number; deductionNote: string | null;
  rows: { stockDate: string; weightGrams: number; ratePaisePerQtl: number; dayAvgPaisePerQtl: number; typed: boolean; amountPaise: number }[];
}

/**
 * Every truck in the filter, priced: an approved truck from its frozen
 * parcha (what the mill was billed), a draft from its rows as they stand.
 */
export async function trucks(businessId: string, f: Filter & { before?: string }): Promise<TruckSummary[]> {
  const L = schema.loads;
  const w: SQL[] = [eq(L.businessId, businessId)];
  if (f.jinsId) w.push(eq(L.jinsId, f.jinsId));
  if (f.merchantId) w.push(eq(L.merchantId, f.merchantId));
  if (f.from) w.push(gte(L.loadDate, f.from));
  if (f.to) w.push(lte(L.loadDate, f.to));
  if (f.before) w.push(lt(L.loadDate, f.before));
  const loads = await db.select().from(L).where(and(...w));
  if (!loads.length) return [];
  const ids = loads.map((l) => l.id);
  const lines = await linesWithWeights(inArray(schema.loadLines.loadId, ids));
  const avg = await dayAverages(businessId);
  const parchas = await db.select({ loadId: schema.parchas.loadId, parchaNo: schema.parchas.parchaNo, snapshot: schema.parchas.snapshot, grand: schema.parchas.grandTotalPaise })
    .from(schema.parchas).where(and(inArray(schema.parchas.loadId, ids), eq(schema.parchas.status, "approved")));
  const parchaOf = new Map(parchas.map((p) => [p.loadId, p]));

  const byLoad = new Map<string, typeof lines>();
  for (const x of lines) byLoad.set(x.loadId, [...(byLoad.get(x.loadId) ?? []), x]);
  return loads.map((l) => {
    const mine = byLoad.get(l.id) ?? [];
    const rows = mine.map((x) => {
      const dayAvg = avg(l.merchantId, x.jinsId, x.stockDate);
      const rate = x.ratePaisePerQtl ?? dayAvg;
      return {
        stockDate: x.stockDate, weightGrams: x.weightGrams, ratePaisePerQtl: rate, dayAvgPaisePerQtl: dayAvg,
        typed: x.ratePaisePerQtl != null, amountPaise: amountPaise(x.weightGrams, rate),
      };
    });
    const p = parchaOf.get(l.id);
    const doc = p ? (JSON.parse(p.snapshot) as ParchaDoc) : null;
    const weight = doc ? doc.totals.netGrams : rows.reduce((s, r) => s + r.weightGrams, 0);
    const goods = doc ? doc.totals.goodsPaise : rows.reduce((s, r) => s + r.amountPaise, 0);
    return {
      loadId: l.id, merchantId: l.merchantId, jinsId: l.jinsId, loadDate: l.loadDate, truckNo: l.truckNo, status: l.status,
      millGrossGrams: l.millGrossGrams, millNetGrams: l.millNetGrams, bags: l.bags,
      weightGrams: weight, goodsPaise: goods, ratePaisePerQtl: doc ? doc.totals.ratePaisePerQtl : rateOf(goods, weight),
      stockDates: [...new Set(rows.map((r) => r.stockDate))].sort(),
      parchaNo: p?.parchaNo ?? null, grandTotalPaise: p?.grand ?? null,
      // an approved truck is billed from its frozen parcha; only a draft can still be out of step
      mismatch: !p && l.millNetGrams != null && rows.length > 0
        && (rows.reduce((s, r) => s + r.weightGrams, 0) !== l.millNetGrams || rows.some((r) => r.weightGrams <= 0)),
      incomplete: l.status !== "billed" && (l.millGrossGrams == null || !l.bags),
      deductionGrams: l.millDeductionGrams, deductionNote: l.millDeductionNote,
      rows,
    };
  });
}

export interface RacePoint { date: string; in: number; out: number; cumIn: number; cumOut: number }

/**
 * The race: cumulative received vs cumulative loaded, day by day. With a
 * `from`, the lines start from what was already in and out before it, so
 * the gap is always the real stock.
 */
export function race(
  inRows: { date: string; netGrams: number }[],
  outRows: { loadDate: string; weightGrams: number }[],
  opening = { in: 0, out: 0 },
): RacePoint[] {
  const ins = new Map<string, number>();
  const outs = new Map<string, number>();
  for (const r of inRows) ins.set(r.date, (ins.get(r.date) ?? 0) + r.netGrams);
  for (const r of outRows) outs.set(r.loadDate, (outs.get(r.loadDate) ?? 0) + r.weightGrams);
  const dates = [...new Set([...ins.keys(), ...outs.keys()])].sort();
  let ci = opening.in, co = opening.out;
  return dates.map((d) => {
    ci += ins.get(d) ?? 0;
    co += outs.get(d) ?? 0;
    return { date: d, in: ins.get(d) ?? 0, out: outs.get(d) ?? 0, cumIn: ci, cumOut: co };
  });
}

/** The worst moment loading ran ahead of receipts, if it ever did. */
export function worstAhead(points: RacePoint[]) {
  let worst: { date: string; grams: number } | null = null;
  for (const p of points) {
    const ahead = p.cumOut - p.cumIn;
    if (ahead > 0 && (!worst || ahead > worst.grams)) worst = { date: p.date, grams: ahead };
  }
  return worst;
}
