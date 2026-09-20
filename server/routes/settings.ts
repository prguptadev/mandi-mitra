import { Hono } from "hono";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { newId, nowSec } from "../lib/ids.ts";
import { audit } from "../lib/audit.ts";
import { encryptSecret, decryptSecret, maskKey } from "../lib/secrets.ts";
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
  const next = GeminiConfigSchema.parse({ ...prev, ...cfgPatch });
  await writeSetting(biz, "gemini", JSON.stringify(next));

  if (clearKey) {
    await db.delete(schema.settings).where(and(
      eq(schema.settings.businessId, biz), eq(schema.settings.key, "gemini.apiKey"),
    ));
    await audit({ actor: actor(c), action: "settings.gemini.key.clear", entity: "settings", entityId: "gemini", entityLabel: "Gemini API key removed" });
  } else if (apiKey) {
    if (apiKey.length < 20) throw bad("That does not look like a Gemini API key", "bad_key");
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
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          contents: [{ parts: [{ text: "Reply with the single word: ready" }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 16 },
        }),
        signal: AbortSignal.timeout(20_000),
      },
    );
    const ms = Date.now() - started;
    const json = await res.json().catch(() => null) as any;

    if (!res.ok) {
      const msg = json?.error?.message ?? `HTTP ${res.status}`;
      await audit({ actor: actor(c), action: "settings.gemini.test.fail", entity: "settings", entityId: "gemini", entityLabel: `${model}: ${msg}` });
      return c.json({ ok: false, model, ms, error: msg, status: res.status }, 200);
    }

    const text = json?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";
    await audit({ actor: actor(c), action: "settings.gemini.test.ok", entity: "settings", entityId: "gemini", entityLabel: `${model} in ${ms}ms` });
    return c.json({
      ok: true, model, ms, reply: text,
      usage: json?.usageMetadata ?? null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Request failed";
    return c.json({ ok: false, model, ms: Date.now() - started, error: msg }, 200);
  }
});
