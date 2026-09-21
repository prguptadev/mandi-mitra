import crypto from "node:crypto";
import { db, schema } from "../db/client.ts";
import { eq, and } from "drizzle-orm";
import { newId, nowSec } from "./ids.ts";
import { ALL_PERMISSIONS, effectivePermissions } from "./rbac.ts";

const SESSION_DAYS = 30;
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

/** Reject the PINs everyone picks first. */
export function weakPin(pin: string): string | null {
  if (!PIN_RE.test(pin)) return "PIN must be 4 to 6 digits";
  if (/^(\d)\1+$/.test(pin)) return "PIN cannot be the same digit repeated";
  if ("0123456789".includes(pin) || "9876543210".includes(pin)) return "PIN cannot be a run of digits";
  if (["1234", "0000", "1111", "1212", "123456", "111111"].includes(pin)) return "PIN is too common";
  return null;
}

export async function createSession(userId: string, businessId: string | null, userAgent?: string) {
  const token = crypto.randomBytes(32).toString("base64url");
  const id = newId();
  await db.insert(schema.sessions).values({
    id, token, userId, activeBusinessId: businessId,
    userAgent: userAgent?.slice(0, 250),
    expiresAt: nowSec() + SESSION_DAYS * 86400,
  });
  return token;
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

export async function resolveSession(token: string | undefined): Promise<AuthContext | null> {
  if (!token) return null;
  const [session] = await db.select().from(schema.sessions).where(eq(schema.sessions.token, token)).limit(1);
  if (!session || session.expiresAt < nowSec()) {
    if (session) await destroySession(token);
    return null;
  }
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
