import { Hono } from "hono";
import { z } from "zod";
import { audit } from "../lib/audit.ts";
import { can, actor, bad, type Env } from "../lib/http.ts";
import {
  accountOf, saveAccount, forgetAccount, statusOf, beginSignIn, finishSignIn, signOut,
  rateBand, cropList, keptCrops, PortalError,
} from "../lib/emandi.ts";

/* The mandi portal, as seen from Mandi Mitra. Each business has its own login
   there, so everything here is per business. Setting the login sits with the
   people who may change business settings; looking at a rate is for anyone who
   may see the dashboard. */
export const emandiRoutes = new Hono<Env>();

const fail = (e: unknown) => bad(e instanceof PortalError ? e.message : "The mandi portal did not answer",
  e instanceof PortalError ? e.code : "portal");

emandiRoutes.get("/", can("dashboard.view"), (c) => c.json(statusOf(c.get("auth")!.businessId!)));

emandiRoutes.put("/", can("business.write"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const body = z.object({
    user: z.string().trim().max(120).optional(),
    password: z.string().max(200).optional(),
    licence: z.string().trim().max(60).optional(),
    watch: z.array(z.string().trim().max(10)).max(12).optional(),
  }).parse(await c.req.json());
  saveAccount(biz, body);
  // the password itself never reaches the trail
  await audit({
    actor: actor(c), action: "emandi.account", entity: "settings", entityId: "emandi",
    entityLabel: `Mandi portal login saved for this business (${accountOf(biz).user || "no user"})`,
  });
  return c.json(statusOf(biz));
});

emandiRoutes.delete("/", can("business.write"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  forgetAccount(biz);
  await audit({ actor: actor(c), action: "emandi.forget", entity: "settings", entityId: "emandi", entityLabel: "Mandi portal login removed from this computer" });
  return c.json(statusOf(biz));
});

/** Step one of signing in: the portal's captcha, for the operator to read. */
emandiRoutes.post("/signin/start", can("dashboard.view"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  try { return c.json(await beginSignIn(biz)); } catch (e) { throw fail(e); }
});

/** Step two: what the operator typed. */
emandiRoutes.post("/signin/finish", can("dashboard.view"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const { captcha } = z.object({ captcha: z.string().trim().min(1).max(20) }).parse(await c.req.json());
  try {
    await finishSignIn(biz, captcha);
  } catch (e) { throw fail(e); }
  await audit({ actor: actor(c), action: "emandi.signin", entity: "settings", entityId: "emandi", entityLabel: "Signed in to the mandi portal" });
  return c.json(statusOf(biz));
});

emandiRoutes.post("/signout", can("dashboard.view"), (c) => {
  signOut(c.get("auth")!.businessId!);
  return c.json(statusOf(c.get("auth")!.businessId!));
});

/** The commodity list as last read — no portal call, so it works signed out. */
emandiRoutes.get("/crops", can("dashboard.view"), (c) => c.json(keptCrops(c.get("auth")!.businessId!)));

/** Read the list from the portal again (needs a session). */
emandiRoutes.post("/crops/refresh", can("dashboard.view"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  try { return c.json({ crops: await cropList(biz, true), at: new Date().toISOString() }); } catch (e) { throw fail(e); }
});

/** The rate band for the commodities this business watches, or the ones asked for. */
emandiRoutes.get("/rates", can("dashboard.view"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const asked = (c.req.query("codes") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const codes = asked.length ? asked.slice(0, 12) : accountOf(biz).watch;
  const out = [];
  for (const code of codes) {
    try { out.push({ ...(await rateBand(biz, code)), error: null }); } catch (e) {
      out.push({ cropCode: code, cropName: null, minRatePaise: null, maxRatePaise: null, mandiFeePct: null, developmentCessPct: null,
        at: new Date().toISOString(), error: e instanceof PortalError ? e.message : "The portal did not answer" });
      if (e instanceof PortalError && e.code === "signed_out") break;
    }
  }
  return c.json({ rates: out, status: statusOf(biz) });
});
