import fs from "node:fs";
import path from "node:path";
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
 * See docs/emandi-portal-map.md for the endpoints and fields, and its §10 for
 * how a session is kept, checked and ended.
 */

const BASE = (process.env.MANDI_EMANDI_BASE ?? "https://emandi.up.gov.in").replace(/\/$/, "");
/* The data folder, found the way the database and the secret key find it —
   without opening the database, which this file never needs. */
const DATA_DIR = process.env.MANDI_DATA_DIR ?? path.resolve(process.cwd(), "data");
const CFG_PATH = () => path.join(DATA_DIR, "emandi.json");
/* No portal call may hold a screen for ever: a site that takes the connection
   and then says nothing would otherwise keep the dashboard on "Loading…" for
   minutes. */
const TIMEOUT_MS = Number(process.env.MANDI_EMANDI_TIMEOUT_MS ?? 15_000);

/* ------------------------------------------------------------ messages */

/*
 * Every message about the portal goes out as a code that does not change; the
 * screen says it in the chosen language (strings: portal.err.<code>). The
 * English here is for the log and for anything reading the API directly.
 */
export const SAY: Record<string, string> = {
  no_account: "Add this firm's e-Mandi user name and password in Settings first",
  password_unreadable: "The saved e-Mandi password cannot be read on this computer — type it again in Settings",
  signed_out: "Sign in to e-Mandi first",
  ended: "e-Mandi ended this session — sign in again",
  offline: "e-Mandi did not answer — check the internet and try again",
  slow: "e-Mandi took too long to answer — try again in a minute",
  portal_error: "e-Mandi's site had trouble just now — try again in a few minutes",
  shape: "e-Mandi's page looked different than expected — tell support",
  rate_shape: "e-Mandi's answer for this commodity had no rate in it",
  stock_shape: "e-Mandi's stock register could not be read",
  crops_shape: "e-Mandi's commodity list could not be read",
  no_licence: "This login's licence could not be read from e-Mandi, so its stock was not asked for",
  other_licence: "This e-Mandi login is for a different licence than this firm's",
  no_captcha: "Ask for a captcha first",
  stale: "That captcha is too old — type the new one",
  replaced: "That captcha was replaced by a newer one — type the one shown now",
  captcha: "The captcha did not match — type the new one",
  credentials: "e-Mandi says the user name or password is wrong — check them in Settings",
  denied: "e-Mandi did not sign this computer in",
  not_captcha: "No captcha address in that",
  no_picture: "e-Mandi did not give back a picture — sign in to e-Mandi first",
  store_busy: "The e-Mandi login file on this computer could not be read just now — try again",
};

export class PortalError extends Error {
  /** `said` is the portal's own words, kept as they came, when it gave any. */
  constructor(public code: string, public said: string | null = null) {
    super(SAY[code] ?? code);
  }
}

/* ------------------------------------------------------------ the login file */

export interface PortalAccount {
  /** What the portal calls the user — an email or user name. */
  user: string;
  /** Encrypted with this computer's key; never returned to a screen. */
  enc: string | null;
  /** Portal crop codes the dashboard shows, e.g. ["1", "6"]. */
  watch: string[];
  /** The portal's cookies from the last good look, encrypted. Not shown anywhere. */
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

const blank = (): PortalAccount => ({ user: "", enc: null, watch: ["1"], session: null,
  firm: null, portalLicence: null, crops: null, cropsAt: null, updatedAt: null });

/* What happened the last time the file was found damaged, for the screen. It
   stays until a login is saved again. */
let storeTrouble: "store_restored" | "store_lost" | null = null;

const parseStore = (text: string): Store | null => {
  try {
    const j = JSON.parse(text) as unknown;
    if (!j || typeof j !== "object" || Array.isArray(j)) return null;
    return Object.values(j).every((v) => v && typeof v === "object" && !Array.isArray(v)) ? j as Store : null;
  } catch { return null; }
};

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");

/* The file is written whole to a side file and then put in place, so a power
   cut leaves either the old file or the new one — never half of one. The one
   before is kept as emandi.json.prev. */
function writeAtomic(file: string, s: Store) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, "w");
  try { fs.writeSync(fd, JSON.stringify(s, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (fs.existsSync(file)) { try { fs.copyFileSync(file, `${file}.prev`); } catch { /* the copy is a spare; the write still goes ahead */ } }
  fs.renameSync(tmp, file);
}

/**
 * The logins on this computer. A file that cannot be read as JSON is never
 * taken for "no logins" and written over: it is moved aside whole, as
 * emandi.json.bad-<when>, and the copy kept from the write before is used.
 */
function readStore(): Store {
  const file = CFG_PATH();
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    // locked by something else just now (an antivirus scan): say so, and write nothing
    throw new PortalError("store_busy");
  }
  const s = parseStore(text);
  if (s) return s;

  const aside = `${file}.bad-${stamp()}`;
  try { fs.renameSync(file, aside); } catch { throw new PortalError("store_busy"); }
  let prev: Store | null = null;
  try { prev = parseStore(fs.readFileSync(`${file}.prev`, "utf8")); } catch { /* no spare copy */ }
  console.warn(`[emandi] emandi.json could not be read; kept as ${path.basename(aside)}`
    + (prev ? ", and the copy from the write before was put back" : ", and there was no earlier copy"));
  storeTrouble = prev ? "store_restored" : "store_lost";
  if (prev) writeAtomic(file, prev);
  return prev ?? {};
}
function writeStore(s: Store) { writeAtomic(CFG_PATH(), s); }

export function accountOf(biz: string): PortalAccount {
  return { ...blank(), ...(readStore()[biz] ?? {}) };
}

const readablePassword = (acc: PortalAccount) => (acc.enc ? decryptSecret(acc.enc) : null);

/**
 * Saves the login for one business. An empty password leaves the saved one
 * alone. Only a changed user name or password ends the portal session — the
 * choice of commodities has nothing to do with it.
 */
export function saveAccount(biz: string, p: { user?: string; password?: string; watch?: string[] }) {
  const s = readStore();
  const cur = { ...blank(), ...(s[biz] ?? {}) };
  const userChanged = p.user !== undefined && p.user !== cur.user;
  const loginChanged = Boolean(p.password) || userChanged;
  s[biz] = {
    user: p.user ?? cur.user,
    /* A password belongs to the user name it was typed with. Put a different
       user name in and the old password is not that user's — keeping it would
       leave a login that looks saved and cannot sign in. */
    enc: p.password ? encryptSecret(p.password) : userChanged ? null : cur.enc,
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
  storeTrouble = null;
  if (loginChanged) dropSession(biz); // a changed login must not keep the old session
  return accountOf(biz);
}

export function forgetAccount(biz: string) {
  const s = readStore();
  delete s[biz];
  writeStore(s);
  dropSession(biz);
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
  /** The user name this session was signed in as, so it can be told apart. */
  user: string | null;
  /** The last page opened, so the next call can say where it came from. */
  lastUrl: string | null;
  /** Keeps a sliding portal session from lapsing while the app is open. */
  keepAlive: ReturnType<typeof setInterval> | null;
  /** Set once a sign-in has gone through. */
  signedInAt: number | null;
  /** The last time e-Mandi showed us a signed-in page: "alive" is counted from here. */
  okAt: number | null;
  /** When /Traders/index was last opened in this session (docs §9). */
  landedAt: number | null;
  /** Put back from the kept cookies after a restart, and not yet shown to work. */
  unproven: boolean;
  /** A look at the portal under way, so calls that arrive together share it. */
  looking: Promise<"alive" | "ended"> | null;
  /** When a look was last tried, worked or not — so a failing portal is not asked every second. */
  triedAt: number | null;
  /** What the screen should be told about the session, as a code (see SAY). */
  noteCode: string | null;
  /** Why the last sign-in was refused, with e-Mandi's own words. */
  refused: { code: string; said: string | null } | null;
  /** Waiting for the operator to read the captcha. */
  pending: { token: string; captchaText: string; verification: string; at: number } | null;
  crops: { code: string; name: string }[] | null;
  /** Which commodities a re-landing last confirmed really are 0.00, and when. */
  bandless: { codes: string; at: number } | null;
}
const sessions = new Map<string, Session>();

/* A look every few minutes keeps the portal's session alive, the same as a
   browser tab left open. A session not seen working for longer than this —
   the laptop lid was shut, the app was closed — is looked at again (opening
   /Traders/index) before anything is read from it. */
const KEEP_ALIVE_MS = 8 * 60_000;
const IDLE_MS = KEEP_ALIVE_MS + 2 * 60_000;
/* A kept session older than this is not even tried: the portal will long have
   ended it. Counted from the last time it was seen working, not from sign-in. */
const KEPT_FOR_MS = 12 * 60 * 60_000;

const sessionOf = (biz: string): Session => {
  let s = sessions.get(biz);
  if (!s) {
    s = { jar: new Jar(), user: null, lastUrl: null, keepAlive: null, signedInAt: null, okAt: null, landedAt: null,
      unproven: false, looking: null, triedAt: null, noteCode: null, refused: null, pending: null, crops: null, bandless: null };
    /* An app restart — an update, a crash, a laptop lid — must not cost the
       operator another captcha. The portal's cookies are kept encrypted on
       this computer and put back. They are not trusted until a look at the
       portal has shown they still work (see check()). */
    const kept = readStore()[biz]?.session;
    if (kept) {
      try {
        const { cookies, at, ok } = JSON.parse(decryptSecret(kept) ?? "{}") as { cookies: Record<string, string>; at: number; ok?: number };
        if (cookies && at && Date.now() - (ok ?? at) < KEPT_FOR_MS) {
          s.jar.restore(cookies);
          s.signedInAt = at;
          s.okAt = ok ?? at;
          s.unproven = true;
          s.user = accountOf(biz).user;
        }
      } catch { /* unreadable: sign in again */ }
    }
    sessions.set(biz, s);
  }
  /* The store can change underneath us — an update, a restore, a folder copied
     from another computer, a hand edit. A session belongs to the user name it
     was signed in as; if that is no longer the saved one, it is not this
     account's session and must not be reported as one. */
  if (s.signedInAt && s.user !== accountOf(biz).user) {
    s.signedInAt = null;
    s.user = null;
    s.jar = new Jar();
    s.crops = null;
    s.unproven = false;
    stopKeepAlive(biz);
  }
  return s;
};

/** Forget this business's session in memory, and stop its keep-alive with it. */
function dropSession(biz: string) {
  stopKeepAlive(biz);
  sessions.delete(biz);
}

/** Keep the jar on disk as it is now, so a restart picks up the latest cookies. */
function keepSession(biz: string) {
  const st = readStore();
  const cur = st[biz];
  if (!cur) return;
  const s = sessions.get(biz);
  st[biz] = { ...cur, session: s?.signedInAt
    ? encryptSecret(JSON.stringify({ cookies: s.jar.all(), at: s.signedInAt, ok: s.okAt ?? s.signedInAt }))
    : null };
  writeStore(st);
}

/** The portal has ended the session: say so at once, everywhere. */
function endSession(biz: string) {
  const s = sessionOf(biz);
  s.signedInAt = null;
  s.okAt = null;
  s.landedAt = null;
  s.unproven = false;
  s.noteCode = "ended";
  stopKeepAlive(biz);
  keepSession(biz);
  return new PortalError("ended");
}

/* ------------------------------------------------------------ calling the portal */

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const CH_UA = '"Google Chrome";v="140", "Not_A Brand";v="8", "Chromium";v="140"';
const LANG = "en-US,en;q=0.9,hi;q=0.8";

/*
 * e-Mandi is an ASP.NET site that keeps a good deal of state in its own
 * session, and we have already been bitten once by asking for a page in a way
 * a browser never would: the rate band came back 0.00 for a week of work
 * because the session was half set up. So every call is made the way the site
 * itself makes it — a page is fetched the way a browser fetches a page, an
 * image the way a browser fetches an image, and one of its own XHR calls is
 * sent the way its jQuery sends one, with the same Accept, Origin, Referer and
 * Sec-Fetch headers, and no header that only a page navigation carries.
 *
 * This is for compatibility, not for hiding: the captcha is still read and
 * typed by a person at sign-in, we ask only for what is ours, and nothing is
 * ever posted to e-Mandi except the login itself.
 */
type Kind = "page" | "xhr" | "image";
const headersFor = (kind: Kind, referer: string | null): Record<string, string> => {
  const site = referer ? "same-origin" : "none";
  const ref: Record<string, string> = referer ? { Referer: BASE + referer } : {};
  if (kind === "xhr") return {
    Accept: "*/*", "Accept-Language": LANG, "X-Requested-With": "XMLHttpRequest",
    "Cache-Control": "no-cache", Pragma: "no-cache", Origin: BASE, ...ref,
    "Sec-Fetch-Dest": "empty", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Site": "same-origin",
  };
  if (kind === "image") return {
    Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8", "Accept-Language": LANG, ...ref,
    "Sec-Fetch-Dest": "image", "Sec-Fetch-Mode": "no-cors", "Sec-Fetch-Site": site,
  };
  return {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": LANG, "Upgrade-Insecure-Requests": "1", ...ref,
    "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": site, "Sec-Fetch-User": "?1",
  };
};

interface Reply { status: number; location: string | null; type: string; text: string; bytes: Buffer }

/**
 * One request to the portal, its whole answer read inside the time limit.
 * Only a page becomes "where we were" for the next Referer — an image or an
 * XHR call is not somewhere a browser has been.
 */
async function call(biz: string, url: string, opts: { kind?: Kind; referer?: string | null; body?: URLSearchParams } = {}): Promise<Reply> {
  const s = sessionOf(biz);
  const kind = opts.kind ?? "page";
  let res: Response;
  let bytes: Buffer;
  try {
    res = await fetch(BASE + url, {
      method: opts.body ? "POST" : "GET",
      body: opts.body,
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        "User-Agent": UA,
        "sec-ch-ua": CH_UA, "sec-ch-ua-mobile": "?0", "sec-ch-ua-platform": '"Windows"',
        ...headersFor(kind, opts.referer === undefined ? s.lastUrl : opts.referer),
        ...(opts.body ? { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" } : {}),
        ...(s.jar.size ? { cookie: s.jar.header() } : {}),
      },
    });
    bytes = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    const name = (e as { name?: string } | null)?.name;
    const slow = name === "TimeoutError" || name === "AbortError";
    console.log(`[emandi] ${url}: ${slow ? `no answer in ${TIMEOUT_MS / 1000} s` : String(e).slice(0, 120)}`);
    throw new PortalError(slow ? "slow" : "offline");
  }
  s.jar.take(res);
  if (kind === "page") s.lastUrl = url;
  return { status: res.status, location: res.headers.get("location"), type: res.headers.get("content-type") ?? "",
    text: bytes.toString("utf8"), bytes };
}

const pathOf = (loc: string) => (/^https?:/i.test(loc) ? new URL(loc).pathname + new URL(loc).search : loc);
const isLoginPath = (p: string) => /^\/Account(\/|$|\?)/i.test(p);

/**
 * True when the answer is the portal's login page rather than what we asked
 * for. It has to be the login FORM, not merely a captcha: the 6R and gate-pass
 * pages carry a captcha of their own, and reading one as "signed out" throws
 * away a perfectly good session.
 */
const looksSignedOut = (text: string) =>
  /name="Password"/i.test(text) && /action="\/Account"/i.test(text);

/**
 * Open a page the way a browser does: a redirect is ordinary on this site
 * (/Traders/index answers 302), so follow it with a GET, keeping the Referer
 * the navigation started with. Being sent to /Account means signed out.
 */
async function openPage(biz: string, url: string): Promise<{ reply: Reply; at: string; toLogin: boolean }> {
  const referer = sessionOf(biz).lastUrl;
  let at = url;
  let reply = await call(biz, url, { kind: "page", referer });
  for (let hop = 0; hop < 4 && reply.status >= 300 && reply.status < 400 && reply.location; hop++) {
    const to = pathOf(reply.location);
    if (isLoginPath(to)) return { reply, at: to, toLogin: true };
    at = to;
    reply = await call(biz, to, { kind: "page", referer });
  }
  return { reply, at, toLogin: false };
}

const between = (html: string, re: RegExp) => re.exec(html)?.[1] ?? "";

/* ------------------------------------------------------------ keeping a session */

/* The portal greets a trader by firm on its dashboard and carries the licence
   in a hidden field. Which licence a login belongs to decides what it can see
   — a mill's licence carries no rate band, an arhat's does — so it is worth
   showing plainly instead of leaving it to be guessed. */
function whoseLogin(dashboard: string) {
  /* The portal writes it as `Welcome,</h2> <h3 class="prev_data"> VIJAY LAXMI
     DALL MILL </h3>`, so the name is past the next tags, not right after the
     word. Skip whatever tags and spaces follow, then take up to the next tag. */
  const at = dashboard.indexOf("Welcome,");
  const after = at < 0 ? "" : dashboard.slice(at + 8).replace(/^(\s|<[^>]*>)+/, "");
  const firm = unescapeHtml(after.split("<")[0]).replace(/\s+/g, " ").trim().slice(0, 80);
  const licence = /<input[^>]*id="MerchantLicense"[^>]*>/.exec(dashboard)?.[0];
  return { firm: firm || null, portalLicence: licence ? /value="([^"]*)"/.exec(licence)?.[1] ?? null : null };
}

/**
 * Open /Traders/index, as a browser does after login, and read the dashboard
 * it sends us on to. This is the page e-Mandi needs opened before it gives a
 * rate band (docs §9), so it is also how a session put back after a restart,
 * or left idle, is made whole again.
 *
 * Only being sent to the login page ends the session. A 5xx, a page that is
 * not there, or no answer at all says nothing about the session: it is left
 * as it is, and the next round tries again.
 */
async function land(biz: string): Promise<"alive" | "ended"> {
  const s = sessionOf(biz);
  s.triedAt = Date.now();
  const { reply, at, toLogin } = await openPage(biz, "/Traders/index");
  // the login was changed or removed while we looked: that session is gone already
  if (sessions.get(biz) !== s) return "ended";
  if (toLogin || looksSignedOut(reply.text)) { endSession(biz); return "ended"; }
  if (reply.status !== 200) {
    console.log(`[emandi] look: /Traders/index answered ${reply.status} — the session is left as it is`);
    throw new PortalError("portal_error", `HTTP ${reply.status}`);
  }
  s.okAt = s.landedAt = Date.now();
  s.unproven = false;
  s.noteCode = null;
  // a session kept from before the licence was recorded fills itself in here
  const who = /Dashboard/i.test(at) && !accountOf(biz).firm ? whoseLogin(reply.text) : null;
  if (who?.firm) {
    const st = readStore();
    if (st[biz]) { st[biz] = { ...st[biz], ...who }; writeStore(st); }
  }
  keepSession(biz); // the file follows the jar, so a restart has the latest cookies
  if (!s.keepAlive) startKeepAlive(biz);
  return "alive";
}

/** One look at a time per business; calls that arrive together share it. */
function look(biz: string): Promise<"alive" | "ended"> {
  const s = sessionOf(biz);
  if (!s.signedInAt) return Promise.resolve("ended");
  if (!s.looking) s.looking = land(biz).finally(() => { s.looking = null; });
  return s.looking;
}

function startKeepAlive(biz: string) {
  const s = sessionOf(biz);
  if (s.keepAlive) clearInterval(s.keepAlive);
  s.keepAlive = setInterval(() => {
    if (!sessions.get(biz)?.signedInAt) return stopKeepAlive(biz);
    look(biz).catch(() => { /* no answer, or a bad one: the session stays; the next round tries again */ });
  }, KEEP_ALIVE_MS);
  s.keepAlive.unref?.();
}
function stopKeepAlive(biz: string) {
  const s = sessions.get(biz);
  if (s?.keepAlive) { clearInterval(s.keepAlive); s.keepAlive = null; }
}

/**
 * Called by the status screen: a session put back after a restart, or one the
 * keep-alive has not seen working for a while (a laptop lid shut stops it),
 * is looked at now, so the screen never says "signed in" about a session the
 * portal has already ended. At most once a minute while the portal is not
 * answering.
 */
export async function check(biz: string, force = false) {
  const s = sessionOf(biz);
  if (!s.signedInAt) return;
  const due = force || s.unproven || Date.now() - (s.okAt ?? 0) > IDLE_MS;
  if (!due) return;
  if (!force && !s.looking && s.triedAt && Date.now() - s.triedAt < 60_000) return;
  try { await look(biz); } catch (e) {
    // this does not end the session — but the screen should know nobody could check it
    s.noteCode = e instanceof PortalError ? e.code : "offline";
    throw e;
  }
}

/** Every kept session on this computer, looked at once when the app starts. */
export async function checkKeptSessions() {
  let st: Store;
  try { st = readStore(); } catch { return; }
  for (const biz of Object.keys(st)) {
    if (!st[biz]?.session) continue;
    await check(biz).catch(() => { /* not answering: the dashboard will try again */ });
  }
}

/**
 * Before anything is read: a session put back after a restart, or one left
 * idle, is landed on /Traders/index first — e-Mandi gives a 0.00 band to a
 * session that has not been there — and that look is also what tells us the
 * session is still alive.
 */
async function freshSession(biz: string): Promise<{ landedNow: boolean }> {
  const s = sessionOf(biz);
  if (!s.signedInAt) throw new PortalError(s.noteCode === "ended" ? "ended" : "signed_out");
  const due = s.unproven || !s.landedAt || Date.now() - (s.okAt ?? 0) > IDLE_MS;
  if (!due) return { landedNow: false };
  if ((await look(biz)) === "ended") throw new PortalError("ended");
  return { landedNow: true };
}

async function signedInCall(biz: string, url: string, opts: { kind?: Kind; referer?: string; body?: URLSearchParams } = {}) {
  const s = sessionOf(biz);
  if (!s.signedInAt) throw new PortalError(s.noteCode === "ended" ? "ended" : "signed_out");
  let res = await call(biz, url, opts);
  /* A redirect is an ordinary thing on this site — /Traders/index answers 302
     and sends a trader on to the dashboard. Only being sent back to the login
     page means the session has ended. */
  for (let hop = 0; hop < 4 && res.status >= 300 && res.status < 400; hop++) {
    if (!res.location) break;
    const to = pathOf(res.location);
    if (isLoginPath(to)) throw endSession(biz);
    res = await call(biz, to); // a browser follows a 302 with a GET
  }
  if (res.status >= 300 && res.status < 400) throw endSession(biz);
  if (looksSignedOut(res.text)) throw endSession(biz);
  // a 5xx or a missing page is the portal's trouble, not a sign-out and not data
  if (res.status !== 200) throw new PortalError("portal_error", `HTTP ${res.status}`);
  s.okAt = Date.now();
  return res.text;
}

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
 *
 * Asking for a captcha does not end a session that is working: a second
 * screen with an old "Sign in" button must not sign everyone out. If the
 * session is alive, that is the answer, and no captcha is needed.
 */
export async function beginSignIn(biz: string): Promise<CaptchaAsk | { already: true }> {
  const acc = accountOf(biz);
  if (!acc.user || !acc.enc) throw new PortalError("no_account");
  if (!readablePassword(acc)) throw new PortalError("password_unreadable");
  const s = sessionOf(biz);
  if (s.signedInAt) {
    const alive = await look(biz).catch((e: unknown) => {
      // a portal in trouble may still show its login page; no answer at all will not
      if (e instanceof PortalError && (e.code === "offline" || e.code === "slow")) throw e;
      return "unknown" as const;
    });
    if (alive === "alive") return { already: true };
  }

  const page = await call(biz, "/Account/index", { kind: "page" });
  if (page.status !== 200) throw new PortalError("portal_error", `HTTP ${page.status}`);
  const html = page.text;
  const verification = between(html, /name="__RequestVerificationToken"[^>]*value="([^"]+)"/);
  const captchaText = between(html, /name="DNTCaptchaText"[^>]*value="([^"]+)"/);
  const token = between(html, /name="DNTCaptchaToken"[^>]*value="([^"]+)"/);
  const imgPath = between(html, /<img[^>]+src="(\/DNTCaptchaImage\/Show\?[^"]+)"/).replace(/&amp;/g, "&");
  if (!verification || !token || !imgPath) throw new PortalError("shape");

  // the picture is an image on the login page, asked for the way the page asks for it
  const img = await call(biz, imgPath, { kind: "image", referer: "/Account/index" });
  if (img.status !== 200 || !img.type.startsWith("image/")) throw new PortalError("shape", `HTTP ${img.status} ${img.type}`);
  s.pending = { token, captchaText, verification, at: Date.now() };
  return { image: `data:${img.type};base64,${img.bytes.toString("base64")}`, ticket: token };
}

/* The login page posts itself over ajax and its own script reads the reply as
   JSON ({succeeded, role}); an older form answered with a page. Read either,
   and keep what the portal said in its own words — any text under a key that
   carries a message, however deep ({errors: {DNTCaptchaInputText: ["…"]}}). */
const SAID_KEYS = /^(message|messages|msg|error|errors|errormessage|description|title|text)$/i;
function words(v: unknown, under = false, out: string[] = []): string[] {
  if (typeof v === "string") { if (under && v.trim()) out.push(v.trim()); return out; }
  if (Array.isArray(v)) { for (const x of v) words(x, under, out); return out; }
  if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) words(x, under || SAID_KEYS.test(k), out);
  return out;
}
function loginReply(text: string): { succeeded: boolean | null; said: string } {
  const clean = (s: string) => unescapeHtml(s).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    if (j && typeof j === "object") {
      const ok = j.succeeded ?? j.Succeeded ?? j.success ?? j.status;
      return { succeeded: typeof ok === "boolean" ? ok : null, said: clean(words(j).join("; ")) };
    }
  } catch { /* a page, not JSON */ }
  const shown = [
    /class="[^"]*(?:text-danger|validation-summary-errors|alert-danger)[^"]*"[^>]*>\s*(?:<[^>]+>\s*)*([^<]{4,200})/i,
    /<span[^>]+id="[^"]*(?:lblMsg|Message|Error)[^"]*"[^>]*>\s*([^<]{4,200})/i,
    /swal\(\s*["'`]([^"'`]{4,200})["'`]/i,
  ].map((re) => between(text, re).trim()).find(Boolean) ?? "";
  return { succeeded: null, said: clean(shown) };
}
/** A refusal, named for what it is: only a captcha is called a captcha. */
function refusal(said: string): PortalError {
  if (/captcha|कैप्चा|security code/i.test(said)) return new PortalError("captcha", said);
  if (/password|पासवर्ड|user ?name|username|यूज़र|यूजर|उपयोगकर्ता|invalid login|login attempt/i.test(said)) return new PortalError("credentials", said);
  return new PortalError("denied", said || null);
}

/** Step two: the operator's reading of the captcha, with the saved password. */
export async function finishSignIn(biz: string, typed: string, ticket?: string): Promise<{ ok: true }> {
  const acc = accountOf(biz);
  const s = sessionOf(biz);
  if (!s.pending) throw new PortalError("no_captcha");
  // a newer captcha was asked for (another screen, the round-arrow): this one is dead
  if (ticket && ticket !== s.pending.token) throw new PortalError("replaced");
  if (Date.now() - s.pending.at > 10 * 60_000) { s.pending = null; throw new PortalError("stale"); }
  const password = readablePassword(acc);
  if (!password) throw new PortalError(acc.enc ? "password_unreadable" : "no_account");

  const pending = s.pending;
  s.pending = null; // the portal takes a captcha once; whatever happens, the next try needs a new one
  const body = new URLSearchParams({
    Email: acc.user,
    Password: password,
    DNTCaptchaText: pending.captchaText,
    DNTCaptchaInputText: typed.trim(),
    DNTCaptchaToken: pending.token,
    __RequestVerificationToken: pending.verification,
  });
  // posting a login replaces whatever session there was
  stopKeepAlive(biz);
  s.signedInAt = s.okAt = s.landedAt = null;
  s.unproven = false;
  s.refused = null;
  const res = await call(biz, "/Account", { kind: "xhr", referer: "/Account/index", body });
  if (res.status >= 500) throw new PortalError("portal_error", `HTTP ${res.status}`);
  const answer = loginReply(res.status === 200 ? res.text : "");
  if (answer.succeeded === false) {
    const why = refusal(answer.said);
    s.refused = { code: why.code, said: why.said };
    console.log(`[emandi] sign-in: post ${res.status} | refused (${why.code}): ${answer.said.slice(0, 120)}`);
    throw why;
  }

  /* The login page's own script sends a merchant to /Traders/index, so that is
     where a browser lands — and the session is not fully set up until it has.
     An older form answered with a redirect; follow it first, as a browser would. */
  if (res.status >= 300 && res.status < 400 && res.location && !isLoginPath(pathOf(res.location))) {
    await openPage(biz, pathOf(res.location));
  }
  const landing = await openPage(biz, "/Traders/index");
  let dash = landing.reply;
  if (!landing.toLogin && !/Dashboard/i.test(landing.at)) dash = (await openPage(biz, "/Traders/Dashboard")).reply;
  // the login was changed or removed while this was under way: this session is no one's now
  if (sessions.get(biz) !== s) throw new PortalError("signed_out");
  const signedIn = !landing.toLogin && dash.status === 200 && !looksSignedOut(dash.text);
  /* One line in the log per attempt: what the portal answered, never what was
     sent. It is the only way to tell a wrong captcha from a changed page. */
  console.log(`[emandi] sign-in: post ${res.status}${res.location ? ` -> ${res.location}` : ""}`
    + ` | reply ${answer.succeeded === null ? "page" : `json succeeded=${answer.succeeded}`}`
    + ` | landing ${landing.reply.status} at ${landing.at}`
    + ` | dashboard ${dash.status} ${dash.text.length}b`
    + ` | signed in: ${signedIn}`);
  if (signedIn) {
    s.user = acc.user;
    s.signedInAt = s.okAt = s.landedAt = Date.now();
    s.noteCode = null;
    s.refused = null;
    s.bandless = null;
    const st = readStore();
    if (st[biz]) { st[biz] = { ...st[biz], ...whoseLogin(dash.text) }; writeStore(st); }
    keepSession(biz);
    startKeepAlive(biz);
    return { ok: true };
  }
  // not in: say what the portal itself said, and only call it a captcha when it is
  const why = answer.said ? refusal(answer.said) : new PortalError("denied");
  s.refused = { code: why.code, said: why.said };
  throw why;
}

export function signOut(biz: string) {
  dropSession(biz);
  const st = readStore();
  if (st[biz]) { st[biz] = { ...st[biz], session: null }; writeStore(st); }
}

export function statusOf(biz: string) {
  const acc = accountOf(biz);
  const s = sessionOf(biz); // brings a kept session back after a restart
  /* "Saved" means it can be used: a password this computer cannot read (the
     data folder was copied without its key) is not a saved password. */
  const passwordReadable = Boolean(readablePassword(acc));
  return {
    configured: Boolean(acc.user && passwordReadable),
    passwordUnreadable: Boolean(acc.enc) && !passwordReadable,
    user: acc.user,
    watch: acc.watch,
    firm: acc.firm ?? null,
    portalLicence: acc.portalLicence ?? null,
    signedIn: Boolean(s.signedInAt),
    signedInAt: s.signedInAt ? new Date(s.signedInAt).toISOString() : null,
    /** When e-Mandi last showed this session working. */
    checkedAt: s.okAt && !s.unproven ? new Date(s.okAt).toISOString() : null,
    noteCode: s.noteCode,
    note: s.noteCode ? SAY[s.noteCode] ?? null : null,
    refused: s.refused,
    storeNote: storeTrouble,
    base: BASE,
  };
}

/* ------------------------------------------------------------ reading */

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

/**
 * A decimal as e-Mandi writes it — "3,965.800", 3400.5 — as a whole number of
 * 1/10^places, half up, without passing through floating point.
 */
export function decimalUnits(v: unknown, places: number): number | null {
  if (v == null || typeof v === "boolean") return null;
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(String(v).replace(/,/g, "").trim());
  if (!m || (!m[2] && !m[3])) return null;
  const [, sign, int, frac = ""] = m;
  let units = BigInt((int || "0") + (frac + "0".repeat(places)).slice(0, places));
  if ((frac[places] ?? "0") >= "5") units += 1n; // the first digit dropped decides, half up
  return Number(sign === "-" ? -units : units);
}

export interface RateBand {
  cropCode: string;
  cropName: string | null;
  /** Paise per quintal, as the portal states them. */
  minRatePaise: number | null;
  maxRatePaise: number | null;
  /** Percentages, e.g. 1.00 and 0.50. */
  mandiFeePct: number | null;
  developmentCessPct: number | null;
  /** The portal's own flags: whether this licence sits on a mandi sthal, and whether it is a direct licence. */
  onMandiSthal: boolean | null;
  directLicence: boolean | null;
  /** What e-Mandi replied, as it came (cut at 200 characters) — shown when there is no band. */
  said: string;
  at: string;
}

/** The band the portal allows for a commodity today, with its fee and cess. */
export async function rateBand(biz: string, cropCode: string): Promise<RateBand> {
  const text = await signedInCall(biz, "/Traders/get_crop_fees", {
    kind: "xhr", referer: "/Traders/add_six_r", // where the page that asks this lives
    body: new URLSearchParams({ crop_code: cropCode }),
  });
  if (process.env.MANDI_EMANDI_DEBUG) console.log(`[emandi] crop_fees ${cropCode}: ${text.slice(0, 400)}`);
  const said = text.replace(/\s+/g, " ").trim().slice(0, 200);
  let row: Record<string, unknown> | null = null;
  try { const j = JSON.parse(text); row = Array.isArray(j) ? j[0] ?? null : j; } catch { /* not json */ }
  /* A reply without the rate fields is not "no band": it is an answer we do
     not understand, and it must not be shown as a decision by the mandi. */
  if (!row || typeof row !== "object" || (!("min_rate" in row) && !("max_rate" in row))) throw new PortalError("rate_shape", said);
  const crops = await cropList(biz).catch(() => []);
  const pct = (v: unknown) => (v == null || v === "" ? null : Number(v));
  return {
    cropCode,
    cropName: crops.find((c) => c.code === cropCode)?.name ?? null,
    minRatePaise: decimalUnits(row.min_rate, 2),
    maxRatePaise: decimalUnits(row.max_rate, 2),
    mandiFeePct: pct(row.mandi_fees),
    developmentCessPct: pct(row.development_cess),
    onMandiSthal: row.isupmandisthal == null ? null : Boolean(Number(row.isupmandisthal)),
    directLicence: row.isDirectlicense == null ? null : Boolean(Number(row.isDirectlicense)),
    said,
    at: new Date().toISOString(),
  };
}

export type RateRow = Omit<RateBand, "said"> & { said: string | null; error: string | null; code: string | null };

/* After one of these nothing else will come through either, so the list stops
   and says so once, instead of waiting on every commodity in turn. */
const STOPS = new Set(["signed_out", "ended", "offline", "slow", "portal_error", "store_busy"]);

/**
 * The band for each commodity asked for. Stops at the first failure that is
 * about the session or the connection; a commodity the portal answers oddly
 * for is noted on its own row and the rest carry on.
 *
 * When every band comes back 0.00 the session may be half set up again (the
 * week-long 0.00 of docs §9), so it is landed on /Traders/index once and asked
 * again before "no band" is believed — at most once in half an hour.
 */
export async function ratesFor(biz: string, codes: string[]): Promise<{ rows: RateRow[]; problem: PortalError | null }> {
  const rows: RateRow[] = [];
  const blankRow = (code: string, e: PortalError): RateRow => ({
    cropCode: code, cropName: null, minRatePaise: null, maxRatePaise: null, mandiFeePct: null, developmentCessPct: null,
    onMandiSthal: null, directLicence: null, at: new Date().toISOString(), said: e.said, error: e.message, code: e.code,
  });
  const readAll = async () => {
    rows.length = 0;
    for (const code of codes) {
      try { rows.push({ ...(await rateBand(biz, code)), error: null, code: null }); } catch (e) {
        const pe = e instanceof PortalError ? e : new PortalError("portal_error");
        if (STOPS.has(pe.code)) return pe;
        rows.push(blankRow(code, pe));
      }
    }
    return null;
  };
  let problem: PortalError | null = null;
  try {
    const { landedNow } = await freshSession(biz);
    problem = await readAll();
    const s = sessionOf(biz);
    const bandless = !problem && rows.length > 0 && rows.every((r) => !r.error && !r.minRatePaise && !r.maxRatePaise);
    const key = codes.join(",");
    const confirmed = s.bandless?.codes === key && Date.now() - s.bandless.at < 30 * 60_000;
    if (bandless && !landedNow && !confirmed) {
      if ((await look(biz)) === "ended") throw new PortalError("ended");
      problem = await readAll();
      s.bandless = { codes: key, at: Date.now() };
    }
  } catch (e) {
    problem = e instanceof PortalError ? e : new PortalError("portal_error");
  }
  // every commodity not answered carries the same reason, so nothing reads as a figure
  if (problem) for (const code of codes.slice(rows.length)) rows.push(blankRow(code, problem));
  return { rows, problem };
}

/**
 * The captcha picture behind an address, as bytes.
 *
 * Only e-Mandi's own captcha image is fetched, and only that: the address is
 * taken from what was pasted and must be /DNTCaptchaImage/Show on the portal,
 * so this cannot be turned into a way of fetching anything else.
 *
 * What it says is still for a person to read.
 */
export async function captchaImage(biz: string, pasted: string): Promise<{ image: string; url: string }> {
  const found = /\/DNTCaptchaImage\/Show\?[^"'\s<>]+/.exec(pasted.replace(/&amp;/g, "&"))?.[0];
  if (!found) throw new PortalError("not_captcha");
  // an image the page asks for: it does not move where "we" are
  const res = await call(biz, found, { kind: "image" });
  if (res.status !== 200 || !res.type.startsWith("image/")) throw new PortalError("no_picture");
  return { image: `data:${res.type};base64,${res.bytes.toString("base64")}`, url: BASE + found };
}

export interface StockLine {
  /** The portal's crop code; "" when the register gave none (then matched by name). */
  cropCode: string;
  crop: string;
  /** Whole grams, from e-Mandi's quintals to three decimals — no rounding on the way. */
  inGrams: number | null;
  outGrams: number | null;
  leftGrams: number | null;
  /** How many register rows were added up into this line. */
  rows: number;
}

/** dd/mm/yyyy, which is what the portal's date boxes hold. */
const ddmmyyyy = (d: Date) =>
  `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
const grams = (cell: unknown) => decimalUnits(cell, 5); // 1 quintal = 100 000 g = 10^5
/** Adds what is there; null only when nothing at all was given. */
const plus = (...xs: (number | null)[]) => (xs.every((x) => x === null) ? null : xs.reduce<number>((a, x) => a + (x ?? 0), 0));

/* The stock register is a DataTable fed from /Stock/GetDayBookList, and it is
   fussy: unless the whole DataTables payload is there — every column, the
   order, the search — the model does not bind, `draw` comes back 0 and the
   answer is empty however much stock there is. The columns are the ones the
   portal's own script asks for, in its order. */
const DAYBOOK_COLUMNS = ["crop_name_hi", "ins_primary", "ins_secondary", "outs_primary",
  "outs_secondary", "availableStock_primary", "availableStock_secondary", "availableStock", ""];

/**
 * What e-Mandi holds as this licence's stock, commodity by commodity — every
 * commodity it holds, watched or not.
 *
 * The window is the last month, counted back from today each time it is asked
 * — so tomorrow it is tomorrow's month, without anyone setting a date.
 */
export async function availableStock(biz: string, days = 30): Promise<{ lines: StockLine[]; licence: string; from: string; to: string; at: string }> {
  await freshSession(biz);
  let licence = accountOf(biz).portalLicence ?? "";
  if (!licence) {
    const page = await signedInCall(biz, "/Stock/DayBook");
    licence = /<input[^>]*id="license_number"[^>]*>/.exec(page)?.[0]?.match(/value="([^"]*)"/)?.[1]?.trim() ?? "";
    // asking with an empty licence gets an empty register, which would read as "no stock"
    if (!licence) throw new PortalError("no_licence");
    const st = readStore();
    if (st[biz] && !st[biz].portalLicence) { st[biz] = { ...st[biz], portalLicence: licence }; writeStore(st); }
  }
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - days);

  const body = new URLSearchParams();
  DAYBOOK_COLUMNS.forEach((name, i) => {
    body.set(`columns[${i}][data]`, name);
    body.set(`columns[${i}][name]`, "");
    body.set(`columns[${i}][searchable]`, "true");
    body.set(`columns[${i}][orderable]`, "true");
    body.set(`columns[${i}][search][value]`, "");
    body.set(`columns[${i}][search][regex]`, "false");
  });
  body.set("order[0][column]", "0");
  body.set("order[0][dir]", "desc");
  body.set("draw", "1");
  body.set("start", "0");
  body.set("length", "-1");
  body.set("search[value]", "");
  body.set("search[regex]", "false");
  body.set("Fdate", ddmmyyyy(from));
  body.set("Tdate", ddmmyyyy(to));
  body.set("LicenseNumber", licence);

  const text = await signedInCall(biz, "/Stock/GetDayBookList", { kind: "xhr", referer: "/Stock/DayBook", body });
  if (process.env.MANDI_EMANDI_DEBUG) console.log(`[emandi] stock ${ddmmyyyy(from)}–${ddmmyyyy(to)}: ${text.slice(0, 300)}`);
  let rows: Record<string, unknown>[] = [];
  try {
    const j = JSON.parse(text) as { draw?: number; data?: Record<string, unknown>[] };
    rows = Array.isArray(j.data) ? j.data : [];
  } catch { throw new PortalError("stock_shape", text.replace(/\s+/g, " ").trim().slice(0, 200)); }

  /* In and out are first arrival plus second arrival, the same as what is
     left — a primary-only in/out beside a total balance would not add up. Two
     rows for one commodity are added together, in grams, not dropped. */
  const byKey = new Map<string, StockLine>();
  for (const r of rows) {
    // the portal writes a byte-order mark into the name: "धान (﻿PADDY)"
    const crop = String(r.crop_name_hi ?? "").replace(/﻿/g, "").replace(/\s+/g, " ").trim();
    const cropCode = String(r.crop_code ?? "").trim();
    const line: StockLine = {
      cropCode, crop, rows: 1,
      inGrams: plus(grams(r.ins_primary), grams(r.ins_secondary)),
      outGrams: plus(grams(r.outs_primary), grams(r.outs_secondary)),
      leftGrams: grams(r.availableStock) ?? plus(grams(r.availableStock_primary), grams(r.availableStock_secondary)),
    };
    const key = cropCode || `name:${crop}`;
    const had = byKey.get(key);
    byKey.set(key, had ? {
      ...had, rows: had.rows + 1,
      inGrams: plus(had.inGrams, line.inGrams), outGrams: plus(had.outGrams, line.outGrams), leftGrams: plus(had.leftGrams, line.leftGrams),
    } : line);
  }
  return { lines: [...byKey.values()], licence, from: ddmmyyyy(from), to: ddmmyyyy(to), at: new Date().toISOString() };
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
  if (force) await freshSession(biz);
  const html = await signedInCall(biz, "/Traders/add_six_r");
  const select = /<select[^>]+id="crop_code"[\s\S]*?<\/select>/i.exec(html)?.[0] ?? "";
  const out: { code: string; name: string }[] = [];
  for (const m of select.matchAll(/<option[^>]+value="([^"]*)"[^>]*>([^<]*)<\/option>/g)) {
    const code = m[1].trim();
    const name = unescapeHtml(m[2]).trim();
    if (code && name && !/चुने/.test(name)) out.push({ code, name });
  }
  if (!out.length) throw new PortalError("crops_shape");
  s.crops = out;
  const st = readStore();
  if (st[biz]) { st[biz] = { ...st[biz], crops: out, cropsAt: new Date().toISOString() }; writeStore(st); }
  return out;
}

/** "l/2016/75/17121983 " and "L/2016/75/17121983" are one licence. */
export const licenceKey = (l: string | null | undefined) => (l ?? "").toUpperCase().replace(/\s+/g, "");
