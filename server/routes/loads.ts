import { Hono } from "hono";
import { z } from "zod";
import { eq, and, desc, asc, sql, inArray, gte, lte, like, or } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { newId, nowSec } from "../lib/ids.ts";
import { audit, enqueueSync } from "../lib/audit.ts";
import { ChargeConfigSchema } from "../lib/charges.ts";
import {
  loadState, storedWeighment, stockDays, linesWithWeights, sameNumberElsewhere, sameNumberCount, revisions, withRevision, fyKey,
  type ParchaDoc,
} from "../lib/parcha.ts";
import { billed, receipts, settle, type DueLine } from "./millAccounts.ts";
import { parchaXlsx } from "../lib/parchaXlsx.ts";
import { poLabel } from "./orders.ts";
import { claimParchaNumber, releaseParchaNumber, CloudError } from "../lib/cloud.ts";
import { repairTrucks } from "../lib/repairTrucks.ts";
import { can, actor, param, notFound, bad, HttpError, attachment, isoDay, LIMIT, type Env } from "../lib/http.ts";
import { assertDaysOpen } from "../lib/dayClose.ts";

/* A load is one truck to one mill, loaded by weight from that mill's stock:
   each row takes a weight from one purchase day (optionally against a PO),
   priced at that day's average rate. The mill's weighbridge reading is
   entered when it comes back, and approving freezes the kaccha parcha.
   Once approved, the load is locked until the parcha is voided. */

export const loadRoutes = new Hono<Env>();
export const parchaRoutes = new Hono<Env>();

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const gramsOrNull = z.number().int().min(0).max(LIMIT.grams, "Weight is too large — check the decimal point").nullish();

const Header = z.object({
  loadDate: isoDay(),
  merchantId: z.string().min(1, "Pick a mill"),
  jinsId: z.string().min(1, "Pick a commodity"),
  poId: z.string().nullish(),
  truckNo: z.string().trim().max(20).nullish(),
  transporter: z.string().trim().max(80).nullish(),
  driverPhone: z.string().trim().max(20).nullish(),
  ewayBillNo: z.string().trim().max(30).nullish(),
  notes: z.string().trim().max(500).nullish(),
});

const Weighment = z.object({
  millGrossGrams: gramsOrNull,
  katteCount: z.number().int().min(0).max(LIMIT.count).nullish(),
  boreCount: z.number().int().min(0).max(LIMIT.count).nullish(),
  katteBardanaGrams: gramsOrNull,
  boreBardanaGrams: gramsOrNull,
});

const ParchaFields = z.object({
  invoiceNo: z.string().trim().max(20).nullish(),
  invoiceDate: isoDay().nullish(),
  advancePaise: z.number().int().min(0).max(LIMIT.paise),
  daraPaise: z.number().int().min(0).max(LIMIT.paise),
});

const truckNorm = (t?: string | null) => (t ? t.toUpperCase().replace(/[\s-]+/g, "") : t ?? null);

async function getLoad(biz: string, id: string) {
  const [l] = await db.select().from(schema.loads)
    .where(and(eq(schema.loads.id, id), eq(schema.loads.businessId, biz))).limit(1);
  if (!l) throw notFound("Load not found");
  return l;
}

function assertDraft(l: { status: string }) {
  if (l.status === "billed") {
    throw new HttpError(409, "This load's parcha is approved. Void the parcha to change the load.", "load_locked");
  }
}

async function checkHeaderRefs(biz: string, h: { merchantId: string; jinsId: string; poId?: string | null }) {
  const [m] = await db.select({ code: schema.merchants.code }).from(schema.merchants)
    .where(and(eq(schema.merchants.id, h.merchantId), eq(schema.merchants.businessId, biz))).limit(1);
  if (!m) throw bad("That mill does not belong to this business", "bad_merchant");
  const [j] = await db.select({ code: schema.jins.code }).from(schema.jins)
    .where(and(eq(schema.jins.id, h.jinsId), eq(schema.jins.businessId, biz))).limit(1);
  if (!j) throw bad("That commodity does not belong to this business", "bad_jins");
  if (h.poId) {
    const [p] = await db.select().from(schema.purchaseOrders)
      .where(and(eq(schema.purchaseOrders.id, h.poId), eq(schema.purchaseOrders.businessId, biz))).limit(1);
    if (!p) throw bad("That PO does not belong to this business", "bad_po");
    if (p.merchantId !== h.merchantId) throw bad(`${poLabel(p)} is for another mill`, "po_mill");
    if (p.jinsId !== h.jinsId) throw bad(`${poLabel(p)} is for another commodity`, "po_jins");
  }
  return { millCode: m.code, jinsCode: j.code };
}

const LineBody = z.object({
  stockDate: isoDay("Pick the purchase day this weight comes from"),
  /** The row's commodity; the truck's own when left out. */
  jinsId: z.string().min(1).optional(),
  poId: z.string().nullish(),
  /** grams; null = the rest of the mill's net */
  netGrams: z.number().int().min(1, "Weight must be more than zero").max(LIMIT.grams, "Weight is too large — check the decimal point").nullish(),
  /** null = that day's average rate */
  ratePaisePerQtl: z.number().int().min(1).max(LIMIT.rate, "Rate is too large — check the decimal point").nullish(),
});

async function checkJins(biz: string, jinsId: string) {
  const [j] = await db.select({ id: schema.jins.id }).from(schema.jins)
    .where(and(eq(schema.jins.id, jinsId), eq(schema.jins.businessId, biz))).limit(1);
  if (!j) throw bad("That commodity does not belong to this business", "bad_jins");
}

/** A PO on a row must be for the row's mill and the row's commodity. */
async function checkLinePo(biz: string, load: { merchantId: string; jinsId: string }, poId: string | null | undefined) {
  if (!poId) return;
  const [p] = await db.select().from(schema.purchaseOrders)
    .where(and(eq(schema.purchaseOrders.id, poId), eq(schema.purchaseOrders.businessId, biz))).limit(1);
  if (!p) throw bad("That PO does not belong to this business", "bad_po");
  if (p.merchantId !== load.merchantId) throw bad(`${poLabel(p)} is for another mill`, "po_mill");
  if (p.jinsId !== load.jinsId) throw bad(`${poLabel(p)} is for another commodity`, "po_jins");
}

/** The newest day with stock left for this mill, else the newest purchase day, else the load date. */
async function defaultStockDate(biz: string, merchantId: string, jinsId: string, loadDate: string) {
  const days = await stockDays(biz, merchantId, jinsId);
  return days.find((d) => d.leftGrams > 0 && d.date <= loadDate)?.date
    ?? days.find((d) => d.boughtNetGrams > 0 && d.date <= loadDate)?.date
    ?? loadDate;
}

async function refreshWeighment(loadId: string) {
  const [l] = await db.select().from(schema.loads).where(eq(schema.loads.id, loadId)).limit(1);
  const [m] = await db.select({ cfg: schema.merchants.chargeConfig }).from(schema.merchants)
    .where(eq(schema.merchants.id, l.merchantId)).limit(1);
  const w = storedWeighment(l, ChargeConfigSchema.parse(JSON.parse(m.cfg)));
  await db.update(schema.loads).set(w).where(eq(schema.loads.id, loadId));
}

/* -------------------------------------------------------------------- read */

loadRoutes.get("/", can("load.read"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const where = [eq(schema.loads.businessId, biz)];
  const from = c.req.query("from");
  const to = c.req.query("to");
  const merchantId = c.req.query("merchantId");
  const status = c.req.query("status");
  const poId = c.req.query("poId");
  const q = c.req.query("q")?.trim();
  if (from && ISO_DATE.test(from)) where.push(gte(schema.loads.loadDate, from));
  if (to && ISO_DATE.test(to)) where.push(lte(schema.loads.loadDate, to));
  if (merchantId) where.push(eq(schema.loads.merchantId, merchantId));
  if (poId) where.push(sql`${schema.loads.id} in (select ${schema.loadLines.loadId} from ${schema.loadLines} where ${schema.loadLines.poId} = ${poId})`);
  if (status === "draft" || status === "billed") where.push(eq(schema.loads.status, status));
  if (q) {
    const t = `%${q.toUpperCase().replace(/[\s-]+/g, "")}%`;
    where.push(or(like(schema.loads.truckNo, t), like(schema.loads.invoiceNo, `%${q}%`))!);
  }

  const rows = await db.select({
    l: schema.loads,
    millCode: schema.merchants.code,
    millName: schema.merchants.name, millNameHi: schema.merchants.nameHi,
    jinsCode: schema.jins.code,
  })
    .from(schema.loads)
    .innerJoin(schema.merchants, eq(schema.merchants.id, schema.loads.merchantId))
    .innerJoin(schema.jins, eq(schema.jins.id, schema.loads.jinsId))
    .where(and(...where))
    .orderBy(desc(schema.loads.loadDate), desc(schema.loads.createdAt))
    // a season is a few hundred trucks; the screens total what they get, so send them all
    .limit(20_000);

  const ids = rows.map((r) => r.l.id);
  const lines = ids.length ? await linesWithWeights(inArray(schema.loadLines.loadId, ids)) : [];
  const jinsCodes = new Map((await db.select({ id: schema.jins.id, code: schema.jins.code }).from(schema.jins).where(eq(schema.jins.businessId, biz))).map((j) => [j.id, j.code]));
  const parchas = ids.length ? await db.select({
    loadId: schema.parchas.loadId, id: schema.parchas.id, parchaNo: schema.parchas.parchaNo,
    version: schema.parchas.version, grandTotalPaise: schema.parchas.grandTotalPaise, status: schema.parchas.status,
  }).from(schema.parchas).where(inArray(schema.parchas.loadId, ids)) : [];
  // the live parcha of each truck, with which approval of the truck it is (2 and up = revised)
  const revs = revisions(parchas);
  const parchaByLoad = new Map(parchas.filter((p) => p.status === "approved").map(({ status: _s, ...p }) => [p.loadId, { ...p, revision: revs.get(p.id)?.revision ?? 1 }]));

  // parcha money (grand total, advance, dara) is for those who may read parchas
  const bills = c.get("auth")!.permissions.has("parcha.read");
  return c.json(rows.map((r) => {
    const mine = lines.filter((x) => x.loadId === r.l.id);
    const p = parchaByLoad.get(r.l.id) ?? null;
    return {
      ...r.l,
      ...(bills ? {} : { advancePaise: null, daraPaise: null }),
      millCode: r.millCode, millName: r.millName, millNameHi: r.millNameHi, jinsCode: r.jinsCode,
      /** Every commodity on the truck's rows, the truck's own first. */
      jinsCodes: [...new Set([r.l.jinsId, ...mine.map((x) => x.jinsId)])].map((j) => jinsCodes.get(j) ?? "?"),
      stockDates: [...new Set(mine.map((x) => x.stockDate))].sort(),
      loadedGrams: mine.reduce((s, x) => s + x.weightGrams, 0),
      parcha: p && !bills ? { ...p, grandTotalPaise: null } : p,
    };
  }));
});

loadRoutes.get("/:id", can("load.read"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const s = await loadState(biz, param(c, "id"));
  if (!s) throw notFound("Load not found");
  const canSeeParcha = c.get("auth")!.permissions.has("parcha.read");
  if (canSeeParcha) return c.json(s);
  // the truck and its rows, without the bill: no totals, charges or mill terms
  const { chargeConfig: _terms, ...mill } = s.mill as typeof s.mill & { chargeConfig?: unknown };
  return c.json({ ...s, mill, doc: null, approved: null, history: [], stale: null, load: { ...s.load, advancePaise: null, daraPaise: null } });
});

/** The mill's stock by purchase day, for picking where a row's weight comes from. */
loadRoutes.get("/:id/stock-days", can("load.read"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const l = await getLoad(biz, param(c, "id"));
  // ?jinsId= for a row that carries another commodity than the truck's own
  const jinsId = c.req.query("jinsId") || l.jinsId;
  if (jinsId !== l.jinsId) await checkJins(biz, jinsId);
  return c.json(await stockDays(biz, l.merchantId, jinsId, l.id));
});

/* ------------------------------------------------------------------- write */

loadRoutes.post("/", can("load.write"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const body = Header.extend({ stockDate: isoDay().optional() }).parse(await c.req.json());
  await assertDaysOpen(biz, body.loadDate);
  const refs = await checkHeaderRefs(biz, body);

  const id = newId();
  const values = {
    id, businessId: biz,
    loadDate: body.loadDate, merchantId: body.merchantId, jinsId: body.jinsId,
    poId: null,
    truckNo: truckNorm(body.truckNo),
    transporter: body.transporter ?? null,
    driverPhone: body.driverPhone ?? null,
    ewayBillNo: body.ewayBillNo ?? null,
    notes: body.notes ?? null,
    invoiceDate: body.loadDate,
    status: "draft",
    createdBy: c.get("auth")!.user.id,
  };
  await db.insert(schema.loads).values(values);
  // the first row: the whole mill net, from the day the owner picked (or the newest with stock)
  const stockDate = body.stockDate ?? await defaultStockDate(biz, body.merchantId, body.jinsId, body.loadDate);
  await db.insert(schema.loadLines).values({
    id: newId(), businessId: biz, loadId: id, jinsId: body.jinsId, poId: body.poId ?? null,
    stockDate, netGrams: null, ratePaisePerQtl: null, sort: 0,
  });
  await audit({ actor: actor(c), action: "load.create", entity: "load", entityId: id,
    entityLabel: `${body.loadDate} ${refs.millCode} ${values.truckNo ?? ""}`.trim(),
    after: { ...values, stockDate } });
  await enqueueSync(biz, "load", id, "insert", values);
  return c.json({ id, stockDate });
});

loadRoutes.put("/:id", can("load.write"), async (c) => {
  const auth = c.get("auth")!;
  const biz = auth.businessId!;
  const id = param(c, "id");
  const before = await getLoad(biz, id);
  assertDraft(before);
  const body = Header.partial().merge(Weighment.partial()).merge(ParchaFields.partial()).parse(await c.req.json());
  await assertDaysOpen(biz, before.loadDate, before.invoiceDate, body.loadDate, body.invoiceDate);

  // a truck with a parcha on record or money against it stays with its mill: moving it
  // would credit one mill's account with another's bill or payment
  if (body.merchantId !== undefined && body.merchantId !== before.merchantId) {
    const [p] = await db.select({ id: schema.parchas.id }).from(schema.parchas).where(eq(schema.parchas.loadId, id)).limit(1);
    const [r] = await db.select({ id: schema.millReceipts.id }).from(schema.millReceipts).where(eq(schema.millReceipts.loadId, id)).limit(1);
    if (p || r) throw new HttpError(409, "This truck has a parcha on record or money received against it, so its mill cannot change. Make a new truck for the other mill.", "load_has_history");
  }
  const touchesParcha = ["invoiceNo", "invoiceDate", "advancePaise", "daraPaise"]
    .some((k) => (body as Record<string, unknown>)[k] !== undefined);
  if (touchesParcha && !auth.permissions.has("parcha.create")) {
    throw new HttpError(403, "You cannot change the parcha's invoice number, advance or dara", "forbidden");
  }

  const header = {
    merchantId: body.merchantId ?? before.merchantId,
    jinsId: body.jinsId ?? before.jinsId,
    // POs live on the rows now; the truck-level field is always cleared
    poId: null as string | null,
  };
  const refs = await checkHeaderRefs(biz, header);

  // another mill: no PO on any row fits any more; another commodity: the rows that
  // carried the old one follow it (rows with their own commodity keep theirs)
  if (header.merchantId !== before.merchantId) {
    await db.update(schema.loadLines).set({ poId: null, updatedAt: nowSec() }).where(eq(schema.loadLines.loadId, id));
  }
  if (header.jinsId !== before.jinsId) {
    await db.update(schema.loadLines).set({ poId: null, jinsId: header.jinsId, updatedAt: nowSec() })
      .where(and(eq(schema.loadLines.loadId, id), eq(schema.loadLines.jinsId, before.jinsId)));
  }

  const pick = <K extends keyof typeof body>(k: K, cur: unknown) => (body[k] === undefined ? cur : (body[k] ?? null));
  const patch = {
    ...header,
    loadDate: body.loadDate ?? before.loadDate,
    truckNo: body.truckNo === undefined ? before.truckNo : truckNorm(body.truckNo),
    transporter: pick("transporter", before.transporter) as string | null,
    driverPhone: pick("driverPhone", before.driverPhone) as string | null,
    ewayBillNo: pick("ewayBillNo", before.ewayBillNo) as string | null,
    notes: pick("notes", before.notes) as string | null,
    millGrossGrams: pick("millGrossGrams", before.millGrossGrams) as number | null,
    katteCount: pick("katteCount", before.katteCount) as number | null,
    boreCount: pick("boreCount", before.boreCount) as number | null,
    katteBardanaGrams: pick("katteBardanaGrams", before.katteBardanaGrams) as number | null,
    boreBardanaGrams: pick("boreBardanaGrams", before.boreBardanaGrams) as number | null,
    invoiceNo: body.invoiceNo === undefined ? before.invoiceNo : (body.invoiceNo?.trim() || null),
    invoiceDate: body.invoiceDate !== undefined ? (body.invoiceDate ?? null)
      : body.loadDate && (before.invoiceDate == null || before.invoiceDate === before.loadDate) ? body.loadDate
      : before.invoiceDate,
    advancePaise: body.advancePaise ?? before.advancePaise,
    daraPaise: body.daraPaise ?? before.daraPaise,
    updatedAt: nowSec(),
  };
  // both bag boxes emptied: the truck has no bags. The stored total goes too, or the
  // weighment would read it as an old truck's katte and bill the bags just cleared.
  const bagsCleared = (body.katteCount !== undefined || body.boreCount !== undefined) && patch.katteCount == null && patch.boreCount == null;
  await db.update(schema.loads).set(bagsCleared ? { ...patch, bags: null } : patch).where(eq(schema.loads.id, id));

  await refreshWeighment(id);

  const [after] = await db.select().from(schema.loads).where(eq(schema.loads.id, id)).limit(1);
  await audit({ actor: actor(c), action: "load.update", entity: "load", entityId: id,
    entityLabel: `${after.loadDate} ${refs.millCode} ${after.truckNo ?? ""}`.trim(), before, after });
  await enqueueSync(biz, "load", id, "update", after);
  return c.json({ ok: true });
});

loadRoutes.post("/:id/lines", can("load.write"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const l = await getLoad(biz, param(c, "id"));
  assertDraft(l);
  await assertDaysOpen(biz, l.loadDate);
  const body = LineBody.parse(await c.req.json());
  const jinsId = body.jinsId ?? l.jinsId;
  if (body.jinsId) await checkJins(biz, jinsId);
  await checkLinePo(biz, { merchantId: l.merchantId, jinsId }, body.poId);
  const [last] = await db.select({ n: sql<number>`coalesce(max(${schema.loadLines.sort}), -1)` })
    .from(schema.loadLines).where(eq(schema.loadLines.loadId, l.id));
  const lid = newId();
  const values = {
    id: lid, businessId: biz, loadId: l.id, jinsId, poId: body.poId ?? null,
    stockDate: body.stockDate, netGrams: body.netGrams ?? null, ratePaisePerQtl: body.ratePaisePerQtl ?? null,
    sort: (last?.n ?? -1) + 1,
  };
  await db.insert(schema.loadLines).values(values);
  await enqueueSync(biz, "load_line", lid, "insert", values);
  await audit({ actor: actor(c), action: "load.add_line", entity: "load", entityId: l.id,
    entityLabel: `${l.loadDate} ${l.truckNo ?? ""}: + ${body.stockDate}`.trim(), after: values });
  return c.json({ id: lid });
});

loadRoutes.put("/:id/lines/:lineId", can("load.write"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const l = await getLoad(biz, param(c, "id"));
  assertDraft(l);
  await assertDaysOpen(biz, l.loadDate);
  const lineId = param(c, "lineId");
  const [before] = await db.select().from(schema.loadLines)
    .where(and(eq(schema.loadLines.id, lineId), eq(schema.loadLines.loadId, l.id))).limit(1);
  if (!before) throw notFound("That row is not on this truck");
  const body = LineBody.partial().parse(await c.req.json());
  const jinsId = body.jinsId ?? before.jinsId;
  if (body.jinsId && body.jinsId !== before.jinsId) await checkJins(biz, jinsId);
  // a row's PO must fit its commodity: a PO given now is checked; one already there is dropped if the commodity moved away from it
  let poId = body.poId === undefined ? before.poId : (body.poId ?? null);
  if (body.poId !== undefined) await checkLinePo(biz, { merchantId: l.merchantId, jinsId }, poId);
  else if (poId && jinsId !== before.jinsId) {
    const [po] = await db.select({ jinsId: schema.purchaseOrders.jinsId }).from(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, poId)).limit(1);
    if (po && po.jinsId !== jinsId) poId = null;
  }
  const patch = {
    stockDate: body.stockDate ?? before.stockDate,
    jinsId,
    poId,
    netGrams: body.netGrams === undefined ? before.netGrams : (body.netGrams ?? null),
    ratePaisePerQtl: body.ratePaisePerQtl === undefined ? before.ratePaisePerQtl : (body.ratePaisePerQtl ?? null),
    updatedAt: nowSec(),
  };
  await db.update(schema.loadLines).set(patch).where(eq(schema.loadLines.id, lineId));
  await enqueueSync(biz, "load_line", lineId, "update", patch);
  await audit({ actor: actor(c), action: "load.update_line", entity: "load", entityId: l.id,
    entityLabel: `${l.loadDate} ${l.truckNo ?? ""}: ${patch.stockDate}`.trim(), before, after: { ...before, ...patch } });
  return c.json({ ok: true });
});

loadRoutes.delete("/:id/lines/:lineId", can("load.write"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const l = await getLoad(biz, param(c, "id"));
  assertDraft(l);
  await assertDaysOpen(biz, l.loadDate);
  const lineId = param(c, "lineId");
  const [before] = await db.select().from(schema.loadLines)
    .where(and(eq(schema.loadLines.id, lineId), eq(schema.loadLines.loadId, l.id))).limit(1);
  if (!before) throw notFound("That row is not on this truck");
  await db.delete(schema.loadLines).where(eq(schema.loadLines.id, lineId));
  await enqueueSync(biz, "load_line", lineId, "delete");
  await audit({ actor: actor(c), action: "load.remove_line", entity: "load", entityId: l.id,
    entityLabel: `${l.loadDate} ${l.truckNo ?? ""}: − ${before.stockDate}`.trim(), before });
  return c.json({ ok: true });
});

loadRoutes.delete("/:id", can("load.delete"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const l = await getLoad(biz, param(c, "id"));
  assertDraft(l);
  await assertDaysOpen(biz, l.loadDate, l.invoiceDate);
  const [p] = await db.select({ id: schema.parchas.id }).from(schema.parchas).where(eq(schema.parchas.loadId, l.id)).limit(1);
  if (p) throw new HttpError(409, "This load has a voided parcha on record, so it is kept.", "load_has_history");
  const [r] = await db.select({ id: schema.millReceipts.id }).from(schema.millReceipts).where(eq(schema.millReceipts.loadId, l.id)).limit(1);
  if (r) throw new HttpError(409, "Money from the mill is recorded against this truck. Move or cancel that receipt first.", "load_has_receipts");
  await db.delete(schema.loads).where(eq(schema.loads.id, l.id));
  await audit({ actor: actor(c), action: "load.delete", entity: "load", entityId: l.id,
    entityLabel: `${l.loadDate} ${l.truckNo ?? ""}`.trim(), before: l });
  await enqueueSync(biz, "load", l.id, "delete");
  return c.json({ ok: true });
});

/* ------------------------------------------------------------------ parcha */

loadRoutes.post("/:id/approve", can("parcha.approve"), async (c) => {
  const auth = c.get("auth")!;
  const biz = auth.businessId!;
  const id = param(c, "id");
  const l = await getLoad(biz, id);
  assertDraft(l);
  const req = z.object({
    invoiceNo: z.string().trim().min(1).max(20).optional(),
    /** The grand total the approver was looking at; a change since then is refused. */
    expectedGrandTotalPaise: z.number().int().optional(),
    /** The approver saw that this number is already on another parcha this year, and keeps it. */
    acceptRepeatedNo: z.boolean().optional(),
  }).parse(await c.req.json().catch(() => ({})));
  if (req.invoiceNo && req.invoiceNo !== (l.invoiceNo ?? "")) {
    await db.update(schema.loads).set({ invoiceNo: req.invoiceNo, updatedAt: nowSec() }).where(eq(schema.loads.id, id));
  }
  const s = await loadState(biz, id);
  if (!s) throw notFound("Load not found");
  if (s.blockers.length || !s.doc) {
    return c.json({ error: "The parcha is not ready to approve", code: "not_ready", blockers: s.blockers }, 409);
  }
  await assertDaysOpen(biz, l.loadDate, s.doc.invoiceDate);
  if (req.expectedGrandTotalPaise !== undefined && req.expectedGrandTotalPaise !== s.doc.result.grandTotalPaise) {
    return c.json({ error: "The parcha changed since you looked at it (someone edited the truck or a slip). Check the new total and approve again.", code: "changed" }, 409);
  }
  const parchaNo = s.doc.invoiceNo!;
  /* A number belongs to one live parcha of the firm in a financial year. The
     same number on another one is a warning the approver answers, never a
     refusal: approving again with acceptRepeatedNo keeps it. */
  const others = await sameNumberElsewhere(biz, parchaNo, s.doc.invoiceDate, id);
  if (others.length && !req.acceptRepeatedNo) {
    return c.json({
      error: `Parcha #${parchaNo} is already on truck ${others.map((o) => o.truckNo ?? "—").join(", ")} this financial year. Use the next number, or approve again to keep #${parchaNo}.`,
      code: "number_repeated", parchaNo, others,
    }, 409);
  }
  // with sync on, the number is claimed in the cloud first (needs the internet), one financial year at a time
  try {
    await claimParchaNumber(biz, parchaNo, s.doc.invoiceDate, id);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Could not reserve the parcha number";
    const offline = e instanceof CloudError && e.offline;
    const elsewhere = !offline && /already used/.test(msg);
    // the shared books hold it for another truck this year (another computer, or a voided parcha): the same warning, and the same answer keeps it
    if (!(elsewhere && req.acceptRepeatedNo)) {
      return c.json({
        error: elsewhere ? `Parcha #${parchaNo} is already used for another truck this financial year, perhaps on another computer. Use the next number, or approve again to keep #${parchaNo}.` : msg,
        code: offline ? "offline" : elsewhere ? "number_repeated" : "cloud", parchaNo, others: [],
      }, 409);
    }
  }

  // the claim waited on the network: look again, and freeze only what is there now
  const now = await loadState(biz, id);
  if (!now || now.load.status !== "draft" || now.blockers.length || !now.doc || now.doc.invoiceNo !== parchaNo
    || now.doc.result.grandTotalPaise !== s.doc.result.grandTotalPaise || JSON.stringify(now.doc.lines) !== JSON.stringify(s.doc.lines)) {
    // a refused approval gives its number back, so no other computer is warned about it
    await releaseParchaNumber(biz, parchaNo, s.doc.invoiceDate, id).catch(() => undefined);
    return c.json({ error: "The truck changed while the parcha number was being reserved. Check it and approve again.", code: "changed" }, 409);
  }
  const s2 = now;
  const pid = newId();
  const at = nowSec();
  // one synchronous transaction: no other request runs between the check and the write
  let frozen: { version: number; doc: ParchaDoc } | null = null;
  try {
    frozen = db.transaction((tx) => {
      const last = tx.select({ v: sql<number>`max(${schema.parchas.version})` }).from(schema.parchas)
        .where(and(eq(schema.parchas.businessId, biz), eq(schema.parchas.parchaNo, parchaNo))).get();
      const version = (last?.v ?? 0) + 1;
      // the truck's earlier (voided) parchas: one or more means this paper is a revised one, dated today
      const before = tx.select({ n: sql<number>`count(*)` }).from(schema.parchas).where(eq(schema.parchas.loadId, id)).get();
      const revision = (before?.n ?? 0) + 1;
      const doc: ParchaDoc = { ...s2.doc!, version, revision, revisedOn: revision > 1 ? new Date().toLocaleDateString("en-CA") : null };
      // the stored mill figures are what stock and PO balances read: make them the billed ones
      const moved = tx.update(schema.loads).set({
        status: "billed", invoiceDate: doc.invoiceDate, updatedAt: at,
        bags: s2.weighment.bags, millBardanaGrams: s2.weighment.bardanaGrams, millNetGrams: s2.weighment.netGrams,
      }).where(and(eq(schema.loads.id, id), eq(schema.loads.status, "draft"))).run();
      if (moved.changes !== 1) return null; // approved a moment ago by another request
      tx.insert(schema.parchas).values({
        id: pid, businessId: biz, loadId: id, parchaNo, version,
        invoiceDate: doc.invoiceDate,
        snapshot: JSON.stringify(doc),
        grandTotalPaise: doc.result.grandTotalPaise,
        status: "approved", approvedBy: auth.user.id, approvedAt: at,
      }).run();
      return { version, doc };
    });
  } catch (e) {
    // the one-approved-parcha-per-truck rule
    if (!/UNIQUE/i.test(String((e as Error).message))) throw e;
  }
  if (!frozen) {
    await releaseParchaNumber(biz, parchaNo, s.doc.invoiceDate, id).catch(() => undefined);
    return c.json({ error: "This truck was approved a moment ago.", code: "already_approved" }, 409);
  }
  const { version, doc } = frozen;
  const revision = doc.revision ?? 1;
  await audit({ actor: actor(c), action: "parcha.approve", entity: "parcha", entityId: pid,
    entityLabel: `Parcha ${parchaNo}${revision > 1 ? ` revised ${revision}` : ""}${others.length ? " (number also on another parcha this year)" : ""} — ${s.mill.code} ${l.truckNo ?? ""}`.trim(),
    after: { parchaNo, version, revision, grandTotalPaise: doc.result.grandTotalPaise, loadId: id, rows: doc.lines.length, repeatedNo: others.length > 0 } });
  await enqueueSync(biz, "parcha", pid, "insert", { id: pid, loadId: id, parchaNo, version });
  return c.json({ id: pid, parchaNo, version, revision, grandTotalPaise: doc.result.grandTotalPaise });
});

/** Excel in the paper's layout. The approved copy when there is one, else a marked draft. */
loadRoutes.get("/:id/parcha.xlsx", can("parcha.read"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const s = await loadState(biz, param(c, "id"));
  if (!s) throw notFound("Load not found");
  const doc = s.approved?.doc ?? s.doc;
  if (!doc) throw bad("Enter the mill weight and bags first — there is no parcha to export yet", "not_ready");
  const buf = await parchaXlsx(doc, { draft: !s.approved });
  const rev = s.approved?.revision ?? doc.revision ?? 1;
  const name = `parcha-${doc.invoiceNo ?? "draft"}${rev > 1 ? `-revised-${rev}` : ""}-${doc.mill.code}-${doc.invoiceDate}.xlsx`;
  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": attachment(name),
    },
  });
});

/** The register of every parcha, approved and voided. */
parchaRoutes.get("/", can("parcha.read"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const where = [eq(schema.parchas.businessId, biz)];
  const from = c.req.query("from");
  const to = c.req.query("to");
  if (from && ISO_DATE.test(from)) where.push(gte(schema.parchas.invoiceDate, from));
  if (to && ISO_DATE.test(to)) where.push(lte(schema.parchas.invoiceDate, to));
  const rows = await db.select({
    id: schema.parchas.id, loadId: schema.parchas.loadId, parchaNo: schema.parchas.parchaNo,
    version: schema.parchas.version, invoiceDate: schema.parchas.invoiceDate,
    grandTotalPaise: schema.parchas.grandTotalPaise, status: schema.parchas.status,
    approvedAt: schema.parchas.approvedAt, voidedAt: schema.parchas.voidedAt, voidReason: schema.parchas.voidReason,
    truckNo: schema.loads.truckNo, millCode: schema.merchants.code, millName: schema.merchants.name, millNameHi: schema.merchants.nameHi,
  })
    .from(schema.parchas)
    .innerJoin(schema.loads, eq(schema.loads.id, schema.parchas.loadId))
    .innerJoin(schema.merchants, eq(schema.merchants.id, schema.loads.merchantId))
    .where(and(...where))
    .orderBy(desc(schema.parchas.invoiceDate), desc(schema.parchas.approvedAt))
    // a season is a few hundred trucks; the screens total what they get, so send them all
    .limit(20_000);
  /* What is due on each live parcha, by the mill statement's own rule
     (settle(): money marked against the truck first, then money on account
     to the oldest parcha), over every bill and receipt of its mill up to the
     register's end date, whatever its start — so a parcha shows the due the
     mill statement to that date shows. With no end date, every date counts. */
  const money = c.get("auth")!.permissions.has("millledger.read");
  const dueOf = new Map<string, DueLine>();
  if (money) {
    const upTo = to && ISO_DATE.test(to) ? to : undefined;
    const allBills = await billed(biz, { upTo });
    const allRecs = await receipts(biz, { upTo });
    const openings = await db.select({ id: schema.merchants.id, o: schema.merchants.openingBalancePaise })
      .from(schema.merchants).where(eq(schema.merchants.businessId, biz));
    for (const m of openings) {
      const b = allBills.filter((x) => x.merchantId === m.id);
      if (!b.length) continue;
      for (const l of settle(m.o, b, allRecs.filter((x) => x.merchantId === m.id)).lines) if (l.loadId) dueOf.set(l.loadId, l);
    }
  }
  // every parcha of the business, whatever the dates: revisions and repeated numbers are worked out over all of them
  const every = await db.select({
    id: schema.parchas.id, loadId: schema.parchas.loadId, parchaNo: schema.parchas.parchaNo, status: schema.parchas.status,
    invoiceDate: schema.parchas.invoiceDate, approvedAt: schema.parchas.approvedAt, version: schema.parchas.version,
  }).from(schema.parchas).where(eq(schema.parchas.businessId, biz));
  const sameNo = sameNumberCount(every);
  const revs = revisions(every);
  return c.json(rows.map((r) => {
    const rev = revs.get(r.id);
    const extra = {
      revision: rev?.revision ?? 1, previousId: rev?.previousId ?? null,
      // the same number on another live parcha of the same financial year: allowed, but shown
      numberRepeated: r.status === "approved" && r.invoiceDate ? (sameNo.get(fyKey(r.invoiceDate, r.parchaNo)) ?? 0) > 1 : false,
    };
    const d = r.status === "approved" ? dueOf.get(r.loadId) : undefined;
    return d && money
      ? { ...r, ...extra, shortagePaise: d.shortagePaise, againstPaise: d.againstPaise, fromAccountPaise: d.fromAccountPaise, receivedPaise: d.againstPaise + d.fromAccountPaise, duePaise: d.duePaise }
      : { ...r, ...extra, shortagePaise: null, againstPaise: null, fromAccountPaise: null, receivedPaise: null, duePaise: null };
  }));
});

/** One parcha version as it was frozen, approved or voided — for viewing and reprinting. */
async function parchaVersion(biz: string, id: string) {
  const [p] = await db.select({ p: schema.parchas, voidedByName: schema.users.name }).from(schema.parchas)
    .leftJoin(schema.users, eq(schema.users.id, schema.parchas.voidedBy))
    .where(and(eq(schema.parchas.id, id), eq(schema.parchas.businessId, biz))).limit(1);
  if (!p) throw notFound("Parcha not found");
  const { snapshot, ...rest } = p.p;
  const same = await db.select({ id: schema.parchas.id, loadId: schema.parchas.loadId }).from(schema.parchas).where(eq(schema.parchas.loadId, rest.loadId));
  const revision = revisions(same).get(rest.id)?.revision ?? 1;
  return { ...rest, revision, voidedByName: p.voidedByName, doc: withRevision(JSON.parse(snapshot) as ParchaDoc, revision) };
}

parchaRoutes.get("/:id", can("parcha.read"), async (c) => {
  return c.json(await parchaVersion(c.get("auth")!.businessId!, param(c, "id")));
});

parchaRoutes.get("/:id/parcha.xlsx", can("parcha.read"), async (c) => {
  const v = await parchaVersion(c.get("auth")!.businessId!, param(c, "id"));
  const buf = await parchaXlsx(v.doc, v.status === "void" ? { voided: v.voidReason ?? "voided" } : {});
  const name = `parcha-${v.parchaNo}${v.revision > 1 ? `-revised-${v.revision}` : ""}${v.status === "void" ? "-VOID" : ""}-${v.doc.mill.code}.xlsx`;
  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": attachment(name),
    },
  });
});

parchaRoutes.post("/:id/void", can("parcha.void"), async (c) => {
  const auth = c.get("auth")!;
  const biz = auth.businessId!;
  const id = param(c, "id");
  const { reason } = z.object({ reason: z.string().trim().min(3, "Say why the parcha is being voided").max(300) })
    .parse(await c.req.json());
  const [p] = await db.select().from(schema.parchas)
    .where(and(eq(schema.parchas.id, id), eq(schema.parchas.businessId, biz))).limit(1);
  if (!p) throw notFound("Parcha not found");
  if (p.status !== "approved") throw new HttpError(409, "This parcha is already void", "already_void");
  await assertDaysOpen(biz, p.invoiceDate);
  const at = nowSec();
  db.transaction((tx) => {
    tx.update(schema.parchas).set({ status: "void", voidedBy: auth.user.id, voidedAt: at, voidReason: reason })
      .where(eq(schema.parchas.id, id)).run();
    tx.update(schema.loads).set({ status: "draft", updatedAt: at }).where(eq(schema.loads.id, p.loadId)).run();
  });
  // back to a draft: its stored mill figures follow today's terms again, as any draft's do (the same rule sync uses)
  repairTrucks([p.loadId], { audit: false });
  const rev = revisions(await db.select({ id: schema.parchas.id, loadId: schema.parchas.loadId }).from(schema.parchas).where(eq(schema.parchas.loadId, p.loadId))).get(id)?.revision ?? 1;
  await audit({ actor: actor(c), action: "parcha.void", entity: "parcha", entityId: id,
    entityLabel: `Parcha ${p.parchaNo}${rev > 1 ? ` revised ${rev}` : ""}`,
    before: { status: "approved" }, after: { status: "void", reason } });
  await enqueueSync(biz, "parcha", id, "update", { status: "void" });
  return c.json({ ok: true });
});
