import { Hono } from "hono";
import { z } from "zod";
import { eq, and, like, or, desc, asc, sql } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { newId, nowSec } from "../lib/ids.ts";
import { audit, enqueueSync } from "../lib/audit.ts";
import { toHinglish, normKey, similarity, canonicalFirm } from "../lib/translit.ts";
import { toDevanagari, looksLatin, hasLatin } from "../lib/devanagari.ts";
import { param, can, actor, notFound, bad, type Env } from "../lib/http.ts";

export const adatiRoutes = new Hono<Env>();

const AdatiBody = z.object({
  nameHi: z.string().trim().min(1, "Hindi name is required"),
  nameHinglish: z.string().trim().optional(),
  /** true when the operator typed the Hinglish themselves — we stop regenerating it. */
  nameHinglishLocked: z.boolean().optional(),
  firmSuffix: z.string().trim().optional(),
  village: z.string().trim().optional(),
  villageHi: z.string().trim().optional(),
  phone: z.string().trim().optional(),
  accountNo: z.string().trim().optional(),
  ifsc: z.string().trim().optional(),
  openingBalanceRupees: z.number().finite().min(-1e10).max(1e10).optional(),
  notes: z.string().trim().optional(),
  active: z.boolean().optional(),
});

adatiRoutes.get("/", can("adati.read"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const q = c.req.query("q")?.trim();
  const includeInactive = c.req.query("all") === "1";

  const where = [eq(schema.adati.businessId, biz)];
  if (!includeInactive) where.push(eq(schema.adati.active, true));
  if (q) {
    where.push(or(
      like(schema.adati.nameHi, `%${q}%`),
      like(schema.adati.nameHinglish, `%${q}%`),
      like(schema.adati.village, `%${q}%`),
      like(schema.adati.phone, `%${q}%`),
    )!);
  }
  const rows = await db.select().from(schema.adati).where(and(...where)).orderBy(asc(schema.adati.nameHinglish));

  // alias counts tell the operator how much the OCR has learned per supplier
  const counts = await db.select({
    adatiId: schema.adatiAliases.adatiId,
    n: sql<number>`count(*)`.as("n"),
  }).from(schema.adatiAliases).where(eq(schema.adatiAliases.businessId, biz))
    .groupBy(schema.adatiAliases.adatiId);
  const cmap = new Map(counts.map((r) => [r.adatiId, r.n]));

  return c.json(rows.map((r) => ({ ...r, aliasCount: cmap.get(r.id) ?? 0 })));
});

/**
 * Typeahead source. Never returns the whole master — this has to stay quick
 * with a few thousand suppliers, so matching happens in SQL and the caller
 * gets a short, ranked list plus the true total.
 */
adatiRoutes.get("/search", can("adati.read"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const raw = (c.req.query("q") ?? "").trim();
  const limit = Math.min(Number(c.req.query("limit") ?? 20), 50);

  const [{ total }] = await db.select({ total: sql<number>`count(*)`.as("total") })
    .from(schema.adati)
    .where(and(eq(schema.adati.businessId, biz), eq(schema.adati.active, true)));

  if (!raw) {
    // no query yet: the ones actually used most, so the common case is one tap
    const rows = await db.select({
      id: schema.adati.id, nameHi: schema.adati.nameHi,
      nameHinglish: schema.adati.nameHinglish, village: schema.adati.village,
    })
      .from(schema.adati)
      .where(and(eq(schema.adati.businessId, biz), eq(schema.adati.active, true)))
      .orderBy(asc(schema.adati.nameHinglish))
      .limit(limit);
    return c.json({ rows, total, truncated: total > rows.length });
  }

  // a Latin query should also find the Devanagari name
  const asHindi = looksLatin(raw) ? toDevanagari(raw) : "";
  const patterns = [`${raw}%`, `%${raw}%`, ...(asHindi ? [`${asHindi}%`, `%${asHindi}%`] : [])];

  const rows = await db.select({
    id: schema.adati.id, nameHi: schema.adati.nameHi,
    nameHinglish: schema.adati.nameHinglish, village: schema.adati.village,
  })
    .from(schema.adati)
    .where(and(
      eq(schema.adati.businessId, biz),
      eq(schema.adati.active, true),
      or(...patterns.flatMap((p) => [
        like(schema.adati.nameHi, p),
        like(schema.adati.nameHinglish, p),
      ]), like(schema.adati.village, `%${raw}%`))!,
    ))
    .limit(limit * 3);

  // rank: prefix hits first, then by closeness
  const q = raw.toLowerCase();
  const qh = asHindi;
  const ranked = rows
    .map((r) => {
      const hi = r.nameHi.toLowerCase();
      const lat = r.nameHinglish.toLowerCase();
      const prefix = lat.startsWith(q) || hi.startsWith(q) || (qh && r.nameHi.startsWith(qh));
      const score = Math.max(
        similarity(raw, r.nameHi),
        similarity(raw, r.nameHinglish),
        qh ? similarity(qh, r.nameHi) : 0,
      );
      return { r, rank: (prefix ? 1 : 0) + score };
    })
    .sort((a, b) => b.rank - a.rank)
    .slice(0, limit)
    .map((x) => x.r);

  return c.json({ rows: ranked, total, truncated: rows.length > ranked.length });
});

/** Live Hinglish -> Hindi while typing, using this business's own spellings. */
adatiRoutes.post("/to-devanagari", can("adati.read"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const { text } = z.object({ text: z.string() }).parse(await c.req.json());
  if (!hasLatin(text)) return c.json({ hindi: text, converted: false });

  const master = await db.select({ hi: schema.adati.nameHi, lat: schema.adati.nameHinglish })
    .from(schema.adati)
    .where(and(eq(schema.adati.businessId, biz), eq(schema.adati.active, true)));

  const known = new Map<string, string>();
  for (const m of master) {
    known.set(m.lat.toLowerCase(), m.hi);
    // individual words too, so a new name reuses the spellings already in use
    const hiWords = m.hi.split(/\s+/);
    const latWords = m.lat.split(/\s+/);
    if (hiWords.length === latWords.length) {
      for (let i = 0; i < hiWords.length; i++) {
        const k = latWords[i].toLowerCase();
        if (!known.has(k)) known.set(k, hiWords[i]);
      }
    }
  }

  return c.json({ hindi: toDevanagari(text, { known }), converted: true });
});

adatiRoutes.get("/:id", can("adati.read"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const [row] = await db.select().from(schema.adati)
    .where(and(eq(schema.adati.id, param(c, "id")), eq(schema.adati.businessId, biz))).limit(1);
  if (!row) throw notFound("Supplier not found");
  const aliases = await db.select().from(schema.adatiAliases)
    .where(eq(schema.adatiAliases.adatiId, row.id)).orderBy(desc(schema.adatiAliases.hits));
  return c.json({ ...row, aliases });
});

adatiRoutes.post("/", can("adati.write"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const body = AdatiBody.parse(await c.req.json());

  const [dupe] = await db.select({ id: schema.adati.id }).from(schema.adati)
    .where(and(eq(schema.adati.businessId, biz), eq(schema.adati.nameHi, body.nameHi))).limit(1);
  if (dupe) throw bad("A supplier with that Hindi name already exists", "duplicate");

  const id = newId();
  const values = {
    id, businessId: biz,
    nameHi: body.nameHi,
    nameHinglish: body.nameHinglish?.trim() || toHinglish(body.nameHi),
    nameHinglishLocked: body.nameHinglishLocked ?? Boolean(body.nameHinglish?.trim()),
    firmSuffix: body.firmSuffix || null,
    village: body.village || null,
    villageHi: body.villageHi || null,
    phone: body.phone || null,
    accountNo: body.accountNo || null,
    ifsc: body.ifsc || null,
    openingBalancePaise: Math.round((body.openingBalanceRupees ?? 0) * 100),
    notes: body.notes || null,
    active: body.active ?? true,
  };
  await db.insert(schema.adati).values(values);

  // the canonical spelling is itself an alias, so OCR can hit it directly
  await db.insert(schema.adatiAliases).values({
    id: newId(), businessId: biz, adatiId: id,
    rawText: body.nameHi, normKey: normKey(body.nameHi),
    source: "canonical", createdBy: c.get("auth")!.user.id,
  }).onConflictDoNothing();

  await audit({ actor: actor(c), action: "adati.create", entity: "adati", entityId: id, entityLabel: values.nameHinglish, after: values });
  await enqueueSync(biz, "adati", id, "insert", values);
  return c.json({ id });
});

adatiRoutes.put("/:id", can("adati.write"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const id = param(c, "id");
  const body = AdatiBody.partial().parse(await c.req.json());

  const [before] = await db.select().from(schema.adati)
    .where(and(eq(schema.adati.id, id), eq(schema.adati.businessId, biz))).limit(1);
  if (!before) throw notFound("Supplier not found");

  const patch: Record<string, unknown> = { updatedAt: nowSec() };
  if (body.nameHi !== undefined) {
    patch.nameHi = body.nameHi;
    // regenerate Hinglish only while it is still machine-generated
    if (!before.nameHinglishLocked && body.nameHinglish === undefined) {
      patch.nameHinglish = toHinglish(body.nameHi);
    }
  }
  if (body.nameHinglish !== undefined) {
    patch.nameHinglish = body.nameHinglish.trim();
    patch.nameHinglishLocked = true; // a human decided this spelling
  }
  if (body.nameHinglishLocked !== undefined) patch.nameHinglishLocked = body.nameHinglishLocked;
  for (const k of ["firmSuffix", "village", "villageHi", "phone", "accountNo", "ifsc", "notes"] as const) {
    if (body[k] !== undefined) patch[k] = body[k] || null;
  }
  if (body.openingBalanceRupees !== undefined) patch.openingBalancePaise = Math.round(body.openingBalanceRupees * 100);
  if (body.active !== undefined) patch.active = body.active;

  await db.update(schema.adati).set(patch).where(eq(schema.adati.id, id));
  const [after] = await db.select().from(schema.adati).where(eq(schema.adati.id, id)).limit(1);

  if (body.nameHi && body.nameHi !== before.nameHi) {
    // old spelling stays searchable — the employee may write it either way
    await db.insert(schema.adatiAliases).values({
      id: newId(), businessId: biz, adatiId: id,
      rawText: before.nameHi, normKey: normKey(before.nameHi),
      source: "rename", createdBy: c.get("auth")!.user.id,
    }).onConflictDoNothing();
  }

  await audit({ actor: actor(c), action: "adati.update", entity: "adati", entityId: id, entityLabel: after!.nameHinglish, before, after });
  await enqueueSync(biz, "adati", id, "update", after);
  return c.json({ ok: true });
});

adatiRoutes.delete("/:id", can("adati.delete"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const id = param(c, "id");
  const [before] = await db.select().from(schema.adati)
    .where(and(eq(schema.adati.id, id), eq(schema.adati.businessId, biz))).limit(1);
  if (!before) throw notFound("Supplier not found");

  const [slip] = await db.select({ id: schema.purchaseSlips.id }).from(schema.purchaseSlips)
    .where(eq(schema.purchaseSlips.adatiId, id)).limit(1);
  const [pay] = await db.select({ id: schema.payments.id }).from(schema.payments)
    .where(eq(schema.payments.adatiId, id)).limit(1);
  // a slip, a payment or an opening balance is money on the ledger: keep the supplier, make it inactive
  if (slip || pay || before.openingBalancePaise !== 0) {
    await db.update(schema.adati).set({ active: false, updatedAt: nowSec() }).where(eq(schema.adati.id, id));
    await audit({ actor: actor(c), action: "adati.deactivate", entity: "adati", entityId: id, entityLabel: before.nameHinglish, before, after: { ...before, active: false } });
    return c.json({ ok: true, deactivated: true, reason: "This supplier has slips, payments or an opening balance, so it was made inactive instead of deleted." });
  }
  await db.delete(schema.adati).where(eq(schema.adati.id, id));
  await audit({ actor: actor(c), action: "adati.delete", entity: "adati", entityId: id, entityLabel: before.nameHinglish, before });
  await enqueueSync(biz, "adati", id, "delete");
  return c.json({ ok: true, deactivated: false });
});

/* -------------------------------------------------------- OCR name learning */

/**
 * Resolve a raw (possibly misread) Hindi name to a supplier.
 *  1. exact alias hit  -> confidence 1.0, no guessing
 *  2. normalised key   -> matras/nasals stripped, confusable consonants folded
 *  3. fuzzy similarity -> ranked suggestions above 0.62
 */
adatiRoutes.post("/resolve", can("adati.read"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const { text, limit } = z.object({ text: z.string(), limit: z.number().optional() })
    .parse(await c.req.json());
  const raw = text.trim();
  if (!raw) return c.json({ match: null, suggestions: [] });

  const [exact] = await db.select({
    adatiId: schema.adatiAliases.adatiId, hits: schema.adatiAliases.hits,
  }).from(schema.adatiAliases)
    .where(and(eq(schema.adatiAliases.businessId, biz), eq(schema.adatiAliases.rawText, raw))).limit(1);

  const all = await db.select().from(schema.adati)
    .where(and(eq(schema.adati.businessId, biz), eq(schema.adati.active, true)));
  const byId = new Map(all.map((a) => [a.id, a]));

  if (exact && byId.has(exact.adatiId)) {
    const a = byId.get(exact.adatiId)!;
    return c.json({
      match: { adatiId: a.id, nameHi: a.nameHi, nameHinglish: a.nameHinglish, confidence: 1, via: "alias" },
      suggestions: [],
    });
  }

  const key = normKey(raw);
  const aliases = await db.select().from(schema.adatiAliases)
    .where(and(eq(schema.adatiAliases.businessId, biz), eq(schema.adatiAliases.normKey, key)));
  const keyHit = aliases.find((al) => byId.has(al.adatiId));
  if (keyHit) {
    const a = byId.get(keyHit.adatiId)!;
    return c.json({
      match: { adatiId: a.id, nameHi: a.nameHi, nameHinglish: a.nameHinglish, confidence: 0.95, via: "normkey" },
      suggestions: [],
    });
  }

  const scored = all
    .map((a) => ({ a, score: Math.max(similarity(raw, a.nameHi), similarity(raw, a.nameHinglish)) }))
    .filter((s) => s.score >= 0.62)
    .sort((x, y) => y.score - x.score)
    .slice(0, Math.min(limit ?? 3, 3));

  const best = scored[0];
  return c.json({
    match: best && best.score >= 0.82
      ? { adatiId: best.a.id, nameHi: best.a.nameHi, nameHinglish: best.a.nameHinglish, confidence: best.score, via: "fuzzy" }
      : null,
    suggestions: scored.map((s) => ({
      adatiId: s.a.id, nameHi: s.a.nameHi, nameHinglish: s.a.nameHinglish,
      village: s.a.village, confidence: Number(s.score.toFixed(3)),
    })),
  });
});

/** Teach the system: this raw reading meant this supplier. */
adatiRoutes.post("/learn", can("adati.write"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const { adatiId, rawText, source } = z.object({
    adatiId: z.string(), rawText: z.string().trim().min(1),
    source: z.enum(["correction", "ocr", "manual"]).optional(),
  }).parse(await c.req.json());

  const [a] = await db.select().from(schema.adati)
    .where(and(eq(schema.adati.id, adatiId), eq(schema.adati.businessId, biz))).limit(1);
  if (!a) throw notFound("Supplier not found");

  const [existing] = await db.select().from(schema.adatiAliases)
    .where(and(eq(schema.adatiAliases.businessId, biz), eq(schema.adatiAliases.rawText, rawText))).limit(1);

  if (existing) {
    await db.update(schema.adatiAliases).set({
      adatiId, hits: existing.hits + 1, lastUsedAt: nowSec(),
      normKey: normKey(rawText),
    }).where(eq(schema.adatiAliases.id, existing.id));
    await audit({ actor: actor(c), action: "adati.alias.reinforce", entity: "adati_alias", entityId: existing.id, entityLabel: `${rawText} -> ${a.nameHinglish}`, before: existing, after: { adatiId, hits: existing.hits + 1 } });
    return c.json({ ok: true, hits: existing.hits + 1 });
  }

  const id = newId();
  await db.insert(schema.adatiAliases).values({
    id, businessId: biz, adatiId, rawText, normKey: normKey(rawText),
    source: source ?? "correction", createdBy: c.get("auth")!.user.id,
  });
  await audit({ actor: actor(c), action: "adati.alias.create", entity: "adati_alias", entityId: id, entityLabel: `${rawText} -> ${a.nameHinglish}`, after: { rawText, adatiId } });
  return c.json({ ok: true, hits: 1 });
});

adatiRoutes.delete("/alias/:aliasId", can("adati.write"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const id = param(c, "aliasId");
  const [before] = await db.select().from(schema.adatiAliases)
    .where(and(eq(schema.adatiAliases.id, id), eq(schema.adatiAliases.businessId, biz))).limit(1);
  if (!before) throw notFound("Alias not found");
  await db.delete(schema.adatiAliases).where(eq(schema.adatiAliases.id, id));
  await audit({ actor: actor(c), action: "adati.alias.delete", entity: "adati_alias", entityId: id, entityLabel: before.rawText, before });
  return c.json({ ok: true });
});

/** Re-run transliteration over every name still unlocked. */
adatiRoutes.post("/regenerate-hinglish", can("adati.write"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const rows = await db.select().from(schema.adati).where(and(
    eq(schema.adati.businessId, biz), eq(schema.adati.nameHinglishLocked, false),
  ));
  let changed = 0;
  for (const r of rows) {
    const next = toHinglish(r.nameHi);
    if (next && next !== r.nameHinglish) {
      await db.update(schema.adati).set({ nameHinglish: next, updatedAt: nowSec() }).where(eq(schema.adati.id, r.id));
      changed++;
    }
  }
  await audit({ actor: actor(c), action: "adati.regenerate_hinglish", entity: "adati", entityLabel: `${changed} updated`, after: { scanned: rows.length, changed } });
  return c.json({ scanned: rows.length, changed, skippedLocked: true });
});
