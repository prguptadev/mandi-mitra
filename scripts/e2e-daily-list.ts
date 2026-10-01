import "./_guard.ts";
import { numberOnly } from "../server/lib/slipChecks.ts";
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

async function raw(method: string, path: string, body?: unknown) {
  const res = await fetch(BASE + path, {
    method, headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  await res.text();
  return { status: res.status };
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

  console.log("\nThe day's rate at the top of the dashboard");
  const dayAvg = await call("GET", `/dashboard/day-averages?days=7&from=${DATE}&to=${DATE}`);
  const dayRow = dayAvg.days.find((d: any) => d.date === DATE);
  const dayList = await call("GET", `/slips?date=${DATE}`);
  check("the day has a line for the mill and commodity", (dayRow?.lines?.length ?? 0) >= 1, true);
  check("  ...its average is the daily list's own weighted average", dayRow.total.avgRatePaisePerQtl, dayList.totals.weightedAvgRatePaise);
  check("  ...and its net weight is the daily list's priced net", dayRow.lines.reduce((s: number, l: any) => s + l.netGrams, 0), dayList.totals.pricedNetGrams);
  /* A slip with no mill on it was bought by the firm itself. "All mills" counts
     it; "added mills only" leaves it out, and the average moves accordingly. */
  const own = await call("POST", "/slips", { slipDate: "2026-12-05", rstNo: "OWN1", adatiName: "अपनी खरीद", jinsId: j.id, grossGrams: 2_000_000, ratePaisePerQtl: 300_000 });
  const withMill = await call("POST", "/slips", { slipDate: "2026-12-05", rstNo: "OWN2", adatiName: "अपनी खरीद", jinsId: j.id, grossGrams: 1_000_000, ratePaisePerQtl: 400_000, merchantId: (await call("GET", "/merchants"))[0].id });
  const allMills = (await call("GET", "/dashboard/day-averages?days=1&from=2026-12-05&to=2026-12-05&mills=all")).days[0];
  const addedOnly = (await call("GET", "/dashboard/day-averages?days=1&from=2026-12-05&to=2026-12-05&mills=added")).days[0];
  check("all mills counts what the firm bought itself", allMills.lines.length, 2);
  check("  ...added mills only leaves it out", addedOnly.lines.length, 1);
  check("  ...and that line is the one with a mill on it", addedOnly.lines[0].millId !== null, true);
  check("all mills averages both: (20×3000 + 10×4000) ÷ 30", allMills.total.avgRatePaisePerQtl, 333_333);
  check("  ...added mills only is that one mill's own rate", addedOnly.total.avgRatePaisePerQtl, 400_000);
  for (const id of [own.id, withMill.id]) await call("DELETE", `/slips/${id}`);

  const noRate = await call("POST", "/slips", { slipDate: "2026-12-03", rstNo: "NR1", adatiName: "बिना दर आढ़ती", jinsId: j.id, grossGrams: 1_000_000, ratePaisePerQtl: 0 });
  const withNoRate = await call("GET", "/dashboard/day-averages?days=30&from=2026-12-03&to=2026-12-03");
  const nrDay = withNoRate.days.find((d: any) => d.date === "2026-12-03");
  check("a day whose slips have no rate shows no average, and says how many wait", [nrDay?.lines.length, nrDay?.waiting], [0, 1]);
  await call("DELETE", `/slips/${noRate.id}`);

  console.log("\nTwo rows that are one trader");
  const mills = await call("GET", "/merchants");
  const mill = mills[0];
  const A = await call("POST", "/adati", { nameHi: "मिलाओ आढ़ती क", openingBalanceRupees: 500 });
  const B = await call("POST", "/adati", { nameHi: "मिलाओ आढ़ती ख", openingBalanceRupees: 300 });
  const sa = await call("POST", "/slips", { slipDate: "2026-12-02", rstNo: "M1", adatiId: A.id, merchantId: mill.id, jinsId: j.id, grossGrams: 2_000_000, ratePaisePerQtl: 300000 });
  const sb = await call("POST", "/slips", { slipDate: "2026-12-02", rstNo: "M2", adatiId: B.id, merchantId: mill.id, jinsId: j.id, grossGrams: 1_000_000, ratePaisePerQtl: 300000 });
  await call("POST", "/payments", { adatiId: B.id, payDate: "2026-12-02", amountPaise: 100000, mode: "cash" });
  const ledgerOf = async (id: string) => (await call("GET", `/ledger/${id}`)).totals;
  const beforeA = await ledgerOf(A.id);
  const beforeB = await ledgerOf(B.id);
  const pre = await call("GET", `/adati/${B.id}/merge-preview`);
  check("the box says what would move", [pre.slips, pre.payments], [1, 1]);
  check("MERGE must be typed", (await raw("POST", `/adati/${B.id}/merge`, { intoId: A.id, confirm: "yes" })).status, 400);
  const m = await call("POST", `/adati/${B.id}/merge`, { intoId: A.id, confirm: "MERGE" });
  check("the slip and the payment moved", [m.slips, m.payments], [1, 1]);
  check("the supplier that went is off the list", (await raw("GET", `/adati/${B.id}`)).status, 404);
  const afterA = await ledgerOf(A.id);
  check("nothing of the money is lost: both ledgers add up to the one that stays",
    afterA.closingPaise, beforeA.closingPaise + beforeB.closingPaise);
  check("  ...and the survivor now carries both sets of slips", afterA.slips, beforeA.slips + beforeB.slips);
  check("its opening balance was added on", (await call("GET", `/adati/${A.id}`)).openingBalancePaise, 80000);
  check("a sheet still being checked has its rows moved too", typeof m.scanRows, "number");
  const resolved = await call("POST", "/adati/resolve", { text: "मिलाओ आढ़ती ख" });
  check("the old name now reads as the supplier that stays", resolved.match?.adatiId ?? resolved.suggestions?.[0]?.adatiId, A.id);
  for (const id of [sa.id, sb.id]) await call("DELETE", `/slips/${id}`);

  /* Book guards: the same weighbridge slip twice, and figures that look like a
     lost decimal point. Every one is a flag — the slip is always saved. */
  console.log("\nThe same RST on any date: a flag, never a block");
  const lbM = mills.find((x: any) => x.code === "LB");
  const grmM = mills.find((x: any) => x.code === "GRM");
  const made: string[] = [];
  // a supplier already on the books (the sheet's RST 633 trader), so nothing new is left behind
  const tester = (byHi.get(SHEET[3][1]) as any).id;
  const put = async (b: any) => { const s = await call("POST", "/slips", { jinsId: j.id, adatiId: tester, ratePaisePerQtl: 345_000, ...b }); made.push(s.id); return s; };
  const g1 = await put({ slipDate: "2027-01-10", rstNo: "1630", merchantId: lbM.id, grossGrams: 2_860_000 });
  check("a first slip carries no flag", [g1.rstRepeated, g1.flags.sameDay.length, g1.flags.otherDays.length], [false, 0, 0]);
  const g2 = await put({ slipDate: "2027-01-15", rstNo: "०१६३०", merchantId: lbM.id, grossGrams: 2_860_000 });
  check("RST typed in Hindi digits is saved in English digits", (await call("GET", "/slips?date=2027-01-15")).rows.find((r: any) => r.id === g2.id)?.rstNo, "01630");
  check("the same RST and weight five days before is flagged, naming the date (0 and Hindi digits read as a number)", g2.flags.otherDays.map((o: any) => [o.date, o.millCode]), [["2027-01-10", "LB"]]);
  check("  ...and the slip is saved all the same", typeof g2.id, "string");
  const g3 = await put({ slipDate: "2027-01-15", rstNo: "1630", merchantId: grmM.id, grossGrams: 3_000_000 });
  check("the same RST under another mill that day is a repeat, naming the mill", [g3.rstRepeated, g3.flags.sameDay.map((o: any) => o.millCode)], [true, ["LB"]]);
  check("  ...a different weight on another date is not flagged (kanta numbers repeat)", g3.flags.otherDays.length, 0);
  const g4 = await put({ slipDate: "2027-03-01", rstNo: "1630", merchantId: lbM.id, grossGrams: 2_860_000 });
  check("the same RST and weight more than 30 days away is not flagged", g4.flags.otherDays.length, 0);
  const onlyGrm = await call("GET", `/slips?date=2027-01-15&merchantId=${grmM.id}`);
  check("a list showing one mill still marks the repeat from the other mill", onlyGrm.rows.map((r: any) => r.rstDay), [2]);
  const onlyLb = await call("GET", `/slips?date=2027-01-15&merchantId=${lbM.id}`);
  check("the row carries the other date, for the orange mark", onlyLb.rows.map((r: any) => r.rstOtherDays), [["2027-01-10"]]);
  check("  ...and the day counts such rows for its banner", onlyLb.totals.rstOtherDayRows, 1);
  check("the new row's RST box knows the whole day's numbers", (await call("GET", "/slips/next-rst?date=2027-01-15")).taken.includes("1630"), true);
  const ed = await call("PUT", `/slips/${g3.id}`, { grossGrams: 2_860_000 });
  check("an edit says the same as a new slip", [ed.rstRepeated, ed.flags.otherDays.map((o: any) => o.date)], [true, ["2027-01-10"]]);

  console.log("\nRate numbers only, and figures far from the day");
  // the number box: a word's dot ("Rs.", "Qtl.") is never read as a decimal point
  check("a pasted rate keeps only its number: Rs. 3,450/- → 3450, Rs.3450 → 3450, रु. 3,450 → 3450, ₹3,450.00/- → 3450.00",
    ["Rs. 3,450/-", "Rs.3450", "रु. 3,450", "₹3,450.00/-"].map((x) => numberOnly(x)), ["3450", "3450", "3450", "3450.00"]);
  check("  ...and a pasted weight too: Qtl. 19.20 → 19.20, 19.20 q. → 19.20", ["Qtl. 19.20", "19.20 q."].map((x) => numberOnly(x)), ["19.20", "19.20"]);
  check("a rate with letters in it is refused, never saved as 0", (await raw("POST", "/slips", { slipDate: "2027-01-20", rstNo: "R1", adatiId: tester, jinsId: j.id, grossGrams: 2_000_000, ratePaisePerQtl: "3450/-" })).status, 400);
  for (const [rst, rate] of [["R2", 3400], ["R3", 3450], ["R4", 3500], ["R5", 3450], ["R6", 3420]] as const) {
    await put({ slipDate: "2027-01-20", rstNo: rst, merchantId: lbM.id, grossGrams: 2_000_000, ratePaisePerQtl: rate * 100 });
  }
  const odd = await put({ slipDate: "2027-01-20", rstNo: "R7", merchantId: lbM.id, grossGrams: 28_600_000, ratePaisePerQtl: 3_450_000 });
  check("286 qtl on one slip is flagged as a likely lost decimal point", odd.flags.grossOdd, "large");
  check("a rate of 34,500 on a 3,450 day is flagged", odd.flags.rateOdd?.medianPaise, 345_000);
  check("  ...and both are saved", typeof odd.id, "string");
  const day20 = await call("GET", "/slips?date=2027-01-20");
  check("the list marks the row", [day20.rows.find((r: any) => r.id === odd.id)?.grossOdd, Boolean(day20.rows.find((r: any) => r.id === odd.id)?.rateOdd)], ["large", true]);
  check("an ordinary row is not marked", day20.rows.filter((r: any) => r.id !== odd.id).every((r: any) => !r.grossOdd && !r.rateOdd), true);

  console.log("\nMoving slips to a mill keeps the ones already there");
  // a slip made at GRM on 1 kg a quintal; GRM's katauti then becomes 1.5 kg
  const stay = await put({ slipDate: "2027-01-25", rstNo: "V1", merchantId: grmM.id, grossGrams: 2_860_000 });
  const stayBefore = (await call("GET", "/slips?date=2027-01-25")).rows.find((r: any) => r.id === stay.id);
  const cfg0 = grmM.chargeConfig;
  await call("PUT", `/merchants/${grmM.id}`, { chargeConfig: { ...cfg0, katauti: { ...cfg0.katauti, kgPerUnit: 1.5 } } });
  try {
    const mover = await put({ slipDate: "2027-01-25", rstNo: "V2", merchantId: lbM.id, grossGrams: 2_860_000 });
    const mv = await call("POST", "/slips/reassign", { slipIds: [mover.id, stay.id], merchantId: grmM.id });
    const after = (await call("GET", "/slips?date=2027-01-25")).rows;
    const stayAfter = after.find((r: any) => r.id === stay.id);
    check("only the slip changing mill is moved", mv.updated, 1);
    check("a slip already at that mill keeps the net and payable it was made with", [stayAfter.netGrams, stayAfter.payablePaise], [stayBefore.netGrams, stayBefore.payablePaise]);
    check("the moved slip takes its new mill's katauti (29 × 1.5 kg)", after.find((r: any) => r.id === mover.id).netGrams, 2_860_000 - 43_500);
    check("moving only slips already there changes nothing", (await call("POST", "/slips/reassign", { slipIds: [stay.id], merchantId: grmM.id })).updated, 0);
  } finally {
    await call("PUT", `/merchants/${grmM.id}`, { chargeConfig: cfg0 });
  }

  console.log("\nThe day's rate card: net × average is the amount");
  await put({ slipDate: "2027-01-28", rstNo: "D1", merchantId: grmM.id, grossGrams: 2_000_000, ratePaisePerQtl: 300_000 });
  await put({ slipDate: "2027-01-28", rstNo: "D2", merchantId: grmM.id, grossGrams: 1_000_000, ratePaisePerQtl: 0 });
  const dd = (await call("GET", "/dashboard/day-averages?days=1&from=2027-01-28&to=2027-01-28")).days[0];
  const line = dd.lines[0];
  check("a line's net is its priced net (20.00 − 0.20)", line.netGrams, 1_980_000);
  check("  ...so net × average is its amount", Math.round(line.netGrams * line.avgRatePaisePerQtl / 100_000), line.amountPaise);
  check("  ...and the weight with no rate is given apart (10.00 − 0.10)", [line.unpricedNetGrams, dd.unpricedNetGrams], [990_000, 990_000]);

  console.log("\nThe books check names the same slip on two dates");
  const books = await call("GET", "/audit/books-check");
  const twice = books.businesses[0].sections[0].lines.find((l: any) => /same RST and the same weight/.test(l.text));
  check("as a note to look at, not a tick and not a failure", [twice?.ok, twice?.warn], [null, true]);
  check("  ...naming the RST and both dates", /RST 1630 28\.60 qtl on 10-01-2027, 15-01-2027/.test(twice?.text ?? ""), true);
  for (const id of made) await call("DELETE", `/slips/${id}`);
}
console.log(bad === 0 ? "\nDaily list reproduces the sheet exactly." : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
