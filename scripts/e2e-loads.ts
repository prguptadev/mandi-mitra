import "./_guard.ts";
import ExcelJS from "exceljs";
/* End-to-end: PO -> load -> mill weighment -> kaccha parcha, through the HTTP
 * API, on the test database only. Sends the real L.B sheet of 20-09-2026 as
 * truck UP25CT5038 and asserts the parcha is invoice 196 to the paisa.
 * Run through: npm run test:e2e
 */
const BASE = process.env.MANDI_API!;
let cookie = "";
const DATE = "2026-09-25"; // its own day, so it never meets the daily-list test's rows

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
const j1121 = jins.find((j: any) => j.code === "1121");
const suppliers = await call("GET", "/adati");
const byHi = new Map(suppliers.map((s: any) => [s.nameHi, s]));

const SHEET: [string, string, number, number][] = [
  ["630", "सामरा इंटरप्राइजेज", 28.60, 3450], ["634", "शिवम ट्रेडिंग", 41.25, 3550],
  ["635", "शिवम ट्रेडिंग", 35.85, 3400], ["633", "अमित ट्रेडिंग", 26.40, 3521],
  ["636", "राधा चरन ट्रेडिंग", 18.75, 3400], ["639", "राजू संजीव कुमार", 5.70, 3611],
  ["643", "धर्मपाल सिंह", 18.20, 3300], ["648", "रामपाल सिंह यादव", 9.60, 3200],
  ["651", "सूर्य प्रकाश वर्मा", 24.95, 3400], ["652", "राधा चरन ट्रेडिंग", 42.60, 3450],
  ["653", "शिवम ट्रेडिंग", 14.40, 3100], ["662", "राधा चरन ट्रेडिंग", 18.20, 3450],
  ["666", "राधे श्याम एण्ड संस", 49.90, 3350],
];
const q = (x: number) => Math.round(x * 100_000);
const slipIds: string[] = [];
for (const [rst, name, gross, rate] of SHEET) {
  const s = byHi.get(name) as any;
  // RST 634 was on the G.R.M sheet and went on the L.B truck
  const merchantId = rst === "634" ? grm.id : lb.id;
  const r = await call("POST", "/slips", {
    slipDate: DATE, rstNo: rst, adatiId: s.id, jinsId: j1509.id, merchantId,
    grossGrams: q(gross), ratePaisePerQtl: rate * 100,
  });
  slipIds.push(r.id);
}
console.log(`entered the L.B sheet (${SHEET.length} slips) on ${DATE}`);

console.log("\nPurchase order");
const po = await call("POST", "/orders", {
  merchantId: lb.id, jinsId: j1509.id, poNo: `E2E-${Date.now() % 100000}`, poDate: DATE, qtyGrams: q(300),
});
check("PO created", Boolean(po.id));
const wrongPo = await status("POST", "/loads", { loadDate: DATE, merchantId: grm.id, jinsId: j1509.id, poId: po.id });
check("a load for another mill cannot use this PO", wrongPo.status === 400, wrongPo.json?.code);

console.log("\nLoad");
const created = await call("POST", "/loads", {
  loadDate: DATE, merchantId: lb.id, jinsId: j1509.id, poId: po.id, truckNo: "up25 ct-5038", slipIds,
});
check("all 13 slips put on the truck", created.allocation.added === 13, created.allocation.added);
check("RST 634 moved from G.R.M to L.B with it", created.allocation.moved === 1, created.allocation.moved);
let st = await call("GET", `/loads/${created.id}`);
check("truck number tidied", st.load.truckNo === "UP25CT5038", st.load.truckNo);
check("our net 331.05 qtl", st.slipTotals.netGrams === 33_105_000, st.slipTotals.netGrams);
check("parcha rate = weighted average 3413.45", st.slipTotals.avgRatePaisePerQtl === 341_345, st.slipTotals.avgRatePaisePerQtl);
const codes = (xs: any[]) => xs.map((x) => x.code).sort();
check("waits for mill weight, bags and invoice no", JSON.stringify(codes(st.blockers)) === JSON.stringify(["no_bags", "no_invoice_no", "no_mill_gross"]), codes(st.blockers));
check("no parcha yet", st.doc === null);

const second = await call("POST", "/loads", { loadDate: DATE, merchantId: lb.id, jinsId: j1509.id });
const again = await call("POST", `/loads/${second.id}/slips`, { slipIds: [slipIds[0]] });
check("one slip, one load: a slip already on a truck is not taken", again.added === 0 && again.elsewhere.length === 1, again);
const other = await call("POST", "/slips", {
  slipDate: DATE, rstNo: "901", adatiId: (byHi.get("शिवम ट्रेडिंग") as any).id, jinsId: j1121.id, merchantId: lb.id,
  grossGrams: q(10), ratePaisePerQtl: 300000,
});
const mixed = await status("POST", `/loads/${second.id}/slips`, { slipIds: [other.id] });
check("a 1121 slip cannot go on a 1509 truck", mixed.status === 409 && mixed.json.code === "wrong_jins", mixed.json?.code);

console.log("\nMill weighment and parcha fields (invoice 196)");
await call("PUT", `/loads/${created.id}`, {
  millGrossGrams: q(315.30), katteCount: 800, boreCount: 0,
  advancePaise: 1_000_000, daraPaise: 359_738, invoiceNo: "196", invoiceDate: DATE,
});
st = await call("GET", `/loads/${created.id}`);
check("nothing blocks approval", st.blockers.length === 0, st.blockers);
const r = st.doc.result;
check("bardana 800 x 0.57 = 4.56 qtl", st.doc.weights.bardanaGrams === 456_000, st.doc.weights.bardanaGrams);
check("net 310.74 qtl", st.doc.weights.netGrams === 31_074_000, st.doc.weights.netGrams);
check("goods 10,60,695.45", r.goodsAmountPaise === 106_069_545, r.goodsAmountPaise);
check("kacchi adat 21,213.91", r.adatPaise === 2_121_391, r.adatPaise);
check("total 11,17,851.22", r.totalPaise === 111_785_122, r.totalPaise);
check("grand total 11,27,851.22", r.grandTotalPaise === 112_785_122, r.grandTotalPaise);
const lab2 = r.lines.find((l: any) => l.key === "labour2");
check("labour @ 15.50 printed at zero (no bore bags)", lab2 && lab2.amountPaise === 0, lab2?.amountPaise);
check("flags the 20.31 qtl gap between our list and the mill", st.warnings.some((w: any) => w.code === "weight_diff" && w.grams === 2_031_000), st.warnings);
check("flags 10.74 qtl over the 300 qtl PO", st.warnings.some((w: any) => w.code === "po_over" && w.overGrams === 1_074_000), st.warnings);

// a slip on a draft load can still be corrected, and the load follows
await call("PUT", `/slips/${slipIds[5]}`, { ratePaisePerQtl: 361_200 });
const moved = await call("GET", `/loads/${created.id}`);
check("editing a slip on a draft load changes the rate", moved.slipTotals.avgRatePaisePerQtl !== 341_345, moved.slipTotals.avgRatePaisePerQtl);
await call("PUT", `/slips/${slipIds[5]}`, { ratePaisePerQtl: 361_100 });

console.log("\nApprove");
const ap = await call("POST", `/loads/${created.id}/approve`);
check("approved as parcha 196 v1", ap.parchaNo === "196" && ap.version === 1, ap);
check("grand total frozen", ap.grandTotalPaise === 112_785_122, ap.grandTotalPaise);
const lockedSlip = await status("PUT", `/slips/${slipIds[0]}`, { ratePaisePerQtl: 1 });
check("slips on an approved parcha are locked", lockedSlip.status === 409 && lockedSlip.json.code === "slip_locked", lockedSlip.json?.code);
const lockedLoad = await status("PUT", `/loads/${created.id}`, { truckNo: "X" });
check("the load is locked too", lockedLoad.status === 409, lockedLoad.status);

const xres = await raw("GET", `/loads/${created.id}/parcha.xlsx`);
const buf = Buffer.from(await xres.arrayBuffer());
check("Excel downloads", xres.ok && buf.subarray(0, 2).toString() === "PK", xres.status);
const wb = new ExcelJS.Workbook();
await wb.xlsx.load(buf as any);
const ws = wb.worksheets[0];
const values: unknown[] = [];
ws.eachRow((row) => row.eachCell((c) => values.push(c.value)));
check("Excel carries the grand total 1127851.22 as a number", values.includes(1127851.22));
check("Excel carries truck, invoice no and date", values.includes("UP25CT5038") && values.includes("196") && values.includes("25-09-2026"));

// another truck cannot reuse number 196
await call("PUT", `/loads/${second.id}`, { millGrossGrams: q(10.2), katteCount: 25, advancePaise: 0, daraPaise: 0, invoiceNo: "196" });
const ok2 = await call("POST", `/slips`, {
  slipDate: DATE, rstNo: "902", adatiId: (byHi.get("अमित ट्रेडिंग") as any).id, jinsId: j1509.id, merchantId: lb.id,
  grossGrams: q(10.2), ratePaisePerQtl: 340000,
});
await call("POST", `/loads/${second.id}/slips`, { slipIds: [ok2.id] });
const dup = await status("POST", `/loads/${second.id}/approve`);
check("invoice 196 cannot be used twice", dup.status === 409 && dup.json.blockers.some((b: any) => b.code === "invoice_taken"), dup.json?.blockers);
const sugg = (await call("GET", `/loads/${second.id}`));
await call("PUT", `/loads/${second.id}`, { invoiceNo: null });
const s2 = await call("GET", `/loads/${second.id}`);
check("the next number is suggested as 197", s2.suggestedInvoiceNo === "197", s2.suggestedInvoiceNo);
void sugg;

console.log("\nVoid and re-approve");
const noReason = await status("POST", `/parchas/${ap.id}/void`, { reason: "" });
check("voiding needs a reason", noReason.status === 400);
await call("POST", `/parchas/${ap.id}/void`, { reason: "advance was 12000, not 10000" });
const unlocked = await status("PUT", `/slips/${slipIds[0]}`, { ratePaisePerQtl: 345_000 });
check("slips are editable again after voiding", unlocked.status === 200, unlocked.status);
await call("PUT", `/slips/${slipIds[0]}`, { ratePaisePerQtl: 345_000 });
await call("PUT", `/loads/${created.id}`, { advancePaise: 1_200_000 });
const ap2 = await call("POST", `/loads/${created.id}/approve`);
check("re-approved as 196 v2", ap2.parchaNo === "196" && ap2.version === 2, ap2);
check("with the new advance", ap2.grandTotalPaise === 112_785_122 + 200_000, ap2.grandTotalPaise);
const reg = await call("GET", "/parchas");
const mine = reg.filter((p: any) => p.parchaNo === "196");
check("register keeps v1 (void) and v2 (approved)", mine.length === 2 && mine.some((p: any) => p.status === "void") && mine.some((p: any) => p.status === "approved"));

console.log("\nPO balance");
const orders = await call("GET", "/orders");
const mypo = orders.find((o: any) => o.id === po.id);
check("PO counts the mill's 310.74 qtl", mypo.sentGrams === 31_074_000, mypo.sentGrams);
check("balance shows 10.74 qtl over", mypo.balanceGrams === -1_074_000, mypo.balanceGrams);
const delPo = await status("DELETE", `/orders/${po.id}`);
check("a PO with loads cannot be deleted", delPo.status === 409);

const loads = await call("GET", "/loads");
const row = loads.find((l: any) => l.id === created.id);
check("load list shows parcha 196 and the gap", row.parcha?.parchaNo === "196" && row.diffGrams === 2_031_000, { p: row.parcha?.parchaNo, d: row.diffGrams });
const delBilled = await status("DELETE", `/loads/${created.id}`);
check("an approved load cannot be deleted", delBilled.status === 409);

console.log(bad === 0 ? "\nLoads, PO and parcha work end to end." : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
