import { Hono } from "hono";
import { z } from "zod";
import { can, actor, bad, HttpError, isoDay, type Env } from "../lib/http.ts";
import { audit } from "../lib/audit.ts";
import { listScanners, scanPage, scannerAvailable, scannerDetails, ScanError } from "../lib/scanner.ts";
import { createScan, appendPage } from "./scans.ts";

/* Scan straight from the scanner connected to the computer the app runs on.
   Each press scans one page: the first starts a new sheet, the next ones add
   pages to it, and "Read" then reads the sheet as if it had been uploaded. */
export const scannerRoutes = new Hono<Env>();

scannerRoutes.get("/", can("scan.create"), (c) => c.json({ available: scannerAvailable(), platform: process.platform }));

scannerRoutes.get("/devices", can("scan.create"), async (c) => {
  if (!scannerAvailable()) return c.json({ available: false, devices: [] });
  try {
    return c.json({ available: true, devices: await listScanners() });
  } catch (e) {
    throw bad(e instanceof ScanError ? e.message : "Could not look for scanners", "scanner_error");
  }
});

scannerRoutes.get("/details", can("scan.create"), async (c) => {
  if (!scannerAvailable()) return c.json({ available: false, details: "" });
  try {
    return c.json({ available: true, details: await scannerDetails() });
  } catch (e) {
    throw bad(e instanceof ScanError ? e.message : "Could not ask the scanner", "scanner_error");
  }
});

scannerRoutes.post("/scan", can("scan.create"), async (c) => {
  if (!scannerAvailable()) throw new HttpError(501, "Scanning from the scanner works in the Windows app, on the computer the scanner is connected to. Here, upload the scan as a file.", "no_scanner");
  const biz = c.get("auth")!.businessId!;
  const body = z.object({
    deviceId: z.string().max(300).optional(),
    dpi: z.number().int().min(150).max(600).default(300),
    color: z.boolean().default(true),
    /** Add this page to a sheet already started. */
    scanId: z.string().optional(),
    slipDate: isoDay().nullish(),
    merchantId: z.string().nullish(),
    jinsId: z.string().nullish(),
  }).parse(await c.req.json());

  let bytes: Buffer;
  try {
    bytes = await scanPage({ deviceId: body.deviceId, dpi: body.dpi, color: body.color });
  } catch (e) {
    throw bad(e instanceof ScanError ? e.message : "The scan failed", "scan_failed");
  }
  // the driver may have given BMP, PNG or TIFF; the reader is told which it is
  const head = bytes.subarray(0, 4);
  const mimeType = head[0] === 0x89 && head[1] === 0x50 ? "image/png"
    : head[0] === 0x42 && head[1] === 0x4d ? "image/bmp"
    : (head[0] === 0x49 && head[1] === 0x49) || (head[0] === 0x4d && head[1] === 0x4d) ? "image/tiff"
    : "image/jpeg";

  if (body.scanId) {
    const pages = await appendPage(biz, body.scanId, bytes, mimeType);
    await audit({ actor: actor(c), action: "scan.scanner", entity: "scan_batch", entityId: body.scanId, entityLabel: `page ${pages} from the scanner` });
    return c.json({ id: body.scanId, pages });
  }
  const auth = c.get("auth")!;
  const { id, saved } = await createScan({
    biz, sourceKind: "scanner",
    pages: [{ name: "scanner.jpg", mimeType, size: bytes.length, bytes }],
    slipDate: body.slipDate ?? null, merchantId: body.merchantId ?? null, jinsId: body.jinsId ?? null,
    user: { id: auth.user.id, name: auth.user.name }, actor: actor(c),
  });
  return c.json({ id, pages: saved.length });
});
