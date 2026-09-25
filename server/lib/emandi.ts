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
  /** The portal's cookies from the last sign-in, encrypted. Not shown anywhere. */
  session?: string | null;
  /** Whose licence the portal says this login is — read from its own dashboard. */
  firm?: string | null;
  portalLicence?: string | null;
  /** The portal's commodity list, read once and kept so the choice can be made offline. */
  crops?: { code: string; name: string }[] | null;
  cropsAt?: string | null;
  updatedAt: string | null;
}
type Store = Record<string, PortalAccount>;

const blank = (): PortalAccount => ({ user: "", enc: null, licence: "", watch: ["1"], session: null,
  firm: null, portalLicence: null, crops: null, cropsAt: null, updatedAt: null });

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
  const loginChanged = Boolean(p.password) || (p.user !== undefined && p.user !== cur.user);
  s[biz] = {
    user: p.user ?? cur.user,
    enc: p.password ? encryptSecret(p.password) : cur.enc,
    licence: p.licence ?? cur.licence,
    watch: p.watch ?? cur.watch,
    session: loginChanged ? null : cur.session ?? null,
    // a changed login may be a different licence, so forget whose it was
    firm: loginChanged ? null : cur.firm ?? null,
    portalLicence: loginChanged ? null : cur.portalLicence ?? null,
    crops: cur.crops ?? null,
    cropsAt: cur.cropsAt ?? null,
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
  all() { return Object.fromEntries(this.jar); }
  restore(saved: Record<string, string>) { for (const [k, v] of Object.entries(saved ?? {})) this.jar.set(k, v); }
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
  /** Keeps a sliding portal session from lapsing while the app is open. */
  keepAlive: ReturnType<typeof setInterval> | null;
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
  if (!s) {
    s = { jar: new Jar(), keepAlive: null, signedInAt: null, note: null, pending: null, crops: null };
    /* An app restart — an update, a crash, a laptop lid — must not cost the
       operator another captcha. The portal's cookies are kept encrypted on
       this computer and put back; the first call proves whether they still
       work, and clears them if not. */
    const kept = readStore()[biz]?.session;
    if (kept) {
      try {
        const { cookies, at } = JSON.parse(decryptSecret(kept) ?? "{}") as { cookies: Record<string, string>; at: number };
        if (cookies && Date.now() - at < 12 * 60 * 60_000) { s.jar.restore(cookies); s.signedInAt = at; }
      } catch { /* unreadable: sign in again */ }
    }
    sessions.set(biz, s);
  }
  return s;
};

function keepSession(biz: string) {
  const st = readStore();
  const cur = st[biz];
  if (!cur) return;
  const s = sessions.get(biz);
  st[biz] = { ...cur, session: s?.signedInAt ? encryptSecret(JSON.stringify({ cookies: s.jar.all(), at: s.signedInAt })) : null };
  writeStore(st);
}

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

  /* A sign-in can come back as a redirect, or as a page, or as a page that
     redirects itself — so rather than guess from the shape, follow whatever
     it sends and then ask the portal for the trader dashboard. If that opens,
     we are in. Reading the answer this way also stops a login page (which
     always carries the word "captcha") being reported as a wrong captcha. */
  const location = res.headers.get("location") ?? "";
  if (res.status >= 300 && res.status < 400 && location) {
    await call(biz, location.startsWith("http") ? new URL(location).pathname + new URL(location).search : location);
  }
  const replyHtml = res.status === 200 ? await res.text() : "";

  const probe = await call(biz, "/Traders/Dashboard");
  const probeText = probe.status === 200 ? await probe.text() : "";
  const signedIn = probe.status === 200 && !looksSignedOut(probeText);
  if (signedIn) {
    const who = whoseLogin(probeText);
    const st = readStore();
    if (st[biz]) { st[biz] = { ...st[biz], ...who }; writeStore(st); }
  }
  /* One line in the log per attempt: what the portal answered, never what was
     sent. It is the only way to tell a wrong captcha from a changed page. */
  console.log(`[emandi] sign-in: post ${res.status}${location ? ` -> ${location}` : ""}`
    + ` | dashboard ${probe.status} ${probeText.length}b`
    + ` | login markers ${/DNTCaptchaToken/.test(probeText) ? "yes" : "no"}/${/Account\/index/i.test(probeText.slice(0, 2000)) ? "yes" : "no"}`
    + ` | signed in: ${signedIn}`);
  if (signedIn) {
    s.signedInAt = Date.now();
    s.note = null;
    keepSession(biz);
    startKeepAlive(biz);
    return { ok: true };
  }

  // not in: say what the portal itself said, and only call it a captcha when it is
  const shown = [
    /class="[^"]*(?:text-danger|validation-summary-errors|alert-danger)[^"]*"[^>]*>\s*(?:<[^>]+>\s*)*([^<]{4,200})/i,
    /<span[^>]+id="[^"]*(?:lblMsg|Message|Error)[^"]*"[^>]*>\s*([^<]{4,200})/i,
    /swal\(\s*["'`]([^"'`]{4,200})["'`]/i,
  ].map((re) => between(replyHtml, re).trim()).find(Boolean) ?? "";
  s.note = shown || null;
  if (/captcha|कैप्चा/i.test(shown)) throw new PortalError(shown, "captcha");
  if (shown) throw new PortalError(shown, "denied");
  throw new PortalError("The portal did not sign this computer in, and did not say why. Try the captcha again; if it keeps failing, sign in once on the portal in a browser to check the user name and password.", "denied");
}

/**
 * The portal ends a session that sits idle. A small read every few minutes
 * keeps it alive for as long as the app is open — the same effect as leaving
 * the portal open in a browser tab. It stops itself the moment the portal
 * says no, and the operator is told to sign in again rather than left with
 * rates that quietly stop refreshing.
 */
const KEEP_ALIVE_MS = 8 * 60_000;
/* The portal greets a trader by firm on its dashboard and carries the licence
   in a hidden field. Which licence a login belongs to decides what it can see
   — a mill's licence carries no rate band, an arhat's does — so it is worth
   showing plainly instead of leaving it to be guessed. */
function whoseLogin(dashboard: string) {
  const firm = /Welcome,\s*([^<\n]{2,80})/.exec(dashboard)?.[1]?.trim() ?? null;
  const licence = /<input[^>]*id="MerchantLicense"[^>]*>/.exec(dashboard)?.[0];
  return { firm: firm || null, portalLicence: licence ? /value="([^"]*)"/.exec(licence)?.[1] ?? null : null };
}

function startKeepAlive(biz: string) {
  const s = sessionOf(biz);
  if (s.keepAlive) clearInterval(s.keepAlive);
  s.keepAlive = setInterval(() => {
    void (async () => {
      const live = sessions.get(biz);
      if (!live?.signedInAt) return stopKeepAlive(biz);
      try {
        const res = await call(biz, "/Traders/Dashboard");
        const text = res.status === 200 ? await res.text() : "";
        if (res.status !== 200 || looksSignedOut(text)) {
          live.signedInAt = null;
          live.note = "The portal ended this session. Sign in again to see the rates.";
          keepSession(biz);
          stopKeepAlive(biz);
          return;
        }
        // a session kept from before this was recorded fills itself in here
        const acc = accountOf(biz);
        if (!acc.firm) {
          const st = readStore();
          if (st[biz]) { st[biz] = { ...st[biz], ...whoseLogin(text) }; writeStore(st); }
        }
      } catch { /* no internet just now; the next round tries again */ }
    })();
  }, KEEP_ALIVE_MS);
  s.keepAlive.unref?.();
}
function stopKeepAlive(biz: string) {
  const s = sessions.get(biz);
  if (s?.keepAlive) { clearInterval(s.keepAlive); s.keepAlive = null; }
}

export function signOut(biz: string) {
  stopKeepAlive(biz);
  sessions.delete(biz);
  const st = readStore();
  if (st[biz]) { st[biz] = { ...st[biz], session: null }; writeStore(st); }
}

export function statusOf(biz: string) {
  const acc = accountOf(biz);
  const s = sessionOf(biz); // brings a kept session back after a restart
  return {
    configured: Boolean(acc.user && acc.enc),
    user: acc.user,
    licence: acc.licence,
    watch: acc.watch,
    firm: acc.firm ?? null,
    portalLicence: acc.portalLicence ?? null,
    signedIn: Boolean(s?.signedInAt),
    signedInAt: s?.signedInAt ? new Date(s.signedInAt).toISOString() : null,
    note: s?.note ?? null,
    base: BASE,
  };
}

/* ------------------------------------------------------------ reading */

/**
 * True when the answer is the portal's login page rather than what we asked
 * for. It has to be the login FORM, not merely a captcha: the 6R and gate-pass
 * pages carry a captcha of their own, and reading one as "signed out" throws
 * away a perfectly good session.
 */
const looksSignedOut = (text: string) =>
  /name="Password"/i.test(text) && /action="\/Account"/i.test(text);

async function signedInCall(biz: string, url: string, init?: RequestInit) {
  const s = sessionOf(biz);
  if (!s.signedInAt) throw new PortalError("Sign in to the mandi portal first", "signed_out");
  const res = await call(biz, url, init);
  const ended = () => {
    s.signedInAt = null;
    keepSession(biz);
    s.note = "The portal ended this session. Sign in again to see the rates.";
    stopKeepAlive(biz);
    return new PortalError("The portal ended this session — sign in again", "signed_out");
  };
  if (res.status >= 300 && res.status < 400) throw ended();
  const text = await res.text();
  if (looksSignedOut(text)) throw ended();
  return text;
}

/* The portal writes Hindi as HTML escapes (&#x927;…), so an option's text is
   not the commodity's name until it is turned back into letters. */
const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export function unescapeHtml(text: string) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    return NAMED[body.toLowerCase()] ?? whole;
  });
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
  /** The portal's own flags: whether this licence sits on a mandi sthal, and whether it is a direct licence. */
  onMandiSthal: boolean | null;
  directLicence: boolean | null;
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
  if (process.env.MANDI_EMANDI_DEBUG) console.log(`[emandi] crop_fees ${cropCode}: ${text.slice(0, 400)}`);
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
    onMandiSthal: row.isupmandisthal == null ? null : Boolean(Number(row.isupmandisthal)),
    directLicence: row.isDirectlicense == null ? null : Boolean(Number(row.isDirectlicense)),
    at: new Date().toISOString(),
  };
}

/** The commodity list as last read, without touching the portal. */
export function keptCrops(biz: string) {
  const acc = accountOf(biz);
  const crops = (acc.crops ?? []).map((c) => ({ code: c.code, name: unescapeHtml(c.name).trim() }));
  return { crops, at: acc.cropsAt ?? null };
}

/**
 * The portal's own commodity list. Read once from the 6R form and kept on this
 * computer, so the choice of what to watch can be made whether or not anyone
 * is signed in; `force` reads it again.
 */
export async function cropList(biz: string, force = false): Promise<{ code: string; name: string }[]> {
  const s = sessionOf(biz);
  if (!force) {
    if (s.crops) return s.crops;
    const kept = keptCrops(biz);
    if (kept.crops.length) { s.crops = kept.crops; return kept.crops; }
  }
  const html = await signedInCall(biz, "/Traders/add_six_r");
  const select = /<select[^>]+id="crop_code"[\s\S]*?<\/select>/i.exec(html)?.[0] ?? "";
  const out: { code: string; name: string }[] = [];
  for (const m of select.matchAll(/<option[^>]+value="([^"]*)"[^>]*>([^<]*)<\/option>/g)) {
    const code = m[1].trim();
    const name = unescapeHtml(m[2]).trim();
    if (code && name && !/चुने/.test(name)) out.push({ code, name });
  }
  if (!out.length) throw new PortalError("The portal's commodity list could not be read", "shape");
  s.crops = out;
  const st = readStore();
  if (st[biz]) { st[biz] = { ...st[biz], crops: out, cropsAt: new Date().toISOString() }; writeStore(st); }
  return out;
}
