import { eq, and, ne, asc, desc, sql, gte, lte, inArray, type SQL } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { rowsOf } from "../db/rows.ts";
import { ChargeConfigSchema, computeParcha, bardanaKg, type ChargeConfig, type ParchaResult } from "./charges.ts";
import { amountPaise, roundHalfUp, avgFromSums } from "./money.ts";
import { fyStartOf, fyRange } from "./vouchers.ts";
export { fyNumberLabel } from "./parchaLabels.ts";

/* Everything about one truck, worked out in one place. A truck is loaded by
   weight from its mill's stock: each row takes a weight from one purchase
   day, priced at that day's average rate for the mill (the "dara") unless a
   rate is typed. Stock is what was bought for the mill less what trucks took,
   day by day, and may go negative. The load screen, the print, the Excel file,
   the approval, the PO balance and the stock page all read from here. */

/** A reason the parcha cannot be approved yet. */
export type Blocker =
  | { code: "no_lines" }
  | { code: "line_no_rate"; date: string }
  | { code: "line_no_weight" }
  | { code: "line_not_positive"; date: string; grams: number }
  | { code: "lines_mismatch"; linesGrams: number; millNetGrams: number }
  | { code: "no_mill_gross" }
  | { code: "no_bags" }
  | { code: "net_nonpositive" }
  | { code: "no_invoice_no" };

/** Worth a look; never stops anything. */
export type Warning =
  | { code: "stock_negative"; date: string; grams: number }
  | { code: "po_over"; po: string; overGrams: number }
  | { code: "po_closed"; po: string }
  | { code: "po_expired"; po: string; validTill: string }
  | { code: "bore_no_labour" }
  /** A row priced at the day's average while that day still has slips with no rate: the average leaves them out. */
  | { code: "day_unpriced"; date: string; jinsCode: string; slips: number }
  /** The parcha number is already on another live parcha of this firm in the same financial year. */
  | { code: "invoice_repeated"; parchaNo: string; others: { loadId: string; truckNo: string | null; date: string | null }[] };

export interface ParchaDocLine {
  po: string;
  jinsCode: string;
  date: string;
  netGrams: number;
  ratePaisePerQtl: number;
  amountPaise: number;
}

/** Everything printed on the parcha, frozen into the snapshot on approval. */
export interface ParchaDoc {
  title: string;
  titleHi: string;
  business: { name: string; nameHi: string | null; city: string | null; state: string | null; gstin: string | null };
  mill: { code: string; name: string; nameHi: string | null; city: string | null; state: string | null; gstin: string | null };
  invoiceNo: string | null;
  invoiceDate: string;
  /** Counts approvals of this number across the firm (it keeps the register's rows apart); not printed. */
  version: number;
  /** The n-th parcha approved for this truck: 2 and up is a revised paper that replaces the one given before. Missing on parchas approved before it was kept: read `version` then. */
  revision?: number;
  /** The day a revised parcha was approved (YYYY-MM-DD), printed beside "REVISED". */
  revisedOn?: string | null;
  truckNo: string | null;
  loadDate: string;
  ewayBillNo: string | null;
  weights: {
    grossGrams: number; bardanaGrams: number; netGrams: number;
    katte: number; bore: number; katteBardanaGrams: number; boreBardanaGrams: number;
  };
  lines: ParchaDocLine[];
  totals: { netGrams: number; ratePaisePerQtl: number; goodsPaise: number };
  result: ParchaResult;
  config: ChargeConfig;
  /** Where the rate came from: each day's purchases for the mill (per commodity), as they stood. */
  stock?: { date: string; jinsCode?: string; boughtNetGrams: number; avgRatePaisePerQtl: number }[];
}

export type LoadRow = typeof schema.loads.$inferSelect;

/** The version an approval of this parcha number would get: one past any earlier (voided) ones. */
export async function nextVersion(businessId: string, parchaNo: string) {
  const [last] = await db.select({ v: sql<number>`max(${schema.parchas.version})` }).from(schema.parchas)
    .where(and(eq(schema.parchas.businessId, businessId), eq(schema.parchas.parchaNo, parchaNo)));
  return (last?.v ?? 0) + 1;
}

/** Rate × weight / weight, back to a rate: the TOTAL row's rate on the parcha. */
export const rateOf = (goodsPaise: number, netGrams: number) =>
  netGrams ? roundHalfUp((goodsPaise * 100_000) / netGrams) : 0;

/* Parcha numbers. A number belongs to one live parcha of the firm within a
   financial year (1 April – 31 March), so a paper series that starts again
   at 1 each April is fine. The same number on two live parchas of one year
   is shown as a warning, never refused: the owner decides. */

/** "2026|196": a parcha number within its financial year. */
export const fyKey = (iso: string, no: string) => `${fyStartOf(iso)}|${no.trim()}`;

/** Live parchas of other trucks that carry this number in the financial year of `onDate`. */
export async function sameNumberElsewhere(businessId: string, parchaNo: string, onDate: string, exceptLoadId: string) {
  const { from, to } = fyRange(onDate);
  return db.select({ loadId: schema.parchas.loadId, truckNo: schema.loads.truckNo, date: schema.parchas.invoiceDate })
    .from(schema.parchas)
    .innerJoin(schema.loads, eq(schema.loads.id, schema.parchas.loadId))
    .where(and(
      eq(schema.parchas.businessId, businessId),
      eq(schema.parchas.parchaNo, parchaNo.trim()),
      eq(schema.parchas.status, "approved"),
      ne(schema.parchas.loadId, exceptLoadId),
      gte(schema.parchas.invoiceDate, from), lte(schema.parchas.invoiceDate, to),
    ));
}

/** How many live parchas carry each number, per financial year (fyKey). */
export function sameNumberCount(all: { parchaNo: string; status: string; invoiceDate: string | null }[]) {
  const n = new Map<string, number>();
  for (const p of all) if (p.status === "approved" && p.invoiceDate) n.set(fyKey(p.invoiceDate, p.parchaNo), (n.get(fyKey(p.invoiceDate, p.parchaNo)) ?? 0) + 1);
  return n;
}

/**
 * Which approval of its truck a parcha is: 1 for the first paper, 2 and up
 * for one approved again after a void (a revised paper). Ids are time-ordered
 * (UUIDv7), so the order they were made in is the order of approval.
 */
export function revisions(all: { id: string; loadId: string }[]) {
  const byLoad = new Map<string, string[]>();
  for (const p of all) { const a = byLoad.get(p.loadId); if (a) a.push(p.id); else byLoad.set(p.loadId, [p.id]); }
  const out = new Map<string, { revision: number; previousId: string | null }>();
  for (const ids of byLoad.values()) {
    ids.sort();
    ids.forEach((id, i) => out.set(id, { revision: i + 1, previousId: i > 0 ? ids[i - 1] : null }));
  }
  return out;
}

/** The frozen paper with the revision it prints. Parchas approved before the paper kept it
 *  take the figure the register and truck page show, so paper and screens agree. */
export const withRevision = (doc: ParchaDoc, revision: number): ParchaDoc => (doc.revision != null ? doc : { ...doc, revision });

/**
 * Invoice numbers are numeric on paper (196); suggest the next one: one past
 * the highest of the financial year `onDate` falls in, or — the first parcha
 * of a new year — one past the highest ever, as a series that runs on would
 * be. Typing 1 instead starts the year's own series, and it follows from there.
 */
export async function suggestInvoiceNo(businessId: string, exceptLoadId?: string, onDate?: string): Promise<string | null> {
  const fromParchas = await db.select({ n: schema.parchas.parchaNo, d: schema.parchas.invoiceDate }).from(schema.parchas)
    .where(eq(schema.parchas.businessId, businessId));
  const fromLoads = await db.select({ n: schema.loads.invoiceNo, d: sql<string>`coalesce(${schema.loads.invoiceDate}, ${schema.loads.loadDate})` }).from(schema.loads)
    .where(and(
      eq(schema.loads.businessId, businessId),
      exceptLoadId ? ne(schema.loads.id, exceptLoadId) : sql`1 = 1`,
    ));
  const all = [...fromParchas, ...fromLoads]
    .map((r) => ({ n: Number(r.n), d: r.d })).filter((r) => Number.isInteger(r.n) && r.n > 0);
  const fy = onDate ? fyRange(onDate) : null;
  const year = fy ? all.filter((r) => r.d && r.d >= fy.from && r.d <= fy.to) : [];
  const nums = (year.length ? year : all).map((r) => r.n);
  return nums.length ? String(Math.max(...nums) + 1) : null;
}

/* A truck entered before bags were split into katte and bore has only the
   total, read as katte. Emptying both boxes clears that total too (PUT
   /loads), so an emptied box never bills the old bags, nor cleared bore as katte. */
function bagCounts(l: LoadRow) {
  return { katte: l.katteCount ?? (l.boreCount == null ? (l.bags ?? 0) : 0), bore: l.boreCount ?? 0 };
}

/** Bardana: typed weight if the operator gave one, else bags x kg per bag. */
function weighment(l: LoadRow, cfg: ChargeConfig) {
  const { katte, bore } = bagCounts(l);
  const katteBardanaGrams = l.katteBardanaGrams ?? bardanaKg(katte, cfg.millBardanaKgPerBag);
  const boreBardanaGrams = l.boreBardanaGrams ?? bardanaKg(bore, cfg.millBoreBardanaKgPerBag);
  const bardanaGrams = katteBardanaGrams + boreBardanaGrams;
  const grossGrams = l.millGrossGrams;
  const netGrams = grossGrams == null ? null : grossGrams - bardanaGrams;
  return { katte, bore, bags: katte + bore, katteBardanaGrams, boreBardanaGrams, bardanaGrams, grossGrams, netGrams };
}

/** The void reason, and the clash note, when one truck was approved on two computers (repairTrucks.ts). */
export const APPROVED_TWICE = "this truck was approved on two computers — the earlier parcha is kept";

type TermsParcha = { id: string; status: string; snapshot: string; voidedAt?: number | null; voidReason?: string | null };

/** The parcha whose terms a truck keeps: the live one, else the one voided last. */
function billedParcha<P extends TermsParcha>(parchas: P[]): P | null {
  const live = parchas.find((p) => p.status === "approved");
  if (live) return live;
  /* Voided ones: the latest void wins (voided_at, then the id), the same on
     every computer. A parcha voided because the truck was approved on two
     computers was never the mill's bill: it counts only if nothing else does. */
  const voided = parchas.filter((p) => p.status !== "approved");
  const genuine = voided.filter((p) => p.voidReason !== APPROVED_TWICE);
  const later = (a: P, b: P) => ((a.voidedAt ?? 0) !== (b.voidedAt ?? 0) ? (a.voidedAt ?? 0) > (b.voidedAt ?? 0) : a.id > b.id);
  return (genuine.length ? genuine : voided).reduce<P | null>((a, p) => (!a || later(p, a) ? p : a), null);
}

/** The terms a parcha froze, or null when it has none readable. */
function frozenTerms(p: TermsParcha): ChargeConfig | null {
  try {
    const r = ChargeConfigSchema.safeParse((JSON.parse(p.snapshot) as Partial<ParchaDoc>).config);
    return r.success ? r.data : null;
  } catch { return null; }
}

/**
 * The terms a truck is billed on. Once a truck has had a parcha it keeps the
 * terms that parcha froze — the live one, else the one voided last — so
 * voiding it to put something right and approving again never re-prices it
 * on terms the mill was given since (unless the approver ticks "bill on the
 * mill's current terms": loadState's millTerms). A truck never billed takes
 * its mill's terms as they stand. Every computer picks the same parcha.
 */
export function truckTerms(millCfg: ChargeConfig, parchas: TermsParcha[]): ChargeConfig {
  const last = billedParcha(parchas);
  return (last && frozenTerms(last)) ?? millCfg;
}

/** The same rule, read from the books for one truck (synchronous: the sync repair calls it inside its transaction). */
export function termsOfTruck(loadId: string, millCfg: ChargeConfig): ChargeConfig {
  const P = schema.parchas;
  return truckTerms(millCfg, db.select({ id: P.id, status: P.status, snapshot: P.snapshot, voidedAt: P.voidedAt, voidReason: P.voidReason })
    .from(P).where(eq(P.loadId, loadId)).all());
}

/** Recompute the stored mill figures from gross, bags and the truck's terms (termsOfTruck). */
export function storedWeighment(l: LoadRow, cfg: ChargeConfig) {
  const w = weighment(l, cfg);
  return { bags: w.bags, millBardanaGrams: w.bardanaGrams, millNetGrams: w.netGrams };
}

/**
 * What a billed truck's own fields must hold: the figures its live parcha
 * froze. Stock, PO balances and the dashboard read the truck; the mill
 * account reads the parcha. Two computers settle a truck and its parcha as
 * separate records, so after a sync the truck is put back in step with the
 * paper — the mill's weighbridge gross, the bags and their bardana, the net,
 * the number, date and advance. A bag count or typed bardana that already
 * reads the same is left as it is (an old truck's bags count as katte).
 */
export function billedFigures(l: LoadRow, p: { parchaNo: string; invoiceDate: string | null; snapshot: string }): Partial<LoadRow> {
  const doc = JSON.parse(p.snapshot) as ParchaDoc;
  const w = doc.weights;
  const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
  const out: Partial<LoadRow> = { status: "billed", invoiceNo: p.parchaNo };
  const day = p.invoiceDate ?? doc.invoiceDate;
  if (typeof day === "string" && day) out.invoiceDate = day;
  if (num(doc.result?.advancePaise)) out.advancePaise = doc.result.advancePaise;
  // a dara typed on the truck is what the paper carries; any other kind is worked out by the terms
  if (doc.config?.dara?.mode === "manual" && num(doc.result?.daraPaise)) out.daraPaise = doc.result.daraPaise;
  if (!w) return out;
  if (num(w.grossGrams)) out.millGrossGrams = w.grossGrams;
  if (num(w.bardanaGrams)) out.millBardanaGrams = w.bardanaGrams;
  if (num(w.netGrams)) out.millNetGrams = w.netGrams;
  if (!num(w.katte) || !num(w.bore)) return out;
  out.bags = w.katte + w.bore;
  const was = bagCounts(l);
  if (was.katte !== w.katte || was.bore !== w.bore) { out.katteCount = w.katte; out.boreCount = w.bore; }
  const cfg = ChargeConfigSchema.safeParse(doc.config);
  if (!cfg.success || !num(w.katteBardanaGrams) || !num(w.boreBardanaGrams)) return out;
  // a bardana the paper worked out from the mill's kg a bag is left blank, so a later void follows the terms again
  const now = weighment({ ...l, ...out }, cfg.data);
  if (now.katteBardanaGrams !== w.katteBardanaGrams) {
    out.katteBardanaGrams = bardanaKg(w.katte, cfg.data.millBardanaKgPerBag) === w.katteBardanaGrams ? null : w.katteBardanaGrams;
  }
  if (now.boreBardanaGrams !== w.boreBardanaGrams) {
    out.boreBardanaGrams = bardanaKg(w.bore, cfg.data.millBoreBardanaKgPerBag) === w.boreBardanaGrams ? null : w.boreBardanaGrams;
  }
  return out;
}

/**
 * Stock, PO balances and the dashboard read the stored mill net, so it is
 * recomputed whenever a mill's terms change (e.g. bardana 0.57 → 0.60 kg) —
 * for draft trucks only; an approved truck keeps what was billed, and a draft
 * that was billed before (its parcha voided) keeps the terms it was billed on.
 */
export async function refreshDraftWeighments(merchantId: string) {
  const [m] = await db.select({ cfg: schema.merchants.chargeConfig }).from(schema.merchants).where(eq(schema.merchants.id, merchantId)).limit(1);
  if (!m) return 0;
  const cfg = ChargeConfigSchema.parse(JSON.parse(m.cfg));
  const drafts = await db.select().from(schema.loads).where(and(eq(schema.loads.merchantId, merchantId), eq(schema.loads.status, "draft")));
  for (const l of drafts) await db.update(schema.loads).set(storedWeighment(l, termsOfTruck(l.id, cfg))).where(eq(schema.loads.id, l.id));
  return drafts.length;
}

/**
 * The weight of each row: typed, or — for the one row left blank — whatever
 * of the mill's net the typed rows leave. A second blank row gets nothing
 * (and blocks approval), so a weight is never counted twice.
 */
export function resolveWeights(lines: { netGrams: number | null }[], millNetGrams: number | null): number[] {
  const typed = lines.reduce((s, l) => s + (l.netGrams ?? 0), 0);
  let restGiven = false;
  return lines.map((l) => {
    if (l.netGrams != null) return l.netGrams;
    if (restGiven || millNetGrams == null) return 0;
    restGiven = true;
    return millNetGrams - typed;
  });
}

const lineFields = {
  id: schema.loadLines.id, loadId: schema.loadLines.loadId, poId: schema.loadLines.poId,
  jinsId: schema.loadLines.jinsId, stockDate: schema.loadLines.stockDate,
  netGrams: schema.loadLines.netGrams, sort: schema.loadLines.sort, createdAt: schema.loadLines.createdAt,
  ratePaisePerQtl: schema.loadLines.ratePaisePerQtl,
  merchantId: schema.loads.merchantId, millNetGrams: schema.loads.millNetGrams,
  status: schema.loads.status, truckNo: schema.loads.truckNo, loadDate: schema.loads.loadDate,
};
const siblingFields = {
  loadId: schema.loadLines.loadId, id: schema.loadLines.id, netGrams: schema.loadLines.netGrams,
  sort: schema.loadLines.sort, createdAt: schema.loadLines.createdAt,
};

/**
 * Every truck row matching `where`, with its weight resolved against its
 * truck's mill net. The basis of stock and PO balances.
 * `wholeTrucks`: `where` keeps every row of each truck it touches (a filter by
 * truck, or by the truck's own business), so those rows are all its siblings.
 */
export async function linesWithWeights(where: SQL | undefined, opts: { wholeTrucks?: boolean } = {}) {
  const rows = await rowsOf(db.select(lineFields)
    .from(schema.loadLines)
    .innerJoin(schema.loads, eq(schema.loads.id, schema.loadLines.loadId))
    .where(where)
    .orderBy(asc(schema.loadLines.sort), asc(schema.loadLines.createdAt)), lineFields);
  // resolve per truck: the blank row depends on its siblings
  const byLoad = new Map<string, typeof rows>();
  for (const r of rows) { const a = byLoad.get(r.loadId); if (a) a.push(r); else byLoad.set(r.loadId, [r]); }
  /* A blank row needs every sibling, even ones the filter left out. With the
     whole truck in hand already, only a truck with two or more blank rows reads
     them again: which blank row comes first, and so takes the rest of the net,
     is settled by that read's order, as always. With one blank row or none,
     the order of the rows changes no weight. */
  const partial = [...byLoad.keys()];
  const read = opts.wholeTrucks ? partial.filter((id) => byLoad.get(id)!.filter((r) => r.netGrams == null).length > 1) : partial;
  const siblings = read.length ? await rowsOf(db.select(siblingFields).from(schema.loadLines).where(inArray(schema.loadLines.loadId, read))
    .orderBy(asc(schema.loadLines.sort), asc(schema.loadLines.createdAt)), siblingFields) : [];
  const siblingsOf = new Map<string, { id: string; netGrams: number | null }[]>();
  for (const sb of siblings) { const a = siblingsOf.get(sb.loadId); if (a) a.push(sb); else siblingsOf.set(sb.loadId, [sb]); }
  const weightById = new Map<string, number>();
  for (const loadId of partial) {
    const all = siblingsOf.get(loadId) ?? (opts.wholeTrucks ? byLoad.get(loadId)! : []);
    const net = byLoad.get(loadId)![0].millNetGrams;
    resolveWeights(all, net).forEach((g, i) => weightById.set(all[i].id, g));
  }
  return rows.map((r) => ({ ...r, weightGrams: weightById.get(r.id) ?? 0 }));
}

/** What was bought for a mill, per day: net and the weighted average rate (the dara). */
export async function boughtByDay(businessId: string, merchantId: string, jinsId: string | null, range?: { from?: string; to?: string; dates?: string[] }) {
  const S = schema.purchaseSlips;
  const where = [eq(S.businessId, businessId), eq(S.merchantId, merchantId)];
  if (jinsId) where.push(eq(S.jinsId, jinsId));
  if (range?.from) where.push(gte(S.slipDate, range.from));
  if (range?.to) where.push(lte(S.slipDate, range.to));
  if (range?.dates) where.push(range.dates.length ? inArray(S.slipDate, range.dates) : sql`0 = 1`);
  const rows = await db.select({
    date: S.slipDate,
    slips: sql<number>`count(*)`,
    netGrams: sql<number>`sum(${S.netGrams})`,
    amountPaise: sql<number>`sum(${S.amountPaise})`,
    pricedNet: sql<number>`sum(case when ${S.ratePaisePerQtl} > 0 then ${S.netGrams} else 0 end)`,
    pricedValue: sql<string>`cast(sum(case when ${S.ratePaisePerQtl} > 0 then ${S.netGrams} * ${S.ratePaisePerQtl} else 0 end) as text)`,
    unpriced: sql<number>`sum(case when ${S.ratePaisePerQtl} > 0 then 0 else 1 end)`,
  }).from(S).where(and(...where)).groupBy(S.slipDate);
  return new Map(rows.map((r) => [r.date, {
    date: r.date, slips: r.slips, netGrams: r.netGrams, amountPaise: r.amountPaise, unpriced: r.unpriced,
    avgRatePaisePerQtl: avgFromSums(r.pricedValue, r.pricedNet),
  }]));
}

/**
 * Everything about one truck. `millTerms`: a truck billed before and voided
 * is worked out on its mill's terms of today instead of those it was billed
 * on — the approver's own choice, for a mill whose terms were put right.
 */
export async function loadState(businessId: string, loadId: string, opts: { millTerms?: boolean } = {}) {
  const [l] = await db.select().from(schema.loads)
    .where(and(eq(schema.loads.id, loadId), eq(schema.loads.businessId, businessId))).limit(1);
  if (!l) return null;

  const [biz] = await db.select().from(schema.businesses).where(eq(schema.businesses.id, businessId)).limit(1);
  const [mill] = await db.select().from(schema.merchants).where(eq(schema.merchants.id, l.merchantId)).limit(1);
  const [jins] = await db.select().from(schema.jins).where(eq(schema.jins.id, l.jinsId)).limit(1);
  // newest first; ids are time-ordered, and the version counts the number's uses across the firm, not this truck's
  const history = await db.select().from(schema.parchas)
    .where(eq(schema.parchas.loadId, l.id)).orderBy(desc(schema.parchas.id));
  // a truck billed before keeps the terms it was billed on; one never billed takes its mill's of today
  const millCfg = ChargeConfigSchema.parse(JSON.parse(mill.chargeConfig));
  const billedCfg = truckTerms(millCfg, history);
  const live = history.some((p) => p.status === "approved");
  // voided, and its mill's terms are not those it was billed on: the approver may bill it on today's
  const millTermsChanged = !live && history.length > 0 && JSON.stringify(billedCfg) !== JSON.stringify(millCfg);
  const onMillTerms = millTermsChanged && opts.millTerms === true;
  const cfg = onMillTerms ? millCfg : billedCfg;
  const w = weighment(l, cfg);

  const rawLines = await db.select({
    line: schema.loadLines,
    poNo: schema.purchaseOrders.poNo, poDate: schema.purchaseOrders.poDate,
  })
    .from(schema.loadLines)
    .leftJoin(schema.purchaseOrders, eq(schema.purchaseOrders.id, schema.loadLines.poId))
    .where(eq(schema.loadLines.loadId, l.id))
    .orderBy(asc(schema.loadLines.sort), asc(schema.loadLines.createdAt));
  const weights = resolveWeights(rawLines.map((r) => r.line), w.netGrams);

  /* A truck can carry two or three commodities: each row has its own, and is
     priced from that commodity's purchase day for this mill. The truck's
     commodity is the first row's; stock is kept per commodity. */
  const jinsIds = [...new Set([l.jinsId, ...rawLines.map((r) => r.line.jinsId)])];
  const jinsRows = await db.select().from(schema.jins).where(inArray(schema.jins.id, jinsIds));
  const jinsOf = new Map(jinsRows.map((j) => [j.id, j]));
  const codeOf = (id: string) => jinsOf.get(id)?.code ?? "?";
  const bought = new Map<string, Awaited<ReturnType<typeof boughtByDay>>>();
  for (const jid of jinsIds) bought.set(jid, await boughtByDay(businessId, l.merchantId, jid));
  // every other truck's rows for this mill, by commodity and day
  const others = await linesWithWeights(and(
    eq(schema.loadLines.businessId, businessId),
    eq(schema.loads.merchantId, l.merchantId),
    inArray(schema.loadLines.jinsId, jinsIds),
    ne(schema.loadLines.loadId, l.id),
  ));
  const dk = (jid: string, date: string) => `${jid}|${date}`;
  const otherByDay = new Map<string, number>();
  for (const o of others) otherByDay.set(dk(o.jinsId, o.stockDate), (otherByDay.get(dk(o.jinsId, o.stockDate)) ?? 0) + o.weightGrams);
  const thisByDay = new Map<string, number>();
  rawLines.forEach((r, i) => thisByDay.set(dk(r.line.jinsId, r.line.stockDate), (thisByDay.get(dk(r.line.jinsId, r.line.stockDate)) ?? 0) + weights[i]));

  const lines = rawLines.map((r, i) => {
    const day = bought.get(r.line.jinsId)?.get(r.line.stockDate);
    const avg = day?.avgRatePaisePerQtl ?? 0;
    const rate = r.line.ratePaisePerQtl ?? avg;
    const weight = weights[i];
    const k = dk(r.line.jinsId, r.line.stockDate);
    return {
      ...r.line,
      jinsCode: codeOf(r.line.jinsId),
      poNo: r.poNo, poDate: r.poDate,
      weightGrams: weight,
      weightIsRest: r.line.netGrams == null,
      dayAvgRatePaisePerQtl: avg,
      ratePaisePerQtlUsed: rate,
      rateTyped: r.line.ratePaisePerQtl != null,
      amountPaise: amountPaise(weight, rate),
      day: {
        boughtNetGrams: day?.netGrams ?? 0,
        slips: day?.slips ?? 0,
        otherTrucksGrams: otherByDay.get(k) ?? 0,
        thisTruckGrams: thisByDay.get(k) ?? 0,
        leftGrams: (day?.netGrams ?? 0) - (otherByDay.get(k) ?? 0) - (thisByDay.get(k) ?? 0),
      },
    };
  });

  const thisTotal = weights.reduce((s, g) => s + g, 0);
  // the mill's stock of each commodity on this truck, and all of them together
  const stockByJins = jinsIds.map((jid) => {
    const b = [...(bought.get(jid)?.values() ?? [])].reduce((s, d) => s + d.netGrams, 0);
    const o = others.filter((x) => x.jinsId === jid).reduce((s, x) => s + x.weightGrams, 0);
    const mine = rawLines.reduce((s, r, i) => s + (r.line.jinsId === jid ? weights[i] : 0), 0);
    return { jinsId: jid, jinsCode: codeOf(jid), boughtNetGrams: b, otherTrucksGrams: o, thisTruckGrams: mine, leftGrams: b - o - mine };
  });
  const stock = {
    boughtNetGrams: stockByJins.reduce((s, x) => s + x.boughtNetGrams, 0),
    otherTrucksGrams: stockByJins.reduce((s, x) => s + x.otherTrucksGrams, 0),
    thisTruckGrams: thisTotal,
    leftGrams: stockByJins.reduce((s, x) => s + x.leftGrams, 0),
  };

  // POs on this truck's rows, and how much of each the other trucks took
  const poIds = [...new Set(rawLines.map((r) => r.line.poId).filter(Boolean))] as string[];
  const pos = [];
  for (const pid of poIds) {
    const [p] = await db.select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, pid)).limit(1);
    if (!p) continue;
    const onPo = await linesWithWeights(and(eq(schema.loadLines.poId, pid), ne(schema.loadLines.loadId, l.id)));
    const otherGrams = onPo.reduce((s, x) => s + x.weightGrams, 0);
    const thisGrams = lines.filter((x) => x.poId === pid).reduce((s, x) => s + x.weightGrams, 0);
    pos.push({
      id: p.id, poNo: p.poNo, poDate: p.poDate, qtyGrams: p.qtyGrams, status: p.status, validTill: p.validTill,
      otherLoadsGrams: otherGrams, thisLoadGrams: thisGrams, balanceGrams: p.qtyGrams - otherGrams - thisGrams,
    });
  }

  const approved = history.find((p) => p.status === "approved") ?? null;
  const revisionAt = (id: string) => history.length - history.findIndex((p) => p.id === id);

  /* ------------------------------------------------------------ checks */
  const blockers: Blocker[] = [];
  const warnings: Warning[] = [];
  if (!lines.length) blockers.push({ code: "no_lines" });
  for (const x of lines) if (!x.ratePaisePerQtlUsed) blockers.push({ code: "line_no_rate", date: x.stockDate });
  if (lines.filter((x) => x.netGrams == null).length > 1) blockers.push({ code: "line_no_weight" });
  // the blank row is "the rest": typed rows heavier than the mill net leave it at or below zero
  if (w.netGrams != null) {
    for (const x of lines) {
      if (x.weightGrams <= 0 && (x.netGrams == null)) blockers.push({ code: "line_not_positive", date: x.stockDate, grams: x.weightGrams });
    }
  }
  if (w.grossGrams == null || w.grossGrams <= 0) blockers.push({ code: "no_mill_gross" });
  if (w.bags <= 0) blockers.push({ code: "no_bags" });
  if (w.netGrams != null && w.netGrams <= 0) blockers.push({ code: "net_nonpositive" });
  if (w.netGrams != null && w.netGrams > 0 && lines.length && thisTotal !== w.netGrams) {
    blockers.push({ code: "lines_mismatch", linesGrams: thisTotal, millNetGrams: w.netGrams });
  }
  if (!l.invoiceNo?.trim()) blockers.push({ code: "no_invoice_no" });
  else if (!approved) {
    // the same number on another live parcha this financial year: the owner may mean it, so it is only said
    const others = await sameNumberElsewhere(businessId, l.invoiceNo, l.invoiceDate ?? l.loadDate, l.id);
    if (others.length) warnings.push({ code: "invoice_repeated", parchaNo: l.invoiceNo.trim(), others });
  }

  const seenDay = new Set<string>();
  for (const x of lines) {
    if (seenDay.has(dk(x.jinsId, x.stockDate))) continue;
    seenDay.add(dk(x.jinsId, x.stockDate));
    if (x.day.leftGrams < 0) warnings.push({ code: "stock_negative", date: x.stockDate, grams: -x.day.leftGrams });
    // the day's average leaves out slips with no rate yet: once they are priced, this truck's rate moves
    const unpriced = bought.get(x.jinsId)?.get(x.stockDate)?.unpriced ?? 0;
    if (unpriced > 0 && lines.some((y) => !y.rateTyped && y.jinsId === x.jinsId && y.stockDate === x.stockDate)) {
      warnings.push({ code: "day_unpriced", date: x.stockDate, jinsCode: x.jinsCode, slips: unpriced });
    }
  }
  for (const p of pos) {
    const name = p.poNo || p.poDate;
    if (p.balanceGrams < 0) warnings.push({ code: "po_over", po: name, overGrams: -p.balanceGrams });
    if (p.status === "closed") warnings.push({ code: "po_closed", po: name });
    if (p.validTill && p.validTill < l.loadDate) warnings.push({ code: "po_expired", po: name, validTill: p.validTill });
  }
  const labourOnBore = [cfg.labour1, cfg.labour2].some((x) => x.enabled && x.appliesTo !== "katte");
  if (w.bore > 0 && !labourOnBore) warnings.push({ code: "bore_no_labour" });

  /* ------------------------------------------------------------ parcha */
  let doc: ParchaDoc | null = null;
  const ready = w.grossGrams != null && w.netGrams != null && w.netGrams > 0 && lines.length > 0
    && lines.every((x) => x.ratePaisePerQtlUsed > 0);
  if (ready) {
    const goods = lines.reduce((s, x) => s + x.amountPaise, 0);
    const rate = lines.length === 1 ? lines[0].ratePaisePerQtlUsed : rateOf(goods, thisTotal);
    const result = computeParcha(cfg, {
      grossGrams: w.grossGrams!,
      katte: w.katte, bore: w.bore,
      katteBardanaGrams: w.katteBardanaGrams, boreBardanaGrams: w.boreBardanaGrams,
      netGrams: w.netGrams!,
      ratePaisePerQtl: rate,
      goodsPaise: goods,
      trucks: 1,
      advancePaise: l.advancePaise,
      manualDaraPaise: l.daraPaise,
    });
    doc = {
      title: cfg.parcha.title, titleHi: cfg.parcha.titleHi,
      business: { name: biz.name, nameHi: biz.nameHi, city: biz.city ?? biz.district, state: biz.state, gstin: biz.gstin },
      mill: { code: mill.code, name: mill.name, nameHi: mill.nameHi, city: mill.city, state: mill.state, gstin: mill.gstin },
      invoiceNo: l.invoiceNo?.trim() || null,
      invoiceDate: l.invoiceDate ?? l.loadDate,
      version: approved ? approved.version : (l.invoiceNo?.trim() ? await nextVersion(businessId, l.invoiceNo.trim()) : 1),
      // a truck approved again after a void gets a revised paper (the day is set when it is approved)
      revision: approved ? revisionAt(approved.id) : history.length + 1,
      revisedOn: null,
      truckNo: l.truckNo, loadDate: l.loadDate, ewayBillNo: l.ewayBillNo,
      weights: {
        grossGrams: w.grossGrams!, bardanaGrams: w.bardanaGrams, netGrams: w.netGrams!,
        katte: w.katte, bore: w.bore, katteBardanaGrams: w.katteBardanaGrams, boreBardanaGrams: w.boreBardanaGrams,
      },
      lines: lines.map((x, i) => ({
        po: x.poNo || (x.poId && x.poDate ? `${x.poDate.slice(8, 10)}-${x.poDate.slice(5, 7)}` : String(i + 1)),
        jinsCode: x.jinsCode,
        date: x.stockDate,
        netGrams: x.weightGrams,
        ratePaisePerQtl: x.ratePaisePerQtlUsed,
        amountPaise: x.amountPaise,
      })),
      totals: { netGrams: thisTotal, ratePaisePerQtl: rate, goodsPaise: goods },
      result,
      config: cfg,
      stock: [...new Map(lines.map((x) => [dk(x.jinsId, x.stockDate), x])).values()].map((x) => ({
        date: x.stockDate, jinsCode: x.jinsCode,
        boughtNetGrams: bought.get(x.jinsId)?.get(x.stockDate)?.netGrams ?? 0, avgRatePaisePerQtl: bought.get(x.jinsId)?.get(x.stockDate)?.avgRatePaisePerQtl ?? 0,
      })),
    };
  }

  return {
    load: l,
    mill: { id: mill.id, code: mill.code, name: mill.name, nameHi: mill.nameHi },
    jins: { id: jins.id, code: jins.code, name: jins.name, nameHi: jins.nameHi },
    /** Every commodity on the truck's rows (the first is the truck's own). */
    jinsList: jinsIds.map((jid) => ({ id: jid, code: codeOf(jid), name: jinsOf.get(jid)?.name ?? "", nameHi: jinsOf.get(jid)?.nameHi ?? null })),
    config: cfg,
    /** Voided, and the mill's terms changed since it was billed: approving may use either (see onMillTerms). */
    millTermsChanged,
    /** This state is worked out on the mill's terms of today rather than those the truck was billed on. */
    onMillTerms,
    lines,
    stock,
    stockByJins,
    weighment: w,
    pos,
    blockers,
    warnings,
    doc,
    approved: approved ? { ...approved, snapshot: undefined, revision: revisionAt(approved.id), doc: withRevision(JSON.parse(approved.snapshot) as ParchaDoc, revisionAt(approved.id)) } : null,
    /* The approved parcha is frozen. When the figures behind it have moved
       since (a slip's rate on one of its days), say what it would be now, so
       the owner can void and re-approve — or leave it. The mill's terms are
       not among them: the truck keeps the terms it was billed on. */
    stale: (() => {
      if (!approved || !doc) return null;
      const was = JSON.parse(approved.snapshot) as ParchaDoc;
      if (was.result.grandTotalPaise === doc.result.grandTotalPaise && was.totals.goodsPaise === doc.totals.goodsPaise) return null;
      return {
        wasGrandTotalPaise: was.result.grandTotalPaise, nowGrandTotalPaise: doc.result.grandTotalPaise,
        wasGoodsPaise: was.totals.goodsPaise, nowGoodsPaise: doc.totals.goodsPaise,
        days: doc.lines.filter((x) => was.lines.some((y) => y.date === x.date && y.jinsCode === x.jinsCode && y.ratePaisePerQtl !== x.ratePaisePerQtl))
          .map((x) => ({ date: x.date, wasRate: was.lines.find((y) => y.date === x.date && y.jinsCode === x.jinsCode)!.ratePaisePerQtl, nowRate: x.ratePaisePerQtl })),
      };
    })(),
    history: history.map((p) => ({ ...p, snapshot: undefined, revision: revisionAt(p.id) })),
    suggestedInvoiceNo: l.invoiceNo ? null : await suggestInvoiceNo(businessId, l.id, l.invoiceDate ?? l.loadDate),
  };
}

export type LoadState = NonNullable<Awaited<ReturnType<typeof loadState>>>;

/**
 * Days a truck for this mill and commodity can load from: every day with
 * purchases or earlier trucks, newest first, with what is left.
 */
export async function stockDays(businessId: string, merchantId: string, jinsId: string, exceptLoadId?: string) {
  const bought = await boughtByDay(businessId, merchantId, jinsId);
  const lines = await linesWithWeights(and(
    eq(schema.loadLines.businessId, businessId),
    eq(schema.loads.merchantId, merchantId),
    eq(schema.loadLines.jinsId, jinsId),
    exceptLoadId ? ne(schema.loadLines.loadId, exceptLoadId) : undefined,
  ));
  const loaded = new Map<string, number>();
  for (const x of lines) loaded.set(x.stockDate, (loaded.get(x.stockDate) ?? 0) + x.weightGrams);
  const dates = [...new Set([...bought.keys(), ...loaded.keys()])].sort().reverse();
  return dates.map((d) => {
    const b = bought.get(d);
    return {
      date: d,
      slips: b?.slips ?? 0,
      boughtNetGrams: b?.netGrams ?? 0,
      avgRatePaisePerQtl: b?.avgRatePaisePerQtl ?? 0,
      unpriced: b?.unpriced ?? 0,
      loadedGrams: loaded.get(d) ?? 0,
      leftGrams: (b?.netGrams ?? 0) - (loaded.get(d) ?? 0),
    };
  });
}

/**
 * Approved parchas whose rows take a purchase day's average rate (no typed
 * rate) on any of these days. A slip changed on such a day moves that
 * average, so the frozen parcha no longer matches the daily list.
 */
export async function approvedOnDays(businessId: string, days: { merchantId: string | null; jinsId: string; date: string }[]) {
  const real = days.filter((d): d is { merchantId: string; jinsId: string; date: string } => Boolean(d.merchantId));
  if (!real.length) return [];
  const LL = schema.loadLines;
  const rows = await db.select({
    loadId: schema.loads.id, truckNo: schema.loads.truckNo, merchantId: schema.loads.merchantId,
    jinsId: LL.jinsId, date: LL.stockDate, typed: LL.ratePaisePerQtl, parchaNo: schema.parchas.parchaNo,
  }).from(LL)
    .innerJoin(schema.loads, eq(schema.loads.id, LL.loadId))
    .innerJoin(schema.parchas, and(eq(schema.parchas.loadId, schema.loads.id), eq(schema.parchas.status, "approved")))
    .where(and(eq(LL.businessId, businessId), inArray(LL.stockDate, [...new Set(real.map((d) => d.date))])));
  const hit = new Map<string, { loadId: string; parchaNo: string; truckNo: string | null; date: string }>();
  for (const r of rows) {
    if (r.typed != null) continue;
    if (real.some((d) => d.merchantId === r.merchantId && d.jinsId === r.jinsId && d.date === r.date)) {
      hit.set(r.loadId, { loadId: r.loadId, parchaNo: r.parchaNo, truckNo: r.truckNo, date: r.date });
    }
  }
  return [...hit.values()];
}
