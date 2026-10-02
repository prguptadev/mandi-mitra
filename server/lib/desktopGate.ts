import type { MiddlewareHandler } from "hono";
import os from "node:os";
import crypto from "node:crypto";

/*
 * The desktop app's server answers the app's own windows, not Chrome or Edge
 * on the same PC (a browser has developer tools; the app keeps them shut).
 * The app makes a fresh key every time it starts (electron/main.cjs), hands it
 * to the server here, and adds it to every request from its windows. A request
 * from this PC without the key gets one plain sentence.
 *
 * Requests from another computer are let through: sharing the books on the
 * shop's network is for exactly that, and the PIN sign-in guards it.
 * /api/health stays open for the app's start-up check. With no key (npm run
 * dev, the tests, the browser preview) there is no gate at all.
 */

export const KEY_HEADER = "x-mandi-desktop";
export const DESKTOP_ONLY = "Open Mandi Mitra from its desktop icon.";

// read once, then removed, so nothing the server starts (the scanner, an installer) inherits it
const KEY = process.env.MANDI_DESKTOP === "1" ? (process.env.MANDI_DESKTOP_TOKEN ?? "") : "";
delete process.env.MANDI_DESKTOP_TOKEN;

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Mandi Mitra</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>html,body{height:100%;margin:0}body{display:flex;align-items:center;justify-content:center;background:#fbfaf7;color:#2a241f;
font:18px "Segoe UI","Nirmala UI",system-ui,sans-serif;text-align:center;padding:0 16px;box-sizing:border-box}
@media (prefers-color-scheme:dark){body{background:#16181b;color:#ece8e1}}</style></head>
<body><p>${DESKTOP_ONLY}</p></body></html>`;

const bare = (a: string) => a.trim().toLowerCase().replace(/^::ffff:/, "").replace(/%.*$/, "");

let own: { at: number; list: Set<string> } | null = null;
/** This computer's own addresses (refreshed every 10 s: a laptop changes Wi-Fi). */
function ownAddresses(): Set<string> {
  if (own && Date.now() - own.at < 10_000) return own.list;
  const list = new Set<string>();
  try {
    for (const addrs of Object.values(os.networkInterfaces())) for (const a of addrs ?? []) list.add(bare(a.address));
  } catch { /* loopback is still recognised */ }
  own = { at: Date.now(), list };
  return list;
}

/**
 * A request from this computer itself: loopback, or one of its own network
 * addresses (Chrome on this PC opening http://<its own IP>:8787 counts as here).
 * An unknown address (a call made inside the process) counts as here too.
 */
export function fromThisComputer(remote: string | undefined | null, addresses: Iterable<string> = ownAddresses()): boolean {
  if (!remote) return true;
  const a = bare(remote);
  if (a === "::1" || a.startsWith("127.")) return true;
  for (const o of addresses) if (bare(o) === a) return true;
  return false;
}

const sameKey = (got: string, want: string) => {
  const a = Buffer.from(got), b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

/** The gate, or null when the server is not running as the desktop app. */
export function desktopGate(key: string = KEY): MiddlewareHandler | null {
  if (!key) return null;
  return async (c, next) => {
    const got = c.req.header(KEY_HEADER);
    if (got && sameKey(got, key)) {
      await next();
      // tells the app that this is its own server, not another program on the same port
      if (c.req.path === "/api/health") { try { c.res.headers.set(KEY_HEADER, "ok"); } catch { /* read-only response */ } }
      return;
    }
    if (c.req.path === "/api/health") return next();
    const remote = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress;
    if (!fromThisComputer(remote)) return next();
    if (c.req.path.startsWith("/api/")) return c.json({ error: DESKTOP_ONLY, code: "desktop_only" }, 403);
    return c.html(PAGE, 403);
  };
}
