import { Hono } from "hono";
import { eq, and, gte, lte, lt, isNull, inArray, sql } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { parsePrefs, MILL_REPORT_COLUMNS, type MillReportColumnKey } from "../lib/prefs.ts";
import { millReportXlsx, millReportCsv, reportTotals, type MillReportRow } from "../lib/millReport.ts";
import { sortSlips, type SlipSortOrder } from "../lib/slipOrder.ts";
import { can, bad, notFound, attachment, type Env } from "../lib/http.ts";
import { boughtByDay, linesWithWeights } from "../lib/parcha.ts";
import { avgFromSums } from "../lib/money.ts";
import { bookLines, bookLinesInHand } from "../lib/tracking.ts";

/* Reports sent out of the office, and the mill stock that proves them. */

export const reportRoutes = new Hono<Env>();
export const stockRoutes = new Hono<Env>();

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SORTS: SlipSortOrder[] = ["entry", "rstAsc", "rstDesc", "newestFirst", "nameAsc", "nameDesc"];

function range(c: { req: { query: (k: string) => string | undefined } }) {
  const date = c.req.query("date");
  const from = c.req.query("from") ?? date;
  const to = c.req.query("to") ?? date ?? from;
  if (!from || !to || !ISO_DATE.test(from) || !ISO_DATE.test(to)) throw bad("Pick a day, or a from and to date", "bad_range");
  if (from > to) throw bad("The from date is after the to date", "bad_range");
  return { from, to };
}

/**
 * The daily report to a mill ("dara"): its slips for the day or range,
 * in the office's chosen order and columns, with total and average rate.
 * ?merchantId=&date= | &from=&to=  [&jinsId=] [&cols=a,b] [&names=hi|latin] [&sort=] [&format=xlsx|csv|json]
 * format=jins answers only which commodities the mill bought in the period
 * (slips and net of each), so the dara can start on one it bought.
 */
reportRoutes.get("/mill", can("export.data"), async (c) => {
  const auth = c.get("auth")!;
  const biz = auth.businessId!;
  const merchantId = c.req.query("merchantId");
  if (!merchantId) throw bad("Pick a mill", "no_mill");
  const { from, to } = range(c);
  const jinsId = c.req.query("jinsId") || null;
  if (c.req.query("format") === "jins") {
    const S = schema.purchaseSlips;
    const jins = await db.select({ jinsId: S.jinsId, slips: sql<number>`count(*)`, netGrams: sql<number>`sum(${S.netGrams})` }).from(S)
      .where(and(eq(S.businessId, biz), eq(S.merchantId, merchantId), gte(S.slipDate, from), lte(S.slipDate, to)))
      .groupBy(S.jinsId);
    return c.json({ from, to, jins });
  }

  const [user] = await db.select({ prefs: schema.users.prefs }).from(schema.users).where(eq(schema.users.id, auth.user.id)).limit(1);
  const prefs = parsePrefs(user?.prefs).dailyList;
  const known = new Set(MILL_REPORT_COLUMNS.map((x) => x.key as string));
  const asked = c.req.query("cols")?.split(",").filter((k) => known.has(k));
  let columns = (asked?.length ? asked
    : MILL_REPORT_COLUMNS.filter((x) => prefs.millReportColumns[x.key] ?? false).map((x) => x.key)) as MillReportColumnKey[];
  if (!columns.length) columns = ["sr", "adati", "jins", "gross", "net", "rate"];
  // several days in one sheet need the date on every row
  if (from !== to && !columns.includes("date")) columns = [columns[0] === "sr" ? "sr" : columns[0], "date", ...columns.slice(1)].filter((k, i, a) => a.indexOf(k) === i) as MillReportColumnKey[];
  const names = (c.req.query("names") ?? prefs.exportNameLang) === "latin" ? "latin" : "hi";
  const sortQ = c.req.query("sort") as SlipSortOrder | undefined;
  const sort = sortQ && SORTS.includes(sortQ) ? sortQ : prefs.sortOrder;

  const [biz_] = await db.select({ name: schema.businesses.name }).from(schema.businesses).where(eq(schema.businesses.id, biz)).limit(1);
  const [mill] = await db.select({ name: schema.merchants.name, code: schema.merchants.code }).from(schema.merchants)
    .where(and(eq(schema.merchants.id, merchantId), eq(schema.merchants.businessId, biz))).limit(1);
  if (!mill) throw notFound("Mill not found");
  let jinsLabel: string | null = null;
  if (jinsId) {
    const [j] = await db.select({ code: schema.jins.code, name: schema.jins.name }).from(schema.jins)
      .where(and(eq(schema.jins.id, jinsId), eq(schema.jins.businessId, biz))).limit(1);
    jinsLabel = j ? j.code : null;
  }

  const where = [
    eq(schema.purchaseSlips.businessId, biz),
    eq(schema.purchaseSlips.merchantId, merchantId),
    gte(schema.purchaseSlips.slipDate, from),
    lte(schema.purchaseSlips.slipDate, to),
  ];
  if (jinsId) where.push(eq(schema.purchaseSlips.jinsId, jinsId));
  const raw = await db.select({
    id: schema.purchaseSlips.id,
    slipDate: schema.purchaseSlips.slipDate, rstNo: schema.purchaseSlips.rstNo,
    nameHi: schema.adati.nameHi, nameLatin: schema.adati.nameHinglish,
    villageHi: schema.adati.villageHi, village: schema.adati.village,
    jinsCode: schema.jins.code,
    grossGrams: schema.purchaseSlips.grossGrams, katautiUnits: schema.purchaseSlips.katautiUnits,
    netGrams: schema.purchaseSlips.netGrams, ratePaisePerQtl: schema.purchaseSlips.ratePaisePerQtl,
    amountPaise: schema.purchaseSlips.amountPaise, createdAt: schema.purchaseSlips.createdAt,
    commissionPaise: schema.purchaseSlips.commissionPaise, gaushalaPaise: schema.purchaseSlips.gaushalaPaise,
    payablePaise: schema.purchaseSlips.payablePaise, bagsCount: schema.purchaseSlips.bagsCount,
  })
    .from(schema.purchaseSlips)
    .innerJoin(schema.adati, eq(schema.adati.id, schema.purchaseSlips.adatiId))
    .innerJoin(schema.jins, eq(schema.jins.id, schema.purchaseSlips.jinsId))
    .where(and(...where));
  const nameOf = (r: typeof raw[number]) => (names === "latin" ? r.nameLatin || r.nameHi : r.nameHi);
  const rows: MillReportRow[] = sortSlips(raw, sort, nameOf).map((r) => ({
    slipDate: r.slipDate, rstNo: r.rstNo, adati: nameOf(r), jinsCode: r.jinsCode,
    village: (names === "latin" ? r.village || r.villageHi : r.villageHi || r.village) ?? "",
    grossGrams: r.grossGrams, katautiUnits: r.katautiUnits, netGrams: r.netGrams,
    ratePaisePerQtl: r.ratePaisePerQtl, amountPaise: r.amountPaise,
    commissionPaise: r.commissionPaise, gaushalaPaise: r.gaushalaPaise, payablePaise: r.payablePaise, bagsCount: r.bagsCount,
  }));

  const data = { from, to, businessName: biz_.name, millName: mill.name, jinsLabel, columns, rows };
  const format = c.req.query("format") ?? "xlsx";
  const base = `dara-${mill.code}-${from}${from === to ? "" : `-to-${to}`}`;
  if (format === "json") return c.json({ ...data, totals: reportTotals(rows) });
  if (format === "csv") {
    return new Response(millReportCsv(data), {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": attachment(`${base}.csv`) },
    });
  }
  const buf = await millReportXlsx(data);
  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": attachment(`${base}.xlsx`),
    },
  });
});

/* -------------------------------------------------------------- stock */

/* Stock is bought − loaded, per mill, per commodity, per purchase day.
   Bought is the sum of that mill's slips; loaded is the weight of every truck
   row taken from that day. Nothing is stored, so it always adds up, and each
   figure opens to the slips and trucks behind it. It may go negative.

   With dates, "left" means one thing everywhere — the stock in hand at the
   end of the period, as the dashboard counts it: what was there at the start
   + slips dated in the period − truck rows on trucks LOADED in the period
   (by the truck's own date, not the purchase day it took from). A truck
   loaded after the period has not taken anything yet on its last day. The
   day-by-day table keeps the other view, labelled as such: what is left of
   each purchase day, counting the trucks loaded up to the period's end. */

async function stockFilter(c: { req: { query: (k: string) => string | undefined } }) {
  const jinsId = c.req.query("jinsId") || null;
  const from = c.req.query("from");
  const to = c.req.query("to");
  return {
    jinsId,
    from: from && ISO_DATE.test(from) ? from : undefined,
    to: to && ISO_DATE.test(to) ? to : undefined,
  };
}

stockRoutes.get("/", can("stock.read"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const f = await stockFilter(c);
  const S = schema.purchaseSlips;
  const where = [eq(S.businessId, biz)];
  if (f.jinsId) where.push(eq(S.jinsId, f.jinsId));
  if (f.from) where.push(gte(S.slipDate, f.from));
  if (f.to) where.push(lte(S.slipDate, f.to));
  const bought = await db.select({
    merchantId: S.merchantId,
    slips: sql<number>`count(*)`,
    netGrams: sql<number>`sum(${S.netGrams})`,
    amountPaise: sql<number>`sum(${S.amountPaise})`,
    pricedNet: sql<number>`sum(case when ${S.ratePaisePerQtl} > 0 then ${S.netGrams} else 0 end)`,
    pricedValue: sql<string>`cast(sum(case when ${S.ratePaisePerQtl} > 0 then ${S.netGrams} * ${S.ratePaisePerQtl} else 0 end) as text)`,
  }).from(S).where(and(...where)).groupBy(S.merchantId);

  /* Loaded in the period: rows on trucks whose own date is in it. A row's
     weight does not depend on which rows are asked for (a blank row is worked
     out from its whole truck), and here rows are only added up, so they come
     from the business's rows shared with the other screens. */
  const book = await bookLines(biz);
  const ofJins = (x: (typeof book)[number]) => !f.jinsId || x.jinsId === f.jinsId;
  const lines = book.filter((x) => ofJins(x) && (!f.from || x.loadDate >= f.from) && (!f.to || x.loadDate <= f.to));

  // what was in hand when the period starts: slips before it − trucks loaded before it
  const atStart = new Map<string | null, number>();
  if (f.from) {
    const bw = [eq(S.businessId, biz), lt(S.slipDate, f.from)];
    if (f.jinsId) bw.push(eq(S.jinsId, f.jinsId));
    for (const r of await db.select({ m: S.merchantId, g: sql<number>`sum(${S.netGrams})` }).from(S).where(and(...bw)).groupBy(S.merchantId)) {
      atStart.set(r.m, (atStart.get(r.m) ?? 0) + r.g);
    }
    for (const x of book) if (ofJins(x) && x.loadDate < f.from) atStart.set(x.merchantId, (atStart.get(x.merchantId) ?? 0) - x.weightGrams);
  }

  const mills = await db.select({ id: schema.merchants.id, code: schema.merchants.code, name: schema.merchants.name, nameHi: schema.merchants.nameHi })
    .from(schema.merchants).where(eq(schema.merchants.businessId, biz));
  const keys = new Set<string | null>([...bought.map((b) => b.merchantId), ...lines.map((x) => x.merchantId),
    ...[...atStart].filter(([, g]) => g !== 0).map(([m]) => m)]);
  const linesOf = new Map<string | null, typeof lines>();
  for (const x of lines) { const a = linesOf.get(x.merchantId); if (a) a.push(x); else linesOf.set(x.merchantId, [x]); }
  const out = [...keys].map((mid) => {
    const b = bought.find((x) => x.merchantId === mid);
    const mine = linesOf.get(mid) ?? [];
    const loaded = mine.reduce((s, x) => s + x.weightGrams, 0);
    const opening = atStart.get(mid) ?? 0;
    const m = mills.find((x) => x.id === mid);
    return {
      merchantId: mid, millCode: m?.code ?? null, millName: m?.name ?? null, millNameHi: m?.nameHi ?? null,
      /** In hand when the period starts (0 with no from date). */
      openingNet: opening,
      slips: b?.slips ?? 0,
      boughtNet: b?.netGrams ?? 0,
      boughtAmount: b?.amountPaise ?? 0,
      avgRatePaisePerQtl: b ? avgFromSums(b.pricedValue, b.pricedNet) : 0,
      loadedNet: loaded,
      trucks: new Set(mine.map((x) => x.loadId)).size,
      /** In hand at the period's end: at start + bought − loaded. */
      stockNet: opening + (b?.netGrams ?? 0) - loaded,
    };
  });
  return c.json(out.sort((a, b) => (a.millCode ?? "~").localeCompare(b.millCode ?? "~")));
});

/** One mill's stock, day by day, with the trucks that took from each day. "none" = slips with no mill yet. */
stockRoutes.get("/:merchantId", can("stock.read"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const mid = c.req.param("merchantId") ?? "";
  const f = await stockFilter(c);

  let days: Map<string, { date: string; slips: number; netGrams: number; amountPaise: number; avgRatePaisePerQtl: number; unpriced: number }>;
  if (mid === "none") {
    const S = schema.purchaseSlips;
    const where = [eq(S.businessId, biz), isNull(S.merchantId)];
    if (f.jinsId) where.push(eq(S.jinsId, f.jinsId));
    if (f.from) where.push(gte(S.slipDate, f.from));
    if (f.to) where.push(lte(S.slipDate, f.to));
    const rows = await db.select({
      date: S.slipDate, slips: sql<number>`count(*)`, netGrams: sql<number>`sum(${S.netGrams})`,
      amountPaise: sql<number>`sum(${S.amountPaise})`,
      pricedNet: sql<number>`sum(case when ${S.ratePaisePerQtl} > 0 then ${S.netGrams} else 0 end)`,
      pricedValue: sql<string>`cast(sum(case when ${S.ratePaisePerQtl} > 0 then ${S.netGrams} * ${S.ratePaisePerQtl} else 0 end) as text)`,
      unpriced: sql<number>`sum(case when ${S.ratePaisePerQtl} > 0 then 0 else 1 end)`,
    }).from(S).where(and(...where)).groupBy(S.slipDate);
    days = new Map(rows.map((r) => [r.date, { date: r.date, slips: r.slips, netGrams: r.netGrams, amountPaise: r.amountPaise,
      unpriced: r.unpriced, avgRatePaisePerQtl: avgFromSums(r.pricedValue, r.pricedNet) }]));
  } else {
    const [m] = await db.select({ id: schema.merchants.id }).from(schema.merchants)
      .where(and(eq(schema.merchants.id, mid), eq(schema.merchants.businessId, biz))).limit(1);
    if (!m) throw notFound("Mill not found");
    days = await boughtByDay(biz, mid, f.jinsId, { from: f.from, to: f.to });
  }

  // what trucks loaded up to the period's end took from each of these purchase days
  const L = schema.loadLines;
  const lw = [eq(L.businessId, biz)];
  if (mid !== "none") lw.push(eq(schema.loads.merchantId, mid)); else lw.push(sql`0 = 1`);
  if (f.jinsId) lw.push(eq(L.jinsId, f.jinsId));
  if (f.from) lw.push(gte(L.stockDate, f.from));
  if (f.to) lw.push(lte(L.stockDate, f.to), lte(schema.loads.loadDate, f.to));
  // the whole of each truck when nothing narrows its rows
  const lines = await linesWithWeights(and(...lw), { wholeTrucks: !f.jinsId && !f.from && !f.to });
  const loadIds = [...new Set(lines.map((x) => x.loadId))];
  const parchas = loadIds.length ? await db.select({
    loadId: schema.parchas.loadId, parchaNo: schema.parchas.parchaNo, grandTotalPaise: schema.parchas.grandTotalPaise,
  }).from(schema.parchas).where(and(inArray(schema.parchas.loadId, loadIds), eq(schema.parchas.status, "approved"))) : [];
  const parchaOf = new Map(parchas.map((p) => [p.loadId, p]));

  const dates = [...new Set([...days.keys(), ...lines.map((x) => x.stockDate)])].sort().reverse();
  // each purchase day's truck rows, in their order
  const takenOn = new Map<string, typeof lines>();
  for (const x of lines) { const a = takenOn.get(x.stockDate); if (a) a.push(x); else takenOn.set(x.stockDate, [x]); }
  const dayList = dates.map((d) => {
    const b = days.get(d);
    const taken = takenOn.get(d) ?? [];
    const trucks = new Map<string, { loadId: string; truckNo: string | null; loadDate: string; status: string; parchaNo: string | null; grams: number }>();
    for (const x of taken) {
      const t = trucks.get(x.loadId) ?? { loadId: x.loadId, truckNo: x.truckNo, loadDate: x.loadDate, status: x.status,
        parchaNo: parchaOf.get(x.loadId)?.parchaNo ?? null, grams: 0 };
      t.grams += x.weightGrams;
      trucks.set(x.loadId, t);
    }
    const loaded = taken.reduce((s, x) => s + x.weightGrams, 0);
    return {
      date: d, slips: b?.slips ?? 0, boughtNet: b?.netGrams ?? 0, boughtAmount: b?.amountPaise ?? 0,
      avgRatePaisePerQtl: b?.avgRatePaisePerQtl ?? 0, unpriced: b?.unpriced ?? 0,
      loadedNet: loaded, stockNet: (b?.netGrams ?? 0) - loaded, trucks: [...trucks.values()],
    };
  });

  /* Stock in hand at the period's end — the same figure as the list and the
     dashboard: every slip up to `to` − every truck row on a truck loaded up
     to `to`. The running column climbs day by day to exactly that: it starts
     from whatever the days in the table do not hold (purchases before them,
     less what trucks took from those). */
  const S = schema.purchaseSlips;
  const cw = [eq(S.businessId, biz), mid === "none" ? isNull(S.merchantId) : eq(S.merchantId, mid)];
  if (f.jinsId) cw.push(eq(S.jinsId, f.jinsId));
  if (f.to) cw.push(lte(S.slipDate, f.to));
  const [allIn] = await db.select({ g: sql<number>`coalesce(sum(${S.netGrams}), 0)` }).from(S).where(and(...cw));
  let allOut = 0;
  if (mid !== "none") {
    // only added up: the business's rows when they are in hand (each row's weight is the same)
    const mine = (x: { merchantId: string; jinsId: string; loadDate: string }) => x.merchantId === mid && (!f.jinsId || x.jinsId === f.jinsId) && (!f.to || x.loadDate <= f.to);
    if (bookLinesInHand(biz)) {
      allOut = (await bookLines(biz)).reduce((x, r) => x + (mine(r) ? r.weightGrams : 0), 0);
    } else {
      const ow = [eq(schema.loadLines.businessId, biz), eq(schema.loads.merchantId, mid)];
      if (f.jinsId) ow.push(eq(schema.loadLines.jinsId, f.jinsId));
      if (f.to) ow.push(lte(schema.loads.loadDate, f.to));
      allOut = (await linesWithWeights(and(...ow))).reduce((x, r) => x + r.weightGrams, 0);
    }
  }
  const closingNet = (allIn?.g ?? 0) - allOut;
  const daysLeft = dayList.reduce((s, d) => s + d.stockNet, 0);
  let run = closingNet - daysLeft;
  const openingNet = run;
  for (const d of [...dayList].reverse()) { run += d.stockNet; (d as typeof d & { runningNet: number }).runningNet = run; }

  const totals = {
    slips: dayList.reduce((s, d) => s + d.slips, 0),
    boughtNet: dayList.reduce((s, d) => s + d.boughtNet, 0),
    loadedNet: dayList.reduce((s, d) => s + d.loadedNet, 0),
    /** Left of these days' purchases. */
    stockNet: daysLeft,
    /** Before the first day in the table. */
    openingNet,
    /** In hand at the period's end: the list's and the dashboard's "left". */
    closingNet,
  };
  return c.json({ days: dayList, totals });
});
