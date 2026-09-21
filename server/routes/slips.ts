import { Hono } from "hono";
import { z } from "zod";
import { eq, and, asc, desc, sql, inArray, gte, lte } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { newId, nowSec } from "../lib/ids.ts";
import { audit, enqueueSync } from "../lib/audit.ts";
import { ChargeConfigSchema, KatautiSchema, deriveKatauti, type Katauti } from "../lib/charges.ts";
import { amountPaise, weightedAvgRate, GRAMS_PER_QTL } from "../lib/money.ts";
import { DisplayConfigSchema, defaultDisplayConfig } from "../lib/display.ts";
import { can, actor, param, notFound, bad, HttpError, isoDay, LIMIT, type Env } from "../lib/http.ts";
import { approvedOnDays } from "../lib/parcha.ts";

/** Supplier, commodity and mill must all be this business's own. */
export async function checkSlipRefs(biz: string, r: { adatiId?: string; jinsId?: string; merchantId?: string | null }) {
  if (r.adatiId) {
    const [a] = await db.select({ id: schema.adati.id }).from(schema.adati).where(and(eq(schema.adati.id, r.adatiId), eq(schema.adati.businessId, biz))).limit(1);
    if (!a) throw bad("That supplier does not belong to this business", "bad_adati");
  }
  if (r.jinsId) {
    const [j] = await db.select({ id: schema.jins.id }).from(schema.jins).where(and(eq(schema.jins.id, r.jinsId), eq(schema.jins.businessId, biz))).limit(1);
    if (!j) throw bad("That commodity does not belong to this business", "bad_jins");
  }
  if (r.merchantId) {
    const [m] = await db.select({ id: schema.merchants.id }).from(schema.merchants).where(and(eq(schema.merchants.id, r.merchantId), eq(schema.merchants.businessId, biz))).limit(1);
    if (!m) throw bad("That mill does not belong to this business", "bad_merchant");
  }
}

export const slipRoutes = new Hono<Env>();

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const SlipBody = z.object({
  slipDate: isoDay(),
  rstNo: z.string().trim().min(1, "RST no is required").max(20),
  adatiId: z.string().min(1, "Pick a supplier"),
  jinsId: z.string().min(1, "Pick a commodity"),
  merchantId: z.string().nullish(),
  /** Dharam kanta, in grams. */
  grossGrams: z.number().int().min(1, "Gross weight is required").max(LIMIT.grams, "Gross weight is too large — check the decimal point"),
  /** Only when the sheet's KATAUTI differs from gross rounded to a quintal. */
  katautiUnits: z.number().int().min(0).max(10_000).nullish(),
  /** Physical bags, when known. Not the same number as katauti. */
  bagsCount: z.number().int().min(0).max(LIMIT.count).nullish(),
  ratePaisePerQtl: z.number().int().min(0).max(LIMIT.rate, "Rate is too large — check the decimal point"),
  /** When the sheet's own net disagrees with the formula, we want to know. */
  netGramsClaimed: z.number().int().min(0).max(LIMIT.grams).nullish(),
});

/** Katauti terms come from the mill on the sheet header, else the business default. */
export async function katautiCfg(businessId: string, merchantId?: string | null): Promise<Katauti> {
  if (merchantId) {
    const [m] = await db.select({ cfg: schema.merchants.chargeConfig }).from(schema.merchants)
      .where(and(eq(schema.merchants.id, merchantId), eq(schema.merchants.businessId, businessId))).limit(1);
    if (m) {
      const parsed = ChargeConfigSchema.safeParse(JSON.parse(m.cfg));
      if (parsed.success) return parsed.data.katauti;
    }
  }
  const [row] = await db.select().from(schema.settings)
    .where(and(eq(schema.settings.businessId, businessId), eq(schema.settings.key, "display"))).limit(1);
  if (row?.value) {
    const parsed = DisplayConfigSchema.safeParse(JSON.parse(row.value));
    if (parsed.success) {
      return KatautiSchema.parse({ mode: parsed.data.katautiMode, kgPerUnit: parsed.data.katautiKgPerUnit, rounding: parsed.data.katautiRounding });
    }
  }
  const d = defaultDisplayConfig();
  return KatautiSchema.parse({ mode: d.katautiMode, kgPerUnit: d.katautiKgPerUnit, rounding: d.katautiRounding });
}

/** The terms a slip was worked out with; slips from before v0.3 without them use `fallback`. */
export function termsOf(slip: { katautiTerms: string | null }, fallback: Katauti): Katauti {
  if (!slip.katautiTerms) return fallback;
  try {
    const p = KatautiSchema.safeParse(JSON.parse(slip.katautiTerms));
    return p.success ? p.data : fallback;
  } catch { return fallback; }
}

/**
 * The one formula the whole daily list rests on.
 * katauti units = gross rounded to the nearest quintal (unless overridden),
 * deduction = units x 1 kg, net = gross - deduction, amount = net x rate.
 */
export function deriveSlip(
  grossGrams: number,
  cfg: Katauti,
  ratePaisePerQtl: number,
  katautiOverride?: number | null,
) {
  const k = deriveKatauti(grossGrams, cfg, katautiOverride);
  const netGrams = grossGrams - k.deductionGrams;
  return {
    katautiUnits: k.units,
    katautiGrams: k.deductionGrams,
    netGrams,
    amountPaise: amountPaise(netGrams, ratePaisePerQtl),
  };
}

/* -------------------------------------------------------------------- read */

/** One day's sheet, with running totals and per-row checks. */
slipRoutes.get("/", can("slip.read"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const date = c.req.query("date");
  const from = c.req.query("from");
  const to = c.req.query("to");
  const merchantId = c.req.query("merchantId");
  const jinsId = c.req.query("jinsId");
  const adatiId = c.req.query("adatiId");

  const where = [eq(schema.purchaseSlips.businessId, biz)];
  if (date) {
    if (!ISO_DATE.test(date)) throw bad("Date must be YYYY-MM-DD");
    where.push(eq(schema.purchaseSlips.slipDate, date));
  }
  // a range, for downloads that span several days
  if (from || to) {
    if ((from && !ISO_DATE.test(from)) || (to && !ISO_DATE.test(to))) throw bad("Date must be YYYY-MM-DD");
    if (from && to && from > to) throw bad("The from date is after the to date", "bad_range");
    if (from) where.push(gte(schema.purchaseSlips.slipDate, from));
    if (to) where.push(lte(schema.purchaseSlips.slipDate, to));
  }
  if (merchantId) where.push(eq(schema.purchaseSlips.merchantId, merchantId));
  if (jinsId) where.push(eq(schema.purchaseSlips.jinsId, jinsId));
  if (adatiId) where.push(eq(schema.purchaseSlips.adatiId, adatiId));

  const rows = await db.select({
    id: schema.purchaseSlips.id,
    slipDate: schema.purchaseSlips.slipDate,
    rstNo: schema.purchaseSlips.rstNo,
    adatiId: schema.purchaseSlips.adatiId,
    adatiNameHi: schema.adati.nameHi,
    adatiNameHinglish: schema.adati.nameHinglish,
    adatiVillage: schema.adati.village,
    jinsId: schema.purchaseSlips.jinsId,
    jinsCode: schema.jins.code,
    jinsName: schema.jins.name,
    jinsNameHi: schema.jins.nameHi,
    merchantId: schema.purchaseSlips.merchantId,
    merchantCode: schema.merchants.code,
    merchantName: schema.merchants.name,
    grossGrams: schema.purchaseSlips.grossGrams,
    katautiUnits: schema.purchaseSlips.katautiUnits,
    katautiOverride: schema.purchaseSlips.katautiOverride,
    katautiTerms: schema.purchaseSlips.katautiTerms,
    bagsCount: schema.purchaseSlips.bagsCount,
    netGrams: schema.purchaseSlips.netGrams,
    ratePaisePerQtl: schema.purchaseSlips.ratePaisePerQtl,
    amountPaise: schema.purchaseSlips.amountPaise,
    status: schema.purchaseSlips.status,
    ocrConfidence: schema.purchaseSlips.ocrConfidence,
    scanBatchId: schema.purchaseSlips.scanBatchId,
    scanStatus: schema.scanBatches.status,
    scanPages: schema.scanBatches.filePaths,
    createdAt: schema.purchaseSlips.createdAt,
    updatedAt: schema.purchaseSlips.updatedAt,
  })
    .from(schema.purchaseSlips)
    .innerJoin(schema.adati, eq(schema.adati.id, schema.purchaseSlips.adatiId))
    .innerJoin(schema.jins, eq(schema.jins.id, schema.purchaseSlips.jinsId))
    .leftJoin(schema.merchants, eq(schema.merchants.id, schema.purchaseSlips.merchantId))
    .leftJoin(schema.scanBatches, eq(schema.scanBatches.id, schema.purchaseSlips.scanBatchId))
    .where(and(...where))
    .orderBy(asc(schema.purchaseSlips.slipDate), asc(schema.purchaseSlips.createdAt));

  // recompute every row server-side and report any that no longer reconcile
  const cfgCache = new Map<string, Katauti>();
  const checked = [];
  for (const r of rows) {
    const cacheKey = r.merchantId ?? "-";
    if (!cfgCache.has(cacheKey)) cfgCache.set(cacheKey, await katautiCfg(biz, r.merchantId));
    const cfg = termsOf(r, cfgCache.get(cacheKey)!);
    const d = deriveSlip(r.grossGrams, cfg, r.ratePaisePerQtl, r.katautiOverride ? r.katautiUnits : null);
    const suggested = deriveSlip(r.grossGrams, cfg, r.ratePaisePerQtl, null);
    // kg per physical bag, only when a bag count was actually recorded
    const avgBagKg = r.bagsCount && r.bagsCount > 0 ? (r.netGrams / 1000) / r.bagsCount : null;
    checked.push({
      ...r,
      scanPages: r.scanPages ? (JSON.parse(r.scanPages) as unknown[]).length : 0,
      katautiGrams: d.katautiGrams,
      katautiCfg: cfg,
      suggestedKatautiUnits: suggested.katautiUnits,
      expectedNetGrams: d.netGrams,
      expectedAmountPaise: d.amountPaise,
      netMismatchGrams: r.netGrams - d.netGrams,
      amountMismatchPaise: r.amountPaise - d.amountPaise,
      reconciles: r.netGrams === d.netGrams && r.amountPaise === d.amountPaise,
      /** Weight entered, rate still to be agreed. Excluded from the average. */
      ratePending: r.ratePaisePerQtl === 0,
      avgBagKg,
      bagWarning: avgBagKg !== null && (avgBagKg < 15 || avgBagKg > 80),
    });
  }

  // A slip with no rate yet would pull the weighted average down and that
  // average becomes the rate on the kaccha parcha. Price only what is priced.
  const priced = checked.filter((r) => !r.ratePending);
  const totals = {
    rows: checked.length,
    grossGrams: checked.reduce((s, r) => s + r.grossGrams, 0),
    katautiUnits: checked.reduce((s, r) => s + r.katautiUnits, 0),
    bagsCount: checked.reduce((s, r) => s + (r.bagsCount ?? 0), 0),
    katautiGrams: checked.reduce((s, r) => s + r.katautiGrams, 0),
    netGrams: checked.reduce((s, r) => s + r.netGrams, 0),
    amountPaise: checked.reduce((s, r) => s + r.amountPaise, 0),
    /** Over priced rows only. */
    weightedAvgRatePaise: weightedAvgRate(priced),
    pricedNetGrams: priced.reduce((s, r) => s + r.netGrams, 0),
    mismatchRows: checked.filter((r) => !r.reconciles).length,
    ratePendingRows: checked.length - priced.length,
    bagWarningRows: checked.filter((r) => r.bagWarning).length,
  };

  return c.json({ rows: checked, totals });
});

/** Dates that have slips, for the date navigator. */
slipRoutes.get("/days", can("slip.read"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const rows = await db.select({
    slipDate: schema.purchaseSlips.slipDate,
    n: sql<number>`count(*)`.as("n"),
    netGrams: sql<number>`sum(${schema.purchaseSlips.netGrams})`.as("netGrams"),
    amountPaise: sql<number>`sum(${schema.purchaseSlips.amountPaise})`.as("amountPaise"),
  })
    .from(schema.purchaseSlips)
    .where(eq(schema.purchaseSlips.businessId, biz))
    .groupBy(schema.purchaseSlips.slipDate)
    .orderBy(desc(schema.purchaseSlips.slipDate))
    .limit(60);
  return c.json(rows);
});

/** Suggests the rate this supplier last got for this commodity. */
slipRoutes.get("/last-rate", can("slip.read"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const adatiId = c.req.query("adatiId");
  const jinsId = c.req.query("jinsId");
  if (!adatiId || !jinsId) return c.json({ ratePaisePerQtl: null, slipDate: null });
  const [row] = await db.select({
    ratePaisePerQtl: schema.purchaseSlips.ratePaisePerQtl,
    slipDate: schema.purchaseSlips.slipDate,
  })
    .from(schema.purchaseSlips)
    .where(and(
      eq(schema.purchaseSlips.businessId, biz),
      eq(schema.purchaseSlips.adatiId, adatiId),
      eq(schema.purchaseSlips.jinsId, jinsId),
    ))
    .orderBy(desc(schema.purchaseSlips.slipDate), desc(schema.purchaseSlips.createdAt))
    .limit(1);
  return c.json(row ?? { ratePaisePerQtl: null, slipDate: null });
});

/** Next free RST no for the day — a nudge, never enforced. */
slipRoutes.get("/next-rst", can("slip.read"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const date = c.req.query("date");
  if (!date || !ISO_DATE.test(date)) return c.json({ rstNo: null });
  const rows = await db.select({ rstNo: schema.purchaseSlips.rstNo })
    .from(schema.purchaseSlips)
    .where(and(eq(schema.purchaseSlips.businessId, biz), eq(schema.purchaseSlips.slipDate, date)));
  const nums = rows.map((r) => Number(r.rstNo)).filter((n) => Number.isFinite(n));
  return c.json({ rstNo: nums.length ? String(Math.max(...nums) + 1) : null });
});

/* ------------------------------------------------------------------- write */

/** Rate changes are guarded separately — that permission is the money one. */
function assertRateAllowed(c: Parameters<typeof actor>[0], changing: boolean) {
  if (!changing) return;
  const auth = c.get("auth")!;
  if (!auth.permissions.has("rate.edit")) {
    throw new HttpError(403, "You cannot set or change the purchase rate", "forbidden");
  }
}

slipRoutes.post("/", can("slip.write"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const body = SlipBody.parse(await c.req.json());
  assertRateAllowed(c, body.ratePaisePerQtl > 0);

  const [dupe] = await db.select({ id: schema.purchaseSlips.id, rst: schema.purchaseSlips.rstNo })
    .from(schema.purchaseSlips)
    .where(and(
      eq(schema.purchaseSlips.businessId, biz),
      eq(schema.purchaseSlips.slipDate, body.slipDate),
      eq(schema.purchaseSlips.rstNo, body.rstNo),
    )).limit(1);
  const rstRepeated = Boolean(dupe);

  const [ad] = await db.select({ id: schema.adati.id, name: schema.adati.nameHinglish }).from(schema.adati)
    .where(and(eq(schema.adati.id, body.adatiId), eq(schema.adati.businessId, biz))).limit(1);
  if (!ad) throw bad("That supplier does not belong to this business", "bad_adati");
  const [jn] = await db.select({ id: schema.jins.id }).from(schema.jins)
    .where(and(eq(schema.jins.id, body.jinsId), eq(schema.jins.businessId, biz))).limit(1);
  if (!jn) throw bad("That commodity does not belong to this business", "bad_jins");
  await checkSlipRefs(biz, { merchantId: body.merchantId });

  const cfg = await katautiCfg(biz, body.merchantId);
  const d = deriveSlip(body.grossGrams, cfg, body.ratePaisePerQtl, body.katautiUnits ?? null);
  if (d.netGrams <= 0) throw bad("Net weight works out to zero or less — check the gross weight", "bad_net");

  const id = newId();
  const values = {
    id, businessId: biz, katautiTerms: JSON.stringify(cfg),
    slipDate: body.slipDate, rstNo: body.rstNo,
    adatiId: body.adatiId, jinsId: body.jinsId,
    merchantId: body.merchantId ?? null,
    grossGrams: body.grossGrams,
    katautiUnits: d.katautiUnits,
    katautiOverride: body.katautiUnits != null,
    bagsCount: body.bagsCount ?? null,
    netGrams: d.netGrams,
    ratePaisePerQtl: body.ratePaisePerQtl,
    amountPaise: d.amountPaise,
    enteredBy: c.get("auth")!.user.id,
  };
  await db.insert(schema.purchaseSlips).values(values);
  await audit({
    actor: actor(c), action: "slip.create", entity: "purchase_slip", entityId: id,
    entityLabel: `${body.slipDate} RST ${body.rstNo} — ${ad.name}`, after: values,
  });
  await enqueueSync(biz, "purchase_slip", id, "insert", values);

  const claimed = body.netGramsClaimed;
  return c.json({
    /** Approved parchas on this day: their frozen figures no longer match it. */
    approvedParchas: await approvedOnDays(biz, [{ merchantId: body.merchantId ?? null, jinsId: body.jinsId, date: body.slipDate }]),
    id,
    netGrams: d.netGrams,
    amountPaise: d.amountPaise,
    katautiUnits: d.katautiUnits,
    katautiGrams: d.katautiGrams,
    /** Set when the sheet's own net differs from the formula. */
    rstRepeated,
    netWarning: claimed != null && claimed !== d.netGrams
      ? { claimedGrams: claimed, computedGrams: d.netGrams, diffGrams: claimed - d.netGrams }
      : null,
  });
});

slipRoutes.put("/:id", can("slip.write"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const id = param(c, "id");
  const body = SlipBody.partial().parse(await c.req.json());

  const [before] = await db.select().from(schema.purchaseSlips)
    .where(and(eq(schema.purchaseSlips.id, id), eq(schema.purchaseSlips.businessId, biz))).limit(1);
  if (!before) throw notFound("Slip not found");
  assertRateAllowed(c, body.ratePaisePerQtl !== undefined && body.ratePaisePerQtl !== before.ratePaisePerQtl);
  await checkSlipRefs(biz, { adatiId: body.adatiId, jinsId: body.jinsId, merchantId: body.merchantId });

  const merged = {
    slipDate: body.slipDate ?? before.slipDate,
    rstNo: body.rstNo ?? before.rstNo,
    adatiId: body.adatiId ?? before.adatiId,
    jinsId: body.jinsId ?? before.jinsId,
    merchantId: body.merchantId === undefined ? before.merchantId : (body.merchantId ?? null),
    grossGrams: body.grossGrams ?? before.grossGrams,
    bagsCount: body.bagsCount === undefined ? before.bagsCount : (body.bagsCount ?? null),
    ratePaisePerQtl: body.ratePaisePerQtl ?? before.ratePaisePerQtl,
  };
  const override = body.katautiUnits !== undefined
    ? body.katautiUnits
    : (before.katautiOverride ? before.katautiUnits : null);
  // a new weight or another mill takes today's terms; any other edit (RST, rate,
  // supplier…) keeps the terms the slip was made with, so its net never moves
  const reweighed = merged.grossGrams !== before.grossGrams || merged.merchantId !== before.merchantId;
  const current = await katautiCfg(biz, merged.merchantId);
  const cfg = reweighed ? current : termsOf(before, current);
  const d = deriveSlip(merged.grossGrams, cfg, merged.ratePaisePerQtl, override);
  if (d.netGrams <= 0) throw bad("Net weight works out to zero or less — check the gross weight", "bad_net");

  await db.update(schema.purchaseSlips).set({
    ...merged,
    katautiTerms: JSON.stringify(cfg),
    katautiUnits: d.katautiUnits,
    katautiOverride: override != null,
    netGrams: d.netGrams, amountPaise: d.amountPaise, updatedAt: nowSec(),
  }).where(eq(schema.purchaseSlips.id, id));

  const [after] = await db.select().from(schema.purchaseSlips).where(eq(schema.purchaseSlips.id, id)).limit(1);
  await audit({
    actor: actor(c), action: "slip.update", entity: "purchase_slip", entityId: id,
    entityLabel: `${merged.slipDate} RST ${merged.rstNo}`, before, after,
  });
  await enqueueSync(biz, "purchase_slip", id, "update", after);
  const touched = before.ratePaisePerQtl !== merged.ratePaisePerQtl || before.netGrams !== d.netGrams || before.slipDate !== merged.slipDate
    || before.merchantId !== merged.merchantId || before.jinsId !== merged.jinsId;
  const approvedParchas = touched ? await approvedOnDays(biz, [
    { merchantId: before.merchantId, jinsId: before.jinsId, date: before.slipDate },
    { merchantId: merged.merchantId, jinsId: merged.jinsId, date: merged.slipDate },
  ]) : [];
  return c.json({ ok: true, netGrams: d.netGrams, amountPaise: d.amountPaise, katautiUnits: d.katautiUnits, katautiGrams: d.katautiGrams, approvedParchas });
});

slipRoutes.delete("/:id", can("slip.delete"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const id = param(c, "id");
  const [before] = await db.select().from(schema.purchaseSlips)
    .where(and(eq(schema.purchaseSlips.id, id), eq(schema.purchaseSlips.businessId, biz))).limit(1);
  if (!before) throw notFound("Slip not found");
  await db.delete(schema.purchaseSlips).where(eq(schema.purchaseSlips.id, id));
  await audit({
    actor: actor(c), action: "slip.delete", entity: "purchase_slip", entityId: id,
    entityLabel: `${before.slipDate} RST ${before.rstNo}`, before,
  });
  await enqueueSync(biz, "purchase_slip", id, "delete");
  return c.json({ ok: true, approvedParchas: await approvedOnDays(biz, [{ merchantId: before.merchantId, jinsId: before.jinsId, date: before.slipDate }]) });
});

/** Move a batch of slips to another mill — RST 634 went from G.R.M to L.B this way. */
slipRoutes.post("/reassign", can("slip.write"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const { slipIds, merchantId } = z.object({
    slipIds: z.array(z.string()).min(1),
    merchantId: z.string().nullable(),
  }).parse(await c.req.json());

  const slips = await db.select().from(schema.purchaseSlips)
    .where(and(eq(schema.purchaseSlips.businessId, biz), inArray(schema.purchaseSlips.id, slipIds)));
  if (slips.length !== slipIds.length) throw bad("Some slips were not found", "missing");


  let label = "no mill";
  if (merchantId) {
    const [m] = await db.select({ code: schema.merchants.code }).from(schema.merchants)
      .where(and(eq(schema.merchants.id, merchantId), eq(schema.merchants.businessId, biz))).limit(1);
    if (!m) throw bad("Unknown mill", "bad_merchant");
    label = m.code;
  }

  // katauti terms can differ per mill, so net and amount are re-derived per slip
  const cfg = await katautiCfg(biz, merchantId);
  const moved = slips.map((s) => ({ s, d: deriveSlip(s.grossGrams, cfg, s.ratePaisePerQtl, s.katautiOverride ? s.katautiUnits : null) }));
  const bad0 = moved.find((x) => x.d.netGrams <= 0);
  if (bad0) throw bad(`RST ${bad0.s.rstNo}: with that mill's katauti the net works out to zero or less`, "bad_net");
  // every slip moves, or none does
  db.transaction((tx) => {
    for (const { s, d } of moved) {
      tx.update(schema.purchaseSlips).set({
        merchantId, katautiUnits: d.katautiUnits, katautiTerms: JSON.stringify(cfg),
        netGrams: d.netGrams, amountPaise: d.amountPaise, updatedAt: nowSec(),
      }).where(eq(schema.purchaseSlips.id, s.id)).run();
    }
  });
  for (const sl of slips) await enqueueSync(biz, "purchase_slip", sl.id, "update", { merchantId });
  await audit({
    actor: actor(c), action: "slip.reassign", entity: "purchase_slip",
    entityLabel: `${slips.length} slips -> ${label}`,
    before: slips.map((s) => ({ rstNo: s.rstNo, merchantId: s.merchantId })),
    after: { merchantId, count: slips.length },
  });
  const days = slips.flatMap((x) => [
    { merchantId: x.merchantId, jinsId: x.jinsId, date: x.slipDate }, { merchantId, jinsId: x.jinsId, date: x.slipDate },
  ]);
  return c.json({ ok: true, updated: slips.length, approvedParchas: await approvedOnDays(biz, days) });
});

/** Change the commodity of several slips at once. Weight, katauti and amount
 *  do not depend on the commodity, so only the commodity changes. */
slipRoutes.post("/set-jins", can("slip.write"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const { slipIds, jinsId } = z.object({
    slipIds: z.array(z.string()).min(1).max(5000),
    jinsId: z.string().min(1),
  }).parse(await c.req.json());
  const [j] = await db.select({ code: schema.jins.code }).from(schema.jins)
    .where(and(eq(schema.jins.id, jinsId), eq(schema.jins.businessId, biz))).limit(1);
  if (!j) throw bad("Unknown commodity", "bad_jins");
  const slips = await db.select().from(schema.purchaseSlips)
    .where(and(eq(schema.purchaseSlips.businessId, biz), inArray(schema.purchaseSlips.id, slipIds)));
  if (slips.length !== new Set(slipIds).size) throw bad("Some slips were not found", "missing");
  const moving = slips.filter((s) => s.jinsId !== jinsId);
  if (moving.length) {
    await db.update(schema.purchaseSlips).set({ jinsId, updatedAt: nowSec() })
      .where(and(eq(schema.purchaseSlips.businessId, biz), inArray(schema.purchaseSlips.id, moving.map((s) => s.id))));
    for (const s of moving) await enqueueSync(biz, "purchase_slip", s.id, "update", { jinsId });
    await audit({
      actor: actor(c), action: "slip.set_jins", entity: "purchase_slip",
      entityLabel: `${moving.length} slips -> ${j.code}`,
      before: moving.map((s) => ({ rstNo: s.rstNo, slipDate: s.slipDate, jinsId: s.jinsId })),
      after: { jinsId, count: moving.length },
    });
  }
  const days = moving.flatMap((x) => [
    { merchantId: x.merchantId, jinsId: x.jinsId, date: x.slipDate }, { merchantId: x.merchantId, jinsId, date: x.slipDate },
  ]);
  return c.json({ ok: true, updated: moving.length, approvedParchas: await approvedOnDays(biz, days) });
});

/** Recompute a whole day from gross + bags + rate. Repairs anything stale. */
slipRoutes.post("/recompute", can("slip.write"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const { slipDate } = z.object({ slipDate: z.string().regex(ISO_DATE) }).parse(await c.req.json());
  const rows = await db.select().from(schema.purchaseSlips)
    .where(and(eq(schema.purchaseSlips.businessId, biz), eq(schema.purchaseSlips.slipDate, slipDate)));

  // repairs a stored figure that disagrees with the slip's own terms; a later
  // change to a mill's katauti does not reach back into old slips
  const cfgCache = new Map<string, Katauti>();
  let changed = 0;
  const fixes: { rstNo: string; before: { net: number; amount: number }; after: { net: number; amount: number } }[] = [];
  for (const r of rows) {
    const key = r.merchantId ?? "-";
    if (!cfgCache.has(key)) cfgCache.set(key, await katautiCfg(biz, r.merchantId));
    const d = deriveSlip(r.grossGrams, termsOf(r, cfgCache.get(key)!), r.ratePaisePerQtl, r.katautiOverride ? r.katautiUnits : null);
    if (d.netGrams !== r.netGrams || d.amountPaise !== r.amountPaise || d.katautiUnits !== r.katautiUnits) {
      fixes.push({ rstNo: r.rstNo, before: { net: r.netGrams, amount: r.amountPaise }, after: { net: d.netGrams, amount: d.amountPaise } });
      await db.update(schema.purchaseSlips)
        .set({ katautiUnits: d.katautiUnits, netGrams: d.netGrams, amountPaise: d.amountPaise, updatedAt: nowSec() })
        .where(eq(schema.purchaseSlips.id, r.id));
      await enqueueSync(biz, "purchase_slip", r.id, "update", { katautiUnits: d.katautiUnits, netGrams: d.netGrams, amountPaise: d.amountPaise });
      changed++;
    }
  }
  await audit({
    actor: actor(c), action: "slip.recompute", entity: "purchase_slip",
    entityLabel: `${slipDate}: ${changed} of ${rows.length} corrected`,
    after: { slipDate, scanned: rows.length, changed, fixes },
  });
  return c.json({ scanned: rows.length, changed });
});
