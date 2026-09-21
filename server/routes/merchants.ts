import { Hono } from "hono";
import { z } from "zod";
import { eq, and, asc } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { newId, nowSec } from "../lib/ids.ts";
import { audit, enqueueSync } from "../lib/audit.ts";
import { toHinglish } from "../lib/translit.ts";
import { ChargeConfigSchema, defaultChargeConfig, computeParcha } from "../lib/charges.ts";
import { param, can, actor, notFound, bad, type Env } from "../lib/http.ts";
import { qtlToGrams, rupeesToPaise } from "../lib/money.ts";

export const merchantRoutes = new Hono<Env>();

const Body = z.object({
  code: z.string().trim().min(1, "Short code is required").max(12),
  name: z.string().trim().min(2, "Mill name is required"),
  nameHi: z.string().trim().optional(),
  nameHinglish: z.string().trim().optional(),
  addressLine1: z.string().trim().optional(),
  addressLine2: z.string().trim().optional(),
  city: z.string().trim().optional(),
  state: z.string().trim().optional(),
  pincode: z.string().trim().optional(),
  contactPerson: z.string().trim().optional(),
  phone: z.string().trim().optional(),
  gstin: z.string().trim().optional(),
  chargeConfig: ChargeConfigSchema.optional(),
  active: z.boolean().optional(),
});

const hydrate = (r: typeof schema.merchants.$inferSelect) => ({
  ...r,
  chargeConfig: ChargeConfigSchema.parse(JSON.parse(r.chargeConfig)),
});

merchantRoutes.get("/", can("merchant.read"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const all = c.req.query("all") === "1";
  const where = [eq(schema.merchants.businessId, biz)];
  if (!all) where.push(eq(schema.merchants.active, true));
  const rows = await db.select().from(schema.merchants).where(and(...where)).orderBy(asc(schema.merchants.name));
  return c.json(rows.map(hydrate));
});

merchantRoutes.get("/defaults", can("merchant.read"), (c) => c.json(defaultChargeConfig()));

merchantRoutes.get("/:id", can("merchant.read"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const [row] = await db.select().from(schema.merchants)
    .where(and(eq(schema.merchants.id, param(c, "id")), eq(schema.merchants.businessId, biz))).limit(1);
  if (!row) throw notFound("Mill not found");
  return c.json(hydrate(row));
});

merchantRoutes.post("/", can("merchant.write"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const body = Body.parse(await c.req.json());
  const code = body.code.toUpperCase();

  const [dupe] = await db.select({ id: schema.merchants.id }).from(schema.merchants)
    .where(and(eq(schema.merchants.businessId, biz), eq(schema.merchants.code, code))).limit(1);
  if (dupe) throw bad(`Short code "${code}" is already used by another mill`, "duplicate");

  const id = newId();
  const cfg = body.chargeConfig ?? defaultChargeConfig();
  const values = {
    id, businessId: biz, code, name: body.name,
    nameHi: body.nameHi || null,
    nameHinglish: body.nameHinglish?.trim() || (body.nameHi ? toHinglish(body.nameHi) : null),
    addressLine1: body.addressLine1 || null, addressLine2: body.addressLine2 || null,
    city: body.city || null, state: body.state || null, pincode: body.pincode || null,
    contactPerson: body.contactPerson || null, phone: body.phone || null,
    gstin: body.gstin || null,
    chargeConfig: JSON.stringify(cfg),
    active: body.active ?? true,
  };
  await db.insert(schema.merchants).values(values);
  await audit({ actor: actor(c), action: "merchant.create", entity: "merchant", entityId: id, entityLabel: body.name, after: { ...values, chargeConfig: cfg } });
  await enqueueSync(biz, "merchant", id, "insert", values);
  return c.json({ id });
});

merchantRoutes.put("/:id", can("merchant.write"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const id = param(c, "id");
  const body = Body.partial().parse(await c.req.json());
  const [before] = await db.select().from(schema.merchants)
    .where(and(eq(schema.merchants.id, id), eq(schema.merchants.businessId, biz))).limit(1);
  if (!before) throw notFound("Mill not found");

  const patch: Record<string, unknown> = { updatedAt: nowSec() };
  if (body.code) patch.code = body.code.toUpperCase();
  for (const k of ["name", "nameHi", "nameHinglish", "addressLine1", "addressLine2", "city", "state", "pincode", "contactPerson", "phone", "gstin"] as const) {
    if (body[k] !== undefined) patch[k] = body[k] || null;
  }
  if (body.active !== undefined) patch.active = body.active;
  if (body.chargeConfig) patch.chargeConfig = JSON.stringify(ChargeConfigSchema.parse(body.chargeConfig));

  await db.update(schema.merchants).set(patch).where(eq(schema.merchants.id, id));
  const [after] = await db.select().from(schema.merchants).where(eq(schema.merchants.id, id)).limit(1);

  // charge terms are money — diff them explicitly so the audit row is readable
  const beforeCfg = JSON.parse(before.chargeConfig);
  const afterCfg = JSON.parse(after!.chargeConfig);
  await audit({
    actor: actor(c), action: "merchant.update", entity: "merchant", entityId: id, entityLabel: after!.name,
    before: { ...before, chargeConfig: beforeCfg }, after: { ...after, chargeConfig: afterCfg },
  });
  if (JSON.stringify(beforeCfg) !== JSON.stringify(afterCfg)) {
    await audit({
      actor: actor(c), action: "merchant.charges.update", entity: "merchant_charges",
      entityId: id, entityLabel: after!.name, before: beforeCfg, after: afterCfg,
    });
  }
  await enqueueSync(biz, "merchant", id, "update", after);
  return c.json({ ok: true });
});

merchantRoutes.delete("/:id", can("merchant.delete"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const id = param(c, "id");
  const [before] = await db.select().from(schema.merchants)
    .where(and(eq(schema.merchants.id, id), eq(schema.merchants.businessId, biz))).limit(1);
  if (!before) throw notFound("Mill not found");
  const [used] = await db.select({ id: schema.loads.id }).from(schema.loads)
    .where(eq(schema.loads.merchantId, id)).limit(1);
  if (used) {
    await db.update(schema.merchants).set({ active: false, updatedAt: nowSec() }).where(eq(schema.merchants.id, id));
    await audit({ actor: actor(c), action: "merchant.deactivate", entity: "merchant", entityId: id, entityLabel: before.name, before });
    return c.json({ ok: true, deactivated: true, reason: "This mill has loads, so it was made inactive instead of deleted." });
  }
  await db.delete(schema.merchants).where(eq(schema.merchants.id, id));
  await audit({ actor: actor(c), action: "merchant.delete", entity: "merchant", entityId: id, entityLabel: before.name, before });
  return c.json({ ok: true, deactivated: false });
});

/**
 * Live preview: feeds a sample load through the charge config so the owner can
 * see the effect of a term change before saving it. Defaults are the real
 * 20-09-2026 figures, which makes the preview instantly recognisable.
 */
merchantRoutes.post("/preview", can("merchant.read"), async (c) => {
  const body = z.object({
    chargeConfig: ChargeConfigSchema,
    grossQtl: z.number().default(315.3),
    bags: z.number().int().default(800),
    katte: z.number().int().optional(),
    bore: z.number().int().optional(),
    bardanaQtl: z.number().optional(),
    netQtl: z.number().optional(),
    rate: z.number().default(3413.45),
    trucks: z.number().int().default(1),
    advanceRupees: z.number().default(10000),
    manualDaraRupees: z.number().default(3597.38),
  }).parse(await c.req.json());

  const result = computeParcha(body.chargeConfig, {
    grossGrams: qtlToGrams(body.grossQtl),
    bags: body.bags,
    katte: body.katte,
    bore: body.bore,
    bardanaGrams: body.bardanaQtl !== undefined ? qtlToGrams(body.bardanaQtl) : undefined,
    netGrams: body.netQtl !== undefined ? qtlToGrams(body.netQtl) : undefined,
    ratePaisePerQtl: rupeesToPaise(body.rate),
    trucks: body.trucks,
    advancePaise: rupeesToPaise(body.advanceRupees),
    manualDaraPaise: rupeesToPaise(body.manualDaraRupees),
  });
  return c.json(result);
});
