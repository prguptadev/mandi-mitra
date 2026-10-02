import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import type { Context, Next } from "hono";
import { z } from "zod";
import { getCookie } from "hono/cookie";
import { bodyLimit } from "hono/body-limit";
import { resolveSession, type AuthContext } from "./auth.ts";
import { DB_PATH } from "../db/client.ts";
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

/* ------------------------------------------------ who is asking, from where

   The address comes from the connection itself, never from a header a
   client can write (X-Forwarded-For was empty on a direct connection and
   could be faked). With "Let this network's computers use these books" on,
   another laptop or phone on the shop's Wi-Fi reaches this server too; the
   main computer's own window always comes from 127.0.0.1. */

/**
 * A connection whose address can no longer be read (the device reset it
 * before the request was looked at): neither this computer nor the shop's
 * network, so it is refused and never taken for the main computer.
 */
export const UNKNOWN_ADDRESS = "unknown";

/**
 * The device this request came from (an IP address). null only when there is
 * no connection at all: a request made inside this process (app.request /
 * app.fetch). A connection without a readable address is UNKNOWN_ADDRESS.
 */
export function clientAddress(c: Context): string | null {
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
  if (!incoming) return null;
  let a: string | undefined;
  try { a = incoming.socket?.remoteAddress; } catch { a = undefined; }
  return a ? a.replace(/^::ffff:/i, "").toLowerCase() : UNKNOWN_ADDRESS;
}

export const isLoopback = (a: string) => a === "::1" || /^127\./.test(a);

/** Loopback, or the private ranges a shop's router hands out (never an address on the open internet). */
export function isLanAddress(a: string): boolean {
  if (isLoopback(a)) return true;
  const v4 = a.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (v4) {
    const x = Number(v4[1]), y = Number(v4[2]);
    return x === 10 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 169 && y === 254);
  }
  const h = a.split("%")[0];
  return /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h);
}

/**
 * True for the main computer itself (its own window, or a browser on it).
 * A request with no connection at all can only come from inside this
 * process, so it counts as here.
 */
export function fromThisComputer(c: Context): boolean {
  const a = clientAddress(c);
  return a === null || isLoopback(a);
}

export const MAIN_ONLY = "This can be done only on the main computer.";

/** Install-wide changes (backups, restore, updates, cloud, network): only at the main computer. */
export async function mainComputerOnly(c: Context<Env>, next: Next) {
  if (!fromThisComputer(c)) throw new HttpError(403, MAIN_ONLY, "main_computer_only");
  await next();
}

/* ------------------------------------------------ which names this server answers to

   A web page elsewhere can point a name at this computer (DNS rebinding) or
   post a form here; the Host it asks for, and the Origin a browser adds to a
   change, give it away. Only this computer's own names are answered: the
   loopback names always, and with sharing on also its own network addresses
   and its Windows computer name. */

const LOOPBACK_NAMES = new Set(["127.0.0.1", "localhost", "::1"]);
let own: { at: number; names: Set<string>; base: string } | null = null;
function ownNames(fresh = false) {
  // an address the router changes is picked up within seconds
  if (own && Date.now() - own.at < (fresh ? 2_000 : 30_000)) return own;
  const names = new Set(LOOPBACK_NAMES);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list ?? []) names.add(n.address.split("%")[0].toLowerCase());
  }
  own = { at: Date.now(), names, base: os.hostname().toLowerCase().split(".")[0] };
  return own;
}
/** The endings a shop router or Windows gives a computer's name (never a public one like .com). */
const LOCAL_SUFFIXES = new Set(["local", "lan", "home", "home.arpa", "localdomain", "internal", "intranet"]);
/** One of this computer's names: an address of its own, or its computer name, bare or with a local ending (shop-pc, shop-pc.local, shop-pc.lan). */
function isOwnName(name: string): boolean {
  const known = (o: ReturnType<typeof ownNames>) => o.names.has(name)
    || (!!o.base && (name === o.base || (name.startsWith(`${o.base}.`) && LOCAL_SUFFIXES.has(name.slice(o.base.length + 1)))));
  return known(ownNames()) || known(ownNames(true));
}

function parseHost(h: string | undefined | null): { name: string; port: string } | null {
  if (!h) return null;
  try {
    const u = new URL(`http://${h}`);
    if (u.pathname !== "/" || u.username || u.search) return null;
    return { name: u.hostname.replace(/^\[|\]$/g, "").toLowerCase(), port: u.port || "80" };
  } catch { return null; }
}
function parseOrigin(o: string): { name: string; port: string } | null {
  try {
    const u = new URL(o);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return { name: u.hostname.replace(/^\[|\]$/g, "").toLowerCase(), port: u.port || (u.protocol === "https:" ? "443" : "80") };
  } catch { return null; }
}
/** The port this server listens on (the socket's own, else PORT). */
function appPort(c: Context): string {
  const local = (c.env as { incoming?: { socket?: { localPort?: number } } } | undefined)?.incoming?.socket?.localPort;
  return String(local ?? process.env.PORT ?? 8787);
}

/**
 * Guards every /api request. `shared` is true when the books are open to the
 * shop's network (MANDI_HOST is not a loopback address).
 *  - a device outside the private address ranges is never answered;
 *  - the Host must be one of this computer's names, on the app's port;
 *  - a change (anything but GET) carrying an Origin must come from this very
 *    address: "null" (sandboxed frames, files) or another port is refused.
 *    Requests with no Origin (scripts, the app itself) are not browsers.
 */
export function requestGuard(shared: boolean) {
  const nope = (c: Context, error: string, code: string) => c.json({ error, code }, 403);
  return async (c: Context<Env>, next: Next) => {
    const addr = clientAddress(c);
    if (addr && !isLanAddress(addr)) return nope(c, "Not allowed from here", "bad_network");
    // listening on the network since start-up, but sharing has been switched off since: this computer only
    if (shared && addr && !isLoopback(addr) && sharingSwitchedOff()) return nope(c, NOT_SHARED, "not_shared");
    const host = parseHost(c.req.header("host"));
    const named = (n: string) => LOOPBACK_NAMES.has(n) || (shared && isOwnName(n));
    if (!host || !named(host.name) || host.port !== appPort(c)) return nope(c, "Not allowed from here", "bad_host");
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      const origin = c.req.header("origin");
      const site = c.req.header("sec-fetch-site");
      if (origin !== undefined) {
        const o = parseOrigin(origin);
        if (!o || !named(o.name)) return nope(c, "Not allowed from another site", "bad_origin");
        // the browser says whether the page is this very site; without that word, the address must match exactly
        if (site ? site !== "same-origin" : o.name !== host.name || o.port !== host.port) {
          return nope(c, "Not allowed from another site", "bad_origin");
        }
      } else if (site && site !== "same-origin" && site !== "none") {
        return nope(c, "Not allowed from another site", "bad_origin");
      }
    }
    await next();
  };
}

/* The server listens on the network from start-up when sharing is on
   (MANDI_HOST); switching sharing off in Settings writes network.json and
   takes effect on the next start. Until then other devices are refused here.
   No network.json at all (MANDI_HOST set by hand, the tests) changes nothing. */
export const NOT_SHARED = "This computer no longer shares its books on the network.";
let shareRead: { at: number; off: boolean } | null = null;
function sharingSwitchedOff(): boolean {
  if (shareRead && Date.now() - shareRead.at < 2_000) return shareRead.off;
  let off = false;
  try { off = JSON.parse(fs.readFileSync(path.join(path.dirname(DB_PATH), "network.json"), "utf8")).share === false; } catch { /* no file: as started */ }
  shareRead = { at: Date.now(), off };
  return off;
}
/** Settings › network sharing changed (routes/cloud.ts): read network.json again at the next request. */
export function sharingChanged() { shareRead = null; }

/* ------------------------------------------------ how much may be sent

   The server runs inside the app's own process, so one huge request would
   freeze the window. Before signing in only a few kilobytes are needed
   (a name, a PIN); signed in, a season's tally marks run to ~10 MB; a
   sheet upload is up to ten pages of 12 MB each. */
const KB = 1024, MB = 1024 * KB;
const tooBig = (c: Context) => c.json({ error: "That is too big to send.", code: "too_large" }, 413);
// signed out with more than a name and a PIN: most likely a sign-in that ran out mid-upload
const signInFirst = (c: Context) => c.json({ error: "Please sign in", code: "no_session" }, 401);
const limitSignedOut = bodyLimit({ maxSize: 64 * KB, onError: signInFirst });
const limitSignedIn = bodyLimit({ maxSize: 50 * MB, onError: tooBig });
const limitUpload = bodyLimit({ maxSize: 10 * 12 * MB + 4 * MB, onError: tooBig });
export async function bodyLimits(c: Context<Env>, next: Next) {
  if (c.req.method === "GET" || c.req.method === "HEAD") return next();
  if (!c.get("auth")) return limitSignedOut(c, next);
  if (c.req.method === "POST" && /^\/api\/scans\/?$/.test(c.req.path)) return limitUpload(c, next);
  return limitSignedIn(c, next);
}

/** Attaches the session. Does not reject — routes opt in with requireAuth. */
export async function withSession(c: Context<Env>, next: Next) {
  const token = getCookie(c, COOKIE);
  const auth = await resolveSession(token, !fromThisComputer(c));
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
    ip: clientAddress(c),
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
