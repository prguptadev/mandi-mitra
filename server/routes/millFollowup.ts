import { Hono } from "hono";
import { z } from "zod";
import { and, eq, desc } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { newId, nowSec } from "../lib/ids.ts";
import { audit } from "../lib/audit.ts";
import { can, actor, bad, isoDay, notFound, param, LIMIT, type Env } from "../lib/http.ts";
import { billed, receipts, settle } from "./millAccounts.ts";
import { officeToday } from "../lib/parchaLabels.ts";

/* Chasing the mills for money. For each mill: what it owes, how old the
   oldest unpaid parcha is, the money split by age, when it last paid, and
   the latest call — what was said, what it promised, when to ask again.

   Which parcha a payment paid: money received against a truck pays that
   truck's parcha first; the rest (and anything paid over a parcha) pays the
   oldest parchas first. The unpaid parts always add up to the balance on the
   mill's statement. */

export const millFollowupRoutes = new Hono<Env>();
// India's date, also on a computer set to another zone: a call due today is due on India's today
const today = () => officeToday();
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400_000);
export const AGE_BUCKETS = [15, 30, 60] as const; // 0–15, 16–30, 31–60, over 60 days

export interface UnpaidBill { loadId: string | null; parchaNo: string | null; date: string | null; truckNo: string | null; billPaise: number; duePaise: number; days: number | null }

/** One mill's unpaid parchas (oldest first) as of a day, and money paid beyond them. Same rule as every other screen: settle(). */
export function ageBills(
  openingPaise: number,
  bills: { loadId: string; parchaNo: string; date: string; truckNo: string | null; grandTotalPaise: number; shortagePaise: number }[],
  recs: { loadId: string | null; amountPaise: number; deductionPaise: number }[],
  asOf: string,
) {
  const { lines, onAccount } = settle(openingPaise, bills, recs);
  const pool = onAccount.leftPaise;
  const unpaid: UnpaidBill[] = lines.filter((l) => l.duePaise > 0).map((l) => ({
    loadId: l.loadId, parchaNo: l.parchaNo, date: l.date, truckNo: l.truckNo, billPaise: l.billPaise, duePaise: l.duePaise,
    days: l.date === null ? null : Math.max(0, daysBetween(l.date, asOf)),
  }));
  const buckets = [0, 0, 0, 0];
  for (const o of unpaid) {
    const d = o.days ?? Infinity; // the opening balance is older than anything in the app
    buckets[d <= AGE_BUCKETS[0] ? 0 : d <= AGE_BUCKETS[1] ? 1 : d <= AGE_BUCKETS[2] ? 2 : 3] += o.duePaise;
  }
  const oldest = unpaid[0];
  return { unpaid, buckets, aheadPaise: pool, oldestDays: oldest ? oldest.days : null, oldestIsOpening: Boolean(oldest && oldest.date === null) };
}

millFollowupRoutes.get("/", can("millledger.read"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  // like the mill accounts: every bill and receipt unless a day is asked for; ages count to today
  const upTo = c.req.query("asOf") || undefined;
  if (upTo && !/^\d{4}-\d{2}-\d{2}$/.test(upTo)) throw bad("Date must be YYYY-MM-DD");
  const asOf = upTo ?? today();
  const mills = await db.select().from(schema.merchants).where(eq(schema.merchants.businessId, biz));
  const allBills = await billed(biz, { upTo });
  const allRecs = await receipts(biz, { upTo });
  const notes = await db.select({ n: schema.millFollowups, by: schema.users.name }).from(schema.millFollowups)
    .leftJoin(schema.users, eq(schema.users.id, schema.millFollowups.createdBy))
    .where(eq(schema.millFollowups.businessId, biz)).orderBy(desc(schema.millFollowups.createdAt));
  const now = today();
  const rows = mills.map((m) => {
    const b = allBills.filter((x) => x.merchantId === m.id);
    const r = allRecs.filter((x) => x.merchantId === m.id);
    const a = ageBills(m.openingBalancePaise, b, r, asOf);
    const balancePaise = m.openingBalancePaise + b.reduce((s, x) => s + x.grandTotalPaise - x.shortagePaise, 0) - r.reduce((s, x) => s + x.amountPaise + x.deductionPaise, 0);
    const lastR = [...r].sort((x, y) => y.receiptDate.localeCompare(x.receiptDate) || y.createdAt - x.createdAt)[0];
    const mine = notes.filter((n) => n.n.merchantId === m.id);
    const latest = mine[0];
    return {
      id: m.id, code: m.code, name: m.name, nameHi: m.nameHi, phone: m.phone, contactPerson: m.contactPerson, city: m.city, active: m.active,
      balancePaise, duePaise: a.unpaid.reduce((s, o) => s + o.duePaise, 0), aheadPaise: a.aheadPaise,
      buckets: a.buckets, oldestDays: a.oldestDays, oldestIsOpening: a.oldestIsOpening, unpaid: a.unpaid.reverse(),
      lastReceipt: lastR ? { date: lastR.receiptDate, amountPaise: lastR.amountPaise + lastR.deductionPaise, days: daysBetween(lastR.receiptDate, asOf) } : null,
      followup: latest ? { id: latest.n.id, note: latest.n.note, promisedPaise: latest.n.promisedPaise, nextDate: latest.n.nextDate, at: latest.n.createdAt, by: latest.by, count: mine.length } : null,
      dueToday: Boolean(latest?.n.nextDate && latest.n.nextDate <= now),
    };
  }).filter((m) => m.balancePaise !== 0 || m.followup);
  // calls due first, then who owes the most
  rows.sort((x, y) => Number(y.dueToday && y.balancePaise > 0) - Number(x.dueToday && x.balancePaise > 0) || y.balancePaise - x.balancePaise || x.code.localeCompare(y.code));
  const owing = rows.filter((m) => m.balancePaise > 0);
  return c.json({
    asOf, buckets: AGE_BUCKETS, rows,
    totals: {
      toReceivePaise: owing.reduce((s, m) => s + m.balancePaise, 0),
      buckets: [0, 1, 2, 3].map((i) => rows.reduce((s, m) => s + m.buckets[i], 0)),
      mills: owing.length,
      dueToday: rows.filter((m) => m.dueToday && m.balancePaise > 0).length,
    },
  });
});

/** Every call noted for one mill, newest first. */
millFollowupRoutes.get("/notes/:merchantId", can("millledger.read"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const rows = await db.select({ n: schema.millFollowups, by: schema.users.name }).from(schema.millFollowups)
    .leftJoin(schema.users, eq(schema.users.id, schema.millFollowups.createdBy))
    .where(and(eq(schema.millFollowups.businessId, biz), eq(schema.millFollowups.merchantId, param(c, "merchantId"))))
    .orderBy(desc(schema.millFollowups.createdAt)).limit(200);
  return c.json({ rows: rows.map((r) => ({ ...r.n, byName: r.by })) });
});

const NoteBody = z.object({
  merchantId: z.string().min(1, "Pick a mill"),
  note: z.string().trim().max(500).nullish(),
  promisedPaise: z.number().int().min(0).max(LIMIT.paise, "Amount is too large").nullish(),
  nextDate: isoDay().nullish(),
});

/** Note a call or visit: what was said, what the mill promised, when to ask again. */
millFollowupRoutes.post("/notes", can("millreceipt.write"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const b = NoteBody.parse(await c.req.json());
  if (!b.note && !b.promisedPaise && !b.nextDate) throw bad("Write what was said, a promised amount or the next date", "empty");
  const [m] = await db.select({ code: schema.merchants.code }).from(schema.merchants)
    .where(and(eq(schema.merchants.id, b.merchantId), eq(schema.merchants.businessId, biz))).limit(1);
  if (!m) throw bad("That mill does not belong to this business", "bad_merchant");
  const at = nowSec();
  const values = { id: newId(), businessId: biz, merchantId: b.merchantId, note: b.note || null, promisedPaise: b.promisedPaise || null, nextDate: b.nextDate || null, createdBy: c.get("auth")!.user.id, createdAt: at, updatedAt: at };
  await db.insert(schema.millFollowups).values(values);
  await audit({ actor: actor(c), action: "mill_followup.create", entity: "mill_followup", entityId: values.id,
    entityLabel: `${m.code}: ${b.note ?? ""}${b.nextDate ? ` · next ${b.nextDate}` : ""}`.trim(), after: values });
  return c.json({ id: values.id });
});

millFollowupRoutes.delete("/notes/:id", can("millreceipt.write"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const id = param(c, "id");
  const [row] = await db.select().from(schema.millFollowups).where(and(eq(schema.millFollowups.id, id), eq(schema.millFollowups.businessId, biz))).limit(1);
  if (!row) throw notFound("Note not found");
  await db.delete(schema.millFollowups).where(eq(schema.millFollowups.id, id));
  await audit({ actor: actor(c), action: "mill_followup.delete", entity: "mill_followup", entityId: id, entityLabel: row.note ?? "", before: row });
  return c.json({ ok: true });
});
