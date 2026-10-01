import { Hono } from "hono";
import { slipCharges, supplierChargesOf, termsOnly } from "../lib/supplierCharges.ts";
import { z } from "zod";
import { eq, and, desc, asc, inArray, notInArray, sql, gte, lte, like, ne, or } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { db, schema } from "../db/client.ts";
import { newId, nowSec } from "../lib/ids.ts";
import { audit, enqueueSync } from "../lib/audit.ts";
import { decryptSecret } from "../lib/secrets.ts";
import { GeminiConfigSchema, defaultGeminiConfig } from "../lib/display.ts";
import { deriveKatauti, type Katauti } from "../lib/charges.ts";
import { readSheetReliably, recordCall, spentToday, type GeminiCallResult } from "../lib/gemini.ts";
import { loadResolver } from "../lib/adatiResolve.ts";
import { normKey, toHinglish } from "../lib/translit.ts";
import {
  ReviewRowSchema, ocrToReviewRow, checkRow, findDupes, qtlToGrams,
  type ReviewRow, type CheckedRow,
} from "../lib/scanRows.ts";
import { deriveSlip, katautiCfg, checkSlipRefs } from "./slips.ts";
import { normRst, checkPages, slipMarks, hasRate, pageOrder, hundredths, type PageMeta, type HeaderDiffers } from "../lib/scanRows.ts";
import { GRAMS_PER_QTL } from "../lib/money.ts";
import { approvedOnDays } from "../lib/parcha.ts";
import { can, canAll, LIMIT, actor, param, notFound, bad, requireBusiness, HttpError, isoDay, type Env } from "../lib/http.ts";
import { assertDaysOpen } from "../lib/dayClose.ts";
import { ensureSupplier } from "../lib/supplierFromName.ts";

/** Pages read so far. A sheet read before pages were counted (before 21-09-2026)
 *  was read in full, but its count was left at 0 when the count was added. */
function pagesRead(b: { status: string; pagesDone: number; parsedRows: string | null; filePaths: string }) {
  if (b.pagesDone === 0 && (b.status === "review" || b.status === "committed") && b.parsedRows) return (JSON.parse(b.filePaths) as unknown[]).length;
  return b.pagesDone;
}

export const scanRoutes = new Hono<Env>();

/* Reading a full sheet takes 20-60s. It runs detached from the request so the
 * operator can switch tabs, open the daily list, or close the page entirely
 * without killing it. The browser polls the batch instead of holding a socket
 * open, so nothing is lost by navigating away and coming back. */
const inFlight = new Set<string>();
/** Scans with one page being read again, and which page: the screen says so while it runs. */
const rereading = new Map<string, number>();

/** A process restart leaves reads orphaned; nothing is running for them. */
export function recoverInterruptedScans() {
  // only reads this computer was doing: with sync, another computer's scan
  // shows "reading" here while it is being read there
  const stale = db.select({ id: schema.scanBatches.id }).from(schema.scanBatches)
    .where(eq(schema.scanBatches.status, "reading")).all()
    .filter((s) => SAFE_ID.test(s.id) && fs.existsSync(path.join(SCAN_DIR, s.id)));
  if (!stale.length) return 0;
  for (const s of stale) {
    const b = db.select({ pagesDone: schema.scanBatches.pagesDone, filePaths: schema.scanBatches.filePaths, parsedRows: schema.scanBatches.parsedRows })
      .from(schema.scanBatches).where(eq(schema.scanBatches.id, s.id)).get();
    const done = b?.pagesDone ?? 0;
    // one page was being read again: every page's lines from before are still there
    if (b?.parsedRows && done >= (JSON.parse(b.filePaths) as unknown[]).length) {
      db.update(schema.scanBatches).set({ status: "review", errorText: null, warningText: "The reader was interrupted while reading a page again. The lines read before are kept." })
        .where(eq(schema.scanBatches.id, s.id)).run();
      continue;
    }
    db.update(schema.scanBatches).set(done > 0
      // pages already read are kept; "Read again" resumes after them
      ? { status: "failed", errorText: `The reader was interrupted. Pages 1–${done} are kept; press "Read again" to continue from page ${done + 1}.`, warningText: null }
      : { status: "uploaded", warningText: "The reader was interrupted before it finished. Start it again." },
    ).where(eq(schema.scanBatches.id, s.id)).run();
  }
  return stale.length;
}

const DATA_DIR = process.env.MANDI_DATA_DIR ?? path.resolve(process.cwd(), "data");
const SCAN_DIR = path.join(DATA_DIR, "scans");
/* Scan ids and page names come from the database — and, with sync, from other
   computers. Only plain names are ever turned into paths inside the scans folder. */
const SAFE_ID = /^[A-Za-z0-9-]{8,64}$/;
const SAFE_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,79}$/;
function scanDir(id: string) {
  if (!SAFE_ID.test(id)) throw notFound("Scan not found");
  return path.join(SCAN_DIR, id);
}
function scanFile(id: string, name: string) {
  if (!SAFE_NAME.test(name) || name.includes("..")) throw notFound("Page not found");
  return path.join(scanDir(id), name);
}
/** The pictures stay on the computer that scanned them; another computer only has the rows. */
function assertImagesHere(id: string, files: { name: string }[]) {
  if (!files.every((f) => fs.existsSync(scanFile(id, f.name)))) {
    throw new HttpError(409, "The pictures of this sheet are on the computer that scanned it. Read it again there.", "images_elsewhere");
  }
}

/** One page of a scan as kept in file_paths. sha256 is there for pages saved since 01-10-2026. */
type PageFile = { name: string; mimeType: string; bytes: number; sha256?: string };
const sha256Of = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");
/** A page's fingerprint: kept from the upload, or worked out from its picture when the picture is here. */
function pageHash(id: string, f: PageFile): string | null {
  if (f.sha256) return f.sha256;
  try {
    const p = scanFile(id, f.name);
    return fs.existsSync(p) ? sha256Of(fs.readFileSync(p)) : null;
  } catch {
    return null;
  }
}

/**
 * Pages of this sheet that are the very same picture as a page of another
 * sheet: the same paper uploaded twice. Only ever a warning, never a stop,
 * but it is said before a read is spent and before the slips go in twice.
 * Pages are compared by size first, so a picture is only opened when another
 * page has exactly its size.
 */
async function samePictures(businessId: string, batch: { id: string; filePaths: string }) {
  const S = schema.scanBatches;
  const others = await db.select({ id: S.id, slipDate: S.slipDate, status: S.status, filePaths: S.filePaths, createdAt: S.createdAt })
    .from(S).where(and(eq(S.businessId, businessId), ne(S.id, batch.id)));
  const bySize = new Map<number, { o: (typeof others)[number]; page: number; f: PageFile }[]>();
  for (const o of others) {
    for (const [i, f] of (JSON.parse(o.filePaths) as PageFile[]).entries()) {
      const list = bySize.get(f.bytes) ?? [];
      list.push({ o, page: i + 1, f });
      bySize.set(f.bytes, list);
    }
  }
  const out: { page: number; scanId: string; otherPage: number; slipDate: string | null; status: string; createdAt: number }[] = [];
  for (const [i, f] of (JSON.parse(batch.filePaths) as PageFile[]).entries()) {
    const same = bySize.get(f.bytes);
    if (!same?.length) continue;
    const mine = pageHash(batch.id, f);
    if (!mine) continue;
    for (const s of same) {
      if (pageHash(s.o.id, s.f) !== mine) continue;
      out.push({ page: i + 1, scanId: s.o.id, otherPage: s.page, slipDate: s.o.slipDate, status: s.o.status, createdAt: s.o.createdAt });
    }
  }
  return out.sort((a, b) => a.page - b.page || a.createdAt - b.createdAt);
}
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_BYTES = 12 * 1024 * 1024;
const OK_TYPES = new Set([
  "image/jpeg", "image/jpg", "image/png", "image/webp",
  "image/heic", "image/heif", "application/pdf",
]);
/** Phones and scanner drivers often send an empty or generic MIME type. */
const EXT_TYPES: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
  heic: "image/heic", heif: "image/heif", pdf: "application/pdf",
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

/**
 * How many pages a PDF has. Older writers leave every page as plain text
 * ("/Type /Page"); PDF 1.5 and later may pack them into compressed object
 * streams, which are opened here and counted too. null when a PDF has packed
 * objects that cannot be opened — its page count is then unknown.
 */
export function pdfPageCount(bytes: Buffer): number | null {
  const text = bytes.toString("latin1");
  const PAGE = /\/Type\s*\/Page(?![a-zA-Z])/g;
  let n = text.match(PAGE)?.length ?? 0;
  const packed = /\/Type\s*\/ObjStm\b/g;
  for (let m = packed.exec(text); m; m = packed.exec(text)) {
    // the dictionary around this /Type, then its stream
    const dictStart = text.lastIndexOf("<<", m.index);
    const s = text.indexOf("stream", m.index);
    if (dictStart === -1 || s === -1) return null;
    const dict = text.slice(dictStart, s);
    if (!/\/Filter\s*\/FlateDecode/.test(dict) || /\/DecodeParms/.test(dict)) return null;
    let start = s + "stream".length;
    if (text[start] === "\r") start++;
    if (text[start] === "\n") start++;
    const end = text.indexOf("endstream", start);
    if (end === -1) return null;
    try {
      const inner = zlib.inflateSync(bytes.subarray(start, end), { finishFlush: zlib.constants.Z_SYNC_FLUSH }).toString("latin1");
      n += inner.match(PAGE)?.length ?? 0;
    } catch {
      return null;
    }
  }
  return n;
}

async function setting(businessId: string, key: string) {
  const [row] = await db.select().from(schema.settings)
    .where(and(eq(schema.settings.businessId, businessId), eq(schema.settings.key, key))).limit(1);
  return row?.value ?? null;
}

const katautiFor = (businessId: string, merchantId: string | null) => katautiCfg(businessId, merchantId);

/** Written next to the images; refreshed whenever the tagging changes. */
function writeScanMeta(id: string, meta: Record<string, unknown>) {
  try {
    fs.writeFileSync(path.join(scanDir(id), "meta.json"), JSON.stringify(meta, null, 2));
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
/**
 * What a rate usually is for this commodity, from this business's own slips
 * of the last 90 days: 70%–140% of the median. Maize at 1,900 and paddy at
 * 3,450 are both normal; a fixed range would flag one of them. With too few
 * slips to judge, a wide default is used.
 */
async function usualRateRange(businessId: string, jinsId: string | null, day: string | null) {
  const S = schema.purchaseSlips;
  const until = day ?? new Date().toLocaleDateString("en-CA");
  const since = new Date(new Date(until).getTime() - 90 * 86400_000).toLocaleDateString("en-CA");
  const rates = (await db.select({ r: S.ratePaisePerQtl }).from(S).where(and(
    eq(S.businessId, businessId), gte(S.slipDate, since), lte(S.slipDate, until), sql`${S.ratePaisePerQtl} > 0`,
    ...(jinsId ? [eq(S.jinsId, jinsId)] : []),
  ))).map((x) => x.r).sort((a, b) => a - b);
  if (rates.length < 15) return { floor: 100_000, ceil: 1_000_000, from: "default" as const };
  const median = rates[Math.floor(rates.length / 2)];
  return { floor: Math.round(median * 0.7), ceil: Math.round(median * 1.4), from: "recent" as const };
}

/** The rates already on the daily list for the sheet's day and commodity, not counting this sheet's own slips. */
async function ratesOfDay(businessId: string, batch: { id: string; slipDate: string | null; jinsId: string | null }) {
  if (!batch.slipDate || !batch.jinsId) return [];
  const S = schema.purchaseSlips;
  return (await db.select({ r: S.ratePaisePerQtl }).from(S).where(and(
    eq(S.businessId, businessId), eq(S.slipDate, batch.slipDate), eq(S.jinsId, batch.jinsId), sql`${S.ratePaisePerQtl} > 0`,
    or(sql`${S.scanBatchId} is null`, ne(S.scanBatchId, batch.id)),
  ))).map((x) => x.r);
}

/** Letters and digits only, upper case: "L.B", "lb" and "L B" are one mill code. */
const codeKey = (s: string | null | undefined) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9ऀ-ॿ]/g, "");

/**
 * The mill and the commodity the sheet's header names, when each is a known
 * one and not what the scan is filed under. A sheet headed "L.B" left under
 * the own firm puts its slips in no mill's stock, and its rates are judged
 * against the wrong commodity — so it is asked, with the header's choice one
 * tap away. A name that matches nothing known is not guessed at.
 */
async function headerDiffers(businessId: string, batch: typeof schema.scanBatches.$inferSelect, meta: PageMeta[]) {
  const first = (pick: (m: PageMeta) => string | null) => meta.filter((m) => codeKey(pick(m))).sort((a, b) => a.page - b.page)[0];
  const millAt = first((m) => m.millName);
  const jinsAt = first((m) => m.jins);
  const out: { mill?: HeaderDiffers; jins?: HeaderDiffers } = {};
  if (millAt) {
    const [biz] = await db.select({ shortCode: schema.businesses.shortCode }).from(schema.businesses).where(eq(schema.businesses.id, businessId)).limit(1);
    const mills = await db.select({ id: schema.merchants.id, code: schema.merchants.code, name: schema.merchants.name, nameHi: schema.merchants.nameHi, active: schema.merchants.active })
      .from(schema.merchants).where(eq(schema.merchants.businessId, businessId));
    const want = codeKey(millAt.millName);
    const hit = mills.find((m) => m.active && [m.code, m.name, m.nameHi].some((x) => x && codeKey(x) === want));
    const own = !hit && codeKey(biz?.shortCode) === want;
    if ((hit || own) && (hit?.id ?? null) !== batch.merchantId) {
      const filed = mills.find((m) => m.id === batch.merchantId);
      out.mill = {
        page: millAt.page, written: millAt.millName!.trim(), id: hit?.id ?? null, label: hit?.code ?? biz?.shortCode ?? "",
        filedId: batch.merchantId, filed: filed?.code ?? biz?.shortCode ?? "",
      };
    }
  }
  if (jinsAt) {
    const all = await db.select({ id: schema.jins.id, code: schema.jins.code, name: schema.jins.name, active: schema.jins.active })
      .from(schema.jins).where(eq(schema.jins.businessId, businessId));
    const want = codeKey(jinsAt.jins);
    const hit = all.find((j) => j.active && (codeKey(j.code) === want || codeKey(j.name) === want));
    if (hit && hit.id !== batch.jinsId) {
      out.jins = {
        page: jinsAt.page, written: jinsAt.jins!.trim(), id: hit.id, label: hit.code,
        filedId: batch.jinsId, filed: all.find((j) => j.id === batch.jinsId)?.code ?? "—",
      };
    }
  }
  return out;
}

async function checkAll(businessId: string, batch: typeof schema.scanBatches.$inferSelect) {
  const stored: ReviewRow[] = batch.parsedRows ? JSON.parse(batch.parsedRows) : [];
  /* A sheet read before weights were kept in whole kilograms may hold a
     third decimal (20.205): it is taken to the kilo here, as a new read is,
     so the box, the check and the slip all carry one figure, and it is asked. */
  const rows = batch.status === "committed" ? stored : stored.map((r) => r.grossGrams !== null && r.grossGrams % 1000 !== 0
    ? { ...r, grossGrams: hundredths(r.grossGrams / GRAMS_PER_QTL) * (GRAMS_PER_QTL / 100) } : r);
  const katauti = await katautiFor(businessId, batch.merchantId);
  const resolver = await loadResolver(businessId);

  /* The RST check (book guards). Same date: any repeat, compared as numbers
     ("0634", "६३४" and "634" are one slip). Another date within 30 days: the
     same RST with the same gross — the same sheet entered again. Both are
     flags for the operator; neither stops the save. */
  const { rstKey } = await import("../lib/slipChecks.ts");
  const { sameSlipOtherDays } = await import("../lib/slipFlags.ts");
  const { dmy } = await import("../lib/parchaLabels.ts");
  const existingRst = new Set<string>();
  let rstOtherDays = new Map<string, { id: string; date: string }[]>();
  if (batch.slipDate) {
    // a sheet already added is never flagged against its own slips
    const taken = await db.select({ rstNo: schema.purchaseSlips.rstNo }).from(schema.purchaseSlips)
      .where(and(
        eq(schema.purchaseSlips.businessId, businessId),
        eq(schema.purchaseSlips.slipDate, batch.slipDate),
        or(sql`${schema.purchaseSlips.scanBatchId} is null`, ne(schema.purchaseSlips.scanBatchId, batch.id)),
      ));
    const takenKeys = new Set(taken.map((r) => rstKey(r.rstNo)));
    // the row's own spelling goes in, so the check below finds it whatever the zeros
    for (const r of rows) if (r.rstNo && takenKeys.has(rstKey(r.rstNo))) existingRst.add(r.rstNo);
    rstOtherDays = await sameSlipOtherDays(businessId,
      rows.filter((r) => !r.excluded).map((r) => ({ key: r.id, slipDate: batch.slipDate!, rstNo: r.rstNo, grossGrams: r.grossGrams })),
      { exceptBatch: batch.id });
  }
  const flagOtherDays = (c: { id: string; rstNo: string; excluded: boolean; issues: { code: string; level: "error" | "warn"; message: string; params?: Record<string, string | number> }[] }) => {
    const od = c.excluded ? undefined : rstOtherDays.get(c.id);
    if (!od?.length) return;
    const dates = [...new Set(od.map((o) => dmy(o.date)))].join(", ");
    c.issues.push({ code: "rst_other_day", level: "warn", message: `RST ${c.rstNo} is also on ${dates} with the same weight — this sheet may already be entered`, params: { rst: c.rstNo, dates } });
  };

  const dupeInBatch = findDupes(rows);
  const range = await usualRateRange(businessId, batch.jinsId, batch.slipDate);
  // page, then position on the page — the same order everywhere
  const ordered = [...rows].sort((a, b) => (a.page ?? 1) - (b.page ?? 1) || Number(a.id.slice(1)) - Number(b.id.slice(1)));
  const meta = JSON.parse(batch.pageMeta ?? "[]") as PageMeta[];
  /* Pages put in the wrong order (page 1 runs 31–60): the sheet is asked to
     be put in order first. Until then the top of a page is not "lines
     missing" — it is the other page's place. */
  const order = pageOrder(rows);
  const head = [...meta].sort((a, b) => a.page - b.page)[0];
  const orderKept = Boolean(order && head?.confirmed?.includes("order") && head.confirmedFor?.order === order.join(","));
  const marks = slipMarks(rows).filter((m) => !(order && !orderKept && m.code === "sr_top"));
  const rowsChecked = (page: number) => (meta.find((m) => m.page === page)?.confirmed ?? []).includes("rows");
  const netPages = new Set(rows.filter((r) => r.ocr.netQtl != null).map((r) => r.page ?? 1));
  const ratePages = new Set(rows.filter((r) => !r.excluded && hasRate(r)).map((r) => r.page ?? 1));
  // the day's rates: the daily list's for this commodity, and this sheet's own lines
  const dayRates = [
    ...await ratesOfDay(businessId, batch),
    ...rows.filter((r) => !r.excluded && (r.ratePaisePerQtl ?? 0) > 0).map((r) => r.ratePaisePerQtl!),
  ];
  const checked: CheckedRow[] = ordered.map((r) => {
    const c = checkRow(r, {
      katauti, resolve: resolver.resolve, byId: resolver.byId, existingRst, dupeInBatch,
      rateFloorPaise: range.floor, rateCeilPaise: range.ceil, pageHasNet: netPages.has(r.page ?? 1),
      pageHasRate: ratePages.has(r.page ?? 1), dayRates,
    });
    flagOtherDays(c);
    if (!c.excluded) {
      /* Rows may have slid on this page (a name with no weight, or numbers that
         break): every row on it waits until the page is checked line by line
         against the paper. The row where it shows is marked until then. */
      const here = marks.find((m) => m.rowId === r.id);
      if (here && !rowsChecked(r.page ?? 1)) c.issues.push({ code: here.code, level: "warn", message: "The rows may slip out of line here", params: here.params });
      if (marks.some((m) => m.page === (r.page ?? 1)) && !rowsChecked(r.page ?? 1)) {
        c.issues.push({ code: "page_slid", level: "error", message: `Check page ${r.page ?? 1} line by line: names may sit on the wrong weights`, params: { page: r.page ?? 1 } });
      }
      c.blocking = c.issues.some((i) => i.level === "error");
    }
    return c;
  });
  const pageChecks = checkPages(meta, checked, batch.slipDate, marks, { ...(await headerDiffers(businessId, batch, meta)), order });

  const active = checked.filter((r) => !r.excluded);
  return {
    rows: checked,
    katauti,
    pageChecks,
    rateRange: { floorPaise: range.floor, ceilPaise: range.ceil, from: range.from },
    summary: {
      total: checked.length,
      included: active.length,
      excluded: checked.length - active.length,
      blocking: active.filter((r) => r.blocking).length,
      /** A page date or total that differs from the sheet and is not yet confirmed. */
      pagesBlocking: pageChecks.filter((p) => !p.confirmed).length,
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

/**
 * Saves the pages of one sheet and creates its scan, from an upload or from
 * the scanner's folder. Checks every page first and saves nothing if one of
 * them is unusable.
 */
export async function createScan(o: {
  biz: string;
  pages: { name: string; mimeType: string | null; size: number; bytes: Buffer; declared?: string }[];
  slipDate: string | null; merchantId: string | null; jinsId: string | null; sourceKind: string;
  user: { id: string | null; name: string };
  actor: Parameters<typeof audit>[0]["actor"];
}) {
  // a mill or commodity from another business (a second tab on the other firm) is refused
  await checkSlipRefs(o.biz, { merchantId: o.merchantId, jinsId: o.jinsId ?? undefined });
  for (const f of o.pages) {
    if (!f.mimeType) throw bad(`"${f.name}" is a ${f.declared || "unknown"} file. Use JPG, PNG, WEBP or a one-page PDF.`, "bad_type");
    if (f.size === 0) throw bad(`"${f.name}" is empty. Scan it again.`, "empty_file");
    if (f.size > MAX_BYTES) throw bad(`"${f.name}" is over 12 MB. Scan at 200–300 dpi instead.`, "too_big");
    /* Gemini reads an iPhone's HEIC photo, but this computer cannot show it,
       and a sheet nobody can see beside its rows cannot be checked. */
    if (f.mimeType === "image/heic" || f.mimeType === "image/heif") {
      throw bad(`"${f.name}" is an iPhone photo (HEIC), which this computer cannot show for checking. Send it as JPG: on the iPhone, Settings › Camera › Formats › Most Compatible, or share it through WhatsApp.`, "heic");
    }
    // one read is one page: a multi-page PDF would lose every page after the first
    if (f.mimeType === "application/pdf") {
      const n = pdfPageCount(f.bytes);
      if (n === null) throw bad(`"${f.name}" is a PDF whose pages could not be counted. Save each page as a JPG and add them together.`, "pdf_unreadable");
      if (n > 1) throw bad(`"${f.name}" has ${n} pages. Save each page as its own image (or PDF) and add them together.`, "multi_page_pdf");
    }
  }
  const id = newId();
  const dir = path.join(SCAN_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const saved: PageFile[] = [];
  for (const [i, f] of o.pages.entries()) {
    const mimeType = f.mimeType!;
    const ext = mimeType === "application/pdf" ? "pdf"
      : mimeType === "image/png" ? "png"
      : mimeType === "image/webp" ? "webp"
      : mimeType === "image/heic" || mimeType === "image/heif" ? "heic" : "jpg";
    const name = `${String(i).padStart(2, "0")}.${ext}`;
    fs.writeFileSync(path.join(dir, name), f.bytes);
    // the picture's fingerprint: the same paper uploaded twice is noticed (and only said)
    saved.push({ name, mimeType, bytes: f.size, sha256: sha256Of(f.bytes) });
  }

  /* An empty commodity silently blocked approval, with nothing on screen
     saying why. Default to what this business buys most, then 1509. */
  let jinsId = o.jinsId;
  if (!jinsId) {
    const [top] = await db.select({ id: schema.purchaseSlips.jinsId, n: sql<number>`count(*)`.as("n") })
      .from(schema.purchaseSlips)
      .where(eq(schema.purchaseSlips.businessId, o.biz))
      .groupBy(schema.purchaseSlips.jinsId)
      .orderBy(desc(sql`n`))
      .limit(1);
    const [fallback] = await db.select({ id: schema.jins.id }).from(schema.jins)
      .where(and(eq(schema.jins.businessId, o.biz), eq(schema.jins.active, true)))
      .orderBy(sql`case when ${schema.jins.code} = '1509' then 0 else 1 end`, asc(schema.jins.code))
      .limit(1);
    jinsId = top?.id ?? fallback?.id ?? null;
  }

  /* A sidecar so the folder means something when browsed in Finder or
     Explorer, and so the images can still be tagged if the DB is ever lost. */
  writeScanMeta(id, {
    scanId: id, businessId: o.biz, uploadedAt: new Date().toISOString(),
    uploadedBy: o.user.name,
    slipDate: o.slipDate, merchantId: o.merchantId, jinsId, sourceKind: o.sourceKind,
    files: saved,
  });

  await db.insert(schema.scanBatches).values({
    id, businessId: o.biz, sourceKind: o.sourceKind,
    filePaths: JSON.stringify(saved),
    slipDate: o.slipDate, merchantId: o.merchantId, jinsId,
    status: "uploaded",
    createdBy: o.user.id,
  });
  await audit({
    actor: o.actor, action: "scan.upload", entity: "scan_batch", entityId: id,
    entityLabel: `${saved.length} page${saved.length === 1 ? "" : "s"}${o.slipDate ? ` for ${o.slipDate}` : ""}${o.sourceKind === "scanner" ? " from the scanner folder" : ""}`,
    after: { files: saved.map((f) => f.name), slipDate: o.slipDate, merchantId: o.merchantId },
  });
  return { id, saved };
}


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

  const slipDate = typeof body["slipDate"] === "string" && ISO_DATE.test(body["slipDate"])
    ? body["slipDate"] : null;
  const merchantId = typeof body["merchantId"] === "string" && body["merchantId"] ? body["merchantId"] : null;
  const jinsId = typeof body["jinsId"] === "string" && body["jinsId"] ? body["jinsId"] : null;
  const sourceKind = typeof body["sourceKind"] === "string" ? body["sourceKind"] : "upload";
  const pages = await Promise.all(files.map(async (file) => ({
    name: file.name, mimeType: resolveType(file), size: file.size, bytes: Buffer.from(await file.arrayBuffer()), declared: file.type,
  })));
  const { id, saved } = await createScan({
    biz, pages, slipDate, merchantId, jinsId, sourceKind,
    user: { id: c.get("auth")!.user.id, name: c.get("auth")!.user.name }, actor: actor(c),
  });
  // the screen does not spend a read on a picture already held: it shows the warning first
  const same = await samePictures(biz, { id, filePaths: JSON.stringify(saved) });
  return c.json({ id, pages: saved.length, samePictures: same.length });
});

/** Adds a page to a scan that has not been read yet (the scanner's "next page"). */
export async function appendPage(biz: string, id: string, bytes: Buffer, mimeType: string) {
  const batch = await loadBatch(biz, id);
  if (batch.status !== "uploaded") throw new HttpError(409, "This sheet is already being read or has been read. Start a new scan for more pages.", "not_open");
  const files: PageFile[] = JSON.parse(batch.filePaths);
  if (files.length >= 10) throw bad("Ten pages at a time is the limit", "too_many");
  if (bytes.length > MAX_BYTES) throw bad("That page is over 12 MB. Scan at 200–300 dpi instead.", "too_big");
  const name = `${String(files.length).padStart(2, "0")}.${mimeType === "image/png" ? "png" : "jpg"}`;
  fs.writeFileSync(scanFile(id, name), bytes);
  files.push({ name, mimeType, bytes: bytes.length, sha256: sha256Of(bytes) });
  await db.update(schema.scanBatches).set({ filePaths: JSON.stringify(files) }).where(eq(schema.scanBatches.id, id));
  await refreshScanMeta(biz, id);
  return files.length;
}

/* --------------------------------------------------------------------- run */

/**
 * Does the actual reading. Never awaited by the request handler.
 *
 * Pages are read ONE AT A TIME, in the order the operator set, and each page's
 * rows are saved as soon as it lands. Two reasons. The page number is ours —
 * image N is page N — rather than something the model has to infer across
 * several images, which is how page 3 ended up above page 1. And the grid can
 * fill in page by page while the rest is still being read.
 */
async function performRead(opts: {
  biz: string; id: string; apiKey: string;
  cfg: ReturnType<typeof defaultGeminiConfig>; wanted?: string;
  actorInfo: { userId: string | null; userName: string | null };
  /** Pages already read by an attempt that stopped at a quota limit. */
  resumeFrom?: number; resumeRows?: ReviewRow[];
  /** Read only this page (1-based) again; every other page's lines stay as they are. */
  only?: number;
}) {
  const { biz, id, apiKey, cfg, wanted, only } = opts;
  const batch = await loadBatch(biz, id);
  const files: { name: string; mimeType: string }[] = JSON.parse(batch.filePaths);

  const resolver = await loadResolver(biz);
  const knownSuppliers = resolver.candidateNames(300);

  // the mill's own katauti terms, for the sheet's self-check below
  const terms = await katautiFor(biz, batch.merchantId);
  function weakness(r: GeminiCallResult): string | null {
    if (!r.ok || !r.page) return "the first pass failed";
    // struck-out lines carry no weight on purpose: they say nothing about the read
    const rows = r.page.rows.filter((x) => !x.struckThrough);
    if (!rows.length) return null; // a blank page is not a weak read
    // the sheet checks itself: net = gross − katauti, on this mill's terms
    const failing = rows.filter((x) => {
      if (x.grossQtl == null || x.netQtl == null) return false;
      const g = qtlToGrams(x.grossQtl);
      return Math.abs(g - deriveKatauti(g, terms, null).deductionGrams - qtlToGrams(x.netQtl)) > 1500;
    }).length;
    if (failing / rows.length > 0.15) return `${failing} rows fail the net-weight check`;
    const mean = rows.reduce((a, x) => a + (x.confidence ?? 0), 0) / rows.length;
    if (mean < cfg.fallbackBelowConfidence) return `average confidence ${mean.toFixed(2)}`;
    const shaky = rows.filter((x) => (x.confidence ?? 1) < 0.6).length;
    if (shaky / rows.length > 0.15) return `${shaky} rows read poorly`;
    const missingName = rows.filter((x) => !x.adatiName?.trim()).length;
    if (missingName / rows.length > 0.1) return `${missingName} names not read`;
    if (rows.filter((x) => x.grossQtl == null).length / rows.length > 0.1) return "weights not read";
    if (r.truncated) return "the reply was cut short";
    return null;
  }

  const before: ReviewRow[] = batch.parsedRows ? JSON.parse(batch.parsedRows) : [];
  const collected: ReviewRow[] = only ? before.filter((r) => (r.page ?? 1) !== only) : [...(opts.resumeRows ?? [])];
  // header date and bottom total of each page, kept for the page checks
  const pageMeta: PageMeta[] = only
    ? (JSON.parse(batch.pageMeta ?? "[]") as PageMeta[]).filter((m) => m.page !== only)
    : opts.resumeFrom
    ? (JSON.parse(batch.pageMeta ?? "[]") as PageMeta[]).filter((m) => m.page <= opts.resumeFrom!)
    : [];
  const notes: string[] = [];
  let tokensIn = batch.tokensIn ?? 0, tokensOut = batch.tokensOut ?? 0;
  if (!only && !opts.resumeFrom) { tokensIn = 0; tokensOut = 0; }
  let modelUsed = wanted ?? cfg.model;

  /** A page read again that could not be read: the sheet stays as it was, and says so. */
  const keepAsWas = async (why: string) => {
    await db.update(schema.scanBatches).set({
      status: "review", errorText: null,
      warningText: `Page ${only} could not be read again: ${why} Its lines are as they were.`,
    }).where(eq(schema.scanBatches.id, id));
    await audit({
      actor: { ...opts.actorInfo, businessId: biz },
      action: "scan.read.fail", entity: "scan_batch", entityId: id,
      entityLabel: `page ${only} read again: ${why}`,
    });
  };

  for (let p = only ? only - 1 : opts.resumeFrom ?? 0; p < (only ?? files.length); p++) {
    const image = [{
      base64: fs.readFileSync(scanFile(id, files[p].name)).toString("base64"),
      mimeType: files[p].mimeType,
    }];

    const record = (r: GeminiCallResult) => recordCall({ businessId: biz, apiKey, result: r });
    // while Google is busy, say so on the scan instead of looking stuck
    const onRetry = async (attempt: number, waitMs: number) => {
      await db.update(schema.scanBatches).set({
        warningText: `Google is busy — page ${p + 1}, trying again in ${Math.round(waitMs / 1000)} s (attempt ${attempt + 1})`,
      }).where(eq(schema.scanBatches.id, id));
    };
    /* Every model has its own free allowance for the day. When the main
       model's is used up (or it has none on this key), the page goes to the
       backups in order; models already refused today are skipped without a
       request, except the last, so the message is Google's own. */
    const chain = wanted ? [wanted] : [...new Set([cfg.model, ...cfg.backupModels])];
    const spentNames: string[] = [];
    let result: GeminiCallResult & { attempts?: number } = { ok: false, model: chain[0], ms: 0, error: "Not read" };
    for (let i = 0; i < chain.length; i++) {
      const m = chain[i];
      if (i < chain.length - 1 && await spentToday(apiKey, m)) { spentNames.push(m); continue; }
      result = await readSheetReliably({
        apiKey, model: m, images: image, knownSuppliers,
        maxOutputTokens: cfg.maxOutputTokens, temperature: cfg.temperature,
      }, record, { onRetry });
      if (result.ok || !result.quota) break;
      // the project's spend cap refuses every model: stop here and say so once
      if (result.quota.kind === "spend_cap") break;
      spentNames.push(m);
    }
    if (result.ok && spentNames.length) {
      notes.push(`page ${p + 1} read on ${result.model}: today's free reads on ${spentNames.join(", ")} are used up`);
    } else if (!result.ok && result.quota && spentNames.length > 1) {
      result = { ...result, error: `${result.error ?? "Gemini limit reached"} Used up today: ${spentNames.join(", ")}.` };
    }

    /* Still busy after the retries: the other model runs on separate
       capacity, so give it one go before giving up on the page. */
    if (!result.ok && result.quota?.kind !== "spend_cap"
      && result.transient && !wanted && cfg.fallbackModel && cfg.fallbackModel !== result.model
      && !(await spentToday(apiKey, cfg.fallbackModel))) {
      const other = await readSheetReliably({
        apiKey, model: cfg.fallbackModel, images: image, knownSuppliers,
        maxOutputTokens: cfg.maxOutputTokens, temperature: cfg.temperature,
      }, record, { onRetry, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5_000))) });
      if (other.ok) {
        notes.push(`page ${p + 1} read on ${other.model} because ${cfg.model} was busy`);
        result = other;
      }
    }

    /* The stronger model is for a page that was read badly, not for a page
       that could not be read. After a refusal (quota, key, network) a second
       request only spends another read and fails the same way. */
    const why = result.ok ? weakness(result) : null;
    if (!wanted && why && cfg.fallbackModel && cfg.fallbackModel !== cfg.model && result.model !== cfg.fallbackModel
      && !(await spentToday(apiKey, cfg.fallbackModel))) {
      const second = await readSheetReliably({
        apiKey, model: cfg.fallbackModel, images: image, knownSuppliers,
        maxOutputTokens: cfg.maxOutputTokens, temperature: cfg.temperature,
      }, record);
      if (second.ok && (!weakness(second) || !result.ok)) {
        result = second;
        notes.push(`page ${p + 1} read again on ${second.model} because ${why}`);
      }
    }
    await db.update(schema.scanBatches).set({ warningText: null }).where(eq(schema.scanBatches.id, id));

    tokensIn += result.tokensIn ?? 0;
    tokensOut += result.tokensOut ?? 0;

    if (only && (result.quota || !result.ok || !result.page)) {
      await db.update(schema.scanBatches).set({ tokensIn, tokensOut }).where(eq(schema.scanBatches.id, id));
      await keepAsWas(result.error ?? "the reader stopped.");
      return;
    }
    // a page that had lines, read again as empty, is a bad read: its lines are not thrown away for it
    if (only && result.page && !result.page.rows.length && before.some((r) => (r.page ?? 1) === only)) {
      await db.update(schema.scanBatches).set({ tokensIn, tokensOut }).where(eq(schema.scanBatches.id, id));
      await keepAsWas("no line was read on it.");
      return;
    }

    if (result.quota) {
      // keep what was read; "Read again" resumes from this page instead of page 1
      await db.update(schema.scanBatches).set({
        status: "failed", errorText: result.error ?? "Gemini limit reached", warningText: null,
        parsedRows: collected.length ? JSON.stringify(collected) : null,
        pagesDone: p, model: modelUsed, tokensIn, tokensOut,
        rawResponse: JSON.stringify(result.raw ?? null).slice(0, 40000),
      }).where(eq(schema.scanBatches.id, id));
      await audit({
        actor: { ...opts.actorInfo, businessId: biz },
        action: "scan.read.quota", entity: "scan_batch", entityId: id,
        entityLabel: `stopped at page ${p + 1} of ${files.length}: ${result.quota.kind} limit`,
      });
      return;
    }

    if (!result.ok || !result.page) {
      /* Never skip a page: its rows would silently be missing from the list.
         Stop here, keep the pages already read, and "Read again" carries on
         from this page. */
      const kept = p > 0 ? ` Page${p > 1 ? "s" : ""} 1${p > 1 ? `–${p}` : ""} ${p > 1 ? "are" : "is"} kept.` : "";
      const tried = (result.attempts ?? 1) > 1 ? ` Tried ${result.attempts} times.` : "";
      const next = ` Press "Read again" to continue from page ${p + 1}${files.length > 1 ? ` of ${files.length}` : ""}.`;
      const detail = ` Details: ${result.model}${result.status ? `, HTTP ${result.status}` : ""}${result.finishReason ? `, ${result.finishReason}` : ""}${result.attempts && result.attempts > 1 ? `, ${result.attempts} tries` : ""}.`;
      await db.update(schema.scanBatches).set({
        status: "failed",
        errorText: `${result.error ?? "Unknown error"}${tried}${kept}${next}${detail}`,
        warningText: null,
        parsedRows: collected.length ? JSON.stringify(collected) : null,
        pagesDone: p, model: result.model, tokensIn, tokensOut,
        rawResponse: JSON.stringify(result.raw ?? null).slice(0, 40000),
      }).where(eq(schema.scanBatches.id, id));
      await audit({
        actor: { ...opts.actorInfo, businessId: biz },
        action: "scan.read.fail", entity: "scan_batch", entityId: id,
        entityLabel: `page ${p + 1} of ${files.length}: ${result.error ?? "failed"}`,
        after: { model: result.model, status: result.status ?? null, finishReason: result.finishReason ?? null, attempts: result.attempts ?? 1, ms: result.ms, page: p + 1, of: files.length },
      });
      return;
    } else {
      modelUsed = result.model;
      if (result.truncated) notes.push(`page ${p + 1} reply was cut short; complete rows were kept`);
      // after every line already held, so a page read again never takes another page's line number
      const offset = collected.reduce((n, r) => Math.max(n, (Number(r.id.slice(1)) || 0) + 1), 0);
      for (const [i, r] of result.page.rows.entries()) {
        // the page is the image's position — never the model's guess
        collected.push(ocrToReviewRow({ ...r, page: p + 1 }, offset + i));
      }
      if (only) {
        // in page order, as a whole read leaves them
        collected.sort((a, b) => (a.page ?? 1) - (b.page ?? 1) || Number(a.id.slice(1)) - Number(b.id.slice(1)));
        notes.push(`page ${p + 1} was read again: ${result.page.rows.length} lines`);
      }
      pageMeta.push({
        page: p + 1, date: result.page.date ?? null, millName: result.page.millName ?? null,
        jins: result.page.jins ?? null, total: result.page.totalWeightWritten ?? null,
        // lines after the last whole one may be missing: the page waits for a look (or a second read)
        ...(result.truncated ? { truncated: true } : {}),
      });
    }

    // save after every page so the grid fills in while the rest is read
    await db.update(schema.scanBatches).set({
      pageMeta: JSON.stringify([...pageMeta].sort((a, b) => a.page - b.page)),
      parsedRows: JSON.stringify(collected),
      pagesDone: only ? files.length : p + 1,
      model: modelUsed,
      tokensIn, tokensOut,
    }).where(eq(schema.scanBatches.id, id));
  }

  const usable = collected.filter(
    (r) => r.rstNo || r.grossGrams !== null || r.adatiRawText,
  );
  if (usable.length === 0) {
    await db.update(schema.scanBatches).set({
      status: "failed",
      errorText: "Nothing on these pages looks like a daily list. Check they are the purchase register pages, right way up and in focus.",
    }).where(eq(schema.scanBatches.id, id));
    await audit({
      actor: { ...opts.actorInfo, businessId: biz },
      action: "scan.read.empty", entity: "scan_batch", entityId: id,
      entityLabel: `${modelUsed} found no usable rows`,
    });
    return;
  }

  await db.update(schema.scanBatches).set({
    status: "review",
    warningText: notes.length ? notes.join(". ") + "." : null,
    errorText: null,
  }).where(eq(schema.scanBatches.id, id));
  await refreshScanMeta(biz, id);

  await audit({
    actor: { ...opts.actorInfo, businessId: biz },
    action: "scan.read", entity: "scan_batch", entityId: id,
    entityLabel: only
      ? `page ${only} of ${files.length} read again via ${modelUsed}: ${collected.filter((r) => r.page === only).length} rows`
      : `${collected.length} rows from ${files.length} page(s) via ${modelUsed}`,
    after: { rows: collected.length, pages: files.length, model: modelUsed, tokensIn, tokensOut, notes },
  });
}

/** Starts the read and returns immediately. Poll GET /scans/:id for progress. */
/**
 * Starts reading a scan in the background. Used by the Read button and by
 * the scanner folder (auto-read). Throws the same errors the button shows.
 */
export async function startRead(biz: string, id: string, actorInfo: { userId: string | null; userName: string | null }, req: { model?: string; force?: boolean; page?: number } = {}) {
  const batch = await loadBatch(biz, id);
  if (batch.status === "committed") throw new HttpError(409, "This scan is already on the daily list", "already_committed");
  if (inFlight.has(id)) return { started: true, alreadyRunning: true };

  const keyRaw = await setting(biz, "gemini.apiKey");
  const apiKey = keyRaw ? decryptSecret(keyRaw) : null;
  if (!apiKey) throw bad("Add the Gemini API key in Settings first", "no_key");

  const cfgRaw = await setting(biz, "gemini");
  const cfg = cfgRaw ? GeminiConfigSchema.parse(JSON.parse(cfgRaw)) : defaultGeminiConfig();
  const wanted = req.model;
  const files: { name: string }[] = JSON.parse(batch.filePaths);
  /* One page read again (its answer was cut short, or it was read badly):
     only that page's lines are replaced; every other page, and the changes
     made on it, stay. The screen asks before it sends this. */
  const only = req.page;
  if (only !== undefined) {
    if (!Number.isInteger(only) || only < 1 || only > files.length) throw bad(`This scan has ${files.length} page(s)`, "no_page");
    if (batch.status !== "review" || pagesRead(batch) < files.length) {
      throw new HttpError(409, "One page can be read again once every page of the sheet is read.", "not_read");
    }
    assertImagesHere(id, [files[only - 1]]);
  } else assertImagesHere(id, files);
  const partial: ReviewRow[] = batch.parsedRows ? JSON.parse(batch.parsedRows) : [];
  const resume = only === undefined && batch.status === "failed" && batch.pagesDone > 0 && batch.pagesDone < files.length;
  // a full read replaces every row: ask first whenever there are rows to lose
  if (only === undefined && (batch.status === "review" || (!resume && partial.length > 0)) && !req.force) {
    throw new HttpError(409, "This sheet is already read. Reading it again replaces every row and your edits, and uses one read per page.", "confirm_reread");
  }

  await db.update(schema.scanBatches)
    .set(resume || only
      ? { status: "reading", errorText: null, warningText: null }
      : { status: "reading", errorText: null, warningText: null, pagesDone: 0, parsedRows: null, pageMeta: null })
    .where(eq(schema.scanBatches.id, id));

  inFlight.add(id);
  if (only) rereading.set(id, only);
  void performRead({
    biz, id, apiKey, cfg, wanted, actorInfo,
    ...(resume ? { resumeFrom: batch.pagesDone, resumeRows: partial } : {}),
    ...(only ? { only } : {}),
  })
    .catch(async (err) => {
      console.error("[scan]", id, err);
      await db.update(schema.scanBatches).set(only
        // the other pages' lines are all still there: the sheet stays as it was
        ? { status: "review", warningText: `Page ${only} could not be read again: ${err instanceof Error ? err.message : "the reader stopped."} Its lines are as they were.` }
        : { status: "failed", errorText: err instanceof Error ? err.message : "The reader stopped unexpectedly" },
      ).where(eq(schema.scanBatches.id, id));
    })
    .finally(() => { inFlight.delete(id); rereading.delete(id); });
  return { started: true };
}

scanRoutes.post("/:id/run", can("scan.create"), async (c) => {
  const reqBody = z.object({
    model: z.string().trim().min(3).max(80).optional(),
    force: z.boolean().optional(),
    page: z.number().int().min(1).optional(),
  }).parse(await c.req.json().catch(() => ({})));
  const actorInfo = { userId: c.get("auth")!.user.id, userName: c.get("auth")!.user.name };
  return c.json(await startRead(c.get("auth")!.businessId!, param(c, "id"), actorInfo, reqBody ?? {}));
});

/**
 * Reads one page of this scan on one model and reports how well it did,
 * without changing the scan: the rows on the scan (with the operator's
 * corrections) are the yardstick. Spends one read of that model's allowance.
 */
scanRoutes.post("/:id/try-model", can("scan.create"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const id = param(c, "id");
  const batch = await loadBatch(biz, id);
  const body = z.object({ model: z.string().trim().min(3).max(80).regex(/^[a-z0-9][a-z0-9.\-]*$/i), page: z.number().int().min(1).default(1) })
    .parse(await c.req.json());
  const files: { name: string; mimeType: string }[] = JSON.parse(batch.filePaths);
  if (body.page > files.length) throw bad(`This scan has ${files.length} page(s)`, "no_page");
  assertImagesHere(id, [files[body.page - 1]]);

  const keyRaw = await setting(biz, "gemini.apiKey");
  const apiKey = keyRaw ? decryptSecret(keyRaw) : null;
  if (!apiKey) throw bad("Add the Gemini API key in Settings first", "no_key");
  const cfgRaw = await setting(biz, "gemini");
  const cfg = cfgRaw ? GeminiConfigSchema.parse(JSON.parse(cfgRaw)) : defaultGeminiConfig();

  const resolver = await loadResolver(biz);
  const file = files[body.page - 1];
  const r = await readSheetReliably({
    apiKey, model: body.model, knownSuppliers: resolver.candidateNames(300),
    images: [{ base64: fs.readFileSync(scanFile(id, file.name)).toString("base64"), mimeType: file.mimeType }],
    maxOutputTokens: cfg.maxOutputTokens, temperature: cfg.temperature,
  }, (x) => recordCall({ businessId: biz, apiKey, result: x }), { sleep: (ms) => new Promise((res) => setTimeout(res, Math.min(ms, 5_000))) });

  await audit({
    actor: actor(c), action: "scan.try_model", entity: "scan_batch", entityId: id,
    entityLabel: `${body.model} on page ${body.page}: ${r.ok ? `${r.page?.rows.length ?? 0} rows` : r.error ?? "failed"}`,
  });
  const base = { model: body.model, page: body.page, ms: r.ms, attempts: r.attempts, tokensIn: r.tokensIn ?? null, tokensOut: r.tokensOut ?? null };
  if (!r.ok || !r.page) {
    return c.json({
      ...base, ok: false, error: r.error ?? "failed",
      quota: r.quota ? { kind: r.quota.kind, limit: r.quota.limit, notFree: Boolean(r.quota.notFree) } : null,
    });
  }

  const read = r.page.rows.filter((x) => !x.struckThrough);
  const withNet = read.filter((x) => x.grossQtl != null && x.netQtl != null);
  // net on this mill's own katauti terms, as the review grid works it out
  const terms = await katautiFor(biz, batch.merchantId);
  const netAgreeing = withNet.filter((x) => {
    const g = qtlToGrams(x.grossQtl!);
    return Math.abs(g - deriveKatauti(g, terms, null).deductionGrams - qtlToGrams(x.netQtl!)) <= 1500;
  }).length;
  const conf = read.map((x) => x.confidence).filter((x): x is number => x != null);

  // the scan's own rows for this page, as the operator left them
  const saved: ReviewRow[] = batch.parsedRows ? JSON.parse(batch.parsedRows) : [];
  const ref = new Map(saved.filter((x) => !x.excluded && (x.page ?? 1) === body.page && x.rstNo).map((x) => [x.rstNo, x]));
  let same = 0, rstFound = 0, grossSame = 0, rateSame = 0, nameSame = 0, namesChecked = 0;
  const rows = r.page.rows.map((o, i) => {
    const rr = ocrToReviewRow(o, i);
    const want = ref.get(rr.rstNo);
    const who = rr.adatiRawText ? resolver.resolve(rr.adatiRawText, rr.modelPick).match : null;
    let diff: string[] = [];
    if (want && !o.struckThrough) {
      rstFound++;
      const g = want.grossGrams === rr.grossGrams; if (g) grossSame++; else diff.push("gross");
      const t = want.ratePaisePerQtl === rr.ratePaisePerQtl; if (t) rateSame++; else diff.push("rate");
      // the supplier the scan's row goes to: picked by hand, else as matched on screen
      const wantId = want.adatiId ?? (want.adatiRawText ? resolver.resolve(want.adatiRawText, want.modelPick).match?.adatiId : null);
      if (wantId) {
        namesChecked++;
        if (who?.adatiId === wantId) nameSame++; else diff.push("name");
      }
      if (!diff.length) same++;
    } else diff = [];
    return {
      rstNo: rr.rstNo, name: rr.adatiRawText, matchedName: who?.nameHi ?? null,
      grossQtl: o.grossQtl ?? null, netQtl: o.netQtl ?? null, rate: o.rate ?? null,
      confidence: o.confidence ?? null, struckThrough: o.struckThrough === true,
      onScan: Boolean(want), diff,
    };
  });
  return c.json({
    ...base, ok: true, truncated: Boolean(r.truncated),
    rowsRead: read.length, netChecked: withNet.length, netAgreeing,
    meanConfidence: conf.length ? conf.reduce((a, x) => a + x, 0) / conf.length : null,
    namesRead: read.filter((x) => x.adatiName?.trim()).length,
    vsScan: { rows: ref.size, rstFound, same, grossSame, rateSame, nameSame, namesChecked },
    rows,
  });
});

/* ------------------------------------------------------------------ review */

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

/**
 * The version of a sheet's rows and header that a screen last saw. Two
 * people (or two tabs) on one sheet: a save built on an older version is
 * refused instead of quietly putting back what the other one corrected.
 */
function revOf(b: { parsedRows: string | null; slipDate: string | null; merchantId: string | null; jinsId: string | null }) {
  return crypto.createHash("sha1").update(`${b.parsedRows ?? ""}|${b.slipDate ?? ""}|${b.merchantId ?? ""}|${b.jinsId ?? ""}`).digest("hex").slice(0, 16);
}

scanRoutes.get("/:id", can("scan.review", "scan.create"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const batch = await loadBatch(biz, param(c, "id"));
  const checked = batch.parsedRows && batch.status !== "reading"
    ? await checkAll(biz, batch) : { rows: [], summary: null, katauti: null, pageChecks: [], rateRange: null };
  const files: { name: string; mimeType: string; bytes: number }[] = JSON.parse(batch.filePaths);
  // what the reader saw at the head and foot of each page, to show beside the date, mill and commodity
  const header = (JSON.parse(batch.pageMeta ?? "[]") as PageMeta[])
    .map((m) => ({ page: m.page, date: m.date, millName: m.millName, jins: m.jins, total: m.total, truncated: Boolean(m.truncated) }));
  return c.json({
    id: batch.id, status: batch.status, sourceKind: batch.sourceKind,
    slipDate: batch.slipDate, merchantId: batch.merchantId, jinsId: batch.jinsId,
    model: batch.model, errorText: batch.errorText, warningText: batch.warningText,
    running: inFlight.has(batch.id),
    rereadPage: rereading.get(batch.id) ?? null,
    pagesDone: pagesRead(batch),
    tokensIn: batch.tokensIn, tokensOut: batch.tokensOut,
    createdAt: batch.createdAt, reviewedAt: batch.reviewedAt,
    pages: files.map((f, i) => ({ index: i, name: f.name, mimeType: f.mimeType, bytes: f.bytes })),
    header, rev: revOf(batch),
    // the same paper uploaded on another sheet: a warning beside it, never a stop
    samePictures: await samePictures(biz, batch),
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
  /* The screen asks for a page by its place and its file name. Pictures are
     kept in the browser for an hour, and putting the pages in order changes
     which picture is at a place: by name, the picture shown beside a page's
     lines is always that page's, never one cached from before the move. */
  const byName = c.req.query("f");
  const file = byName ? files.find((x) => x.name === byName) : files[Number(param(c, "index"))];
  if (!file) throw notFound("Page not found");
  const full = scanFile(batch.id, file.name);
  if (!fs.existsSync(full)) throw notFound("This page's picture is on the computer that scanned it");
  return new Response(fs.readFileSync(full), {
    headers: { "Content-Type": file.mimeType, "Cache-Control": "private, max-age=3600" },
  });
});

/** Save edits. Sends back the freshly re-checked rows so the UI stays honest. */
scanRoutes.put("/:id/rows", can("scan.review"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const id = param(c, "id");
  // the body first: the sheet's state is read after it, not before a slow upload
  const { rows, slipDate, merchantId, jinsId, rev } = z.object({
    rows: z.array(ReviewRowSchema),
    slipDate: isoDay().nullish(),
    merchantId: z.string().nullish(),
    jinsId: z.string().nullish(),
    /** The version this screen last saw; left out by older screens and scripts. */
    rev: z.string().max(64).optional(),
  }).parse(await c.req.json());
  const batch = await loadBatch(biz, id);
  if (batch.status === "committed") throw new HttpError(409, "This scan has already been added to the daily list", "already_committed");
  // while the reader runs it owns the rows (they are not saved from here), so only the header can change
  if (rev && batch.status !== "reading" && rev !== revOf(batch)) {
    throw new HttpError(409, "Someone else changed this sheet while you were on it. It has been loaded again: check your last change.", "stale_rows");
  }

  await checkSlipRefs(biz, { jinsId: jinsId ?? undefined, merchantId: merchantId ?? undefined });
  // what the model read is kept exactly as read: only the operator's columns come from the screen
  const asRead = new Map((JSON.parse(batch.parsedRows ?? "[]") as ReviewRow[]).map((r) => [r.id, r]));
  const NOT_READ = { rstNo: null, adatiName: null, village: null, grossQtl: null, katauti: null, netQtl: null, rate: null, confidence: null, struckThrough: null, srNo: null };
  /* A name typed over a row is settled here, not at commit: the same spelling
     twice on one sheet is one supplier, and the row comes back pointing at it. */
  const made = new Map<string, { id: string; nameHi: string; nameHinglish: string; created: boolean }>();
  for (const r of rows) {
    const typed = r.typedName?.trim();
    if (!typed) continue;
    if (!made.has(typed)) made.set(typed, await ensureSupplier(biz, typed, actor(c)));
  }
  const kept = rows.map((r) => {
    const m = r.typedName?.trim() ? made.get(r.typedName.trim()) : null;
    return {
      ...r, rstNo: normRst(r.rstNo), typedName: null,
      ...(m ? { adatiId: m.id, adatiRawText: r.adatiRawText || m.nameHi, nameCorrected: true } : {}),
      ocr: asRead.get(r.id)?.ocr ?? NOT_READ, modelPick: asRead.get(r.id)?.modelPick ?? null,
    };
  });
  await db.update(schema.scanBatches).set({
    // the reader owns the rows while it runs; the header is the operator's
    ...(batch.status === "reading" ? {} : { parsedRows: JSON.stringify(kept) }),
    ...(slipDate !== undefined ? { slipDate: slipDate ?? null } : {}),
    ...(merchantId !== undefined ? { merchantId: merchantId ?? null } : {}),
    ...(jinsId !== undefined ? { jinsId: jinsId ?? null } : {}),
  // a sheet added to the daily list a moment ago keeps the rows its slips came from
  }).where(and(eq(schema.scanBatches.id, id), ne(schema.scanBatches.status, "committed")));

  const fresh = await loadBatch(biz, id);
  await refreshScanMeta(biz, id);
  /* The date, mill and commodity decide where every slip of the sheet lands:
     who moved them, and from what, is kept. */
  const head = (b: typeof batch) => ({ slipDate: b.slipDate, merchantId: b.merchantId, jinsId: b.jinsId });
  if (fresh.status !== "committed" && JSON.stringify(head(batch)) !== JSON.stringify(head(fresh))) {
    const codes = new Map<string | null, string>([[null, "own firm"]]);
    for (const m of await db.select({ id: schema.merchants.id, code: schema.merchants.code }).from(schema.merchants).where(eq(schema.merchants.businessId, biz))) codes.set(m.id, m.code);
    for (const j of await db.select({ id: schema.jins.id, code: schema.jins.code }).from(schema.jins).where(eq(schema.jins.businessId, biz))) codes.set(j.id, j.code);
    const said: string[] = [];
    if (batch.slipDate !== fresh.slipDate) said.push(`date ${batch.slipDate ?? "—"} → ${fresh.slipDate ?? "—"}`);
    if (batch.merchantId !== fresh.merchantId) said.push(`mill ${codes.get(batch.merchantId) ?? "?"} → ${codes.get(fresh.merchantId) ?? "?"}`);
    if (batch.jinsId !== fresh.jinsId) said.push(`commodity ${batch.jinsId ? codes.get(batch.jinsId) ?? "?" : "—"} → ${fresh.jinsId ? codes.get(fresh.jinsId) ?? "?" : "—"}`);
    await audit({
      actor: actor(c), action: "scan.header", entity: "scan_batch", entityId: id,
      entityLabel: said.join(", "), before: head(batch), after: head(fresh),
    });
  }
  const newOnes = [...made.values()].filter((m) => m.created);
  if (newOnes.length) {
    await audit({
      actor: actor(c), action: "scan.typed_suppliers", entity: "scan_batch", entityId: id,
      entityLabel: `${newOnes.length} new supplier${newOnes.length === 1 ? "" : "s"} typed on the sheet`,
      after: { names: newOnes.map((m) => m.nameHinglish) },
    });
  }
  return c.json({ ...(await checkAll(biz, fresh)), rev: revOf(fresh), suppliersCreated: newOnes.map((m) => ({ id: m.id, nameHi: m.nameHi, nameHinglish: m.nameHinglish })) });
});

/**
 * The operator checked a page against the paper: its rows line by line, its
 * date, its total, its line count, its crossed-out lines, or the mill and
 * commodity its header names. The tick is tied to what it was given for —
 * the dates, the sums — and lapses when that changes.
 */
scanRoutes.put("/:id/page-confirm", can("scan.review"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const id = param(c, "id");
  const { page, what, on } = z.object({
    page: z.number().int().min(1),
    what: z.enum(["rows", "date", "total", "cut", "count", "struck", "mill", "jins", "norate", "order"]),
    on: z.boolean(),
  }).parse(await c.req.json());
  const batch = await loadBatch(biz, id);
  if (batch.status === "committed") throw new HttpError(409, "This scan has already been added to the daily list", "already_committed");
  const shown = on ? (await checkAll(biz, batch)).pageChecks.find((p) => p.page === page && p.code === `page_${what}`) : undefined;
  /* The ticks as they are now, read and written in one go: two ticks sent
     together each keep the other's, and none is lost. */
  db.transaction((tx) => {
    const now = tx.select({ pageMeta: schema.scanBatches.pageMeta, status: schema.scanBatches.status })
      .from(schema.scanBatches).where(eq(schema.scanBatches.id, id)).get();
    if (!now || now.status === "committed") throw new HttpError(409, "This scan has already been added to the daily list", "already_committed");
    const meta = JSON.parse(now.pageMeta ?? "[]") as PageMeta[];
    let m = meta.find((x) => x.page === page);
    if (!m) { m = { page, date: null, millName: null, jins: null, total: null }; meta.push(m); }
    const set = new Set(m.confirmed ?? []);
    const given = { ...(m.confirmedFor ?? {}) };
    if (on) { set.add(what); given[what] = shown?.stamp ?? ""; } else { set.delete(what); delete given[what]; }
    m.confirmed = [...set];
    m.confirmedFor = given;
    tx.update(schema.scanBatches).set({ pageMeta: JSON.stringify(meta) }).where(eq(schema.scanBatches.id, id)).run();
  });
  await audit({
    actor: actor(c), action: "scan.page_confirm", entity: "scan_batch", entityId: id,
    entityLabel: `Page ${page}: ${what} ${on ? "checked" : "unchecked"}`,
    ...(shown ? { after: { what, params: shown.params } } : {}),
  });
  return c.json(await checkAll(biz, await loadBatch(biz, id)));
});

/* ------------------------------------------------------------------ commit */

scanRoutes.post("/:id/commit", canAll("scan.review", "slip.write"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const userId = c.get("auth")!.user.id;
  const id = param(c, "id");
  /** The version of the sheet the "are you sure" box was built from; left out by older screens and scripts. */
  const { rev } = z.object({ rev: z.string().max(64).optional() }).parse(await c.req.json().catch(() => ({})));
  const batch = await loadBatch(biz, id);
  if (batch.status === "committed") throw new HttpError(409, "This scan has already been added to the daily list", "already_committed");
  // what was confirmed is what is written: a change from another screen since then is shown first
  if (rev && rev !== revOf(batch)) {
    throw new HttpError(409, "Someone else changed this sheet while you were on it. It has been loaded again: check your last change.", "stale_rows");
  }
  if (!batch.slipDate) throw bad("Set the sheet date before adding it to the daily list", "no_date");
  if (!batch.jinsId) throw bad("Set the commodity before adding it to the daily list", "no_jins");
  await assertDaysOpen(biz, batch.slipDate);

  const pageCount = (JSON.parse(batch.filePaths) as unknown[]).length;
  const read = pagesRead(batch);
  if (batch.status !== "review" || read < pageCount) {
    throw new HttpError(409, read === 0
      ? "This sheet has not been read yet. Press “Read the sheet” first, then check the rows and add it."
      : `Only ${read} of ${pageCount} pages are read. Press “Read again” to read the rest, then add the sheet.`, "incomplete");
  }

  await checkSlipRefs(biz, { jinsId: batch.jinsId, merchantId: batch.merchantId });
  const { rows, summary, katauti } = await checkAll(biz, batch);
  const toWrite = rows.filter((r) => !r.excluded);
  if (!toWrite.length) throw bad("Every row is excluded — nothing to add", "nothing_to_commit");
  /* Every refusal comes before anything is written: a sheet that is not
     added leaves no new supplier behind, and its rows keep their "new
     supplier" marks and close suggestions. */
  // the same rules as typing a slip by hand
  if (toWrite.some((r) => (r.ratePaisePerQtl ?? 0) > 0) && !c.get("auth")!.permissions.has("rate.edit")) {
    throw new HttpError(403, "This sheet carries rates, and you may not set purchase rates. Ask someone who may to add it.", "forbidden");
  }
  if (summary && summary.blocking > 0) {
    throw new HttpError(409, `${summary.blocking} row${summary.blocking === 1 ? "" : "s"} still need fixing before this can be added`, "has_blocking");
  }
  if (summary && summary.pagesBlocking > 0) {
    throw new HttpError(409, "A page's date, total or rows still need checking against the paper before this can be added", "has_blocking");
  }
  const outOfRange = (r: CheckedRow) => r.grossGrams === null || r.grossGrams <= 0 || r.grossGrams > LIMIT.grams
    || (r.ratePaisePerQtl ?? 0) < 0 || (r.ratePaisePerQtl ?? 0) > LIMIT.rate;
  const nameless = (r: CheckedRow) => !(r.adatiId ?? r.match?.adatiId) && !r.adatiRawText.trim();
  const unfitFirst = toWrite.filter((r) => outOfRange(r) || nameless(r));
  if (unfitFirst.length) {
    throw new HttpError(409, `${unfitFirst.length} row${unfitFirst.length === 1 ? " has" : "s have"} no supplier, no weight, or a figure out of range (RST ${unfitFirst.slice(0, 5).map((r) => r.rstNo || "—").join(", ")})`, "has_blocking");
  }
  // names nobody matched: made into suppliers now, the way a typed name on the daily list is
  const newlyMade: { rowId: string; adatiId: string; nameHi: string }[] = [];
  const madeByName = new Map<string, string>();
  for (const r of toWrite) {
    if (r.adatiId ?? r.match?.adatiId) continue;
    const raw = r.adatiRawText.trim();
    if (!raw) continue;
    let adatiId = madeByName.get(raw);
    if (!adatiId) { const m = await ensureSupplier(biz, raw, actor(c)); adatiId = m.id; madeByName.set(raw, adatiId); }
    r.adatiId = adatiId;
    newlyMade.push({ rowId: r.id, adatiId, nameHi: raw });
  }
  if (newlyMade.length) {
    const stored = JSON.parse(batch.parsedRows ?? "[]") as { id: string }[];
    const by = new Map(newlyMade.map((x) => [x.rowId, x.adatiId]));
    await db.update(schema.scanBatches).set({ parsedRows: JSON.stringify(stored.map((x) => (by.has(x.id) ? { ...x, adatiId: by.get(x.id), nameCorrected: false } : x))) })
      .where(eq(schema.scanBatches.id, id));
  }
  // a supplier for every line now, or nothing is written
  const unfit = toWrite.filter((r) => !(r.adatiId ?? r.match?.adatiId));
  if (unfit.length) {
    throw new HttpError(409, `${unfit.length} row${unfit.length === 1 ? " has" : "s have"} no supplier (RST ${unfit.slice(0, 5).map((r) => r.rstNo || "—").join(", ")})`, "has_blocking");
  }

  // work everything out first, then write it all or nothing
  const slipRows: (typeof schema.purchaseSlips.$inferInsert)[] = [];
  // what each supplier adds to their receipt: today's terms, kept on every slip
  const sTerms = termsOnly(await supplierChargesOf(biz));
  const aliasOps: { raw: string; adatiId: string; corrected: boolean }[] = [];
  const whoFor = new Map<string, string>();
  for (const r of toWrite) {
    const adatiId = (r.adatiId ?? r.match?.adatiId)!;
    const d = deriveSlip(r.grossGrams!, katauti!, r.ratePaisePerQtl ?? 0, r.katautiOverride);
    if (d.netGrams <= 0) throw new HttpError(409, `RST ${r.rstNo}: the net weight works out to zero or less — check the gross`, "has_blocking");
    slipRows.push({
      id: newId(), businessId: biz,
      slipDate: batch.slipDate, rstNo: normRst(r.rstNo),
      adatiId, jinsId: batch.jinsId,
      merchantId: batch.merchantId,
      grossGrams: r.grossGrams!,
      katautiUnits: d.katautiUnits,
      katautiOverride: r.katautiOverride != null,
      katautiTerms: JSON.stringify(katauti),
      supplierTerms: JSON.stringify(sTerms),
      ...slipCharges(d.amountPaise, d.netGrams, r.ratePaisePerQtl ?? 0, sTerms),
      netGrams: d.netGrams,
      ratePaisePerQtl: r.ratePaisePerQtl ?? 0,
      amountPaise: d.amountPaise,
      scanBatchId: id,
      ocrConfidence: r.ocr.confidence ?? null,
      enteredBy: userId,
    });
    const raw = r.adatiRawText.trim();
    if (raw) aliasOps.push({ raw, adatiId, corrected: r.nameCorrected });
    whoFor.set(slipRows[slipRows.length - 1].id as string, r.chosen?.nameHinglish ?? r.match?.nameHinglish ?? raw);
  }
  const existingAliases = aliasOps.length ? await db.select().from(schema.adatiAliases)
    .where(and(eq(schema.adatiAliases.businessId, biz), inArray(schema.adatiAliases.rawText, [...new Set(aliasOps.map((a) => a.raw))]))) : [];
  const aliasByRaw = new Map(existingAliases.map((a) => [a.rawText, a]));
  const learned: { rawText: string; adatiId: string }[] = [];

  db.transaction((tx) => {
    /* The sheet is marked added first, and only if it is still waiting: of
       two "Add"s sent together, the second writes nothing. */
    const claimed = tx.update(schema.scanBatches).set({ status: "committed", reviewedBy: userId, reviewedAt: nowSec() })
      .where(and(eq(schema.scanBatches.id, id), eq(schema.scanBatches.status, "review"))).run();
    if (claimed.changes !== 1) throw new HttpError(409, "This scan has already been added to the daily list", "already_committed");
    for (const v of slipRows) tx.insert(schema.purchaseSlips).values(v).run();
    for (const a of aliasOps) {
      const ex = aliasByRaw.get(a.raw);
      /* Teach the resolver only what the operator decided. The model's own
         pick is not proof: learning it would make a wrong guess permanent. */
      if (ex && ex.adatiId === a.adatiId) {
        tx.update(schema.adatiAliases).set({ hits: ex.hits + 1, lastUsedAt: nowSec() }).where(eq(schema.adatiAliases.id, ex.id)).run();
      } else if (ex && a.corrected) {
        tx.update(schema.adatiAliases).set({ adatiId: a.adatiId, hits: 1, lastUsedAt: nowSec(), normKey: normKey(a.raw), source: "correction" })
          .where(eq(schema.adatiAliases.id, ex.id)).run();
        learned.push({ rawText: a.raw, adatiId: a.adatiId });
      } else if (!ex && a.corrected) {
        const row = { id: newId(), businessId: biz, adatiId: a.adatiId, rawText: a.raw, normKey: normKey(a.raw), source: "correction", createdBy: userId };
        tx.insert(schema.adatiAliases).values(row).run();
        aliasByRaw.set(a.raw, { ...row, hits: 1, lastUsedAt: nowSec(), createdAt: nowSec() } as never);
        learned.push({ rawText: a.raw, adatiId: a.adatiId });
      }
    }
  });
  const created = slipRows.map((v) => v.id as string);
  for (const v of slipRows) await enqueueSync(biz, "purchase_slip", v.id as string, "insert", { rstNo: v.rstNo, adatiId: v.adatiId });

  await refreshScanMeta(biz, id);

  await audit({
    actor: actor(c), action: "scan.commit", entity: "scan_batch", entityId: id,
    entityLabel: `${created.length} slips added to ${batch.slipDate}${newlyMade.length ? ` · ${new Set(newlyMade.map((x) => x.adatiId)).size} new supplier(s)` : ""}`,
    after: { slips: created.length, learnedAliases: learned.length, slipDate: batch.slipDate },
  });
  /* Each slip is in the trail on its own, with every value it was saved
     with, as a slip typed by hand is: the CA looks a slip up by its RST. */
  for (const v of slipRows) {
    await audit({
      actor: actor(c), action: "slip.create", entity: "purchase_slip", entityId: v.id as string,
      entityLabel: `${v.slipDate} RST ${v.rstNo || "—"} — ${whoFor.get(v.id as string) ?? ""} (from a scanned sheet)`,
      after: v,
    });
  }

  return c.json({
    ok: true, created: created.length, learnedAliases: learned.length,
    slipDate: batch.slipDate, merchantId: batch.merchantId,
    // an approved parcha priced on this day's average no longer matches it
    approvedParchas: await approvedOnDays(biz, [{ merchantId: batch.merchantId, jinsId: batch.jinsId, date: batch.slipDate }]),
  });
});

/**
 * Put the pages in the right order. The order matters: the daily list keeps
 * it, and each page's first line follows the last line of the page before.
 * Before reading, only the pictures move. Once every page is read — each on
 * its own, so a page's lines belong to its picture whatever its place — the
 * lines, the header and the ticks of each page move with its picture, and
 * nothing is read again.
 */
scanRoutes.put("/:id/order", can("scan.create"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const id = param(c, "id");
  const { order, rev } = z.object({
    order: z.array(z.number().int().min(0)),
    rev: z.string().max(64).optional(),
  }).parse(await c.req.json());
  const batch = await loadBatch(biz, id);
  const files: { name: string; mimeType: string; bytes: number }[] = JSON.parse(batch.filePaths);
  const unread = ["uploaded", "failed"].includes(batch.status) && batch.pagesDone === 0;
  const read = batch.status === "review" && pagesRead(batch) === files.length;
  if (!unread && !read) {
    throw new HttpError(409, "Pages can be put in order before the sheet is read, or once every page of it is read", "already_read");
  }
  if (read && rev && rev !== revOf(batch)) {
    throw new HttpError(409, "Someone else changed this sheet while you were on it. It has been loaded again: check your last change.", "stale_rows");
  }

  const valid = order.length === files.length
    && new Set(order).size === files.length
    && order.every((i) => i < files.length);
  if (!valid) throw bad("The new order must list every page exactly once", "bad_order");

  const next = order.map((i) => files[i]);
  // page n now is the picture that was at order[n - 1]
  const moved = (page: number) => order.indexOf(page - 1) + 1;
  const rows: ReviewRow[] = read ? JSON.parse(batch.parsedRows ?? "[]") : [];
  const meta: PageMeta[] = read ? JSON.parse(batch.pageMeta ?? "[]") : [];
  await db.update(schema.scanBatches).set({
    filePaths: JSON.stringify(next),
    ...(read ? {
      parsedRows: JSON.stringify(rows.map((r) => ({ ...r, page: moved(r.page ?? 1) }))),
      pageMeta: JSON.stringify(meta.map((m) => ({ ...m, page: moved(m.page) })).sort((a, b) => a.page - b.page)),
    } : {}),
  }).where(and(eq(schema.scanBatches.id, id), eq(schema.scanBatches.status, batch.status)));
  await refreshScanMeta(biz, id);
  await audit({
    actor: actor(c), action: "scan.reorder", entity: "scan_batch", entityId: id,
    entityLabel: read ? `pages put in order after reading: ${order.map((i) => i + 1).join(", ")}` : `pages reordered`,
    before: files.map((f) => f.name), after: next.map((f) => f.name),
  });
  const pages = next.map((f, i) => ({ index: i, name: f.name, mimeType: f.mimeType, bytes: f.bytes }));
  if (!read) return c.json({ ok: true, pages });
  const fresh = await loadBatch(biz, id);
  return c.json({ ok: true, pages, ...(await checkAll(biz, fresh)), rev: revOf(fresh) });
});

/**
 * Create suppliers for the names this scan read but the master does not have.
 * On a new business that is every row, and picking them one by one is not a
 * reasonable ask — the names are already on the paper.
 */
scanRoutes.post("/:id/create-suppliers", canAll("adati.write", "scan.review"), async (c) => {
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
  return c.json({ created, linked: assign.size, ...(await checkAll(biz, fresh)), rev: revOf(fresh) });
});

scanRoutes.delete("/:id", can("scan.create"), async (c) => {
  const biz = c.get("auth")!.businessId!;
  const id = param(c, "id");
  const batch = await loadBatch(biz, id);
  if (batch.status === "committed") {
    throw new HttpError(409, "This scan is already on the daily list. Delete those rows there instead.", "already_committed");
  }
  fs.rmSync(scanDir(id), { recursive: true, force: true });
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
  const limit = Math.max(1, Math.min(Number(c.req.query("limit") ?? 40) || 40, 1000));

  /* A sheet still waiting for someone (not read, being read, waiting for
     review, failed) is always listed, whatever its date — or no date — and
     however many sheets were added after it: otherwise it drops off the page
     and its purchases never reach the books. The added ones are filtered by
     date and come in pages. */
  const OPEN = ["uploaded", "reading", "review", "failed", "pending"];
  const S = schema.scanBatches;
  const mine = [eq(S.businessId, biz), ...(merchantId ? [eq(S.merchantId, merchantId)] : [])];
  const dated = [
    ...(from && ISO_DATE.test(from) ? [gte(S.slipDate, from)] : []),
    ...(to && ISO_DATE.test(to) ? [lte(S.slipDate, to)] : []),
  ];
  const where = [...mine];
  if (status && status !== "all") {
    where.push(eq(S.status, status));
    if (!OPEN.includes(status)) where.push(...dated);
  } else if (dated.length) {
    where.push(or(inArray(S.status, OPEN), and(notInArray(S.status, OPEN), ...dated))!);
  }

  // the limit is on top of the waiting ones: however many there are, they all show
  const [{ waiting }] = await db.select({ waiting: sql<number>`count(*)` }).from(S).where(and(...mine, inArray(S.status, OPEN)));

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
    // waiting sheets first, so the limit only ever cuts sheets already added
    .orderBy(sql`case when ${S.status} in ('uploaded','reading','review','failed','pending') then 0 else 1 end`, desc(schema.scanBatches.createdAt))
    .limit(limit + waiting);

  return c.json(rows.map((r) => ({
    ...r,
    pages: (JSON.parse(r.filePaths) as unknown[]).length,
    rowCount: r.parsedRows ? (JSON.parse(r.parsedRows) as unknown[]).length : 0,
    filePaths: undefined,
    parsedRows: undefined,
  })));
});


