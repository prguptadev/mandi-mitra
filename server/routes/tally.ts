import { Hono } from "hono";
import { z } from "zod";
import { and, eq, gte, lte, isNull, inArray, sql } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { newId, nowSec } from "../lib/ids.ts";
import { audit } from "../lib/audit.ts";
import { amountPaise } from "../lib/money.ts";
import { can, canAll, actor, bad, isoDay, type Env } from "../lib/http.ts";
import { readSetting, writeSetting } from "./settings.ts";
import { TallySettingsSchema, defaultTallySettings, vouchersFile, ledgersFile, type TallySettings, type TallyVoucher, type TallyLedger, oneFile } from "../lib/tally.ts";
import type { ParchaDoc } from "../lib/parcha.ts";

/* Sending the books to Tally Prime: purchases, payments to suppliers, kaccha
   parchas (sales to mills), money from mills and the mills' weight cuts, as
   Tally import files. What was sent is remembered (tally_exports), so nothing
   goes twice, and an entry changed here afterwards is listed for fixing. */

export const tallyRoutes = new Hono<Env>();
export const KINDS = ["slip", "payment", "parcha", "receipt", "cut"] as const;
type Kind = (typeof KINDS)[number];
const guard = canAll("export.data", "ledger.read", "millledger.read");

export async function settingsOf(biz: string): Promise<TallySettings> {
  const raw = await readSetting(biz, "tally");
  if (!raw) return defaultTallySettings();
  const p = TallySettingsSchema.safeParse(JSON.parse(raw));
  return p.success ? p.data : defaultTallySettings();
}

tallyRoutes.get("/settings", guard, async (c) => c.json(await settingsOf(c.get("auth")!.businessId!)));
tallyRoutes.put("/settings", can("settings.write"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const next = TallySettingsSchema.parse(await c.req.json());
  await writeSetting(biz, "tally", JSON.stringify(next));
  await audit({ actor: actor(c), action: "settings.tally.update", entity: "settings", entityId: "tally", entityLabel: "Tally ledger names", after: next });
  return c.json(next);
});

type Entry = { kind: Kind; id: string; fp: string; day: string };
/** Only one party's entries: a supplier's purchases and payments, or a mill's sales, cuts, money and the purchases loaded for it. */
export type Party = { adatiId?: string | null; merchantId?: string | null };
/** A parcha counts on its invoice date, else on its truck's load date (as in the mill ledger). */
const parchaDay = sql<string>`coalesce(${schema.parchas.invoiceDate}, ${schema.loads.loadDate})`;

/** Everything in the period that Tally should hold, as vouchers, with each source entry's fingerprint. */
/** Everything a Tally file is made of, for a period. Used by the route and by scripts/tally-check.ts. */
export async function build(biz: string, from: string, to: string, kinds0: Kind[], cfg: TallySettings, skip: Set<string> = new Set(), party: Party = {}) {
  // a supplier has no sales; a mill has no supplier payments
  const kinds = kinds0.filter((k) => !(party.adatiId && (k === "parcha" || k === "cut" || k === "receipt")) && !(party.merchantId && k === "payment"));
  const L = cfg.ledgers, T = cfg.voucherTypes;
  const vouchers: TallyVoucher[] = [];
  const entries: Entry[] = [];
  const ledgers = new Map<string, string>(); // name → parent group
  const openings = new Map<string, number>(); // party ledger → opening balance, Tally sign
  const charges = new Map<string, string>(); // parcha charge key → its label, for naming its Tally ledger
  const use = (name: string, parent: string) => { if (!ledgers.has(name)) ledgers.set(name, parent); return name; };
  let unpriced = 0, alreadySent = 0;
  // entries already in Tally stay out (counted), before anything is grouped
  const fresh = <T,>(kind: Kind, list: T[], id: (x: T) => string) => {
    const out = list.filter((x) => !skip.has(`${kind}|${id(x)}`));
    alreadySent += list.length - out.length;
    return out;
  };

  // party names as Tally holds them; two suppliers with one name get their village added
  const sups = await db.select({ id: schema.adati.id, nameHi: schema.adati.nameHi, nameHinglish: schema.adati.nameHinglish, village: schema.adati.village, opening: schema.adati.openingBalancePaise })
    .from(schema.adati).where(eq(schema.adati.businessId, biz));
  const base = (s: (typeof sups)[number]) => (cfg.partyNames === "hindi" ? s.nameHi : s.nameHinglish || s.nameHi).trim();
  const count = new Map<string, number>();
  for (const s of sups) count.set(base(s).toLowerCase(), (count.get(base(s).toLowerCase()) ?? 0) + 1);
  const supName = new Map(sups.map((s) => [s.id, count.get(base(s).toLowerCase())! > 1 ? `${base(s)} - ${s.village || s.id.slice(-4)}` : base(s)]));
  const mills = await db.select({ id: schema.merchants.id, code: schema.merchants.code, name: schema.merchants.name, opening: schema.merchants.openingBalancePaise })
    .from(schema.merchants).where(eq(schema.merchants.businessId, biz));
  const mCount = new Map<string, number>();
  for (const m of mills) mCount.set((m.name || m.code).toLowerCase(), (mCount.get((m.name || m.code).toLowerCase()) ?? 0) + 1);
  const millName = new Map(mills.map((m) => [m.id, mCount.get((m.name || m.code).toLowerCase())! > 1 ? `${m.name} (${m.code})` : m.name || m.code]));
  // what the party was owed (or owed us) before the app: the ledger's opening in Tally.
  // A supplier's positive opening is what we owe (credit); a mill's is what it owes us (debit, negative in Tally).
  const supOpening = new Map(sups.map((s) => [s.id, s.opening]));
  const millOpening = new Map(mills.map((m) => [m.id, -m.opening]));
  const sup = (id: string) => { const n = use(supName.get(id) ?? id, cfg.supplierGroup); if (supOpening.get(id)) openings.set(n, supOpening.get(id)!); return n; };
  const mill = (id: string) => { const n = use(millName.get(id) ?? id, cfg.millGroup); if (millOpening.get(id)) openings.set(n, millOpening.get(id)!); return n; };
  const cashOrBank = (mode: string) => (mode === "cash" ? use(L.cash, "Cash-in-Hand") : use(L.bank, "Bank Accounts"));
  const q2 = (g: number) => { const kg = Math.round(g / 1000); return `${Math.floor(kg / 100)}.${String(kg % 100).padStart(2, "0")}`; };

  if (kinds.includes("slip")) {
    const S = schema.purchaseSlips;
    const slips = await db.select({ s: S, jins: schema.jins.code, millCode: schema.merchants.code }).from(S)
      .innerJoin(schema.jins, eq(schema.jins.id, S.jinsId))
      .leftJoin(schema.merchants, eq(schema.merchants.id, S.merchantId))
      .where(and(eq(S.businessId, biz), gte(S.slipDate, from), lte(S.slipDate, to),
        party.adatiId ? eq(S.adatiId, party.adatiId) : undefined, party.merchantId ? eq(S.merchantId, party.merchantId) : undefined));
    const pricedAll = slips.filter((x) => x.s.ratePaisePerQtl > 0);
    unpriced = slips.length - pricedAll.length;
    const priced = fresh("slip", pricedAll, (x) => x.s.id);
    const groups = new Map<string, typeof priced>();
    for (const x of priced) {
      const k = cfg.purchasePer === "slip" ? x.s.id : `${x.s.adatiId}|${x.s.slipDate}`;
      groups.set(k, [...(groups.get(k) ?? []), x]);
    }
    for (const g of groups.values()) {
      const s0 = g[0].s;
      const sum = (f: (y: (typeof g)[number]["s"]) => number) => g.reduce((t, y) => t + f(y.s), 0);
      const rsts = g.map((y) => y.s.rstNo).join(", ");
      vouchers.push({
        type: T.purchase, date: s0.slipDate, number: g.length === 1 ? `RST ${s0.rstNo}` : undefined, reference: rsts.slice(0, 60),
        party: sup(s0.adatiId),
        narration: g.length === 1
          ? `RST ${s0.rstNo} · ${q2(s0.netGrams)} qtl × Rs ${(s0.ratePaisePerQtl / 100).toFixed(2)} · ${g[0].jins}${g[0].millCode ? ` · ${g[0].millCode}` : ""}`
          : `RST ${rsts} · ${q2(sum((y) => y.netGrams))} qtl · ${g.length} slips`,
        lines: [
          { ledger: use(L.purchase, "Purchase Accounts"), paise: sum((y) => y.amountPaise) },
          { ledger: use(L.commissionPaid, "Direct Expenses"), paise: sum((y) => y.commissionPaise) },
          { ledger: use(L.gaushalaPaid, "Direct Expenses"), paise: sum((y) => y.gaushalaPaise) },
          { ledger: sup(s0.adatiId), paise: -sum((y) => y.payablePaise) },
        ],
      });
      for (const y of g) entries.push({ kind: "slip", id: y.s.id, fp: fpSlip(y.s), day: y.s.slipDate });
    }
  }

  if (kinds.includes("payment")) {
    const P = schema.payments;
    const pays = fresh("payment", await db.select().from(P).where(and(eq(P.businessId, biz), isNull(P.voidedAt), gte(P.payDate, from), lte(P.payDate, to),
      party.adatiId ? eq(P.adatiId, party.adatiId) : undefined)), (x) => x.id);
    for (const p of pays) {
      vouchers.push({
        type: T.payment, date: p.payDate, number: p.voucherNo ? `PV-${p.voucherNo}` : undefined, reference: p.reference ?? undefined, party: sup(p.adatiId),
        narration: [`Paid by ${p.mode}`, p.reference, p.notes].filter(Boolean).join(" · "),
        lines: [{ ledger: sup(p.adatiId), paise: p.amountPaise }, { ledger: cashOrBank(p.mode), paise: -p.amountPaise }],
      });
      entries.push({ kind: "payment", id: p.id, fp: fpPayment(p), day: p.payDate });
    }
  }

  const PA = schema.parchas;
  const parchas = kinds.includes("parcha") || kinds.includes("cut")
    ? await db.select({ p: PA, l: schema.loads }).from(PA).innerJoin(schema.loads, eq(schema.loads.id, PA.loadId))
      .where(and(eq(PA.businessId, biz), eq(PA.status, "approved"), sql`${parchaDay} >= ${from}`, sql`${parchaDay} <= ${to}`,
        party.merchantId ? eq(schema.loads.merchantId, party.merchantId) : undefined))
    : [];
  if (kinds.includes("parcha")) {
    for (const { p, l } of fresh("parcha", parchas, (x) => x.p.id)) {
      const d = JSON.parse(p.snapshot) as ParchaDoc;
      const r = d.result;
      const lines = [
        { ledger: mill(l.merchantId), paise: r.grandTotalPaise },
        { ledger: use(L.sales, "Sales Accounts"), paise: -r.goodsAmountPaise },
      ];
      for (const x of r.lines) {
        if (x.kind !== "charge" || !x.amountPaise) continue;
        if (!charges.has(x.key)) charges.set(x.key, x.label);
        const name = (cfg.chargeLedgers[x.key] || x.label).trim();
        lines.push({ ledger: use(name, /mandi|tax|shulk|cess/i.test(`${x.key} ${x.label}`) ? "Duties & Taxes" : "Indirect Incomes"), paise: x.sign === "subtract" ? x.amountPaise : -x.amountPaise });
      }
      if (r.advancePaise && d.config.advance.treatment !== "exclude") {
        lines.push({ ledger: use(L.advance, "Current Assets"), paise: d.config.advance.treatment === "subtract" ? r.advancePaise : -r.advancePaise });
      }
      if (r.daraPaise && d.config.dara.includeInGrandTotal) lines.push({ ledger: use(L.dara, "Indirect Incomes"), paise: -r.daraPaise });
      // the grand-total rounding: whatever keeps the voucher exact
      const rest = lines.reduce((s, x) => s + x.paise, 0);
      if (rest) lines.push({ ledger: use(L.roundOff, "Indirect Expenses"), paise: -rest });
      vouchers.push({
        type: T.sales, date: p.invoiceDate ?? l.loadDate, number: p.version > 1 ? `${p.parchaNo}/${p.version}` : p.parchaNo, reference: l.truckNo ?? undefined,
        party: mill(l.merchantId),
        narration: `Kaccha parcha ${p.parchaNo}${p.version > 1 ? ` v${p.version}` : ""} · truck ${l.truckNo ?? "-"} · ${q2(d.totals.netGrams)} qtl × Rs ${(d.totals.ratePaisePerQtl / 100).toFixed(2)}`,
        lines,
      });
      entries.push({ kind: "parcha", id: p.id, fp: fpParcha(p), day: p.invoiceDate ?? l.loadDate });
    }
  }

  if (kinds.includes("cut")) {
    for (const { p, l } of fresh("cut", parchas.filter((x) => x.l.millDeductionGrams > 0), (x) => x.l.id)) {
      if (!l.millDeductionGrams) continue;
      const d = JSON.parse(p.snapshot) as ParchaDoc;
      const value = amountPaise(l.millDeductionGrams, d.totals.ratePaisePerQtl);
      if (!value) continue;
      vouchers.push({
        type: T.journal, date: p.invoiceDate ?? l.loadDate, reference: p.parchaNo, party: mill(l.merchantId),
        narration: `Weight cut on parcha ${p.parchaNo} · ${q2(l.millDeductionGrams)} qtl${l.millDeductionNote ? ` · ${l.millDeductionNote}` : ""}`,
        lines: [{ ledger: use(L.weightShortage, "Indirect Expenses"), paise: value }, { ledger: mill(l.merchantId), paise: -value }],
      });
      entries.push({ kind: "cut", id: l.id, fp: fpCut(l.millDeductionGrams, value), day: p.invoiceDate ?? l.loadDate });
    }
  }

  if (kinds.includes("receipt")) {
    const R = schema.millReceipts;
    const recs = fresh("receipt", await db.select().from(R).where(and(eq(R.businessId, biz), isNull(R.voidedAt), gte(R.receiptDate, from), lte(R.receiptDate, to),
      party.merchantId ? eq(R.merchantId, party.merchantId) : undefined)), (x) => x.id);
    for (const x of recs) {
      vouchers.push({
        type: T.receipt, date: x.receiptDate, number: x.voucherNo ? `RV-${x.voucherNo}` : undefined, reference: x.reference ?? undefined, party: mill(x.merchantId),
        narration: [`Received by ${x.mode}`, x.reference, x.deductionPaise ? `held back Rs ${(x.deductionPaise / 100).toFixed(2)}${x.deductionNote ? ` (${x.deductionNote})` : ""}` : "", x.notes].filter(Boolean).join(" · "),
        lines: [
          { ledger: cashOrBank(x.mode), paise: x.amountPaise },
          { ledger: use(L.millDeductions, "Current Assets"), paise: x.deductionPaise },
          { ledger: mill(x.merchantId), paise: -(x.amountPaise + x.deductionPaise) },
        ],
      });
      entries.push({ kind: "receipt", id: x.id, fp: fpReceipt(x), day: x.receiptDate });
    }
  }
  vouchers.sort((a, b) => a.date.localeCompare(b.date));
  return { vouchers, entries, ledgers: [...ledgers].map(([name, parent]): TallyLedger => ({ name, parent, openingPaise: openings.get(name) })), unpriced, alreadySent, charges: [...charges].map(([key, label]) => ({ key, label })) };
}

const fpSlip = (s: typeof schema.purchaseSlips.$inferSelect) => [s.slipDate, s.adatiId, s.amountPaise, s.commissionPaise, s.gaushalaPaise, s.payablePaise].join("|");
const fpPayment = (p: typeof schema.payments.$inferSelect) => [p.payDate, p.adatiId, p.amountPaise, p.mode].join("|");
const fpParcha = (p: typeof schema.parchas.$inferSelect) => [p.invoiceDate, p.parchaNo, p.version, p.grandTotalPaise, p.status].join("|");
const fpReceipt = (x: typeof schema.millReceipts.$inferSelect) => [x.receiptDate, x.merchantId, x.amountPaise, x.deductionPaise, x.mode].join("|");
const fpCut = (grams: number, value: number) => [grams, value].join("|");

/** Entries sent to Tally that have since changed here, or been cancelled or deleted. */
async function changedSince(biz: string) {
  const marks = await db.select().from(schema.tallyExports).where(eq(schema.tallyExports.businessId, biz));
  if (!marks.length) return [];
  const ids = (k: Kind) => marks.filter((m) => m.kind === k).map((m) => m.entityId);
  const now = new Map<string, string | null>();
  const chunk = async <T,>(list: string[], q: (part: string[]) => Promise<T[]>) => { const out: T[] = []; for (let i = 0; i < list.length; i += 500) out.push(...await q(list.slice(i, i + 500))); return out; };
  for (const s of await chunk(ids("slip"), (x) => db.select().from(schema.purchaseSlips).where(inArray(schema.purchaseSlips.id, x)))) now.set(`slip|${s.id}`, fpSlip(s));
  for (const p of await chunk(ids("payment"), (x) => db.select().from(schema.payments).where(inArray(schema.payments.id, x)))) now.set(`payment|${p.id}`, p.voidedAt ? null : fpPayment(p));
  for (const p of await chunk(ids("parcha"), (x) => db.select().from(schema.parchas).where(inArray(schema.parchas.id, x)))) now.set(`parcha|${p.id}`, p.status === "approved" ? fpParcha(p) : null);
  for (const r of await chunk(ids("receipt"), (x) => db.select().from(schema.millReceipts).where(inArray(schema.millReceipts.id, x)))) now.set(`receipt|${r.id}`, r.voidedAt ? null : fpReceipt(r));
  for (const l of await chunk(ids("cut"), (x) => db.select().from(schema.loads).where(inArray(schema.loads.id, x)))) {
    const [p] = await db.select().from(schema.parchas).where(and(eq(schema.parchas.loadId, l.id), eq(schema.parchas.status, "approved"))).limit(1);
    now.set(`cut|${l.id}`, p && l.millDeductionGrams ? fpCut(l.millDeductionGrams, amountPaise(l.millDeductionGrams, (JSON.parse(p.snapshot) as ParchaDoc).totals.ratePaisePerQtl)) : null);
  }
  return marks.filter((m) => now.get(`${m.kind}|${m.entityId}`) !== m.fingerprint).map((m) => ({
    kind: m.kind as Kind, id: m.entityId, sent: m.fingerprint, now: now.get(`${m.kind}|${m.entityId}`) ?? null, exportedAt: m.exportedAt,
  }));
}

const Q = z.object({
  from: isoDay(), to: isoDay(),
  kinds: z.array(z.enum(KINDS)).min(1),
  /** Leave out what was sent to Tally before (the usual). */
  onlyNew: z.boolean().default(true),
  /** Only this supplier's, or only this mill's, entries. */
  adatiId: z.string().nullish(),
  merchantId: z.string().nullish(),
});

/* ------------------------------------------------ where each entry stands */

export type TallyState = "new" | "sent" | "changed" | "unpriced";
export interface EntryState { kind: Kind; id: string; day: string; state: TallyState; at: number | null; by: string | null }

/** Every entry in the period and whether Tally has it: not yet, yes, or yes but it changed here since.
 *  Reads only the figures a fingerprint needs, so a whole season stays quick. */
export async function tallyStatus(biz: string, from: string, to: string, kinds: Kind[], party: Party = {}): Promise<EntryState[]> {
  const TE = schema.tallyExports;
  const mark = (kind: Kind, id: Parameters<typeof eq>[1]) => and(eq(TE.businessId, biz), eq(TE.kind, kind), eq(TE.entityId, id as never));
  const out: EntryState[] = [];
  // a left join with nothing on the right comes back as null
  const put = (kind: Kind, id: string, day: string, fp: string | null, m: { fp: string | null; at: number | null; by: string | null } | null) =>
    out.push({ kind, id, day, at: m?.at ?? null, by: m?.by ?? null, state: fp === null ? "unpriced" : m?.fp == null ? "new" : m.fp === fp ? "sent" : "changed" });
  const M = { fp: TE.fingerprint, at: TE.exportedAt, by: TE.exportedBy };

  if (kinds.includes("slip")) {
    const S = schema.purchaseSlips;
    const rows = await db.select({ s: { id: S.id, slipDate: S.slipDate, adatiId: S.adatiId, amountPaise: S.amountPaise, commissionPaise: S.commissionPaise, gaushalaPaise: S.gaushalaPaise, payablePaise: S.payablePaise, ratePaisePerQtl: S.ratePaisePerQtl }, m: M })
      .from(S).leftJoin(TE, mark("slip", S.id))
      .where(and(eq(S.businessId, biz), gte(S.slipDate, from), lte(S.slipDate, to),
        party.adatiId ? eq(S.adatiId, party.adatiId) : undefined, party.merchantId ? eq(S.merchantId, party.merchantId) : undefined));
    for (const r of rows) put("slip", r.s.id, r.s.slipDate, r.s.ratePaisePerQtl > 0 ? fpSlip(r.s as typeof S.$inferSelect) : null, r.m);
  }
  if (kinds.includes("payment") && !party.merchantId) {
    const P = schema.payments;
    const rows = await db.select({ p: { id: P.id, payDate: P.payDate, adatiId: P.adatiId, amountPaise: P.amountPaise, mode: P.mode }, m: M })
      .from(P).leftJoin(TE, mark("payment", P.id))
      .where(and(eq(P.businessId, biz), isNull(P.voidedAt), gte(P.payDate, from), lte(P.payDate, to), party.adatiId ? eq(P.adatiId, party.adatiId) : undefined));
    for (const r of rows) put("payment", r.p.id, r.p.payDate, fpPayment(r.p as typeof P.$inferSelect), r.m);
  }
  if ((kinds.includes("parcha") || kinds.includes("cut")) && !party.adatiId) {
    const PA = schema.parchas, LD = schema.loads;
    const where = and(eq(PA.businessId, biz), eq(PA.status, "approved"), sql`${parchaDay} >= ${from}`, sql`${parchaDay} <= ${to}`,
      party.merchantId ? eq(LD.merchantId, party.merchantId) : undefined);
    if (kinds.includes("parcha")) {
      const rows = await db.select({ p: { id: PA.id, invoiceDate: PA.invoiceDate, parchaNo: PA.parchaNo, version: PA.version, grandTotalPaise: PA.grandTotalPaise, status: PA.status }, day: parchaDay, m: M })
        .from(PA).innerJoin(LD, eq(LD.id, PA.loadId)).leftJoin(TE, mark("parcha", PA.id)).where(where);
      for (const r of rows) put("parcha", r.p.id, r.day, fpParcha(r.p as typeof PA.$inferSelect), r.m);
    }
    if (kinds.includes("cut")) {
      const rows = await db.select({ id: LD.id, grams: LD.millDeductionGrams, snapshot: PA.snapshot, day: parchaDay, m: M })
        .from(PA).innerJoin(LD, eq(LD.id, PA.loadId)).leftJoin(TE, mark("cut", LD.id)).where(and(where, sql`${LD.millDeductionGrams} > 0`));
      for (const r of rows) {
        const value = amountPaise(r.grams, (JSON.parse(r.snapshot) as ParchaDoc).totals.ratePaisePerQtl);
        if (value) put("cut", r.id, r.day, fpCut(r.grams, value), r.m);
      }
    }
  }
  if (kinds.includes("receipt") && !party.adatiId) {
    const R = schema.millReceipts;
    const rows = await db.select({ x: { id: R.id, receiptDate: R.receiptDate, merchantId: R.merchantId, amountPaise: R.amountPaise, deductionPaise: R.deductionPaise, mode: R.mode }, m: M })
      .from(R).leftJoin(TE, mark("receipt", R.id))
      .where(and(eq(R.businessId, biz), isNull(R.voidedAt), gte(R.receiptDate, from), lte(R.receiptDate, to), party.merchantId ? eq(R.merchantId, party.merchantId) : undefined));
    for (const r of rows) put("receipt", r.x.id, r.x.receiptDate, fpReceipt(r.x as typeof R.$inferSelect), r.m);
  }
  return out;
}

type Tally4 = Record<TallyState, number>;
const zero = (): Tally4 => ({ new: 0, sent: 0, changed: 0, unpriced: 0 });

/** Day by day: how many entries of each kind are new, in Tally, or changed since. */
export async function tallyDays(biz: string, from: string, to: string, kinds: Kind[], party: Party = {}) {
  const byDay = new Map<string, { day: string; all: Tally4; kinds: Partial<Record<Kind, Tally4>> }>();
  for (const e of await tallyStatus(biz, from, to, kinds, party)) {
    let d = byDay.get(e.day);
    if (!d) { d = { day: e.day, all: zero(), kinds: {} }; byDay.set(e.day, d); }
    d.all[e.state]++;
    (d.kinds[e.kind] ??= zero())[e.state]++;
  }
  return [...byDay.values()].sort((a, b) => b.day.localeCompare(a.day));
}

async function pick(biz: string, body: z.infer<typeof Q>) {
  if (body.from > body.to) throw bad("The from date is after the to date", "bad_range");
  const cfg = await settingsOf(biz);
  const skip = new Set<string>();
  if (body.onlyNew) {
    const marks = await db.select({ kind: schema.tallyExports.kind, id: schema.tallyExports.entityId }).from(schema.tallyExports)
      .where(eq(schema.tallyExports.businessId, biz));
    for (const m of marks) skip.add(`${m.kind}|${m.id}`);
  }
  return { cfg, ...(await build(biz, body.from, body.to, body.kinds, cfg, skip, { adatiId: body.adatiId, merchantId: body.merchantId })) };
}

/** The day-by-day table of the Tally screen. */
tallyRoutes.post("/days", guard, async (c) => {
  const biz = c.get("auth")!.businessId!;
  const body = Q.parse(await c.req.json());
  if (body.from > body.to) throw bad("The from date is after the to date", "bad_range");
  return c.json({ days: await tallyDays(biz, body.from, body.to, body.kinds, { adatiId: body.adatiId, merchantId: body.merchantId }) });
});

/** The little "in Tally" mark on each row of a list: only entries Tally has (or had), with when and by whom. */
tallyRoutes.get("/flags", can("slip.read", "payment.read", "parcha.read", "millledger.read", "ledger.read"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const q = z.object({ kind: z.enum(KINDS), from: isoDay(), to: isoDay() }).parse(c.req.query());
  const list = (await tallyStatus(biz, q.from, q.to, [q.kind])).filter((e) => e.state === "sent" || e.state === "changed");
  const ids = [...new Set(list.map((e) => e.by).filter((x): x is string => Boolean(x)))];
  const names = new Map(ids.length ? (await db.select({ id: schema.users.id, name: schema.users.name }).from(schema.users).where(inArray(schema.users.id, ids))).map((u) => [u.id, u.name]) : []);
  return c.json({ flags: Object.fromEntries(list.map((e) => [e.id, { state: e.state, at: e.at, by: e.by ? names.get(e.by) ?? null : null }])) });
});

/** What would go: counts, and what needs fixing in Tally by hand. */
tallyRoutes.post("/preview", guard, async (c) => {
  const biz = c.get("auth")!.businessId!;
  const body = Q.parse(await c.req.json());
  const s = await pick(biz, body);
  const byKind = Object.fromEntries(KINDS.map((k) => [k, s.entries.filter((e) => e.kind === k).length]));
  return c.json({
    vouchers: s.vouchers.length, entries: byKind, unpriced: s.unpriced, alreadySent: s.alreadySent,
    ledgers: s.ledgers.map((l) => l.name), charges: s.charges, changed: await changedSince(biz),
  });
});

/** The two files (ledgers first, then vouchers) and the entries in them; nothing is marked yet. */
tallyRoutes.post("/export", guard, async (c) => {
  const biz = c.get("auth")!.businessId!;
  const body = Q.parse(await c.req.json());
  const s = await pick(biz, body);
  let vouchers: string;
  try { vouchers = vouchersFile(s.cfg.companyName, s.vouchers); } catch (e) { throw bad(e instanceof Error ? e.message : "A voucher does not balance", "unbalanced"); }
  await audit({ actor: actor(c), action: "tally.export", entity: "settings", entityId: "tally",
    entityLabel: `Tally file ${body.from} to ${body.to}: ${s.vouchers.length} vouchers, ${s.ledgers.length} ledgers` });
  const types = Object.values(s.cfg.voucherTypes);
  return c.json({
    // one file is the normal way: Tally cannot meet a voucher before its ledger
    allXml: oneFile(s.cfg.companyName, s.ledgers, types, s.vouchers),
    ledgersXml: ledgersFile(s.cfg.companyName, s.ledgers, types), vouchersXml: vouchers,
    entries: s.entries, vouchers: s.vouchers.length, ledgers: s.ledgers.length,
  });
});

/** After Tally imported the file: these entries are now in Tally. */
tallyRoutes.post("/mark", guard, async (c) => {
  const auth = c.get("auth")!;
  const biz = auth.businessId!;
  const { entries: asked } = z.object({ entries: z.array(z.object({ kind: z.enum(KINDS), id: z.string(), fp: z.string() })).max(100_000) }).parse(await c.req.json());
  // only this business's own entries can be marked as sent
  const own = new Set<string>();
  const tables = { slip: schema.purchaseSlips, payment: schema.payments, parcha: schema.parchas, receipt: schema.millReceipts, cut: schema.loads } as const;
  for (const k of KINDS) {
    const T = tables[k];
    const ids = [...new Set(asked.filter((e) => e.kind === k).map((e) => e.id))];
    for (let i = 0; i < ids.length; i += 500) {
      const part = ids.slice(i, i + 500);
      for (const r of await db.select({ id: T.id }).from(T).where(and(eq(T.businessId, biz), inArray(T.id, part)))) own.add(`${k}|${r.id}`);
    }
  }
  const entries = asked.filter((e) => own.has(`${e.kind}|${e.id}`));
  const at = nowSec();
  db.transaction((tx) => {
    for (const e of entries) {
      tx.insert(schema.tallyExports).values({ id: newId(), businessId: biz, kind: e.kind, entityId: e.id, fingerprint: e.fp, exportedBy: auth.user.id, exportedAt: at, updatedAt: at })
        .onConflictDoUpdate({ target: [schema.tallyExports.businessId, schema.tallyExports.kind, schema.tallyExports.entityId], set: { fingerprint: e.fp, exportedAt: at, updatedAt: at, exportedBy: auth.user.id } }).run();
    }
  });
  await audit({ actor: actor(c), action: "tally.mark", entity: "settings", entityId: "tally", entityLabel: `${entries.length} entries marked as in Tally` });
  return c.json({ marked: entries.length, notThisBusiness: asked.length - entries.length });
});

/** A changed entry was put right in Tally by hand: it now matches (or, if gone here, is forgotten). */
tallyRoutes.post("/fixed", guard, async (c) => {
  const biz = c.get("auth")!.businessId!;
  const { kind, id, now } = z.object({ kind: z.enum(KINDS), id: z.string(), now: z.string().nullable() }).parse(await c.req.json());
  const where = and(eq(schema.tallyExports.businessId, biz), eq(schema.tallyExports.kind, kind), eq(schema.tallyExports.entityId, id));
  if (now) await db.update(schema.tallyExports).set({ fingerprint: now, updatedAt: nowSec() }).where(where);
  else await db.delete(schema.tallyExports).where(where);
  await audit({ actor: actor(c), action: "tally.fixed", entity: "settings", entityId: "tally", entityLabel: `${kind} ${id} put right in Tally` });
  return c.json({ ok: true });
});
