import { Hono } from "hono";
import { setCookie, deleteCookie, getCookie } from "hono/cookie";
import { z } from "zod";
import { eq, and, asc, ne } from "drizzle-orm";
import { db, schema, sqlite } from "../db/client.ts";
import { newId, nowSec } from "../lib/ids.ts";
import type { Context } from "hono";
import {
  hashPin, verifyPin, weakPin, createSession, destroySession, registerFailure, clearFailures, lockRemaining,
  remoteWait, registerRemoteFailure, clearRemoteFailures, REMOTE_SESSION_SECONDS,
} from "../lib/auth.ts";
import { seedRoles, seedJins } from "../lib/businessSetup.ts";
import { audit } from "../lib/audit.ts";
import { defaultChargeConfig } from "../lib/charges.ts";
import { COOKIE, HttpError, bad, requireAuth, actor, clientAddress, fromThisComputer, mainComputerOnly, type Env } from "../lib/http.ts";
import { toHinglish } from "../lib/translit.ts";
import { toDevanagari, looksLatin, hasLatin } from "../lib/devanagari.ts";
import { PrefsSchema, parsePrefs, defaultPrefs, DAILY_COLUMNS, DailyListPrefsSchema } from "../lib/prefs.ts";
import { readDevicePrefs, writeDevicePrefs } from "../lib/devicePrefs.ts";

export const authRoutes = new Hono<Env>();

const cookieOpts = { httpOnly: true, sameSite: "Lax", path: "/", maxAge: 30 * 86400 } as const;

/** Seed the five stock roles for a new business. */
/** True only before the very first user exists. */
authRoutes.get("/bootstrap", async (c) => {
  const [u] = await db.select({ id: schema.users.id }).from(schema.users).limit(1);
  return c.json({ needsSignup: !u });
});

// the very first person is made at the main computer, never from the network
authRoutes.post("/signup", mainComputerOnly, async (c) => {
  const [existing] = await db.select({ id: schema.users.id }).from(schema.users).limit(1);
  if (existing) throw new HttpError(409, "Already set up. Please sign in.", "already_setup");

  const body = z.object({
    name: z.string().trim().min(2, "Enter your name").max(100),
    nameHi: z.string().trim().max(100).optional(),
    phone: z.string().trim().max(20).optional(),
    pin: z.string().max(12),
    businessName: z.string().trim().min(2, "Enter the business name").max(150),
    businessNameHi: z.string().trim().max(150).optional(),
    shortCode: z.string().trim().min(1).max(12),
  }).parse(await c.req.json());

  const weak = weakPin(body.pin);
  if (weak) throw bad(weak, "weak_pin");

  const { hash, salt } = hashPin(body.pin);
  const userId = newId();
  const businessId = newId();

  // one transaction: one flush to the disk for the business's hundred-odd rows, and never half a business
  sqlite.transaction(() => {
    db.insert(schema.users).values({
      id: userId, name: body.name, nameHi: body.nameHi || null,
      phone: body.phone || null, pinHash: hash, pinSalt: salt, isRoot: true,
    }).run();
    db.insert(schema.businesses).values({
      id: businessId, name: body.businessName,
      nameHi: body.businessNameHi || null,
      shortCode: body.shortCode.toUpperCase(),
    }).run();
    const roles = seedRoles(businessId);
    seedJins(businessId);
    db.insert(schema.memberships).values({
      id: newId(), userId, businessId, roleId: roles.owner,
    }).run();
  })();

  const token = await createSession(userId, businessId, c.req.header("user-agent"));
  setCookie(c, COOKIE, token, cookieOpts);
  await audit({
    actor: { userId, userName: body.name, businessId, ip: clientAddress(c) },
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

type User = typeof schema.users.$inferSelect;
const minutes = (s: number) => Math.ceil(s / 60);
const plural = (n: number) => `${n} attempt${n === 1 ? "" : "s"}`;

/** The business a person comes back to: where they left off, not whichever row the DB returns first. */
async function resumeBusiness(user: User) {
  const mems = await db.select().from(schema.memberships).where(and(
    eq(schema.memberships.userId, user.id), eq(schema.memberships.active, true),
  ));
  const remembered = parsePrefs(user.prefs).lastBusinessId;
  return mems.find((m) => m.businessId === remembered)?.businessId ?? mems[0]?.businessId ?? null;
}

/**
 * The person and PIN, checked, with wrong PINs counted where they were
 * typed: on the main computer against the person's row (as before), from
 * another device per person and device (lib/auth.ts). The audit trail
 * names the device.
 */
async function checkPin(c: Context<Env>, userId: string, pin: string): Promise<User> {
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  if (!user || !user.active) throw new HttpError(401, "Unknown user", "bad_credentials");
  const here = fromThisComputer(c);
  const ip = clientAddress(c);

  const wait = here ? lockRemaining(user) : remoteWait(user.id, ip);
  if (wait > 0) throw new HttpError(429, `Too many wrong PINs. Try again in ${minutes(wait)} min.`, "locked");

  if (!verifyPin(pin, user.pinHash, user.pinSalt)) {
    let msg: string;
    if (here) {
      await registerFailure(user.id);
      const left = Math.max(0, 4 - user.failedAttempts);
      msg = left > 0 ? `Wrong PIN. ${plural(left)} left.` : "Wrong PIN. Account locked for 5 minutes.";
    } else {
      const r = registerRemoteFailure(user.id, ip);
      msg = r.wait > 0 ? `Wrong PIN. Try again in ${minutes(r.wait)} min.` : `Wrong PIN. ${plural(r.left)} left.`;
    }
    await audit({
      actor: { userId: user.id, userName: user.name, businessId: await resumeBusiness(user), ip },
      action: "login.failed", entity: "user", entityId: user.id,
      entityLabel: here ? user.name : `${user.name} · ${ip}`,
    });
    throw new HttpError(401, msg, "bad_credentials");
  }
  if (here) await clearFailures(user.id);
  else clearRemoteFailures(user.id, ip);
  return user;
}

/** Signs the person in on this device: a month on the main computer, the working day from another. */
async function startSession(c: Context<Env>, user: User) {
  const remote = !fromThisComputer(c);
  const resume = await resumeBusiness(user);
  const token = await createSession(user.id, resume, c.req.header("user-agent"), remote);
  setCookie(c, COOKIE, token, remote ? { ...cookieOpts, maxAge: REMOTE_SESSION_SECONDS } : cookieOpts);
  await audit({
    actor: { userId: user.id, userName: user.name, businessId: resume, ip: clientAddress(c) },
    action: "login", entity: "user", entityId: user.id, entityLabel: remote ? `${user.name} · ${clientAddress(c)}` : user.name,
  });
}

const LoginBody = z.object({ userId: z.string().max(64), pin: z.string().max(12) });

/* The right PIN lets the person in, on the main computer or another device:
   a new install's people stay on 7747 until the owner changes their PINs
   himself (Change PIN, or Users), and nobody is stopped for still being on it. */
authRoutes.post("/login", async (c) => {
  const body = LoginBody.parse(await c.req.json());
  const user = await checkPin(c, body.userId, body.pin);
  await startSession(c, user);
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
    roleLabel: schema.roles.label, roleLabelHi: schema.roles.labelHi,
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
  const prefs = parsePrefs(auth.user.prefs);
  await db.update(schema.users)
    .set({ prefs: JSON.stringify({ ...prefs, lastBusinessId: businessId }), updatedAt: nowSec() })
    .where(eq(schema.users.id, auth.user.id));
  await audit({ actor: { ...actor(c), businessId }, action: "business.switch", entity: "business", entityId: businessId });
  return c.json({ ok: true });
});

/** Add a second business (V C Enterprise alongside Vijay Laxmi). */
authRoutes.post("/businesses", requireAuth, async (c) => {
  const auth = c.get("auth")!;
  // a new business carries install-wide powers (backups, cloud, updates): only the Admin adds one
  if (!auth.user.isRoot) throw new HttpError(403, "Only the Admin can add a business", "forbidden");
  const body = z.object({
    name: z.string().trim().min(2),
    nameHi: z.string().trim().optional(),
    shortCode: z.string().trim().min(1).max(12),
  }).parse(await c.req.json());

  const businessId = newId();
  // one transaction: one flush to the disk for the business's hundred-odd rows, and never half a business
  sqlite.transaction(() => {
    db.insert(schema.businesses).values({
      id: businessId, name: body.name,
      nameHi: body.nameHi || null, shortCode: body.shortCode.toUpperCase(),
    }).run();
    const roles = seedRoles(businessId);
    seedJins(businessId);
    db.insert(schema.memberships).values({
      id: newId(), userId: auth.user.id, businessId, roleId: roles.owner,
    }).run();
    db.update(schema.sessions).set({ activeBusinessId: businessId })
      .where(eq(schema.sessions.id, auth.session.id)).run();
  })();
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
  // every other sign-in of this person ends; this one stays
  await db.delete(schema.sessions).where(and(eq(schema.sessions.userId, auth.user.id), ne(schema.sessions.id, auth.session.id)));
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

/** Per-user screen preferences: column layout, row order, density. */
authRoutes.get("/prefs", requireAuth, async (c) => {
  const auth = c.get("auth")!;
  return c.json({ prefs: parsePrefs(auth.user.prefs), columns: DAILY_COLUMNS });
});

/** Merges — send only the slice you changed. */
authRoutes.put("/prefs", requireAuth, async (c) => {
  const auth = c.get("auth")!;
  const patch = PrefsSchema.deepPartial().parse(await c.req.json());
  const current = parsePrefs(auth.user.prefs);
  const next = PrefsSchema.parse({
    ...current,
    dailyList: { ...current.dailyList, ...(patch.dailyList ?? {}) },
  });
  await db.update(schema.users).set({ prefs: JSON.stringify(next), updatedAt: nowSec() })
    .where(eq(schema.users.id, auth.user.id));
  return c.json(next);
});

authRoutes.post("/prefs/reset", requireAuth, async (c) => {
  const auth = c.get("auth")!;
  await db.update(schema.users).set({ prefs: null, updatedAt: nowSec() })
    .where(eq(schema.users.id, auth.user.id));
  return c.json(defaultPrefs());
});

/** The daily-list layout this person chose on this computer (see lib/devicePrefs.ts). */
authRoutes.get("/device-prefs", requireAuth, (c) => c.json({ dailyList: readDevicePrefs(c.get("auth")!.user.id) }));
authRoutes.put("/device-prefs", requireAuth, async (c) => {
  const { dailyList } = z.object({ dailyList: DailyListPrefsSchema }).parse(await c.req.json());
  writeDevicePrefs(c.get("auth")!.user.id, dailyList);
  return c.json({ dailyList });
});
authRoutes.delete("/device-prefs", requireAuth, (c) => {
  writeDevicePrefs(c.get("auth")!.user.id, null);
  return c.json({ dailyList: null });
});

/** Utility the UI calls while typing a Hindi name. */
authRoutes.post("/transliterate", requireAuth, async (c) => {
  const { text } = z.object({ text: z.string().max(2000) }).parse(await c.req.json());
  return c.json({ hinglish: toHinglish(text) });
});

/**
 * Latin -> Devanagari without a business context: for the sign-up screen
 * (nobody exists yet), and for anyone signed in whose /adati one is refused.
 */
authRoutes.post("/to-devanagari", async (c) => {
  if (!c.get("auth")) {
    const [someone] = await db.select({ id: schema.users.id }).from(schema.users).limit(1);
    if (someone) throw new HttpError(401, "Please sign in", "no_session");
  }
  const { text } = z.object({ text: z.string().max(2000) }).parse(await c.req.json());
  if (!hasLatin(text)) return c.json({ hindi: text, converted: false });
  return c.json({ hindi: toDevanagari(text), converted: true });
});

export { seedRoles, seedJins, defaultChargeConfig };
