import { Hono } from "hono";
import { z } from "zod";
import { eq, and, desc, lt, like, or, sql } from "drizzle-orm";
import { db, schema, sqlite } from "../db/client.ts";
import { checkBooks } from "../lib/booksCheck.ts";
import { nowSec } from "../lib/ids.ts";
import { audit } from "../lib/audit.ts";
import { param, can, actor, notFound, type Env } from "../lib/http.ts";

export const businessRoutes = new Hono<Env>();

businessRoutes.get("/current", can("business.read"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const [row] = await db.select().from(schema.businesses).where(eq(schema.businesses.id, biz)).limit(1);
  if (!row) throw notFound("Business not found");
  return c.json(row);
});

businessRoutes.put("/current", can("business.write"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const body = z.object({
    name: z.string().trim().min(2).optional(),
    nameHi: z.string().trim().optional(),
    shortCode: z.string().trim().min(1).max(12).optional(),
    addressLine1: z.string().trim().optional(),
    addressLine2: z.string().trim().optional(),
    city: z.string().trim().optional(),
    district: z.string().trim().optional(),
    state: z.string().trim().optional(),
    pincode: z.string().trim().optional(),
    phone: z.string().trim().optional(),
    gstin: z.string().trim().optional(),
    mandiLicense: z.string().trim().optional(),
    panNo: z.string().trim().optional(),
    setupComplete: z.boolean().optional(),
  }).parse(await c.req.json());

  const [before] = await db.select().from(schema.businesses).where(eq(schema.businesses.id, biz)).limit(1);
  if (!before) throw notFound("Business not found");

  const patch: Record<string, unknown> = { updatedAt: nowSec() };
  for (const [k, v] of Object.entries(body)) {
    patch[k] = typeof v === "string" ? (v || null) : v;
  }
  if (body.shortCode) patch.shortCode = body.shortCode.toUpperCase();

  await db.update(schema.businesses).set(patch).where(eq(schema.businesses.id, biz));
  const [after] = await db.select().from(schema.businesses).where(eq(schema.businesses.id, biz)).limit(1);
  await audit({ actor: actor(c), action: "business.update", entity: "business", entityId: biz, entityLabel: after!.name, before, after });
  return c.json({ ok: true });
});

/* ------------------------------------------------------------------- audit */

export const auditRoutes = new Hono<Env>();

/** The independent re-working of every figure, on the live books of this business (read-only). */
auditRoutes.get("/books-check", can("audit.read", "backup.manage"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const r = checkBooks(sqlite, biz);
  await audit({ actor: actor(c), action: "books.check", entity: "settings", entityId: "books",
    entityLabel: r.problems ? `${r.problems} problem(s) found` : "Every figure re-works exactly" });
  return c.json(r);
});

auditRoutes.get("/", can("audit.read"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const q = c.req.query("q")?.trim();
  const entity = c.req.query("entity")?.trim();
  const action = c.req.query("action")?.trim();
  const userId = c.req.query("userId")?.trim();
  const before = c.req.query("before");
  const limit = Math.min(Number(c.req.query("limit") ?? 60), 200);

  const where = [eq(schema.auditLog.businessId, biz)];
  if (entity) where.push(eq(schema.auditLog.entity, entity));
  if (action) where.push(like(schema.auditLog.action, `${action}%`));
  if (userId) where.push(eq(schema.auditLog.userId, userId));
  if (before) where.push(lt(schema.auditLog.at, Number(before)));
  if (q) {
    where.push(or(
      like(schema.auditLog.entityLabel, `%${q}%`),
      like(schema.auditLog.userName, `%${q}%`),
      like(schema.auditLog.action, `%${q}%`),
    )!);
  }

  const rows = await db.select().from(schema.auditLog)
    .where(and(...where)).orderBy(desc(schema.auditLog.at)).limit(limit + 1);

  const hasMore = rows.length > limit;
  return c.json({
    rows: rows.slice(0, limit).map((r) => ({
      ...r,
      before: r.before ? JSON.parse(r.before) : null,
      after: r.after ? JSON.parse(r.after) : null,
      changedKeys: r.changedKeys ? JSON.parse(r.changedKeys) : [],
    })),
    nextCursor: hasMore ? rows[limit - 1].at : null,
  });
});

/** SQLite's own text order (BINARY: by code point), nothing first. */
const binaryOrder = (a: string | null, b: string | null) => {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n;) {
    const x = a.codePointAt(i)!, y = b.codePointAt(i)!;
    if (x !== y) return x < y ? -1 : 1;
    i += x > 0xffff ? 2 : 1;
  }
  return a.length - b.length;
};

/** Distinct entities/actions/users, for the filter dropdowns. One pass over the trail, not one per list. */
auditRoutes.get("/facets", can("audit.read"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const A = schema.auditLog;
  const kinds = await db.select({ entity: A.entity, action: A.action, userId: A.userId, userName: A.userName, n: sql<number>`count(*)` })
    .from(A).where(eq(A.businessId, biz)).groupBy(A.entity, A.action, A.userId, A.userName);
  // each user (and the name written with it) with how many entries, in the order a group by user gives
  const byUser = new Map<string, { userId: string | null; userName: string | null; n: number }>();
  for (const k of kinds) {
    const key = JSON.stringify([k.userId, k.userName]);
    const u = byUser.get(key);
    if (u) u.n += k.n; else byUser.set(key, { userId: k.userId, userName: k.userName, n: k.n });
  }
  const users = [...byUser.values()].sort((a, b) => binaryOrder(a.userId, b.userId) || binaryOrder(a.userName, b.userName));
  return c.json({
    entities: [...new Set(kinds.map((k) => k.entity))].sort(),
    actions: [...new Set(kinds.map((k) => k.action))].sort(),
    users: users.filter((u) => u.userId),
  });
});
