/* Exercises the OCR review pipeline end to end WITHOUT calling Gemini.
 *
 * A realistic model reading of the G.R.M sheet — including the mistakes a
 * reader actually makes — is injected as if Gemini had returned it, then run
 * through the real validation, correction and commit endpoints.
 *
 * Usage: npx tsx scripts/e2e-scan-review.ts [PIN]
 */
import { sqlite } from "../server/db/client.ts";

const BASE = "http://localhost:8787/api";
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
];

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
}));
sqlite.prepare("update scan_batches set parsed_rows = ?, status = 'review', model = 'simulated' where id = ?")
  .run(JSON.stringify(rows), scanId);

const v1 = await call("GET", `/scans/${scanId}`);
const byRst = (r: string) => v1.rows.filter((x: any) => x.rstNo === r);

console.log("Validation of the raw reading");
check("rows read", v1.summary.total, 10);
check("struck-through row auto-excluded", v1.summary.excluded, 1);
check("misspelling resolved without help", byRst("627")[0].match?.via, "normkey");
check("  ...to the right supplier", byRst("627")[0].match?.nameHinglish, "Phoolsingh Verma");
check("unknown name blocks", byRst("637")[0].blocking, true);
check("  ...with the right reason", byRst("637")[0].issues.some((i: any) => i.code === "name_unresolved"), true);
check("duplicate RST blocks both rows", byRst("640").filter((r: any) => r.blocking).length, 2);
check("sheet net disagreeing warns, not blocks", byRst("638")[0].blocking, false);
check("  ...and is flagged", byRst("638")[0].issues.some((i: any) => i.code === "net_mismatch"), true);
check("missing rate warns, not blocks", byRst("644")[0].blocking, false);
check("net cross-check counted", `${v1.summary.netAgreeing}/${v1.summary.netChecked}`, "8/9");

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
  };
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

console.log(bad === 0 ? "\nOCR review pipeline works end to end." : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
