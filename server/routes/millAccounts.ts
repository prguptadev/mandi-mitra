import { Hono } from "hono";
import { z } from "zod";
import { eq, and, gte, lte, lt, desc, sql, isNull, inArray } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { newId, nowSec } from "../lib/ids.ts";
import { audit, enqueueSync } from "../lib/audit.ts";
import { can, actor, param, notFound, bad, isoDay, LIMIT, HttpError, type Env } from "../lib/http.ts";
import { amountPaise } from "../lib/money.ts";
import type { ParchaDoc } from "../lib/parcha.ts";

/* The mill side of the money, Tally-style, like the supplier ledger:
     what a mill owes us = its opening + every approved kaccha parcha (grand
     total, on its invoice date) − every receipt (money in + anything the mill
     held back and we accepted, such as TDS or a shortage claim).
   Positive = the mill owes us (लेना). A voided parcha or a cancelled receipt
   counts for nothing. Nothing is stored as a balance: it is summed each time. */

export const millLedgerRoutes = new Hono<Env>();
export const millReceiptRoutes = new Hono<Env>();

export const RECEIPT_MODES = ["bank", "rtgs", "cheque", "upi", "cash"] as const;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const Pa = schema.parchas;
const L = schema.loads;
const R = schema.millReceipts;
/** A parcha counts on its invoice date, else on the truck's load date. */
const billDay = sql<string>`coalesce(${Pa.invoiceDate}, ${L.loadDate})`;

type Range = { merchantId?: string; before?: string; upTo?: string; from?: string; to?: string };

/** Approved parchas, one row each. */
export async function billed(biz: string, r: Range = {}) {
  const w = [eq(Pa.businessId, biz), eq(Pa.status, "approved")];
  if (r.merchantId) w.push(eq(L.merchantId, r.merchantId));
  if (r.before) w.push(sql`${billDay} < ${r.before}`);
  if (r.upTo) w.push(sql`${billDay} <= ${r.upTo}`);
  if (r.from) w.push(sql`${billDay} >= ${r.from}`);
  if (r.to) w.push(sql`${billDay} <= ${r.to}`);
  const rows = await db.select({
    id: Pa.id, parchaNo: Pa.parchaNo, version: Pa.version, loadId: Pa.loadId, merchantId: L.merchantId,
    date: billDay, grandTotalPaise: Pa.grandTotalPaise, truckNo: L.truckNo, netGrams: L.millNetGrams,
    createdAt: Pa.createdAt, deductionGrams: L.millDeductionGrams, deductionNote: L.millDeductionNote, snapshot: Pa.snapshot,
  }).from(Pa).innerJoin(L, eq(L.id, Pa.loadId)).where(and(...w));
  /* Weight the mill cut on arrival lowers what it owes: the cut, at the rate
     the parcha billed the goods (the challan screen shows the same figure). */
  return rows.map(({ snapshot, ...r }) => {
    const rate = r.deductionGrams ? (JSON.parse(snapshot) as ParchaDoc).totals.ratePaisePerQtl : 0;
    return { ...r, deductionRatePaisePerQtl: rate, shortagePaise: r.deductionGrams ? amountPaise(r.deductionGrams, rate) : 0 };
  });
}

/** Receipts that count (not cancelled), one row each. */
export async function receipts(biz: string, r: Range & { withVoid?: boolean } = {}) {
  const w = [eq(R.businessId, biz)];
  if (!r.withVoid) w.push(isNull(R.voidedAt));
  if (r.merchantId) w.push(eq(R.merchantId, r.merchantId));
  if (r.before) w.push(lt(R.receiptDate, r.before));
  if (r.upTo) w.push(lte(R.receiptDate, r.upTo));
  if (r.from) w.push(gte(R.receiptDate, r.from));
  if (r.to) w.push(lte(R.receiptDate, r.to));
  return db.select().from(R).where(and(...w));
}

const settled = (x: { amountPaise: number; deductionPaise: number }) => x.amountPaise + x.deductionPaise;

/** Every mill: opening, billed, received, held back, and what it still owes. */
export async function millBalances(biz: string, asOf?: string) {
  const mills = await db.select({
    id: schema.merchants.id, code: schema.merchants.code, name: schema.merchants.name, nameHi: schema.merchants.nameHi,
    active: schema.merchants.active, openingBalancePaise: schema.merchants.openingBalancePaise,
  }).from(schema.merchants).where(eq(schema.merchants.businessId, biz));
  const bills = await billed(biz, { upTo: asOf });
  const recs = await receipts(biz, { upTo: asOf });
  const rows = mills.map((m) => {
    const b = bills.filter((x) => x.merchantId === m.id);
    const r = recs.filter((x) => x.merchantId === m.id);
    const billedPaise = b.reduce((s, x) => s + x.grandTotalPaise, 0);
    const shortagePaise = b.reduce((s, x) => s + x.shortagePaise, 0);
    const receivedPaise = r.reduce((s, x) => s + x.amountPaise, 0);
    const deductedPaise = r.reduce((s, x) => s + x.deductionPaise, 0);
    return {
      ...m,
      parchas: b.length, billedPaise, shortagePaise, receipts: r.length, receivedPaise, deductedPaise,
      balancePaise: m.openingBalancePaise + billedPaise - shortagePaise - receivedPaise - deductedPaise,
      lastBill: b.map((x) => x.date).sort().pop() ?? null,
      lastReceipt: r.map((x) => x.receiptDate).sort().pop() ?? null,
    };
  }).filter((m) => m.active || m.balancePaise !== 0 || m.parchas > 0 || m.receipts > 0);
  rows.sort((a, b) => b.balancePaise - a.balancePaise || a.code.localeCompare(b.code));
  const sum = (k: "openingBalancePaise" | "billedPaise" | "shortagePaise" | "receivedPaise" | "deductedPaise" | "balancePaise") => rows.reduce((s, r) => s + r[k], 0);
  return {
    rows,
    totals: {
      openingPaise: sum("openingBalancePaise"), billedPaise: sum("billedPaise"), shortagePaise: sum("shortagePaise"), receivedPaise: sum("receivedPaise"),
      deductedPaise: sum("deductedPaise"), balancePaise: sum("balancePaise"),
      toReceivePaise: rows.filter((r) => r.balancePaise > 0).reduce((s, r) => s + r.balancePaise, 0),
      paidAheadPaise: rows.filter((r) => r.balancePaise < 0).reduce((s, r) => s - r.balancePaise, 0),
    },
  };
}

millLedgerRoutes.get("/", can("ledger.read"), async (c) => {
  const asOf = c.req.query("asOf");
  if (asOf && !ISO_DATE.test(asOf)) throw bad("Date must be YYYY-MM-DD");
  return c.json(await millBalances(c.get("auth")!.businessId!, asOf));
});

/**
 * One mill's statement: brought forward to `from`, then every parcha and
 * receipt in the period with the running balance, plus each parcha's own
 * outstanding (bill − receipts marked against its truck).
 */
millLedgerRoutes.get("/:merchantId", can("ledger.read"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const merchantId = param(c, "merchantId");
  const from = c.req.query("from") || undefined;
  const to = c.req.query("to") || undefined;
  if ((from && !ISO_DATE.test(from)) || (to && !ISO_DATE.test(to))) throw bad("Date must be YYYY-MM-DD");
  if (from && to && from > to) throw bad("The from date is after the to date", "bad_range");
  const [m] = await db.select().from(schema.merchants)
    .where(and(eq(schema.merchants.id, merchantId), eq(schema.merchants.businessId, biz))).limit(1);
  if (!m) throw notFound("Mill not found");

  let broughtForward = m.openingBalancePaise;
  if (from) {
    const b = await billed(biz, { merchantId, before: from });
    const r = await receipts(biz, { merchantId, before: from });
    broughtForward += b.reduce((s, x) => s + x.grandTotalPaise - x.shortagePaise, 0) - r.reduce((s, x) => s + settled(x), 0);
  }
  const bills = await billed(biz, { merchantId, from, to });
  const recs = await receipts(biz, { merchantId, from, to, withVoid: true });

  // per truck: everything ever billed and received against it (not just this period)
  const allBills = await billed(biz, { merchantId });
  const allRecs = await receipts(biz, { merchantId });
  const againstLoad = new Map<string, number>();
  for (const r of allRecs) if (r.loadId) againstLoad.set(r.loadId, (againstLoad.get(r.loadId) ?? 0) + settled(r));

  type Entry = {
    kind: "parcha" | "shortage" | "receipt"; id: string; date: string; at: number; deductionGrams?: number;
    parchaNo?: string; version?: number; truckNo?: string | null; netGrams?: number | null; loadId?: string | null;
    mode?: string; reference?: string | null; notes?: string | null; deductionNote?: string | null;
    amountPaise?: number; deductionPaise?: number; voided?: boolean; voidReason?: string | null;
    debitPaise: number; creditPaise: number; balancePaise?: number;
  };
  const truckOf = new Map(allBills.map((b) => [b.loadId, b]));
  const entries: Entry[] = [
    ...bills.map((b) => ({
      kind: "parcha" as const, id: b.id, date: b.date, at: b.createdAt,
      parchaNo: b.parchaNo, version: b.version, truckNo: b.truckNo, netGrams: b.netGrams, loadId: b.loadId,
      debitPaise: b.grandTotalPaise, creditPaise: 0,
    })),
    // the mill's weight cut on a billed truck, right after its bill
    ...bills.filter((b) => b.shortagePaise).map((b) => ({
      kind: "shortage" as const, id: `short-${b.id}`, date: b.date, at: b.createdAt + 0.5,
      parchaNo: b.parchaNo, truckNo: b.truckNo, loadId: b.loadId, deductionGrams: b.deductionGrams,
      deductionNote: b.deductionNote, debitPaise: 0, creditPaise: b.shortagePaise,
    })),
    ...recs.map((r) => ({
      kind: "receipt" as const, id: r.id, date: r.receiptDate, at: r.createdAt,
      mode: r.mode, reference: r.reference, notes: r.notes, deductionNote: r.deductionNote,
      amountPaise: r.amountPaise, deductionPaise: r.deductionPaise, loadId: r.loadId,
      parchaNo: r.loadId ? truckOf.get(r.loadId)?.parchaNo : undefined,
      truckNo: r.loadId ? truckOf.get(r.loadId)?.truckNo : undefined,
      voided: r.voidedAt != null, voidReason: r.voidReason,
      debitPaise: 0, creditPaise: r.voidedAt != null ? 0 : settled(r),
    })),
  ];
  // day by day; within a day bills first, then money, each in the order entered
  const order = { parcha: 0, shortage: 0, receipt: 1 } as const;
  entries.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1
    : order[a.kind] !== order[b.kind] ? order[a.kind] - order[b.kind] : a.at - b.at));
  let run = broughtForward;
  for (const e of entries) { run += e.debitPaise - e.creditPaise; e.balancePaise = run; }

  const billedP = entries.reduce((s, e) => s + e.debitPaise, 0);
  const live = recs.filter((r) => r.voidedAt == null);
  return c.json({
    mill: { id: m.id, code: m.code, name: m.name, nameHi: m.nameHi, openingBalancePaise: m.openingBalancePaise },
    from: from ?? null, to: to ?? null,
    broughtForwardPaise: broughtForward,
    entries,
    totals: {
      billedPaise: billedP,
      shortagePaise: bills.reduce((s, b) => s + b.shortagePaise, 0),
      receivedPaise: live.reduce((s, r) => s + r.amountPaise, 0),
      deductedPaise: live.reduce((s, r) => s + r.deductionPaise, 0),
      closingPaise: run,
    },
    /** Every approved parcha of this mill with what is still due on it. */
    bills: allBills.sort((a, b) => b.date.localeCompare(a.date) || b.parchaNo.localeCompare(a.parchaNo)).map((b) => ({
      loadId: b.loadId, parchaNo: b.parchaNo, date: b.date, truckNo: b.truckNo, grandTotalPaise: b.grandTotalPaise,
      shortagePaise: b.shortagePaise,
      receivedPaise: againstLoad.get(b.loadId) ?? 0,
      duePaise: b.grandTotalPaise - b.shortagePaise - (againstLoad.get(b.loadId) ?? 0),
    })),
  });
});

/* ----------------------------------------------------------- receipts */

const Body = z.object({
  merchantId: z.string().min(1, "Pick a mill"),
  receiptDate: isoDay("Date is required"),
  amountPaise: z.number().int().min(0, "Amount cannot be negative").max(LIMIT.paise, "Amount is too large"),
  deductionPaise: z.number().int().min(0, "Held back cannot be negative").max(LIMIT.paise, "Amount is too large").default(0),
  deductionNote: z.string().trim().max(200).nullish(),
  mode: z.enum(RECEIPT_MODES).default("bank"),
  reference: z.string().trim().max(60).nullish(),
  notes: z.string().trim().max(300).nullish(),
  loadId: z.string().nullish(),
});

async function checkRefs(biz: string, merchantId: string, loadId: string | null | undefined) {
  const [m] = await db.select({ code: schema.merchants.code }).from(schema.merchants)
    .where(and(eq(schema.merchants.id, merchantId), eq(schema.merchants.businessId, biz))).limit(1);
  if (!m) throw bad("That mill does not belong to this business", "bad_merchant");
  if (loadId) {
    const [l] = await db.select({ merchantId: L.merchantId }).from(L)
      .where(and(eq(L.id, loadId), eq(L.businessId, biz))).limit(1);
    if (!l) throw bad("That truck was not found", "bad_load");
    if (l.merchantId !== merchantId) throw bad("That truck went to a different mill", "load_other_mill");
  }
  return m.code;
}

const label = (code: string, r: { receiptDate: string; amountPaise: number; deductionPaise: number }) =>
  `${r.receiptDate} ${code} ₹${(r.amountPaise / 100).toFixed(2)}${r.deductionPaise ? ` + held ₹${(r.deductionPaise / 100).toFixed(2)}` : ""}`;

millReceiptRoutes.get("/", can("payment.read"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const w = [eq(R.businessId, biz)];
  const from = c.req.query("from");
  const to = c.req.query("to");
  const merchantId = c.req.query("merchantId");
  if (c.req.query("showVoid") !== "1") w.push(isNull(R.voidedAt));
  if (from && ISO_DATE.test(from)) w.push(gte(R.receiptDate, from));
  if (to && ISO_DATE.test(to)) w.push(lte(R.receiptDate, to));
  if (merchantId) w.push(eq(R.merchantId, merchantId));
  const rows = await db.select({
    r: R, code: schema.merchants.code, name: schema.merchants.name, nameHi: schema.merchants.nameHi,
    truckNo: L.truckNo, byName: schema.users.name,
  }).from(R)
    .innerJoin(schema.merchants, eq(schema.merchants.id, R.merchantId))
    .leftJoin(L, eq(L.id, R.loadId))
    .leftJoin(schema.users, eq(schema.users.id, R.createdBy))
    .where(and(...w))
    .orderBy(desc(R.receiptDate), desc(R.createdAt))
    .limit(1000);
  // the parcha number of each truck, from its approved parcha
  const loadIds = [...new Set(rows.map((x) => x.r.loadId).filter((x): x is string => Boolean(x)))];
  const nos = loadIds.length
    ? await db.select({ loadId: Pa.loadId, no: Pa.parchaNo }).from(Pa).where(and(inArray(Pa.loadId, loadIds), eq(Pa.status, "approved")))
    : [];
  const noOf = new Map(nos.map((n) => [n.loadId, n.no]));
  const live = rows.filter((x) => x.r.voidedAt == null);
  return c.json({
    rows: rows.map((x) => ({
      ...x.r, millCode: x.code, millName: x.name, millNameHi: x.nameHi, truckNo: x.truckNo,
      parchaNo: x.r.loadId ? noOf.get(x.r.loadId) ?? null : null, createdByName: x.byName,
    })),
    totals: {
      count: live.length,
      amountPaise: live.reduce((s, x) => s + x.r.amountPaise, 0),
      deductionPaise: live.reduce((s, x) => s + x.r.deductionPaise, 0),
    },
  });
});

millReceiptRoutes.post("/", can("payment.write"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const body = Body.parse(await c.req.json());
  if (body.amountPaise + body.deductionPaise <= 0) throw bad("Enter the amount received", "zero");
  const code = await checkRefs(biz, body.merchantId, body.loadId);
  const id = newId();
  const values = {
    id, businessId: biz, merchantId: body.merchantId, loadId: body.loadId ?? null,
    receiptDate: body.receiptDate, amountPaise: body.amountPaise, deductionPaise: body.deductionPaise,
    deductionNote: body.deductionNote || null, mode: body.mode, reference: body.reference || null,
    notes: body.notes || null, createdBy: c.get("auth")!.user.id,
  };
  await db.insert(R).values(values);
  await audit({ actor: actor(c), action: "mill_receipt.create", entity: "mill_receipt", entityId: id, entityLabel: label(code, values), after: values });
  await enqueueSync(biz, "mill_receipt", id, "insert", values);
  return c.json({ id });
});

millReceiptRoutes.put("/:id", can("payment.write"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const id = param(c, "id");
  const [before] = await db.select().from(R).where(and(eq(R.id, id), eq(R.businessId, biz))).limit(1);
  if (!before) throw notFound("Receipt not found");
  if (before.voidedAt) throw new HttpError(409, "This receipt is cancelled and cannot be changed", "voided");
  const body = Body.partial().parse(await c.req.json());
  const patch = {
    merchantId: body.merchantId ?? before.merchantId,
    loadId: body.loadId === undefined ? before.loadId : (body.loadId ?? null),
    receiptDate: body.receiptDate ?? before.receiptDate,
    amountPaise: body.amountPaise ?? before.amountPaise,
    deductionPaise: body.deductionPaise ?? before.deductionPaise,
    deductionNote: body.deductionNote === undefined ? before.deductionNote : (body.deductionNote || null),
    mode: body.mode ?? before.mode,
    reference: body.reference === undefined ? before.reference : (body.reference || null),
    notes: body.notes === undefined ? before.notes : (body.notes || null),
  };
  if (patch.amountPaise + patch.deductionPaise <= 0) throw bad("Enter the amount received", "zero");
  const code = await checkRefs(biz, patch.merchantId, patch.loadId);
  await db.update(R).set(patch).where(eq(R.id, id));
  await audit({ actor: actor(c), action: "mill_receipt.update", entity: "mill_receipt", entityId: id, entityLabel: label(code, patch), before, after: { ...before, ...patch } });
  await enqueueSync(biz, "mill_receipt", id, "update", patch);
  return c.json({ ok: true });
});

millReceiptRoutes.post("/:id/void", can("payment.write"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const id = param(c, "id");
  const { reason } = z.object({ reason: z.string().trim().min(3, "Say why it is cancelled").max(300) }).parse(await c.req.json());
  const [before] = await db.select().from(R).where(and(eq(R.id, id), eq(R.businessId, biz))).limit(1);
  if (!before) throw notFound("Receipt not found");
  if (before.voidedAt) return c.json({ ok: true, alreadyVoid: true });
  const [m] = await db.select({ code: schema.merchants.code }).from(schema.merchants).where(eq(schema.merchants.id, before.merchantId)).limit(1);
  const patch = { voidedAt: nowSec(), voidedBy: c.get("auth")!.user.id, voidReason: reason };
  await db.update(R).set(patch).where(eq(R.id, id));
  await audit({ actor: actor(c), action: "mill_receipt.void", entity: "mill_receipt", entityId: id,
    entityLabel: `${label(m?.code ?? "?", before)} cancelled: ${reason}`, before, after: { ...before, ...patch } });
  await enqueueSync(biz, "mill_receipt", id, "update", patch);
  return c.json({ ok: true });
});
