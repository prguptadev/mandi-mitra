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
/* Rows written that are not the books: sync's own marks of what is still to
   send, cleared once it has gone up. Leaving them out keeps every kept answer
   good after a push (the change itself was counted when it was made). */
let notBooks = 0;
/** `n` rows just written were sync's marks only (no slip, payment, truck or other record). */
export function notBooksWritten(n: number) { notBooks += n; }
const stampNow = () => `${(written.get() as number) - notBooks}|${sqlite.pragma("data_version", { simple: true }) as number}`;

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

/* The same rule for the parts several screens are added up from: every
   purchase day of a business, every truck row with its weight, every truck
   priced. Worked out once while the books stay as they are and handed to each
   screen that asks meanwhile (the home screen asks for three at once, and the
   next screen opened usually needs the same parts). Anything written here or
   by another connection, and the next ask works them out afresh. A part asked
   for while it is still being worked out waits for that work instead of
   repeating it. The screens only read what they are handed: a list is frozen,
   so changing one would fail loudly rather than alter another screen's
   figures. */

let partsAt = "";
const parts = new Map<string, Promise<unknown>>();
/** Plenty for every screen of two businesses; a long evening of picking dates one by one gives the oldest back. */
const MAX_PARTS = 48;

/** `work()`'s answer, shared while the books are unchanged. `key` names the part and everything it depends on. */
export function sharedPart<T>(key: string, work: () => Promise<T>): Promise<T> {
  const stamp = stampNow();
  if (stamp !== partsAt) { parts.clear(); partsAt = stamp; }
  const hit = parts.get(key);
  if (hit) {
    // the most recently used are the last to give back
    parts.delete(key);
    parts.set(key, hit);
    return hit as Promise<T>;
  }
  const p = work().then((v) => (Array.isArray(v) ? Object.freeze(v) : v) as T);
  parts.set(key, p);
  while (parts.size > MAX_PARTS) parts.delete(parts.keys().next().value!);
  // an answer that saw a change while it was being worked out is not handed out again
  p.then(() => { if (stampNow() !== stamp && parts.get(key) === p) parts.delete(key); }, () => { if (parts.get(key) === p) parts.delete(key); });
  return p;
}

/** Whether that part is in hand (or being worked out) for the books as they are now. */
export function partInHand(key: string): boolean {
  return stampNow() === partsAt && parts.has(key);
}
