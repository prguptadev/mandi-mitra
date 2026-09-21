import { Hono } from "hono";
import { z } from "zod";
import { eq, and, desc, inArray, sql, gte, lte, like } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";
import { db, schema } from "../db/client.ts";
import { newId, nowSec } from "../lib/ids.ts";
import { audit, enqueueSync } from "../lib/audit.ts";
import { decryptSecret } from "../lib/secrets.ts";
import { GeminiConfigSchema, defaultGeminiConfig, DisplayConfigSchema, defaultDisplayConfig } from "../lib/display.ts";
import { ChargeConfigSchema, KatautiSchema, type Katauti } from "../lib/charges.ts";
import { readSheet } from "../lib/gemini.ts";
import { loadResolver } from "../lib/adatiResolve.ts";
import { normKey, toHinglish } from "../lib/translit.ts";
import {
  ReviewRowSchema, ocrToReviewRow, checkRow, findDupes,
  type ReviewRow, type CheckedRow,
} from "../lib/scanRows.ts";
import { deriveSlip } from "./slips.ts";
import { can, actor, param, notFound, bad, requireBusiness, HttpError, type Env } from "../lib/http.ts";

export const scanRoutes = new Hono<Env>();

/* Reading a full sheet takes 20-60s. It runs detached from the request so the
 * operator can switch tabs, open the daily list, or close the page entirely
 * without killing it. The browser polls the batch instead of holding a socket
 * open, so nothing is lost by navigating away and coming back. */
const inFlight = new Set<string>();

/** A process restart leaves reads orphaned; nothing is running for them. */
export function recoverInterruptedScans() {
  const stale = db.select({ id: schema.scanBatches.id }).from(schema.scanBatches)
    .where(eq(schema.scanBatches.status, "reading")).all();
  if (!stale.length) return 0;
  for (const s of stale) {
    db.update(schema.scanBatches).set({
      status: "uploaded",
      warningText: "The reader was interrupted before it finished. Start it again.",
    }).where(eq(schema.scanBatches.id, s.id)).run();
  }
  return stale.length;
}

const DATA_DIR = process.env.MANDI_DATA_DIR ?? path.resolve(process.cwd(), "data");
const SCAN_DIR = path.join(DATA_DIR, "scans");
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_BYTES = 12 * 1024 * 1024;
const OK_TYPES = new Set([
  "image/jpeg", "image/jpg", "image/png", "image/webp",
  "image/heic", "image/heif", "image/tiff", "image/bmp", "application/pdf",
]);
/** Phones and scanner drivers often send an empty or generic MIME type. */
const EXT_TYPES: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
  heic: "image/heic", heif: "image/heif", tif: "image/tiff", tiff: "image/tiff",
  bmp: "image/bmp", pdf: "application/pdf",
};

function resolveType(file: File): string | null {
  const declared = (file.type || "").toLowerCase();
  if (OK_TYPES.has(declared)) return declared === "image/jpg" ? "image/jpeg" : declared;
  // fall back to the extension when the browser says nothing useful
  if (!declared || declared === "application/octet-stream" || declared === "binary/octet-stream") {
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    return EXT_TYPES[ext] ?? null;
  }
  return null;
}

async function setting(businessId: string, key: string) {
  const [row] = await db.select().from(schema.settings)
    .where(and(eq(schema.settings.businessId, businessId), eq(schema.settings.key, key))).limit(1);
  return row?.value ?? null;
}

async function katautiFor(businessId: string, merchantId: string | null): Promise<Katauti> {
  if (merchantId) {
    const [m] = await db.select({ cfg: schema.merchants.chargeConfig }).from(schema.merchants)
      .where(and(eq(schema.merchants.id, merchantId), eq(schema.merchants.businessId, businessId))).limit(1);
    if (m) {
      const p = ChargeConfigSchema.safeParse(JSON.parse(m.cfg));
      if (p.success) return p.data.katauti;
    }
  }
  const raw = await setting(businessId, "display");
  const d = raw ? DisplayConfigSchema.safeParse(JSON.parse(raw)) : null;
  const cfg = d?.success ? d.data : defaultDisplayConfig();
  return KatautiSchema.parse({
    mode: cfg.katautiMode, kgPerUnit: cfg.katautiKgPerUnit, rounding: cfg.katautiRounding,
  });
}

/** Written next to the images; refreshed whenever the tagging changes. */
function writeScanMeta(id: string, meta: Record<string, unknown>) {
  try {
    fs.writeFileSync(path.join(SCAN_DIR, id, "meta.json"), JSON.stringify(meta, null, 2));
  } catch (err) {
    console.error("[scan] could not write meta.json", id, err);
  }
}

async function refreshScanMeta(businessId: string, id: string) {
  const [b] = await db.select().from(schema.scanBatches)
    .where(and(eq(schema.scanBatches.id, id), eq(schema.scanBatches.businessId, businessId))).limit(1);
  if (!b) return;
  const [m] = b.merchantId
    ? await db.select({ code: schema.merchants.code, name: schema.merchants.name })
        .from(schema.merchants).where(eq(schema.merchants.id, b.merchantId)).limit(1)
    : [null];
  const [j] = b.jinsId
    ? await db.select({ code: schema.jins.code }).from(schema.jins).where(eq(schema.jins.id, b.jinsId)).limit(1)
    : [null];
  writeScanMeta(id, {
    scanId: id, businessId, status: b.status,
    slipDate: b.slipDate,
    mill: m ? { code: m.code, name: m.name } : null,
    jins: j?.code ?? null,
    model: b.model,
    files: JSON.parse(b.filePaths),
    updatedAt: new Date().toISOString(),
  });
}

async function loadBatch(businessId: string, id: string) {
  const [b] = await db.select().from(schema.scanBatches)
    .where(and(eq(schema.scanBatches.id, id), eq(schema.scanBatches.businessId, businessId))).limit(1);
  if (!b) throw notFound("Scan not found");
  return b;
}

/** Re-runs every check. Nothing is cached — the answer must follow the edits. */
async function checkAll(businessId: string, batch: typeof schema.scanBatches.$inferSelect) {
  const rows: ReviewRow[] = batch.parsedRows ? JSON.parse(batch.parsedRows) : [];
  const katauti = await katautiFor(businessId, batch.merchantId);
  const resolver = await loadResolver(businessId);

  const existingRst = new Set<string>();
  if (batch.slipDate) {
    const taken = await db.select({ rstNo: schema.purchaseSlips.rstNo }).from(schema.purchaseSlips)
      .where(and(
        eq(schema.purchaseSlips.businessId, businessId),
        eq(schema.purchaseSlips.slipDate, batch.slipDate),
      ));
    for (const r of taken) existingRst.add(r.rstNo);
  }

  const dupeInBatch = findDupes(rows);
  const checked: CheckedRow[] = rows.map((r) => checkRow(r, {
    katauti, resolve: resolver.resolve, byId: resolver.byId, existingRst, dupeInBatch,
    rateFloorPaise: 200_000, rateCeilPaise: 600_000,
  }));

  const active = checked.filter((r) => !r.excluded);
  return {
    rows: checked,
    katauti,
    summary: {
      total: checked.length,
      included: active.length,
      excluded: checked.length - active.length,
      blocking: active.filter((r) => r.blocking).length,
      warnings: active.filter((r) => !r.blocking && r.issues.length > 0).length,
      clean: active.filter((r) => r.issues.length === 0).length,
      autoMatchedNames: active.filter((r) => r.adatiId || r.match).length,
      netAgreeing: active.filter((r) => r.netAgrees === true).length,
      netChecked: active.filter((r) => r.netAgrees !== null).length,
      totalNetGrams: active.reduce((s, r) => s + (r.derivedNetGrams ?? 0), 0),
      totalAmountPaise: active.reduce((s, r) => s + (r.derivedAmountPaise ?? 0), 0),
      meanConfidence: active.length
        ? active.reduce((s, r) => s + (r.ocr.confidence ?? 0), 0) / active.length
        : 0,
    },
  };
}

/* ------------------------------------------------------------------ upload */

scanRoutes.post("/", can("scan.create"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const body = await c.req.parseBody({ all: true });

  // accept whatever field name the client used, so a stray key is not fatal
  const candidates = [body["files"], body["file"], ...Object.values(body)];
  const files: File[] = [];
  for (const v of candidates) {
    for (const item of Array.isArray(v) ? v : [v]) {
      if (item instanceof File && !files.includes(item)) files.push(item);
    }
  }
  if (!files.length) {
    throw bad(
      "No file reached the server. Pick the scan again — if it still fails, try dragging the file onto the box.",
      "no_file",
    );
  }
  if (files.length > 10) throw bad("Ten pages at a time is the limit", "too_many");

  const id = newId();
  const dir = path.join(SCAN_DIR, id);
  fs.mkdirSync(dir, { recursive: true });

  const saved: { name: string; mimeType: string; bytes: number }[] = [];
  for (const [i, file] of files.entries()) {
    const mimeType = resolveType(file);
    if (!mimeType) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw bad(`"${file.name}" is a ${file.type || "unknown"} file. Use JPG, PNG, WEBP or PDF.`, "bad_type");
    }
    if (file.size === 0) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw bad(`"${file.name}" is empty. Scan it again.`, "empty_file");
    }
    if (file.size > MAX_BYTES) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw bad(`"${file.name}" is over 12 MB. Scan at 200–300 dpi instead.`, "too_big");
    }
    const ext = mimeType === "application/pdf" ? "pdf"
      : mimeType === "image/png" ? "png"
      : mimeType === "image/webp" ? "webp"
      : mimeType === "image/heic" || mimeType === "image/heif" ? "heic"
      : mimeType === "image/tiff" ? "tiff"
      : mimeType === "image/bmp" ? "bmp" : "jpg";
    const name = `${String(i).padStart(2, "0")}.${ext}`;
    fs.writeFileSync(path.join(dir, name), Buffer.from(await file.arrayBuffer()));
    saved.push({ name, mimeType, bytes: file.size });
  }

  const slipDate = typeof body["slipDate"] === "string" && ISO_DATE.test(body["slipDate"])
    ? body["slipDate"] : null;
  const merchantId = typeof body["merchantId"] === "string" && body["merchantId"] ? body["merchantId"] : null;
  const jinsId = typeof body["jinsId"] === "string" && body["jinsId"] ? body["jinsId"] : null;
  const sourceKind = typeof body["sourceKind"] === "string" ? body["sourceKind"] : "upload";

  /* A sidecar so the folder means something when browsed in Finder or
     Explorer, and so the images can still be tagged if the DB is ever lost. */
  writeScanMeta(id, {
    scanId: id, businessId: biz, uploadedAt: new Date().toISOString(),
    uploadedBy: c.get("auth")!.user.name,
    slipDate, merchantId, jinsId, sourceKind,
    files: saved,
  });

  await db.insert(schema.scanBatches).values({
    id, businessId: biz, sourceKind,
    filePaths: JSON.stringify(saved),
    slipDate, merchantId, jinsId,
    status: "uploaded",
    createdBy: c.get("auth")!.user.id,
  });
  await audit({
    actor: actor(c), action: "scan.upload", entity: "scan_batch", entityId: id,
    entityLabel: `${saved.length} page${saved.length === 1 ? "" : "s"}${slipDate ? ` for ${slipDate}` : ""}`,
    after: { files: saved.map((f) => f.name), slipDate, merchantId },
  });
  return c.json({ id, pages: saved.length });
});

/* --------------------------------------------------------------------- run */

/** Does the actual reading. Never awaited by the request handler. */
async function performRead(opts: {
  biz: string; id: string; apiKey: string;
  cfg: ReturnType<typeof defaultGeminiConfig>; wanted?: string;
  actorInfo: { userId: string | null; userName: string | null };
}) {
  const { biz, id, apiKey, cfg, wanted } = opts;
  const batch = await loadBatch(biz, id);
  const files: { name: string; mimeType: string }[] = JSON.parse(batch.filePaths);
  const dir = path.join(SCAN_DIR, id);
  const images = files.map((f) => ({
    base64: fs.readFileSync(path.join(dir, f.name)).toString("base64"),
    mimeType: f.mimeType,
  }));

  let result = await readSheet({
    apiKey, model: wanted ?? cfg.model, images,
    maxOutputTokens: cfg.maxOutputTokens, temperature: cfg.temperature,
  });

  /* A weak first pass is read again on the stronger model. "Weak" is not just
     a low average: a page can average 0.9 and still have a handful of rows the
     reader clearly struggled with, or come back with names and weights
     missing. Any of those is worth the second call. */
  function weakness(r: typeof result): { weak: boolean; why: string } | null {
    if (!r.ok || !r.page) return { weak: true, why: "the first pass failed" };
    const rows = r.page.rows;
    if (!rows.length) return { weak: true, why: "no rows came back" };
    const mean = rows.reduce((a, x) => a + (x.confidence ?? 0), 0) / rows.length;
    if (mean < cfg.fallbackBelowConfidence) return { weak: true, why: `average confidence ${mean.toFixed(2)}` };
    const shaky = rows.filter((x) => (x.confidence ?? 1) < 0.6).length;
    if (shaky / rows.length > 0.15) return { weak: true, why: `${shaky} rows read poorly` };
    const missingName = rows.filter((x) => !x.adatiName?.trim()).length;
    if (missingName / rows.length > 0.1) return { weak: true, why: `${missingName} names not read` };
    const missingGross = rows.filter((x) => x.grossQtl == null).length;
    if (missingGross / rows.length > 0.1) return { weak: true, why: `${missingGross} weights not read` };
    if (r.truncated) return { weak: true, why: "the reply was cut short" };
    return null;
  }

  let usedFallback = false;
  let fallbackReason: string | null = null;
  const weak = weakness(result);
  if (!wanted && weak && cfg.fallbackModel && cfg.fallbackModel !== cfg.model) {
    const second = await readSheet({
      apiKey, model: cfg.fallbackModel, images,
      maxOutputTokens: cfg.maxOutputTokens, temperature: cfg.temperature,
    });
    // only keep the retry if it is genuinely no worse
    if (second.ok && !weakness(second)) {
      result = second; usedFallback = true; fallbackReason = weak.why;
    } else if (second.ok && !result.ok) {
      result = second; usedFallback = true; fallbackReason = weak.why;
    }
  }

  if (!result.ok || !result.page) {
    await db.update(schema.scanBatches).set({
      status: "failed", errorText: result.error ?? "Unknown error", warningText: null,
      model: result.model, rawResponse: JSON.stringify(result.raw ?? null).slice(0, 40000),
      tokensIn: result.tokensIn ?? null, tokensOut: result.tokensOut ?? null,
    }).where(eq(schema.scanBatches.id, id));
    await audit({
      actor: { ...opts.actorInfo, businessId: biz },
      action: "scan.read.fail", entity: "scan_batch", entityId: id,
      entityLabel: result.error ?? "failed",
    });
    return;
  }

  /* Someone will upload a photo of something else — a parcha, a bill, a
     thumb over the lens. Say so plainly instead of presenting an empty grid
     and letting them wonder whether the reader is broken. */
  const usable = result.page.rows.filter(
    (r) => (r.rstNo && r.rstNo.trim()) || r.grossQtl != null || (r.adatiName && r.adatiName.trim()),
  );
  if (usable.length === 0) {
    await db.update(schema.scanBatches).set({
      status: "failed",
      errorText: result.page.rows.length === 0
        ? "Nothing on this image looks like a daily list. Check it is the purchase register page, right way up and in focus."
        : "This image was read, but none of the rows carry an RST number, a supplier or a weight. It may not be a daily list page.",
      model: result.model,
      rawResponse: JSON.stringify(result.raw ?? null).slice(0, 40000),
      tokensIn: result.tokensIn ?? null, tokensOut: result.tokensOut ?? null,
    }).where(eq(schema.scanBatches.id, id));
    await audit({
      actor: { ...opts.actorInfo, businessId: biz },
      action: "scan.read.empty", entity: "scan_batch", entityId: id,
      entityLabel: `${result.model} found no usable rows`,
    });
    return;
  }

  const rows: ReviewRow[] = result.page.rows.map(ocrToReviewRow);
  const warning = result.truncated
    ? `The reply was cut short, so ${rows.length} complete rows were recovered. Check the bottom of the sheet for any row that did not come through.`
    : usedFallback
    ? `Read again on ${result.model} because ${fallbackReason}.`
    : null;
  await db.update(schema.scanBatches).set({
    status: "review",
    warningText: warning,
    model: result.model,
    parsedRows: JSON.stringify(rows),
    rawResponse: JSON.stringify(result.raw).slice(0, 200000),
    tokensIn: result.tokensIn ?? null,
    tokensOut: result.tokensOut ?? null,
    errorText: null,
    // keep whatever the header said, without overwriting an explicit choice
    slipDate: batch.slipDate,
  }).where(eq(schema.scanBatches.id, id));

  await audit({
    actor: { ...opts.actorInfo, businessId: biz },
    action: "scan.read", entity: "scan_batch", entityId: id,
    entityLabel: `${rows.length} rows via ${result.model}${usedFallback ? " (fallback)" : ""}${result.truncated ? " (recovered from a truncated reply)" : ""} in ${result.ms} ms`,
    after: { rows: rows.length, model: result.model, ms: result.ms, tokensIn: result.tokensIn, tokensOut: result.tokensOut },
  });
}

/** Starts the read and returns immediately. Poll GET /scans/:id for progress. */
scanRoutes.post("/:id/run", can("scan.create"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const id = param(c, "id");
  const batch = await loadBatch(biz, id);
  if (batch.status === "committed") throw new HttpError(409, "This scan is already on the daily list", "already_committed");
  if (inFlight.has(id)) return c.json({ started: true, alreadyRunning: true });

  const keyRaw = await setting(biz, "gemini.apiKey");
  const apiKey = keyRaw ? decryptSecret(keyRaw) : null;
  if (!apiKey) throw bad("Add the Gemini API key in Settings first", "no_key");

  const cfgRaw = await setting(biz, "gemini");
  const cfg = cfgRaw ? GeminiConfigSchema.parse(JSON.parse(cfgRaw)) : defaultGeminiConfig();
  const wanted = (await c.req.json().catch(() => ({})))?.model as string | undefined;
  const actorInfo = { userId: c.get("auth")!.user.id, userName: c.get("auth")!.user.name };

  await db.update(schema.scanBatches)
    .set({ status: "reading", errorText: null, warningText: null })
    .where(eq(schema.scanBatches.id, id));

  inFlight.add(id);
  void performRead({ biz, id, apiKey, cfg, wanted, actorInfo })
    .catch(async (err) => {
      console.error("[scan]", id, err);
      await db.update(schema.scanBatches).set({
        status: "failed",
        errorText: err instanceof Error ? err.message : "The reader stopped unexpectedly",
      }).where(eq(schema.scanBatches.id, id));
    })
    .finally(() => inFlight.delete(id));

  return c.json({ started: true });
});

/* ------------------------------------------------------------------ review */

scanRoutes.get("/:id", can("scan.review", "scan.create"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const batch = await loadBatch(biz, param(c, "id"));
  const checked = batch.parsedRows ? await checkAll(biz, batch) : { rows: [], summary: null, katauti: null };
  const files: { name: string; mimeType: string; bytes: number }[] = JSON.parse(batch.filePaths);
  return c.json({
    id: batch.id, status: batch.status, sourceKind: batch.sourceKind,
    slipDate: batch.slipDate, merchantId: batch.merchantId, jinsId: batch.jinsId,
    model: batch.model, errorText: batch.errorText, warningText: batch.warningText,
    running: inFlight.has(batch.id),
    tokensIn: batch.tokensIn, tokensOut: batch.tokensOut,
    createdAt: batch.createdAt, reviewedAt: batch.reviewedAt,
    pages: files.map((f, i) => ({ index: i, name: f.name, mimeType: f.mimeType, bytes: f.bytes })),
    ...checked,
  });
});

/**
 * A scan lives in one business. Opening its link from another is the usual
 * cause of "not found", so say where it actually is instead of stopping dead.
 * Only reports businesses this user is already a member of.
 */
scanRoutes.get("/:id/whereis", requireBusiness, async (c) => {
  const auth = c.get("auth")!;
  const id = param(c, "id");
  const [batch] = await db.select({ businessId: schema.scanBatches.businessId })
    .from(schema.scanBatches).where(eq(schema.scanBatches.id, id)).limit(1);
  if (!batch) return c.json({ found: false });

  const [m] = await db.select({
    businessId: schema.businesses.id,
    name: schema.businesses.name,
    shortCode: schema.businesses.shortCode,
  })
    .from(schema.memberships)
    .innerJoin(schema.businesses, eq(schema.businesses.id, schema.memberships.businessId))
    .where(and(
      eq(schema.memberships.userId, auth.user.id),
      eq(schema.memberships.businessId, batch.businessId),
      eq(schema.memberships.active, true),
    )).limit(1);

  // a member of that business gets told where to go; anyone else gets nothing
  return c.json(m ? { found: true, ...m } : { found: false });
});

scanRoutes.get("/:id/page/:index", can("scan.review", "scan.create"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const batch = await loadBatch(biz, param(c, "id"));
  const files: { name: string; mimeType: string }[] = JSON.parse(batch.filePaths);
  const file = files[Number(param(c, "index"))];
  if (!file) throw notFound("Page not found");
  const full = path.join(SCAN_DIR, batch.id, file.name);
  if (!fs.existsSync(full)) throw notFound("Image file is missing from disk");
  return new Response(fs.readFileSync(full), {
    headers: { "Content-Type": file.mimeType, "Cache-Control": "private, max-age=3600" },
  });
});

/** Save edits. Sends back the freshly re-checked rows so the UI stays honest. */
scanRoutes.put("/:id/rows", can("scan.review"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const id = param(c, "id");
  const batch = await loadBatch(biz, id);
  if (batch.status === "committed") throw new HttpError(409, "This scan has already been added to the daily list", "already_committed");

  const { rows, slipDate, merchantId, jinsId } = z.object({
    rows: z.array(ReviewRowSchema),
    slipDate: z.string().regex(ISO_DATE).nullish(),
    merchantId: z.string().nullish(),
    jinsId: z.string().nullish(),
  }).parse(await c.req.json());

  await db.update(schema.scanBatches).set({
    parsedRows: JSON.stringify(rows),
    ...(slipDate !== undefined ? { slipDate: slipDate ?? null } : {}),
    ...(merchantId !== undefined ? { merchantId: merchantId ?? null } : {}),
    ...(jinsId !== undefined ? { jinsId: jinsId ?? null } : {}),
    status: batch.status === "failed" ? "review" : batch.status,
  }).where(eq(schema.scanBatches.id, id));

  const fresh = await loadBatch(biz, id);
  await refreshScanMeta(biz, id);
  return c.json(await checkAll(biz, fresh));
});

/* ------------------------------------------------------------------ commit */

scanRoutes.post("/:id/commit", can("scan.review", "slip.write"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const userId = c.get("auth")!.user.id;
  const id = param(c, "id");
  const batch = await loadBatch(biz, id);
  if (batch.status === "committed") throw new HttpError(409, "This scan has already been added to the daily list", "already_committed");
  if (!batch.slipDate) throw bad("Set the sheet date before adding it to the daily list", "no_date");
  if (!batch.jinsId) throw bad("Set the commodity before adding it to the daily list", "no_jins");

  const { rows, summary, katauti } = await checkAll(biz, batch);
  const toWrite = rows.filter((r) => !r.excluded);
  if (!toWrite.length) throw bad("Every row is excluded — nothing to add", "nothing_to_commit");
  if (summary && summary.blocking > 0) {
    throw new HttpError(409, `${summary.blocking} row${summary.blocking === 1 ? "" : "s"} still need fixing before this can be added`, "has_blocking");
  }

  const created: string[] = [];
  const learned: { rawText: string; adatiId: string }[] = [];

  for (const r of toWrite) {
    const adatiId = r.adatiId ?? r.match?.adatiId;
    if (!adatiId || r.grossGrams === null) continue;

    const d = deriveSlip(r.grossGrams, katauti!, r.ratePaisePerQtl ?? 0, r.katautiOverride);
    const slipId = newId();
    await db.insert(schema.purchaseSlips).values({
      id: slipId, businessId: biz,
      slipDate: batch.slipDate, rstNo: r.rstNo,
      adatiId, jinsId: batch.jinsId,
      merchantId: batch.merchantId,
      grossGrams: r.grossGrams,
      katautiUnits: d.katautiUnits,
      katautiOverride: r.katautiOverride != null,
      netGrams: d.netGrams,
      ratePaisePerQtl: r.ratePaisePerQtl ?? 0,
      amountPaise: d.amountPaise,
      scanBatchId: id,
      ocrConfidence: r.ocr.confidence ?? null,
      enteredBy: userId,
    });
    created.push(slipId);
    await enqueueSync(biz, "purchase_slip", slipId, "insert", { rstNo: r.rstNo, adatiId });

    // teach the resolver: this reading meant this supplier
    const raw = r.adatiRawText.trim();
    if (raw) {
      const [existing] = await db.select().from(schema.adatiAliases)
        .where(and(eq(schema.adatiAliases.businessId, biz), eq(schema.adatiAliases.rawText, raw))).limit(1);
      if (existing) {
        await db.update(schema.adatiAliases)
          .set({ adatiId, hits: existing.hits + 1, lastUsedAt: nowSec(), normKey: normKey(raw) })
          .where(eq(schema.adatiAliases.id, existing.id));
      } else {
        await db.insert(schema.adatiAliases).values({
          id: newId(), businessId: biz, adatiId, rawText: raw, normKey: normKey(raw),
          source: r.nameCorrected ? "correction" : "ocr", createdBy: userId,
        });
        learned.push({ rawText: raw, adatiId });
      }
    }
  }

  await db.update(schema.scanBatches).set({
    status: "committed", reviewedBy: userId, reviewedAt: nowSec(),
  }).where(eq(schema.scanBatches.id, id));
  await refreshScanMeta(biz, id);

  await audit({
    actor: actor(c), action: "scan.commit", entity: "scan_batch", entityId: id,
    entityLabel: `${created.length} slips added to ${batch.slipDate}`,
    after: { slips: created.length, learnedAliases: learned.length, slipDate: batch.slipDate },
  });

  return c.json({
    ok: true, created: created.length, learnedAliases: learned.length,
    slipDate: batch.slipDate, merchantId: batch.merchantId,
  });
});

/**
 * Put the pages in the right order before they are read. The order matters:
 * the model reads them as one continuous list, and the daily list keeps that
 * order. Only allowed before reading, since the row-to-page mapping comes from
 * the read itself.
 */
scanRoutes.put("/:id/order", can("scan.create"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const id = param(c, "id");
  const batch = await loadBatch(biz, id);
  if (!["uploaded", "failed"].includes(batch.status)) {
    throw new HttpError(409, "Pages can only be reordered before the sheet is read", "already_read");
  }
  const files: { name: string; mimeType: string; bytes: number }[] = JSON.parse(batch.filePaths);
  const { order } = z.object({ order: z.array(z.number().int().min(0)) }).parse(await c.req.json());

  const valid = order.length === files.length
    && new Set(order).size === files.length
    && order.every((i) => i < files.length);
  if (!valid) throw bad("The new order must list every page exactly once", "bad_order");

  const next = order.map((i) => files[i]);
  await db.update(schema.scanBatches).set({ filePaths: JSON.stringify(next) })
    .where(eq(schema.scanBatches.id, id));
  await refreshScanMeta(biz, id);
  await audit({
    actor: actor(c), action: "scan.reorder", entity: "scan_batch", entityId: id,
    entityLabel: `pages reordered`,
    before: files.map((f) => f.name), after: next.map((f) => f.name),
  });
  return c.json({ ok: true, pages: next.map((f, i) => ({ index: i, name: f.name, mimeType: f.mimeType, bytes: f.bytes })) });
});

/**
 * Create suppliers for the names this scan read but the master does not have.
 * On a new business that is every row, and picking them one by one is not a
 * reasonable ask — the names are already on the paper.
 */
scanRoutes.post("/:id/create-suppliers", can("adati.write", "scan.review"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const userId = c.get("auth")!.user.id;
  const id = param(c, "id");
  const batch = await loadBatch(biz, id);
  if (batch.status === "committed") throw new HttpError(409, "This scan is already on the daily list", "already_committed");

  const { rowIds } = z.object({ rowIds: z.array(z.string()).optional() })
    .parse(await c.req.json().catch(() => ({})));

  const { rows } = await checkAll(biz, batch);
  const stored: ReviewRow[] = JSON.parse(batch.parsedRows ?? "[]");

  // one supplier per distinct name, however many rows carry it
  const wanted = new Map<string, string[]>();
  for (const r of rows) {
    if (r.excluded || r.adatiId || r.match) continue;
    if (rowIds && !rowIds.includes(r.id)) continue;
    /* A row with a close suggestion is almost certainly an existing supplier
       spelled badly — "धरमपाल" is "धर्मपाल सिंह". Creating it would put a
       duplicate in the master and split that supplier's ledger in two. Only
       names with nothing close are genuinely new. */
    if (r.suggestions.length > 0) continue;
    const name = r.adatiRawText.trim();
    if (!name) continue;
    const list = wanted.get(name) ?? [];
    list.push(r.id);
    wanted.set(name, list);
  }
  if (!wanted.size) return c.json({ created: 0, linked: 0 });

  const assign = new Map<string, string>();
  let created = 0;
  for (const [nameHi, ids] of wanted) {
    const [exists] = await db.select({ id: schema.adati.id }).from(schema.adati)
      .where(and(eq(schema.adati.businessId, biz), eq(schema.adati.nameHi, nameHi))).limit(1);

    let adatiId = exists?.id;
    if (!adatiId) {
      adatiId = newId();
      await db.insert(schema.adati).values({
        id: adatiId, businessId: biz, nameHi,
        nameHinglish: toHinglish(nameHi),
      });
      await db.insert(schema.adatiAliases).values({
        id: newId(), businessId: biz, adatiId, rawText: nameHi,
        normKey: normKey(nameHi), source: "canonical", createdBy: userId,
      }).onConflictDoNothing();
      created++;
    }
    for (const rid of ids) assign.set(rid, adatiId);
  }

  const next = stored.map((r) => (assign.has(r.id) ? { ...r, adatiId: assign.get(r.id)!, nameCorrected: false } : r));
  await db.update(schema.scanBatches).set({ parsedRows: JSON.stringify(next) })
    .where(eq(schema.scanBatches.id, id));

  await audit({
    actor: actor(c), action: "scan.create_suppliers", entity: "scan_batch", entityId: id,
    entityLabel: `${created} new supplier${created === 1 ? "" : "s"} from the sheet`,
    after: { created, linkedRows: assign.size, names: [...wanted.keys()] },
  });

  const fresh = await loadBatch(biz, id);
  return c.json({ created, linked: assign.size, ...(await checkAll(biz, fresh)) });
});

scanRoutes.delete("/:id", can("scan.create"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const id = param(c, "id");
  const batch = await loadBatch(biz, id);
  if (batch.status === "committed") {
    throw new HttpError(409, "This scan is already on the daily list. Delete those rows there instead.", "already_committed");
  }
  fs.rmSync(path.join(SCAN_DIR, id), { recursive: true, force: true });
  await db.delete(schema.scanBatches).where(eq(schema.scanBatches.id, id));
  await audit({ actor: actor(c), action: "scan.delete", entity: "scan_batch", entityId: id, entityLabel: batch.slipDate ?? id });
  return c.json({ ok: true });
});

/* -------------------------------------------------------------------- list */

scanRoutes.get("/", can("scan.review", "scan.create"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const status = c.req.query("status");
  const from = c.req.query("from");
  const to = c.req.query("to");
  const merchantId = c.req.query("merchantId");
  const limit = Math.min(Number(c.req.query("limit") ?? 40), 100);

  const where = [eq(schema.scanBatches.businessId, biz)];
  if (status && status !== "all") where.push(eq(schema.scanBatches.status, status));
  if (merchantId) where.push(eq(schema.scanBatches.merchantId, merchantId));
  if (from && ISO_DATE.test(from)) where.push(gte(schema.scanBatches.slipDate, from));
  if (to && ISO_DATE.test(to)) where.push(lte(schema.scanBatches.slipDate, to));

  const rows = await db.select({
    id: schema.scanBatches.id,
    status: schema.scanBatches.status,
    sourceKind: schema.scanBatches.sourceKind,
    slipDate: schema.scanBatches.slipDate,
    merchantId: schema.scanBatches.merchantId,
    merchantCode: schema.merchants.code,
    model: schema.scanBatches.model,
    errorText: schema.scanBatches.errorText,
    filePaths: schema.scanBatches.filePaths,
    parsedRows: schema.scanBatches.parsedRows,
    createdAt: schema.scanBatches.createdAt,
    reviewedAt: schema.scanBatches.reviewedAt,
  })
    .from(schema.scanBatches)
    .leftJoin(schema.merchants, eq(schema.merchants.id, schema.scanBatches.merchantId))
    .where(and(...where))
    .orderBy(desc(schema.scanBatches.createdAt))
    .limit(limit);

  return c.json(rows.map((r) => ({
    ...r,
    pages: (JSON.parse(r.filePaths) as unknown[]).length,
    rowCount: r.parsedRows ? (JSON.parse(r.parsedRows) as unknown[]).length : 0,
    filePaths: undefined,
    parsedRows: undefined,
  })));
});

/** Counts per status, for the filter chips. */
scanRoutes.get("/counts", can("scan.review", "scan.create"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const rows = await db.select({
    status: schema.scanBatches.status,
    n: sql<number>`count(*)`.as("n"),
  }).from(schema.scanBatches)
    .where(eq(schema.scanBatches.businessId, biz))
    .groupBy(schema.scanBatches.status);
  return c.json(Object.fromEntries(rows.map((r) => [r.status, r.n])));
});
