import { Hono } from "hono";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { nowSec } from "../lib/ids.ts";
import { audit, enqueueSync } from "../lib/audit.ts";
import { trucks } from "../lib/tracking.ts";
import { amountPaise } from "../lib/money.ts";
import { can, actor, param, notFound, bad, LIMIT, type Env } from "../lib/http.ts";

/* The challan register: every truck sent to a mill with its full details,
   and the weight the mill cut when it arrived (shortage, moisture). The cut
   is valued at the rate the truck was billed at (its parcha's rate; a draft
   at its rows' rate), so:
     final net   = loaded − cut
     final value = goods value − cut × rate
     final bill  = parcha grand total − cut × rate   (what the mill now owes for it)
   The parcha itself is never changed; the mill account takes the cut off. */

export const challanRoutes = new Hono<Env>();
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

challanRoutes.get("/", can("load.read"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const from = c.req.query("from") || undefined;
  const to = c.req.query("to") || undefined;
  if ((from && !ISO_DATE.test(from)) || (to && !ISO_DATE.test(to))) throw bad("Date must be YYYY-MM-DD");
  if (from && to && from > to) throw bad("The from date is after the to date", "bad_range");
  const merchantId = c.req.query("merchantId") || undefined;
  const jinsId = c.req.query("jinsId") || undefined;
  const q = (c.req.query("q") ?? "").trim().toLowerCase();

  const list = await trucks(biz, { merchantId, jinsId, from, to });
  const mills = await db.select({ id: schema.merchants.id, code: schema.merchants.code, name: schema.merchants.name, nameHi: schema.merchants.nameHi })
    .from(schema.merchants).where(eq(schema.merchants.businessId, biz));
  const jins = await db.select({ id: schema.jins.id, code: schema.jins.code }).from(schema.jins).where(eq(schema.jins.businessId, biz));
  const millOf = new Map(mills.map((m) => [m.id, m]));
  const jinsOf = new Map(jins.map((j) => [j.id, j.code]));

  const rows = list.map((t) => {
    const m = millOf.get(t.merchantId);
    const cut = t.deductionGrams;
    const cutValue = cut ? amountPaise(cut, t.ratePaisePerQtl) : 0;
    return {
      loadId: t.loadId, loadDate: t.loadDate, truckNo: t.truckNo, status: t.status,
      merchantId: t.merchantId, millCode: m?.code ?? "?", millName: m?.name ?? "", millNameHi: m?.nameHi ?? null,
      jinsId: t.jinsId, jinsCode: jinsOf.get(t.jinsId) ?? "",
      stockDates: t.stockDates, millGrossGrams: t.millGrossGrams, millNetGrams: t.millNetGrams, bags: t.bags,
      weightGrams: t.weightGrams, ratePaisePerQtl: t.ratePaisePerQtl, goodsPaise: t.goodsPaise,
      parchaNo: t.parchaNo, grandTotalPaise: t.grandTotalPaise,
      deductionGrams: cut, deductionNote: t.deductionNote, deductionValuePaise: cutValue,
      finalNetGrams: t.weightGrams - cut,
      finalGoodsPaise: t.goodsPaise - cutValue,
      finalTotalPaise: t.grandTotalPaise != null ? t.grandTotalPaise - cutValue : null,
      incomplete: t.incomplete, mismatch: t.mismatch,
    };
  }).filter((r) => !q || [r.truckNo, r.millCode, r.millName, r.millNameHi, r.parchaNo, r.jinsCode]
    .some((v) => (v ?? "").toLowerCase().replace(/\s+/g, "").includes(q.replace(/\s+/g, ""))));
  rows.sort((a, b) => b.loadDate.localeCompare(a.loadDate) || (a.truckNo ?? "").localeCompare(b.truckNo ?? ""));

  const sum = (k: "weightGrams" | "deductionGrams" | "finalNetGrams" | "goodsPaise" | "deductionValuePaise" | "finalGoodsPaise") =>
    rows.reduce((s, r) => s + r[k], 0);
  const billed = rows.filter((r) => r.grandTotalPaise != null);
  return c.json({
    rows,
    totals: {
      trucks: rows.length, billed: billed.length,
      weightGrams: sum("weightGrams"), deductionGrams: sum("deductionGrams"), finalNetGrams: sum("finalNetGrams"),
      goodsPaise: sum("goodsPaise"), deductionValuePaise: sum("deductionValuePaise"), finalGoodsPaise: sum("finalGoodsPaise"),
      grandTotalPaise: billed.reduce((s, r) => s + r.grandTotalPaise!, 0),
      finalTotalPaise: billed.reduce((s, r) => s + r.finalTotalPaise!, 0),
    },
  });
});

/** The mill's weight cut on one truck. Allowed at any time, even after the parcha is approved. */
challanRoutes.put("/:loadId", can("challan.write"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const loadId = param(c, "loadId");
  const body = z.object({
    deductionGrams: z.number().int("Weight must be in whole grams").min(0, "The cut cannot be negative").max(LIMIT.grams, "That is more than any truck holds"),
    note: z.string().trim().max(200).nullish(),
  }).parse(await c.req.json());
  const [before] = await db.select().from(schema.loads)
    .where(and(eq(schema.loads.id, loadId), eq(schema.loads.businessId, biz))).limit(1);
  if (!before) throw notFound("Truck not found");
  const [t] = await trucks(biz, { merchantId: before.merchantId, from: before.loadDate, to: before.loadDate }).then((l) => l.filter((x) => x.loadId === loadId));
  if (t && body.deductionGrams > t.weightGrams) throw bad("The cut is more than the truck carried", "cut_too_big");
  const patch = { millDeductionGrams: body.deductionGrams, millDeductionNote: body.note || null, updatedAt: nowSec() };
  await db.update(schema.loads).set(patch).where(eq(schema.loads.id, loadId));
  await audit({
    actor: actor(c), action: "load.deduction", entity: "load", entityId: loadId,
    entityLabel: `${before.truckNo ?? "truck"} ${before.loadDate}: mill cut ${(body.deductionGrams / 100_000).toFixed(2)} qtl${body.note ? ` (${body.note})` : ""}`,
    before: { millDeductionGrams: before.millDeductionGrams, millDeductionNote: before.millDeductionNote }, after: patch,
  });
  await enqueueSync(biz, "load", loadId, "update", patch);
  return c.json({ ok: true });
});
