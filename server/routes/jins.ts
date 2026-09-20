import { Hono } from "hono";
import { z } from "zod";
import { eq, and, asc } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { newId, nowSec } from "../lib/ids.ts";
import { audit } from "../lib/audit.ts";
import { param, can, actor, notFound, bad, type Env } from "../lib/http.ts";

export const jinsRoutes = new Hono<Env>();

const Body = z.object({
  code: z.string().trim().min(1).max(20),
  name: z.string().trim().min(1),
  nameHi: z.string().trim().optional(),
  crop: z.enum(["paddy", "wheat", "maize", "other"]).default("paddy"),
  active: z.boolean().optional(),
});

jinsRoutes.get("/", can("jins.read"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const all = c.req.query("all") === "1";
  const where = [eq(schema.jins.businessId, biz)];
  if (!all) where.push(eq(schema.jins.active, true));
  return c.json(await db.select().from(schema.jins).where(and(...where)).orderBy(asc(schema.jins.crop), asc(schema.jins.code)));
});

jinsRoutes.post("/", can("jins.write"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const body = Body.parse(await c.req.json());
  const code = body.code.toUpperCase();
  const [dupe] = await db.select({ id: schema.jins.id }).from(schema.jins)
    .where(and(eq(schema.jins.businessId, biz), eq(schema.jins.code, code))).limit(1);
  if (dupe) throw bad(`Code "${code}" already exists`, "duplicate");
  const id = newId();
  const values = { id, businessId: biz, code, name: body.name, nameHi: body.nameHi || null, crop: body.crop, active: body.active ?? true };
  await db.insert(schema.jins).values(values);
  await audit({ actor: actor(c), action: "jins.create", entity: "jins", entityId: id, entityLabel: body.name, after: values });
  return c.json({ id });
});

jinsRoutes.put("/:id", can("jins.write"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const id = param(c, "id");
  const body = Body.partial().parse(await c.req.json());
  const [before] = await db.select().from(schema.jins)
    .where(and(eq(schema.jins.id, id), eq(schema.jins.businessId, biz))).limit(1);
  if (!before) throw notFound("Commodity not found");
  const patch: Record<string, unknown> = { updatedAt: nowSec() };
  if (body.code) patch.code = body.code.toUpperCase();
  if (body.name !== undefined) patch.name = body.name;
  if (body.nameHi !== undefined) patch.nameHi = body.nameHi || null;
  if (body.crop !== undefined) patch.crop = body.crop;
  if (body.active !== undefined) patch.active = body.active;
  await db.update(schema.jins).set(patch).where(eq(schema.jins.id, id));
  const [after] = await db.select().from(schema.jins).where(eq(schema.jins.id, id)).limit(1);
  await audit({ actor: actor(c), action: "jins.update", entity: "jins", entityId: id, entityLabel: after!.name, before, after });
  return c.json({ ok: true });
});
