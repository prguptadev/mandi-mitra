/* Loose packets: a few packets that came without a weighbridge slip are
 * written in the RST box as "N+K" or "N-K" — N packets, the last of them K kg,
 * every other one 50 kg — with the net beside it in kilograms. The owner's
 * sheet of 17-09-2026:
 *   1  RST 1243   dharam kanta 1190 (11.90)  katauti 12  net 11.78  rate 3451   a truck
 *   2  RST 2+45   —                          —           net 95     rate 3200   2 packets: 50 + 45 kg
 *   3  RST 1-64   —                          —           net 64     rate 3481   1 packet of 64 kg
 * Read through the stand-in for Google (scripts/fake-gemini.ts), checked,
 * added, typed on the daily list, and followed into every total.
 * Run through: npm run test:e2e
 */
import "./_guard.ts";
import fs from "node:fs";
import path from "node:path";
import { sqlite } from "../server/db/client.ts";
import { looseRst, grossOdd } from "../server/lib/slipChecks.ts";
import { normRst } from "../server/lib/scanRows.ts";
import { PROMPT } from "../server/lib/gemini.ts";
import { amountPaise, weightedAvgRate } from "../server/lib/money.ts";
import { withRst } from "../src/lib/dailyList.ts";

const BASE = process.env.MANDI_API!;
const D = "2026-08-17";     // the sheet's day (a date no other script uses)
const D_NEXT = "2026-08-18"; // the same sheet read again a day later
const D_OLD = "2026-08-19";  // a slip saved before loose packets were understood
let cookie = "";
let bad = 0;

async function raw(method: string, p: string, body?: unknown) {
  const res = await fetch(BASE + p, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sc = res.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0];
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}
async function call(method: string, p: string, body?: unknown) {
  const r = await raw(method, p, body);
  if (r.status >= 400) throw new Error(`${method} ${p} -> ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
}
const check = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(` ${ok ? "PASS" : "FAIL"}  ${label.padEnd(60)} ${JSON.stringify(got)}${ok ? "" : "  want " + JSON.stringify(want)}`);
};

/* ------------------------------------------------------------ the parser */

console.log("The RST box: loose packets, and what is not");
const L = (v: string | null) => { const x = looseRst(v); return x && [x.packets, x.lastKg, x.netGrams, x.text]; };
check("2+45: 2 packets, last 45 kg = 95 kg", L("2+45"), [2, 45, 95_000, "2+45"]);
check("1-64: 1 packet of 64 kg", L("1-64"), [1, 64, 64_000, "1-64"]);
check("3+40: 50 + 50 + 40 = 140 kg", L("3+40"), [3, 40, 140_000, "3+40"]);
check("spaces: 2 + 45", L("2 + 45"), [2, 45, 95_000, "2+45"]);
check("Hindi digits: २+४५", L("२+४५"), [2, 45, 95_000, "2+45"]);
check("Hindi digits: १-६४", L("१-६४"), [1, 64, 64_000, "1-64"]);
check("a unit written after it: 2+45 kg", L("2+45 kg"), [2, 45, 95_000, "2+45"]);
check("a long dash: 1–64", L("1–64"), [1, 64, 64_000, "1-64"]);
check("the largest taken: 50+100 = 49 × 50 + 100 kg", L("50+100"), [50, 100, 2_550_000, "50+100"]);
// a phone or a word processor puts in its own dash: the minus sign above all ("1−64")
for (const [name, dash] of [["the minus sign U+2212", "\u2212"], ["a hyphen U+2010", "\u2010"], ["a non-breaking hyphen U+2011", "\u2011"],
  ["a figure dash U+2012", "\u2012"], ["an em dash U+2014", "\u2014"], ["a horizontal bar U+2015", "\u2015"],
  ["a small hyphen-minus U+FE63", "\uFE63"], ["a full-width hyphen-minus U+FF0D", "\uFF0D"]]) {
  check(`1${dash}64 with ${name}: 1 packet of 64 kg`, L(`1${dash}64`), [1, 64, 64_000, "1-64"]);
}
check("a full-width plus: 2\uFF0B45 is 95 kg", L("2\uFF0B45"), [2, 45, 95_000, "2+45"]);
check("  ...kept as 1-64 and 2+45", ["1\u221264", "\u0967 \u2212 \u096C\u096A", "2\uFF0B45"].map(normRst), ["1-64", "1-64", "2+45"]);
for (const no of ["1243", "245", "2745", "", "0+45", "2+0", "51+10", "2+101", "2+45+3", "a+45", "2+", "+45", "2.5+45", "12-13-14", "RST 2+45"]) {
  check(`not loose packets: "${no}"`, looseRst(no), null);
}
check("null is not loose packets", looseRst(null), null);
check("kept as 2+45 whatever the spelling", ["२ + ४५ kg", "2 +45", "1 – 64"].map(normRst), ["2+45", "2+45", "1-64"]);
check("an ordinary RST is kept as before", ["६२६", "6 26", "0634"].map(normRst), ["626", "626", "0634"]);
check("95 kg of loose packets is not 'under one quintal'", grossOdd(95_000, "2+45"), null);
check("  ...a 0.95 qtl truck slip still is", grossOdd(95_000, "1243"), "small");

console.log("\nTyping in the daily list's RST box");
type Box = { rstNo: string; gross: string; katauti: string; autoGross?: string };
const typeKeys = (start: Box, ...steps: string[]) => steps.reduce((b, v) => withRst(b, v), start);
const empty: Box = { rstNo: "", gross: "", katauti: "" };
const shown = (b: Box) => [b.rstNo, b.gross, b.katauti];
check("2, 2+, 2+4, 2+45: weight 0.95, katauti 0", shown(typeKeys(empty, "2", "2+", "2+4", "2+45")), ["2+45", "0.95", "0"]);
check("  ...back to 2+4: the weight follows (0.54)", shown(typeKeys(empty, "2+45", "2+4")), ["2+4", "0.54", "0"]);
check("  ...cleared: the weight it put in goes too", shown(typeKeys(empty, "2+45", "2+", "")), ["", "", ""]);
check("Hindi digits and spaces: '१ - ६४' gives 0.64", shown(typeKeys(empty, "१ - ६४")), ["1-64", "0.64", "0"]);
check("a weight typed first is never changed", shown(typeKeys({ rstNo: "", gross: "1.00", katauti: "" }, "2+45")), ["2+45", "1.00", ""]);
check("an ordinary RST fills nothing", shown(typeKeys(empty, "1243")), ["1243", "", ""]);

console.log("\nWhat the reader is told");
check("the prompt explains loose packets in the RST box", /LOOSE PACKETS/.test(PROMPT) && PROMPT.includes('"2+45"') && PROMPT.includes('"1-64"'), true);
check("  ...kept as written with + or -, never one number", /exactly as written with its "\+" or "-"/.test(PROMPT) && /never join it into one number like 245 or 2745/.test(PROMPT), true);
check("  ...no kanta, no katauti, net in kg as written", /no DHARAM KANTA and no KATAUTI: return null for both/.test(PROMPT) && /NET WEIGHT is written in kilograms/.test(PROMPT), true);
check("  ...every other RST is still digits only", PROMPT.includes("Write it with Latin digits 0-9 only") && /every other RST is digits only/.test(PROMPT), true);
check("  ...the other rules stand", PROMPT.includes("1920 almost certainly means 19.20") && PROMPT.includes("Report what is WRITTEN"), true);

/* ------------------------------------------------------------ set up */

const users = await call("GET", "/auth/users");
await call("POST", "/auth/login", { userId: users.find((u: any) => u.name === "Test Owner").id, pin: process.env.MANDI_PIN ?? "482915" });
const me = await call("GET", "/auth/me");
const vldm = me.businesses.find((b: any) => b.shortCode === "VLDM");
if (vldm && me.activeBusinessId !== vldm.businessId) await call("POST", "/auth/switch-business", { businessId: vldm.businessId });
const grm = (await call("GET", "/merchants")).find((m: any) => m.code === "GRM");
const j1509 = (await call("GET", "/jins")).find((j: any) => j.code === "1509");
// the sheet's three suppliers, known by name, so every line resolves on its own
const NAMES = ["जय भारत ट्रेडिंग कंपनी", "विशाल बन्धु जैन", "लोकपाल सिंह"];
const sup: Record<string, string> = {};
for (const n of NAMES) sup[n] = (await call("POST", "/adati", { nameHi: n })).id;
const geminiWas = await call("GET", "/settings/gemini");
await call("PUT", "/settings/gemini", { apiKey: "AIzaFAKE-KEY-ONLY-FOR-THE-LOCAL-STAND-IN", model: "gemini-test-loose", fallbackModel: "gemini-test-loose", backupModels: [] });

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
async function readSheet(date: string, model: string, tag: string) {
  const fd = new FormData();
  fd.append("files", new File([Buffer.concat([PNG, Buffer.from(tag)])], `${tag}.png`, { type: "image/png" }));
  fd.append("slipDate", date);
  fd.append("merchantId", grm.id);
  fd.append("jinsId", j1509.id);
  const { id } = await (await fetch(`${BASE}/scans`, { method: "POST", body: fd, headers: { cookie } })).json() as { id: string };
  await call("POST", `/scans/${id}/run`, { model });
  for (let i = 0; i < 120; i++) {
    const s = await call("GET", `/scans/${id}`);
    if (s.status !== "reading" && !s.running) return s;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("the read did not finish");
}
const line = (s: any, rst: string) => s.rows.find((r: any) => r.rstNo === rst);
const figures = (r: any) => [r.grossGrams, r.katautiOverride, r.derivedKatautiUnits, r.derivedNetGrams, r.derivedAmountPaise];
// what a line says about its slip and its weight (a rate unlike the day's other rates is its own matter)
const codes = (r: any) => r.issues.map((i: any) => i.code).filter((c: string) => c !== "rate_day");
const says = (r: any) => r.issues.filter((i: any) => i.code !== "rate_day").map((i: any) => i.message);

/* ------------------------------------------------------------ the sheet */

console.log("\nThe owner's sheet, read (loose nets written in kg: 95, 64)");
const A = await readSheet(D, "gemini-test-loose", "loose-a");
check("three lines read, in order", A.rows.map((r: any) => r.rstNo), ["1243", "2+45", "1-64"]);
check("the RST is kept as written", A.rows.map((r: any) => r.ocr.rstNo), ["1243", "2+45", "1-64"]);
// gross, katauti typed, katauti, net, amount
check("RST 1243: 11.90 − 12 kg = 11.78 qtl, × 3451 = ₹40,652.78", figures(line(A, "1243")), [1_190_000, null, 12, 1_178_000, 4_065_278]);
check("RST 2+45: 95 kg, no katauti, × 3200 = ₹3,040.00", figures(line(A, "2+45")), [95_000, 0, 0, 95_000, 304_000]);
check("RST 1-64: 64 kg, no katauti, × 3481 = ₹2,227.84", figures(line(A, "1-64")), [64_000, 0, 0, 64_000, 222_784]);
check("  ...the same as the money rule, half up", [amountPaise(1_178_000, 345_100), amountPaise(95_000, 320_000), amountPaise(64_000, 348_100)], [4_065_278, 304_000, 222_784]);
check("the sheet's own nets agree on every line (95 read as kg)", A.rows.map((r: any) => r.netAgrees), [true, true, true]);
check("no warning on any line: not 'small', not 'net differs', not a repeat", A.rows.map(codes), [[], [], []]);
check("nothing blocks", [A.summary.blocking, A.summary.warnings, A.summary.clean], [0, 0, 3]);
check("the sheet adds to 13.37 qtl, ₹45,920.62", [A.summary.totalNetGrams, A.summary.totalAmountPaise], [1_337_000, 4_592_062]);
check("only the line count is asked (no total at the bottom)", A.pageChecks.map((p: any) => p.code), ["page_count"]);
await call("PUT", `/scans/${A.id}/page-confirm`, { page: 1, what: "count", on: true });
const added = await call("POST", `/scans/${A.id}/commit`, { rev: (await call("GET", `/scans/${A.id}`)).rev });
check("added: three slips", added.created, 3);
type Slip = { id: string; rst: string; gross: number; units: number; over: number; net: number; rate: number; amount: number; commission: number; gaushala: number; payable: number; adati: string };
const SLIP_COLS = `id, rst_no rst, gross_grams gross, katauti_units units, katauti_override over, net_grams net, rate_paise_per_qtl rate, amount_paise amount,
  commission_paise commission, gaushala_paise gaushala, payable_paise payable, adati_id adati`;
const slipsA = sqlite.prepare(`select ${SLIP_COLS} from purchase_slips where scan_batch_id = ? order by rst_no`).all(A.id) as Slip[];
const stored = (s: Slip) => [s.rst, s.gross, s.units, s.over, s.net, s.amount];
check("stored: 1-64 = 64,000 g, katauti 0, ₹2,227.84", stored(slipsA.find((s) => s.rst === "1-64")!), ["1-64", 64_000, 0, 1, 64_000, 222_784]);
check("stored: 1243 = 11.78 qtl, katauti 12, ₹40,652.78", stored(slipsA.find((s) => s.rst === "1243")!), ["1243", 1_190_000, 12, 0, 1_178_000, 4_065_278]);
check("stored: 2+45 = 95,000 g, katauti 0, ₹3,040.00", stored(slipsA.find((s) => s.rst === "2+45")!), ["2+45", 95_000, 0, 1, 95_000, 304_000]);
check("what each supplier is owed = amount + commission + gaushala", slipsA.every((s) => s.payable === s.amount + s.commission + s.gaushala), true);
const s245 = slipsA.find((s) => s.rst === "2+45")!;

console.log("\nThe same sheet, the reader giving the loose nets in quintal (0.95, 0.64)");
const B = await readSheet(D_NEXT, "gemini-test-loose-qtl", "loose-b");
check("the same weights and amounts", B.rows.map(figures), A.rows.map(figures));
check("0.95 and 0.64 agree as well", B.rows.map((r: any) => r.netAgrees), [true, true, true]);
// a day later: 1243 with the same 11.90 is the same sheet again; 2+45 and 1-64 recur by nature
check("1243 with the same weight a day before is flagged; the loose lines are not", B.rows.map(codes), [["rst_other_day"], [], []]);
await call("DELETE", `/scans/${B.id}`);

console.log("\nThe same sheet with 90 written as the net of 2+45");
const C = await readSheet(D, "gemini-test-loose-off", "loose-c");
const off = line(C, "2+45");
check("2+45 stays 95 kg: nothing is guessed", figures(off), [95_000, 0, 0, 95_000, 304_000]);
check("  ...the line says why, in one sentence", says(off), ["2+45 is 95 kg; the sheet says 90"]);
check("  ...and waits for a fix or a ✓", [off.issues[0].level, off.blocking], ["error", true]);
check("1243 is already on this day's list; the loose lines are not a repeat", C.rows.map(codes), [["rst_exists"], ["loose_net"], []]);
let c2 = await call("PUT", `/scans/${C.id}/rows`, { rows: C.rows.map((r: any) => r.rstNo === "2+45" ? { ...r, confirmed: ["gross"] } : r), rev: C.rev });
check("✓ 'right as read': a look, no longer a stop", [line(c2, "2+45").issues[0]?.level, line(c2, "2+45").blocking], ["warn", false]);
c2 = await call("PUT", `/scans/${C.id}/rows`, { rows: c2.rows.map((r: any) => r.rstNo === "2+45" ? { ...r, rstNo: "2+40", confirmed: [] } : r), rev: c2.rev });
const fixed = c2.rows.find((r: any) => r.id === off.id);
check("the RST corrected to 2+40: its weight follows (90 kg), the line is clear", [fixed.rstNo, ...figures(fixed), codes(fixed)], ["2+40", 90_000, 0, 0, 90_000, 288_000, []]);
const typedOver = await call("PUT", `/scans/${C.id}/rows`, { rows: c2.rows.map((r: any) => r.id === off.id ? { ...r, grossGrams: 92_000 } : r), rev: c2.rev });
const t92 = typedOver.rows.find((r: any) => r.id === off.id);
check("a weight typed over it is kept, and said", [t92.grossGrams, says(t92)], [92_000, ["2+40 is 90 kg; the weight here is 92 kg"]]);
const twice = await call("PUT", `/scans/${C.id}/rows`, { rows: typedOver.rows.map((r: any) => r.rstNo === "1-64" ? { ...r, rstNo: "2+40" } : r.id === off.id ? { ...r, grossGrams: 90_000 } : r), rev: typedOver.rev });
check("two lines of 2+40 on one sheet: no 'appears twice'", twice.rows.filter((r: any) => r.rstNo === "2+40").map(codes), [[], ["loose_net"]]);
await call("DELETE", `/scans/${C.id}`);

/* ------------------------------------------------------------ downstream */

console.log("\nThe sheet's slips in every total (" + D + ", G.R.M)");
const day = await call("GET", `/slips?date=${D}&merchantId=${grm.id}`);
const t = day.totals;
check("daily list: 3 rows, gross 13.49, katauti 12, net 13.37 qtl", [t.rows, t.grossGrams, t.katautiUnits, t.netGrams], [3, 1_349_000, 12, 1_337_000]);
check("  ...amount ₹45,920.62, everything reconciles", [t.amountPaise, t.mismatchRows], [4_592_062, 0]);
const avg = weightedAvgRate(slipsA.map((s) => ({ netGrams: s.net, ratePaisePerQtl: s.rate })));
check("  ...weighted rate 3434.60 (Σ net × rate ÷ Σ net, half up)", [t.weightedAvgRatePaise, avg], [343_460, 343_460]);
const loosesOnList = day.rows.filter((r: any) => looseRst(r.rstNo));
check("  ...the loose rows carry no flag", loosesOnList.map((r: any) => [r.rstNo, r.rstDay, r.rstOtherDays.length, r.grossOdd, r.looseOff, r.reconciles]),
  [["2+45", 1, 0, null, null, true], ["1-64", 1, 0, null, null, true]]);

const ledger = await call("GET", `/ledger/${sup["विशाल बन्धु जैन"]}?from=${D}&to=${D}`);
const buy = ledger.entries.find((e: any) => e.kind === "purchase");
check("supplier ledger: 2+45, 95 kg, goods ₹3,040.00, credit = its net amount", [buy.rstNo, buy.netGrams, buy.goodsPaise, buy.creditPaise], ["2+45", 95_000, 304_000, s245.payable]);
const pay = await call("GET", `/ledger/sheet?mode=day&date=${D}&format=json`);
const payRow = (nameHi: string) => pay.rows.find((r: any) => r.nameHi === nameHi);
const s164 = slipsA.find((s) => s.rst === "1-64")!;
check("pay sheet: 95 kg for ₹3,040.00 and 64 kg for ₹2,227.84, with their charges", ["विशाल बन्धु जैन", "लोकपाल सिंह"].map((n) => [payRow(n)?.netGrams, payRow(n)?.goodsPaise, payRow(n)?.payablePaise]),
  [[95_000, 304_000, s245.payable], [64_000, 222_784, s164.payable]]);
const stock = await call("GET", `/stock/${grm.id}?from=${D}&to=${D}&jinsId=${j1509.id}`);
const sday = stock.days.find((d: any) => d.date === D);
check("stock: the day bought 13.37 qtl at 3434.60, ₹45,920.62", [sday?.slips, sday?.boughtNet, sday?.avgRatePaisePerQtl, sday?.boughtAmount], [3, 1_337_000, 343_460, 4_592_062]);
const mill = await call("GET", `/reports/mill?merchantId=${grm.id}&from=${D}&to=${D}&format=json&cols=sr,rstNo,gross,katauti,net,rate,amount`);
check("mill report: three rows, 2+45 and 1-64 among them", mill.rows.map((r: any) => r.rstNo).sort(), ["1-64", "1243", "2+45"]);
check("  ...net 13.37 qtl, ₹45,920.62", [mill.totals.netGrams, mill.totals.amountPaise], [1_337_000, 4_592_062]);
const truck = await call("POST", "/loads", { loadDate: D, merchantId: grm.id, jinsId: j1509.id, stockDate: D, truckNo: "UP80LP0001" });
const tl = await call("GET", `/loads/${truck.id}`);
check("truck (parcha): its row takes the day's 13.37 qtl at 3434.60", [tl.lines[0].day.boughtNetGrams, tl.lines[0].dayAvgRatePaisePerQtl], [1_337_000, 343_460]);
await call("DELETE", `/loads/${truck.id}`);

/* ------------------------------------------------------------ typed */

console.log("\nTyped on the daily list");
const typed = await call("POST", "/slips", { slipDate: D, rstNo: "२ + ४५", adatiId: sup["विशाल बन्धु जैन"], jinsId: j1509.id, merchantId: grm.id, ratePaisePerQtl: 320_000 });
const typedRow = sqlite.prepare(`select ${SLIP_COLS} from purchase_slips where id = ?`).get(typed.id) as Slip;
const same = (s: Slip) => [s.rst, s.gross, s.units, s.over, s.net, s.rate, s.amount, s.commission, s.gaushala, s.payable, s.adati];
check("'२ + ४५' with no weight: the same slip as from the sheet", same(typedRow), same(s245));
check("  ...and not a repeat of the sheet's 2+45", [typed.rstRepeated, typed.flags.sameDay.length, typed.flags.grossOdd, typed.flags.looseOff], [false, 0, null, null]);
const t64 = await call("POST", "/slips", { slipDate: D, rstNo: "1-64", adatiId: sup["लोकपाल सिंह"], jinsId: j1509.id, merchantId: grm.id, grossGrams: 64_000, katautiUnits: null, ratePaisePerQtl: 348_100 });
check("1-64 with 0.64 typed: no katauti, ₹2,227.84", [t64.katautiUnits, t64.netGrams, t64.amountPaise, t64.flags.looseOff], [0, 64_000, 222_784, null]);
const t90 = await call("POST", "/slips", { slipDate: D, rstNo: "2+45", adatiId: sup["विशाल बन्धु जैन"], jinsId: j1509.id, merchantId: grm.id, grossGrams: 90_000, ratePaisePerQtl: 320_000 });
check("2+45 with 0.90 typed: the typed weight is kept, and flagged", [t90.netGrams, t90.amountPaise, t90.flags.looseOff], [90_000, 288_000, { rst: "2+45", kg: 95 }]);
const listed = (await call("GET", `/slips?date=${D}&merchantId=${grm.id}`)).rows.find((r: any) => r.id === t90.id);
check("  ...on the list too", [listed.looseOff, listed.rstDay], [{ rst: "2+45", kg: 95 }, 1]);
const put = await call("PUT", `/slips/${t90.id}`, { grossGrams: 95_000 });
check("  ...put right to 0.95: the flag goes", [put.netGrams, put.amountPaise, put.flags.looseOff], [95_000, 304_000, null]);
const noGross = await raw("POST", "/slips", { slipDate: D, rstNo: "1250", adatiId: sup["जय भारत ट्रेडिंग कंपनी"], jinsId: j1509.id, merchantId: grm.id, ratePaisePerQtl: 345_100 });
check("an ordinary RST still needs its weight", [noGross.status, noGross.json?.error], [400, "Gross weight is required"]);
const minus = await raw("POST", "/slips", { slipDate: D, rstNo: "1\u221264", adatiId: sup["लोकपाल सिंह"], jinsId: j1509.id, merchantId: grm.id, ratePaisePerQtl: 348_100 });
const minusRow = minus.json?.id ? sqlite.prepare("select rst_no rst, gross_grams gross, katauti_units units, net_grams net from purchase_slips where id = ?").get(minus.json.id) as { rst: string } : null;
check("'1\u221264' typed with the minus sign, no weight: kept as 1-64, 64 kg, no katauti", [minus.status, minusRow], [200, { rst: "1-64", gross: 64_000, units: 0, net: 64_000 }]);

console.log("\nA slip saved before this, untouched");
// as v0.3.19 saved "2+45" typed with 0.95: katauti 1 worked out from the weight, net 0.94
const old = await call("POST", "/slips", { slipDate: D_OLD, rstNo: "2+45", adatiId: sup["विशाल बन्धु जैन"], jinsId: j1509.id, merchantId: grm.id, grossGrams: 95_000, katautiUnits: 1, ratePaisePerQtl: 320_000 });
sqlite.prepare("update purchase_slips set katauti_override = 0 where id = ?").run(old.id);
const oldDay = await call("GET", `/slips?date=${D_OLD}`);
check("it still reconciles on its own terms (net 94 kg)", oldDay.rows.map((r: any) => [r.netGrams, r.katautiUnits, r.reconciles]), [[94_000, 1, true]]);
check("'work the day out again' changes nothing", (await call("POST", "/slips/recompute", { slipDate: D_OLD })).changed, 0);

/* ------------------------------------------------------------ clean up */

for (const id of [...slipsA.map((s) => s.id), typed.id, t64.id, t90.id, old.id, ...(minus.json?.id ? [minus.json.id] : [])]) await call("DELETE", `/slips/${id}`);
sqlite.prepare("delete from scan_batches where id = ?").run(A.id);
fs.rmSync(path.resolve(process.env.MANDI_DATA_DIR!, "scans", A.id), { recursive: true, force: true });
for (const id of Object.values(sup)) await call("DELETE", `/adati/${id}`);
await call("PUT", "/settings/gemini", { model: geminiWas.model, fallbackModel: geminiWas.fallbackModel, backupModels: geminiWas.backupModels });
check("nothing of this script is left", (sqlite.prepare("select count(*) n from purchase_slips where slip_date in (?, ?, ?)").get(D, D_NEXT, D_OLD) as { n: number }).n, 0);

console.log(bad === 0 ? "\nLoose packets work end to end." : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
