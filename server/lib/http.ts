import type { Context, Next } from "hono";
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
