import { Hono } from "hono";
import { z } from "zod";
import { eq, and, desc, asc, sql, inArray, isNull, gte, lte, like, or } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { newId, nowSec } from "../lib/ids.ts";
import { audit, enqueueSync } from "../lib/audit.ts";
import { ChargeConfigSchema } from "../lib/charges.ts";
import { loadState, storedWeighment, stockDays, linesWithWeights, type ParchaDoc } from "../lib/parcha.ts";
import { parchaXlsx } from "../lib/parchaXlsx.ts";
import { poLabel } from "./orders.ts";
import { can, actor, param, notFound, bad, HttpError, attachment, isoDay, LIMIT, type Env } from "../lib/http.ts";

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
  poId: z.string().nullish(),
  /** grams; null = the rest of the mill's net */
  netGrams: z.number().int().min(1, "Weight must be more than zero").max(LIMIT.grams, "Weight is too large — check the decimal point").nullish(),
  /** null = that day's average rate */
  ratePaisePerQtl: z.number().int().min(1).max(LIMIT.rate, "Rate is too large — check the decimal point").nullish(),
});

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
    millName: schema.merchants.name,
    jinsCode: schema.jins.code,
  })
    .from(schema.loads)
    .innerJoin(schema.merchants, eq(schema.merchants.id, schema.loads.merchantId))
    .innerJoin(schema.jins, eq(schema.jins.id, schema.loads.jinsId))
    .where(and(...where))
    .orderBy(desc(schema.loads.loadDate), desc(schema.loads.createdAt))
    .limit(500);

  const ids = rows.map((r) => r.l.id);
  const lines = ids.length ? await linesWithWeights(inArray(schema.loadLines.loadId, ids)) : [];
  const parchas = ids.length ? await db.select({
    loadId: schema.parchas.loadId, id: schema.parchas.id, parchaNo: schema.parchas.parchaNo,
    version: schema.parchas.version, grandTotalPaise: schema.parchas.grandTotalPaise,
  }).from(schema.parchas).where(and(inArray(schema.parchas.loadId, ids), eq(schema.parchas.status, "approved"))) : [];
  const parchaByLoad = new Map(parchas.map((p) => [p.loadId, p]));

  return c.json(rows.map((r) => {
    const mine = lines.filter((x) => x.loadId === r.l.id);
    return {
      ...r.l,
      millCode: r.millCode, millName: r.millName, jinsCode: r.jinsCode,
      stockDates: [...new Set(mine.map((x) => x.stockDate))].sort(),
      loadedGrams: mine.reduce((s, x) => s + x.weightGrams, 0),
      parcha: parchaByLoad.get(r.l.id) ?? null,
    };
  }));
});

loadRoutes.get("/:id", can("load.read"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const s = await loadState(biz, param(c, "id"));
  if (!s) throw notFound("Load not found");
  const canSeeParcha = c.get("auth")!.permissions.has("parcha.read");
  return c.json(canSeeParcha ? s : { ...s, doc: null, approved: null, history: [] });
});

/** The mill's stock by purchase day, for picking where a row's weight comes from. */
loadRoutes.get("/:id/stock-days", can("load.read"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const l = await getLoad(biz, param(c, "id"));
  return c.json(await stockDays(biz, l.merchantId, l.jinsId, l.id));
});

/* ------------------------------------------------------------------- write */

loadRoutes.post("/", can("load.write"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const body = Header.extend({ stockDate: isoDay().optional() }).parse(await c.req.json());
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

  // rows follow the truck's commodity; a PO on a row must fit the new mill and commodity
  if (header.merchantId !== before.merchantId || header.jinsId !== before.jinsId) {
    await db.update(schema.loadLines).set({ poId: null, jinsId: header.jinsId, updatedAt: nowSec() })
      .where(eq(schema.loadLines.loadId, id));
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
  await db.update(schema.loads).set(patch).where(eq(schema.loads.id, id));

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
  const body = LineBody.parse(await c.req.json());
  await checkLinePo(biz, l, body.poId);
  const [last] = await db.select({ n: sql<number>`coalesce(max(${schema.loadLines.sort}), -1)` })
    .from(schema.loadLines).where(eq(schema.loadLines.loadId, l.id));
  const lid = newId();
  const values = {
    id: lid, businessId: biz, loadId: l.id, jinsId: l.jinsId, poId: body.poId ?? null,
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
  const lineId = param(c, "lineId");
  const [before] = await db.select().from(schema.loadLines)
    .where(and(eq(schema.loadLines.id, lineId), eq(schema.loadLines.loadId, l.id))).limit(1);
  if (!before) throw notFound("That row is not on this truck");
  const body = LineBody.partial().parse(await c.req.json());
  if (body.poId !== undefined) await checkLinePo(biz, l, body.poId);
  const patch = {
    stockDate: body.stockDate ?? before.stockDate,
    poId: body.poId === undefined ? before.poId : (body.poId ?? null),
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
  const [p] = await db.select({ id: schema.parchas.id }).from(schema.parchas).where(eq(schema.parchas.loadId, l.id)).limit(1);
  if (p) throw new HttpError(409, "This load has a voided parcha on record, so it is kept.", "load_has_history");
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
  }).parse(await c.req.json().catch(() => ({})));
  if (req.invoiceNo && req.invoiceNo !== (l.invoiceNo ?? "")) {
    await db.update(schema.loads).set({ invoiceNo: req.invoiceNo, updatedAt: nowSec() }).where(eq(schema.loads.id, id));
  }
  const s = await loadState(biz, id);
  if (!s) throw notFound("Load not found");
  if (s.blockers.length || !s.doc) {
    return c.json({ error: "The parcha is not ready to approve", code: "not_ready", blockers: s.blockers }, 409);
  }
  if (req.expectedGrandTotalPaise !== undefined && req.expectedGrandTotalPaise !== s.doc.result.grandTotalPaise) {
    return c.json({ error: "The parcha changed since you looked at it (someone edited the truck or a slip). Check the new total and approve again.", code: "changed" }, 409);
  }
  const parchaNo = s.doc.invoiceNo!;
  const [last] = await db.select({ v: sql<number>`max(${schema.parchas.version})` }).from(schema.parchas)
    .where(and(eq(schema.parchas.businessId, biz), eq(schema.parchas.parchaNo, parchaNo)));
  const version = (last?.v ?? 0) + 1;
  const doc: ParchaDoc = { ...s.doc, version };

  const pid = newId();
  const at = nowSec();
  db.transaction((tx) => {
    tx.insert(schema.parchas).values({
      id: pid, businessId: biz, loadId: id, parchaNo, version,
      invoiceDate: doc.invoiceDate,
      snapshot: JSON.stringify(doc),
      grandTotalPaise: doc.result.grandTotalPaise,
      status: "approved", approvedBy: auth.user.id, approvedAt: at,
    }).run();
    // the stored mill figures are what stock and PO balances read: make them the billed ones
    tx.update(schema.loads).set({
      status: "billed", invoiceDate: doc.invoiceDate, updatedAt: at,
      bags: s.weighment.bags, millBardanaGrams: s.weighment.bardanaGrams, millNetGrams: s.weighment.netGrams,
    })
      .where(eq(schema.loads.id, id)).run();
  });
  await audit({ actor: actor(c), action: "parcha.approve", entity: "parcha", entityId: pid,
    entityLabel: `Parcha ${parchaNo}${version > 1 ? ` v${version}` : ""} — ${s.mill.code} ${l.truckNo ?? ""}`.trim(),
    after: { parchaNo, version, grandTotalPaise: doc.result.grandTotalPaise, loadId: id, rows: doc.lines.length } });
  await enqueueSync(biz, "parcha", pid, "insert", { id: pid, loadId: id, parchaNo, version });
  return c.json({ id: pid, parchaNo, version, grandTotalPaise: doc.result.grandTotalPaise });
});

/** Excel in the paper's layout. The approved copy when there is one, else a marked draft. */
loadRoutes.get("/:id/parcha.xlsx", can("parcha.read"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const s = await loadState(biz, param(c, "id"));
  if (!s) throw notFound("Load not found");
  const doc = s.approved?.doc ?? s.doc;
  if (!doc) throw bad("Enter the mill weight and bags first — there is no parcha to export yet", "not_ready");
  const buf = await parchaXlsx(doc, { draft: !s.approved });
  const name = `parcha-${doc.invoiceNo ?? "draft"}-${doc.mill.code}-${doc.invoiceDate}.xlsx`;
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
    truckNo: schema.loads.truckNo, millCode: schema.merchants.code, millName: schema.merchants.name,
  })
    .from(schema.parchas)
    .innerJoin(schema.loads, eq(schema.loads.id, schema.parchas.loadId))
    .innerJoin(schema.merchants, eq(schema.merchants.id, schema.loads.merchantId))
    .where(and(...where))
    .orderBy(desc(schema.parchas.invoiceDate), desc(schema.parchas.approvedAt))
    .limit(500);
  // money the mill has sent against each truck (cancelled receipts count for nothing)
  const R = schema.millReceipts;
  const loadIds = [...new Set(rows.map((r) => r.loadId))];
  const got = loadIds.length
    ? await db.select({ loadId: R.loadId, p: sql<number>`sum(${R.amountPaise} + ${R.deductionPaise})` }).from(R)
      .where(and(inArray(R.loadId, loadIds), isNull(R.voidedAt))).groupBy(R.loadId)
    : [];
  const gotBy = new Map(got.map((g) => [g.loadId, g.p]));
  // the mill's weight cut, valued as the mill account values it
  const { billed } = await import("./millAccounts.ts");
  const cut = new Map((await billed(biz)).map((b) => [b.id, b.shortagePaise]));
  return c.json(rows.map((r) => r.status === "approved"
    ? { ...r, shortagePaise: cut.get(r.id) ?? 0, receivedPaise: gotBy.get(r.loadId) ?? 0, duePaise: r.grandTotalPaise - (cut.get(r.id) ?? 0) - (gotBy.get(r.loadId) ?? 0) }
    : { ...r, shortagePaise: null, receivedPaise: null, duePaise: null }));
});

/** One parcha version as it was frozen, approved or voided — for viewing and reprinting. */
async function parchaVersion(biz: string, id: string) {
  const [p] = await db.select({ p: schema.parchas, voidedByName: schema.users.name }).from(schema.parchas)
    .leftJoin(schema.users, eq(schema.users.id, schema.parchas.voidedBy))
    .where(and(eq(schema.parchas.id, id), eq(schema.parchas.businessId, biz))).limit(1);
  if (!p) throw notFound("Parcha not found");
  const { snapshot, ...rest } = p.p;
  return { ...rest, voidedByName: p.voidedByName, doc: JSON.parse(snapshot) as ParchaDoc };
}

parchaRoutes.get("/:id", can("parcha.read"), async (c) => {
  return c.json(await parchaVersion(c.get("auth")!.businessId!, param(c, "id")));
});

parchaRoutes.get("/:id/parcha.xlsx", can("parcha.read"), async (c) => {
  const v = await parchaVersion(c.get("auth")!.businessId!, param(c, "id"));
  const buf = await parchaXlsx(v.doc, v.status === "void" ? { voided: v.voidReason ?? "voided" } : {});
  const name = `parcha-${v.parchaNo}${v.version > 1 ? `-v${v.version}` : ""}${v.status === "void" ? "-VOID" : ""}-${v.doc.mill.code}.xlsx`;
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
  const at = nowSec();
  db.transaction((tx) => {
    tx.update(schema.parchas).set({ status: "void", voidedBy: auth.user.id, voidedAt: at, voidReason: reason })
      .where(eq(schema.parchas.id, id)).run();
    tx.update(schema.loads).set({ status: "draft", updatedAt: at }).where(eq(schema.loads.id, p.loadId)).run();
  });
  await audit({ actor: actor(c), action: "parcha.void", entity: "parcha", entityId: id,
    entityLabel: `Parcha ${p.parchaNo}${p.version > 1 ? ` v${p.version}` : ""}`,
    before: { status: "approved" }, after: { status: "void", reason } });
  await enqueueSync(biz, "parcha", id, "update", { status: "void" });
  return c.json({ ok: true });
});
