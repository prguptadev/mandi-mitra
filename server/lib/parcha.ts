import { eq, and, ne, asc, desc, sql, inArray } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { ChargeConfigSchema, computeParcha, type ChargeConfig, type ParchaResult } from "./charges.ts";
import { weightedAvgRate } from "./money.ts";

/* Everything about one load, worked out in one place: its slips and their
   totals, the mill's weighment, what blocks approval, what only deserves a
   look, and the kaccha parcha itself. The load screen, the print, the Excel
   file and the approval all read from here, so they cannot disagree. */

/** A reason the parcha cannot be approved yet. */
export type Blocker =
  | { code: "no_slips" }
  | { code: "no_rate" }
  | { code: "no_mill_gross" }
  | { code: "no_bags" }
  | { code: "net_nonpositive" }
  | { code: "no_invoice_no" }
  | { code: "invoice_taken"; loadId: string; truckNo: string | null };

/** Worth a look; never stops anything. */
export type Warning =
  | { code: "rate_pending"; n: number }
  | { code: "weight_diff"; grams: number; pct: number }
  | { code: "po_over"; overGrams: number }
  | { code: "po_closed" }
  | { code: "po_expired"; validTill: string }
  | { code: "bore_no_labour" }
  | { code: "mixed_jins"; n: number };

export interface ParchaDocLine {
  po: string;
  jinsCode: string;
  date: string;
  netGrams: number;
  ratePaisePerQtl: number;
  amountPaise: number;
}

/** Everything printed on the parcha, frozen into the snapshot on approval. */
export interface ParchaDoc {
  title: string;
  titleHi: string;
  business: { name: string; nameHi: string | null; city: string | null; state: string | null; gstin: string | null };
  mill: { code: string; name: string; nameHi: string | null; city: string | null; state: string | null; gstin: string | null };
  invoiceNo: string | null;
  invoiceDate: string;
  version: number;
  truckNo: string | null;
  loadDate: string;
  ewayBillNo: string | null;
  weights: {
    grossGrams: number; bardanaGrams: number; netGrams: number;
    katte: number; bore: number; katteBardanaGrams: number; boreBardanaGrams: number;
  };
  lines: ParchaDocLine[];
  totals: { netGrams: number; ratePaisePerQtl: number; goodsPaise: number };
  result: ParchaResult;
  config: ChargeConfig;
  slips: {
    count: number; netGrams: number; grossGrams: number; amountPaise: number;
    list: { id: string; rstNo: string; slipDate: string; adati: string; netGrams: number; ratePaisePerQtl: number }[];
  };
}

export type LoadRow = typeof schema.loads.$inferSelect;

/** Quintals the load counts against its PO: the mill's net once weighed, else ours. */
export const loadQtyGrams = (l: { millNetGrams: number | null }, slipsNetGrams: number) =>
  l.millNetGrams ?? slipsNetGrams;

/** Invoice numbers are numeric on paper (196); suggest the next one. */
export async function suggestInvoiceNo(businessId: string, exceptLoadId?: string): Promise<string | null> {
  const fromParchas = await db.select({ n: schema.parchas.parchaNo }).from(schema.parchas)
    .where(eq(schema.parchas.businessId, businessId));
  const fromLoads = await db.select({ n: schema.loads.invoiceNo }).from(schema.loads)
    .where(and(
      eq(schema.loads.businessId, businessId),
      exceptLoadId ? ne(schema.loads.id, exceptLoadId) : sql`1 = 1`,
    ));
  const nums = [...fromParchas, ...fromLoads]
    .map((r) => Number(r.n)).filter((n) => Number.isInteger(n) && n > 0);
  return nums.length ? String(Math.max(...nums) + 1) : null;
}

/** Bardana: typed weight if the operator gave one, else bags x kg per bag. */
function weighment(l: LoadRow, cfg: ChargeConfig) {
  const katte = l.katteCount ?? (l.boreCount == null ? (l.bags ?? 0) : 0);
  const bore = l.boreCount ?? 0;
  const katteBardanaGrams = l.katteBardanaGrams ?? Math.round(katte * cfg.millBardanaKgPerBag * 1000);
  const boreBardanaGrams = l.boreBardanaGrams ?? Math.round(bore * cfg.millBoreBardanaKgPerBag * 1000);
  const bardanaGrams = katteBardanaGrams + boreBardanaGrams;
  const grossGrams = l.millGrossGrams;
  const netGrams = grossGrams == null ? null : grossGrams - bardanaGrams;
  return { katte, bore, bags: katte + bore, katteBardanaGrams, boreBardanaGrams, bardanaGrams, grossGrams, netGrams };
}

/** Recompute the stored mill figures from gross, bags and the mill's terms. */
export function storedWeighment(l: LoadRow, cfg: ChargeConfig) {
  const w = weighment(l, cfg);
  return { bags: w.bags, millBardanaGrams: w.bardanaGrams, millNetGrams: w.netGrams };
}

export async function loadState(businessId: string, loadId: string) {
  const [l] = await db.select().from(schema.loads)
    .where(and(eq(schema.loads.id, loadId), eq(schema.loads.businessId, businessId))).limit(1);
  if (!l) return null;

  const [biz] = await db.select().from(schema.businesses).where(eq(schema.businesses.id, businessId)).limit(1);
  const [mill] = await db.select().from(schema.merchants).where(eq(schema.merchants.id, l.merchantId)).limit(1);
  const [jins] = await db.select().from(schema.jins).where(eq(schema.jins.id, l.jinsId)).limit(1);
  const cfg = ChargeConfigSchema.parse(JSON.parse(mill.chargeConfig));

  const slips = await db.select({
    id: schema.purchaseSlips.id,
    slipDate: schema.purchaseSlips.slipDate,
    rstNo: schema.purchaseSlips.rstNo,
    adatiId: schema.purchaseSlips.adatiId,
    adatiNameHi: schema.adati.nameHi,
    adatiNameHinglish: schema.adati.nameHinglish,
    jinsId: schema.purchaseSlips.jinsId,
    jinsCode: schema.jins.code,
    grossGrams: schema.purchaseSlips.grossGrams,
    katautiUnits: schema.purchaseSlips.katautiUnits,
    netGrams: schema.purchaseSlips.netGrams,
    ratePaisePerQtl: schema.purchaseSlips.ratePaisePerQtl,
    amountPaise: schema.purchaseSlips.amountPaise,
  })
    .from(schema.purchaseSlips)
    .innerJoin(schema.adati, eq(schema.adati.id, schema.purchaseSlips.adatiId))
    .innerJoin(schema.jins, eq(schema.jins.id, schema.purchaseSlips.jinsId))
    .where(eq(schema.purchaseSlips.loadId, l.id))
    .orderBy(asc(schema.purchaseSlips.slipDate), asc(schema.purchaseSlips.createdAt));

  const priced = slips.filter((s) => s.ratePaisePerQtl > 0);
  const slipTotals = {
    count: slips.length,
    grossGrams: slips.reduce((s, r) => s + r.grossGrams, 0),
    katautiUnits: slips.reduce((s, r) => s + r.katautiUnits, 0),
    netGrams: slips.reduce((s, r) => s + r.netGrams, 0),
    amountPaise: slips.reduce((s, r) => s + r.amountPaise, 0),
    pricedCount: priced.length,
    /** Σ(net x rate) / Σ net over priced slips — the parcha rate. */
    avgRatePaisePerQtl: weightedAvgRate(priced),
  };

  const w = weighment(l, cfg);

  // the PO, and how much of it the other loads have already taken
  let po: null | {
    id: string; poNo: string; qtyGrams: number; status: string; validTill: string | null;
    otherLoadsGrams: number; thisLoadGrams: number; balanceGrams: number;
  } = null;
  if (l.poId) {
    const [p] = await db.select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, l.poId)).limit(1);
    if (p) {
      const others = await db.select({ id: schema.loads.id, millNetGrams: schema.loads.millNetGrams })
        .from(schema.loads).where(and(eq(schema.loads.poId, p.id), ne(schema.loads.id, l.id)));
      let otherGrams = 0;
      for (const o of others) {
        if (o.millNetGrams != null) { otherGrams += o.millNetGrams; continue; }
        const [s] = await db.select({ g: sql<number>`coalesce(sum(${schema.purchaseSlips.netGrams}), 0)` })
          .from(schema.purchaseSlips).where(eq(schema.purchaseSlips.loadId, o.id));
        otherGrams += s?.g ?? 0;
      }
      const thisGrams = w.netGrams ?? slipTotals.netGrams;
      po = {
        id: p.id, poNo: p.poNo, qtyGrams: p.qtyGrams, status: p.status, validTill: p.validTill,
        otherLoadsGrams: otherGrams, thisLoadGrams: thisGrams,
        balanceGrams: p.qtyGrams - otherGrams - thisGrams,
      };
    }
  }

  const history = await db.select().from(schema.parchas)
    .where(eq(schema.parchas.loadId, l.id)).orderBy(desc(schema.parchas.version));
  const approved = history.find((p) => p.status === "approved") ?? null;

  /* ------------------------------------------------------------ checks */
  const blockers: Blocker[] = [];
  const warnings: Warning[] = [];
  if (!slips.length) blockers.push({ code: "no_slips" });
  else if (!priced.length) blockers.push({ code: "no_rate" });
  if (w.grossGrams == null || w.grossGrams <= 0) blockers.push({ code: "no_mill_gross" });
  if (w.bags <= 0) blockers.push({ code: "no_bags" });
  if (w.netGrams != null && w.netGrams <= 0) blockers.push({ code: "net_nonpositive" });
  if (!l.invoiceNo?.trim()) blockers.push({ code: "no_invoice_no" });
  else if (!approved) {
    // the same number on another load's live parcha
    const [taken] = await db.select({ loadId: schema.parchas.loadId, truckNo: schema.loads.truckNo })
      .from(schema.parchas)
      .innerJoin(schema.loads, eq(schema.loads.id, schema.parchas.loadId))
      .where(and(
        eq(schema.parchas.businessId, businessId),
        eq(schema.parchas.parchaNo, l.invoiceNo.trim()),
        eq(schema.parchas.status, "approved"),
        ne(schema.parchas.loadId, l.id),
      )).limit(1);
    if (taken) blockers.push({ code: "invoice_taken", loadId: taken.loadId, truckNo: taken.truckNo });
  }

  if (slips.length && priced.length < slips.length) warnings.push({ code: "rate_pending", n: slips.length - priced.length });
  if (w.netGrams != null && slipTotals.netGrams > 0) {
    const diff = slipTotals.netGrams - w.netGrams;
    const pct = (diff / slipTotals.netGrams) * 100;
    if (Math.abs(pct) >= 2) warnings.push({ code: "weight_diff", grams: diff, pct: Math.round(pct * 10) / 10 });
  }
  if (po) {
    if (po.balanceGrams < 0) warnings.push({ code: "po_over", overGrams: -po.balanceGrams });
    if (po.status === "closed") warnings.push({ code: "po_closed" });
    if (po.validTill && po.validTill < l.loadDate) warnings.push({ code: "po_expired", validTill: po.validTill });
  }
  const labourOnBore = [cfg.labour1, cfg.labour2].some((x) => x.enabled && x.appliesTo !== "katte");
  if (w.bore > 0 && !labourOnBore) warnings.push({ code: "bore_no_labour" });
  const otherJins = slips.filter((s) => s.jinsId !== l.jinsId).length;
  if (otherJins) warnings.push({ code: "mixed_jins", n: otherJins });

  /* ------------------------------------------------------------ parcha */
  let doc: ParchaDoc | null = null;
  if (w.grossGrams != null && w.netGrams != null && w.netGrams > 0 && priced.length) {
    const rate = slipTotals.avgRatePaisePerQtl;
    const result = computeParcha(cfg, {
      grossGrams: w.grossGrams,
      katte: w.katte, bore: w.bore,
      katteBardanaGrams: w.katteBardanaGrams, boreBardanaGrams: w.boreBardanaGrams,
      netGrams: w.netGrams,
      ratePaisePerQtl: rate,
      trucks: 1,
      advancePaise: l.advancePaise,
      manualDaraPaise: l.daraPaise,
    });
    const dates = [...new Set(slips.map((s) => s.slipDate))];
    doc = {
      title: cfg.parcha.title, titleHi: cfg.parcha.titleHi,
      business: {
        name: biz.name, nameHi: biz.nameHi, city: biz.city ?? biz.district, state: biz.state, gstin: biz.gstin,
      },
      mill: { code: mill.code, name: mill.name, nameHi: mill.nameHi, city: mill.city, state: mill.state, gstin: mill.gstin },
      invoiceNo: l.invoiceNo?.trim() || null,
      invoiceDate: l.invoiceDate ?? l.loadDate,
      version: (history[0]?.version ?? 0) + (approved ? 0 : 1),
      truckNo: l.truckNo, loadDate: l.loadDate, ewayBillNo: l.ewayBillNo,
      weights: {
        grossGrams: w.grossGrams, bardanaGrams: w.bardanaGrams, netGrams: w.netGrams,
        katte: w.katte, bore: w.bore, katteBardanaGrams: w.katteBardanaGrams, boreBardanaGrams: w.boreBardanaGrams,
      },
      lines: [{
        po: po?.poNo ?? "1",
        jinsCode: jins.code,
        date: dates.length === 1 ? dates[0] : l.loadDate,
        netGrams: w.netGrams,
        ratePaisePerQtl: rate,
        amountPaise: result.goodsAmountPaise,
      }],
      totals: { netGrams: w.netGrams, ratePaisePerQtl: rate, goodsPaise: result.goodsAmountPaise },
      result,
      config: cfg,
      slips: {
        count: slips.length, netGrams: slipTotals.netGrams, grossGrams: slipTotals.grossGrams,
        amountPaise: slipTotals.amountPaise,
        list: slips.map((s) => ({
          id: s.id, rstNo: s.rstNo, slipDate: s.slipDate, adati: s.adatiNameHi,
          netGrams: s.netGrams, ratePaisePerQtl: s.ratePaisePerQtl,
        })),
      },
    };
  }

  return {
    load: l,
    mill: { id: mill.id, code: mill.code, name: mill.name, nameHi: mill.nameHi },
    jins: { id: jins.id, code: jins.code, name: jins.name, nameHi: jins.nameHi },
    config: cfg,
    slips,
    slipTotals,
    weighment: w,
    po,
    blockers,
    warnings,
    doc,
    approved: approved ? { ...approved, snapshot: undefined, doc: JSON.parse(approved.snapshot) as ParchaDoc } : null,
    history: history.map((p) => ({ ...p, snapshot: undefined })),
    suggestedInvoiceNo: l.invoiceNo ? null : await suggestInvoiceNo(businessId, l.id),
  };
}

export type LoadState = NonNullable<Awaited<ReturnType<typeof loadState>>>;

/** Slip ids that belong to the business and are free, for allocation. */
export async function freeSlips(businessId: string, ids: string[]) {
  if (!ids.length) return [];
  return db.select().from(schema.purchaseSlips).where(and(
    eq(schema.purchaseSlips.businessId, businessId),
    inArray(schema.purchaseSlips.id, ids),
  ));
}
