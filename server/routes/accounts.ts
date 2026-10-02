import { Hono } from "hono";
import { z } from "zod";
import { eq, and, gte, lte, lt, desc, sql, isNull } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { newId } from "../lib/ids.ts";
import { audit, enqueueSync } from "../lib/audit.ts";
import { can, canAll, actor, param, notFound, bad, isoDay, attachment, LIMIT, HttpError, type Env } from "../lib/http.ts";
import { weightedAvgRate } from "../lib/money.ts";
import { assertDaysOpen } from "../lib/dayClose.ts";
import { nextVoucherNo, fyRange } from "../lib/vouchers.ts";
import { parsePrefs, SUPPLIER_SHEET_COLUMNS, type SupplierSheetColumnKey } from "../lib/prefs.ts";
import { readDevicePrefs } from "../lib/devicePrefs.ts";
import { supplierChargesOf } from "../lib/supplierCharges.ts";
import { supplierSheetXlsx, supplierSheetCsv, sheetTotals, sheetPeriod, type SupplierSheetRow, type SupplierSheetData, type SheetNames } from "../lib/supplierSheet.ts";

/* The supplier (adati) ledger, Tally-style. What we owe a supplier is
     opening balance + every purchase (net × rate, on the slip's date) − every payment.
   Positive means we have to pay them (देना); negative means we paid ahead (लेना).
   Nothing is stored as a balance: it is summed from slips and payments each
   time, so it can never drift from them. */

export const ledgerRoutes = new Hono<Env>();
export const paymentRoutes = new Hono<Env>();

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const PAY_MODES = ["cash", "bank", "upi", "cheque"] as const;

/** Purchases and payments per supplier, optionally before a day, from a day, or up to (and including) one. */
async function sums(businessId: string, opts: { before?: string; from?: string; upTo?: string; adatiId?: string } = {}) {
  const S = schema.purchaseSlips;
  const P = schema.payments;
  const sw = [eq(S.businessId, businessId)];
  // a cancelled payment stays on record but pays nothing
  const pw = [eq(P.businessId, businessId), isNull(P.voidedAt)];
  if (opts.adatiId) { sw.push(eq(S.adatiId, opts.adatiId)); pw.push(eq(P.adatiId, opts.adatiId)); }
  if (opts.before) { sw.push(lt(S.slipDate, opts.before)); pw.push(lt(P.payDate, opts.before)); }
  if (opts.from) { sw.push(gte(S.slipDate, opts.from)); pw.push(gte(P.payDate, opts.from)); }
  if (opts.upTo) { sw.push(lte(S.slipDate, opts.upTo)); pw.push(lte(P.payDate, opts.upTo)); }
  const bought = await db.select({
    adatiId: S.adatiId,
    slips: sql<number>`count(*)`,
    netGrams: sql<number>`sum(${S.netGrams})`,
    /** Goods value (net × rate). */
    goodsPaise: sql<number>`sum(${S.amountPaise})`,
    commissionPaise: sql<number>`sum(${S.commissionPaise})`,
    gaushalaPaise: sql<number>`sum(${S.gaushalaPaise})`,
    /** What we owe for them: goods + commission + gaushala. */
    amountPaise: sql<number>`sum(${S.payablePaise})`,
    unpriced: sql<number>`sum(case when ${S.ratePaisePerQtl} > 0 then 0 else 1 end)`,
    last: sql<string>`max(${S.slipDate})`,
  }).from(S).where(and(...sw)).groupBy(S.adatiId);
  const paid = await db.select({
    adatiId: P.adatiId,
    n: sql<number>`count(*)`,
    amountPaise: sql<number>`sum(${P.amountPaise})`,
    last: sql<string>`max(${P.payDate})`,
  }).from(P).where(and(...pw)).groupBy(P.adatiId);
  return { bought: new Map(bought.map((b) => [b.adatiId, b])), paid: new Map(paid.map((p) => [p.adatiId, p])) };
}

/**
 * Every supplier with what is owed at a day, and what a period put on and took
 * off his account: the ledger list, and the pay sheet built from it.
 *   asOf  the balance counts everything up to and including this day (default: everything)
 *   from  slips, weight, amount, commission, gaushala, purchases and payments
 *         count from this day (default: from the start); what was owed before
 *         it is brought forward, so  brought forward + purchases − payments = balance
 */
async function ledgerList(biz: string, opts: { from?: string; asOf?: string } = {}) {
  const suppliers = await db.select({
    id: schema.adati.id, nameHi: schema.adati.nameHi, nameHinglish: schema.adati.nameHinglish,
    village: schema.adati.village, villageHi: schema.adati.villageHi, phone: schema.adati.phone, active: schema.adati.active,
    openingBalancePaise: schema.adati.openingBalancePaise,
  }).from(schema.adati).where(eq(schema.adati.businessId, biz));
  const all = await sums(biz, { upTo: opts.asOf });
  const period = opts.from ? await sums(biz, { from: opts.from, upTo: opts.asOf }) : all;
  const rows = suppliers.map((s) => {
    const b = period.bought.get(s.id);
    const p = period.paid.get(s.id);
    const purchases = b?.amountPaise ?? 0;
    const payments = p?.amountPaise ?? 0;
    const balance = s.openingBalancePaise + (all.bought.get(s.id)?.amountPaise ?? 0) - (all.paid.get(s.id)?.amountPaise ?? 0);
    return {
      ...s,
      slips: b?.slips ?? 0,
      netGrams: b?.netGrams ?? 0,
      unpriced: b?.unpriced ?? 0,
      goodsPaise: b?.goodsPaise ?? 0,
      commissionPaise: b?.commissionPaise ?? 0,
      gaushalaPaise: b?.gaushalaPaise ?? 0,
      /** goods + commission + gaushala: what the purchases put on the supplier's account */
      purchasesPaise: purchases,
      paymentsPaise: payments,
      /** What was owed when the period began: the opening balance, or with `from`, everything before it too. */
      broughtForwardPaise: balance - purchases + payments,
      balancePaise: balance,
      lastActivity: [all.bought.get(s.id)?.last, all.paid.get(s.id)?.last].filter(Boolean).sort().pop() ?? null,
    };
  // a supplier settled and made inactive is still on the list for a period in which he was paid
  }).filter((r) => r.active || r.balancePaise !== 0 || r.slips > 0 || r.paymentsPaise !== 0);
  rows.sort((a, b) => b.balancePaise - a.balancePaise || a.nameHi.localeCompare(b.nameHi, "hi"));
  const total = (k: "openingBalancePaise" | "broughtForwardPaise" | "goodsPaise" | "commissionPaise" | "gaushalaPaise" | "purchasesPaise" | "paymentsPaise" | "balancePaise") =>
    rows.reduce((s, r) => s + r[k], 0);
  const totals = {
    openingPaise: total("openingBalancePaise"),
    broughtForwardPaise: total("broughtForwardPaise"),
    goodsPaise: total("goodsPaise"),
    commissionPaise: total("commissionPaise"),
    gaushalaPaise: total("gaushalaPaise"),
    purchasesPaise: total("purchasesPaise"),
    paymentsPaise: total("paymentsPaise"),
    balancePaise: total("balancePaise"),
    toPayPaise: rows.filter((r) => r.balancePaise > 0).reduce((s, r) => s + r.balancePaise, 0),
    paidAheadPaise: rows.filter((r) => r.balancePaise < 0).reduce((s, r) => s - r.balancePaise, 0),
  };
  return { from: opts.from ?? null, asOf: opts.asOf ?? null, rows, totals };
}

/** ?from=YYYY-MM-DD &asOf=YYYY-MM-DD, both optional: see ledgerList. */
ledgerRoutes.get("/", can("ledger.read"), async (c) => {
  const asOf = c.req.query("asOf") || undefined;
  const from = c.req.query("from") || undefined;
  if ((asOf && !isoDay().safeParse(asOf).success) || (from && !isoDay().safeParse(from).success)) throw bad("Date must be YYYY-MM-DD", "bad_date");
  if (from && asOf && from > asOf) throw bad("The from date is after the to date", "bad_range");
  return c.json(await ledgerList(c.get("auth")!.businessId!, { from, asOf }));
});

/**
 * The supplier pay sheet, as Excel or CSV: one row per adati.
 *   mode=till&date=D          1 April of D's financial year to D
 *   mode=day&date=D           D alone
 *   mode=range&from=F&to=T    F to T
 * Amount, commission, gaushala, net amount and paid are for the period; "to
 * pay" is the balance at its end, never below zero (paid ahead is named under
 * the total instead). Every figure is ledgerList's own for the same period, so
 * each total is the ledger's: GET /ledger?from=F&asOf=T.
 * Who is on it: everyone with slips in the period; for till date and from–to
 * also everyone still to be paid at the end; with the paid column, also
 * everyone paid in the period. Largest to pay first.
 * [&names=hi|hinglish|both] [&cols=a,b] [&format=xlsx|csv|json]
 * Registered before "/:adatiId", which would otherwise take "sheet" for a supplier.
 */
ledgerRoutes.get("/sheet", canAll("export.data", "ledger.read"), async (c) => {
  const auth = c.get("auth")!;
  const biz = auth.businessId!;
  const m = c.req.query("mode");
  const mode = m === "day" ? "day" : m === "range" ? "range" : "till";
  const day = (v: string | undefined) => {
    if (!v || !isoDay().safeParse(v).success) throw bad("Pick a date", "bad_date");
    return v;
  };
  let from: string, to: string;
  if (mode === "range") {
    from = day(c.req.query("from"));
    to = day(c.req.query("to"));
    if (from > to) throw bad("The from date is after the to date", "bad_range");
  } else {
    to = day(c.req.query("date"));
    from = mode === "day" ? to : fyRange(to).from;
  }

  const prefs = readDevicePrefs(auth.user.id) ?? parsePrefs(auth.user.prefs).dailyList;
  const known = new Set<string>(SUPPLIER_SHEET_COLUMNS.map((x) => x.key));
  const asked = new Set(c.req.query("cols")?.split(",").filter((k) => known.has(k)) ?? []);
  const chosen = asked.size ? asked : new Set<string>(SUPPLIER_SHEET_COLUMNS.filter((x) => prefs.paySheetColumns[x.key]).map((x) => x.key));
  // the name is always there: a sheet of figures with no one to pay is no use
  const columns: SupplierSheetColumnKey[] = SUPPLIER_SHEET_COLUMNS.map((x) => x.key).filter((k) => k === "name" || chosen.has(k));
  const n = c.req.query("names") ?? prefs.supplierSheetNames;
  const names: SheetNames = n === "both" ? "both" : n === "hinglish" || n === "latin" ? "hinglish" : "hi";

  const list = await ledgerList(biz, { from, asOf: to });
  const on = list.rows.filter((r) => r.slips > 0 || (mode !== "day" && r.balancePaise > 0) || (columns.includes("paid") && r.paymentsPaise > 0));
  // Hindi names are unique, Hinglish ones need not be: two RAM LALs get their village
  const latinSeen = new Map<string, number>();
  for (const r of list.rows) { const k = r.nameHinglish || r.nameHi; latinSeen.set(k, (latinSeen.get(k) ?? 0) + 1); }
  const latinOf = (r: (typeof list.rows)[number]) => {
    const latin = r.nameHinglish || r.nameHi;
    return (latinSeen.get(latin) ?? 0) > 1 ? `${latin} (${r.village || r.villageHi || r.nameHi})` : latin;
  };
  const rows: SupplierSheetRow[] = on.map((r) => ({
    nameHi: r.nameHi, nameLatin: latinOf(r),
    slips: r.slips, netGrams: r.netGrams, unpriced: r.unpriced,
    goodsPaise: r.goodsPaise, commissionPaise: r.commissionPaise, gaushalaPaise: r.gaushalaPaise,
    payablePaise: r.purchasesPaise, paidPaise: r.paymentsPaise,
    // paid ahead is money to recover, not money to pay: it never lowers the total
    toPayPaise: Math.max(0, r.balancePaise),
  })).sort((a, b) => b.toPayPaise - a.toPayPaise || b.payablePaise - a.payablePaise || a.nameHi.localeCompare(b.nameHi, "hi"));

  const money = (p: number) => `₹${(p / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const notes: string[] = [];
  const waiting = rows.reduce((s, r) => s + r.unpriced, 0);
  if (waiting) notes.push(`${waiting} slip${waiting === 1 ? "" : "s"} with no rate yet: weight counted, amount 0.`);
  // as the ledger's "paid ahead" card: everyone, at the end date (one day: those on the sheet)
  const ahead = (mode === "day" ? on : list.rows).filter((r) => r.balancePaise < 0);
  if (ahead.length) notes.push(`Paid ahead (to recover, not in "To pay"): ${ahead.map((r) => `${names === "hinglish" ? latinOf(r) : r.nameHi} ${money(-r.balancePaise)}`).join("; ")}.`);

  const [business] = await db.select({ name: schema.businesses.name }).from(schema.businesses).where(eq(schema.businesses.id, biz)).limit(1);
  const L = (await supplierChargesOf(biz)).labels;
  const data: SupplierSheetData = {
    mode, from, to, businessName: business?.name ?? "",
    names, columns, labels: { commission: L.commission, gaushala: L.gaushala, payable: L.payable }, rows, notes,
  };
  const format = c.req.query("format") ?? "xlsx";
  const fileBase = mode === "till" ? `pay-sheet-till-${to}` : mode === "day" ? `pay-sheet-${to}` : `pay-sheet-${from}-to-${to}`;
  if (format === "json") return c.json({ ...data, period: sheetPeriod(data), totals: sheetTotals(rows) });
  if (format === "csv") {
    return new Response(supplierSheetCsv(data), {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": attachment(`${fileBase}.csv`) },
    });
  }
  const buf = await supplierSheetXlsx(data);
  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": attachment(`${fileBase}.xlsx`),
    },
  });
});

/**
 * One supplier's statement: the balance brought forward to `from`, then
 * every purchase and payment in the period with the running balance.
 */
ledgerRoutes.get("/:adatiId", can("ledger.read"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const adatiId = param(c, "adatiId");
  const from = c.req.query("from") || undefined;
  const to = c.req.query("to") || undefined;
  if ((from && !ISO_DATE.test(from)) || (to && !ISO_DATE.test(to))) throw bad("Date must be YYYY-MM-DD");
  if (from && to && from > to) throw bad("The from date is after the to date", "bad_range");

  const [s] = await db.select().from(schema.adati)
    .where(and(eq(schema.adati.id, adatiId), eq(schema.adati.businessId, biz))).limit(1);
  if (!s) throw notFound("Supplier not found");

  // brought forward: opening + everything before the period
  let broughtForward = s.openingBalancePaise;
  if (from) {
    const before = await sums(biz, { adatiId, before: from });
    broughtForward += (before.bought.get(adatiId)?.amountPaise ?? 0) - (before.paid.get(adatiId)?.amountPaise ?? 0);
  }

  const S = schema.purchaseSlips;
  const sw = [eq(S.businessId, biz), eq(S.adatiId, adatiId)];
  if (from) sw.push(gte(S.slipDate, from));
  if (to) sw.push(lte(S.slipDate, to));
  const slips = await db.select({
    id: S.id, date: S.slipDate, rstNo: S.rstNo, netGrams: S.netGrams, ratePaisePerQtl: S.ratePaisePerQtl,
    grossGrams: S.grossGrams, katautiUnits: S.katautiUnits,
    amountPaise: S.amountPaise, commissionPaise: S.commissionPaise, gaushalaPaise: S.gaushalaPaise, payablePaise: S.payablePaise,
    createdAt: S.createdAt, jinsCode: schema.jins.code, millCode: schema.merchants.code,
  }).from(S)
    .innerJoin(schema.jins, eq(schema.jins.id, S.jinsId))
    .leftJoin(schema.merchants, eq(schema.merchants.id, S.merchantId))
    .where(and(...sw));

  const P = schema.payments;
  const pw = [eq(P.businessId, biz), eq(P.adatiId, adatiId)];
  if (from) pw.push(gte(P.payDate, from));
  if (to) pw.push(lte(P.payDate, to));
  const pays = await db.select().from(P).where(and(...pw));

  type Entry = {
    kind: "purchase" | "payment"; id: string; date: string; at: number; voided?: boolean; voidReason?: string | null;
    rstNo?: string; jinsCode?: string; millCode?: string | null; netGrams?: number; ratePaisePerQtl?: number;
    grossGrams?: number; katautiUnits?: number;
    /** A purchase: goods value, and what the supplier adds to it. The credit is their sum. */
    goodsPaise?: number; commissionPaise?: number; gaushalaPaise?: number;
    mode?: string; reference?: string | null; notes?: string | null; voucherNo?: number | null;
    creditPaise: number; debitPaise: number; balancePaise?: number;
  };
  const entries: Entry[] = [
    ...slips.map((x) => ({
      kind: "purchase" as const, id: x.id, date: x.date, at: x.createdAt,
      rstNo: x.rstNo, jinsCode: x.jinsCode, millCode: x.millCode, netGrams: x.netGrams, ratePaisePerQtl: x.ratePaisePerQtl,
      grossGrams: x.grossGrams, katautiUnits: x.katautiUnits,
      goodsPaise: x.amountPaise, commissionPaise: x.commissionPaise, gaushalaPaise: x.gaushalaPaise,
      creditPaise: x.payablePaise, debitPaise: 0,
    })),
    ...pays.map((p) => ({
      kind: "payment" as const, id: p.id, date: p.payDate, at: p.createdAt,
      mode: p.mode, reference: p.reference, notes: p.notes, voucherNo: p.voucherNo,
      // shown struck out, counted as nothing
      voided: p.voidedAt != null, voidReason: p.voidReason,
      creditPaise: 0, debitPaise: p.voidedAt != null ? 0 : p.amountPaise,
    })),
  ];
  // day by day; within a day purchases first, then payments, each in the order entered
  entries.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1
    : a.kind !== b.kind ? (a.kind === "purchase" ? -1 : 1) : a.at - b.at));
  let run = broughtForward;
  for (const e of entries) { run += e.creditPaise - e.debitPaise; e.balancePaise = run; }

  const purchases = entries.reduce((x, e) => x + e.creditPaise, 0);
  const payments = entries.reduce((x, e) => x + e.debitPaise, 0);
  return c.json({
    supplier: { id: s.id, nameHi: s.nameHi, nameHinglish: s.nameHinglish, village: s.village, phone: s.phone,
      accountNo: s.accountNo, ifsc: s.ifsc, openingBalancePaise: s.openingBalancePaise },
    from: from ?? null, to: to ?? null,
    broughtForwardPaise: broughtForward,
    entries,
    totals: {
      goodsPaise: slips.reduce((x, e) => x + e.amountPaise, 0),
      commissionPaise: slips.reduce((x, e) => x + e.commissionPaise, 0),
      gaushalaPaise: slips.reduce((x, e) => x + e.gaushalaPaise, 0),
      purchasesPaise: purchases,
      paymentsPaise: payments,
      netGrams: entries.reduce((x, e) => x + (e.netGrams ?? 0), 0),
      grossGrams: slips.reduce((x, e) => x + e.grossGrams, 0),
      katautiUnits: slips.reduce((x, e) => x + e.katautiUnits, 0),
      avgRatePaisePerQtl: weightedAvgRate(slips.filter((x) => x.ratePaisePerQtl > 0)),
      slips: slips.length,
      unpriced: slips.filter((x) => !x.ratePaisePerQtl).length,
      closingPaise: broughtForward + purchases - payments,
    },
  });
});

/* ----------------------------------------------------------- payments */

const PayBody = z.object({
  adatiId: z.string().min(1, "Pick a supplier"),
  payDate: isoDay("Payment date is required"),
  amountPaise: z.number().int().min(1, "Amount must be more than zero").max(LIMIT.paise, "Amount is too large"),
  mode: z.enum(PAY_MODES).default("cash"),
  reference: z.string().trim().max(60).nullish(),
  notes: z.string().trim().max(300).nullish(),
});

async function supplierName(biz: string, adatiId: string) {
  const [a] = await db.select({ name: schema.adati.nameHinglish, nameHi: schema.adati.nameHi }).from(schema.adati)
    .where(and(eq(schema.adati.id, adatiId), eq(schema.adati.businessId, biz))).limit(1);
  if (!a) throw bad("That supplier does not belong to this business", "bad_adati");
  return a.name || a.nameHi;
}

paymentRoutes.get("/", can("payment.read"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const P = schema.payments;
  const where = [eq(P.businessId, biz)];
  const from = c.req.query("from");
  const to = c.req.query("to");
  const adatiId = c.req.query("adatiId");
  const mode = c.req.query("mode");
  const showVoid = c.req.query("showVoid") === "1";
  if (!showVoid) where.push(isNull(P.voidedAt));
  if (from && ISO_DATE.test(from)) where.push(gte(P.payDate, from));
  if (to && ISO_DATE.test(to)) where.push(lte(P.payDate, to));
  if (adatiId) where.push(eq(P.adatiId, adatiId));
  if (mode && (PAY_MODES as readonly string[]).includes(mode)) where.push(eq(P.mode, mode));
  const rows = await db.select({
    p: P, nameHi: schema.adati.nameHi, nameHinglish: schema.adati.nameHinglish, byName: schema.users.name,
  }).from(P)
    .innerJoin(schema.adati, eq(schema.adati.id, P.adatiId))
    .leftJoin(schema.users, eq(schema.users.id, P.createdBy))
    .where(and(...where))
    .orderBy(desc(P.payDate), desc(P.createdAt))
    .limit(1000);
  const list = rows.map((r) => ({ ...r.p, adatiNameHi: r.nameHi, adatiNameHinglish: r.nameHinglish, createdByName: r.byName }));
  // totals over every matching payment, not just the rows sent
  const agg = await db.select({ mode: P.mode, n: sql<number>`count(*)`, p: sql<number>`sum(${P.amountPaise})` })
    .from(P).where(and(...where, isNull(P.voidedAt))).groupBy(P.mode);
  const byMode = Object.fromEntries(PAY_MODES.map((m) => [m, agg.find((a) => a.mode === m)?.p ?? 0]));
  const count = agg.reduce((s, a) => s + a.n, 0);
  const [all] = await db.select({ n: sql<number>`count(*)` }).from(P).where(and(...where));
  return c.json({ rows: list, truncated: all.n > list.length, totals: { count, amountPaise: agg.reduce((s, a) => s + a.p, 0), byMode } });
});

paymentRoutes.post("/", can("payment.write"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const body = PayBody.parse(await c.req.json());
  await assertDaysOpen(biz, body.payDate);
  const name = await supplierName(biz, body.adatiId);
  const id = newId();
  const values = {
    id, businessId: biz, adatiId: body.adatiId, payDate: body.payDate, amountPaise: body.amountPaise,
    mode: body.mode, reference: body.reference ?? null, notes: body.notes ?? null, createdBy: c.get("auth")!.user.id,
    voucherNo: 0,
  };
  // the number and the row go in together, so two payments saved at once cannot share one
  db.transaction((tx) => {
    values.voucherNo = nextVoucherNo("payments", biz, body.payDate);
    tx.insert(schema.payments).values(values).run();
  });
  await audit({ actor: actor(c), action: "payment.create", entity: "payment", entityId: id,
    entityLabel: `PV-${values.voucherNo} ${body.payDate} ${name} ₹${(body.amountPaise / 100).toFixed(2)} ${body.mode}`, after: values });
  await enqueueSync(biz, "payment", id, "insert", values);
  return c.json({ id, voucherNo: values.voucherNo });
});

paymentRoutes.put("/:id", can("payment.write"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const id = param(c, "id");
  const [before] = await db.select().from(schema.payments)
    .where(and(eq(schema.payments.id, id), eq(schema.payments.businessId, biz))).limit(1);
  if (!before) throw notFound("Payment not found");
  if (before.voidedAt) throw new HttpError(409, "This payment is cancelled and cannot be changed", "voided");
  const body = PayBody.partial().parse(await c.req.json());
  await assertDaysOpen(biz, before.payDate, body.payDate);
  const patch = {
    adatiId: body.adatiId ?? before.adatiId,
    payDate: body.payDate ?? before.payDate,
    amountPaise: body.amountPaise ?? before.amountPaise,
    mode: body.mode ?? before.mode,
    reference: body.reference === undefined ? before.reference : (body.reference ?? null),
    notes: body.notes === undefined ? before.notes : (body.notes ?? null),
  };
  const name = await supplierName(biz, patch.adatiId);
  await db.update(schema.payments).set(patch).where(eq(schema.payments.id, id));
  await audit({ actor: actor(c), action: "payment.update", entity: "payment", entityId: id,
    entityLabel: `${patch.payDate} ${name} ₹${(patch.amountPaise / 100).toFixed(2)}`, before, after: { ...before, ...patch } });
  await enqueueSync(biz, "payment", id, "update", patch);
  return c.json({ ok: true });
});

/* A payment is never erased: cancelling keeps it on record, struck out, with
   who cancelled it and why, and it stops counting towards the balance. */
async function voidPayment(c: any, reason: string) {
  const biz = c.get("auth")!.businessId!;
  const id = param(c, "id");
  const [before] = await db.select().from(schema.payments)
    .where(and(eq(schema.payments.id, id), eq(schema.payments.businessId, biz))).limit(1);
  if (!before) throw notFound("Payment not found");
  if (before.voidedAt) return c.json({ ok: true, alreadyVoid: true });
  await assertDaysOpen(biz, before.payDate);
  const name = await supplierName(biz, before.adatiId);
  const patch = { voidedAt: Math.floor(Date.now() / 1000), voidedBy: c.get("auth")!.user.id, voidReason: reason };
  await db.update(schema.payments).set(patch).where(eq(schema.payments.id, id));
  await audit({ actor: actor(c), action: "payment.void", entity: "payment", entityId: id,
    entityLabel: `${before.payDate} ${name} ₹${(before.amountPaise / 100).toFixed(2)} cancelled: ${reason}`, before, after: { ...before, ...patch } });
  await enqueueSync(biz, "payment", id, "update", patch);
  return c.json({ ok: true });
}

paymentRoutes.post("/:id/void", can("payment.write"), async (c) => {
  const { reason } = z.object({ reason: z.string().trim().min(3, "Say why it is cancelled").max(300) }).parse(await c.req.json());
  return voidPayment(c, reason);
});

/** Kept for older screens: "delete" now cancels, it never erases. */
paymentRoutes.delete("/:id", can("payment.write"), async (c) => voidPayment(c, "Deleted"));
