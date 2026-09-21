import { Hono } from "hono";
import { SupplierChargesSchema, supplierChargesOf } from "../lib/supplierCharges.ts";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { newId, nowSec } from "../lib/ids.ts";
import { audit } from "../lib/audit.ts";
import { encryptSecret, decryptSecret, maskKey } from "../lib/secrets.ts";
import { explainGeminiError, usageToday, listModels, GEMINI_BASE } from "../lib/gemini.ts";
import {
  DisplayConfigSchema, defaultDisplayConfig,
  GeminiConfigSchema, defaultGeminiConfig, GEMINI_MODELS,
} from "../lib/display.ts";
import { can, actor, param, HttpError, bad, type Env } from "../lib/http.ts";

export const settingsRoutes = new Hono<Env>();

async function readSetting(businessId: string, key: string): Promise<string | null> {
  const [row] = await db.select().from(schema.settings)
    .where(and(eq(schema.settings.businessId, businessId), eq(schema.settings.key, key))).limit(1);
  return row?.value ?? null;
}

async function writeSetting(businessId: string, key: string, value: string) {
  const [row] = await db.select().from(schema.settings)
    .where(and(eq(schema.settings.businessId, businessId), eq(schema.settings.key, key))).limit(1);
  if (row) {
    await db.update(schema.settings).set({ value, updatedAt: nowSec() }).where(eq(schema.settings.id, row.id));
  } else {
    await db.insert(schema.settings).values({ id: newId(), businessId, key, value });
  }
}

/* ----------------------------------------------------------------- display */

/** Readable without a permission: every screen needs it to render a number. */
settingsRoutes.get("/display", async (c) => {
  const auth = c.get("auth");
  if (!auth?.businessId) return c.json(defaultDisplayConfig());
  const raw = await readSetting(auth.businessId, "display");
  if (!raw) return c.json(defaultDisplayConfig());
  const parsed = DisplayConfigSchema.safeParse(JSON.parse(raw));
  return c.json(parsed.success ? parsed.data : defaultDisplayConfig());
});

settingsRoutes.put("/display", can("settings.write"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const next = DisplayConfigSchema.parse(await c.req.json());
  const before = await readSetting(biz, "display");
  await writeSetting(biz, "display", JSON.stringify(next));
  await audit({
    actor: actor(c), action: "settings.display.update", entity: "settings",
    entityId: "display", entityLabel: "Number & currency format",
    before: before ? JSON.parse(before) : defaultDisplayConfig(), after: next,
  });
  return c.json(next);
});

/* -------------------------------------------------------- supplier charges */

/** Commission and gaushala each supplier adds, and what the columns are called. Everyone who sees slips reads it. */
settingsRoutes.get("/supplier-charges", async (c) => {
  const biz = c.get("auth")?.businessId;
  if (!biz) throw new HttpError(401, "Please sign in", "no_session");
  return c.json(await supplierChargesOf(biz));
});

/** New slips take these; slips already entered keep the terms they were made with. */
settingsRoutes.put("/supplier-charges", can("settings.write"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const next = SupplierChargesSchema.parse(await c.req.json());
  const before = await supplierChargesOf(biz);
  await writeSetting(biz, "supplierCharges", JSON.stringify(next));
  await audit({
    actor: actor(c), action: "settings.supplier_charges.update", entity: "settings",
    entityId: "supplierCharges", entityLabel: `Supplier charges: commission ${next.commissionPct}%, gaushala ₹${next.gaushalaPerQtl}/qtl`,
    before, after: next,
  });
  return c.json(next);
});

/* ------------------------------------------------------------------ gemini */

settingsRoutes.get("/gemini", can("settings.write", "scan.create"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const cfgRaw = await readSetting(biz, "gemini");
  const keyRaw = await readSetting(biz, "gemini.apiKey");
  const cfg = cfgRaw
    ? GeminiConfigSchema.safeParse(JSON.parse(cfgRaw))
    : { success: true as const, data: defaultGeminiConfig() };

  const plain = keyRaw ? decryptSecret(keyRaw) : null;
  return c.json({
    ...(cfg.success ? cfg.data : defaultGeminiConfig()),
    configured: Boolean(plain),
    maskedKey: plain ? maskKey(plain) : null,
    /** true when a stored key exists but could not be decrypted */
    keyUnreadable: Boolean(keyRaw) && !plain,
    models: GEMINI_MODELS,
  });
});

settingsRoutes.put("/gemini", can("settings.write"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const body = z.object({
    apiKey: z.string().trim().optional(),
    clearKey: z.boolean().optional(),
  }).and(GeminiConfigSchema.partial()).parse(await c.req.json());

  const prevRaw = await readSetting(biz, "gemini");
  const prev = prevRaw ? GeminiConfigSchema.parse(JSON.parse(prevRaw)) : defaultGeminiConfig();
  const { apiKey, clearKey, ...cfgPatch } = body;
  let keyWarning: string | null = null;
  const next = GeminiConfigSchema.parse({ ...prev, ...cfgPatch });
  await writeSetting(biz, "gemini", JSON.stringify(next));

  if (clearKey) {
    await db.delete(schema.settings).where(and(
      eq(schema.settings.businessId, biz), eq(schema.settings.key, "gemini.apiKey"),
    ));
    await audit({ actor: actor(c), action: "settings.gemini.key.clear", entity: "settings", entityId: "gemini", entityLabel: "Gemini API key removed" });
  } else if (apiKey) {
    if (apiKey.length < 20) throw bad("That does not look like a Gemini API key", "bad_key");
    /* An AI Studio API key starts with "AIza" and does not expire. An "AQ."
       value is a short-lived token: it works, then starts failing with a 401
       a few hours later. Warn, but never block — a working key is a working
       key, and refusing to save one the user can prove works is wrong. */
    if (!apiKey.startsWith("AIza")) {
      keyWarning = "This works for now, but it looks like a temporary sign-in token rather than an API key. It will stop working after a few hours. A permanent key from aistudio.google.com/apikey starts with \"AIza\".";
    }
    await writeSetting(biz, "gemini.apiKey", encryptSecret(apiKey));
    // the key itself never reaches the audit log
    await audit({
      actor: actor(c), action: "settings.gemini.key.set", entity: "settings",
      entityId: "gemini", entityLabel: `Gemini API key set (${maskKey(apiKey)})`,
    });
  }

  if (JSON.stringify(prev) !== JSON.stringify(next)) {
    await audit({
      actor: actor(c), action: "settings.gemini.update", entity: "settings",
      entityId: "gemini", entityLabel: "Gemini settings", before: prev, after: next,
    });
  }
  return c.json({ ok: true });
});

/** Round-trips a tiny prompt so the key and model are proven before a real scan. */
/** How much of today's Gemini allowance this key has used, as counted by the app. */
settingsRoutes.get("/gemini/usage", can("scan.create", "settings.write"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const keyRaw = await readSetting(biz, "gemini.apiKey");
  const key = keyRaw ? decryptSecret(keyRaw) : null;
  if (!key) return c.json({ configured: false });
  const cfgRaw = await readSetting(biz, "gemini");
  const cfg = cfgRaw ? GeminiConfigSchema.parse(JSON.parse(cfgRaw)) : defaultGeminiConfig();
  /* With backups, the main model running out is not the end of the day:
     say which model the next page goes to. */
  const chain = await Promise.all([...new Set([cfg.model, ...cfg.backupModels])].map((m) => usageToday(key, m)));
  const next = chain.find((u) => !u.exhausted && (u.dailyLimit == null || u.used < u.dailyLimit))?.model ?? null;
  return c.json({
    configured: true, ...chain[0],
    chain: chain.map((u) => ({ model: u.model, used: u.used, dailyLimit: u.dailyLimit, exhausted: u.exhausted })),
    next,
  });
});

/**
 * The models this key can call (Google's list — free to ask), with what the
 * app has seen of each today: reads used, Google's stated daily limit, and
 * whether it already refused. Which are free only shows on a real read.
 */
settingsRoutes.get("/gemini/models", can("settings.write", "scan.create"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const keyRaw = await readSetting(biz, "gemini.apiKey");
  const key = keyRaw ? decryptSecret(keyRaw) : null;
  if (!key) return c.json({ configured: false, ok: false, models: [] });
  const cfgRaw = await readSetting(biz, "gemini");
  const cfg = cfgRaw ? GeminiConfigSchema.parse(JSON.parse(cfgRaw)) : defaultGeminiConfig();
  const listed = await listModels(key);
  const ids = new Set<string>([
    ...(listed.ok ? listed.models.map((m) => m.id) : []),
    ...GEMINI_MODELS.map((m) => m.id), cfg.model, cfg.fallbackModel, ...cfg.backupModels,
  ]);
  const usage = await Promise.all([...ids].map((id) => usageToday(key, id)));
  return c.json({
    configured: true,
    ok: listed.ok,
    error: listed.ok ? null : listed.error,
    models: listed.ok ? listed.models : [],
    usage: Object.fromEntries(usage.map((u) => [u.model, { used: u.used, dailyLimit: u.dailyLimit, exhausted: u.exhausted }])),
  });
});

/** Copy the key from another business this user already set it up in. */
settingsRoutes.post("/gemini/copy-from", can("settings.write"), async (c) => {
  const auth = c.get("auth")!;
  const { businessId } = z.object({ businessId: z.string() }).parse(await c.req.json());

  const [member] = await db.select().from(schema.memberships).where(and(
    eq(schema.memberships.userId, auth.user.id),
    eq(schema.memberships.businessId, businessId),
    eq(schema.memberships.active, true),
  )).limit(1);
  if (!member) throw new HttpError(403, "You are not a member of that business", "forbidden");

  const raw = await readSetting(businessId, "gemini.apiKey");
  const plain = raw ? decryptSecret(raw) : null;
  if (!plain) throw bad("That business has no key saved", "no_key");

  await writeSetting(auth.businessId!, "gemini.apiKey", encryptSecret(plain));
  await audit({
    actor: actor(c), action: "settings.gemini.key.copy", entity: "settings", entityId: "gemini",
    entityLabel: `Key copied from another business (${maskKey(plain)})`,
  });
  return c.json({ ok: true, maskedKey: maskKey(plain) });
});

/** Businesses this user could copy a key from. */
settingsRoutes.get("/gemini/sources", can("settings.write"), async (c) => {
  const auth = c.get("auth")!;
  const mems = await db.select({
    businessId: schema.memberships.businessId,
    name: schema.businesses.name,
    shortCode: schema.businesses.shortCode,
  })
    .from(schema.memberships)
    .innerJoin(schema.businesses, eq(schema.businesses.id, schema.memberships.businessId))
    .where(and(eq(schema.memberships.userId, auth.user.id), eq(schema.memberships.active, true)));

  const out = [];
  for (const m of mems) {
    if (m.businessId === auth.businessId) continue;
    const raw = await readSetting(m.businessId, "gemini.apiKey");
    const plain = raw ? decryptSecret(raw) : null;
    if (plain) out.push({ ...m, maskedKey: maskKey(plain) });
  }
  return c.json(out);
});

settingsRoutes.post("/gemini/test", can("settings.write", "scan.create"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const keyRaw = await readSetting(biz, "gemini.apiKey");
  const key = keyRaw ? decryptSecret(keyRaw) : null;
  if (!key) throw bad("Add the API key first", "no_key");

  const cfgRaw = await readSetting(biz, "gemini");
  const cfg = cfgRaw ? GeminiConfigSchema.parse(JSON.parse(cfgRaw)) : defaultGeminiConfig();
  const model = (await c.req.json().catch(() => ({})))?.model ?? cfg.model;

  const started = Date.now();
  try {
    /* Looking the model up proves the key and the model name without calling
       generateContent — so testing the key does not spend one of the day's
       free reads. */
    const res = await fetch(
      `${GEMINI_BASE}/v1beta/models/${encodeURIComponent(model)}`,
      { headers: { "x-goog-api-key": key }, signal: AbortSignal.timeout(20_000) },
    );
    const ms = Date.now() - started;
    const json = await res.json().catch(() => null) as any;

    if (!res.ok) {
      const msg = explainGeminiError(res.status, json?.error?.message ?? `HTTP ${res.status}`, key, json);
      await audit({ actor: actor(c), action: "settings.gemini.test.fail", entity: "settings", entityId: "gemini", entityLabel: `${model}: ${msg}` });
      return c.json({ ok: false, model, ms, error: msg, status: res.status }, 200);
    }
    await audit({ actor: actor(c), action: "settings.gemini.test.ok", entity: "settings", entityId: "gemini", entityLabel: `${model} in ${ms}ms (no read used)` });
    return c.json({ ok: true, model, ms, reply: json?.displayName ?? model });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Request failed";
    return c.json({ ok: false, model, ms: Date.now() - started, error: msg }, 200);
  }
});
