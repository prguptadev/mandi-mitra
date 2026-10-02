/* Exercises the OCR review pipeline end to end WITHOUT calling Gemini.
 *
 * A realistic model reading of the G.R.M sheet — including the mistakes a
 * reader actually makes — is injected as if Gemini had returned it, then run
 * through the real validation, correction and commit endpoints.
 *
 * Usage: npx tsx scripts/e2e-scan-review.ts [PIN]
 */
import "./_guard.ts";
import fs from "node:fs";
import path from "node:path";
import { sqlite } from "../server/db/client.ts";

const BASE = process.env.MANDI_API!;
const PIN = process.argv[2] ?? process.env.MANDI_PIN ?? "482915";
const DATE = "2026-09-21"; // a clear date, so nothing collides with the L.B run
let cookie = "";
let bad = 0;

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sc = res.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0];
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
}

const check = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(` ${ok ? "PASS" : "FAIL"}  ${label.padEnd(46)} ${JSON.stringify(got)}${ok ? "" : "  want " + JSON.stringify(want)}`);
};

/* Self-cleaning: this script both COMMITS slips and TEACHES aliases, so a
   second run would legitimately behave differently (the misspelling would
   already be known, the RST numbers already taken). Wipe its own footprint
   first so the assertions describe a first encounter every time. */
const RAW_NAMES = [
  "फूलसिंह वर्मा", "पुष्पेन्द्र यादव", "वीरेन्द्र जोशी", "फुलसिह वर्मा",
  "अज्ञात व्यापारी", "अरुण कुमार यादव", "अरविन्द ट्रेडिंग", "अमित ट्रेडिंग",
  "सहदेव सिंह ट्रेडिंग", "शिवम ट्रेडिंग",
];
{
  sqlite.prepare("delete from purchase_slips where slip_date = ?").run(DATE);
  const olds = sqlite.prepare("select id from scan_batches where slip_date = ?").all(DATE) as any[];
  for (const o of olds) sqlite.prepare("delete from scan_batches where id = ?").run(o.id);
  const del = sqlite.prepare("delete from adati_aliases where raw_text = ? and source in ('ocr','correction')");
  for (const n of RAW_NAMES) del.run(n);
  console.log(`Cleaned ${olds.length} old scan(s), slips and learnt aliases for ${DATE}`);
}

const users = await call("GET", "/auth/users");
await call("POST", "/auth/login", { userId: users.find((u: any) => u.name === "Test Owner").id, pin: PIN });
const mills = await call("GET", "/merchants");
const grm = mills.find((m: any) => m.code === "GRM");
const j1509 = (await call("GET", "/jins")).find((j: any) => j.code === "1509");

/* A 1x1 PNG stands in for the scan; the image is never read by the checks. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const fd = new FormData();
fd.append("files", new File([PNG], "sheet.png", { type: "image/png" }));
fd.append("slipDate", DATE);
fd.append("merchantId", grm.id);
fd.append("jinsId", j1509.id);
const up = await fetch(`${BASE}/scans`, { method: "POST", body: fd, headers: { cookie } });
const { id: scanId } = await up.json() as { id: string };
console.log(`Scan created: ${scanId}\n`);

/* A two-page sheet, mixed PNG + JPEG, is one scan. Your G.R.M list runs
   30 rows then continues onto a second page, so this is the normal case. */
const JPG = Buffer.from("/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==", "base64");
{
  const multi = new FormData();
  multi.append("files", new File([PNG], "page-1.png", { type: "image/png" }));
  multi.append("files", new File([JPG], "page-2.jpg", { type: "image/jpeg" }));
  multi.append("files", new File([JPG], "page-3.jpeg", { type: "" }));   // browser gave no MIME type
  multi.append("slipDate", DATE);
  const r = await fetch(`${BASE}/scans`, { method: "POST", body: multi, headers: { cookie } });
  const j = await r.json() as { id?: string; pages?: number; error?: string };
  console.log("Multi-page upload");
  check("three mixed pages accepted as one scan", j.pages, 3);
  if (j.id) await call("DELETE", `/scans/${j.id}`);

  const empty = new FormData();
  empty.append("slipDate", DATE);
  const r2 = await fetch(`${BASE}/scans`, { method: "POST", body: empty, headers: { cookie } });
  const j2 = await r2.json() as { code?: string };
  check("upload with no file is rejected cleanly", j2.code, "no_file");
  console.log();
}

/* What a model plausibly returns from the G.R.M sheet, warts and all. */
const OCR = [
  // clean rows
  { rstNo: "626", adatiName: "फूलसिंह वर्मा",     grossQtl: 19.20, katauti: 19, netQtl: 19.01, rate: 3500, confidence: 0.94 },
  { rstNo: "629", adatiName: "पुष्पेन्द्र यादव",   grossQtl: 17.30, katauti: 17, netQtl: 17.13, rate: 3525, confidence: 0.91 },
  { rstNo: "632", adatiName: "वीरेन्द्र जोशी",     grossQtl: 32.50, katauti: 33, netQtl: 32.17, rate: 3500, confidence: 0.89 },
  // a misspelling the alias/normkey layer should absorb silently
  { rstNo: "627", adatiName: "फुलसिह वर्मा",       grossQtl: 19.70, katauti: 20, netQtl: 19.50, rate: 3525, confidence: 0.72 },
  // a name that is not in the master at all -> must block
  { rstNo: "637", adatiName: "अज्ञात व्यापारी",    grossQtl: 37.65, katauti: 38, netQtl: 37.27, rate: 3500, confidence: 0.55 },
  // the sheet's own net disagrees with the arithmetic -> warn, not block
  { rstNo: "638", adatiName: "अरुण कुमार यादव",   grossQtl: 19.20, katauti: 19, netQtl: 19.91, rate: 3500, confidence: 0.83 },
  // duplicate RST inside the batch -> both must block
  { rstNo: "640", adatiName: "अरविन्द ट्रेडिंग",   grossQtl: 14.85, katauti: 15, netQtl: 14.70, rate: 3470, confidence: 0.9 },
  { rstNo: "640", adatiName: "अमित ट्रेडिंग",      grossQtl: 26.40, katauti: 26, netQtl: 26.14, rate: 3521, confidence: 0.88 },
  // rate not read -> red until typed or ✓ "fill it in later": never a silent ₹0
  { rstNo: "644", adatiName: "सहदेव सिंह ट्रेडिंग", grossQtl: 40.40, katauti: 40, netQtl: 40.00, rate: null, confidence: 0.8 },
  // struck through on the paper -> excluded automatically
  { rstNo: "634", adatiName: "शिवम ट्रेडिंग",      grossQtl: 41.25, katauti: 41, netQtl: 40.84, rate: 3550, confidence: 0.86, struckThrough: true },
  // the model "picked" a known supplier that looks nothing like the handwriting -> a suggestion, not a match
  { rstNo: "650", adatiName: "रामू लाल",          grossQtl: 12.00, katauti: 12, netQtl: 11.88, rate: 3500, confidence: 0.9, supplierMatch: "फूलसिंह वर्मा" },
] as { rstNo: string; adatiName: string; grossQtl: number; katauti: number; netQtl: number; rate: number | null; confidence: number; struckThrough?: boolean; supplierMatch?: string }[];

const rows = OCR.map((r, i) => ({
  id: `r${i}`,
  ocr: {
    rstNo: r.rstNo, adatiName: r.adatiName, grossQtl: r.grossQtl,
    katauti: r.katauti, netQtl: r.netQtl, rate: r.rate,
    confidence: r.confidence, struckThrough: r.struckThrough ?? null,
  },
  rstNo: r.rstNo,
  adatiId: null,
  adatiRawText: r.adatiName,
  grossGrams: Math.round(r.grossQtl * 100000),
  katautiOverride: null,
  ratePaisePerQtl: r.rate === null ? null : Math.round(r.rate * 100),
  excluded: r.struckThrough === true,
  nameCorrected: false,
  modelPick: r.supplierMatch ?? null,
}));
// a fully read sheet: every page done
sqlite.prepare("update scan_batches set parsed_rows = ?, status = 'review', model = 'simulated', pages_done = json_array_length(file_paths) where id = ?")
  .run(JSON.stringify(rows), scanId);

const v1 = await call("GET", `/scans/${scanId}`);
const byRst = (r: string) => v1.rows.filter((x: any) => x.rstNo === r);

console.log("Validation of the raw reading");
check("rows read", v1.summary.total, 11);
check("struck-through row auto-excluded", v1.summary.excluded, 1);
check("misspelling resolved without help", byRst("627")[0].match?.via, "normkey");
check("  ...to the right supplier", byRst("627")[0].match?.nameHinglish, "PHOOLSINGH VERMA");
check("an unknown name no longer blocks: saving the sheet adds it as a supplier", byRst("637")[0].blocking, false);
check("  ...and the row says so", byRst("637")[0].issues.some((i: any) => i.code === "name_unresolved" && i.level === "warn"), true);
check("  ...with the right reason", byRst("637")[0].issues.some((i: any) => i.code === "name_unresolved"), true);
// a repeated kanta slip no. is highlighted on both rows but never blocks
check("repeated RST flagged on both rows", byRst("640").filter((r: any) => r.issues.some((i: any) => i.code === "rst_dupe")).length, 2);
check("repeated RST does not block", byRst("640").filter((r: any) => r.blocking).length, 0);
check("sheet net disagreeing blocks until the operator confirms it", byRst("638")[0].blocking, true);
check("a model pick unlike the handwriting is not taken as the match", byRst("650")[0].match, null);
check("  ...but offered first among the suggestions", byRst("650")[0].suggestions[0]?.nameHinglish, "PHOOLSINGH VERMA");
check("  ...and is flagged", byRst("638")[0].issues.some((i: any) => i.code === "net_mismatch"), true);
check("a missing rate blocks: never a silent ₹0", byRst("644")[0].blocking, true);
check("net cross-check counted", `${v1.summary.netAgreeing}/${v1.summary.netChecked}`, "9/10");

console.log("\nCommit is refused while a page is unread");
// the reader stopped part-way: the sheet is left "failed" with fewer pages done
sqlite.prepare("update scan_batches set pages_done = 0, status = 'failed' where id = ?").run(scanId);
try {
  await call("POST", `/scans/${scanId}/commit`);
  console.log(" FAIL  a half-read sheet was committed"); bad++;
} catch (e) {
  const ok = (e as Error).message.includes("incomplete");
  if (!ok) bad++;
  console.log(` ${ok ? "PASS" : "FAIL"}  refused: incomplete`);
}
// a sheet read in full before pages were counted says 0 pages: it is not "unread"
sqlite.prepare("update scan_batches set pages_done = 0, status = 'review' where id = ?").run(scanId);
try {
  await call("POST", `/scans/${scanId}/commit`);
  console.log(" FAIL  a sheet with broken rows was committed"); bad++;
} catch (e) {
  const ok = !(e as Error).message.includes("incomplete");
  if (!ok) bad++;
  console.log(` ${ok ? "PASS" : "FAIL"}  an old fully-read sheet is not refused as unread`);
}
sqlite.prepare("update scan_batches set pages_done = json_array_length(file_paths) where id = ?").run(scanId);

console.log("\nCommit is refused while rows are broken");
try {
  await call("POST", `/scans/${scanId}/commit`);
  console.log(" FAIL  commit went through with blocking rows"); bad++;
} catch (e) {
  const m = (e as Error).message;
  const ok = m.includes("has_blocking");
  if (!ok) bad++;
  console.log(` ${ok ? "PASS" : "FAIL"}  refused: ${ok ? "has_blocking" : m.slice(0, 80)}`);
}
// a sheet that is not added leaves nothing behind: no supplier made from its unknown names
check("the refused sheet made no new supplier", (sqlite.prepare("select count(*) as n from adati where name_hi in (?, ?)").get("अज्ञात व्यापारी", "रामू लाल") as { n: number }).n, 0);
check("  ...and its rows still say who is new", (await call("GET", `/scans/${scanId}`)).rows.filter((r: any) => r.issues.some((i: any) => i.code === "name_unresolved")).length > 0, true);

console.log("\nOperator fixes the blocking rows");
const suppliers = await call("GET", "/adati");
const ramveer = suppliers.find((s: any) => s.nameHinglish.toUpperCase().startsWith("RAMVEER"));
const fixed = v1.rows.map((r: any) => {
  const base = {
    id: r.id, ocr: r.ocr, rstNo: r.rstNo, adatiId: r.adatiId, adatiRawText: r.adatiRawText,
    grossGrams: r.grossGrams, katautiOverride: r.katautiOverride,
    ratePaisePerQtl: r.ratePaisePerQtl, excluded: r.excluded, nameCorrected: r.nameCorrected,
    modelPick: r.modelPick ?? null,
    // the operator checked RST 638 against the paper: the gross is right as read;
    // RST 644 has no rate on the paper yet: it is priced later on the daily list
    confirmed: r.rstNo === "638" ? ["gross"] : r.rstNo === "644" ? ["rate"] : [],
  };
  // not one of ours: the operator leaves it out
  if (r.rstNo === "650") return { ...base, excluded: true };
  // pick a real supplier for the unreadable name
  if (r.rstNo === "637") return { ...base, adatiId: ramveer.id, nameCorrected: true };
  // the second RST 640 was really 645
  if (r.rstNo === "640" && r.adatiRawText.startsWith("अमित")) return { ...base, rstNo: "645" };
  return base;
});
const v2 = await call("PUT", `/scans/${scanId}/rows`, { rows: fixed });
check("nothing blocking now", v2.summary.blocking, 0);
check("rows that will be written", v2.summary.included, 9);

console.log("\nCommit");
const res = await call("POST", `/scans/${scanId}/commit`);
check("slips created", res.created, 9);
check("new spellings learnt", res.learnedAliases > 0, true);

const day = await call("GET", `/slips?date=${DATE}`);
check("slips on the daily list", day.totals.rows, 9);
check("struck-through row did not land", day.rows.some((r: any) => r.rstNo === "634"), false);
check("corrected RST landed as 645", day.rows.some((r: any) => r.rstNo === "645"), true);
check("unpriced row excluded from average", day.totals.ratePendingRows, 1);

console.log("\nThe correction is remembered for next time");
const again = await call("POST", "/adati/resolve", { text: "अज्ञात व्यापारी" });
check("previously unknown name now resolves", again.match?.via, "alias");
check("  ...to the supplier the operator chose", again.match?.nameHinglish, ramveer.nameHinglish);

console.log("\nRe-committing is refused");
try {
  await call("POST", `/scans/${scanId}/commit`);
  console.log(" FAIL  committed twice"); bad++;
} catch (e) {
  const ok = (e as Error).message.includes("already_committed");
  if (!ok) bad++;
  console.log(` ${ok ? "PASS" : "FAIL"}  refused: already_committed`);
}

/* Every sheet stays findable by its day and mill, and a slip in the supplier
   ledger opens the paper it came from: its own sheet, or — typed by hand —
   the mill's sheet of that day. */
console.log("\nScanned sheets, and a slip's paper");
{
  const listed = await call("GET", `/scans/sheets?from=${DATE}&to=${DATE}&merchantId=${grm.id}`);
  const mine = listed.rows.find((s: any) => s.id === scanId);
  check("the added sheet is listed under its day and mill", mine ? [mine.slipDate, mine.millCode, mine.jinsCode, mine.status] : null, [DATE, "GRM", "1509", "committed"]);
  check("  ...with its pages and the slips it added", mine ? [mine.pages.length, mine.slipsAdded] : null, [1, 9]);
  const own = await call("GET", `/scans/sheets?from=${DATE}&to=${DATE}&merchantId=own`);
  check("  ...and not among the firm's own sheets", own.rows.some((s: any) => s.id === scanId), false);
  const pic = await fetch(`${BASE}/scans/${scanId}/page/0?f=${encodeURIComponent(mine?.pages[0]?.name ?? "")}`, { headers: { cookie } });
  check("its picture opens", [pic.status, pic.headers.get("content-type")], [200, "image/png"]);
  const fromSheet = day.rows.find((r: any) => r.rstNo === "645");
  const paper = await call("GET", `/scans/for-slip/${fromSheet.id}`);
  check("a slip from the sheet opens that sheet", [paper.how, paper.sheets.map((s: any) => s.id)], ["slip", [scanId]]);
  const typed = await call("POST", "/slips", { slipDate: DATE, rstNo: "9901", adatiId: ramveer.id, jinsId: j1509.id, merchantId: grm.id, grossGrams: 1_000_000, ratePaisePerQtl: 0 });
  const paper2 = await call("GET", `/scans/for-slip/${typed.id}`);
  check("a slip typed by hand opens the mill's sheet of its day", [paper2.how, paper2.sheets.map((s: any) => s.id)], ["day", [scanId]]);
  // filed under GRM, but the paper's header names the firm itself: said on the row, found under both
  const metaWas = (sqlite.prepare("select page_meta as m from scan_batches where id = ?").get(scanId) as { m: string | null }).m;
  const firmCode = (sqlite.prepare("select b.short_code as c from businesses b join scan_batches s on s.business_id = b.id where s.id = ?").get(scanId) as { c: string }).c;
  sqlite.prepare("update scan_batches set page_meta = ? where id = ?").run(JSON.stringify([{ page: 1, date: DATE, millName: firmCode, jins: null, total: null }]), scanId);
  const misfiled = await call("GET", `/scans/sheets?from=${DATE}&to=${DATE}&merchantId=${grm.id}`);
  check("a sheet whose paper names another mill says which", misfiled.rows.find((s: any) => s.id === scanId)?.paperMillCode, firmCode);
  const ownNow = await call("GET", `/scans/sheets?from=${DATE}&to=${DATE}&merchantId=own`);
  check("  ...and is found under that mill as well", ownNow.rows.some((s: any) => s.id === scanId), true);
  check("  ...but a slip typed for GRM does not open it", (await call("GET", `/scans/for-slip/${typed.id}`)).sheets.length, 0);
  sqlite.prepare("update scan_batches set page_meta = ? where id = ?").run(metaWas, scanId);
  check("  ...and does again once the header names GRM", (await call("GET", `/scans/for-slip/${typed.id}`)).sheets.map((s: any) => s.id), [scanId]);
  const lone = await call("POST", "/slips", { slipDate: "2026-08-14", rstNo: "9902", adatiId: ramveer.id, jinsId: j1509.id, merchantId: grm.id, grossGrams: 1_000_000, ratePaisePerQtl: 0 });
  check("a day with no sheet has none to show", (await call("GET", `/scans/for-slip/${lone.id}`)).sheets.length, 0);
  sqlite.prepare("delete from purchase_slips where id in (?, ?)").run(typed.id, lone.id);
}

/* The same sheet uploaded again under another date: the rows already on the
   books (same RST, same weight, within 30 days) are flagged with the date they
   are on. A flag for the operator — it never blocks the sheet. */
console.log("\nThe same sheet scanned again under another date");
{
  const fd3 = new FormData();
  fd3.append("files", new File([PNG], "again.png", { type: "image/png" }));
  fd3.append("slipDate", "2026-09-23");
  fd3.append("merchantId", grm.id);
  fd3.append("jinsId", j1509.id);
  const { id: id3 } = await (await fetch(`${BASE}/scans`, { method: "POST", body: fd3, headers: { cookie } })).json() as { id: string };
  // two lines of the sheet just saved on 21-09, and one line not seen before
  const again = [rows[0], rows[1], { ...rows[2], rstNo: "699", ocr: { ...rows[2].ocr, rstNo: "699" }, grossGrams: 2_222_000 }]
    .map((r, i) => ({ ...r, id: `r${i}`, excluded: false }));
  sqlite.prepare("update scan_batches set parsed_rows = ?, status = 'review', model = 'simulated', pages_done = json_array_length(file_paths) where id = ?")
    .run(JSON.stringify(again), id3);
  const s = await call("GET", `/scans/${id3}`);
  const flagged = s.rows.filter((r: any) => r.issues.some((i: any) => i.code === "rst_other_day"));
  check("rows already saved on 21-09 are flagged", flagged.map((r: any) => r.rstNo), ["626", "629"]);
  check("  ...naming the date they are on", flagged[0]?.issues.find((i: any) => i.code === "rst_other_day")?.params.dates, "21-09-2026");
  check("  ...as a warning that never blocks", flagged.every((r: any) => r.issues.find((i: any) => i.code === "rst_other_day").level === "warn"), true);
  check("a line not seen before carries no such flag", s.rows.find((r: any) => r.rstNo === "699")?.issues.some((i: any) => i.code === "rst_other_day"), false);
  await call("DELETE", `/scans/${id3}`);
}

/* Clean up. A committed scan cannot be deleted through the API by design, and
   leaving a 1x1 test image behind means the owner clicks a row in the daily
   list and gets a green square. */
{
  const dir = path.resolve(process.env.MANDI_DATA_DIR!, "scans", scanId);
  sqlite.prepare("delete from purchase_slips where scan_batch_id = ?").run(scanId);
  sqlite.prepare("delete from purchase_slips where slip_date = ?").run(DATE);
  sqlite.prepare("delete from scan_batches where id = ?").run(scanId);
  fs.rmSync(dir, { recursive: true, force: true });
  const del = sqlite.prepare("delete from adati_aliases where raw_text = ? and source in ('ocr','correction')");
  for (const n of RAW_NAMES) del.run(n);
  console.log("\ncleaned up: test scan, its image and its slips removed");
}

/* Page-level checks and misplaced decimal points, on a second sheet taken
   from the real G.R.M page of 20-09-2026: row 13 has its net written "4,000"
   for 40.00, and a reader may drop the point in 19.20. */
console.log("\nWhole-page checks and decimal points");
{
  const fd2 = new FormData();
  fd2.append("files", new File([PNG], "sheet2.png", { type: "image/png" }));
  fd2.append("slipDate", DATE);
  fd2.append("merchantId", grm.id);
  fd2.append("jinsId", j1509.id);
  const up2 = await fetch(`${BASE}/scans`, { method: "POST", body: fd2, headers: { cookie } });
  const { id: id2 } = await up2.json() as { id: string };
  const two = [
    { rstNo: "644", adatiName: "सहदेव सिंह ट्रेडिंग", grossQtl: 40.40, katauti: 40, netQtl: 4000, rate: 3300, confidence: 0.9 },
    { rstNo: "626", adatiName: "फूलसिंह वर्मा", grossQtl: 1920, katauti: 19, netQtl: 19.01, rate: 3500, confidence: 0.9 },
    { rstNo: "640", adatiName: "अरविन्द ट्रेडिंग", grossQtl: 14.85, katauti: 15, netQtl: 14.70, rate: 3470, confidence: 0.9 },
  ].map((r, i) => ({
    id: `r${i}`, page: 1,
    ocr: { rstNo: r.rstNo, adatiName: r.adatiName, grossQtl: r.grossQtl, katauti: r.katauti, netQtl: r.netQtl, rate: r.rate, confidence: r.confidence, struckThrough: false, srNo: i + 1 },
    rstNo: r.rstNo, adatiId: null, adatiRawText: r.adatiName, grossGrams: Math.round(r.grossQtl * 100_000),
    katautiOverride: null, ratePaisePerQtl: r.rate * 100, excluded: false, nameCorrected: false, modelPick: null, confirmed: [],
  }));
  // the header says 20/9/26 (the scan is dated 21-09) and the bottom total says 75.00
  sqlite.prepare("update scan_batches set parsed_rows = ?, page_meta = ?, status = 'review', model = 'simulated', pages_done = 1 where id = ?")
    .run(JSON.stringify(two), JSON.stringify([{ page: 1, date: "20/9/26", millName: "G.R.M", jins: "1509", total: 75 }]), id2);
  const s2 = await call("GET", `/scans/${id2}`);
  const r644 = s2.rows.find((r: any) => r.rstNo === "644");
  const r626 = s2.rows.find((r: any) => r.rstNo === "626");
  check("a net written as 4,000 for 40.00 still confirms the gross", r644.netAgrees, true);
  check("  ...so that row is not blocked", r644.blocking, false);
  check("a gross read as 1920 is offered as 19.20", r626.grossSuggestGrams, 1_920_000);
  check("  ...and blocks until it is fixed or accepted", r626.blocking, true);
  check("the header date 20/9/26 is noticed against the scan's 21-09", s2.pageChecks.some((p: any) => p.code === "page_date" && p.params.written === "2026-09-20"), true);
  check("a bottom total that the rows do not make is noticed", s2.pageChecks.some((p: any) => p.code === "page_total" && p.params.written === "75.00"), true);
  check("the usual rate range is worked out and sensible", s2.rateRange.floorPaise < 330_000 && s2.rateRange.ceilPaise > 350_000, true);

  // apply the suggestion: the page total now agrees too (40.00 + 19.01 + 14.70 = 73.71 net; written 73.71)
  const fixed = s2.rows.map((r: any) => ({ ...r, ...(r.rstNo === "626" ? { grossGrams: r.grossSuggestGrams, confirmed: ["gross"] } : {}) }));
  await call("PUT", `/scans/${id2}/rows`, { rows: fixed });
  sqlite.prepare("update scan_batches set page_meta = ? where id = ?")
    .run(JSON.stringify([{ page: 1, date: "21-09-2026", millName: "G.R.M", jins: "1509", total: 73.71 }]), id2);
  const s3 = await call("GET", `/scans/${id2}`);
  check("after the fix, RST 626 is clear", s3.rows.find((r: any) => r.rstNo === "626").blocking, false);
  check("with the right date and total, the page raises nothing", s3.pageChecks.length, 0);

  /* The G.R.M sheet's line 6 is crossed out. A reader that drops it and slides
     line 6's name onto line 7's figures shows up as a jump in the printed row
     numbers (5 → 7), or as a name left over with no weight: the whole page is
     held back until it is checked line by line against the paper. What the
     model read is set here in the database: the screen cannot change it. */
  const setOcr = (patch: (r: any, i: number) => Record<string, unknown>) => {
    const cur = JSON.parse((sqlite.prepare("select parsed_rows as p from scan_batches where id = ?").get(id2) as { p: string }).p);
    sqlite.prepare("update scan_batches set parsed_rows = ?, page_meta = ? where id = ?")
      .run(JSON.stringify(cur.map((r: any, i: number) => ({ ...r, ocr: { ...r.ocr, ...patch(r, i) } }))),
        JSON.stringify([{ page: 1, date: "21-09-2026", millName: "G.R.M", jins: "1509", total: 73.71 }]), id2);
  };
  const tamper = s3.rows.map((r: any) => ({ ...r, ocr: { ...r.ocr, grossQtl: 99 } }));
  await call("PUT", `/scans/${id2}/rows`, { rows: tamper });
  const kept = JSON.parse((sqlite.prepare("select parsed_rows as p from scan_batches where id = ?").get(id2) as { p: string }).p);
  check("the model's own reading cannot be rewritten from the screen", kept.every((r: any) => r.ocr.grossQtl !== 99), true);

  setOcr((_r, i) => ({ srNo: [5, 7, 8][i] }));
  const s4 = await call("GET", `/scans/${id2}`);
  const jumped = s4.rows.find((r: any) => r.ocr.srNo === 7);
  check("a jump in the printed row numbers (5 → 7) is caught on the row", jumped.issues.some((i: any) => i.code === "sr_gap"), true);
  check("  ...the page is flagged to be checked line by line", s4.pageChecks.some((p: any) => p.code === "page_rows" && !p.confirmed), true);
  check("  ...and every row on it waits", s4.rows.every((r: any) => r.blocking && r.issues.some((i: any) => i.code === "page_slid")), true);
  check("  ...picking a name does not clear it", (await call("PUT", `/scans/${id2}/rows`, { rows: s4.rows.map((r: any) => ({ ...r, confirmed: [...(r.confirmed ?? []), "name"] })) }))
    .rows.every((r: any) => r.issues.some((i: any) => i.code === "page_slid")), true);
  const ok4 = await call("PUT", `/scans/${id2}/page-confirm`, { page: 1, what: "rows", on: true });
  check("checked page 1 line by line: the rows are free", ok4.rows.every((r: any) => !r.issues.some((i: any) => i.code === "page_slid")), true);
  check("  ...and the page note shows as checked", ok4.pageChecks.find((p: any) => p.code === "page_rows").confirmed, true);
  await call("PUT", `/scans/${id2}/page-confirm`, { page: 1, what: "rows", on: false });

  setOcr((_r, i) => ({ srNo: [1, 2, 3][i], ...(i === 2 ? { grossQtl: null, netQtl: null } : {}) }));
  const s5 = await call("GET", `/scans/${id2}`);
  check("a name left with no weight flags the page (rows may have slid)", s5.pageChecks.some((p: any) => p.code === "page_rows" && p.params.why === "name_only"), true);
  setOcr((_r, i) => ({ srNo: [1, null, 3][i], ...(i === 2 ? { grossQtl: 14.85, netQtl: 14.70 } : {}) }));
  const unnumbered = await call("GET", `/scans/${id2}`);
  check("a row the reader gave no number does not make a gap (1, —, 3)", !unnumbered.rows.some((r: any) => r.issues.some((i: any) => i.code === "sr_gap")), true);
  setOcr(() => ({ srNo: null }));
  const quiet = await call("GET", `/scans/${id2}`);
  check("a page read without row numbers (an older read) raises nothing about them", quiet.pageChecks.length === 0 && quiet.rows.every((r: any) => !r.issues.some((i: any) => i.code.startsWith("sr_") || i.code === "page_slid")), true);

  console.log("\nA name typed over a reading");
  const nameRows = (await call("GET", `/scans/${id2}`)).rows;
  const typedName = nameRows.map((r: any, i: number) => (i === 0 ? { ...r, typedName: "टाइप किया आढ़ती", nameCorrected: true } : r));
  const afterName = await call("PUT", `/scans/${id2}/rows`, { rows: typedName });
  check("the row comes back pointing at a supplier", Boolean(afterName.rows[0].adatiId), true);
  check("  ...which was made from the typed name", afterName.suppliersCreated?.[0]?.nameHi, "टाइप किया आढ़ती");
  check("  ...and the name no longer blocks the row", afterName.rows[0].issues.some((i: any) => i.code === "name_unresolved"), false);
  const madeId = afterName.rows[0].adatiId;
  const again = await call("PUT", `/scans/${id2}/rows`, { rows: afterName.rows.map((r: any, i: number) => (i === 1 ? { ...r, typedName: "टाइप किया आढ़ती", nameCorrected: true } : r)) });
  check("the same name on another row is the same supplier", again.rows[1].adatiId === madeId && (again.suppliersCreated ?? []).length === 0, true);

  // typing a value is not accepting it: an unusual rate typed in still needs its ✓
  const typedRate = quiet.rows.map((r: any, i: number) => (i === 0 ? { ...r, ratePaisePerQtl: 9_000_000, confirmed: (r.confirmed ?? []).filter((c: string) => c !== "rate") } : r));
  const afterType = await call("PUT", `/scans/${id2}/rows`, { rows: typedRate });
  check("a rate typed far out of range still blocks until ✓", afterType.rows[0].blocking && afterType.rows[0].issues.some((i: any) => i.code === "rate_range" && i.level === "error"), true);
  await call("DELETE", `/scans/${id2}`);
}

/* A two-page sheet read through the stand-in for Google: page 1 whole, with
   a rate written "3450/-" and a gross with a letter in it; page 2 carries on
   at line 4, and Google's answer stops in the middle of line 6. */
console.log("\nA two-page sheet, read page by page");
{
  const LB = mills.find((m: any) => m.code === "LB");
  await call("PUT", "/settings/gemini", {
    apiKey: "AIzaFAKE-KEY-ONLY-FOR-THE-LOCAL-STAND-IN",
    model: "gemini-test-pages", fallbackModel: "gemini-test-pages", backupModels: [],
  });
  const fd3 = new FormData();
  fd3.append("files", new File([PNG], "page-1.png", { type: "image/png" }));
  fd3.append("files", new File([JPG], "page-2.jpg", { type: "image/jpeg" }));
  fd3.append("slipDate", DATE);
  fd3.append("merchantId", LB.id); // filed under L.B; the header will say G.R.M
  fd3.append("jinsId", j1509.id);
  const { id: id3 } = await (await fetch(`${BASE}/scans`, { method: "POST", body: fd3, headers: { cookie } })).json() as { id: string };
  await call("POST", `/scans/${id3}/run`, {});
  let s: any = null;
  for (let i = 0; i < 120; i++) {
    s = await call("GET", `/scans/${id3}`);
    if (s.status !== "reading" && !s.running) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  check("both pages read", [s.status, s.pagesDone], ["review", 2]);
  check("rows in page order, page 2 after page 1", s.rows.map((r: any) => `${r.page}:${r.ocr.srNo}`), ["1:1", "1:2", "1:3", "2:4", "2:5"]);
  check("  ...each row numbered on its own", s.rows.map((r: any) => r.id), ["r0", "r1", "r2", "r3", "r4"]);
  check("where each line sits on its page comes through", s.rows.map((r: any) => r.ocr.lineY), [210, 240, 270, 120, 150]);
  check("a rate written 3450/- is read as 3450", s.rows[1].ratePaisePerQtl, 345_000);
  const odd = s.rows[2];
  check("a gross with a letter in it keeps the rest of its line", [odd.rstNo, odd.ratePaisePerQtl, odd.ocr.netQtl], ["933", 350_000, 4.95]);
  check("  ...the box is empty and red, showing what was written", [odd.grossGrams, odd.ocr.unreadable?.grossQtl, odd.blocking], [null, "5.0O", true]);
  check("the header the reader saw is returned", s.header.map((h: any) => `${h.page}:${h.millName ?? "-"}:${h.truncated}`), ["1:G.R.M:false", "2:-:true"]);
  const codes = s.pageChecks.map((p: any) => `${p.page}:${p.code}`).sort();
  check("page 2's answer was cut short: it is a page question", codes.includes("2:page_cut"), true);
  check("page 1 has no total: its lines are counted once", codes.includes("1:page_count"), true);
  check("page 2 carries on at line 4: no lines missing at its top", s.rows.some((r: any) => r.issues.some((i: any) => i.code === "sr_top")), false);
  const mill = s.pageChecks.find((p: any) => p.code === "page_mill");
  check("the header's mill (G.R.M) differs from the one filed (LB): asked", [mill?.params.label, mill?.params.filed], ["GRM", "LB"]);

  console.log("\nTwo screens on one sheet");
  const a = await call("PUT", `/scans/${id3}/rows`, { rows: s.rows, rev: s.rev, merchantId: grm.id });
  check("taking the header's mill clears that question", a.pageChecks.some((p: any) => p.code === "page_mill"), false);
  const stale = await fetch(`${BASE}/scans/${id3}/rows`, { method: "PUT", headers: { "Content-Type": "application/json", cookie }, body: JSON.stringify({ rows: s.rows, rev: s.rev }) });
  check("a save built on the older version is refused, not applied", [stale.status, ((await stale.json()) as { code?: string }).code], [409, "stale_rows"]);
  const trail = sqlite.prepare("select entity_label as l from audit_log where entity_id = ? and action = 'scan.header'").all(id3) as { l: string }[];
  check("moving the sheet to another mill is in the audit trail", trail.map((x) => x.l), ["mill LB → GRM"]);

  console.log("\nA tick lasts while what it was given for does");
  let pc = await call("PUT", `/scans/${id3}/page-confirm`, { page: 1, what: "count", on: true });
  check("page 1's line count ticked", pc.pageChecks.find((p: any) => p.code === "page_count")?.confirmed, true);
  const fixed = a.rows.map((r: any) => r.id === "r2" ? { ...r, grossGrams: 500_000 } : r);
  const b2 = await call("PUT", `/scans/${id3}/rows`, { rows: fixed, rev: a.rev });
  check("typing the gross clears the red box", b2.rows.find((r: any) => r.id === "r2").blocking, false);
  await call("PUT", `/scans/${id3}/rows`, { rows: b2.rows, rev: b2.rev, slipDate: "2026-09-22" });
  pc = await call("PUT", `/scans/${id3}/page-confirm`, { page: 1, what: "date", on: true });
  check("the header's date (21-09) against the scan's (22-09): ticked", pc.pageChecks.find((p: any) => p.code === "page_date")?.confirmed, true);
  const back = await call("GET", `/scans/${id3}`);
  await call("PUT", `/scans/${id3}/rows`, { rows: back.rows, rev: back.rev, slipDate: "2026-09-23" });
  const moved = await call("GET", `/scans/${id3}`);
  check("the scan moved to 23-09: the date is asked again", moved.pageChecks.find((p: any) => p.code === "page_date")?.confirmed, false);
  await call("PUT", `/scans/${id3}/rows`, { rows: moved.rows, rev: moved.rev, slipDate: DATE });

  console.log("\nA blank RST and a missing rate are never quietly saved");
  const cur = await call("GET", `/scans/${id3}`);
  const blank = await call("PUT", `/scans/${id3}/rows`, { rows: cur.rows.map((r: any) => r.id === "r4" ? { ...r, rstNo: "", ratePaisePerQtl: null } : r), rev: cur.rev });
  const r4 = blank.rows.find((r: any) => r.id === "r4");
  check("a blank RST is red", r4.issues.find((i: any) => i.code === "rst_missing")?.level, "error");
  check("a missing rate on a page with rates is red", r4.issues.find((i: any) => i.code === "rate_missing")?.level, "error");
  const ok = await call("PUT", `/scans/${id3}/rows`, { rows: blank.rows.map((r: any) => r.id === "r4" ? { ...r, confirmed: ["rst", "rate"] } : r), rev: blank.rev });
  check("  ...✓ 'none on the paper' and 'rate later' clear them", ok.rows.find((r: any) => r.id === "r4").blocking, false);

  /* The answer for page 2 was cut short: that one page is read again, and
     page 1 — with the gross typed on it — is left as it is. */
  console.log("\nReading one page again");
  const before = await call("GET", `/scans/${id3}`);
  await call("POST", `/scans/${id3}/run`, { page: 2, model: "gemini-test-pages-whole" });
  let again: any = null;
  for (let i = 0; i < 120; i++) {
    again = await call("GET", `/scans/${id3}`);
    if (again.status !== "reading" && !again.running) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  check("page 2 read again: its lines now run 4 to 6", again.rows.filter((r: any) => r.page === 2).map((r: any) => r.ocr.srNo), [4, 5, 6]);
  check("  ...page 1's lines and the change on them are kept", again.rows.filter((r: any) => r.page === 1).map((r: any) => `${r.id}:${r.grossGrams}`),
    before.rows.filter((r: any) => r.page === 1).map((r: any) => `${r.id}:${r.grossGrams}`));
  check("  ...no line number is used twice", new Set(again.rows.map((r: any) => r.id)).size, again.rows.length);
  check("  ...the question about the cut answer is gone", again.pageChecks.some((p: any) => p.code === "page_cut"), false);
  check("  ...the total at its foot proves its lines", again.pageChecks.some((p: any) => p.page === 2 && ["page_count", "page_total"].includes(p.code)), false);
  check("  ...and a screen holding the sheet from before must load it again", again.rev !== before.rev, true);
  // read again once more, and this time the answer is cut short with fewer lines: the page keeps what it had
  await call("POST", `/scans/${id3}/run`, { page: 2, model: "gemini-test-pages" });
  let shorter: any = null;
  for (let i = 0; i < 120; i++) {
    shorter = await call("GET", `/scans/${id3}`);
    if (shorter.status !== "reading" && !shorter.running) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  check("a page read again and cut shorter keeps its lines", [shorter.rows.filter((r: any) => r.page === 2).length, shorter.rev === again.rev], [3, true]);
  const z = again.rows.find((r: any) => r.ocr.srNo === 6);
  check("a rate written so it reads 35Z1 is red, showing what was written", [z.ratePaisePerQtl, z.ocr.unreadable?.rate, z.blocking], [null, "35Z1", true]);
  const putOff = await call("PUT", `/scans/${id3}/rows`, { rows: again.rows.map((r: any) => r.id === z.id ? { ...r, confirmed: ["rate"] } : r), rev: again.rev });
  check("  ...a ✓ cannot put it off to later: it is on the paper, so it is typed", putOff.rows.find((r: any) => r.id === z.id).blocking, true);
  const typedRate = await call("PUT", `/scans/${id3}/rows`, { rows: putOff.rows.map((r: any) => r.id === z.id ? { ...r, ratePaisePerQtl: 352_100 } : r), rev: putOff.rev });
  check("  ...typed as 3521, the line is clear", typedRate.rows.find((r: any) => r.id === z.id).blocking, false);

  console.log("\nAdding the sheet");
  const ready = await call("GET", `/scans/${id3}`);
  check("nothing left to answer", [ready.summary.blocking, ready.summary.pagesBlocking], [0, 0]);
  // the "are you sure" box was built from an older version: what it showed is not what would be written
  const staleAdd = await fetch(`${BASE}/scans/${id3}/commit`, { method: "POST", headers: { "Content-Type": "application/json", cookie }, body: JSON.stringify({ rev: "0000000000000000" }) });
  check("adding from an older copy of the sheet is refused", [staleAdd.status, ((await staleAdd.json()) as { code?: string }).code], [409, "stale_rows"]);
  // the same sheet added from two screens at the same moment: its slips are written once
  const addOnce = () => fetch(`${BASE}/scans/${id3}/commit`, { method: "POST", headers: { "Content-Type": "application/json", cookie }, body: JSON.stringify({ rev: ready.rev }) });
  const both = await Promise.all([addOnce(), addOnce()]);
  const answers = await Promise.all(both.map(async (r) => ({ status: r.status, json: await r.json() as { created?: number; code?: string } })));
  check("two Adds at once: one adds, the other is refused", answers.map((a) => a.status).sort(), [200, 409]);
  const res3 = answers.find((a) => a.status === 200)!.json as { created: number; approvedParchas?: unknown[] };
  check("six slips added", res3.created, 6);
  check("  ...and written only once", (sqlite.prepare("select count(*) as n from purchase_slips where scan_batch_id = ?").get(id3) as { n: number }).n, 6);
  check("the answer says which approved parchas no longer match (none)", res3.approvedParchas, []);
  const slips3 = sqlite.prepare("select id, gross_grams as g, rst_no as rst from purchase_slips where scan_batch_id = ?").all(id3) as { id: string; g: number; rst: string }[];
  check("every slip is in whole kilograms", slips3.every((x) => x.g % 1000 === 0), true);
  const audited = sqlite.prepare(`select count(*) as n from audit_log where action = 'slip.create' and entity_id in (${slips3.map(() => "?").join(",")})`).get(...slips3.map((x) => x.id)) as { n: number };
  check("each slip has its own entry in the audit trail", audited.n, 6);
  const late = await fetch(`${BASE}/scans/${id3}/rows`, { method: "PUT", headers: { "Content-Type": "application/json", cookie }, body: JSON.stringify({ rows: ready.rows }) });
  check("a save that arrives after the sheet is added is refused", late.status, 409);
  const added = await call("GET", `/scans/${id3}`);
  check("the added sheet is not flagged against its own slips", added.rows.filter((r: any) => r.issues.some((i: any) => i.code === "rst_exists")).length, 0);

  sqlite.prepare("delete from purchase_slips where scan_batch_id = ?").run(id3);
  sqlite.prepare("delete from scan_batches where id = ?").run(id3);
  fs.rmSync(path.resolve(process.env.MANDI_DATA_DIR!, "scans", id3), { recursive: true, force: true });
}

/* The same two pages uploaded the wrong way round: the sheet's later lines
   are read as page 1. Their line numbers say so; one tap puts the pages in
   order, each with its own lines and picture, and nothing is read again. */
console.log("\nPages in the wrong order, put right after reading");
{
  const fd4 = new FormData();
  fd4.append("files", new File([JPG], "later-lines.jpg", { type: "image/jpeg" }));
  fd4.append("files", new File([PNG], "first-lines.png", { type: "image/png" }));
  fd4.append("slipDate", DATE);
  fd4.append("merchantId", grm.id);
  fd4.append("jinsId", j1509.id);
  const { id: id4 } = await (await fetch(`${BASE}/scans`, { method: "POST", body: fd4, headers: { cookie } })).json() as { id: string };
  await call("POST", `/scans/${id4}/run`, { model: "gemini-test-pages-whole" });
  let s4: any = null;
  for (let i = 0; i < 120; i++) {
    s4 = await call("GET", `/scans/${id4}`);
    if (s4.status !== "reading" && !s4.running) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  check("read in the order given: lines 4–6 on page 1", s4.rows.map((r: any) => `${r.page}:${r.ocr.srNo}`), ["1:4", "1:5", "1:6", "2:1", "2:2", "2:3"]);
  const po = s4.pageChecks.find((p: any) => p.code === "page_order");
  check("the line numbers say page 2 comes first: asked", po?.params.order, "2, 1");
  check("  ...not taken for lines missing at the top of page 1", s4.pageChecks.some((p: any) => p.code === "page_rows"), false);
  check("  ...and the sheet waits for the answer", s4.summary.pagesBlocking > 0, true);
  const stale4 = await fetch(`${BASE}/scans/${id4}/order`, { method: "PUT", headers: { "Content-Type": "application/json", cookie }, body: JSON.stringify({ order: [1, 0], rev: "0000000000000000" }) });
  check("  ...an order sent from an older copy of the sheet is refused", [stale4.status, ((await stale4.json()) as { code?: string }).code], [409, "stale_rows"]);
  const o = await call("PUT", `/scans/${id4}/order`, { order: [1, 0], rev: s4.rev });
  check("put in order: page 1 runs 1–3, page 2 runs 4–6", o.rows.map((r: any) => `${r.page}:${r.ocr.srNo}`), ["1:1", "1:2", "1:3", "2:4", "2:5", "2:6"]);
  check("  ...the question is gone", o.pageChecks.some((p: any) => p.code === "page_order"), false);
  const s5 = await call("GET", `/scans/${id4}`);
  check("  ...each page's header went with it", s5.header.map((h: any) => `${h.page}:${h.millName ?? "-"}:${h.total ?? "-"}`), ["1:G.R.M:-", "2:-:73.75"]);
  const pic = await fetch(`${BASE}/scans/${id4}/page/0?f=${encodeURIComponent(s5.pages[0].name)}`, { headers: { cookie } });
  check("  ...and page 1's picture is the one its lines were read from", pic.headers.get("content-type"), "image/png");
  const trail4 = sqlite.prepare("select entity_label as l from audit_log where entity_id = ? and action = 'scan.reorder'").all(id4) as { l: string }[];
  check("  ...which is in the audit trail", trail4.map((x) => x.l), ["pages put in order after reading: 2, 1"]);
  await call("DELETE", `/scans/${id4}`);
}

console.log("\nWhat is refused at upload, and what is never lost from the list");
{
  const heic = new FormData();
  heic.append("files", new File([Buffer.from("not really a heic")], "IMG_0001.HEIC", { type: "image/heic" }));
  const h = await fetch(`${BASE}/scans`, { method: "POST", body: heic, headers: { cookie } });
  check("an iPhone HEIC photo is refused, saying how to send it", [h.status, ((await h.json()) as { code?: string }).code], [400, "heic"]);
  // two pages packed into a compressed object stream, as PDF 1.5 writers do
  const zlib = await import("node:zlib");
  const packed = zlib.deflateSync(Buffer.from("1 0 2 30 << /Type /Page >> << /Type /Page >> << /Type /Pages /Count 2 >>"));
  const pdf = Buffer.concat([Buffer.from("%PDF-1.5\n5 0 obj << /Type /ObjStm /N 3 /First 10 /Filter /FlateDecode >>\nstream\n", "latin1"), packed, Buffer.from("\nendstream\nendobj\n", "latin1")]);
  const pf = new FormData();
  pf.append("files", new File([pdf], "two.pdf", { type: "application/pdf" }));
  const p = await fetch(`${BASE}/scans`, { method: "POST", body: pf, headers: { cookie } });
  check("a two-page PDF with packed pages is refused", [p.status, ((await p.json()) as { code?: string }).code], [400, "multi_page_pdf"]);

  const nd = new FormData();
  nd.append("files", new File([PNG], "undated.png", { type: "image/png" }));
  const { id: undated } = await (await fetch(`${BASE}/scans`, { method: "POST", body: nd, headers: { cookie } })).json() as { id: string };
  const listed = await call("GET", "/scans?from=2026-04-01&to=2027-03-31&limit=1");
  check("a sheet with no date still shows in the year's list", listed.some((r: any) => r.id === undated), true);
  await call("DELETE", `/scans/${undated}`);

  /* The same paper uploaded twice: said beside the sheet, never refused. A
     picture of exactly the same size but other content is not the same paper. */
  const tag = `same-paper-${Date.now()}`;
  const paper = Buffer.concat([PNG, Buffer.from(tag)]);
  const lookalike = Buffer.concat([PNG, Buffer.from(tag.replace(/\d/g, "x"))]);
  const upOne = async (bytes: Buffer, name: string) => {
    const f = new FormData();
    f.append("files", new File([bytes], name, { type: "image/png" }));
    f.append("slipDate", "2026-09-25");
    return await (await fetch(`${BASE}/scans`, { method: "POST", body: f, headers: { cookie } })).json() as { id: string; samePictures?: number };
  };
  const first = await upOne(paper, "first.png");
  const second = await upOne(paper, "again.png");
  const other = await upOne(lookalike, "other.png");
  check("the same picture uploaded again: the upload says so", [first.samePictures, second.samePictures], [0, 1]);
  const s2 = await call("GET", `/scans/${second.id}`);
  check("  ...the sheet names the one it repeats, page by page", s2.samePictures.map((x: any) => `${x.page}:${x.scanId === first.id}:${x.otherPage}`), ["1:true:1"]);
  check("  ...and it is only a warning: the sheet waits to be read as usual", s2.status, "uploaded");
  check("  ...the first sheet is told about the second too", (await call("GET", `/scans/${first.id}`)).samePictures.some((x: any) => x.scanId === second.id), true);
  check("a picture of the same size but other content is not taken for it", (await call("GET", `/scans/${other.id}`)).samePictures.length, 0);
  for (const x of [first, second, other]) await call("DELETE", `/scans/${x.id}`);
}

/* A rate inside the season's usual range but unlike the day's: a 1 read as a
   7 (3150 as 3750). Amber, in words, one ✓ — never a stop. */
console.log("\nA rate unlike the day's other rates");
{
  const fd5 = new FormData();
  fd5.append("files", new File([PNG], "rates.png", { type: "image/png" }));
  fd5.append("slipDate", "2026-09-26");
  fd5.append("merchantId", grm.id);
  fd5.append("jinsId", j1509.id);
  const { id: id5 } = await (await fetch(`${BASE}/scans`, { method: "POST", body: fd5, headers: { cookie } })).json() as { id: string };
  const rates = [3400, 3500, 3500, 3500, 3450, 3750];
  const lines = rates.map((rate, i) => ({
    id: `r${i}`, page: 1,
    ocr: { rstNo: String(951 + i), adatiName: "फूलसिंह वर्मा", grossQtl: 20, katauti: 20, netQtl: 19.8, rate, confidence: 0.95, struckThrough: false, srNo: i + 1 },
    rstNo: String(951 + i), adatiId: null, adatiRawText: "फूलसिंह वर्मा", grossGrams: 2_000_000,
    katautiOverride: null, ratePaisePerQtl: rate * 100, excluded: false, nameCorrected: false, modelPick: null, confirmed: [],
  }));
  sqlite.prepare("update scan_batches set parsed_rows = ?, page_meta = ?, status = 'review', model = 'simulated', pages_done = 1 where id = ?")
    .run(JSON.stringify(lines), JSON.stringify([{ page: 1, date: "26-09-2026", millName: null, jins: null, total: 118.8 }]), id5);
  const s5 = await call("GET", `/scans/${id5}`);
  const odd = s5.rows.find((r: any) => r.ratePaisePerQtl === 375_000);
  check("3750 among 3400–3500 is flagged, saying what the day's rate is", odd.issues.find((i: any) => i.code === "rate_day")?.params, { median: 3500, low: 0 });
  check("  ...as a look, not a stop", [odd.issues.find((i: any) => i.code === "rate_day")?.level, odd.blocking], ["warn", false]);
  check("  ...the day's ordinary rates are not", s5.rows.filter((r: any) => r.issues.some((i: any) => i.code === "rate_day")).length, 1);
  const seen = await call("PUT", `/scans/${id5}/rows`, { rows: s5.rows.map((r: any) => r.id === odd.id ? { ...r, confirmed: ["rate"] } : r), rev: s5.rev });
  check("  ...✓ 'right as read' clears it", seen.rows.find((r: any) => r.id === odd.id).issues.some((i: any) => i.code === "rate_day"), false);
  await call("DELETE", `/scans/${id5}`);
}

/* A line read as crossed out, put back in by the munshi, with a name not in
   the master: "All right as read" on that line ticks "it really belongs" too,
   so the line can be added. */
console.log("\nA crossed-out line put back in");
{
  const { lineState } = await import("../src/components/ScanGrid.tsx");
  const { STRINGS } = await import("../src/lib/strings.ts");
  const tr = ((k: string) => (STRINGS.en as Record<string, string>)[k] ?? k) as never;
  const fd6 = new FormData();
  fd6.append("files", new File([PNG], "struck.png", { type: "image/png" }));
  fd6.append("slipDate", "2026-09-27");
  fd6.append("jinsId", j1509.id);
  const { id: id6 } = await (await fetch(`${BASE}/scans`, { method: "POST", body: fd6, headers: { cookie } })).json() as { id: string };
  const back = { id: "r0", page: 1, ocr: { rstNo: "961", adatiName: "कल्लू पहलवान", grossQtl: 20, katauti: 20, netQtl: 19.8, rate: 3400, confidence: 0.95, struckThrough: true, srNo: 1 },
    rstNo: "961", adatiId: null, adatiRawText: "कल्लू पहलवान", grossGrams: 2_000_000, katautiOverride: null, ratePaisePerQtl: 340_000, excluded: false, nameCorrected: false, modelPick: null, confirmed: [] };
  sqlite.prepare("update scan_batches set parsed_rows = ?, page_meta = ?, status = 'review', model = 'simulated', pages_done = 1 where id = ?")
    .run(JSON.stringify([back]), JSON.stringify([{ page: 1, date: "27-09-2026", millName: null, jins: null, total: 19.8 }]), id6);
  const s6 = await call("GET", `/scans/${id6}`);
  const st = lineState(s6.rows[0], tr);
  const keys = [...new Set(st.flags.filter((x) => x.flag.confirmable).map((x) => x.flag.key ?? x.field))];
  check("the line asks first whether it really belongs", keys.includes("struck"), true);
  const ticked = await call("PUT", `/scans/${id6}/rows`, { rows: s6.rows.map((r: any) => ({ ...r, confirmed: keys })), rev: s6.rev });
  check("  ...'All right as read' lets it be added", ticked.rows[0].blocking, false);
  // filed under no mill: the tag next to the pictures names the firm, never a blank
  const meta = JSON.parse(fs.readFileSync(path.resolve(process.env.MANDI_DATA_DIR!, "scans", id6, "meta.json"), "utf8"));
  check("a sheet of the firm's own is tagged with the firm", [meta.slipDate, meta.mill?.ownFirm, Boolean(meta.mill?.code)], ["2026-09-27", true, true]);
  await call("DELETE", `/scans/${id6}`);
}

console.log(bad === 0 ? "\nOCR review pipeline works end to end." : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
