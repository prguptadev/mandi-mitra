import { Hono } from "hono";
import { z } from "zod";
import { and, eq, gte, lte, sql, inArray } from "drizzle-orm";
import { db, schema, sqlite } from "../db/client.ts";
import { newId, nowSec } from "../lib/ids.ts";
import { audit } from "../lib/audit.ts";
import { can, actor, bad, isoDay, HttpError, type Env } from "../lib/http.ts";
import { officeToday } from "../lib/parchaLabels.ts";

/* Day close. Each day of business gets a row here with its figures — slips,
   payments, trucks, parchas, money from mills — and whether it is closed.
   Closing keeps the day's figures with the close; the write routes refuse
   anything dated on a closed day (lib/dayClose.ts) until it is reopened. */

export const dayRoutes = new Hono<Env>();
// India's date, also on a computer set to another zone
const today = () => officeToday();
const MAX_DAYS = 800;

export interface DaySummary {
  slips: number; netGrams: number; amountPaise: number; payablePaise: number; unpriced: number;
  payments: number; paidPaise: number;
  trucks: number; draftTrucks: number; parchas: number; billedPaise: number;
  receipts: number; receivedPaise: number;
  scansPending: number;
}
const empty = (): DaySummary => ({
  slips: 0, netGrams: 0, amountPaise: 0, payablePaise: 0, unpriced: 0, payments: 0, paidPaise: 0,
  trucks: 0, draftTrucks: 0, parchas: 0, billedPaise: 0, receipts: 0, receivedPaise: 0, scansPending: 0,
});

/** Every day in the period with anything on it, and its figures (one grouped query per table). */
export function daySummaries(biz: string, from: string, to: string): Map<string, DaySummary> {
  const out = new Map<string, DaySummary>();
  const at = (d: string) => { let x = out.get(d); if (!x) { x = empty(); out.set(d, x); } return x; };
  const q = <T,>(text: string) => sqlite.prepare(text).all(biz, from, to) as T[];
  for (const r of q<{ d: string; n: number; g: number; a: number; p: number; u: number }>(
    `select slip_date d, count(*) n, sum(net_grams) g, sum(amount_paise) a, sum(payable_paise) p, sum(rate_paise_per_qtl = 0) u
       from purchase_slips where business_id = ? and slip_date between ? and ? group by slip_date`)) {
    Object.assign(at(r.d), { slips: r.n, netGrams: r.g, amountPaise: r.a, payablePaise: r.p, unpriced: r.u });
  }
  for (const r of q<{ d: string; n: number; a: number }>(
    `select pay_date d, count(*) n, sum(amount_paise) a from payments
       where business_id = ? and pay_date between ? and ? and voided_at is null group by pay_date`)) {
    Object.assign(at(r.d), { payments: r.n, paidPaise: r.a });
  }
  for (const r of q<{ d: string; n: number; dr: number }>(
    `select load_date d, count(*) n, sum(status = 'draft') dr from loads
       where business_id = ? and load_date between ? and ? group by load_date`)) {
    Object.assign(at(r.d), { trucks: r.n, draftTrucks: r.dr });
  }
  for (const r of q<{ d: string; n: number; a: number }>(
    `select coalesce(p.invoice_date, l.load_date) d, count(*) n, sum(p.grand_total_paise) a
       from parchas p join loads l on l.id = p.load_id
      where p.business_id = ? and p.status = 'approved' and coalesce(p.invoice_date, l.load_date) between ? and ? group by 1`)) {
    Object.assign(at(r.d), { parchas: r.n, billedPaise: r.a });
  }
  for (const r of q<{ d: string; n: number; a: number }>(
    `select receipt_date d, count(*) n, sum(amount_paise + deduction_paise) a from mill_receipts
       where business_id = ? and receipt_date between ? and ? and voided_at is null group by receipt_date`)) {
    Object.assign(at(r.d), { receipts: r.n, receivedPaise: r.a });
  }
  for (const r of q<{ d: string; n: number }>(
    `select slip_date d, count(*) n from scan_batches
       where business_id = ? and slip_date between ? and ? and status <> 'committed' group by slip_date`)) {
    at(r.d).scansPending = r.n;
  }
  return out;
}

/** The first day anything was entered (for the year list and "close all up to"). */
export function firstDay(biz: string): string | null {
  const r = sqlite.prepare(`select min(d) d from (
      select min(slip_date) d from purchase_slips where business_id = @b
      union all select min(pay_date) from payments where business_id = @b
      union all select min(load_date) from loads where business_id = @b
      union all select min(receipt_date) from mill_receipts where business_id = @b)`).get({ b: biz }) as { d: string | null };
  return r.d;
}

const dayList = (from: string, to: string) => {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`), end = Date.parse(`${to}T00:00:00Z`); t <= end && out.length <= MAX_DAYS; t += 86400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
};

const READ = can("slip.read", "dashboard.view", "ledger.read", "millledger.read", "day.close");

dayRoutes.get("/span", READ, (c) => c.json({ first: firstDay(c.get("auth")!.businessId!), today: today() }));

/** One day: its figures and whether it is closed (the daily list's lock). */
dayRoutes.get("/one", READ, async (c) => {
  const biz = c.get("auth")!.businessId!;
  const { day } = z.object({ day: isoDay() }).parse(c.req.query());
  const [cl] = await db.select({ closedAt: schema.dayCloses.closedAt, note: schema.dayCloses.note, by: schema.users.name })
    .from(schema.dayCloses).leftJoin(schema.users, eq(schema.users.id, schema.dayCloses.closedBy))
    .where(and(eq(schema.dayCloses.businessId, biz), eq(schema.dayCloses.day, day))).limit(1);
  return c.json({ day, ...(daySummaries(biz, day, day).get(day) ?? empty()), closed: cl ? { at: cl.closedAt, by: cl.by, note: cl.note } : null });
});

/** Days in the period: figures, closed or not, by whom. Newest first. */
dayRoutes.get("/", READ, async (c) => {
  const biz = c.get("auth")!.businessId!;
  const q = z.object({ from: isoDay(), to: isoDay() }).parse(c.req.query());
  if (q.from > q.to) throw bad("The from date is after the to date", "bad_range");
  const sums = daySummaries(biz, q.from, q.to);
  const closes = await db.select({ day: schema.dayCloses.day, closedAt: schema.dayCloses.closedAt, note: schema.dayCloses.note, summary: schema.dayCloses.summary, by: schema.users.name })
    .from(schema.dayCloses).leftJoin(schema.users, eq(schema.users.id, schema.dayCloses.closedBy))
    .where(and(eq(schema.dayCloses.businessId, biz), gte(schema.dayCloses.day, q.from), lte(schema.dayCloses.day, q.to)));
  const closed = new Map(closes.map((x) => [x.day, x]));
  const days = [...sums.entries()].map(([day, s]) => {
    const cl = closed.get(day);
    const was = cl ? (JSON.parse(cl.summary) as DaySummary) : null;
    return {
      day, ...s,
      closed: cl ? { at: cl.closedAt, by: cl.by, note: cl.note,
        // the figures moved after closing: only possible through another computer's sync or a reopen-and-close
        changed: was ? was.slips !== s.slips || was.payablePaise !== s.payablePaise || was.paidPaise !== s.paidPaise || was.billedPaise !== s.billedPaise || was.receivedPaise !== s.receivedPaise : false } : null,
    };
  }).sort((a, b) => b.day.localeCompare(a.day));
  const lastClosed = (await db.select({ d: sql<string | null>`max(${schema.dayCloses.day})` }).from(schema.dayCloses).where(eq(schema.dayCloses.businessId, biz)))[0]?.d ?? null;
  return c.json({ days, emptyClosed: closes.filter((x) => !sums.has(x.day)).length, lastClosed, first: firstDay(biz), today: today() });
});

async function closeDays(c: Parameters<typeof actor>[0], biz: string, list: string[], note: string | null) {
  const have = new Set(list.length ? (await db.select({ d: schema.dayCloses.day }).from(schema.dayCloses)
    .where(and(eq(schema.dayCloses.businessId, biz), inArray(schema.dayCloses.day, list)))).map((x) => x.d) : []);
  const todo = list.filter((d) => !have.has(d));
  if (!todo.length) return [];
  const sums = daySummaries(biz, todo[0], todo[todo.length - 1]);
  const at = nowSec();
  const by = c.get("auth")!.user.id;
  db.transaction((tx) => {
    for (const d of todo) {
      tx.insert(schema.dayCloses).values({ id: newId(), businessId: biz, day: d, summary: JSON.stringify(sums.get(d) ?? empty()), note, closedBy: by, closedAt: at, updatedAt: at })
        .onConflictDoNothing().run();
    }
  });
  return todo;
}

/** Close one day. */
dayRoutes.post("/close", can("day.close"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const b = z.object({ day: isoDay(), note: z.string().trim().max(200).nullish() }).parse(await c.req.json());
  if (b.day > today()) throw bad("A day that has not come yet cannot be closed", "future");
  const done = await closeDays(c, biz, [b.day], b.note || null);
  if (!done.length) throw new HttpError(409, "This day is already closed", "already_closed");
  await audit({ actor: actor(c), action: "day.close", entity: "day", entityId: b.day, entityLabel: `Closed ${b.day}${b.note ? ` (${b.note})` : ""}`, after: daySummaries(biz, b.day, b.day).get(b.day) ?? empty() });
  return c.json({ closed: done });
});

/** Close every day from the first entry up to this one (empty days too, so nothing can be back-dated into them). */
dayRoutes.post("/close-upto", can("day.close"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const b = z.object({ day: isoDay() }).parse(await c.req.json());
  if (b.day > today()) throw bad("A day that has not come yet cannot be closed", "future");
  const first = firstDay(biz);
  if (!first || first > b.day) return c.json({ closed: [] });
  const list = dayList(first, b.day);
  if (list.length > MAX_DAYS) throw bad(`That is more than ${MAX_DAYS} days at once. Pick a nearer date first.`, "too_many");
  const done = await closeDays(c, biz, list, null);
  if (done.length) await audit({ actor: actor(c), action: "day.close", entity: "day", entityId: b.day, entityLabel: `Closed ${done.length} days up to ${b.day}` });
  return c.json({ closed: done });
});

/** Reopen a closed day, with a reason. */
dayRoutes.post("/reopen", can("day.reopen"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const b = z.object({ day: isoDay(), reason: z.string().trim().min(3, "Say why the day is being reopened").max(300) }).parse(await c.req.json());
  const [row] = await db.select().from(schema.dayCloses).where(and(eq(schema.dayCloses.businessId, biz), eq(schema.dayCloses.day, b.day))).limit(1);
  if (!row) return c.json({ ok: true, alreadyOpen: true });
  await db.delete(schema.dayCloses).where(eq(schema.dayCloses.id, row.id));
  await audit({ actor: actor(c), action: "day.reopen", entity: "day", entityId: b.day, entityLabel: `Reopened ${b.day}: ${b.reason}`, before: JSON.parse(row.summary) });
  return c.json({ ok: true });
});
