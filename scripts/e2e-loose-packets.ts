/* Loose packets: a few packets that came without a weighbridge slip are
 * written in the RST box as "N+K" or "N-K" — N packets, the last of them K kg,
 * every other one 50 kg — with the net beside it in kilograms. The owner's
 * sheet of 17-09-2026:
 *   1  RST 1243   dharam kanta 1190 (11.90)  katauti 12  net 11.78  rate 3451   a truck
 *   2  RST 2+45   —                          —           net 95     rate 3200   2 packets: 50 + 45 kg
 *   3  RST 1-64   —                          —           net 64     rate 3481   1 packet of 64 kg
 * Read through the stand-in for Google (scripts/fake-gemini.ts), checked,
 * added, typed on the daily list, and followed into every total. Then the
 * same sheet misread ("1-64" for RST 1164, "12-43" for 1243) and put right,
 * on the sheet screen and on the daily list alike.
 * Run through: npm run test:e2e
 */
import "./_guard.ts";
import fs from "node:fs";
import path from "node:path";
import { sqlite } from "../server/db/client.ts";
import { looseRst, grossOdd } from "../server/lib/slipChecks.ts";
import * as slipChecks from "../server/lib/slipChecks.ts";
import { normRst } from "../server/lib/scanRows.ts";
import { PROMPT } from "../server/lib/gemini.ts";
import { amountPaise, weightedAvgRate } from "../server/lib/money.ts";
import { withRst } from "../src/lib/dailyList.ts";
import * as dailyList from "../src/lib/dailyList.ts";

const BASE = process.env.MANDI_API!;
const FAKE = process.env.MANDI_GEMINI_BASE!;
const D = "2026-08-17";     // the sheet's day (a date no other script uses)
const D_NEXT = "2026-08-18"; // the same sheet read again a day later
const D_OLD = "2026-08-19";  // a slip saved before loose packets were understood
const D_M = "2026-08-21";    // the sheet misread
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
/** A check that runs code: what it threw is what it got. */
const safe = (f: () => unknown) => { try { return f(); } catch (e) { return `threw: ${(e as Error).message}`; } };
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
type Box = { rstNo: string; gross: string; katauti: string };
const typeKeys = (start: Box, ...steps: string[]) => steps.reduce((b, v) => withRst(b, v), start);
const empty: Box = { rstNo: "", gross: "", katauti: "" };
const shown = (b: Box) => [b.rstNo, b.gross, b.katauti];
// the katauti box is left empty: its 0 for loose packets is the rule, shown faint, as on the sheet screen
check("2, 2+, 2+4, 2+45: weight 0.95, the katauti box left to the rule", shown(typeKeys(empty, "2", "2+", "2+4", "2+45")), ["2+45", "0.95", ""]);
check("  ...back to 2+4: the weight follows (0.54)", shown(typeKeys(empty, "2+45", "2+4")), ["2+4", "0.54", ""]);
check("  ...cleared: the weight it put in goes too", shown(typeKeys(empty, "2+45", "2+", "")), ["", "", ""]);
check("Hindi digits and spaces: '१ - ६४' gives 0.64", shown(typeKeys(empty, "१ - ६४")), ["1-64", "0.64", ""]);
check("a weight typed first is never changed, loose or not", shown(typeKeys({ rstNo: "", gross: "1.00", katauti: "" }, "2+45", "1245")), ["1245", "1.00", ""]);
check("a katauti typed first is never changed, loose or not", shown(typeKeys({ rstNo: "", gross: "", katauti: "1" }, "2+45", "1245")), ["1245", "", "1"]);
check("an ordinary RST fills nothing", shown(typeKeys(empty, "1243")), ["1243", "", ""]);
const RULE = { mode: "per_quintal_rounded", kgPerUnit: 1 } as const; // G.R.M's: 1 kg a quintal, rounded
const kat = (rst: string, grams: number | null) => safe(() => dailyList.suggestedKatauti(rst, grams, RULE));
check("the katauti it suggests: 2+45 at its own 0.95 has none", kat("2+45", 95_000), 0);
check("  ...2+45 at 0.90 typed (not its weight): the mill's, 1", kat("2+45", 90_000), 1);
check("  ...'12-43' with 11.90 typed (RST 1243, a stray dash): the mill's 12, never a silent 0", kat("12-43", 1_190_000), 12);
check("  ...an ordinary 1243 at 11.90: 12, as always; nothing without a weight", [kat("1243", 1_190_000), kat("2+45", null)], [12, null]);

console.log("\nEditing a saved slip on the daily list");
type Saved = { rstNo: string; grossGrams: number; katautiUnits: number; katautiOverride: boolean };
// what the edit row opens with: the weight to 2 places, and the katauti box as the list fills it
const opened = (r: Saved): Box => ({ rstNo: r.rstNo, gross: (r.grossGrams / 100_000).toFixed(2), katauti: String(safe(() => dailyList.katautiBox(r))) });
const open245: Saved = { rstNo: "2+45", grossGrams: 95_000, katautiUnits: 0, katautiOverride: true };
check("a saved 2+45 opens at 0.95, its katauti 0 the rule's, not typed", shown(opened(open245)), ["2+45", "0.95", ""]);
check("  ...RST to 2+40: the weight follows, 0.95 → 0.90", shown(typeKeys(opened(open245), "2+40")), ["2+40", "0.90", ""]);
check("  ...one key at a time (2+4, 2+40): the same", shown(typeKeys(opened(open245), "2+4", "2+40")), ["2+40", "0.90", ""]);
check("  ...RST to 1245 (a misread put right): its 0.95 goes, to be typed", shown(typeKeys(opened(open245), "1245")), ["1245", "", ""]);
const open092: Saved = { rstNo: "2+45", grossGrams: 92_000, katautiUnits: 1, katautiOverride: false };
check("a weight typed by hand (2+45 at 0.92) stays through 2+40 and 1245", [typeKeys(opened(open092), "2+40"), typeKeys(opened(open092), "1245")].map(shown), [["2+40", "0.92", ""], ["1245", "0.92", ""]]);
const openKat: Saved = { rstNo: "2+45", grossGrams: 95_000, katautiUnits: 2, katautiOverride: true };
check("a katauti typed by hand (2) stays in its box through 1245", shown(typeKeys(opened(openKat), "1245")), ["1245", "", "2"]);
check("a 0 typed for a weight that is not the packets' is a typed 0", safe(() => dailyList.katautiBox({ rstNo: "12-43", grossGrams: 1_190_000, katautiUnits: 0, katautiOverride: true })), "0");
check("one rule on both screens (the sheet screen's box uses it too)", safe(() => [
  slipChecks.rstWeight("2+45", "2+40", 95_000), slipChecks.rstWeight("2+45", "1164", 95_000, 1_164_000), slipChecks.rstWeight("2+45", "1245", 95_000),
  slipChecks.rstWeight("2+45", "2+40", 92_000), slipChecks.rstWeight("1245", "2+45", null), slipChecks.rstWeight("1245", "2+45", 1_245_000),
]), [90_000, 1_164_000, null, 92_000, 95_000, 1_245_000]);

console.log("\nWhat the reader is told");
check("the prompt explains loose packets in the RST box", /LOOSE PACKETS/.test(PROMPT) && PROMPT.includes('"2+45"') && PROMPT.includes('"1-64"'), true);
check("  ...kept as written with + or -, never one number", /exactly as written with its "\+" or "-"/.test(PROMPT) && /never join it into one number like 245 or 2745/.test(PROMPT), true);
check("  ...no kanta, no katauti, net in kg as written", /no DHARAM KANTA and no KATAUTI: return null for both/.test(PROMPT) && /NET WEIGHT is written in kilograms/.test(PROMPT), true);
check("  ...every other RST is still digits only", PROMPT.includes("Write it with Latin digits 0-9 only") && /every other RST is digits only/.test(PROMPT), true);
check("  ...the other rules stand", PROMPT.includes("1920 almost certainly means 19.20") && PROMPT.includes("Report what is WRITTEN"), true);
check("the owner's worked example of an ordinary line sits with the decimal rule",
  /1920 almost certainly means 19\.20\.[^\n]*RST 1243, DHARAM KANTA written 1190 means 11\.90 quintal, KATAUTI 12, NET 11\.78/.test(PROMPT), true);

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
/** Reads on the model asked for, or (null) as Settings say: the main model, and its fallback for a weak read. */
async function readSheet(date: string, model: string | null, tag: string) {
  const fd = new FormData();
  fd.append("files", new File([Buffer.concat([PNG, Buffer.from(tag)])], `${tag}.png`, { type: "image/png" }));
  fd.append("slipDate", date);
  fd.append("merchantId", grm.id);
  fd.append("jinsId", j1509.id);
  const { id } = await (await fetch(`${BASE}/scans`, { method: "POST", body: fd, headers: { cookie } })).json() as { id: string };
  await call("POST", `/scans/${id}/run`, model ? { model } : {});
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

/* ------------------------------------------------------------ one read */

/* Loose lines have no dharam kanta by design. A page of them is not a page
   whose weights could not be read: it must not go to the fallback model
   (gemini-2.5-pro by default) for a second, paid read that is thrown away. */
console.log("\nA page of mostly loose lines is read once");
const geminiCalls = async () => (await (await fetch(`${FAKE}/__calls`)).json()) as { model: string }[];
await call("PUT", "/settings/gemini", { model: "gemini-test-loose", fallbackModel: "gemini-test-loose-qtl", backupModels: [] });
let callsBefore = (await geminiCalls()).length;
const once = await readSheet(D_NEXT, null, "loose-once");
check("2 of 3 lines loose, no kanta on them: one read, on the main model", (await geminiCalls()).slice(callsBefore).map((x) => x.model), ["gemini-test-loose"]);
check("  ...the page is as read", once.rows.map((r: any) => [r.rstNo, r.grossGrams]), [["1243", 1_190_000], ["2+45", 95_000], ["1-64", 64_000]]);
await call("DELETE", `/scans/${once.id}`);
await call("PUT", "/settings/gemini", { model: "gemini-test-loose-nokanta", fallbackModel: "gemini-test-loose-qtl", backupModels: [] });
callsBefore = (await geminiCalls()).length;
const noKanta = await readSheet(D_NEXT, null, "loose-nokanta");
check("the truck's own kanta not read: still read again on the fallback", (await geminiCalls()).slice(callsBefore).map((x) => x.model), ["gemini-test-loose-nokanta", "gemini-test-loose-qtl"]);
await call("DELETE", `/scans/${noKanta.id}`);
await call("PUT", "/settings/gemini", { model: "gemini-test-loose", fallbackModel: "gemini-test-loose", backupModels: [] });

/* ------------------------------------------------------------ the sheet */

console.log("\nThe owner's sheet, read (loose nets written in kg: 95, 64)");
const A = await readSheet(D, "gemini-test-loose", "loose-a");
check("three lines read, in order", A.rows.map((r: any) => r.rstNo), ["1243", "2+45", "1-64"]);
check("the RST is kept as written", A.rows.map((r: any) => r.ocr.rstNo), ["1243", "2+45", "1-64"]);
// gross, katauti typed, katauti, net, amount
check("RST 1243: 11.90 − 12 kg = 11.78 qtl, × 3451 = ₹40,652.78", figures(line(A, "1243")), [1_190_000, null, 12, 1_178_000, 4_065_278]);
// no katauti typed: the 0 is the rule for packets at their own weight, as the mill's 12 is for the truck
check("RST 2+45: 95 kg, no katauti, × 3200 = ₹3,040.00", figures(line(A, "2+45")), [95_000, null, 0, 95_000, 304_000]);
check("RST 1-64: 64 kg, no katauti, × 3481 = ₹2,227.84", figures(line(A, "1-64")), [64_000, null, 0, 64_000, 222_784]);
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
check("2+45 stays 95 kg: nothing is guessed", figures(off), [95_000, null, 0, 95_000, 304_000]);
check("  ...the line says why, in one sentence", says(off), ["2+45 is 95 kg; the sheet says 90"]);
check("  ...and waits for a fix or a ✓", [off.issues[0].level, off.blocking], ["error", true]);
check("1243 is already on this day's list; the loose lines are not a repeat", C.rows.map(codes), [["rst_exists"], ["loose_net"], []]);
let c2 = await call("PUT", `/scans/${C.id}/rows`, { rows: C.rows.map((r: any) => r.rstNo === "2+45" ? { ...r, confirmed: ["gross"] } : r), rev: C.rev });
check("✓ 'right as read': a look, no longer a stop", [line(c2, "2+45").issues[0]?.level, line(c2, "2+45").blocking], ["warn", false]);
c2 = await call("PUT", `/scans/${C.id}/rows`, { rows: c2.rows.map((r: any) => r.rstNo === "2+45" ? { ...r, rstNo: "2+40", confirmed: [] } : r), rev: c2.rev });
const fixed = c2.rows.find((r: any) => r.id === off.id);
check("the RST corrected to 2+40: its weight follows (90 kg), the line is clear", [fixed.rstNo, ...figures(fixed), codes(fixed)], ["2+40", 90_000, null, 0, 90_000, 288_000, []]);
const typedOver = await call("PUT", `/scans/${C.id}/rows`, { rows: c2.rows.map((r: any) => r.id === off.id ? { ...r, grossGrams: 92_000 } : r), rev: c2.rev });
const t92 = typedOver.rows.find((r: any) => r.id === off.id);
check("a weight typed over it is kept, with the mill's katauti (1), and said", [t92.grossGrams, t92.derivedKatautiUnits, says(t92)], [92_000, 1, ["2+40 is 90 kg; the weight here is 92 kg"]]);
const twice = await call("PUT", `/scans/${C.id}/rows`, { rows: typedOver.rows.map((r: any) => r.rstNo === "1-64" ? { ...r, rstNo: "2+40" } : r.id === off.id ? { ...r, grossGrams: 90_000 } : r), rev: typedOver.rev });
check("two lines of 2+40 on one sheet: no 'appears twice'", twice.rows.filter((r: any) => r.rstNo === "2+40").map(codes), [[], ["loose_net"]]);
await call("DELETE", `/scans/${C.id}`);

console.log("\nThe sheet misread: '1-64' for RST 1164, '12-43' for 1243");
const M = await readSheet(D_M, "gemini-test-loose-misread", "loose-m");
check("four lines read", M.rows.map((r: any) => r.rstNo), ["1243", "2+45", "1-64", "12-43"]);
const m164 = line(M, "1-64"), m245 = line(M, "2+45"), m1243 = line(M, "12-43");
let m = M;
const edit = async (id: string, change: Record<string, unknown>) => {
  m = await call("PUT", `/scans/${M.id}/rows`, { rows: m.rows.map((r: any) => r.id === id ? { ...r, ...change } : r), rev: m.rev });
  return m.rows.find((r: any) => r.id === id);
};
// nothing read in its net column: the weight is the RST's, so a look, never a stop — and never "this gross"
check("'2+45' with an empty net column: a warning, not a stop", [codes(m245), m245.issues.find((i: any) => i.code === "loose_unchecked")?.level, m245.blocking], [["loose_unchecked"], "warn", false]);
check("  ...said for loose packets", says(m245), ["2+45 is 95 kg of loose packets; no net weight was read beside it"]);
const { STRINGS } = await import("../src/lib/strings.ts");
const { lineState } = await import("../src/components/ScanGrid.tsx");
const words = (lang: "en" | "hi") => ((k: string, v?: Record<string, string | number>) =>
  String((STRINGS[lang] as Record<string, string>)[k] ?? k).replace(/\{(\w+)\}/g, (_, n: string) => String(v?.[n] ?? `{${n}}`))) as never;
const onScreen = (lang: "en" | "hi") => { const st = lineState(m245, words(lang)); return [st.tone, st.flags.map((f) => [f.field, f.flag.level, f.flag.why])]; };
check("  ...on the screen: amber on the weight, in one line", onScreen("en"), ["look", [["gross", "doubt", "2+45 is 95 kg of loose packets; no net weight was read beside it — ✓ if right"]]]);
check("  ...in Hindi too", onScreen("hi"), ["look", [["gross", "doubt", "2+45 यानी 95 किलो खुले पैकेट; बगल में शुद्ध वज़न पढ़ा नहीं गया — सही हो तो ✓"]]]);
check("  ...neither speaks of 'this gross' / dharam kanta", [/gross/i.test(STRINGS.en["issue.loose_unchecked" as never] ?? "gross"), /धर्म कांटा/.test(STRINGS.hi["issue.loose_unchecked" as never] ?? "धर्म कांटा")], [false, false]);
check("  ...✓ as right: the line is clear", codes(await edit(m245.id, { confirmed: ["gross"] })), []);
check("'1-64': 64 kg from the RST box, no katauti; the kanta read (11.64) kept aside", [...figures(m164), m164.ocr.grossQtl], [64_000, null, 0, 64_000, 222_784, 11.64]);
check("  ...and flagged: the sheet's net 11.52 is not 64 kg", codes(m164), ["loose_net"]);
check("'12-43', no weight: 593 kg from the RST box, flagged against the sheet's 11.78", [m1243.grossGrams, m1243.derivedKatautiUnits, codes(m1243)], [593_000, 0, ["loose_net"]]);
const r1164 = await edit(m164.id, { rstNo: "1164" });
check("'1-64' put right to 1164: the kanta read comes back, the mill's katauti 12, net 11.52 = the sheet's",
  [r1164.rstNo, ...figures(r1164), r1164.netAgrees, codes(r1164)], ["1164", 1_164_000, null, 12, 1_152_000, amountPaise(1_152_000, 348_100), true, []]);
const r1245 = await edit(m245.id, { rstNo: "1245" });
check("'2+45' changed to 1245, no kanta read: the 0.95 it put in goes, to be typed", [r1245.grossGrams, r1245.katautiOverride, codes(r1245)], [null, null, ["gross_missing"]]);
const r1243typed = await edit(m1243.id, { grossGrams: 1_190_000 });
check("'12-43' with 11.90 typed: the mill's katauti 12, net 11.78 — never a silent 0",
  [r1243typed.grossGrams, r1243typed.katautiOverride, r1243typed.derivedKatautiUnits, r1243typed.derivedNetGrams], [1_190_000, null, 12, 1_178_000]);
check("  ...and still asked: 12-43 is 593 kg", says(r1243typed), ["12-43 is 593 kg; the sheet says 11.78"]);
const r1243 = await edit(m1243.id, { rstNo: "1243" });
check("  ...the RST put right to 1243: the typed 11.90 stays, katauti 12, net 11.78", [r1243.grossGrams, r1243.derivedKatautiUnits, r1243.derivedNetGrams], [1_190_000, 12, 1_178_000]);
const katSeq: unknown[] = [];
for (const [rst, k] of [["2+45", 1], ["2+40", undefined], ["1240", undefined]] as const) {
  const r = await edit(m245.id, { rstNo: rst, ...(k === undefined ? {} : { katautiOverride: k }) });
  katSeq.push([r.grossGrams, r.katautiOverride]);
}
check("a katauti typed (1) stays as the RST goes 2+45, 2+40, 1240; the weight follows it", katSeq, [[95_000, 1], [90_000, 1], [null, 1]]);
const w2 = await edit(m245.id, { rstNo: "2+40", grossGrams: 92_000, katautiOverride: null });
const w3 = await edit(m245.id, { rstNo: "1240" });
check("a weight typed (0.92) stays through 2+40 and 1240", [w2.grossGrams, w3.grossGrams], [92_000, 92_000]);
// the same keys on both screens: the daily list's weight box and the sheet's line end alike
const SEQ = ["2+45", "2+40", "2+4", "1240"];
const onList = SEQ.map((_, i) => typeKeys({ rstNo: "1240", gross: "", katauti: "" }, ...SEQ.slice(0, i + 1)).gross);
await edit(m245.id, { rstNo: "1240", grossGrams: null, katautiOverride: null });
const onSheet: string[] = [];
for (const rst of SEQ) {
  const g = (await edit(m245.id, { rstNo: rst })).grossGrams;
  onSheet.push(g === null ? "" : (g / 100_000).toFixed(2));
}
check("the RST typed 2+45, 2+40, 2+4, 1240 on the daily list and on the sheet: the same weight each time", [onList, onSheet], [["0.95", "0.90", "0.54", ""], ["0.95", "0.90", "0.54", ""]]);
await call("DELETE", `/scans/${M.id}`);

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
check("2+45 with 0.90 typed: the weight kept, the mill's katauti (1), and flagged", [t90.katautiUnits, t90.netGrams, t90.amountPaise, t90.flags.looseOff], [1, 89_000, 284_800, { rst: "2+45", kg: 95 }]);
const listed = (await call("GET", `/slips?date=${D}&merchantId=${grm.id}`)).rows.find((r: any) => r.id === t90.id);
check("  ...on the list too", [listed.looseOff, listed.rstDay], [{ rst: "2+45", kg: 95 }, 1]);
const put = await call("PUT", `/slips/${t90.id}`, { grossGrams: 95_000 });
check("  ...put right to 0.95: no katauti, the flag goes", [put.katautiUnits, put.netGrams, put.amountPaise, put.flags.looseOff], [0, 95_000, 304_000, null]);
const t1243 = await call("POST", "/slips", { slipDate: D, rstNo: "12-43", adatiId: sup["जय भारत ट्रेडिंग कंपनी"], jinsId: j1509.id, merchantId: grm.id, grossGrams: 1_190_000, ratePaisePerQtl: 345_100 });
check("'12-43' typed with 11.90 (RST 1243, a stray dash): the mill's katauti 12, net 11.78, flagged as not 593 kg",
  [t1243.katautiUnits, t1243.netGrams, t1243.flags.looseOff], [12, 1_178_000, { rst: "12-43", kg: 593 }]);
const reweighed = await call("PUT", `/slips/${typed.id}`, { grossGrams: 90_000 });
check("a 2+45 slip's weight changed to 0.90 (no katauti sent): its 0 goes, the mill's 1", [reweighed.katautiUnits, reweighed.netGrams], [1, 89_000]);
const renumbered = await call("PUT", `/slips/${t64.id}`, { rstNo: "1164", grossGrams: 1_164_000 });
check("a 1-64 slip put right to RST 1164 at 11.64 (no katauti sent): the mill's 12, net 11.52", [renumbered.katautiUnits, renumbered.netGrams], [12, 1_152_000]);
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

for (const id of [...slipsA.map((s) => s.id), typed.id, t64.id, t90.id, t1243.id, old.id, ...(minus.json?.id ? [minus.json.id] : [])]) await call("DELETE", `/slips/${id}`);
sqlite.prepare("delete from scan_batches where id = ?").run(A.id);
fs.rmSync(path.resolve(process.env.MANDI_DATA_DIR!, "scans", A.id), { recursive: true, force: true });
for (const id of Object.values(sup)) await call("DELETE", `/adati/${id}`);
await call("PUT", "/settings/gemini", { model: geminiWas.model, fallbackModel: geminiWas.fallbackModel, backupModels: geminiWas.backupModels });
check("nothing of this script is left", (sqlite.prepare("select count(*) n from purchase_slips where slip_date in (?, ?, ?, ?)").get(D, D_NEXT, D_OLD, D_M) as { n: number }).n
  + (sqlite.prepare("select count(*) n from scan_batches where slip_date in (?, ?, ?, ?)").get(D, D_NEXT, D_OLD, D_M) as { n: number }).n, 0);

console.log(bad === 0 ? "\nLoose packets work end to end." : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
