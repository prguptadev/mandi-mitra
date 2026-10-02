import crypto from "node:crypto";
import { db, schema } from "../db/client.ts";
import { eq, and, lte, sql } from "drizzle-orm";
import { newId, nowSec } from "./ids.ts";
import { ALL_PERMISSIONS, effectivePermissions } from "./rbac.ts";

const SESSION_DAYS = 30;
/** A sign-in from another device on the shop's network lasts the working day, not a month:
 *  the network is plain HTTP, so a cookie seen on the Wi-Fi is worth little. */
export const REMOTE_SESSION_SECONDS = 12 * 3600;
const MAX_ATTEMPTS = 5;
const LOCKOUT_SECONDS = 300;

export function hashPin(pin: string) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(pin, salt, 64, { N: 16384, r: 8, p: 1 }).toString("hex");
  return { hash, salt };
}

export function verifyPin(pin: string, hash: string, salt: string) {
  const candidate = crypto.scryptSync(pin, salt, 64, { N: 16384, r: 8, p: 1 });
  const known = Buffer.from(hash, "hex");
  return candidate.length === known.length && crypto.timingSafeEqual(candidate, known);
}

export const PIN_RE = /^\d{4,6}$/;

/**
 * Reject the PINs everyone picks first. 7747 is the PIN every new install
 * starts with (lib/businessSetup.ts) and is published, so it is never a PIN
 * of one's own: a person still on it, or on any PIN refused here, chooses a
 * new one at sign-in (routes/auth.ts).
 */
export function weakPin(pin: string): string | null {
  if (!PIN_RE.test(pin)) return "PIN must be 4 to 6 digits";
  if (/^(\d)\1+$/.test(pin)) return "PIN cannot be the same digit repeated";
  if ("0123456789".includes(pin) || "9876543210".includes(pin)) return "PIN cannot be a run of digits";
  if (["7747", "1234", "0000", "1111", "1212", "1122", "1313", "2580", "0852", "1010", "2020",
    "123456", "111111", "121212", "112233", "123123"].includes(pin)) return "PIN is too common";
  return null;
}

export async function createSession(userId: string, businessId: string | null, userAgent?: string, remote = false) {
  const token = crypto.randomBytes(32).toString("base64url");
  const id = newId();
  await db.insert(schema.sessions).values({
    id, token, userId, activeBusinessId: businessId,
    userAgent: userAgent?.slice(0, 250),
    expiresAt: nowSec() + (remote ? REMOTE_SESSION_SECONDS : SESSION_DAYS * 86400),
  });
  return token;
}

/** A sign-in made from another device is the short kind (see REMOTE_SESSION_SECONDS). */
const isRemoteSession = (s: { expiresAt: number; createdAt: number }) => s.expiresAt - s.createdAt <= REMOTE_SESSION_SECONDS + 60;

/** Every sign-in made from another device ends (sharing switched off). */
export async function endRemoteSessions() {
  await db.delete(schema.sessions)
    .where(lte(sql`${schema.sessions.expiresAt} - ${schema.sessions.createdAt}`, REMOTE_SESSION_SECONDS + 60));
}

export async function destroySession(token: string) {
  await db.delete(schema.sessions).where(eq(schema.sessions.token, token));
}

export interface AuthContext {
  user: typeof schema.users.$inferSelect;
  session: typeof schema.sessions.$inferSelect;
  businessId: string | null;
  business: typeof schema.businesses.$inferSelect | null;
  role: typeof schema.roles.$inferSelect | null;
  permissions: Set<string>;
}

/** `remote`: the request comes from another device, which may use only a sign-in made there. */
export async function resolveSession(token: string | undefined, remote = false): Promise<AuthContext | null> {
  if (!token) return null;
  const [session] = await db.select().from(schema.sessions).where(eq(schema.sessions.token, token)).limit(1);
  if (!session || session.expiresAt < nowSec()) {
    if (session) await destroySession(token);
    return null;
  }
  // the main computer's month-long sign-in is never carried over the network
  if (remote && !isRemoteSession(session)) return null;
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, session.userId)).limit(1);
  if (!user || !user.active) return null;

  let business = null;
  let role = null;
  let permissions = new Set<string>();

  if (session.activeBusinessId) {
    const [b] = await db.select().from(schema.businesses)
      .where(eq(schema.businesses.id, session.activeBusinessId)).limit(1);
    business = b ?? null;

    const [m] = await db.select().from(schema.memberships).where(and(
      eq(schema.memberships.userId, user.id),
      eq(schema.memberships.businessId, session.activeBusinessId),
      eq(schema.memberships.active, true),
    )).limit(1);

    if (m) {
      const [r] = await db.select().from(schema.roles).where(eq(schema.roles.id, m.roleId)).limit(1);
      role = r ?? null;
      const rolePerms = await db.select().from(schema.rolePermissions)
        .where(eq(schema.rolePermissions.roleId, m.roleId));
      const overrides = await db.select().from(schema.userPermissionOverrides)
        .where(eq(schema.userPermissionOverrides.membershipId, m.id));
      // the owner can do everything, including what later versions add
      permissions = r?.key === "owner"
        ? new Set<string>(ALL_PERMISSIONS)
        : effectivePermissions(rolePerms.map((p) => p.permission), overrides);
    }
  }

  return { user, session, businessId: session.activeBusinessId, business, role, permissions };
}

export async function registerFailure(userId: string) {
  const [u] = await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  if (!u) return;
  const attempts = u.failedAttempts + 1;
  await db.update(schema.users).set({
    failedAttempts: attempts,
    lockedUntil: attempts >= MAX_ATTEMPTS ? nowSec() + LOCKOUT_SECONDS : null,
    updatedAt: nowSec(),
  }).where(eq(schema.users.id, userId));
}

export async function clearFailures(userId: string) {
  await db.update(schema.users)
    .set({ failedAttempts: 0, lockedUntil: null, updatedAt: nowSec() })
    .where(eq(schema.users.id, userId));
}

export function lockRemaining(u: { lockedUntil: number | null }) {
  if (!u.lockedUntil) return 0;
  return Math.max(0, u.lockedUntil - nowSec());
}

/* ------------------------------------------------ wrong PINs from other devices

   The count above (on the person's row) is the main computer's own: only a
   wrong PIN typed there locks a person there, so a phone or laptop on the
   Wi-Fi can never keep the owner out of his own window. Other devices are
   counted here, in memory, per person AND per device: five tries, then a
   wait that grows (5 min, 15 min, 1 hour), so one device guessing does not
   lock the second laptop out. A device that keeps changing its address is
   caught by a cap per person over all other devices together (20 a day,
   then an hour's wait for every other device; never the main computer).
   A restart forgets these counts, which only ever lets someone in sooner. */

const REMOTE_WAITS = [300, 900, 3600];
const REMOTE_DAY_CAP = 20;
const REMOTE_CAP_WAIT = 3600;
interface Tally { fails: number; strikes: number; lockedUntil: number; last: number }
const byDevice = new Map<string, Tally>();
const byPerson = new Map<string, { at: number[]; lockedUntil: number }>();
const deviceKey = (userId: string, ip: string | null) => `${userId} ${ip ?? "?"}`;

function prune(now: number) {
  if (byDevice.size < 2000) return;
  for (const [k, t] of byDevice) if (t.lockedUntil < now && now - t.last > 86400) byDevice.delete(k);
  // still too many: the oldest go (a wait cut short, nothing worse)
  if (byDevice.size >= 2000) [...byDevice.keys()].slice(0, byDevice.size - 1500).forEach((k) => byDevice.delete(k));
}

/** Seconds this person must wait before trying again from that device (0: may try). */
export function remoteWait(userId: string, ip: string | null): number {
  const now = nowSec();
  const t = byDevice.get(deviceKey(userId, ip));
  const p = byPerson.get(userId);
  return Math.max(0, (t?.lockedUntil ?? 0) - now, (p?.lockedUntil ?? 0) - now);
}

/** Until when some other device must wait for this person (0: none), for the Users list's "Locked". */
export function remoteLockedUntil(userId: string): number {
  let until = byPerson.get(userId)?.lockedUntil ?? 0;
  for (const [k, t] of byDevice) if (k.startsWith(`${userId} `) && t.lockedUntil > until) until = t.lockedUntil;
  return until > nowSec() ? until : 0;
}

/** Counts a wrong PIN from another device: the tries left there, and the wait it now has. */
export function registerRemoteFailure(userId: string, ip: string | null): { left: number; wait: number } {
  const now = nowSec();
  prune(now);
  const key = deviceKey(userId, ip);
  const t = byDevice.get(key) ?? { fails: 0, strikes: 0, lockedUntil: 0, last: 0 };
  // a day without a wrong PIN from there starts the device afresh
  if (now - t.last > 86400) { t.fails = 0; t.strikes = 0; }
  t.fails++;
  t.last = now;
  if (t.fails >= MAX_ATTEMPTS) {
    t.lockedUntil = now + REMOTE_WAITS[Math.min(t.strikes, REMOTE_WAITS.length - 1)];
    t.strikes++;
    t.fails = 0;
  }
  byDevice.set(key, t);
  const p = byPerson.get(userId) ?? { at: [], lockedUntil: 0 };
  p.at = [...p.at.filter((x) => now - x < 86400), now];
  if (p.at.length >= REMOTE_DAY_CAP) { p.lockedUntil = now + REMOTE_CAP_WAIT; p.at = []; }
  byPerson.set(userId, p);
  const wait = remoteWait(userId, ip);
  return { left: wait > 0 ? 0 : MAX_ATTEMPTS - t.fails, wait };
}

/** A right PIN from a device clears that device's count; the Admin's "unlock" (no device named) clears them all. */
export function clearRemoteFailures(userId: string, ip?: string | null) {
  if (ip !== undefined) { byDevice.delete(deviceKey(userId, ip)); return; }
  for (const k of byDevice.keys()) if (k.startsWith(`${userId} `)) byDevice.delete(k);
  byPerson.delete(userId);
}
