import { eq, and, gte, lte, lt, inArray, sql, getTableColumns, type SQL } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { rowsOf } from "../db/rows.ts";
import { amountPaise, avgFromSums } from "./money.ts";
import { linesWithWeights, rateOf } from "./parcha.ts";
import { figuresOf } from "./parchaFigures.ts";
import { sharedPart, partInHand } from "./unchangedBooks.ts";

/* Reconciliation: what came in for each mill against what went out to it.
   Incoming is the slips (by purchase date); outgoing is the truck rows (by
   the truck's date). Every figure is a sum of those rows, so any mismatch —
   more loaded than received, a truck whose rows do not add up — shows up as
   a difference rather than hiding inside a stored total. */

export interface Filter { jinsId?: string | null; from?: string; to?: string; merchantId?: string }

const key = (mill: string | null, jins: string, date: string) => `${mill ?? "-"}|${jins}|${date}`;

export type AvgOf = (mill: string | null, jins: string, date: string) => number;

/**
 * Every purchase day of a business — mill, commodity, date — with its sums,
 * in one pass over the slips. The dashboard reads what came in, each day's
 * average rate and its checks from these rows, instead of going over the
 * whole slip table once for each.
 */
export interface SlipDay {
  merchantId: string | null; jinsId: string; date: string;
  slips: number; netGrams: number; grossGrams: number; amountPaise: number;
  pricedNet: number; pricedValue: string; unpriced: number;
  /** Slips (and their net) with a rate of exactly 0. */
  zeroRateSlips: number; zeroRateNet: number;
}
export async function slipDays(businessId: string): Promise<SlipDay[]> {
  const S = schema.purchaseSlips;
  const fields = {
    merchantId: S.merchantId, jinsId: S.jinsId, date: S.slipDate,
    slips: sql<number>`count(*)`,
    netGrams: sql<number>`sum(${S.netGrams})`,
    grossGrams: sql<number>`sum(${S.grossGrams})`,
    amountPaise: sql<number>`sum(${S.amountPaise})`,
    pricedNet: sql<number>`sum(case when ${S.ratePaisePerQtl} > 0 then ${S.netGrams} else 0 end)`,
    pricedValue: sql<string>`cast(sum(case when ${S.ratePaisePerQtl} > 0 then ${S.netGrams} * ${S.ratePaisePerQtl} else 0 end) as text)`,
    unpriced: sql<number>`sum(case when ${S.ratePaisePerQtl} > 0 then 0 else 1 end)`,
    zeroRateSlips: sql<number>`sum(case when ${S.ratePaisePerQtl} = 0 then 1 else 0 end)`,
    zeroRateNet: sql<number>`sum(case when ${S.ratePaisePerQtl} = 0 then ${S.netGrams} else 0 end)`,
  };
  return rowsOf(db.select(fields).from(S).where(eq(S.businessId, businessId)).groupBy(S.merchantId, S.jinsId, S.slipDate), fields);
}

/* The parts the whole-book screens share while the books are unchanged (see
   sharedPart): each is exactly what the function named would give. */

/** slipDays(businessId). */
export const bookSlipDays = (businessId: string) => sharedPart(`slipDays|${businessId}`, () => slipDays(businessId));
/** dayAverages(businessId): every mill's, from bookSlipDays(). */
export const bookAverages = (businessId: string) => sharedPart(`averages|${businessId}`, async () => averagesOf(await bookSlipDays(businessId)));
/** Every truck row of a business with its weight: linesWithWeights() for the business, in that query's order. */
const linesKey = (businessId: string) => `lines|${businessId}`;
export const bookLines = (businessId: string) =>
  sharedPart(linesKey(businessId), () => linesWithWeights(eq(schema.loadLines.businessId, businessId), { wholeTrucks: true }));
/** Whether bookLines(businessId) is in hand for the books as they are now. */
export const bookLinesInHand = (businessId: string) => partInHand(linesKey(businessId));
/** trucks(businessId, { jinsId }): every truck of a business, priced. */
export const bookTrucks = (businessId: string, jinsId?: string | null) =>
  sharedPart(`trucks|${businessId}|${jinsId ?? ""}`, () => trucks(businessId, { jinsId }));

/** dayAverages(), from slipDays() rows. */
export function averagesOf(days: SlipDay[]): AvgOf {
  const m = new Map<string, number>();
  for (const r of days) if (r.pricedNet) m.set(key(r.merchantId, r.jinsId, r.date), avgFromSums(r.pricedValue, r.pricedNet));
  return (mill, jins, date) => m.get(key(mill, jins, date)) ?? 0;
}

/** incoming(businessId, { jinsId }), from slipDays() rows: by mill and date, every commodity added (or only jinsId). */
export function incomingOf(days: SlipDay[], jinsId?: string | null) {
  const by = new Map<string, { merchantId: string | null; date: string; slips: number; netGrams: number; grossGrams: number; amountPaise: number; pricedNet: number; value: bigint; unpriced: number }>();
  for (const r of days) {
    if (jinsId && r.jinsId !== jinsId) continue;
    const k = `${r.merchantId ?? "-"}|${r.date}`;
    let g = by.get(k);
    if (!g) { g = { merchantId: r.merchantId, date: r.date, slips: 0, netGrams: 0, grossGrams: 0, amountPaise: 0, pricedNet: 0, value: 0n, unpriced: 0 }; by.set(k, g); }
    g.slips += r.slips; g.netGrams += r.netGrams; g.grossGrams += r.grossGrams; g.amountPaise += r.amountPaise;
    g.pricedNet += r.pricedNet; g.value += BigInt(String(r.pricedValue).split(".")[0]); g.unpriced += r.unpriced;
  }
  // in incoming()'s order: by mill (none first), then date
  const cmp = (a: string | null, b: string | null) => (a === b ? 0 : a === null ? -1 : b === null ? 1 : a < b ? -1 : 1);
  return [...by.values()].sort((a, b) => cmp(a.merchantId, b.merchantId) || cmp(a.date, b.date))
    .map(({ merchantId, date, slips, netGrams, grossGrams, amountPaise, pricedNet, value, unpriced }) =>
      ({ merchantId, date, slips, netGrams, grossGrams, amountPaise, pricedNet, pricedValue: value.toString(), unpriced }));
}

/** The day's average rate for a mill and commodity: Σ net × rate / Σ net over priced slips.
 *  With `merchantId`, only that mill's days are worked out (the others answer 0). */
export async function dayAverages(businessId: string, merchantId?: string): Promise<AvgOf> {
  const S = schema.purchaseSlips;
  const fields = {
    merchantId: S.merchantId, jinsId: S.jinsId, date: S.slipDate,
    pricedNet: sql<number>`sum(case when ${S.ratePaisePerQtl} > 0 then ${S.netGrams} else 0 end)`,
    pricedValue: sql<string>`cast(sum(case when ${S.ratePaisePerQtl} > 0 then ${S.netGrams} * ${S.ratePaisePerQtl} else 0 end) as text)`,
  };
  const rows = await rowsOf(db.select(fields).from(S).where(and(eq(S.businessId, businessId), ...(merchantId ? [eq(S.merchantId, merchantId)] : []))).groupBy(S.merchantId, S.jinsId, S.slipDate), fields);
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
  /** Every commodity on the truck (the header's first); with a commodity filter, only that one. */
  jinsIds: string[];
  stockDates: string[]; parchaNo: string | null; grandTotalPaise: number | null;
  mismatch: boolean; incomplete: boolean;
  /** Weight the mill cut on arrival, and its note (see loads.millDeductionGrams). */
  deductionGrams: number; deductionNote: string | null;
  /** Freight advance paid to the truck on the mill's behalf, recovered on the parcha (the frozen figure once billed). */
  advancePaise: number;
  rows: { stockDate: string; jinsId: string; weightGrams: number; ratePaisePerQtl: number; dayAvgPaisePerQtl: number; typed: boolean; amountPaise: number }[];
}

/**
 * Every truck in the filter, priced: an approved truck from its frozen
 * parcha (what the mill was billed), a draft from its rows as they stand.
 */
export async function trucks(businessId: string, f: Filter & { before?: string }, shared: { avg?: AvgOf } = {}): Promise<TruckSummary[]> {
  const L = schema.loads;
  const w: SQL[] = [eq(L.businessId, businessId)];
  if (f.merchantId) w.push(eq(L.merchantId, f.merchantId));
  if (f.from) w.push(gte(L.loadDate, f.from));
  if (f.to) w.push(lte(L.loadDate, f.to));
  if (f.before) w.push(lt(L.loadDate, f.before));
  // a commodity filter is answered from the rows: a truck carrying two commodities counts each under its own
  const loadFields = getTableColumns(L);
  const allLoads = await rowsOf(db.select(loadFields).from(L).where(and(...w)), loadFields);
  if (!allLoads.length) return [];
  /* Every row of these trucks: from the business's rows when they are in hand
     or when no one mill is asked for (each truck's rows the same, in the same
     order), else read for these trucks alone. */
  let allLines: Awaited<ReturnType<typeof linesWithWeights>>;
  if (!f.merchantId || bookLinesInHand(businessId)) {
    const these = new Set(allLoads.map((l) => l.id));
    allLines = (await bookLines(businessId)).filter((x) => these.has(x.loadId));
  } else {
    allLines = await linesWithWeights(inArray(schema.loadLines.loadId, allLoads.map((l) => l.id)), { wholeTrucks: true });
  }
  const lines = f.jinsId ? allLines.filter((x) => x.jinsId === f.jinsId) : allLines;
  const withLines = f.jinsId ? new Set(lines.map((x) => x.loadId)) : null;
  const loads = withLines ? allLoads.filter((l) => withLines.has(l.id)) : allLoads;
  if (!loads.length) return [];
  const ids = loads.map((l) => l.id);
  const jinsCode = f.jinsId ? (await db.select({ code: schema.jins.code }).from(schema.jins).where(eq(schema.jins.id, f.jinsId)))[0]?.code : null;
  /* Every truck here is of f.merchantId when it is given: only that mill's day
     averages are ever asked for, and the business's give the same figures. */
  const avg = shared.avg ?? (!f.merchantId || partInHand(`averages|${businessId}`) ? await bookAverages(businessId) : await dayAverages(businessId, f.merchantId));
  // a truck has one live parcha at most (parcha_one_approved_uq); for many trucks, the business's, kept for these
  const P = schema.parchas;
  const parchaFields = { id: P.id, loadId: P.loadId, parchaNo: P.parchaNo, bytes: sql<number>`octet_length(${P.snapshot})`, grand: P.grandTotalPaise };
  const idSet = new Set(ids);
  const parchas = ids.length > 500
    ? (await rowsOf(db.select(parchaFields).from(P).where(and(eq(P.businessId, businessId), eq(P.status, "approved"))), parchaFields)).filter((p) => idSet.has(p.loadId))
    : await rowsOf(db.select(parchaFields).from(P).where(and(inArray(P.loadId, ids), eq(P.status, "approved"))), parchaFields);
  const parchaOf = new Map(parchas.map((p) => [p.loadId, p]));
  const frozen = figuresOf([...parchaOf.values()]);

  const byLoad = new Map<string, typeof lines>();
  for (const x of lines) { const a = byLoad.get(x.loadId); if (a) a.push(x); else byLoad.set(x.loadId, [x]); }
  // every row of a truck, whatever the commodity filter: a draft is out of step only as a whole
  const wholeOf = new Map<string, typeof allLines>();
  for (const x of allLines) { const a = wholeOf.get(x.loadId); if (a) a.push(x); else wholeOf.set(x.loadId, [x]); }
  return loads.map((l) => {
    const mine = byLoad.get(l.id) ?? [];
    const rows = mine.map((x) => {
      const dayAvg = avg(l.merchantId, x.jinsId, x.stockDate);
      const rate = x.ratePaisePerQtl ?? dayAvg;
      return {
        stockDate: x.stockDate, jinsId: x.jinsId, weightGrams: x.weightGrams, ratePaisePerQtl: rate, dayAvgPaisePerQtl: dayAvg,
        typed: x.ratePaisePerQtl != null, amountPaise: amountPaise(x.weightGrams, rate),
      };
    });
    const p = parchaOf.get(l.id);
    const doc = p ? frozen.get(p.id)! : null;
    // an approved truck is what its frozen parcha billed; under a commodity filter, that commodity's lines of it
    const docLines = doc ? (jinsCode ? doc.lines.filter((x) => x.jinsCode === jinsCode) : doc.lines) : null;
    const weight = docLines ? docLines.reduce((s, x) => s + x.netGrams, 0) : rows.reduce((s, r) => s + r.weightGrams, 0);
    const goods = docLines ? docLines.reduce((s, x) => s + x.amountPaise, 0) : rows.reduce((s, r) => s + r.amountPaise, 0);
    // the whole truck's rate only when the whole truck is meant
    const rate = doc && !jinsCode ? doc.totals.ratePaisePerQtl : rateOf(goods, weight);
    return {
      loadId: l.id, merchantId: l.merchantId, jinsId: l.jinsId, loadDate: l.loadDate, truckNo: l.truckNo, status: l.status,
      jinsIds: f.jinsId ? [f.jinsId] : [...new Set([l.jinsId, ...mine.map((x) => x.jinsId)])],
      millGrossGrams: l.millGrossGrams, millNetGrams: l.millNetGrams, bags: l.bags,
      weightGrams: weight, goodsPaise: goods, ratePaisePerQtl: rate,
      stockDates: [...new Set(rows.map((r) => r.stockDate))].sort(),
      parchaNo: p?.parchaNo ?? null, grandTotalPaise: p?.grand ?? null,
      // an approved truck is billed from its frozen parcha; only a draft can still be out of step
      mismatch: !p && l.millNetGrams != null && rows.length > 0 && (() => {
        const whole = wholeOf.get(l.id) ?? [];
        return whole.reduce((s, r) => s + r.weightGrams, 0) !== l.millNetGrams || whole.some((r) => r.weightGrams <= 0);
      })(),
      incomplete: l.status !== "billed" && (l.millGrossGrams == null || !l.bags),
      deductionGrams: l.millDeductionGrams, deductionNote: l.millDeductionNote,
      advancePaise: doc ? doc.result.advancePaise : l.advancePaise,
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
