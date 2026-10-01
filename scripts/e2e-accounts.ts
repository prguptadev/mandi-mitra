import "./_guard.ts";
import ExcelJS from "exceljs";
/* End-to-end: supplier ledger and payments, on the test database only.
 * A fresh supplier with hand-worked figures, so every rupee can be checked:
 *   opening 5,000.00
 *   27-09  20.00 gross -> 19.80 net @ 3400        = 67,320.00
 *   27-09  10.50 gross -> 11 katauti -> 10.39 net @ 3450 = 35,845.50
 *   28-09   5.00 gross -> 4.95 net, rate not set yet = 0
 *   27-09  paid 50,000.00 cash;  28-09 paid 30,000.00 UPI
 *   balance = 5,000 + 67,320 + 35,845.50 − 50,000 − 30,000 = 28,165.50 to pay
 * Run through: npm run test:e2e
 */
const BASE = process.env.MANDI_API!;
let cookie = "";

async function raw(method: string, path: string, body?: unknown) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sc = res.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0];
  return res;
}
async function call(method: string, path: string, body?: unknown) {
  const res = await raw(method, path, body);
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
}
let bad = 0;
const check = (label: string, ok: boolean, got?: unknown) => {
  if (!ok) bad++;
  console.log(` ${ok ? "PASS" : "FAIL"}  ${label}${got === undefined ? "" : `   ${JSON.stringify(got)}`}`);
};
const rs = (x: number) => Math.round(x * 100);

const users = await call("GET", "/auth/users");
const owner = users.find((u: any) => u.name === "Test Owner");
await call("POST", "/auth/login", { userId: owner.id, pin: process.env.MANDI_PIN ?? "482915" });
const me = await call("GET", "/auth/me");
const vldm = me.businesses.find((b: any) => b.shortCode === "VLDM");
if (vldm && me.activeBusinessId !== vldm.businessId) await call("POST", "/auth/switch-business", { businessId: vldm.businessId });

const jins = await call("GET", "/jins");
const j1509 = jins.find((j: any) => j.code === "1509");
const mills = await call("GET", "/merchants");
const lb = mills.find((m: any) => m.code === "LB");
const sup = await call("POST", "/adati", { nameHi: "खाता जाँच ट्रेडर्स", openingBalanceRupees: 5000 });
const A = sup.id;

const slip = (slipDate: string, rstNo: string, grossQtl: number, rate: number) => call("POST", "/slips", {
  slipDate, rstNo, adatiId: A, jinsId: j1509.id, merchantId: lb.id, grossGrams: Math.round(grossQtl * 100_000), ratePaisePerQtl: rate * 100,
});
const s1 = await slip("2026-09-27", "801", 20.00, 3400);
const s2 = await slip("2026-09-27", "802", 10.50, 3450);
const s3 = await slip("2026-09-28", "803", 5.00, 0);
check("20.00 gross -> 19.80 net, 67,320.00", s1.netGrams === 1_980_000 && s1.amountPaise === rs(67320), { net: s1.netGrams, amt: s1.amountPaise });
check("10.50 gross rounds up to 11 katauti -> 10.39 net, 35,845.50", s2.katautiUnits === 11 && s2.netGrams === 1_039_000 && s2.amountPaise === rs(35845.50), s2);
check("a slip with no rate yet is worth 0 until priced", s3.amountPaise === 0 && s3.payablePaise === 0 && s3.commissionPaise === 0 && s3.gaushalaPaise === 0, s3);

/* What the supplier adds (Settings default: commission 1 % of the amount,
   gaushala ₹1.25 a quintal of net weight), each half up to the paisa:
     slip 801: 67,320.00 + 673.20 + 24.75 (19.80 × 1.25)            = 68,017.95
     slip 802: 35,845.50 + 358.46 (358.455) + 12.99 (10.39 × 1.25 = 12.9875) = 36,216.95 */
console.log("\nSupplier charges");
check("801: commission 673.20, gaushala 24.75, net amount 68,017.95", s1.commissionPaise === 67320 && s1.gaushalaPaise === 2475 && s1.payablePaise === rs(68017.95), s1);
check("802: commission 358.46, gaushala 12.99, net amount 36,216.95", s2.commissionPaise === 35846 && s2.gaushalaPaise === 1299 && s2.payablePaise === rs(36216.95), s2);
const day = await call("GET", `/slips?date=2026-09-27`);
const mine = day.rows.filter((r: any) => r.adatiId === A);
check("the daily list carries the same figures", mine.reduce((x: number, r: any) => x + r.payablePaise, 0) === rs(68017.95 + 36216.95));
check("every row of the day adds up (net amount = amount + commission + gaushala)",
  day.rows.every((r: any) => r.payablePaise === r.amountPaise + r.commissionPaise + r.gaushalaPaise && r.reconciles));
check("the day's totals are the sums of its rows",
  day.totals.payablePaise === day.rows.reduce((x: number, r: any) => x + r.payablePaise, 0)
  && day.totals.commissionPaise === day.rows.reduce((x: number, r: any) => x + r.commissionPaise, 0)
  && day.totals.payablePaise === day.totals.amountPaise + day.totals.commissionPaise + day.totals.gaushalaPaise, day.totals);

console.log("\nPayments");
const bad0 = await raw("POST", "/payments", { adatiId: A, payDate: "2026-09-27", amountPaise: 0 });
check("a zero payment is refused", bad0.status === 400);
const badNoDate = await raw("POST", "/payments", { adatiId: A, amountPaise: 100 });
check("a payment needs a date", badNoDate.status === 400);
const badNeg = await raw("POST", "/payments", { adatiId: A, payDate: "2026-09-27", amountPaise: -500 });
check("a negative payment is refused", badNeg.status === 400);
const p1 = await call("POST", "/payments", { adatiId: A, payDate: "2026-09-27", amountPaise: rs(50000), mode: "cash" });
const p2 = await call("POST", "/payments", { adatiId: A, payDate: "2026-09-28", amountPaise: rs(30000), mode: "upi", reference: "UTR123" });

console.log("\nLedger");
let list = await call("GET", "/ledger");
let row = list.rows.find((r: any) => r.id === A);
check("balance = 5,000 + 68,017.95 + 36,216.95 − 50,000 − 30,000 = 29,234.90", row.balancePaise === rs(29234.90), row.balancePaise);
check("purchases 1,04,234.90 over 3 slips, 1 without a rate", row.purchasesPaise === rs(104234.90) && row.slips === 3 && row.unpriced === 1, row);
check("…made of amount 1,03,165.50 + commission 1,031.66 + gaushala 37.74",
  row.goodsPaise === rs(103165.50) && row.commissionPaise === 103166 && row.gaushalaPaise === 3774 && row.goodsPaise + row.commissionPaise + row.gaushalaPaise === row.purchasesPaise, row);
const sum = list.rows.reduce((s: number, r: any) => s + r.balancePaise, 0);
check("the list's total is the sum of its rows", list.totals.balancePaise === sum);
check("opening + purchases − payments = total balance", list.totals.openingPaise + list.totals.purchasesPaise - list.totals.paymentsPaise === list.totals.balancePaise);

let st = await call("GET", `/ledger/${A}`);
check("statement starts from the opening 5,000.00", st.broughtForwardPaise === rs(5000));
check("entries in date order, purchases before payments within a day",
  st.entries.map((e: any) => `${e.date}:${e.kind[1]}`).join(" ") === "2026-09-27:u 2026-09-27:u 2026-09-27:a 2026-09-28:u 2026-09-28:a",
  st.entries.map((e: any) => `${e.date}:${e.kind}`));
const runs = st.entries.map((e: any) => e.balancePaise);
check("running balance: 73,017.95 → 1,09,234.90 → 59,234.90 → 59,234.90 → 29,234.90",
  JSON.stringify(runs) === JSON.stringify([rs(73017.95), rs(109234.90), rs(59234.90), rs(59234.90), rs(29234.90)]), runs.map((x: number) => x / 100));
const p801 = st.entries.find((e: any) => e.rstNo === "801");
check("the statement shows 801 as 67,320.00 + 673.20 + 24.75 = 68,017.95",
  p801.goodsPaise === rs(67320) && p801.commissionPaise === 67320 && p801.gaushalaPaise === 2475 && p801.creditPaise === rs(68017.95), p801);
check("statement totals: amount + commission + gaushala = purchases",
  st.totals.goodsPaise + st.totals.commissionPaise + st.totals.gaushalaPaise === st.totals.purchasesPaise, st.totals);
check("closing matches the list", st.totals.closingPaise === row.balancePaise);

st = await call("GET", `/ledger/${A}?from=2026-09-28`);
check("from 28-09: brought forward 59,234.90", st.broughtForwardPaise === rs(59234.90), st.broughtForwardPaise);
check("from 28-09: two entries, closing still 29,234.90", st.entries.length === 2 && st.totals.closingPaise === rs(29234.90));
st = await call("GET", `/ledger/${A}?to=2026-09-27`);
check("to 27-09: closing 59,234.90", st.totals.closingPaise === rs(59234.90), st.totals.closingPaise);
const asOf = await call("GET", "/ledger?asOf=2026-09-27");
check("list as of 27-09 agrees", asOf.rows.find((r: any) => r.id === A).balancePaise === rs(59234.90));

console.log("\nEdit, delete, overpay, price a slip");
await call("PUT", `/payments/${p2.id}`, { amountPaise: rs(32000) });
row = (await call("GET", "/ledger")).rows.find((r: any) => r.id === A);
check("editing 30,000 → 32,000 lowers the balance by 2,000", row.balancePaise === rs(27234.90), row.balancePaise);
const noWhy = await raw("POST", `/payments/${p2.id}/void`, { reason: "" });
check("cancelling a payment needs a reason", noWhy.status === 400);
await call("POST", `/payments/${p2.id}/void`, { reason: "paid twice by mistake" });
row = (await call("GET", "/ledger")).rows.find((r: any) => r.id === A);
check("cancelling it puts 32,000 back", row.balancePaise === rs(59234.90), row.balancePaise);
check("a cancelled payment cannot be edited", (await raw("PUT", `/payments/${p2.id}`, { amountPaise: 1 })).status === 409);
const stV = await call("GET", `/ledger/${A}`);
check("…but stays on the statement, struck, counting nothing", stV.entries.some((e: any) => e.id === p2.id && e.voided && e.debitPaise === 0));
const withVoid = await call("GET", `/payments?adatiId=${A}&showVoid=1`);
check("the payments list shows it only when asked", withVoid.rows.some((p: any) => p.id === p2.id && p.voidedAt));
const p3 = await call("POST", "/payments", { adatiId: A, payDate: "2026-09-29", amountPaise: rs(60000), mode: "bank" });
list = await call("GET", "/ledger");
row = list.rows.find((r: any) => r.id === A);
check("paying 60,000 against 59,234.90 leaves 765.10 paid ahead", row.balancePaise === -rs(765.10), row.balancePaise);
check("paid-ahead total includes it", list.totals.paidAheadPaise >= rs(765.10));
await call("PUT", `/slips/${s3.id}`, { ratePaisePerQtl: 350_000 });
row = (await call("GET", "/ledger")).rows.find((r: any) => r.id === A);
// 4.95 × 3,500 = 17,325.00 + commission 173.25 + gaushala 6.19 (6.1875) = 17,504.44
check("pricing the 4.95 qtl slip at 3500 adds 17,325.00 + 173.25 + 6.19 = 17,504.44", row.balancePaise === -rs(765.10) + rs(17504.44), row.balancePaise);

console.log("\nChanging the supplier charges in Settings");
const was = await call("GET", "/settings/supplier-charges");
check("the defaults are 1 % and ₹1.25 a quintal", was.commissionPct === 1 && was.gaushalaPerQtl === 1.25, was);
await call("PUT", "/settings/supplier-charges", { ...was, commissionPct: 2, gaushalaPerQtl: 1, labels: { ...was.labels, payable: "Payable" } });
const s4 = await slip("2026-09-29", "804", 10.00, 3000); // 9.90 net × 3,000 = 29,700.00
check("a new slip takes the new terms: 2 % = 594.00, ₹1 × 9.90 = 9.90, net 30,303.90",
  s4.commissionPaise === rs(594) && s4.gaushalaPaise === rs(9.90) && s4.payablePaise === rs(30303.90), s4);
const old801 = (await call("GET", `/ledger/${A}`)).entries.find((e: any) => e.rstNo === "801");
check("an old slip keeps the terms it was made with (68,017.95)", old801.creditPaise === rs(68017.95), old801.creditPaise);
check("the column name is changed", (await call("GET", "/settings/supplier-charges")).labels.payable === "Payable");
await call("PUT", `/slips/${s4.id}`, { ratePaisePerQtl: 310_000 }); // 9.90 × 3,100 = 30,690.00
const s4b = (await call("GET", "/slips?date=2026-09-29")).rows.find((r: any) => r.id === s4.id);
check("re-pricing it keeps its own terms: 613.80 + 9.90 = 31,313.70", s4b.commissionPaise === rs(613.80) && s4b.payablePaise === rs(31313.70) && s4b.reconciles, s4b);
check("a bad rate is refused", (await raw("PUT", "/settings/supplier-charges", { ...was, commissionPct: -1 })).status === 400);
await call("DELETE", `/slips/${s4.id}`);
await call("PUT", "/settings/supplier-charges", was);
check("back to 1 % and ₹1.25", (await call("GET", "/settings/supplier-charges")).commissionPct === 1);

console.log("\nChange a slip's commodity");
const other = jins.find((j: any) => j.id !== j1509.id);
const balBefore = (await call("GET", "/ledger")).rows.find((r: any) => r.id === A).balancePaise;
const mv = await call("POST", "/slips/set-jins", { slipIds: [s1.id, s2.id], jinsId: other.id });
check("two slips moved to the other commodity", mv.updated === 2, mv);
const inOther = await call("GET", `/slips?date=2026-09-27&jinsId=${other.id}`);
check("the list filtered by that commodity shows them", inOther.rows.filter((r: any) => r.adatiId === A).length === 2, inOther.rows.length);
const in1509 = await call("GET", `/slips?date=2026-09-27&jinsId=${j1509.id}`);
check("…and 1509 no longer does", in1509.rows.filter((r: any) => r.adatiId === A).length === 0);
const s1now = inOther.rows.find((r: any) => r.id === s1.id);
check("weight and amount do not change with the commodity", s1now.netGrams === 1_980_000 && s1now.amountPaise === rs(67320), s1now);
check("the supplier's balance does not change either", (await call("GET", "/ledger")).rows.find((r: any) => r.id === A).balancePaise === balBefore);
check("an unknown commodity is refused", (await raw("POST", "/slips/set-jins", { slipIds: [s1.id], jinsId: "nope" })).status === 400);
check("moving to the same commodity again changes nothing", (await call("POST", "/slips/set-jins", { slipIds: [s1.id], jinsId: other.id })).updated === 0);
await call("PUT", `/slips/${s2.id}`, { jinsId: j1509.id });
check("one slip changed back on its own", (await call("GET", `/slips?date=2026-09-27&jinsId=${j1509.id}`)).rows.some((r: any) => r.id === s2.id));
await call("POST", "/slips/set-jins", { slipIds: [s1.id], jinsId: j1509.id });

const pays = await call("GET", `/payments?adatiId=${A}`);
check("payments list: 2 left (the cancelled one hidden), 1,10,000 in all", pays.rows.length === 2 && pays.totals.amountPaise === rs(110000), pays.totals);
check("split by mode: cash 50,000, bank 60,000", pays.totals.byMode.cash === rs(50000) && pays.totals.byMode.bank === rs(60000), pays.totals.byMode);
void p1; void p3;
const del = await call("DELETE", `/adati/${A}`);
check("a supplier with payments is made inactive, not deleted", del.deactivated === true, del);
const still = (await call("GET", "/ledger")).rows.find((r: any) => r.id === A);
check("…and stays on the ledger with its balance", Boolean(still) && still.balancePaise === -rs(765.10) + rs(17504.44), still?.balancePaise);

/* The pay sheet downloaded from the ledger, on a day of its own (30-09):
 *   पर्ची जाँच भंडार  811  10.00 gross -> 9.90 net @ 3000 = 29,700.00 + 297.00 + 12.38 (12.375) = 30,009.38
 *                    812   5.00 gross -> 4.95 net, no rate yet = 0
 *   शून्य जाँच ट्रेडर्स 813   4.00 gross -> 3.96 net @ 3000 = 11,880.00 + 118.80 + 4.95 = 12,003.75, paid in full that day
 * Every figure on the sheet must be the ledger's own. */
console.log("\nSupplier pay sheet (ledger download)");
const PD = "2026-09-30";
const sp = await call("POST", "/adati", { nameHi: "पर्ची जाँच भंडार", nameHinglish: "Parchi Jaanch Bhandar", village: "Rampur", villageHi: "रामपुर" });
const sq = await call("POST", "/adati", { nameHi: "शून्य जाँच ट्रेडर्स", nameHinglish: "Shunya Jaanch Traders" });
const slipOf = (adatiId: string, rstNo: string, grossQtl: number, rate: number) => call("POST", "/slips", {
  slipDate: PD, rstNo, adatiId, jinsId: j1509.id, merchantId: lb.id, grossGrams: Math.round(grossQtl * 100_000), ratePaisePerQtl: rate * 100,
});
const p811 = await slipOf(sp.id, "811", 10.00, 3000);
await slipOf(sp.id, "812", 5.00, 0);
const q813 = await slipOf(sq.id, "813", 4.00, 3000);
check("811 is 30,009.38 and 813 is 12,003.75", p811.payablePaise === rs(30009.38) && q813.payablePaise === rs(12003.75), { p811: p811.payablePaise, q813: q813.payablePaise });
await call("POST", "/payments", { adatiId: sq.id, payDate: PD, amountPaise: q813.payablePaise, mode: "cash" });

const ledgerOn = await call("GET", `/ledger?asOf=${PD}`);
// the names as the ledger has them; every check below looks a supplier up by them
const spL = ledgerOn.rows.find((r: any) => r.id === sp.id);
const sqL = ledgerOn.rows.find((r: any) => r.id === sq.id);
check("both suppliers are on the ledger, named in Hindi and Hinglish",
  spL?.nameHi === "पर्ची जाँच भंडार" && spL.nameHinglish === "PARCHI JAANCH BHANDAR" && sqL?.nameHi === "शून्य जाँच ट्रेडर्स",
  { p: spL && [spL.nameHi, spL.nameHinglish], q: sqL?.nameHi });
const till = await call("GET", `/ledger/sheet?mode=till&date=${PD}&format=json`);
check("till date: the sheet's to-pay total is the ledger's own to-pay total", till.totals.toPayPaise === ledgerOn.totals.toPayPaise,
  { sheet: till.totals.toPayPaise, ledger: ledgerOn.totals.toPayPaise });
check("…one row for every supplier with something to pay, largest first",
  till.rows.length === ledgerOn.rows.filter((r: any) => r.balancePaise > 0).length
  && till.rows.every((r: any, i: number, a: any[]) => r.toPayPaise > 0 && (i === 0 || a[i - 1].toPayPaise >= r.toPayPaise)), till.rows.length);
const tillP = till.rows.find((r: any) => r.nameHi === spL.nameHi);
check("…the supplier owed 30,009.38 is on it, with 2 slips, 14.85 qtl, 1 without a rate",
  tillP?.toPayPaise === rs(30009.38) && tillP.slips === 2 && tillP.netGrams === 1_485_000 && tillP.unpriced === 1
  && tillP.goodsPaise + tillP.commissionPaise + tillP.gaushalaPaise === tillP.payablePaise, tillP);
check("a supplier with nothing to pay is not on the till-date sheet",
  ledgerOn.rows.find((r: any) => r.id === sq.id)?.balancePaise === 0 && !till.rows.some((r: any) => r.nameHi === sqL.nameHi));
const before = await call("GET", `/ledger/sheet?mode=till&date=2026-09-29&format=json`);
check("till the day before, neither of them is on it", !before.rows.some((r: any) => r.nameHi === spL.nameHi || r.nameHi === sqL.nameHi)
  && before.totals.toPayPaise === (await call("GET", "/ledger?asOf=2026-09-29")).totals.toPayPaise);

const daySlips = await call("GET", `/slips?date=${PD}`);
const oneDay = await call("GET", `/ledger/sheet?mode=day&date=${PD}&format=json`);
check("one day: the sheet's payable total is the sum of that day's slips' payable",
  oneDay.totals.payablePaise === daySlips.rows.reduce((s: number, r: any) => s + r.payablePaise, 0) && oneDay.totals.payablePaise === daySlips.totals.payablePaise,
  { sheet: oneDay.totals.payablePaise, slips: daySlips.totals.payablePaise });
check("…and its slips and weight are that day's", oneDay.totals.slips === daySlips.rows.length && oneDay.totals.netGrams === daySlips.totals.netGrams,
  { slips: oneDay.totals.slips, net: oneDay.totals.netGrams });
const dayQ = oneDay.rows.find((r: any) => r.nameHi === sqL.nameHi);
check("…the supplier paid in full that day is on it: 12,003.75 bought, 0 to pay at the day's end",
  dayQ?.payablePaise === rs(12003.75) && dayQ.paidPaise === rs(12003.75) && dayQ.toPayPaise === 0, dayQ);
const dayP = oneDay.rows.find((r: any) => r.nameHi === spL.nameHi);
check("an unpriced slip: its 4.95 qtl is counted, its money is 0",
  dayP?.slips === 2 && dayP.unpriced === 1 && dayP.netGrams === 990_000 + 495_000 && dayP.payablePaise === rs(30009.38) && dayP.toPayPaise === rs(30009.38), dayP);
check("…and the sheet counts it", oneDay.totals.unpriced === daySlips.totals.ratePendingRows && oneDay.totals.unpriced >= 1, oneDay.totals.unpriced);

/* The files themselves: Excel read back cell by cell, CSV parsed by hand. */
const ALL = "name,net,goods,commission,gaushala,paid,toPay";
const fileOf = async (q: string) => {
  const res = await raw("GET", `/ledger/sheet?${q}`);
  if (!res.ok) throw new Error(`/ledger/sheet?${q} -> ${res.status} ${await res.text()}`);
  return { res, buf: Buffer.from(await res.arrayBuffer()) };
};
const xlsxRows = async (buf: Buffer) => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as any);
  const out: unknown[][] = [];
  wb.worksheets[0].eachRow({ includeEmpty: true }, (row, n) => { out[n - 1] = (row.values as unknown[]).slice(1); });
  return out;
};
const csvRows = (text: string) => {
  const out: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) { if (ch === '"' && s[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch; }
    else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell.replace(/\r$/, "")); out.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  row.push(cell); out.push(row);
  return out;
};
const totalRow = (rows: unknown[][]) => rows.find((r) => typeof r?.[0] === "string" && (r[0] as string).startsWith("Total ("))!;
const header = (rows: unknown[][]) => rows.find((r) => r?.includes("To pay") || r?.includes("To pay (end of day)") || r?.some((v) => String(v ?? "").startsWith("Adati name")))!;

const hiX = await fileOf(`mode=till&date=${PD}&names=hi&cols=${ALL}&format=xlsx`);
check("the till-date sheet downloads as Excel", hiX.res.headers.get("content-type")?.includes("spreadsheetml") === true && hiX.buf.subarray(0, 2).toString() === "PK"
  && /pay-sheet-till-2026-09-30\.xlsx/.test(hiX.res.headers.get("content-disposition") ?? ""), hiX.res.headers.get("content-disposition"));
const hiRows = await xlsxRows(hiX.buf);
check("its head: the business, 'Supplier pay sheet — till 30-09-2026', and when it was made",
  String(hiRows[0]?.[0] ?? "").length > 0 && hiRows[1]?.[0] === "Supplier pay sheet — till 30-09-2026" && /^Made on \d{2}-\d{2}-\d{4} \d{2}:\d{2}$/.test(String(hiRows[2]?.[0])),
  hiRows.slice(0, 3).map((r) => r?.[0]));
const hiHead = header(hiRows);
check("Hindi names: one name column, in Hindi", hiHead[0] === "Adati name" && hiHead[1] === "Net weight (qtl)" && hiRows.some((r) => r?.[0] === spL.nameHi), hiHead);
const hiTotal = totalRow(hiRows);
check("…its total row: to pay = the ledger's to-pay total", hiTotal[0] === `Total (${till.totals.count})` && hiTotal[hiHead.indexOf("To pay")] === ledgerOn.totals.toPayPaise / 100,
  { total: hiTotal, ledger: ledgerOn.totals.toPayPaise / 100 });
check("…net weight in quintals, the unpriced slip's weight counted in it", hiTotal[hiHead.indexOf("Net weight (qtl)")] === Math.round(till.totals.netGrams / 1000) / 100);
check("…and a line under it says how many slips have no rate yet",
  hiRows.some((r) => typeof r?.[0] === "string" && (r[0] as string).startsWith(`${till.totals.unpriced} slip(s) have no rate yet`)), till.totals.unpriced);

const enX = await xlsxRows((await fileOf(`mode=till&date=${PD}&names=hinglish&cols=${ALL}&format=xlsx`)).buf);
check("Hinglish names: one name column, in Hinglish",
  header(enX)[0] === "Adati name" && enX.some((r) => r?.[0] === spL.nameHinglish) && !enX.some((r) => r?.[0] === spL.nameHi), spL.nameHinglish);
const bothX = await fileOf(`mode=till&date=${PD}&names=both&cols=${ALL}&format=xlsx`);
const bothRows = await xlsxRows(bothX.buf);
const bothHead = header(bothRows);
check("both: two name columns, Hindi then Hinglish",
  bothHead[0] === "Adati name (Hindi)" && bothHead[1] === "Adati name (Hinglish)" && bothRows.some((r) => r?.[0] === spL.nameHi && r[1] === spL.nameHinglish), bothHead.slice(0, 2));
const onlyFew = await xlsxRows((await fileOf(`mode=till&date=${PD}&names=hi&cols=net,toPay&format=xlsx`)).buf);
check("only the columns asked for, and the name always", JSON.stringify(header(onlyFew)) === JSON.stringify(["Adati name", "Net weight (qtl)", "To pay"]), header(onlyFew));

const csvF = await fileOf(`mode=till&date=${PD}&names=both&cols=${ALL}&format=csv`);
const csv = csvRows(csvF.buf.toString("utf8"));
check("the CSV downloads and parses: the same header, one row per supplier",
  csvF.res.headers.get("content-type")?.startsWith("text/csv") === true && JSON.stringify(header(csv)) === JSON.stringify(bothHead)
  && csv.filter((r) => r[0] === spL.nameHi).length === 1 && csv.indexOf(totalRow(csv)) - csv.indexOf(header(csv)) - 1 === till.rows.length, header(csv));
const csvTotal = totalRow(csv);
const xlTotal = totalRow(bothRows);
check("…its totals are the Excel's, column by column",
  csvTotal[0] === xlTotal[0] && bothHead.every((_, i) => i < 2 || (csvTotal[i] === "" ? xlTotal[i] == null : Number(csvTotal[i]) === xlTotal[i])),
  { csv: csvTotal, xlsx: xlTotal });
check("…to pay to the paisa: the ledger's total", csvTotal[bothHead.indexOf("To pay")] === (ledgerOn.totals.toPayPaise / 100).toFixed(2), csvTotal[bothHead.indexOf("To pay")]);

const dayX = await xlsxRows((await fileOf(`mode=day&date=${PD}&names=hi&cols=${ALL}&format=xlsx`)).buf);
const dayHead = header(dayX);
const dayTot = totalRow(dayX);
const cell = (label: string) => Number(dayTot[dayHead.findIndex((h) => String(h).startsWith(label))] ?? NaN);
check("the one-day Excel: '30-09-2026', and amount + commission + gaushala is the day's slips' payable",
  dayX[1]?.[0] === "Supplier pay sheet — 30-09-2026"
  && Math.round((cell("Amount") + cell(dayHead[dayHead.indexOf("Amount") + 1] as string) + cell(dayHead[dayHead.indexOf("Amount") + 2] as string)) * 100) === daySlips.totals.payablePaise,
  { title: dayX[1]?.[0], total: dayTot, payable: daySlips.totals.payablePaise });
check("…with the unpriced slips noted", dayX.some((r) => typeof r?.[0] === "string" && (r[0] as string).startsWith(`${oneDay.totals.unpriced} slip(s) have no rate yet`)));
check("a date is needed", (await raw("GET", "/ledger/sheet?mode=day&format=json")).status === 400);
check("…and it must be a real day", (await raw("GET", "/ledger/sheet?mode=till&date=2026-02-31&format=json")).status === 400);
check("the CSV starts with the mark that tells Excel it is UTF-8 (Hindi stays Hindi)", csvF.buf[0] === 0xef && csvF.buf[1] === 0xbb && csvF.buf[2] === 0xbf);

/* Paid ahead on the day: money to recover, never a minus inside "To pay". */
const ahead = await call("POST", "/adati", { nameHi: "अग्रिम जाँच भंडार", nameHinglish: "Agrim Jaanch Bhandar" });
const a821 = await slipOf(ahead.id, "821", 3.00, 3000);
await call("POST", "/payments", { adatiId: ahead.id, payDate: PD, amountPaise: a821.payablePaise + rs(1000), mode: "cash" });
const day2 = await call("GET", `/ledger/sheet?mode=day&date=${PD}&format=json`);
const aheadRow = day2.rows.find((r: any) => r.nameHi === "अग्रिम जाँच भंडार");
const ledger2 = await call("GET", `/ledger?asOf=${PD}`);
const owedOnSheet = ledger2.rows.filter((r: any) => day2.rows.some((x: any) => x.nameHi === r.nameHi) && r.balancePaise > 0).reduce((s: number, r: any) => s + r.balancePaise, 0);
check("one day: a supplier paid ahead shows 0 to pay, not a minus", aheadRow?.toPayPaise === 0, aheadRow?.toPayPaise);
check("…the to-pay total is only what is really owed", day2.totals.toPayPaise === owedOnSheet, { sheet: day2.totals.toPayPaise, owed: owedOnSheet });
check("…and the advance is named under the total", day2.notes.some((n: string) => n.startsWith("Paid ahead") && n.includes("अग्रिम जाँच भंडार") && n.includes("1,000.00")), day2.notes);

/* Two suppliers whose Hinglish names come out the same are told apart by village. */
const r1 = await call("POST", "/adati", { nameHi: "राम लाल जाँच", nameHinglish: "Ram Lal Jaanch", village: "Etah", villageHi: "एटा" });
const r2 = await call("POST", "/adati", { nameHi: "रामलाल जाँच", nameHinglish: "Ram Lal Jaanch", village: "Nagla", villageHi: "नगला" });
await slipOf(r1.id, "831", 2.00, 3000);
await slipOf(r2.id, "832", 3.00, 3000);
const twin = await call("GET", `/ledger/sheet?mode=till&date=${PD}&names=hinglish&format=json`);
const latin = twin.rows.map((r: any) => r.nameLatin).filter((n: string) => n.startsWith("RAM LAL JAANCH"));
check("two RAM LAL JAANCHs on a Hinglish sheet carry their village", latin.includes("RAM LAL JAANCH (Etah)") && latin.includes("RAM LAL JAANCH (Nagla)"), latin);

/* An opening balance gets its own column, so the row adds up to "to pay". */
const op = await call("POST", "/adati", { nameHi: "पुराना जाँच भंडार", nameHinglish: "Purana Jaanch Bhandar", openingBalanceRupees: 5000 });
await slipOf(op.id, "841", 1.00, 3000);
const opX = await xlsxRows((await fileOf(`mode=till&date=${PD}&names=hi&cols=${ALL}&format=xlsx`)).buf);
const opHead = header(opX);
const opRow = opX.find((r) => r?.[0] === "पुराना जाँच भंडार")!;
const at = (label: string) => Number(opRow[opHead.findIndex((h) => String(h).startsWith(label))] ?? 0);
const comm = Number(opRow[opHead.indexOf("Amount") + 1]), gau = Number(opRow[opHead.indexOf("Amount") + 2]);
check("an opening balance gets its own column on the till-date sheet", opHead.includes("Opening balance"), opHead);
check("…and the row adds up: opening + amount + commission + gaushala − paid = to pay",
  Math.round((at("Opening balance") + at("Amount") + comm + gau - at("Paid")) * 100) === Math.round(at("To pay") * 100), opRow);

console.log(bad === 0 ? "\nLedger and payments add up." : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
