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
/* What is due on each parcha, by hand, by the one rule every screen uses: money
   against a truck pays its parcha (any extra goes on account); money on account
   (the 2,00,000 cheque) pays the 10,000 opening first, then the oldest parcha. */
const dueByHand = (onAccount: number, against196: number, cut = new Map<string, number>()) => {
  let pool = onAccount;
  const oldest = [...lbBills].sort((a: any, b: any) => a.invoiceDate.localeCompare(b.invoiceDate) || a.parchaNo.localeCompare(b.parchaNo, undefined, { numeric: true }));
  const lines = [{ no: "opening", due: rs(10000) }, ...oldest.map((p: any) => {
    const bill = p.grandTotalPaise - (cut.get(p.loadId) ?? 0);
    const against = p.loadId === p196.loadId ? against196 : 0;
    if (against > bill) pool += against - bill;
    return { no: p.parchaNo, due: Math.max(0, bill - against) };
  })];
  for (const l of lines) { const take = Math.min(pool, l.due); l.due -= take; pool -= take; }
  return { lines, left: pool };
};
const byHand = dueByHand(rs(200000), rs(501129.85));
check("parcha 196's due: its total − 5,01,129.85 against it − whatever on-account money reached it (oldest first)",
  b196.duePaise === byHand.lines.find((l) => l.no === "196")!.due, { got: b196.duePaise, want: byHand.lines.find((l) => l.no === "196")!.due });
check("every L.B parcha's due on the statement is the hand-worked one",
  lbBills.every((p: any) => st.bills.find((b: any) => b.loadId === p.loadId)?.duePaise === byHand.lines.find((l) => l.no === p.parchaNo)!.due),
  st.bills.map((b: any) => [b.parchaNo, b.duePaise]));
check("the opening is due first: the cheque on account pays it", st.openingDue?.duePaise === byHand.lines[0].due, st.openingDue);
check("money on account is its own line: 2,00,000 in all", st.onAccount.totalPaise === rs(200000) && st.onAccount.leftPaise === byHand.left, st.onAccount);
check("the dues less money on account left over = what L.B owes", st.stillDuePaise === st.totals.closingPaise, { still: st.stillDuePaise, owes: st.totals.closingPaise });
const reg2 = await call("GET", "/parchas");
const reg196 = reg2.find((p: any) => p.parchaNo === "196" && p.status === "approved");
check("the register shows the same due on 196", reg196.duePaise === b196.duePaise, reg196.duePaise);
check("…and on every L.B parcha", reg2.filter((p: any) => p.millCode === "LB" && p.status === "approved").every((p: any) => p.duePaise === st.bills.find((b: any) => b.loadId === p.loadId)?.duePaise));
const fuLb = (await call("GET", "/mill-followup")).rows.find((r: any) => r.id === lb.id);
check("the follow-up screen agrees, parcha by parcha", st.bills.every((b: any) => (fuLb.unpaid.find((u: any) => u.loadId === b.loadId)?.duePaise ?? 0) === b.duePaise)
  && (fuLb.unpaid.find((u: any) => u.loadId === null)?.duePaise ?? 0) === (st.openingDue?.duePaise ?? 0), fuLb.unpaid.map((u: any) => [u.parchaNo, u.duePaise]));
const editing = await call("GET", `/mill-ledger/${lb.id}?exceptReceipt=${r2.id}`);
check("the receipt form, editing the cheque, sees L.B as if it were not there", editing.totals.closingPaise === st.totals.closingPaise + rs(200000) && editing.onAccount.totalPaise === 0, editing.totals);

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
// the cut lands on 196's bill day: with that day closed it is refused, like any other change there
await call("POST", "/days/close", { day: p196.invoiceDate });
const cutClosed = await raw("PUT", `/challan/${p196.loadId}`, { deductionGrams: 250_000, note: "moisture" });
check("a mill cut on a parcha whose bill day is closed is refused", cutClosed.status === 409 && (await cutClosed.json()).code === "day_closed", cutClosed.status);
check("…and what L.B owes did not move", (await call("GET", "/mill-ledger")).rows.find((r: any) => r.id === lb.id).balancePaise === owesBeforeCut);
await call("POST", "/days/reopen", { day: p196.invoiceDate, reason: "test: reopened to enter the mill's cut" });
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
// by now the cheque has bounced and 5,10,000 + 1,129.85 is against 196
check("…still by the one rule, and the dues still add up to what L.B owes",
  stCut.bills.find((b: any) => b.parchaNo === "196").duePaise === dueByHand(0, rs(511129.85), new Map([[p196.loadId, cutValue]])).lines.find((l) => l.no === "196")!.due
  && stCut.stillDuePaise === owesAfterCut, { due: stCut.bills.find((b: any) => b.parchaNo === "196").duePaise, still: stCut.stillDuePaise, owes: owesAfterCut });
const regCut = (await call("GET", "/parchas")).find((p: any) => p.id === p196.id);
check("the register shows the cut, and its row re-adds: total − cut − paid = due",
  regCut.shortagePaise === cutValue && regCut.grandTotalPaise - regCut.shortagePaise - regCut.receivedPaise === regCut.duePaise, regCut);
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
const stockList = await call("GET", "/stock");
check("goods in hand counts every truck once: the money card's stock = the stock list (with the no-mill row)",
  money.stock.leftGrams === stockList.reduce((s: number, r: any) => s + r.stockNet, 0), { money: money.stock.leftGrams, list: stockList.reduce((s: number, r: any) => s + r.stockNet, 0) });
const dash = await call("GET", "/dashboard");
check("dashboard's to-receive agrees", dash.kpis.toReceivePaise === mlist.totals.toReceivePaise);
const dLb = dash.mills.find((m: any) => m.merchantId === lb.id);
check("L.B's card shows what it owes", dLb.owedPaise === mlist.rows.find((r: any) => r.id === lb.id).balancePaise, dLb.owedPaise);

const del = await call("DELETE", `/merchants/${lb.id}`);
check("a mill with receipts is made inactive, never deleted", del.deactivated === true);
await call("PUT", `/merchants/${lb.id}`, { active: true });

console.log(bad === 0 ? "\nMill money adds up." : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
