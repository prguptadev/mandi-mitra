import { Hono, type Context } from "hono";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { audit } from "../lib/audit.ts";
import { can, actor, type Env } from "../lib/http.ts";
import {
  accountOf, saveAccount, forgetAccount, statusOf, beginSignIn, finishSignIn, signOut, check, checkKeptSessions,
  ratesFor, cropList, keptCrops, availableStock, captchaImage, licenceKey, PortalError,
} from "../lib/emandi.ts";

/* The mandi portal, as seen from Mandi Mitra. Each business has its own login
   there, so everything here is per business. Setting the login sits with the
   people who may change business settings; looking at a rate is for anyone who
   may see the dashboard. */
export const emandiRoutes = new Hono<Env>();

/* A session kept from before the app was closed is looked at once as the app
   starts, so it is kept alive (or known to be over) before anyone opens the
   dashboard. */
setTimeout(() => { void checkKeptSessions(); }, 3_000).unref?.();

/* A refusal goes out with its code, so the screen can say it in the chosen
   language, and with e-Mandi's own words when it gave any. */
const fail = (c: Context<Env>, e: unknown) => {
  if (!(e instanceof PortalError)) console.error("[emandi]", e);
  const pe = e instanceof PortalError ? e : new PortalError("portal_error");
  return c.json({ error: pe.message, code: pe.code, said: pe.said }, 400);
};

/**
 * One firm never sees another's figures. When this business has its own mandi
 * licence on record and the login opens a different one, nothing is read with
 * that login — not a rate, not the stock.
 */
async function licenceClash(biz: string, portalLicence: string | null | undefined) {
  if (!portalLicence) return null;
  const [row] = await db.select({ l: schema.businesses.mandiLicense }).from(schema.businesses)
    .where(eq(schema.businesses.id, biz)).limit(1);
  const here = licenceKey(row?.l);
  return here && here !== licenceKey(portalLicence) ? new PortalError("other_licence", row!.l) : null;
}

/** The status, after looking at a session the app has not seen working for a while. */
emandiRoutes.get("/", can("dashboard.view"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  try { await check(biz); } catch (e) { if (!(e instanceof PortalError)) return fail(c, e); /* the status says why */ }
  try { return c.json(statusOf(biz)); } catch (e) { return fail(c, e); }
});

/** Look at the session now — what "Refresh" does before the rates and stock are read again. */
emandiRoutes.post("/check", can("dashboard.view"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  try { await check(biz, true); } catch (e) { return fail(c, e); }
  return c.json(statusOf(biz));
});

emandiRoutes.put("/", can("business.write"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const body = z.object({
    user: z.string().trim().max(120).optional(),
    password: z.string().max(200).optional(),
    watch: z.array(z.string().trim().max(10)).max(12, "Choose at most 12 commodities").optional(),
  }).parse(await c.req.json());
  let before, after;
  try {
    before = accountOf(biz);
    after = saveAccount(biz, body);
  } catch (e) { return fail(c, e); }
  /* Each kind of change says what it was, so the trail can tell a new
     password from a ticked commodity. The password itself never reaches it. */
  const who = actor(c);
  const base = { actor: who, entity: "settings", entityId: "emandi" } as const;
  if (after.user !== before.user) {
    await audit({ ...base, action: "emandi.account", entityLabel: `Mandi portal user name changed to ${after.user || "nothing"}`,
      before: { user: before.user }, after: { user: after.user } });
  }
  if (body.password) await audit({ ...base, action: "emandi.password", entityLabel: `Mandi portal password changed for ${after.user || "no user"}` });
  if (after.watch.join(",") !== before.watch.join(",")) {
    await audit({ ...base, action: "emandi.watch", entityLabel: `Commodities shown from e-Mandi: ${after.watch.join(", ") || "none"}`,
      before: { watch: before.watch }, after: { watch: after.watch } });
  }
  return c.json(statusOf(biz));
});

emandiRoutes.delete("/", can("business.write"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  try { forgetAccount(biz); } catch (e) { return fail(c, e); }
  await audit({ actor: actor(c), action: "emandi.forget", entity: "settings", entityId: "emandi", entityLabel: "Mandi portal login removed from this computer" });
  return c.json(statusOf(biz));
});

/**
 * Step one of signing in: the portal's captcha, for the operator to read — or,
 * when this firm's session is in fact still working, word that it is.
 */
emandiRoutes.post("/signin/start", can("dashboard.view"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  try {
    const r = await beginSignIn(biz);
    return c.json("already" in r ? { already: true, status: statusOf(biz) } : r);
  } catch (e) { return fail(c, e); }
});

/** Step two: what the operator typed, and which captcha they were looking at. */
emandiRoutes.post("/signin/finish", can("dashboard.view"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const { captcha, ticket } = z.object({ captcha: z.string().trim().min(1).max(20), ticket: z.string().max(4000).optional() })
    .parse(await c.req.json());
  try {
    await finishSignIn(biz, captcha, ticket);
  } catch (e) { return fail(c, e); }
  await audit({ actor: actor(c), action: "emandi.signin", entity: "settings", entityId: "emandi", entityLabel: "Signed in to the mandi portal" });
  return c.json(statusOf(biz));
});

/* Ending the session costs a captcha to start again, so it is on the trail. */
emandiRoutes.post("/signout", can("dashboard.view"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  try { signOut(biz); } catch (e) { return fail(c, e); }
  await audit({ actor: actor(c), action: "emandi.signout", entity: "settings", entityId: "emandi", entityLabel: "Signed out of the mandi portal" });
  return c.json(statusOf(biz));
});

/**
 * The picture behind a captcha address, fetched with this firm's own session
 * and handed back as bytes.
 *
 * A browser cannot fetch it: e-Mandi's cookies are SameSite=Lax, so they are
 * not sent for an image another page asks for. The server holds the session,
 * so it can — the same way the sign-in card gets its picture.
 */
emandiRoutes.post("/captcha", can("dashboard.view"), async (c) => {
  const { text } = z.object({ text: z.string().min(1).max(20_000) }).parse(await c.req.json());
  try { return c.json(await captchaImage(c.get("auth")!.businessId!, text)); } catch (e) { return fail(c, e); }
});

/**
 * What e-Mandi holds as this firm's own stock: every commodity on the
 * licence, and the licence it was read for, so a screen can refuse lines that
 * belong to another.
 */
emandiRoutes.get("/stock", can("dashboard.view"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  try {
    const before = await licenceClash(biz, accountOf(biz).portalLicence);
    if (before) throw before;
    const r = await availableStock(biz);
    const after = await licenceClash(biz, r.licence);
    if (after) throw after;
    return c.json({ ...r, status: statusOf(biz) });
  } catch (e) { return fail(c, e); }
});

/** The commodity list as last read — no portal call, so it works signed out. */
emandiRoutes.get("/crops", can("dashboard.view"), (c) => {
  try { return c.json(keptCrops(c.get("auth")!.businessId!)); } catch (e) { return fail(c, e); }
});

/** Read the list from the portal again (needs a session). It is part of the login's settings. */
emandiRoutes.post("/crops/refresh", can("business.write"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  try { return c.json({ crops: await cropList(biz, true), at: new Date().toISOString() }); } catch (e) { return fail(c, e); }
});

/**
 * The rate band for the commodities this business watches, or the ones asked
 * for. Each firm has its own login on the portal and sees only its own: a
 * login is never borrowed from the other firm, on screen or behind it.
 *
 * When the portal stops answering, or the session has ended, the list stops
 * there and says so once (`problem`), with every commodity left marked the
 * same — never a figure, and never a wait on each commodity in turn.
 */
emandiRoutes.get("/rates", can("dashboard.view"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const asked = (c.req.query("codes") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  try {
    const codes = asked.length ? asked.slice(0, 12) : accountOf(biz).watch;
    const clash = await licenceClash(biz, accountOf(biz).portalLicence);
    const { rows, problem } = clash
      ? { rows: codes.map((code) => ({ cropCode: code, cropName: null, minRatePaise: null, maxRatePaise: null, mandiFeePct: null,
          developmentCessPct: null, onMandiSthal: null, directLicence: null, at: new Date().toISOString(),
          said: clash.said, error: clash.message, code: clash.code })), problem: clash }
      : await ratesFor(biz, codes);
    return c.json({
      rates: rows,
      problem: problem ? { code: problem.code, error: problem.message, said: problem.said } : null,
      status: statusOf(biz),
      at: new Date().toISOString(),
    });
  } catch (e) { return fail(c, e); }
});
