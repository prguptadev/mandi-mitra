import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { shiftDay } from "./parchaLabels.ts";
import { rstKey, looseRst, grossOdd, usualRate, rateOdd, dayGap, RST_WINDOW_DAYS, type GrossOdd, type RateRange } from "./slipChecks.ts";

/* The same weighbridge slip entered twice is the costliest slip of all: the
   supplier is owed for it twice. RST numbers repeat (every kanta's counter
   rolls over), so a repeat on another date only means something when the
   weight is the same to the gram — that is the same sheet entered again.
   On the same date any repeat is shown, whatever the weight. Loose packets
   ("2+45" in the RST box) are no weighbridge slip: the same packets come
   again on any day, so they are never a repeat. Everything here is a flag
   for a person; nothing stops a save. */

export interface SlipTarget {
  /** Left out of its own matches. */
  id?: string;
  slipDate: string; rstNo: string; grossGrams: number;
  ratePaisePerQtl?: number; jinsId?: string;
}

export interface SlipFlags {
  /** Slips on that date with this RST, this one included — every mill and commodity. */
  rstDay: number;
  /** The other slips with this RST on the same date. */
  sameDayIds: string[];
  /** Slips within 30 days either side, on another date, with this RST and exactly this gross. */
  otherDays: { id: string; date: string }[];
  grossOdd: GrossOdd;
  /** The day's usual range, when this rate is outside it. */
  rateOdd: RateRange | null;
}

const S = schema.purchaseSlips;

/**
 * Same RST and same gross on another date, 30 days either side. Slips of
 * `exceptBatch` (a scan being checked again after it was saved) are not
 * counted against themselves.
 */
export async function sameSlipOtherDays(
  biz: string,
  targets: { key: string; slipDate: string; rstNo: string; grossGrams: number | null; id?: string }[],
  opts: { exceptBatch?: string } = {},
): Promise<Map<string, { id: string; date: string }[]>> {
  const out = new Map<string, { id: string; date: string }[]>();
  const live = targets.filter((t) => t.slipDate && t.rstNo && t.grossGrams && !looseRst(t.rstNo));
  if (!live.length) return out;
  const dates = live.map((t) => t.slipDate).sort();
  const from = shiftDay(dates[0], -RST_WINDOW_DAYS);
  const to = shiftDay(dates[dates.length - 1], RST_WINDOW_DAYS);
  const grosses = [...new Set(live.map((t) => t.grossGrams!))];
  const found: { id: string; date: string; rst: string; gross: number; batch: string | null }[] = [];
  // the weight narrows it to a handful of slips; a few hundred at a time
  for (let i = 0; i < grosses.length; i += 400) {
    found.push(...await db.select({ id: S.id, date: S.slipDate, rst: S.rstNo, gross: S.grossGrams, batch: S.scanBatchId }).from(S)
      .where(and(eq(S.businessId, biz), gte(S.slipDate, from), lte(S.slipDate, to), inArray(S.grossGrams, grosses.slice(i, i + 400)))));
  }
  const byKey = new Map<string, typeof found>();
  for (const f of found) {
    if (opts.exceptBatch && f.batch === opts.exceptBatch) continue;
    const k = `${f.gross}|${rstKey(f.rst)}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(f);
  }
  for (const t of live) {
    const hits = (byKey.get(`${t.grossGrams}|${rstKey(t.rstNo)}`) ?? [])
      .filter((f) => f.id !== t.id && f.date !== t.slipDate && Math.abs(dayGap(t.slipDate, f.date)) <= RST_WINDOW_DAYS)
      .sort((a, b) => a.date.localeCompare(b.date));
    if (hits.length) out.set(t.key, hits.map((h) => ({ id: h.id, date: h.date })));
  }
  return out;
}

/**
 * Every flag for each slip, against the whole of its day (all mills, all
 * commodities — not just the rows a filtered list happens to show), plus the
 * usual rate of each day and commodity, keyed "date|jinsId".
 */
export async function slipFlags(biz: string, targets: SlipTarget[]) {
  const dates = [...new Set(targets.map((t) => t.slipDate))];
  const day = dates.length
    ? await db.select({ id: S.id, date: S.slipDate, rst: S.rstNo, rate: S.ratePaisePerQtl, jins: S.jinsId }).from(S)
      .where(and(eq(S.businessId, biz), inArray(S.slipDate, dates)))
    : [];
  const byRst = new Map<string, string[]>();
  const rates = new Map<string, number[]>();
  for (const s of day) {
    const k = `${s.date}|${rstKey(s.rst)}`;
    if (!looseRst(s.rst)) {
      if (!byRst.has(k)) byRst.set(k, []);
      byRst.get(k)!.push(s.id);
    }
    const rk = `${s.date}|${s.jins}`;
    if (!rates.has(rk)) rates.set(rk, []);
    rates.get(rk)!.push(s.rate);
  }
  const usual = new Map<string, RateRange>();
  for (const [k, list] of rates) usual.set(k, usualRate(list));
  const others = await sameSlipOtherDays(biz, targets.map((t, i) => ({ key: String(i), slipDate: t.slipDate, rstNo: t.rstNo, grossGrams: t.grossGrams, id: t.id })));

  const flags: SlipFlags[] = targets.map((t, i) => {
    const loose = looseRst(t.rstNo);
    const same = loose ? [] : (byRst.get(`${t.slipDate}|${rstKey(t.rstNo)}`) ?? []).filter((id) => id !== t.id);
    const range = t.jinsId ? usual.get(`${t.slipDate}|${t.jinsId}`) ?? usualRate([]) : usualRate([]);
    return {
      // a slip not saved yet (no id) counts itself in
      rstDay: same.length + 1,
      sameDayIds: same,
      otherDays: others.get(String(i)) ?? [],
      grossOdd: grossOdd(t.grossGrams, t.rstNo),
      rateOdd: rateOdd(t.ratePaisePerQtl, range) ? range : null,
    };
  });
  return { flags, usual };
}

/**
 * What the screen says after a save: the other slips by date, mill and
 * supplier, so the operator can find them, and the figures that look off.
 */
export async function describeFlags(biz: string, f: SlipFlags) {
  const ids = [...f.sameDayIds, ...f.otherDays.map((o) => o.id)];
  const rows = ids.length
    ? await db.select({ id: S.id, date: S.slipDate, rst: S.rstNo, mill: schema.merchants.code, nameHi: schema.adati.nameHi, nameHinglish: schema.adati.nameHinglish })
      .from(S)
      .innerJoin(schema.adati, eq(schema.adati.id, S.adatiId))
      .leftJoin(schema.merchants, eq(schema.merchants.id, S.merchantId))
      .where(and(eq(S.businessId, biz), inArray(S.id, ids)))
    : [];
  const one = (id: string) => {
    const r = rows.find((x) => x.id === id);
    return r ? { date: r.date, rstNo: r.rst, millCode: r.mill ?? null, nameHi: r.nameHi, nameHinglish: r.nameHinglish } : null;
  };
  return {
    /** The same RST already on this date — any mill, any commodity. */
    sameDay: f.sameDayIds.map(one).filter((x) => x !== null),
    /** The same RST with the same weight on another date: likely the same sheet entered twice. */
    otherDays: f.otherDays.map((o) => one(o.id)).filter((x) => x !== null),
    grossOdd: f.grossOdd,
    rateOdd: f.rateOdd,
  };
}
