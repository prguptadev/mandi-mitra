import { Hono } from "hono";
import { z } from "zod";
import { eq, and, desc, sql, inArray } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { newId, nowSec } from "../lib/ids.ts";
import { audit, enqueueSync } from "../lib/audit.ts";
import { can, actor, param, notFound, bad, HttpError, type Env } from "../lib/http.ts";

/* Purchase orders: a mill asks for N quintals of a commodity. Loads are sent
   against them; the balance is what is still to go. Going over is flagged on
   the load, never refused — mills routinely take a little extra. */

export const orderRoutes = new Hono<Env>();

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const Body = z.object({
  merchantId: z.string().min(1, "Pick a mill"),
  jinsId: z.string().min(1, "Pick a commodity"),
  poNo: z.string().trim().min(1, "PO number is required").max(30),
  poDate: z.string().regex(ISO_DATE, "Date must be YYYY-MM-DD"),
  qtyGrams: z.number().int().min(1, "Quantity is required"),
  ratePaisePerQtl: z.number().int().min(0).nullish(),
  validTill: z.string().regex(ISO_DATE).nullish().or(z.literal("")),
  status: z.enum(["open", "closed"]).optional(),
  notes: z.string().trim().max(500).nullish(),
});

/** Quantity each PO has had sent against it: the mill's net once weighed, else ours. */
export async function dispatchedByPo(poIds: string[]) {
  const out = new Map<string, { grams: number; loads: number; billed: number }>();
  if (!poIds.length) return out;
  const loads = await db.select({
    id: schema.loads.id, poId: schema.loads.poId, millNetGrams: schema.loads.millNetGrams, status: schema.loads.status,
    slipNet: sql<number>`(select coalesce(sum(${schema.purchaseSlips.netGrams}), 0) from ${schema.purchaseSlips} where ${schema.purchaseSlips.loadId} = ${schema.loads.id})`,
  }).from(schema.loads).where(inArray(schema.loads.poId, poIds));
  for (const l of loads) {
    const cur = out.get(l.poId!) ?? { grams: 0, loads: 0, billed: 0 };
    cur.grams += l.millNetGrams ?? l.slipNet;
    cur.loads += 1;
    if (l.status === "billed") cur.billed += 1;
    out.set(l.poId!, cur);
  }
  return out;
}

orderRoutes.get("/", can("po.read"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const where = [eq(schema.purchaseOrders.businessId, biz)];
  const merchantId = c.req.query("merchantId");
  const jinsId = c.req.query("jinsId");
  const status = c.req.query("status");
  if (merchantId) where.push(eq(schema.purchaseOrders.merchantId, merchantId));
  if (jinsId) where.push(eq(schema.purchaseOrders.jinsId, jinsId));
  if (status === "open" || status === "closed") where.push(eq(schema.purchaseOrders.status, status));

  const rows = await db.select({
    po: schema.purchaseOrders,
    millCode: schema.merchants.code,
    millName: schema.merchants.name,
    jinsCode: schema.jins.code,
    jinsName: schema.jins.name,
    jinsNameHi: schema.jins.nameHi,
  })
    .from(schema.purchaseOrders)
    .innerJoin(schema.merchants, eq(schema.merchants.id, schema.purchaseOrders.merchantId))
    .innerJoin(schema.jins, eq(schema.jins.id, schema.purchaseOrders.jinsId))
    .where(and(...where))
    .orderBy(desc(schema.purchaseOrders.poDate), desc(schema.purchaseOrders.createdAt));

  const sent = await dispatchedByPo(rows.map((r) => r.po.id));
  return c.json(rows.map((r) => {
    const s = sent.get(r.po.id) ?? { grams: 0, loads: 0, billed: 0 };
    return {
      ...r.po,
      millCode: r.millCode, millName: r.millName,
      jinsCode: r.jinsCode, jinsName: r.jinsName, jinsNameHi: r.jinsNameHi,
      sentGrams: s.grams, loads: s.loads, billedLoads: s.billed,
      balanceGrams: r.po.qtyGrams - s.grams,
    };
  }));
});

async function checkRefs(biz: string, merchantId: string, jinsId: string) {
  const [m] = await db.select({ code: schema.merchants.code }).from(schema.merchants)
    .where(and(eq(schema.merchants.id, merchantId), eq(schema.merchants.businessId, biz))).limit(1);
  if (!m) throw bad("That mill does not belong to this business", "bad_merchant");
  const [j] = await db.select({ code: schema.jins.code }).from(schema.jins)
    .where(and(eq(schema.jins.id, jinsId), eq(schema.jins.businessId, biz))).limit(1);
  if (!j) throw bad("That commodity does not belong to this business", "bad_jins");
  return { millCode: m.code, jinsCode: j.code };
}

orderRoutes.post("/", can("po.write"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const body = Body.parse(await c.req.json());
  const refs = await checkRefs(biz, body.merchantId, body.jinsId);
  const [dupe] = await db.select({ id: schema.purchaseOrders.id }).from(schema.purchaseOrders)
    .where(and(
      eq(schema.purchaseOrders.businessId, biz),
      eq(schema.purchaseOrders.merchantId, body.merchantId),
      eq(schema.purchaseOrders.poNo, body.poNo),
    )).limit(1);
  if (dupe) throw new HttpError(409, `PO ${body.poNo} already exists for ${refs.millCode}`, "duplicate");

  const id = newId();
  const values = {
    id, businessId: biz,
    merchantId: body.merchantId, jinsId: body.jinsId,
    poNo: body.poNo, poDate: body.poDate, qtyGrams: body.qtyGrams,
    ratePaisePerQtl: body.ratePaisePerQtl ?? null,
    validTill: body.validTill || null,
    status: body.status ?? "open",
    notes: body.notes ?? null,
    createdBy: c.get("auth")!.user.id,
  };
  await db.insert(schema.purchaseOrders).values(values);
  await audit({ actor: actor(c), action: "po.create", entity: "purchase_order", entityId: id,
    entityLabel: `${refs.millCode} PO ${body.poNo}`, after: values });
  await enqueueSync(biz, "purchase_order", id, "insert", values);
  return c.json({ id });
});

orderRoutes.put("/:id", can("po.write"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const id = param(c, "id");
  const body = Body.partial().parse(await c.req.json());
  const [before] = await db.select().from(schema.purchaseOrders)
    .where(and(eq(schema.purchaseOrders.id, id), eq(schema.purchaseOrders.businessId, biz))).limit(1);
  if (!before) throw notFound("PO not found");

  const merchantId = body.merchantId ?? before.merchantId;
  const jinsId = body.jinsId ?? before.jinsId;
  if (merchantId !== before.merchantId || jinsId !== before.jinsId) {
    const [used] = await db.select({ id: schema.loads.id }).from(schema.loads).where(eq(schema.loads.poId, id)).limit(1);
    if (used) throw new HttpError(409, "Loads are already sent against this PO, so its mill and commodity cannot change", "po_in_use");
  }
  const refs = await checkRefs(biz, merchantId, jinsId);
  const poNo = body.poNo ?? before.poNo;
  if (poNo !== before.poNo || merchantId !== before.merchantId) {
    const [dupe] = await db.select({ id: schema.purchaseOrders.id }).from(schema.purchaseOrders)
      .where(and(
        eq(schema.purchaseOrders.businessId, biz),
        eq(schema.purchaseOrders.merchantId, merchantId),
        eq(schema.purchaseOrders.poNo, poNo),
      )).limit(1);
    if (dupe && dupe.id !== id) throw new HttpError(409, `PO ${poNo} already exists for ${refs.millCode}`, "duplicate");
  }

  const patch = {
    merchantId, jinsId, poNo,
    poDate: body.poDate ?? before.poDate,
    qtyGrams: body.qtyGrams ?? before.qtyGrams,
    ratePaisePerQtl: body.ratePaisePerQtl === undefined ? before.ratePaisePerQtl : (body.ratePaisePerQtl ?? null),
    validTill: body.validTill === undefined ? before.validTill : (body.validTill || null),
    status: body.status ?? before.status,
    notes: body.notes === undefined ? before.notes : (body.notes ?? null),
    updatedAt: nowSec(),
  };
  await db.update(schema.purchaseOrders).set(patch).where(eq(schema.purchaseOrders.id, id));
  const after = { ...before, ...patch };
  await audit({ actor: actor(c), action: body.status && body.status !== before.status ? `po.${body.status === "closed" ? "close" : "reopen"}` : "po.update",
    entity: "purchase_order", entityId: id, entityLabel: `${refs.millCode} PO ${poNo}`, before, after });
  await enqueueSync(biz, "purchase_order", id, "update", after);
  return c.json({ ok: true });
});

orderRoutes.delete("/:id", can("po.write"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const id = param(c, "id");
  const [before] = await db.select().from(schema.purchaseOrders)
    .where(and(eq(schema.purchaseOrders.id, id), eq(schema.purchaseOrders.businessId, biz))).limit(1);
  if (!before) throw notFound("PO not found");
  const [used] = await db.select({ id: schema.loads.id }).from(schema.loads).where(eq(schema.loads.poId, id)).limit(1);
  if (used) throw new HttpError(409, "Loads are sent against this PO. Close it instead of deleting it.", "po_in_use");
  await db.delete(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, id));
  await audit({ actor: actor(c), action: "po.delete", entity: "purchase_order", entityId: id,
    entityLabel: `PO ${before.poNo}`, before });
  await enqueueSync(biz, "purchase_order", id, "delete");
  return c.json({ ok: true });
});
