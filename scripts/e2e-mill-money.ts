import "./_guard.ts";
/* End-to-end: what the mills owe us, on the test database only. Runs after
 * e2e-loads, which leaves L.B with approved parchas (196 v2 among them).
 *   L.B owes = its opening + every approved parcha − every receipt (money + held back)
 * Every figure below is worked from the register, not from the code under test.
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

const mills = await call("GET", "/merchants");
const lb = mills.find((m: any) => m.code === "LB");
const grm = mills.find((m: any) => m.code === "GRM");
const reg = await call("GET", "/parchas");
const lbBills = reg.filter((p: any) => p.millCode === "LB" && p.status === "approved");
const billedByHand = lbBills.reduce((s: number, p: any) => s + p.grandTotalPaise, 0);
const p196 = lbBills.find((p: any) => p.parchaNo === "196");
check("L.B has approved parchas to work with, 196 among them", lbBills.length >= 1 && Boolean(p196), lbBills.map((p: any) => p.parchaNo));

console.log("\nWhat L.B owes");
let list = await call("GET", "/mill-ledger");
let row = list.rows.find((r: any) => r.id === lb.id);
check("billed = the sum of its approved parchas (voided ones left out)", row.billedPaise === billedByHand && row.parchas === lbBills.length, { got: row.billedPaise, want: billedByHand });
check("nothing received yet: it owes the whole bill", row.balancePaise === billedByHand);
await call("PUT", `/merchants/${lb.id}`, { openingBalanceRupees: 10000 });
row = (await call("GET", "/mill-ledger")).rows.find((r: any) => r.id === lb.id);
check("an opening of 10,000.00 adds to it", row.balancePaise === billedByHand + rs(10000), row.balancePaise);

console.log("\nMoney from the mill");
const zero = await raw("POST", "/mill-receipts", { merchantId: lb.id, receiptDate: "2026-09-27", amountPaise: 0 });
check("a receipt of nothing is refused", zero.status === 400, zero.status);
const neg = await raw("POST", "/mill-receipts", { merchantId: lb.id, receiptDate: "2026-09-27", amountPaise: -5 });
check("a negative receipt is refused", neg.status === 400, neg.status);
const wrongMill = await raw("POST", "/mill-receipts", { merchantId: grm.id, receiptDate: "2026-09-27", amountPaise: 100, loadId: p196.loadId });
check("money against a truck of another mill is refused", wrongMill.status === 400, wrongMill.status);
const noDate = await raw("POST", "/mill-receipts", { merchantId: lb.id, amountPaise: 100 });
check("a receipt needs a date", noDate.status === 400);
// 5,00,000 by RTGS against truck 196, and the mill kept 1,129.85 as TDS
const r1 = await call("POST", "/mill-receipts", {
  merchantId: lb.id, receiptDate: "2026-09-27", amountPaise: rs(500000), deductionPaise: rs(1129.85),
  deductionNote: "TDS 0.1%", mode: "rtgs", reference: "UTR998", loadId: p196.loadId,
});
const r2 = await call("POST", "/mill-receipts", { merchantId: lb.id, receiptDate: "2026-09-28", amountPaise: rs(200000), mode: "cheque" });
list = await call("GET", "/mill-ledger");
row = list.rows.find((r: any) => r.id === lb.id);
const expectBal = rs(10000) + billedByHand - rs(500000) - rs(1129.85) - rs(200000);
check("owes = 10,000 + bills − 5,00,000 − 1,129.85 held − 2,00,000", row.balancePaise === expectBal, { got: row.balancePaise, want: expectBal });
check("received 7,00,000 and held back 1,129.85 are shown apart", row.receivedPaise === rs(700000) && row.deductedPaise === rs(1129.85));
check("the list total is the sum of its rows", list.totals.balancePaise === list.rows.reduce((s: number, r: any) => s + r.balancePaise, 0));

const st = await call("GET", `/mill-ledger/${lb.id}`);
const runs = st.entries.map((e: any) => e.balancePaise);
check("statement starts from the opening", st.broughtForwardPaise === rs(10000));
check("statement closes where the list does", st.totals.closingPaise === row.balancePaise && runs[runs.length - 1] === row.balancePaise, st.totals.closingPaise);
let ok = true, run = st.broughtForwardPaise;
for (const e of st.entries) { run += e.debitPaise - e.creditPaise; if (run !== e.balancePaise) ok = false; }
check("every running balance = the one before + bill − money", ok);
const b196 = st.bills.find((b: any) => b.parchaNo === "196");
check("parcha 196: due = its total − 5,01,129.85 received against it", b196.duePaise === p196.grandTotalPaise - rs(501129.85), b196);
const reg2 = await call("GET", "/parchas");
const reg196 = reg2.find((p: any) => p.parchaNo === "196" && p.status === "approved");
check("the register shows the same due on 196", reg196.duePaise === b196.duePaise, reg196.duePaise);

const later = await call("GET", `/mill-ledger/${lb.id}?from=2026-09-28`);
const bfWant = st.entries.filter((e: any) => e.date < "2026-09-28").reduce((s: number, e: any) => s + e.debitPaise - e.creditPaise, rs(10000));
check("from 28-09: brought forward = opening + everything before", later.broughtForwardPaise === bfWant, { got: later.broughtForwardPaise, want: bfWant });
check("from 28-09: still closes at the same balance", later.totals.closingPaise === row.balancePaise);

console.log("\nCancel a receipt");
const noReason = await raw("POST", `/mill-receipts/${r2.id}/void`, { reason: "" });
check("cancelling needs a reason", noReason.status === 400);
await call("POST", `/mill-receipts/${r2.id}/void`, { reason: "cheque bounced" });
row = (await call("GET", "/mill-ledger")).rows.find((r: any) => r.id === lb.id);
check("a bounced cheque puts 2,00,000 back on what L.B owes", row.balancePaise === expectBal + rs(200000), row.balancePaise);
const editVoid = await raw("PUT", `/mill-receipts/${r2.id}`, { amountPaise: 1 });
check("a cancelled receipt cannot be edited", editVoid.status === 409);
const st2 = await call("GET", `/mill-ledger/${lb.id}`);
const vEntry = st2.entries.find((e: any) => e.id === r2.id);
check("…but stays on the statement, struck, counting nothing", vEntry?.voided === true && vEntry.creditPaise === 0);
const recs = await call("GET", `/mill-receipts?merchantId=${lb.id}`);
const recsAll = await call("GET", `/mill-receipts?merchantId=${lb.id}&showVoid=1`);
check("receipt list hides it unless asked; totals never count it", recs.rows.length === 1 && recsAll.rows.length === 2 && recsAll.totals.amountPaise === rs(500000));
check("the receipt carries its parcha number", recs.rows[0].parchaNo === "196", recs.rows[0].parchaNo);
await call("PUT", `/mill-receipts/${r1.id}`, { amountPaise: rs(510000) });
row = (await call("GET", "/mill-ledger")).rows.find((r: any) => r.id === lb.id);
check("editing 5,00,000 → 5,10,000 lowers what L.B owes by 10,000", row.balancePaise === expectBal + rs(200000) - rs(10000), row.balancePaise);

console.log("\nChallan: the mill cuts weight on a truck");
const jinsAll = await call("GET", "/jins");
let ch = await call("GET", `/challan?merchantId=${lb.id}`);
const c196 = ch.rows.find((r: any) => r.loadId === p196.loadId);
check("the challan lists truck 196 with its parcha", Boolean(c196) && c196.parchaNo === "196" && c196.grandTotalPaise === p196.grandTotalPaise, c196 && { no: c196.parchaNo });
check("every truck on it belongs to L.B", ch.rows.every((r: any) => r.millCode === "LB"));
const owesBeforeCut = (await call("GET", "/mill-ledger")).rows.find((r: any) => r.id === lb.id).balancePaise;
const tooBig = await raw("PUT", `/challan/${p196.loadId}`, { deductionGrams: c196.weightGrams + 1 });
check("a cut bigger than the truck is refused", tooBig.status === 400, tooBig.status);
const negCut = await raw("PUT", `/challan/${p196.loadId}`, { deductionGrams: -1 });
check("a negative cut is refused", negCut.status === 400);
await call("PUT", `/challan/${p196.loadId}`, { deductionGrams: 250_000, note: "moisture" });
ch = await call("GET", `/challan?merchantId=${lb.id}`);
const cut = ch.rows.find((r: any) => r.loadId === p196.loadId);
// by hand: 2.50 qtl at the parcha's rate, half up to the paisa
const cutValue = Math.floor((250_000 * cut.ratePaisePerQtl) / 100_000 + 0.5);
check("final weight = loaded − 2.50 qtl", cut.finalNetGrams === c196.weightGrams - 250_000, cut.finalNetGrams);
check("cut value = 2.50 × the parcha's rate", cut.deductionValuePaise === cutValue, { got: cut.deductionValuePaise, want: cutValue });
check("final value = goods − cut value", cut.finalGoodsPaise === c196.goodsPaise - cutValue);
check("final bill = parcha total − cut value", cut.finalTotalPaise === p196.grandTotalPaise - cutValue, cut.finalTotalPaise);
check("the parcha itself is not changed", (await call("GET", "/parchas")).find((p: any) => p.id === p196.id).grandTotalPaise === p196.grandTotalPaise);
const owesAfterCut = (await call("GET", "/mill-ledger")).rows.find((r: any) => r.id === lb.id).balancePaise;
check("what L.B owes drops by the cut value", owesAfterCut === owesBeforeCut - cutValue, { before: owesBeforeCut, after: owesAfterCut, cutValue });
const stCut = await call("GET", `/mill-ledger/${lb.id}`);
check("the statement shows the cut right under its parcha", stCut.entries.some((e: any) => e.kind === "shortage" && e.creditPaise === cutValue && e.parchaNo === "196"));
check("parcha 196's due drops by it too", stCut.bills.find((b: any) => b.parchaNo === "196").shortagePaise === cutValue);
let ok2 = true, run2 = stCut.broughtForwardPaise;
for (const e of stCut.entries) { run2 += e.debitPaise - e.creditPaise; if (run2 !== e.balancePaise) ok2 = false; }
check("running balance still adds up with the cut in it", ok2 && run2 === owesAfterCut);
const otherJins = jinsAll.find((j: any) => j.id !== c196.jinsId);
check("filter by another commodity leaves 196 out", !(await call("GET", `/challan?jinsId=${otherJins.id}`)).rows.some((r: any) => r.loadId === p196.loadId));
check("search by truck number finds it", (await call("GET", `/challan?q=${encodeURIComponent((c196.truckNo ?? "").slice(0, 6))}`)).rows.some((r: any) => r.loadId === p196.loadId));
check("a date range before it leaves it out", !(await call("GET", `/challan?to=2026-01-01`)).rows.some((r: any) => r.loadId === p196.loadId));
const totals = ch.totals;
check("challan totals add up down the columns", totals.finalNetGrams === totals.weightGrams - totals.deductionGrams && totals.finalGoodsPaise === totals.goodsPaise - totals.deductionValuePaise);

console.log("\nWhole money picture");
const money = await call("GET", "/dashboard/money");
const mlist = await call("GET", "/mill-ledger");
const slist = await call("GET", "/ledger");
check("to receive from mills = the mill ledger's total", money.mills.toReceivePaise === mlist.totals.toReceivePaise, money.mills.toReceivePaise);
check("the money picture counts the mill's cut", money.mills.shortagePaise === mlist.totals.shortagePaise && money.mills.shortagePaise >= cutValue, money.mills.shortagePaise);
check("to pay suppliers = the supplier ledger's total", money.suppliers.toPayPaise === slist.totals.toPayPaise, money.suppliers.toPayPaise);
const allRecs = await call("GET", "/mill-receipts");
check("cash in from mills = every receipt not cancelled", money.cash.receivedFromMillsPaise === allRecs.totals.amountPaise, money.cash);
check("cash out to suppliers = every payment not cancelled", money.cash.paidToSuppliersPaise === slist.totals.paymentsPaise, money.cash.paidToSuppliersPaise);
const b = money.billed;
const parts = b.goodsPaise + b.parts.reduce((s: number, p: any) => s + p.amountPaise, 0) + b.otherPaise;
check("goods + every charge + rounding = the parchas' grand totals", parts === b.grandTotalPaise && b.grandTotalPaise === money.mills.billedPaise, { parts, grand: b.grandTotalPaise, billed: money.mills.billedPaise });
check("adat is named on its own", b.adatPaise > 0 && b.parts.some((p: any) => p.key === "adat" && p.amountPaise === b.adatPaise), b.adatPaise);
const dash = await call("GET", "/dashboard");
check("dashboard's to-receive agrees", dash.kpis.toReceivePaise === mlist.totals.toReceivePaise);
const dLb = dash.mills.find((m: any) => m.merchantId === lb.id);
check("L.B's card shows what it owes", dLb.owedPaise === mlist.rows.find((r: any) => r.id === lb.id).balancePaise, dLb.owedPaise);

/* The mill's own mandi licence: the buyer's licence on a 6R and a 9R, so it
   belongs on the mill and not typed again per voucher. */
await call("PUT", `/merchants/${lb.id}`, { mandiLicense: " l/2016/75/17121983 " });
const withLic = (await call("GET", "/merchants")).find((m: any) => m.id === lb.id);
check("a mill keeps its mandi licence, trimmed and in capitals",
  withLic.mandiLicense === "L/2016/75/17121983", withLic.mandiLicense);
const madeWithLic = await call("POST", "/merchants", { code: "LICM", name: "Licence Mill", mandiLicense: "L/2016/75/99887766" });
check("  ...and a new mill can be added with one", (await call("GET", `/merchants/${madeWithLic.id}`)).mandiLicense === "L/2016/75/99887766");
await call("PUT", `/merchants/${lb.id}`, { mandiLicense: "" });
check("  ...and clearing it leaves nothing behind",
  (await call("GET", `/merchants/${lb.id}`)).mandiLicense === null, (await call("GET", `/merchants/${lb.id}`)).mandiLicense);
await call("PUT", `/merchants/${lb.id}`, { mandiLicense: "L/2016/75/17121983" });

const del = await call("DELETE", `/merchants/${lb.id}`);
check("a mill with receipts is made inactive, never deleted", del.deactivated === true);
await call("PUT", `/merchants/${lb.id}`, { active: true });

console.log(bad === 0 ? "\nMill money adds up." : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
