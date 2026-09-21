import "./_guard.ts";
import ExcelJS from "exceljs";
/* End-to-end: PO -> truck -> mill weighment -> kaccha parcha -> stock, through
 * the HTTP API, on the test database only. The real L.B sheet of 20-09-2026
 * goes into L.B's stock; truck UP25CT5038 takes the mill's 310.74 qtl from it
 * at that day's average rate, and the parcha must be invoice 196 to the paisa,
 * with 20.31 qtl left in stock.  Run through: npm run test:e2e
 */
const BASE = process.env.MANDI_API!;
let cookie = "";
const DAY1 = "2026-09-25"; // its own days, so they never meet the daily-list test's rows
const DAY2 = "2026-09-26";

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
async function status(method: string, path: string, body?: unknown) {
  const res = await raw(method, path, body);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

let bad = 0;
const check = (label: string, ok: boolean, got?: unknown) => {
  if (!ok) bad++;
  console.log(` ${ok ? "PASS" : "FAIL"}  ${label}${got === undefined ? "" : `   ${JSON.stringify(got)}`}`);
};
const codes = (xs: { code: string }[]) => xs.map((x) => x.code).sort();

const users = await call("GET", "/auth/users");
const owner = users.find((u: any) => u.name === "Test Owner");
await call("POST", "/auth/login", { userId: owner.id, pin: process.env.MANDI_PIN ?? "482915" });
const me = await call("GET", "/auth/me");
const vldm = me.businesses.find((b: any) => b.shortCode === "VLDM");
if (vldm && me.activeBusinessId !== vldm.businessId) await call("POST", "/auth/switch-business", { businessId: vldm.businessId });

const mills = await call("GET", "/merchants");
const lb = mills.find((m: any) => m.code === "LB");
const grm = mills.find((m: any) => m.code === "GRM") ?? mills.find((m: any) => m.id !== lb.id);
const jins = await call("GET", "/jins");
const j1509 = jins.find((j: any) => j.code === "1509");
const suppliers = await call("GET", "/adati");
const byHi = new Map(suppliers.map((s: any) => [s.nameHi, s]));
const q = (x: number) => Math.round(x * 100_000);

const SHEET: [string, string, number, number][] = [
  ["630", "सामरा इंटरप्राइजेज", 28.60, 3450], ["634", "शिवम ट्रेडिंग", 41.25, 3550],
  ["635", "शिवम ट्रेडिंग", 35.85, 3400], ["633", "अमित ट्रेडिंग", 26.40, 3521],
  ["636", "राधा चरन ट्रेडिंग", 18.75, 3400], ["639", "राजू संजीव कुमार", 5.70, 3611],
  ["643", "धर्मपाल सिंह", 18.20, 3300], ["648", "रामपाल सिंह यादव", 9.60, 3200],
  ["651", "सूर्य प्रकाश वर्मा", 24.95, 3400], ["652", "राधा चरन ट्रेडिंग", 42.60, 3450],
  ["653", "शिवम ट्रेडिंग", 14.40, 3100], ["662", "राधा चरन ट्रेडिंग", 18.20, 3450],
  ["666", "राधे श्याम एण्ड संस", 49.90, 3350],
];
const slipIds: string[] = [];
for (const [rst, name, gross, rate] of SHEET) {
  const r = await call("POST", "/slips", {
    slipDate: DAY1, rstNo: rst, adatiId: (byHi.get(name) as any).id, jinsId: j1509.id, merchantId: lb.id,
    grossGrams: q(gross), ratePaisePerQtl: rate * 100,
  });
  slipIds.push(r.id);
}
// a second day for L.B: 20.00 qtl gross @ 3500 and 10.00 @ 3300
for (const [rst, gross, rate] of [["700", 20, 3500], ["701", 10, 3300]] as const) {
  await call("POST", "/slips", {
    slipDate: DAY2, rstNo: rst, adatiId: (byHi.get("अमित ट्रेडिंग") as any).id, jinsId: j1509.id, merchantId: lb.id,
    grossGrams: q(gross), ratePaisePerQtl: rate * 100,
  });
}
console.log(`entered the L.B sheet (${SHEET.length} slips) on ${DAY1} and 2 slips on ${DAY2}`);

console.log("\nPurchase orders");
const po = await call("POST", "/orders", { merchantId: lb.id, jinsId: j1509.id, poDate: DAY1, qtyGrams: q(300) });
check("a PO with only a date (no number) is accepted", Boolean(po.id));
const po2 = await call("POST", "/orders", { merchantId: lb.id, jinsId: j1509.id, poDate: DAY2, qtyGrams: q(50) });
check("a second PO without a number for the same mill too", Boolean(po2.id));
const numbered = await call("POST", "/orders", { merchantId: lb.id, jinsId: j1509.id, poNo: "77", poDate: DAY1, qtyGrams: q(10) });
const dupe = await status("POST", "/orders", { merchantId: lb.id, jinsId: j1509.id, poNo: "77", poDate: DAY2, qtyGrams: q(10) });
check("but a PO number is unique per mill", dupe.status === 409 && Boolean(numbered.id), dupe.status);
const noDate = await status("POST", "/orders", { merchantId: lb.id, jinsId: j1509.id, qtyGrams: q(10) });
check("the PO date is required", noDate.status === 400, noDate.json?.error);

console.log("\nTruck UP25CT5038 from L.B's stock of " + DAY1);
const t1 = await call("POST", "/loads", { loadDate: DAY1, merchantId: lb.id, jinsId: j1509.id, stockDate: DAY1, truckNo: "up25 ct-5038" });
let st = await call("GET", `/loads/${t1.id}`);
check("truck number tidied", st.load.truckNo === "UP25CT5038", st.load.truckNo);
check("one row, from " + DAY1 + ", taking the rest of the mill net", st.lines.length === 1 && st.lines[0].stockDate === DAY1 && st.lines[0].weightIsRest);
check("that day's stock: 331.05 qtl bought for L.B", st.lines[0].day.boughtNetGrams === q(331.05), st.lines[0].day.boughtNetGrams);
check("the truck's stock line adds up: bought − others − this = left",
  st.stock.boughtNetGrams - st.stock.otherTrucksGrams - st.stock.thisTruckGrams === st.stock.leftGrams, st.stock);
check("the row's rate is that day's average, 3413.45", st.lines[0].dayAvgRatePaisePerQtl === 341_345, st.lines[0].dayAvgRatePaisePerQtl);
check("waits for mill weight, bags and invoice no", JSON.stringify(codes(st.blockers)) === JSON.stringify(["no_bags", "no_invoice_no", "no_mill_gross"]), codes(st.blockers));
await call("PUT", `/loads/${t1.id}/lines/${st.lines[0].id}`, { poId: po.id });

await call("PUT", `/loads/${t1.id}`, {
  millGrossGrams: q(315.30), katteCount: 800, boreCount: 0,
  advancePaise: 1_000_000, daraPaise: 359_738, invoiceNo: "196", invoiceDate: DAY1,
});
st = await call("GET", `/loads/${t1.id}`);
check("nothing blocks approval", st.blockers.length === 0, st.blockers);
const r = st.doc.result;
check("bardana 800 x 0.57 = 4.56 qtl, net 310.74", st.doc.weights.bardanaGrams === q(4.56) && st.doc.weights.netGrams === q(310.74));
check("the row weighs the mill's 310.74", st.lines[0].weightGrams === q(310.74), st.lines[0].weightGrams);
check("goods 10,60,695.45", r.goodsAmountPaise === 106_069_545, r.goodsAmountPaise);
check("kacchi adat 21,213.91", r.adatPaise === 2_121_391, r.adatPaise);
check("total 11,17,851.22", r.totalPaise === 111_785_122, r.totalPaise);
check("grand total 11,27,851.22", r.grandTotalPaise === 112_785_122, r.grandTotalPaise);
check("parcha row: PO by date prints as 1, rate 3413.45", st.doc.lines[0].po === "1" && st.doc.lines[0].ratePaisePerQtl === 341_345, st.doc.lines[0]);
check("20.31 qtl of " + DAY1 + " stays in stock", st.lines[0].day.leftGrams === q(20.31), st.lines[0].day.leftGrams);
check("flags 10.74 qtl over the 300 qtl PO", st.warnings.some((w: any) => w.code === "po_over" && w.overGrams === q(10.74)), st.warnings);

console.log("\nA second truck: two days, and stock going negative");
const t2 = await call("POST", "/loads", { loadDate: DAY2, merchantId: lb.id, jinsId: j1509.id, stockDate: DAY1 });
let s2 = await call("GET", `/loads/${t2.id}`);
await call("PUT", `/loads/${t2.id}/lines/${s2.lines[0].id}`, { netGrams: q(25) }); // 25 of the 20.31 left: 4.69 below zero
await call("POST", `/loads/${t2.id}/lines`, { stockDate: DAY2 }); // the rest, from day 2
await call("PUT", `/loads/${t2.id}`, { millGrossGrams: q(50.30), katteCount: 100, advancePaise: 0, daraPaise: 0, invoiceNo: "197" });
s2 = await call("GET", `/loads/${t2.id}`);
const [a, b] = s2.lines;
check("mill net 50.30 − 0.57 = 49.73; the blank row takes 24.73", s2.weighment.netGrams === q(49.73) && b.weightGrams === q(24.73), { net: s2.weighment.netGrams, b: b.weightGrams });
check(`day 2 average: (19.80×3500 + 9.90×3300) / 29.70 = 3433.33`, b.dayAvgRatePaisePerQtl === 343_333, b.dayAvgRatePaisePerQtl);
const goods = Math.round(q(25) * 341_345 / 100_000) + Math.round(q(24.73) * 343_333 / 100_000);
check("goods = the two rows' amounts added", s2.doc.totals.goodsPaise === goods && s2.doc.result.goodsAmountPaise === goods, { got: s2.doc.totals.goodsPaise, want: goods });
check("stock of " + DAY1 + " goes 4.69 below zero — allowed, flagged", a.day.leftGrams === -q(4.69) && s2.warnings.some((w: any) => w.code === "stock_negative"), a.day.leftGrams);
check("negative stock does not block approval", !s2.blockers.length, s2.blockers);
// rows must add up to the mill net
await call("PUT", `/loads/${t2.id}/lines/${b.id}`, { netGrams: q(20) });
s2 = await call("GET", `/loads/${t2.id}`);
check("typed rows that do not add up to the mill net block approval", s2.blockers.some((x: any) => x.code === "lines_mismatch"), codes(s2.blockers));
await call("PUT", `/loads/${t2.id}/lines/${b.id}`, { netGrams: null });
await call("PUT", `/loads/${t2.id}/lines/${a.id}`, { netGrams: null });
s2 = await call("GET", `/loads/${t2.id}`);
check("two blank rows block approval (a weight would count twice)", s2.blockers.some((x: any) => x.code === "line_no_weight"), codes(s2.blockers));
await call("PUT", `/loads/${t2.id}/lines/${a.id}`, { netGrams: q(25) });

console.log("\nApprove");
const ap = await call("POST", `/loads/${t1.id}/approve`);
check("approved as parcha 196 v1", ap.parchaNo === "196" && ap.version === 1, ap);
check("grand total frozen", ap.grandTotalPaise === 112_785_122, ap.grandTotalPaise);
st = await call("GET", `/loads/${t1.id}`);
const lockedLine = await status("PUT", `/loads/${t1.id}/lines/${st.lines[0].id}`, { netGrams: q(1) });
check("an approved truck's rows are locked", lockedLine.status === 409, lockedLine.status);
const lockedLoad = await status("PUT", `/loads/${t1.id}`, { truckNo: "X" });
check("the truck is locked too", lockedLoad.status === 409, lockedLoad.status);

// a slip's rate changes after approval: the approved parcha must not move
await call("PUT", `/slips/${slipIds[0]}`, { ratePaisePerQtl: 360_000 });
const reg0 = await call("GET", "/parchas");
check("changing a slip later leaves the approved parcha untouched", reg0.find((p: any) => p.parchaNo === "196").grandTotalPaise === 112_785_122);
await call("PUT", `/slips/${slipIds[0]}`, { ratePaisePerQtl: 345_000 });

const xres = await raw("GET", `/loads/${t1.id}/parcha.xlsx`);
const buf = Buffer.from(await xres.arrayBuffer());
check("Excel downloads", xres.ok && buf.subarray(0, 2).toString() === "PK", xres.status);
const wb = new ExcelJS.Workbook();
await wb.xlsx.load(buf as any);
const values: unknown[] = [];
wb.worksheets[0].eachRow((row) => row.eachCell((c) => values.push(c.value)));
check("Excel carries the grand total 1127851.22 as a number", values.includes(1127851.22));
check("Excel carries truck, invoice no and date", values.includes("UP25CT5038") && values.includes("196") && values.includes("25-09-2026"));

await call("PUT", `/loads/${t2.id}`, { invoiceNo: "196" });
const dup = await status("POST", `/loads/${t2.id}/approve`);
check("invoice 196 cannot be used twice", dup.status === 409 && dup.json.blockers.some((x: any) => x.code === "invoice_taken"), dup.json?.blockers);
await call("PUT", `/loads/${t2.id}`, { invoiceNo: null });
const s2b = await call("GET", `/loads/${t2.id}`);
check("the next number is suggested as 197", s2b.suggestedInvoiceNo === "197", s2b.suggestedInvoiceNo);

console.log("\nVoid and re-approve");
const noReason = await status("POST", `/parchas/${ap.id}/void`, { reason: "" });
check("voiding needs a reason", noReason.status === 400);
await call("POST", `/parchas/${ap.id}/void`, { reason: "advance was 12000, not 10000" });
await call("PUT", `/loads/${t1.id}`, { advancePaise: 1_200_000 });
const ap2 = await call("POST", `/loads/${t1.id}/approve`);
check("re-approved as 196 v2 with the new advance", ap2.parchaNo === "196" && ap2.version === 2 && ap2.grandTotalPaise === 112_785_122 + 200_000, ap2);
const reg = await call("GET", "/parchas");
const mine = reg.filter((p: any) => p.parchaNo === "196");
check("register keeps v1 (void) and v2 (approved)", mine.length === 2 && mine.some((p: any) => p.status === "void") && mine.some((p: any) => p.status === "approved"));

console.log("\nStock and PO, from the rows");
// only this test's two days: the daily-list test put other L.B slips in the same database
const stock = await call("GET", `/stock?jinsId=${j1509.id}&from=${DAY1}&to=${DAY2}`);
const lbStock = stock.find((s: any) => s.merchantId === lb.id);
const bought = q(331.05) + q(19.80) + q(9.90);
const loaded = q(310.74) + q(25) + q(24.73);
check("L.B bought = the sum of its slips", lbStock.boughtNet === bought, lbStock.boughtNet);
check("L.B loaded = the sum of the truck rows", lbStock.loadedNet === loaded, lbStock.loadedNet);
check("left = bought − loaded (can be negative)", lbStock.stockNet === bought - loaded, lbStock.stockNet);
const days = await call("GET", `/stock/${lb.id}?jinsId=${j1509.id}&from=${DAY1}&to=${DAY2}`);
const d1 = days.days.find((d: any) => d.date === DAY1);
check(`${DAY1}: 331.05 − 310.74 − 25.00 = −4.69`, d1.stockNet === -q(4.69), d1.stockNet);
check(`${DAY1}: both trucks are named`, d1.trucks.length === 2, d1.trucks.map((x: any) => x.truckNo));
check("days add up to the mill total", days.totals.stockNet === lbStock.stockNet, days.totals.stockNet);
const orders = await call("GET", "/orders");
const mypo = orders.find((o: any) => o.id === po.id);
check("the PO counts the mill's 310.74 qtl", mypo.sentGrams === q(310.74), mypo.sentGrams);
check("balance shows 10.74 qtl over", mypo.balanceGrams === -q(10.74), mypo.balanceGrams);
const delPo = await status("DELETE", `/orders/${po.id}`);
check("a PO with loads cannot be deleted", delPo.status === 409);

console.log("\nDara (mill report)");
const dara = await call("GET", `/reports/mill?merchantId=${lb.id}&date=${DAY1}&format=json&sort=nameAsc`);
check("13 slips, 331.05 qtl, average 3413.45", dara.totals.count === 13 && dara.totals.netGrams === q(331.05) && dara.totals.avgRatePaisePerQtl === 341_345, dara.totals);
check("sorted by name (Hindi alphabetical)", dara.rows[0].adati === "अमित ट्रेडिंग", dara.rows[0].adati);
const range = await call("GET", `/reports/mill?merchantId=${lb.id}&from=${DAY1}&to=${DAY2}&format=json`);
check("a date range adds the date column and both days' slips", range.columns.includes("date") && range.totals.count === 15, { cols: range.columns, n: range.totals.count });
const xl = await raw("GET", `/reports/mill?merchantId=${lb.id}&date=${DAY1}&format=xlsx`);
check("Dara downloads as Excel", xl.ok && Buffer.from(await xl.arrayBuffer()).subarray(0, 2).toString() === "PK");

const delBilled = await status("DELETE", `/loads/${t1.id}`);
check("an approved truck cannot be deleted", delBilled.status === 409);

console.log(bad === 0 ? "\nLoads, PO, parcha and stock work end to end." : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
