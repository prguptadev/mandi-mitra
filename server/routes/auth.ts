import { Hono } from "hono";
import { setCookie, deleteCookie, getCookie } from "hono/cookie";
import { z } from "zod";
import { eq, and, asc } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { newId, nowSec } from "../lib/ids.ts";
import { hashPin, verifyPin, weakPin, createSession, destroySession, registerFailure, clearFailures, lockRemaining } from "../lib/auth.ts";
import { ROLE_PRESETS } from "../lib/rbac.ts";
import { audit } from "../lib/audit.ts";
import { defaultChargeConfig } from "../lib/charges.ts";
import { COOKIE, HttpError, bad, requireAuth, actor, type Env } from "../lib/http.ts";
import { toHinglish } from "../lib/translit.ts";

export const authRoutes = new Hono<Env>();

const cookieOpts = { httpOnly: true, sameSite: "Lax", path: "/", maxAge: 30 * 86400 } as const;

/** Seed the five stock roles for a new business. */
async function seedRoles(businessId: string) {
  const map: Record<string, string> = {};
  for (const preset of ROLE_PRESETS) {
    const roleId = newId();
    await db.insert(schema.roles).values({
      id: roleId, businessId, key: preset.key, label: preset.label,
      labelHi: preset.labelHi, isSystem: true, rank: preset.rank,
    });
    for (const p of preset.permissions) {
      await db.insert(schema.rolePermissions).values({ id: newId(), roleId, permission: p });
    }
    map[preset.key] = roleId;
  }
  return map;
}

/** Give a fresh business the commodities that actually move through Etah. */
async function seedJins(businessId: string) {
  const rows = [
    { code: "1509", name: "Paddy 1509", nameHi: "धान 1509", crop: "paddy" },
    { code: "1121", name: "Paddy 1121", nameHi: "धान 1121", crop: "paddy" },
    { code: "1718", name: "Paddy 1718", nameHi: "धान 1718", crop: "paddy" },
    { code: "SARBATI", name: "Paddy Sarbati", nameHi: "धान सरबती", crop: "paddy" },
    { code: "WHEAT", name: "Wheat", nameHi: "गेहूँ", crop: "wheat" },
    { code: "MAIZE", name: "Maize", nameHi: "मक्का", crop: "maize" },
  ];
  for (const r of rows) {
    await db.insert(schema.jins).values({ id: newId(), businessId, ...r });
  }
}

/** True only before the very first user exists. */
authRoutes.get("/bootstrap", async (c) => {
  const [u] = await db.select({ id: schema.users.id }).from(schema.users).limit(1);
  return c.json({ needsSignup: !u });
});

authRoutes.post("/signup", async (c) => {
  const [existing] = await db.select({ id: schema.users.id }).from(schema.users).limit(1);
  if (existing) throw new HttpError(409, "Already set up. Please sign in.", "already_setup");

  const body = z.object({
    name: z.string().trim().min(2, "Enter your name"),
    nameHi: z.string().trim().optional(),
    phone: z.string().trim().optional(),
    pin: z.string(),
    businessName: z.string().trim().min(2, "Enter the business name"),
    businessNameHi: z.string().trim().optional(),
    shortCode: z.string().trim().min(1).max(12),
  }).parse(await c.req.json());

  const weak = weakPin(body.pin);
  if (weak) throw bad(weak, "weak_pin");

  const { hash, salt } = hashPin(body.pin);
  const userId = newId();
  const businessId = newId();

  await db.insert(schema.users).values({
    id: userId, name: body.name, nameHi: body.nameHi || null,
    phone: body.phone || null, pinHash: hash, pinSalt: salt, isRoot: true,
  });
  await db.insert(schema.businesses).values({
    id: businessId, name: body.businessName,
    nameHi: body.businessNameHi || null,
    shortCode: body.shortCode.toUpperCase(),
  });
  const roles = await seedRoles(businessId);
  await seedJins(businessId);
  await db.insert(schema.memberships).values({
    id: newId(), userId, businessId, roleId: roles.owner,
  });

  const token = await createSession(userId, businessId, c.req.header("user-agent"));
  setCookie(c, COOKIE, token, cookieOpts);
  await audit({
    actor: { userId, userName: body.name, businessId, ip: c.req.header("x-forwarded-for") },
    action: "signup", entity: "business", entityId: businessId, entityLabel: body.businessName,
    after: { name: body.businessName, shortCode: body.shortCode },
  });
  return c.json({ ok: true });
});

/** Who can sign in — names only, so the PIN screen can show a picker. */
authRoutes.get("/users", async (c) => {
  const rows = await db.select({
    id: schema.users.id, name: schema.users.name, nameHi: schema.users.nameHi,
  }).from(schema.users).where(eq(schema.users.active, true)).orderBy(asc(schema.users.name));
  return c.json(rows);
});

authRoutes.post("/login", async (c) => {
  const body = z.object({ userId: z.string(), pin: z.string() }).parse(await c.req.json());
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, body.userId)).limit(1);
  if (!user || !user.active) throw new HttpError(401, "Unknown user", "bad_credentials");

  const wait = lockRemaining(user);
  if (wait > 0) throw new HttpError(429, `Too many wrong PINs. Try again in ${Math.ceil(wait / 60)} min.`, "locked");

  if (!verifyPin(body.pin, user.pinHash, user.pinSalt)) {
    await registerFailure(user.id);
    const left = Math.max(0, 4 - user.failedAttempts);
    await audit({
      actor: { userId: user.id, userName: user.name, ip: c.req.header("x-forwarded-for") },
      action: "login.failed", entity: "user", entityId: user.id, entityLabel: user.name,
    });
    throw new HttpError(401, left > 0 ? `Wrong PIN. ${left} attempt${left === 1 ? "" : "s"} left.` : "Wrong PIN. Account locked for 5 minutes.", "bad_credentials");
  }
  await clearFailures(user.id);

  const mems = await db.select().from(schema.memberships).where(and(
    eq(schema.memberships.userId, user.id), eq(schema.memberships.active, true),
  ));
  const token = await createSession(user.id, mems[0]?.businessId ?? null, c.req.header("user-agent"));
  setCookie(c, COOKIE, token, cookieOpts);
  await audit({
    actor: { userId: user.id, userName: user.name, businessId: mems[0]?.businessId, ip: c.req.header("x-forwarded-for") },
    action: "login", entity: "user", entityId: user.id, entityLabel: user.name,
  });
  return c.json({ ok: true });
});

authRoutes.post("/logout", async (c) => {
  const token = getCookie(c, COOKIE);
  const auth = c.get("auth");
  if (auth) await audit({ actor: actor(c), action: "logout", entity: "user", entityId: auth.user.id, entityLabel: auth.user.name });
  if (token) await destroySession(token);
  deleteCookie(c, COOKIE, { path: "/" });
  return c.json({ ok: true });
});

/** Everything the shell needs on boot: user, businesses, active one, permissions. */
authRoutes.get("/me", requireAuth, async (c) => {
  const auth = c.get("auth")!;
  const mems = await db.select({
    businessId: schema.memberships.businessId,
    roleKey: schema.roles.key,
    roleLabel: schema.roles.label,
    name: schema.businesses.name,
    nameHi: schema.businesses.nameHi,
    shortCode: schema.businesses.shortCode,
    setupComplete: schema.businesses.setupComplete,
  })
    .from(schema.memberships)
    .innerJoin(schema.businesses, eq(schema.businesses.id, schema.memberships.businessId))
    .innerJoin(schema.roles, eq(schema.roles.id, schema.memberships.roleId))
    .where(and(eq(schema.memberships.userId, auth.user.id), eq(schema.memberships.active, true)))
    .orderBy(asc(schema.businesses.name));

  return c.json({
    user: {
      id: auth.user.id, name: auth.user.name, nameHi: auth.user.nameHi,
      phone: auth.user.phone, isRoot: auth.user.isRoot,
      lang: auth.user.lang, theme: auth.user.theme,
    },
    businesses: mems,
    activeBusinessId: auth.businessId,
    business: auth.business,
    role: auth.role ? { key: auth.role.key, label: auth.role.label, labelHi: auth.role.labelHi } : null,
    permissions: [...auth.permissions],
  });
});

/** Switch business — just repoints the session. */
authRoutes.post("/switch-business", requireAuth, async (c) => {
  const auth = c.get("auth")!;
  const { businessId } = z.object({ businessId: z.string() }).parse(await c.req.json());
  const [m] = await db.select().from(schema.memberships).where(and(
    eq(schema.memberships.userId, auth.user.id),
    eq(schema.memberships.businessId, businessId),
    eq(schema.memberships.active, true),
  )).limit(1);
  if (!m) throw new HttpError(403, "You are not a member of that business", "forbidden");

  await db.update(schema.sessions)
    .set({ activeBusinessId: businessId })
    .where(eq(schema.sessions.id, auth.session.id));
  await audit({ actor: { ...actor(c), businessId }, action: "business.switch", entity: "business", entityId: businessId });
  return c.json({ ok: true });
});

/** Add a second business (V C Enterprise alongside Vijay Laxmi). */
authRoutes.post("/businesses", requireAuth, async (c) => {
  const auth = c.get("auth")!;
  if (!auth.user.isRoot && !auth.permissions.has("business.write")) {
    throw new HttpError(403, "You cannot add a business", "forbidden");
  }
  const body = z.object({
    name: z.string().trim().min(2),
    nameHi: z.string().trim().optional(),
    shortCode: z.string().trim().min(1).max(12),
  }).parse(await c.req.json());

  const businessId = newId();
  await db.insert(schema.businesses).values({
    id: businessId, name: body.name,
    nameHi: body.nameHi || null, shortCode: body.shortCode.toUpperCase(),
  });
  const roles = await seedRoles(businessId);
  await seedJins(businessId);
  await db.insert(schema.memberships).values({
    id: newId(), userId: auth.user.id, businessId, roleId: roles.owner,
  });
  await db.update(schema.sessions).set({ activeBusinessId: businessId })
    .where(eq(schema.sessions.id, auth.session.id));
  await audit({
    actor: { ...actor(c), businessId }, action: "business.create",
    entity: "business", entityId: businessId, entityLabel: body.name, after: body,
  });
  return c.json({ id: businessId });
});

/** Change your own PIN. */
authRoutes.post("/change-pin", requireAuth, async (c) => {
  const auth = c.get("auth")!;
  const body = z.object({ currentPin: z.string(), newPin: z.string() }).parse(await c.req.json());
  if (!verifyPin(body.currentPin, auth.user.pinHash, auth.user.pinSalt)) {
    throw new HttpError(401, "Current PIN is wrong", "bad_credentials");
  }
  const weak = weakPin(body.newPin);
  if (weak) throw bad(weak, "weak_pin");
  const { hash, salt } = hashPin(body.newPin);
  await db.update(schema.users).set({ pinHash: hash, pinSalt: salt, updatedAt: nowSec() })
    .where(eq(schema.users.id, auth.user.id));
  await audit({ actor: actor(c), action: "pin.change", entity: "user", entityId: auth.user.id, entityLabel: auth.user.name });
  return c.json({ ok: true });
});

/** Save language / theme against the user so it follows them between devices. */
authRoutes.post("/prefs", requireAuth, async (c) => {
  const auth = c.get("auth")!;
  const body = z.object({
    lang: z.enum(["en", "hi"]).optional(),
    theme: z.enum(["light", "dark", "system"]).optional(),
  }).parse(await c.req.json());
  await db.update(schema.users).set({ ...body, updatedAt: nowSec() })
    .where(eq(schema.users.id, auth.user.id));
  return c.json({ ok: true });
});

/** Utility the UI calls while typing a Hindi name. */
authRoutes.post("/transliterate", async (c) => {
  const { text } = z.object({ text: z.string() }).parse(await c.req.json());
  return c.json({ hinglish: toHinglish(text) });
});

export { seedRoles, seedJins, defaultChargeConfig };
