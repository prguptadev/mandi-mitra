import fs from "node:fs";
import path from "node:path";
import { DB_PATH } from "../db/client.ts";
import { encryptSecret, decryptSecret } from "./secrets.ts";

/*
 * The UP e-Mandi portal (emandi.up.gov.in), read from Mandi Mitra.
 *
 * What this does: keeps one signed-in session per business, so the day's
 * rate band for a commodity can be shown on the dashboard, and later the
 * issued 6R/9R/gate-pass lists can be read back and set against our own
 * books.
 *
 * What it does not do, by design: the portal shows a captcha at sign-in and
 * again on every 6R and gate pass. Nothing here solves, guesses or works
 * around it — the image is handed to the operator, who types it. A session
 * therefore starts with a person, and ends when the portal ends it.
 *
 * The two firms have separate portal logins, so everything here is keyed by
 * business. The password is kept encrypted in this computer's own data folder
 * (never in the database, so it never reaches the cloud or a backup that
 * leaves the machine), the same way the Supabase string is kept.
 *
 * See docs/emandi-portal-map.md for the endpoints and fields.
 */

const BASE = (process.env.MANDI_EMANDI_BASE ?? "https://emandi.up.gov.in").replace(/\/$/, "");
const CFG_PATH = () => path.join(path.dirname(DB_PATH), "emandi.json");

export interface PortalAccount {
  /** What the portal calls the user — an email or user name. */
  user: string;
  /** Encrypted with this computer's key; never returned to a screen. */
  enc: string | null;
  /** The trader licence, kept for the forms later. */
  licence: string;
  /** Portal crop codes the dashboard shows, e.g. ["1", "6"]. */
  watch: string[];
  updatedAt: string | null;
}
type Store = Record<string, PortalAccount>;

const blank = (): PortalAccount => ({ user: "", enc: null, licence: "", watch: ["1"], updatedAt: null });

function readStore(): Store {
  try { return JSON.parse(fs.readFileSync(CFG_PATH(), "utf8")) as Store; } catch { return {}; }
}
function writeStore(s: Store) {
  fs.mkdirSync(path.dirname(CFG_PATH()), { recursive: true });
  fs.writeFileSync(CFG_PATH(), JSON.stringify(s, null, 2));
}

export function accountOf(biz: string): PortalAccount {
  return { ...blank(), ...(readStore()[biz] ?? {}) };
}

/** Saves the login for one business. An empty password leaves the saved one alone. */
export function saveAccount(biz: string, p: { user?: string; password?: string; licence?: string; watch?: string[] }) {
  const s = readStore();
  const cur = { ...blank(), ...(s[biz] ?? {}) };
  s[biz] = {
    user: p.user ?? cur.user,
    enc: p.password ? encryptSecret(p.password) : cur.enc,
    licence: p.licence ?? cur.licence,
    watch: p.watch ?? cur.watch,
    updatedAt: new Date().toISOString(),
  };
  writeStore(s);
  sessions.delete(biz); // a changed login must not keep the old session
  return accountOf(biz);
}

export function forgetAccount(biz: string) {
  const s = readStore();
  delete s[biz];
  writeStore(s);
  sessions.delete(biz);
}

/* ------------------------------------------------------------ cookies */

/** A small cookie jar: the portal only needs its session and antiforgery cookies. */
class Jar {
  private jar = new Map<string, string>();
  take(res: Response) {
    // one header per cookie in Node's fetch; getSetCookie keeps them apart
    const list = typeof (res.headers as { getSetCookie?: () => string[] }).getSetCookie === "function"
      ? (res.headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
      : [res.headers.get("set-cookie")].filter(Boolean) as string[];
    for (const raw of list) {
      const [pair] = raw.split(";");
      const i = pair.indexOf("=");
      if (i > 0) this.jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }
  header() { return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "); }
  get size() { return this.jar.size; }
}

interface Session {
  jar: Jar;
  /** Set once a sign-in has gone through. */
  signedInAt: number | null;
  /** The last thing the portal said, for the screen. */
  note: string | null;
  /** Waiting for the operator to read the captcha. */
  pending: { token: string; captchaText: string; verification: string; at: number } | null;
  crops: { code: string; name: string }[] | null;
}
const sessions = new Map<string, Session>();
const sessionOf = (biz: string): Session => {
  let s = sessions.get(biz);
  if (!s) { s = { jar: new Jar(), signedInAt: null, note: null, pending: null, crops: null }; sessions.set(biz, s); }
  return s;
};

export class PortalError extends Error {
  constructor(message: string, public code = "portal") { super(message); }
}

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Safari/537.36";

async function call(biz: string, url: string, init: RequestInit = {}) {
  const s = sessionOf(biz);
  const res = await fetch(BASE + url, {
    ...init,
    redirect: "manual",
    headers: {
      "User-Agent": UA,
      ...(s.jar.size ? { cookie: s.jar.header() } : {}),
      ...(init.headers ?? {}),
    },
  }).catch((e) => { throw new PortalError(`The mandi portal did not answer (${String(e).slice(0, 80)})`, "offline"); });
  s.jar.take(res);
  return res;
}

const between = (html: string, re: RegExp) => re.exec(html)?.[1] ?? "";

/* ------------------------------------------------------------ signing in */

export interface CaptchaAsk {
  /** The captcha as a data: URL, to show the operator. */
  image: string;
  /** Hand this back with what they typed. */
  ticket: string;
}

/**
 * Step one of signing in: fetch the login page and its captcha.
 * The operator reads the image; nothing here tries to.
 */
export async function beginSignIn(biz: string): Promise<CaptchaAsk> {
  const acc = accountOf(biz);
  if (!acc.user || !acc.enc) throw new PortalError("Add the portal user name and password in Settings first", "no_account");
  const s = sessionOf(biz);
  s.signedInAt = null;
  const res = await call(biz, "/Account/index");
  if (res.status >= 400) throw new PortalError(`The portal's login page did not open (${res.status})`, "portal");
  const html = await res.text();
  const verification = between(html, /name="__RequestVerificationToken"[^>]*value="([^"]+)"/);
  const captchaText = between(html, /name="DNTCaptchaText"[^>]*value="([^"]+)"/);
  const token = between(html, /name="DNTCaptchaToken"[^>]*value="([^"]+)"/);
  const imgPath = between(html, /<img[^>]+src="(\/DNTCaptchaImage\/Show\?[^"]+)"/).replace(/&amp;/g, "&");
  if (!verification || !token || !imgPath) throw new PortalError("The portal's login page looks different than expected; tell support", "shape");

  const img = await call(biz, imgPath);
  const bytes = Buffer.from(await img.arrayBuffer());
  s.pending = { token, captchaText, verification, at: Date.now() };
  return { image: `data:${img.headers.get("content-type") ?? "image/png"};base64,${bytes.toString("base64")}`, ticket: token };
}

/** Step two: the operator's reading of the captcha, with the saved password. */
export async function finishSignIn(biz: string, typed: string): Promise<{ ok: true }> {
  const acc = accountOf(biz);
  const s = sessionOf(biz);
  if (!s.pending) throw new PortalError("Ask for the captcha again", "no_captcha");
  if (Date.now() - s.pending.at > 10 * 60_000) { s.pending = null; throw new PortalError("That captcha is stale — ask for a new one", "stale"); }
  const password = acc.enc ? decryptSecret(acc.enc) : null;
  if (!password) throw new PortalError("No password saved for this business", "no_account");

  const body = new URLSearchParams({
    Email: acc.user,
    Password: password,
    DNTCaptchaText: s.pending.captchaText,
    DNTCaptchaInputText: typed.trim(),
    DNTCaptchaToken: s.pending.token,
    __RequestVerificationToken: s.pending.verification,
  });
  const res = await call(biz, "/Account", {
    method: "POST", body,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  s.pending = null;

  // a good sign-in redirects to the trader dashboard; a bad one redraws the form
  const location = res.headers.get("location") ?? "";
  if (res.status >= 300 && res.status < 400 && /Dashboard|Traders/i.test(location)) {
    s.signedInAt = Date.now();
    s.note = null;
    return { ok: true };
  }
  const html = res.status === 200 ? await res.text() : "";
  const shown = between(html, /class="[^"]*(?:text-danger|validation-summary-errors)[^"]*"[^>]*>\s*(?:<[^>]+>\s*)*([^<]{4,160})/i).trim();
  s.note = shown || null;
  if (/captcha/i.test(html)) throw new PortalError(shown || "The captcha did not match — try again", "captcha");
  throw new PortalError(shown || "The portal did not accept that user name or password", "denied");
}

export function signOut(biz: string) { sessions.delete(biz); }

export function statusOf(biz: string) {
  const acc = accountOf(biz);
  const s = sessions.get(biz);
  return {
    configured: Boolean(acc.user && acc.enc),
    user: acc.user,
    licence: acc.licence,
    watch: acc.watch,
    signedIn: Boolean(s?.signedInAt),
    signedInAt: s?.signedInAt ? new Date(s.signedInAt).toISOString() : null,
    note: s?.note ?? null,
    base: BASE,
  };
}

/* ------------------------------------------------------------ reading */

/** True when the answer is the portal's login page rather than what we asked for. */
const looksSignedOut = (text: string) => /name="DNTCaptchaToken"/.test(text) || /\/Account\/index/.test(text.slice(0, 2000));

async function signedInCall(biz: string, url: string, init?: RequestInit) {
  const s = sessionOf(biz);
  if (!s.signedInAt) throw new PortalError("Sign in to the mandi portal first", "signed_out");
  const res = await call(biz, url, init);
  if (res.status >= 300 && res.status < 400) { s.signedInAt = null; throw new PortalError("The portal signed this computer out — sign in again", "signed_out"); }
  const text = await res.text();
  if (looksSignedOut(text)) { s.signedInAt = null; throw new PortalError("The portal signed this computer out — sign in again", "signed_out"); }
  return text;
}

export interface RateBand {
  cropCode: string;
  cropName: string | null;
  /** Rupees per quintal, as the portal states them. */
  minRatePaise: number | null;
  maxRatePaise: number | null;
  /** Percentages, e.g. 1.00 and 0.50. */
  mandiFeePct: number | null;
  developmentCessPct: number | null;
  at: string;
}

const toPaise = (n: unknown) => (n == null || n === "" ? null : Math.round(Number(n) * 100));

/** The band the portal allows for a commodity today, with its fee and cess. */
export async function rateBand(biz: string, cropCode: string): Promise<RateBand> {
  const text = await signedInCall(biz, "/Traders/get_crop_fees", {
    method: "POST",
    body: new URLSearchParams({ crop_code: cropCode }),
    headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest" },
  });
  let row: Record<string, unknown> | null = null;
  try { const j = JSON.parse(text); row = Array.isArray(j) ? j[0] ?? null : j; } catch { /* not json */ }
  if (!row) throw new PortalError("The portal did not give the rate for that commodity", "shape");
  const crops = await cropList(biz).catch(() => []);
  return {
    cropCode,
    cropName: crops.find((c) => c.code === cropCode)?.name ?? null,
    minRatePaise: toPaise(row.min_rate),
    maxRatePaise: toPaise(row.max_rate),
    mandiFeePct: row.mandi_fees == null ? null : Number(row.mandi_fees),
    developmentCessPct: row.development_cess == null ? null : Number(row.development_cess),
    at: new Date().toISOString(),
  };
}

/** The portal's own commodity list, read once per session from the 6R form. */
export async function cropList(biz: string): Promise<{ code: string; name: string }[]> {
  const s = sessionOf(biz);
  if (s.crops) return s.crops;
  const html = await signedInCall(biz, "/Traders/add_six_r");
  const select = /<select[^>]+id="crop_code"[\s\S]*?<\/select>/i.exec(html)?.[0] ?? "";
  const out: { code: string; name: string }[] = [];
  for (const m of select.matchAll(/<option[^>]+value="([^"]*)"[^>]*>([^<]*)<\/option>/g)) {
    const code = m[1].trim();
    const name = m[2].replace(/&nbsp;/g, " ").trim();
    if (code && name && !/चुने/.test(name)) out.push({ code, name });
  }
  if (!out.length) throw new PortalError("The portal's commodity list could not be read", "shape");
  s.crops = out;
  return out;
}
