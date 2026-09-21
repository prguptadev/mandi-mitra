import { Hono } from "hono";
import { z } from "zod";
import { eq, and, desc, inArray } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { newId, nowSec } from "../lib/ids.ts";
import { audit, enqueueSync } from "../lib/audit.ts";
import { can, actor, param, notFound, bad, HttpError, isoDay, LIMIT, type Env } from "../lib/http.ts";
import { dmy } from "../lib/parchaLabels.ts";
import { linesWithWeights } from "../lib/parcha.ts";

/** How a PO is named where there is no number: by its date. */
export const poLabel = (p: { poNo: string; poDate: string }) => (p.poNo ? `PO ${p.poNo}` : `PO of ${dmy(p.poDate)}`);

/* Purchase orders: a mill asks for N quintals of a commodity. Loads are sent
   against them; the balance is what is still to go. Going over is flagged on
   the load, never refused — mills routinely take a little extra. */

export const orderRoutes = new Hono<Env>();

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const Body = z.object({
  merchantId: z.string().min(1, "Pick a mill"),
  jinsId: z.string().min(1, "Pick a commodity"),
  /** Optional: a mill often sends only a date. */
  poNo: z.string().trim().max(30).optional().default(""),
  poDate: isoDay("PO date is required"),
  qtyGrams: z.number().int().min(1, "Quantity is required").max(LIMIT.grams * 1000, "Quantity is too large"),
  ratePaisePerQtl: z.number().int().min(0).max(LIMIT.rate).nullish(),
  validTill: isoDay().nullish().or(z.literal("")),
  status: z.enum(["open", "closed"]).optional(),
  notes: z.string().trim().max(500).nullish(),
});

/** Quantity sent against each PO: the weight of every truck row that names it. */
export async function dispatchedByPo(poIds: string[]) {
  const out = new Map<string, { grams: number; loads: number; billed: number }>();
  if (!poIds.length) return out;
  const lines = await linesWithWeights(inArray(schema.loadLines.poId, poIds));
  const seen = new Set<string>();
  for (const x of lines) {
    const cur = out.get(x.poId!) ?? { grams: 0, loads: 0, billed: 0 };
    cur.grams += x.weightGrams;
    const key = `${x.poId}:${x.loadId}`;
    if (!seen.has(key)) {
      seen.add(key);
      cur.loads += 1;
      if (x.status === "billed") cur.billed += 1;
    }
    out.set(x.poId!, cur);
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
    millName: schema.merchants.name, millNameHi: schema.merchants.nameHi,
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
  if (body.poNo) {
    const [dupe] = await db.select({ id: schema.purchaseOrders.id }).from(schema.purchaseOrders)
      .where(and(
        eq(schema.purchaseOrders.businessId, biz),
        eq(schema.purchaseOrders.merchantId, body.merchantId),
        eq(schema.purchaseOrders.poNo, body.poNo),
      )).limit(1);
    if (dupe) throw new HttpError(409, `PO ${body.poNo} already exists for ${refs.millCode}`, "duplicate");
  }

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
    entityLabel: `${refs.millCode} ${poLabel(values)}`, after: values });
  await enqueueSync(biz, "purchase_order", id, "insert", values);
  return c.json({ id });
});

orderRoutes.put("/:id", can("po.write"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const id = param(c, "id");
  const json = await c.req.json();
  const body = Body.partial().parse(json);
  if (!("poNo" in json)) body.poNo = undefined;
  const [before] = await db.select().from(schema.purchaseOrders)
    .where(and(eq(schema.purchaseOrders.id, id), eq(schema.purchaseOrders.businessId, biz))).limit(1);
  if (!before) throw notFound("PO not found");

  const merchantId = body.merchantId ?? before.merchantId;
  const jinsId = body.jinsId ?? before.jinsId;
  if (merchantId !== before.merchantId || jinsId !== before.jinsId) {
    const [used] = await db.select({ id: schema.loadLines.id }).from(schema.loadLines).where(eq(schema.loadLines.poId, id)).limit(1);
    if (used) throw new HttpError(409, "Loads are already sent against this PO, so its mill and commodity cannot change", "po_in_use");
  }
  const refs = await checkRefs(biz, merchantId, jinsId);
  const poNo = body.poNo ?? before.poNo;
  if (poNo && (poNo !== before.poNo || merchantId !== before.merchantId)) {
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
    entity: "purchase_order", entityId: id, entityLabel: `${refs.millCode} ${poLabel(after)}`, before, after });
  await enqueueSync(biz, "purchase_order", id, "update", after);
  return c.json({ ok: true });
});

orderRoutes.delete("/:id", can("po.write"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const id = param(c, "id");
  const [before] = await db.select().from(schema.purchaseOrders)
    .where(and(eq(schema.purchaseOrders.id, id), eq(schema.purchaseOrders.businessId, biz))).limit(1);
  if (!before) throw notFound("PO not found");
  const [used] = await db.select({ id: schema.loadLines.id }).from(schema.loadLines).where(eq(schema.loadLines.poId, id)).limit(1);
  if (used) throw new HttpError(409, "Loads are sent against this PO. Close it instead of deleting it.", "po_in_use");
  await db.delete(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, id));
  await audit({ actor: actor(c), action: "po.delete", entity: "purchase_order", entityId: id,
    entityLabel: poLabel(before), before });
  await enqueueSync(biz, "purchase_order", id, "delete");
  return c.json({ ok: true });
});
