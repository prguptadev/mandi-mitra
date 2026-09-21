import { Hono } from "hono";
import { z } from "zod";
import { eq, and, desc, asc, sql, inArray, isNull, gte, lte, like, or } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { newId, nowSec } from "../lib/ids.ts";
import { audit, enqueueSync } from "../lib/audit.ts";
import { ChargeConfigSchema } from "../lib/charges.ts";
import { loadState, storedWeighment, type ParchaDoc } from "../lib/parcha.ts";
import { parchaXlsx } from "../lib/parchaXlsx.ts";
import { katautiCfg, deriveSlip } from "./slips.ts";
import { can, actor, param, notFound, bad, HttpError, type Env } from "../lib/http.ts";

/* A load is one truck to one mill. Slips from the daily list are put on it —
   each slip on exactly one load, ever — the mill's weighbridge reading is
   entered when it comes back, and approving it freezes the kaccha parcha.
   Once approved, the load and its slips are locked until the parcha is voided. */

export const loadRoutes = new Hono<Env>();
export const parchaRoutes = new Hono<Env>();

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const gramsOrNull = z.number().int().min(0).nullish();

const Header = z.object({
  loadDate: z.string().regex(ISO_DATE, "Date must be YYYY-MM-DD"),
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
  katteCount: z.number().int().min(0).nullish(),
  boreCount: z.number().int().min(0).nullish(),
  katteBardanaGrams: gramsOrNull,
  boreBardanaGrams: gramsOrNull,
});

const ParchaFields = z.object({
  invoiceNo: z.string().trim().max(20).nullish(),
  invoiceDate: z.string().regex(ISO_DATE).nullish(),
  advancePaise: z.number().int().min(0),
  daraPaise: z.number().int().min(0),
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
    if (p.merchantId !== h.merchantId) throw bad(`PO ${p.poNo} is for another mill`, "po_mill");
    if (p.jinsId !== h.jinsId) throw bad(`PO ${p.poNo} is for another commodity`, "po_jins");
  }
  return { millCode: m.code, jinsCode: j.code };
}

/**
 * Put slips on a load. The update only touches slips with no load, inside one
 * transaction, so two people allocating the same slip cannot both succeed.
 * A slip moved here takes this load's mill, and its katauti is re-derived on
 * that mill's terms, the same as the daily list's "move to mill".
 */
async function allocate(biz: string, load: { id: string; merchantId: string; jinsId: string }, slipIds: string[]) {
  const ids = [...new Set(slipIds)];
  const slips = ids.length ? await db.select({
    s: schema.purchaseSlips,
    otherTruck: schema.loads.truckNo,
    otherDate: schema.loads.loadDate,
    jinsCode: schema.jins.code,
  })
    .from(schema.purchaseSlips)
    .innerJoin(schema.jins, eq(schema.jins.id, schema.purchaseSlips.jinsId))
    .leftJoin(schema.loads, eq(schema.loads.id, schema.purchaseSlips.loadId))
    .where(and(eq(schema.purchaseSlips.businessId, biz), inArray(schema.purchaseSlips.id, ids))) : [];
  if (slips.length !== ids.length) throw bad("Some slips were not found", "missing");

  const [j] = await db.select({ code: schema.jins.code }).from(schema.jins).where(eq(schema.jins.id, load.jinsId)).limit(1);
  const wrongJins = slips.filter((r) => r.s.jinsId !== load.jinsId);
  if (wrongJins.length) {
    throw new HttpError(409,
      `RST ${wrongJins.map((r) => r.s.rstNo).join(", ")} ${wrongJins.length === 1 ? "is" : "are"} ${wrongJins[0].jinsCode}; this load is ${j.code}. A truck carries one commodity.`,
      "wrong_jins");
  }

  const elsewhere = slips.filter((r) => r.s.loadId && r.s.loadId !== load.id)
    .map((r) => ({ rstNo: r.s.rstNo, loadId: r.s.loadId!, truckNo: r.otherTruck, loadDate: r.otherDate }));
  // slips already on this load are re-derived too (the load's mill may have changed)
  const free = slips.filter((r) => !r.s.loadId || r.s.loadId === load.id).map((r) => r.s);

  const cfg = await katautiCfg(biz, load.merchantId);
  const derived = free.map((s) => ({
    s, d: deriveSlip(s.grossGrams, cfg, s.ratePaisePerQtl, s.katautiOverride ? s.katautiUnits : null),
  }));

  let added = 0;
  db.transaction((tx) => {
    for (const { s, d } of derived) {
      const r = tx.update(schema.purchaseSlips).set({
        loadId: load.id, merchantId: load.merchantId,
        katautiUnits: d.katautiUnits, netGrams: d.netGrams, amountPaise: d.amountPaise,
        updatedAt: nowSec(),
      }).where(and(
        eq(schema.purchaseSlips.id, s.id),
        or(isNull(schema.purchaseSlips.loadId), eq(schema.purchaseSlips.loadId, load.id)),
      )).run();
      if (r.changes && s.loadId !== load.id) added++;
    }
  });
  return { added, elsewhere, moved: free.filter((s) => s.merchantId !== load.merchantId).length };
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
  if (poId) where.push(eq(schema.loads.poId, poId));
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
    poNo: schema.purchaseOrders.poNo,
  })
    .from(schema.loads)
    .innerJoin(schema.merchants, eq(schema.merchants.id, schema.loads.merchantId))
    .innerJoin(schema.jins, eq(schema.jins.id, schema.loads.jinsId))
    .leftJoin(schema.purchaseOrders, eq(schema.purchaseOrders.id, schema.loads.poId))
    .where(and(...where))
    .orderBy(desc(schema.loads.loadDate), desc(schema.loads.createdAt))
    .limit(500);

  const ids = rows.map((r) => r.l.id);
  const agg = ids.length ? await db.select({
    loadId: schema.purchaseSlips.loadId,
    n: sql<number>`count(*)`,
    net: sql<number>`sum(${schema.purchaseSlips.netGrams})`,
    amount: sql<number>`sum(${schema.purchaseSlips.amountPaise})`,
    pricedNet: sql<number>`sum(case when ${schema.purchaseSlips.ratePaisePerQtl} > 0 then ${schema.purchaseSlips.netGrams} else 0 end)`,
    pricedValue: sql<number>`sum(case when ${schema.purchaseSlips.ratePaisePerQtl} > 0 then ${schema.purchaseSlips.netGrams} * ${schema.purchaseSlips.ratePaisePerQtl} else 0 end)`,
  }).from(schema.purchaseSlips).where(inArray(schema.purchaseSlips.loadId, ids)).groupBy(schema.purchaseSlips.loadId) : [];
  const byLoad = new Map(agg.map((a) => [a.loadId, a]));

  const parchas = ids.length ? await db.select({
    loadId: schema.parchas.loadId, id: schema.parchas.id, parchaNo: schema.parchas.parchaNo,
    version: schema.parchas.version, grandTotalPaise: schema.parchas.grandTotalPaise,
  }).from(schema.parchas).where(and(inArray(schema.parchas.loadId, ids), eq(schema.parchas.status, "approved"))) : [];
  const parchaByLoad = new Map(parchas.map((p) => [p.loadId, p]));

  return c.json(rows.map((r) => {
    const a = byLoad.get(r.l.id);
    const slipNet = a?.net ?? 0;
    return {
      ...r.l,
      millCode: r.millCode, millName: r.millName, jinsCode: r.jinsCode, poNo: r.poNo,
      slips: a?.n ?? 0,
      slipNetGrams: slipNet,
      slipAmountPaise: a?.amount ?? 0,
      avgRatePaisePerQtl: a && a.pricedNet ? Math.floor(a.pricedValue / a.pricedNet + 0.5) : 0,
      diffGrams: r.l.millNetGrams == null ? null : slipNet - r.l.millNetGrams,
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

/** Slips that could go on this load: same commodity, not on any load yet. */
loadRoutes.get("/:id/candidates", can("load.read"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const l = await getLoad(biz, param(c, "id"));
  const date = c.req.query("date");
  const mill = c.req.query("mill") ?? "this"; // this | all | none
  const where = [
    eq(schema.purchaseSlips.businessId, biz),
    eq(schema.purchaseSlips.jinsId, l.jinsId),
    isNull(schema.purchaseSlips.loadId),
  ];
  if (date && ISO_DATE.test(date)) where.push(eq(schema.purchaseSlips.slipDate, date));
  if (mill === "this") where.push(eq(schema.purchaseSlips.merchantId, l.merchantId));
  if (mill === "none") where.push(isNull(schema.purchaseSlips.merchantId));

  const rows = await db.select({
    id: schema.purchaseSlips.id,
    slipDate: schema.purchaseSlips.slipDate,
    rstNo: schema.purchaseSlips.rstNo,
    adatiNameHi: schema.adati.nameHi,
    adatiNameHinglish: schema.adati.nameHinglish,
    merchantId: schema.purchaseSlips.merchantId,
    merchantCode: schema.merchants.code,
    grossGrams: schema.purchaseSlips.grossGrams,
    katautiUnits: schema.purchaseSlips.katautiUnits,
    netGrams: schema.purchaseSlips.netGrams,
    ratePaisePerQtl: schema.purchaseSlips.ratePaisePerQtl,
    amountPaise: schema.purchaseSlips.amountPaise,
  })
    .from(schema.purchaseSlips)
    .innerJoin(schema.adati, eq(schema.adati.id, schema.purchaseSlips.adatiId))
    .leftJoin(schema.merchants, eq(schema.merchants.id, schema.purchaseSlips.merchantId))
    .where(and(...where))
    .orderBy(desc(schema.purchaseSlips.slipDate), asc(schema.purchaseSlips.createdAt))
    .limit(1000);

  // the days that have free slips, so the picker can offer them
  const days = await db.select({
    slipDate: schema.purchaseSlips.slipDate,
    n: sql<number>`count(*)`,
  }).from(schema.purchaseSlips)
    .where(and(eq(schema.purchaseSlips.businessId, biz), eq(schema.purchaseSlips.jinsId, l.jinsId), isNull(schema.purchaseSlips.loadId)))
    .groupBy(schema.purchaseSlips.slipDate).orderBy(desc(schema.purchaseSlips.slipDate)).limit(60);

  return c.json({ rows, days });
});

/* ------------------------------------------------------------------- write */

loadRoutes.post("/", can("load.write"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const body = Header.extend({ slipIds: z.array(z.string()).optional() }).parse(await c.req.json());
  const refs = await checkHeaderRefs(biz, body);

  const id = newId();
  const values = {
    id, businessId: biz,
    loadDate: body.loadDate, merchantId: body.merchantId, jinsId: body.jinsId,
    poId: body.poId ?? null,
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
  let allocation = null;
  if (body.slipIds?.length) allocation = await allocate(biz, { id, merchantId: body.merchantId, jinsId: body.jinsId }, body.slipIds);
  await audit({ actor: actor(c), action: "load.create", entity: "load", entityId: id,
    entityLabel: `${body.loadDate} ${refs.millCode} ${values.truckNo ?? ""}`.trim(),
    after: { ...values, slipsAdded: allocation?.added ?? 0 } });
  await enqueueSync(biz, "load", id, "insert", values);
  return c.json({ id, allocation });
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
    poId: body.poId === undefined ? before.poId : (body.poId ?? null),
  };
  const refs = await checkHeaderRefs(biz, header);

  if (header.jinsId !== before.jinsId || header.merchantId !== before.merchantId) {
    const [n] = await db.select({ n: sql<number>`count(*)` }).from(schema.purchaseSlips).where(eq(schema.purchaseSlips.loadId, id));
    if (header.jinsId !== before.jinsId && n.n > 0) {
      throw new HttpError(409, "Remove the slips before changing this load's commodity", "load_has_slips");
    }
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
    invoiceDate: pick("invoiceDate", before.invoiceDate) as string | null,
    advancePaise: body.advancePaise ?? before.advancePaise,
    daraPaise: body.daraPaise ?? before.daraPaise,
    updatedAt: nowSec(),
  };
  await db.update(schema.loads).set(patch).where(eq(schema.loads.id, id));

  // a changed mill moves every slip on the load with it (and re-derives katauti)
  if (header.merchantId !== before.merchantId) {
    const slips = await db.select({ id: schema.purchaseSlips.id }).from(schema.purchaseSlips).where(eq(schema.purchaseSlips.loadId, id));
    if (slips.length) await allocate(biz, { id, merchantId: header.merchantId, jinsId: header.jinsId }, slips.map((s) => s.id));
  }
  await refreshWeighment(id);

  const [after] = await db.select().from(schema.loads).where(eq(schema.loads.id, id)).limit(1);
  await audit({ actor: actor(c), action: "load.update", entity: "load", entityId: id,
    entityLabel: `${after.loadDate} ${refs.millCode} ${after.truckNo ?? ""}`.trim(), before, after });
  await enqueueSync(biz, "load", id, "update", after);
  return c.json({ ok: true });
});

loadRoutes.post("/:id/slips", can("load.write"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const l = await getLoad(biz, param(c, "id"));
  assertDraft(l);
  const { slipIds } = z.object({ slipIds: z.array(z.string()).min(1, "Pick at least one slip") }).parse(await c.req.json());
  const r = await allocate(biz, l, slipIds);
  await refreshWeighment(l.id);
  await audit({ actor: actor(c), action: "load.add_slips", entity: "load", entityId: l.id,
    entityLabel: `${l.loadDate} ${l.truckNo ?? ""}: +${r.added} slips`.trim(),
    after: { slipIds, added: r.added, elsewhere: r.elsewhere } });
  return c.json(r);
});

loadRoutes.delete("/:id/slips", can("load.write"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const l = await getLoad(biz, param(c, "id"));
  assertDraft(l);
  const { slipIds } = z.object({ slipIds: z.array(z.string()).min(1) }).parse(await c.req.json());
  const r = db.update(schema.purchaseSlips).set({ loadId: null, updatedAt: nowSec() })
    .where(and(eq(schema.purchaseSlips.loadId, l.id), inArray(schema.purchaseSlips.id, slipIds))).run();
  await refreshWeighment(l.id);
  await audit({ actor: actor(c), action: "load.remove_slips", entity: "load", entityId: l.id,
    entityLabel: `${l.loadDate} ${l.truckNo ?? ""}: -${r.changes} slips`.trim(), after: { slipIds, removed: r.changes } });
  return c.json({ removed: r.changes });
});

loadRoutes.delete("/:id", can("load.delete"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const l = await getLoad(biz, param(c, "id"));
  assertDraft(l);
  const [p] = await db.select({ id: schema.parchas.id }).from(schema.parchas).where(eq(schema.parchas.loadId, l.id)).limit(1);
  if (p) throw new HttpError(409, "This load has a voided parcha on record, so it is kept. Remove its slips instead.", "load_has_history");
  const freed = db.update(schema.purchaseSlips).set({ loadId: null, updatedAt: nowSec() })
    .where(eq(schema.purchaseSlips.loadId, l.id)).run();
  await db.delete(schema.loads).where(eq(schema.loads.id, l.id));
  await audit({ actor: actor(c), action: "load.delete", entity: "load", entityId: l.id,
    entityLabel: `${l.loadDate} ${l.truckNo ?? ""}`.trim(), before: { ...l, slipsFreed: freed.changes } });
  await enqueueSync(biz, "load", l.id, "delete");
  return c.json({ ok: true, slipsFreed: freed.changes });
});

/* ------------------------------------------------------------------ parcha */

loadRoutes.post("/:id/approve", can("parcha.approve"), async (c) => {
  const auth = c.get("auth")!;
  const biz = auth.businessId!;
  const id = param(c, "id");
  const l = await getLoad(biz, id);
  assertDraft(l);
  const s = await loadState(biz, id);
  if (!s) throw notFound("Load not found");
  if (s.blockers.length || !s.doc) {
    return c.json({ error: "The parcha is not ready to approve", code: "not_ready", blockers: s.blockers }, 409);
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
    tx.update(schema.loads).set({ status: "billed", invoiceDate: doc.invoiceDate, updatedAt: at })
      .where(eq(schema.loads.id, id)).run();
    tx.update(schema.purchaseSlips).set({ status: "billed", updatedAt: at })
      .where(eq(schema.purchaseSlips.loadId, id)).run();
  });
  await audit({ actor: actor(c), action: "parcha.approve", entity: "parcha", entityId: pid,
    entityLabel: `Parcha ${parchaNo}${version > 1 ? ` v${version}` : ""} — ${s.mill.code} ${l.truckNo ?? ""}`.trim(),
    after: { parchaNo, version, grandTotalPaise: doc.result.grandTotalPaise, loadId: id, slips: doc.slips.count } });
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
      "Content-Disposition": `attachment; filename="${name}"`,
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
  return c.json(rows);
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
    tx.update(schema.purchaseSlips).set({ status: "open", updatedAt: at }).where(eq(schema.purchaseSlips.loadId, p.loadId)).run();
  });
  await audit({ actor: actor(c), action: "parcha.void", entity: "parcha", entityId: id,
    entityLabel: `Parcha ${p.parchaNo}${p.version > 1 ? ` v${p.version}` : ""}`,
    before: { status: "approved" }, after: { status: "void", reason } });
  await enqueueSync(biz, "parcha", id, "update", { status: "void" });
  return c.json({ ok: true });
});
