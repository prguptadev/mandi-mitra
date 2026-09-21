import type { Context, Next } from "hono";
import { z } from "zod";
import { getCookie } from "hono/cookie";
import { resolveSession, type AuthContext } from "./auth.ts";
import type { AuditActor } from "./audit.ts";

export const COOKIE = "mandi_session";

export type Env = { Variables: { auth: AuthContext } };

export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

export const bad = (m: string, code?: string) => new HttpError(400, m, code);
export const notFound = (m = "Not found") => new HttpError(404, m);

/** Attaches the session. Does not reject — routes opt in with requireAuth. */
export async function withSession(c: Context<Env>, next: Next) {
  const token = getCookie(c, COOKIE);
  const auth = await resolveSession(token);
  if (auth) c.set("auth", auth);
  await next();
}

export async function requireAuth(c: Context<Env>, next: Next) {
  if (!c.get("auth")) throw new HttpError(401, "Please sign in", "no_session");
  await next();
}

export async function requireBusiness(c: Context<Env>, next: Next) {
  const auth = c.get("auth");
  if (!auth) throw new HttpError(401, "Please sign in", "no_session");
  if (!auth.businessId) throw new HttpError(409, "No business selected", "no_business");
  await next();
}

/** Route guard: `app.get("/x", can("adati.read"), handler)` */
export function can(...perms: string[]) {
  return async (c: Context<Env>, next: Next) => {
    const auth = c.get("auth");
    if (!auth) throw new HttpError(401, "Please sign in", "no_session");
    if (!auth.businessId) throw new HttpError(409, "No business selected", "no_business");
    const ok = perms.some((p) => auth.permissions.has(p));
    if (!ok) throw new HttpError(403, `You do not have permission: ${perms.join(" or ")}`, "forbidden");
    await next();
  };
}

/** Route guard needing every one of the permissions (`can` needs any one). */
export function canAll(...perms: string[]) {
  return async (c: Context<Env>, next: Next) => {
    const auth = c.get("auth");
    if (!auth) throw new HttpError(401, "Please sign in", "no_session");
    if (!auth.businessId) throw new HttpError(409, "No business selected", "no_business");
    const missing = perms.filter((p) => !auth.permissions.has(p));
    if (missing.length) throw new HttpError(403, `You do not have permission: ${missing.join(" and ")}`, "forbidden");
    await next();
  };
}

/** Route params are `string | undefined` in Hono; a missing one is a 400, not a cast. */
export function param(c: Context<Env>, name: string): string {
  const v = c.req.param(name);
  if (!v) throw new HttpError(400, `Missing ${name} in the URL`, "bad_param");
  return v;
}

export function actor(c: Context<Env>): AuditActor {
  const auth = c.get("auth");
  return {
    userId: auth?.user.id ?? null,
    userName: auth?.user.name ?? null,
    businessId: auth?.businessId ?? null,
    ip: c.req.header("x-forwarded-for") ?? null,
    userAgent: c.req.header("user-agent") ?? null,
  };
}

/**
 * A Content-Disposition value any browser accepts for any file name: an ASCII
 * fallback (Hindi digits, slashes and quotes replaced) plus the real name
 * UTF-8 encoded. "parcha-25-26/१९६.xlsx" must download, not crash.
 */
export function attachment(name: string): string {
  const ascii = name.normalize("NFKD").replace(/[^\x20-\x7e]/g, "_").replace(/["\\/;]/g, "-");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name.replace(/[\\/]/g, "-"))}`;
}

/** A real calendar day, YYYY-MM-DD, within 2000–2100: a typo like 0202 is refused, not saved. */
export const isoDay = (msg = "Date must be YYYY-MM-DD") => z.string().regex(/^\d{4}-\d{2}-\d{2}$/, msg).refine((v) => {
  const [y, m, d] = v.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return y >= 2000 && y <= 2100 && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}, { message: "That date is not a real day between 2000 and 2100" });

/** Sanity caps: a slip or truck of 1,000 qtl, ₹1 lakh a quintal, ₹1,000 crore. */
export const LIMIT = { grams: 100_000_000, rate: 10_000_000, paise: 100_000_000_000, count: 1_000_000 } as const;
