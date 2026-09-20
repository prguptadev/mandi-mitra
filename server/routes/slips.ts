import { Hono } from "hono";
import { z } from "zod";
import { eq, and, asc, desc, sql, inArray } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { newId, nowSec } from "../lib/ids.ts";
import { audit, enqueueSync } from "../lib/audit.ts";
import { ChargeConfigSchema, KatautiSchema, deriveKatauti, type Katauti } from "../lib/charges.ts";
import { amountPaise, weightedAvgRate, GRAMS_PER_QTL } from "../lib/money.ts";
import { DisplayConfigSchema, defaultDisplayConfig } from "../lib/display.ts";
import { can, actor, param, notFound, bad, HttpError, type Env } from "../lib/http.ts";

export const slipRoutes = new Hono<Env>();

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const SlipBody = z.object({
  slipDate: z.string().regex(ISO_DATE, "Date must be YYYY-MM-DD"),
  rstNo: z.string().trim().min(1, "RST no is required").max(20),
  adatiId: z.string().min(1, "Pick a supplier"),
  jinsId: z.string().min(1, "Pick a commodity"),
  merchantId: z.string().nullish(),
  /** Dharam kanta, in grams. */
  grossGrams: z.number().int().min(1, "Gross weight is required"),
  /** Only when the sheet's KATAUTI differs from gross rounded to a quintal. */
  katautiUnits: z.number().int().min(0).nullish(),
  /** Physical bags, when known. Not the same number as katauti. */
  bagsCount: z.number().int().min(0).nullish(),
  ratePaisePerQtl: z.number().int().min(0),
  /** When the sheet's own net disagrees with the formula, we want to know. */
  netGramsClaimed: z.number().int().nullish(),
});

/** Katauti terms come from the mill on the sheet header, else the business default. */
async function katautiCfg(businessId: string, merchantId?: string | null): Promise<Katauti> {
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
      return KatautiSchema.parse({ mode: parsed.data.katautiMode, kgPerUnit: parsed.data.katautiKgPerUnit });
    }
  }
  const d = defaultDisplayConfig();
  return KatautiSchema.parse({ mode: d.katautiMode, kgPerUnit: d.katautiKgPerUnit });
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
  const merchantId = c.req.query("merchantId");
  const jinsId = c.req.query("jinsId");
  const adatiId = c.req.query("adatiId");
  const unallocated = c.req.query("unallocated") === "1";

  const where = [eq(schema.purchaseSlips.businessId, biz)];
  if (date) {
    if (!ISO_DATE.test(date)) throw bad("Date must be YYYY-MM-DD");
    where.push(eq(schema.purchaseSlips.slipDate, date));
  }
  if (merchantId) where.push(eq(schema.purchaseSlips.merchantId, merchantId));
  if (jinsId) where.push(eq(schema.purchaseSlips.jinsId, jinsId));
  if (adatiId) where.push(eq(schema.purchaseSlips.adatiId, adatiId));
  if (unallocated) where.push(sql`${schema.purchaseSlips.loadId} is null`);

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
    loadId: schema.purchaseSlips.loadId,
    grossGrams: schema.purchaseSlips.grossGrams,
    katautiUnits: schema.purchaseSlips.katautiUnits,
    katautiOverride: schema.purchaseSlips.katautiOverride,
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
    const cfg = cfgCache.get(cacheKey)!;
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
    allocatedRows: checked.filter((r) => r.loadId).length,
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
  if (dupe) throw bad(`RST ${body.rstNo} is already on this date`, "duplicate_rst");

  const [ad] = await db.select({ id: schema.adati.id, name: schema.adati.nameHinglish }).from(schema.adati)
    .where(and(eq(schema.adati.id, body.adatiId), eq(schema.adati.businessId, biz))).limit(1);
  if (!ad) throw bad("That supplier does not belong to this business", "bad_adati");
  const [jn] = await db.select({ id: schema.jins.id }).from(schema.jins)
    .where(and(eq(schema.jins.id, body.jinsId), eq(schema.jins.businessId, biz))).limit(1);
  if (!jn) throw bad("That commodity does not belong to this business", "bad_jins");

  const cfg = await katautiCfg(biz, body.merchantId);
  const d = deriveSlip(body.grossGrams, cfg, body.ratePaisePerQtl, body.katautiUnits ?? null);
  if (d.netGrams <= 0) throw bad("Net weight works out to zero or less — check the gross weight", "bad_net");

  const id = newId();
  const values = {
    id, businessId: biz,
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
    id,
    netGrams: d.netGrams,
    amountPaise: d.amountPaise,
    katautiUnits: d.katautiUnits,
    katautiGrams: d.katautiGrams,
    /** Set when the sheet's own net differs from the formula. */
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
  if (before.loadId) {
    throw new HttpError(409, "This slip is already on a load. Remove it from the load before changing it.", "slip_locked");
  }
  assertRateAllowed(c, body.ratePaisePerQtl !== undefined && body.ratePaisePerQtl !== before.ratePaisePerQtl);

  if (body.rstNo && body.rstNo !== before.rstNo) {
    const date = body.slipDate ?? before.slipDate;
    const [dupe] = await db.select({ id: schema.purchaseSlips.id }).from(schema.purchaseSlips)
      .where(and(
        eq(schema.purchaseSlips.businessId, biz),
        eq(schema.purchaseSlips.slipDate, date),
        eq(schema.purchaseSlips.rstNo, body.rstNo),
      )).limit(1);
    if (dupe && dupe.id !== id) throw bad(`RST ${body.rstNo} is already on this date`, "duplicate_rst");
  }

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
  const cfg = await katautiCfg(biz, merged.merchantId);
  const d = deriveSlip(merged.grossGrams, cfg, merged.ratePaisePerQtl, override);
  if (d.netGrams <= 0) throw bad("Net weight works out to zero or less — check the gross weight", "bad_net");

  await db.update(schema.purchaseSlips).set({
    ...merged,
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
  return c.json({ ok: true, netGrams: d.netGrams, amountPaise: d.amountPaise, katautiUnits: d.katautiUnits, katautiGrams: d.katautiGrams });
});

slipRoutes.delete("/:id", can("slip.delete"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const id = param(c, "id");
  const [before] = await db.select().from(schema.purchaseSlips)
    .where(and(eq(schema.purchaseSlips.id, id), eq(schema.purchaseSlips.businessId, biz))).limit(1);
  if (!before) throw notFound("Slip not found");
  if (before.loadId) {
    throw new HttpError(409, "This slip is on a load. Remove it from the load first.", "slip_locked");
  }
  await db.delete(schema.purchaseSlips).where(eq(schema.purchaseSlips.id, id));
  await audit({
    actor: actor(c), action: "slip.delete", entity: "purchase_slip", entityId: id,
    entityLabel: `${before.slipDate} RST ${before.rstNo}`, before,
  });
  await enqueueSync(biz, "purchase_slip", id, "delete");
  return c.json({ ok: true });
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

  const locked = slips.filter((s) => s.loadId);
  if (locked.length) {
    throw new HttpError(409, `${locked.length} of these are already on a load. Remove them from the load first.`, "slip_locked");
  }

  let label = "no mill";
  if (merchantId) {
    const [m] = await db.select({ code: schema.merchants.code }).from(schema.merchants)
      .where(and(eq(schema.merchants.id, merchantId), eq(schema.merchants.businessId, biz))).limit(1);
    if (!m) throw bad("Unknown mill", "bad_merchant");
    label = m.code;
  }

  // katauti terms can differ per mill, so net and amount are re-derived per slip
  const cfg = await katautiCfg(biz, merchantId);
  for (const s of slips) {
    const d = deriveSlip(s.grossGrams, cfg, s.ratePaisePerQtl, s.katautiOverride ? s.katautiUnits : null);
    await db.update(schema.purchaseSlips).set({
      merchantId, katautiUnits: d.katautiUnits,
      netGrams: d.netGrams, amountPaise: d.amountPaise, updatedAt: nowSec(),
    }).where(eq(schema.purchaseSlips.id, s.id));
  }
  await audit({
    actor: actor(c), action: "slip.reassign", entity: "purchase_slip",
    entityLabel: `${slips.length} slips -> ${label}`,
    before: slips.map((s) => ({ rstNo: s.rstNo, merchantId: s.merchantId })),
    after: { merchantId, count: slips.length },
  });
  return c.json({ ok: true, updated: slips.length });
});

/** Recompute a whole day from gross + bags + rate. Repairs anything stale. */
slipRoutes.post("/recompute", can("slip.write"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const { slipDate } = z.object({ slipDate: z.string().regex(ISO_DATE) }).parse(await c.req.json());
  const rows = await db.select().from(schema.purchaseSlips)
    .where(and(eq(schema.purchaseSlips.businessId, biz), eq(schema.purchaseSlips.slipDate, slipDate)));

  const cfgCache = new Map<string, Katauti>();
  let changed = 0;
  for (const r of rows) {
    const key = r.merchantId ?? "-";
    if (!cfgCache.has(key)) cfgCache.set(key, await katautiCfg(biz, r.merchantId));
    const d = deriveSlip(r.grossGrams, cfgCache.get(key)!, r.ratePaisePerQtl, r.katautiOverride ? r.katautiUnits : null);
    if (d.netGrams !== r.netGrams || d.amountPaise !== r.amountPaise || d.katautiUnits !== r.katautiUnits) {
      await db.update(schema.purchaseSlips)
        .set({ katautiUnits: d.katautiUnits, netGrams: d.netGrams, amountPaise: d.amountPaise, updatedAt: nowSec() })
        .where(eq(schema.purchaseSlips.id, r.id));
      changed++;
    }
  }
  await audit({
    actor: actor(c), action: "slip.recompute", entity: "purchase_slip",
    entityLabel: `${slipDate}: ${changed} of ${rows.length} corrected`,
    after: { slipDate, scanned: rows.length, changed },
  });
  return c.json({ scanned: rows.length, changed });
});
