import type { Context, Next } from "hono";
import { sqlite } from "../db/client.ts";
import type { Env } from "./http.ts";

/* The heaviest screens add up a whole book. Asked again while nothing in the
   books has changed (no slip, payment, truck or receipt saved here, nothing
   brought down from another computer), they would add up to the very same
   answer, so the last one is given again. SQLite itself says whether anything
   changed: the rows this connection has written (total_changes) and, for any
   other connection, the file's data_version. An answer is kept per business,
   per set of permissions (only some may see money) and per exact address, and
   only if nothing changed while it was being worked out. These screens read
   nothing but the books and the address: no clock, no files. */

const SCREENS = [
  /^\/api\/dashboard$/, /^\/api\/dashboard\/money$/, /^\/api\/dashboard\/mill\/[^/]+$/,
  /^\/api\/stock$/, /^\/api\/stock\/[^/]+$/,
  /^\/api\/ledger$/, /^\/api\/mill-ledger$/, /^\/api\/mill-ledger\/[^/]+$/,
  /^\/api\/challan$/, /^\/api\/parchas$/, /^\/api\/loads$/,
];
/** A dozen answers of up to a MB or so: what a morning's going back and forth between screens needs. */
const MAX_KEPT = 12;
const kept = new Map<string, { stamp: string; body: string; type: string }>();
const written = sqlite.prepare("select total_changes()").pluck();
const stampNow = () => `${written.get() as number}|${sqlite.pragma("data_version", { simple: true }) as number}`;

export async function unchangedBooks(c: Context<Env>, next: Next) {
  const auth = c.get("auth");
  if (c.req.method !== "GET" || !auth?.businessId || !SCREENS.some((r) => r.test(c.req.path))) return next();
  const url = new URL(c.req.url);
  const key = `${auth.businessId}|${[...auth.permissions].sort().join(",")}|${url.pathname}${url.search}`;
  const stamp = stampNow();
  const hit = kept.get(key);
  if (hit && hit.stamp === stamp) {
    kept.delete(key);
    kept.set(key, hit);
    return c.body(hit.body, 200, { "Content-Type": hit.type });
  }
  await next();
  if (c.res.status !== 200 || stampNow() !== stamp) return;
  const body = await c.res.clone().text();
  kept.delete(key);
  kept.set(key, { stamp, body, type: c.res.headers.get("content-type") ?? "application/json" });
  while (kept.size > MAX_KEPT) kept.delete(kept.keys().next().value!);
}
