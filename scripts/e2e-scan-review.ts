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
  // rate not read -> warn only, weight still usable
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
check("  ...to the right supplier", byRst("627")[0].match?.nameHinglish, "Phoolsingh Verma");
check("unknown name blocks", byRst("637")[0].blocking, true);
check("  ...with the right reason", byRst("637")[0].issues.some((i: any) => i.code === "name_unresolved"), true);
// a repeated kanta slip no. is highlighted on both rows but never blocks
check("repeated RST flagged on both rows", byRst("640").filter((r: any) => r.issues.some((i: any) => i.code === "rst_dupe")).length, 2);
check("repeated RST does not block", byRst("640").filter((r: any) => r.blocking).length, 0);
check("sheet net disagreeing blocks until the operator confirms it", byRst("638")[0].blocking, true);
check("a model pick unlike the handwriting is not taken as the match", byRst("650")[0].match, null);
check("  ...but offered first among the suggestions", byRst("650")[0].suggestions[0]?.nameHinglish, "Phoolsingh Verma");
check("  ...and is flagged", byRst("638")[0].issues.some((i: any) => i.code === "net_mismatch"), true);
check("missing rate warns, not blocks", byRst("644")[0].blocking, false);
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

console.log("\nOperator fixes the three blocking rows");
const suppliers = await call("GET", "/adati");
const ramveer = suppliers.find((s: any) => s.nameHinglish.startsWith("Ramveer"));
const fixed = v1.rows.map((r: any) => {
  const base = {
    id: r.id, ocr: r.ocr, rstNo: r.rstNo, adatiId: r.adatiId, adatiRawText: r.adatiRawText,
    grossGrams: r.grossGrams, katautiOverride: r.katautiOverride,
    ratePaisePerQtl: r.ratePaisePerQtl, excluded: r.excluded, nameCorrected: r.nameCorrected,
    modelPick: r.modelPick ?? null,
    // the operator checked RST 638 against the paper: the gross is right as read
    confirmed: r.rstNo === "638" ? ["gross"] : [],
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

  // typing a value is not accepting it: an unusual rate typed in still needs its ✓
  const typedRate = quiet.rows.map((r: any, i: number) => (i === 0 ? { ...r, ratePaisePerQtl: 9_000_000, confirmed: (r.confirmed ?? []).filter((c: string) => c !== "rate") } : r));
  const afterType = await call("PUT", `/scans/${id2}/rows`, { rows: typedRate });
  check("a rate typed far out of range still blocks until ✓", afterType.rows[0].blocking && afterType.rows[0].issues.some((i: any) => i.code === "rate_range" && i.level === "error"), true);
  await call("DELETE", `/scans/${id2}`);
}

console.log(bad === 0 ? "\nOCR review pipeline works end to end." : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
