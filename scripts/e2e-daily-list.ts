import "./_guard.ts";
/* End-to-end check against a RUNNING dev server: enters the real L.B daily
 * list of 20-09-2026 through the HTTP API and asserts the day totals match
 * the paper (331.05 qtl net, 3413.45 weighted average).
 *
 * Needs: npm run dev, and a signed-up owner. Usage:
 *   npx tsx scripts/e2e-daily-list.ts [PIN]
 */
const BASE = process.env.MANDI_API!;
let cookie = "";
const DATE = "2026-09-20";

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

const users = await call("GET", "/auth/users");
const owner = users.find((u: any) => u.name === "Test Owner");
const PIN = process.argv[2] ?? process.env.MANDI_PIN ?? "482915";
await call("POST", "/auth/login", { userId: owner.id, pin: PIN });
console.log("logged in as Test Owner");

/* Two businesses exist; this sheet belongs to Vijay Laxmi. Be explicit rather
   than trusting whichever business the session happened to resume. */
const me = await call("GET", "/auth/me");
const vldm = me.businesses.find((b: any) => b.shortCode === "VLDM");
if (vldm && me.activeBusinessId !== vldm.businessId) {
  await call("POST", "/auth/switch-business", { businessId: vldm.businessId });
  console.log("switched to", vldm.name);
}

/* This script inserts slips, so a rerun would legitimately hit the duplicate
   RST guard. Clear its own footprint first. */
{
  const existing = await call("GET", `/slips?date=${DATE}`);
  let removed = 0;
  for (const r of existing.rows) {
    try { await call("DELETE", `/slips/${r.id}`); removed++; } catch { /* on a load */ }
  }
  if (removed) console.log(`cleared ${removed} slip(s) left from a previous run`);
}

const mills = await call("GET", "/merchants");
const lb = mills.find((m: any) => m.code === "LB");
const jins = await call("GET", "/jins");
const j1509 = jins.find((j: any) => j.code === "1509");
const suppliers = await call("GET", "/adati");
const byHi = new Map(suppliers.map((s: any) => [s.nameHi, s]));

/* The L.B sheet dated 20-09-2026: RST, dharam kanta, KATAUTI as written, rate.
   Katauti is NOT sent — the server derives it and we assert it comes back equal. */
const SHEET: [string, string, number, number, number][] = [ // rst, name, gross, katauti, rate
  ["630", "सामरा इंटरप्राइजेज", 28.60, 29, 3450],
  ["634", "शिवम ट्रेडिंग",      41.25, 41, 3550],
  ["635", "शिवम ट्रेडिंग",      35.85, 36, 3400],
  ["633", "अमित ट्रेडिंग",      26.40, 26, 3521],
  ["636", "राधा चरन ट्रेडिंग",  18.75, 19, 3400],
  ["639", "राजू संजीव कुमार",   5.70,  6,  3611],
  ["643", "धर्मपाल सिंह",       18.20, 18, 3300],
  ["648", "रामपाल सिंह यादव",   9.60,  10, 3200],
  ["651", "सूर्य प्रकाश वर्मा", 24.95, 25, 3400],
  ["652", "राधा चरन ट्रेडिंग",  42.60, 43, 3450],
  ["653", "शिवम ट्रेडिंग",      14.40, 14, 3100],
  ["662", "राधा चरन ट्रेडिंग",  18.20, 18, 3450],
  ["666", "राधे श्याम एण्ड संस", 49.90, 50, 3350],
];

console.log(`\nEntering ${SHEET.length} rows for ${DATE} against mill ${lb.code}...`);
let entered = 0;
for (const [rst, nameHi, gross, bags, rate] of SHEET) {
  const ad: any = byHi.get(nameHi);
  if (!ad) { console.log(`  !! no supplier "${nameHi}"`); continue; }
  try {
    await call("POST", "/slips", {
      slipDate: DATE, rstNo: rst, adatiId: ad.id, jinsId: j1509.id, merchantId: lb.id,
      grossGrams: Math.round(gross * 100000), ratePaisePerQtl: Math.round(rate * 100),
    });
    entered++;
  } catch (e) {
    console.log(`  !! RST ${rst}: ${(e as Error).message.slice(0, 110)}`);
  }
}
console.log(`  ${entered} rows accepted`);

const day = await call("GET", `/slips?date=${DATE}&merchantId=${lb.id}`);
const T = day.totals;
const q = (g: number) => (g / 100000).toFixed(2);
const r = (p: number) => (p / 100).toFixed(2);

console.log("\nDay totals computed by the server:");
console.log("  rows              ", T.rows);
console.log("  katauti units     ", T.katautiUnits);
console.log("  gross (dharam)    ", q(T.grossGrams));
console.log("  katauti deduction ", q(T.katautiGrams));
console.log("  NET               ", q(T.netGrams), "   sheet says 331.05");
console.log("  weighted avg rate ", r(T.weightedAvgRatePaise), " parcha says 3413.45");
console.log("  amount            ", r(T.amountPaise));
console.log("  rows not adding up", T.mismatchRows);

const checks: [string, unknown, unknown][] = [
  ["row count", T.rows, 13],
  ["katauti units (derived)", T.katautiUnits, 335],
  ["net weight", q(T.netGrams), "331.05"],
  ["weighted avg rate", r(T.weightedAvgRatePaise), "3413.45"],
  ["rows failing reconciliation", T.mismatchRows, 0],
];
let bad = 0;
console.log("\nAgainst the paper:");
for (const [name, got, want] of checks) {
  const ok = got === want;
  if (!ok) bad++;
  console.log(` ${ok ? "PASS" : "FAIL"}  ${String(name).padEnd(30)} ${got}${ok ? "" : "  want " + want}`);
}

console.log("\nDerived katauti vs what is written on the sheet:");
{
  const byRst = new Map(day.rows.map((r: any) => [r.rstNo, r]));
  let miss = 0;
  for (const [rst, , , katautiOnSheet] of SHEET) {
    const row: any = byRst.get(rst);
    if (!row) continue;
    if (row.katautiUnits !== katautiOnSheet) {
      miss++; bad++;
      console.log(` FAIL  RST ${rst}: derived ${row.katautiUnits}, sheet says ${katautiOnSheet}`);
    }
  }
  console.log(miss === 0 ? ` PASS  all ${SHEET.length} derived katauti values match the sheet` : "");
}

console.log("\nRepeated RST (allowed, highlighted):");
try {
  const ad: any = byHi.get("शिवम ट्रेडिंग");
  await call("POST", "/slips", {
    slipDate: DATE, rstNo: "634", adatiId: ad.id, jinsId: j1509.id, merchantId: lb.id,
    grossGrams: 1000000, ratePaisePerQtl: 300000,
  });
  console.log(" PASS  repeated RST 634 accepted");
} catch (e) {
  console.log(" FAIL  repeated RST was refused: " + (e as Error).message.slice(0, 90)); bad++;
}

console.log("\nA typed name is a supplier");
{
  const check = (label: string, got: unknown, want: unknown) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) bad++;
    console.log(` ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `   got ${JSON.stringify(got)}`}`);
  };
  const jinsAll = await call("GET", "/jins");
  const j = jinsAll.find((x: any) => x.code === "1509") ?? jinsAll[0];
  const supBefore = (await call("GET", "/adati?all=1")).length;
  const s1 = await call("POST", "/slips", { slipDate: "2026-12-01", rstNo: "T1", adatiName: "नया टाइप आढ़ती", jinsId: j.id, grossGrams: 1_000_000, ratePaisePerQtl: 300000 });
  check("a Hindi name nobody has becomes a new supplier", s1.supplierCreated?.nameHi, "नया टाइप आढ़ती");
  const s2 = await call("POST", "/slips", { slipDate: "2026-12-01", rstNo: "T2", adatiName: "नया टाइप आढ़ती", jinsId: j.id, grossGrams: 1_000_000, ratePaisePerQtl: 300000 });
  check("the same name again is the same supplier, not a second one", s2.supplierCreated, null);
  const s3 = await call("POST", "/slips", { slipDate: "2026-12-01", rstNo: "T3", adatiName: "Naya Latin Trader", jinsId: j.id, grossGrams: 1_000_000, ratePaisePerQtl: 300000 });
  check("a name typed in English is saved in Devanagari with the English spelling kept, in capitals", /^[\u0900-\u097F ]+$/.test(s3.supplierCreated?.nameHi ?? "") && s3.supplierCreated?.nameHinglish === "NAYA LATIN TRADER", true);
  const day = await call("GET", "/slips?date=2026-12-01");
  const rowT1 = day.rows.find((r: any) => r.rstNo === "T1");
  const e1 = await call("PUT", `/slips/${rowT1.id}`, { adatiName: "दूसरा टाइप आढ़ती" });
  check("editing a row with a new typed name makes that supplier too", e1.supplierCreated?.nameHi, "दूसरा टाइप आढ़ती");
  const e2 = await call("PUT", `/slips/${rowT1.id}`, { adatiName: "Naya Latin Trader" });
  check("…and a known English spelling finds the existing supplier", e2.supplierCreated, null);
  check("the new suppliers are on the supplier list", (await call("GET", "/adati?all=1")).length, supBefore + 3);
  for (const r of day.rows.filter((x: any) => /^T\d$/.test(x.rstNo))) await call("DELETE", `/slips/${r.id}`);
}
console.log(bad === 0 ? "\nDaily list reproduces the sheet exactly." : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
