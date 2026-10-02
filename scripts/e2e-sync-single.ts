import "./_guard.ts";
/* End-to-end: one computer's figures "as of a day", on the books the sync test
 * leaves behind (test databases only).
 *   - Money "now" is money as of today on every screen, supplier side and mill
 *     side alike: a slip, payment or receipt dated after today (a post-dated
 *     cheque) is not owed, paid or received yet.
 *   - The money card as of a day counts a truck once, even when its parcha is
 *     dated before the truck was loaded.
 *   - The parcha register's dues are the mill statement's for the same end date.
 *   - A two-row truck's rate is shown as an average, not as net × rate.
 *   - The books check re-works supplier terms to 4 decimals, as the app does.
 * Every figure is worked out here by hand. The screens' own requests come from
 * src/lib/asOfToday.ts, so these checks ask exactly what the screens ask.
 * Afterwards the two joined computers are synced and must show the same.
 * Run through: npm run test:e2e
 */
import { shiftDay, goodsAt } from "../server/lib/parchaLabels.ts";
import { amountPaise } from "../server/lib/money.ts";
import { notAfterToday, suppliersNow, millsNow, millNow, followupNow, owedBeforePayment } from "../src/lib/asOfToday.ts";

const PIN = process.env.MANDI_PIN ?? "482915";
const PG = process.env.MANDI_FAKE_PG!;
const PG_SWITCH = `http://127.0.0.1:${Number(new URL(PG).port) + 2000}`;
let bad = 0;
const check = (label: string, ok: boolean, got?: unknown) => {
  if (!ok) bad++;
  console.log(` ${ok ? "PASS" : "FAIL"}  ${label}${ok || got === undefined ? "" : `   ${JSON.stringify(got)}`}`);
};
const rs = (p: number) => `₹${(p / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const internet = (on: boolean) => fetch(`${PG_SWITCH}/${on ? "up" : "down"}`, { method: "POST" });

function computer(name: string, base: string) {
  let cookie = "";
  async function raw(method: string, p: string, body?: unknown) {
    const res = await fetch(base + p, {
      method, headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = res.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  }
  async function call(method: string, p: string, body?: unknown) {
    const r = await raw(method, p, body);
    if (r.status >= 400) throw new Error(`${name}: ${method} ${p} -> ${r.status} ${JSON.stringify(r.json)}`);
    return r.json;
  }
  async function login(user = "Test Owner", pin = PIN) {
    cookie = "";
    const users = await call("GET", "/auth/users");
    const u = users.find((x: any) => x.name === user);
    if (!u) throw new Error(`${name}: nobody called ${user}`);
    await call("POST", "/auth/login", { userId: u.id, pin });
    const me = await call("GET", "/auth/me");
    const vldm = me.businesses.find((b: any) => b.shortCode === "VLDM");
    if (vldm && me.activeBusinessId !== vldm.businessId) await call("POST", "/auth/switch-business", { businessId: vldm.businessId });
    return me;
  }
  return { name, raw, call, login };
}
const A = computer("A", process.env.MANDI_API!);
const B = computer("B", process.env.MANDI_API_B!);
const C = computer("C", process.env.MANDI_API_C!);

/** Sync the computers that are joined, until a whole round moves nothing. */
async function settleAll(who: ReturnType<typeof computer>[]) {
  const joined = [];
  for (const x of who) {
    try {
      await x.login();
      if ((await x.call("GET", "/cloud/status")).enabled) joined.push(x);
    } catch { /* not joined to the cloud (the sync test turns one computer off) */ }
  }
  for (let round = 0; round < 8; round++) {
    let moved = 0;
    for (const x of joined) { const r = await x.call("POST", "/cloud/sync"); moved += r.pushed + r.pulled; }
    if (!moved) return joined.map((x) => x.name);
  }
  return null;
}

// the office's own dates, counted from today, so the checks mean the same on any day
const T = new Date().toLocaleDateString("en-CA");
const d = (n: number) => shiftDay(T, n);
const fyStart = Number(T.slice(5, 7)) >= 4 ? Number(T.slice(0, 4)) : Number(T.slice(0, 4)) - 1;
const FY = { from: `${fyStart}-04-01`, to: `${fyStart + 1}-03-31` };
// the dashboard's and the statement's default period: the year up to today
const YEAR_TO = notAfterToday(FY.to, T);

await internet(true);
await A.login();
const jinsAll = await A.call("GET", "/jins");
const j = jinsAll.find((x: any) => x.code === "1509") ?? jinsAll[0];
const lb = (await A.call("GET", "/merchants")).find((m: any) => m.code === "LB");
// two mills of this test's own, on L.B's terms, so every figure below is theirs alone
const M = await A.call("POST", "/merchants", { code: "ASOF1", name: "As Of Test Mill", chargeConfig: lb.chargeConfig, openingBalanceRupees: 10000 });
const N = await A.call("POST", "/merchants", { code: "ASOF2", name: "As Of Back-dated Mill", chargeConfig: lb.chargeConfig });
const SA = await A.call("POST", "/adati", { nameHi: "आज तक जाँच एक", openingBalanceRupees: 10000 });
const SB = await A.call("POST", "/adati", { nameHi: "आज तक जाँच दो" });
const SC = await A.call("POST", "/adati", { nameHi: "आज तक जाँच तीन" });
const SD = await A.call("POST", "/adati", { nameHi: "आज तक जाँच चार" });
let rst = 0;
async function slip(adatiId: string, merchantId: string, date: string, grossGrams: number, rate: number) {
  const rstNo = `AT${++rst}`;
  return { ...(await A.call("POST", "/slips", { slipDate: date, rstNo, adatiId, jinsId: j.id, merchantId, grossGrams, ratePaisePerQtl: rate })), rstNo };
}
const pay = (adatiId: string, date: string, amountPaise: number) => A.call("POST", "/payments", { adatiId, payDate: date, amountPaise, mode: "cash" });
async function approve(loadId: string) {
  let r = await A.raw("POST", `/loads/${loadId}/approve`, {});
  // a number already used this year elsewhere in the test books is kept, as the approver may
  if (r.status === 409 && r.json?.code === "number_repeated") r = await A.raw("POST", `/loads/${loadId}/approve`, { acceptRepeatedNo: true });
  if (r.status !== 200) throw new Error(`approve ${loadId}: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json as { id: string; parchaNo: string; grandTotalPaise: number };
}
async function truck(m: { id: string }, loadDate: string, stockDate: string, millGrossGrams: number, katteCount: number, invoiceNo: string, invoiceDate: string) {
  const t = await A.call("POST", "/loads", { loadDate, merchantId: m.id, jinsId: j.id, stockDate, truckNo: `UP82AS${invoiceNo}` });
  await A.call("PUT", `/loads/${t.id}`, { millGrossGrams, katteCount, advancePaise: 0, daraPaise: 0, invoiceNo, invoiceDate });
  return t.id as string;
}
const rec = (m: { id: string }, date: string, amountPaise: number, loadId: string | null = null) =>
  A.call("POST", "/mill-receipts", { merchantId: m.id, receiptDate: date, amountPaise, deductionPaise: 0, mode: "bank", loadId });

console.log("Supplier money now: the payment form");
const a1 = await slip(SA.id, M.id, d(-10), 2_000_000, 300_000);
const a2 = await slip(SA.id, M.id, d(1), 1_000_000, 300_000);   // dated tomorrow
await pay(SA.id, d(-5), 2_000_000);
await pay(SA.id, d(2), 1_000_000);                              // a post-dated payment
const b1 = await slip(SB.id, M.id, d(4), 500_000, 300_000);      // SB's only slip, dated ahead
const c1 = await slip(SC.id, M.id, d(-3), 1_000_000, 300_000);
await pay(SC.id, d(3), c1.payablePaise + 1_000_000);             // a post-dated cheque bigger than the bill
// by hand: what each owes today, and all time
const saToday = 1_000_000 + a1.payablePaise - 2_000_000;
const saAll = saToday + a2.payablePaise - 1_000_000;
const form = await A.call("GET", suppliersNow(T));
const page = await A.call("GET", `/ledger?from=${FY.from}&asOf=${T}`);
const formSA = form.rows.find((r: any) => r.id === SA.id);
const pageSA = page.rows.find((r: any) => r.id === SA.id);
check(`"owed now" for a supplier with a slip and a payment dated after today: ${rs(saToday)} = the ledger page (all dates would be ${rs(saAll)})`,
  formSA?.balancePaise === saToday && pageSA?.balancePaise === saToday, { form: formSA?.balancePaise, page: pageSA?.balancePaise, byHand: saToday });
const formSB = form.rows.find((r: any) => r.id === SB.id);
check(`…and for one whose only slip is dated after today: nothing owed yet (not ${rs(b1.payablePaise)})`, formSB?.balancePaise === 0, formSB?.balancePaise);
const editPast = owedBeforePayment(formSA, { adatiId: SA.id, payDate: d(-5), amountPaise: 2_000_000 }, SA.id, T);
check(`editing the payment of ${d(-5)}: owed before it ${rs(saToday + 2_000_000)}, and opening + amount + commission + gaushala − paid re-adds to it`,
  editPast.owedPaise === saToday + 2_000_000
  && formSA.openingBalancePaise + formSA.goodsPaise + formSA.commissionPaise + formSA.gaushalaPaise - editPast.paidPaise === editPast.owedPaise, editPast);
const editAhead = owedBeforePayment(formSA, { adatiId: SA.id, payDate: d(2), amountPaise: 1_000_000 }, SA.id, T);
check(`editing the post-dated payment: it was never counted, so nothing is added back (${rs(saToday)})`,
  editAhead.owedPaise === saToday && formSA.openingBalancePaise + formSA.goodsPaise + formSA.commissionPaise + formSA.gaushalaPaise - editAhead.paidPaise === editAhead.owedPaise, editAhead);
// the dashboard as the screen asks for it: the year so far, balances as of today
const dashQ = `from=${FY.from}&to=${YEAR_TO}&asOf=${T}`;
const dash = await A.call("GET", `/dashboard?${dashQ}`);
const aheadNow = (dash.flags.find((f: any) => f.code === "paid_ahead")?.items ?? []).map((x: any) => x.adatiId);
const scAll = (await A.call("GET", "/ledger")).rows.find((r: any) => r.id === SC.id)?.balancePaise;
check(`a post-dated cheque pays no one ahead yet: no "paid ahead" warning for a supplier owed ${rs(c1.payablePaise)} today (all dates: ${rs(scAll)})`,
  !aheadNow.includes(SC.id) && scAll === -1_000_000 && form.rows.find((r: any) => r.id === SC.id)?.balancePaise === c1.payablePaise, { aheadNow: aheadNow.includes(SC.id), scAll });

console.log("\nMill money now: every mill screen");
// stock for two trucks, then the trucks, their parchas and the money from the mill
await slip(SD.id, M.id, d(-16), 3_000_000, 300_000);
await slip(SD.id, M.id, d(-11), 2_000_000, 300_000);
const ta = await truck(M, d(-15), d(-16), 2_990_000, 60, "88101", d(-15));
const tb = await truck(M, d(-10), d(-11), 1_985_000, 40, "88102", d(-10));
const pa = await approve(ta);
const pb = await approve(tb);
await rec(M, d(-8), 500_000);                     // on account
const r2 = await rec(M, d(-2), 3_000_000, ta);    // against the first truck
await rec(M, d(3), 700_000);                      // a post-dated cheque
const recsByHand = [{ date: d(-8), amt: 500_000, loadId: null as string | null }, { date: d(-2), amt: 3_000_000, loadId: ta }, { date: d(3), amt: 700_000, loadId: null }];
const billsByHand = [{ loadId: ta, no: pa.parchaNo, date: d(-15), grand: pa.grandTotalPaise }, { loadId: tb, no: pb.parchaNo, date: d(-10), grand: pb.grandTotalPaise }];
/** What M owes on a day, and what is due on each parcha: money against a truck pays it, the rest the opening and then the oldest. */
function millByHand(upTo: string) {
  const bills = billsByHand.filter((b) => b.date <= upTo);
  const recs = recsByHand.filter((r) => r.date <= upTo);
  const live = new Set(bills.map((b) => b.loadId));
  let pool = 0;
  const against = new Map<string, number>();
  for (const r of recs) if (r.loadId && live.has(r.loadId)) against.set(r.loadId, (against.get(r.loadId) ?? 0) + r.amt); else pool += r.amt;
  const due = new Map<string, number>();
  for (const b of bills) { const g = against.get(b.loadId) ?? 0; if (g > b.grand) pool += g - b.grand; due.set(b.loadId, Math.max(0, b.grand - g)); }
  const take = (x: number) => { const t = Math.min(pool, x); pool -= t; return x - t; };
  const openingDue = take(1_000_000);
  for (const b of [...bills].sort((x, y) => x.date.localeCompare(y.date))) due.set(b.loadId, take(due.get(b.loadId)!));
  const balance = 1_000_000 + bills.reduce((s, b) => s + b.grand, 0) - recs.reduce((s, r) => s + r.amt, 0);
  return { due, openingDue, balance };
}
const H = millByHand(T);
const dueText = (m: Map<string, number> | Record<string, number>) => billsByHand.map((b) => `${b.no}: ${rs(m instanceof Map ? m.get(b.loadId) ?? 0 : m[b.loadId] ?? 0)}`).join(", ");
const allTime = 1_000_000 + pa.grandTotalPaise + pb.grandTotalPaise - 4_200_000;
console.log(`   by hand, today: M owes ${rs(H.balance)} (${dueText(H.due)}); counting the post-dated cheque it would be ${rs(allTime)}`);
const list = await A.call("GET", millsNow(T));
check(`mills list: M owes ${rs(H.balance)}`, list.rows.find((r: any) => r.id === M.id)?.balancePaise === H.balance, list.rows.find((r: any) => r.id === M.id)?.balancePaise);
const card = await A.call("GET", millNow(M.id, null, T));
check("stock page card: the same", card.totals.closingPaise === H.balance, card.totals.closingPaise);
const st = await A.call("GET", `/mill-ledger/${M.id}?from=${FY.from}&to=${YEAR_TO}`);
const stDue = Object.fromEntries(st.bills.map((b: any) => [b.loadId, b.duePaise]));
check(`mill statement (the year to today): closing, Σ due − left on account, and each parcha's due (${dueText(H.due)})`,
  st.totals.closingPaise === H.balance && st.stillDuePaise === H.balance && billsByHand.every((b) => stDue[b.loadId] === H.due.get(b.loadId)) && (st.openingDue?.duePaise ?? 0) === H.openingDue,
  { closing: st.totals.closingPaise, dues: dueText(stDue) });
const fu = (await A.call("GET", followupNow(T))).rows.find((r: any) => r.id === M.id);
const fuDue = Object.fromEntries((fu?.unpaid ?? []).filter((u: any) => u.loadId).map((u: any) => [u.loadId, u.duePaise]));
check("follow-up: the same balance, and the same unpaid on each parcha",
  fu?.balancePaise === H.balance && billsByHand.every((b) => (fuDue[b.loadId] ?? 0) === H.due.get(b.loadId)), { balance: fu?.balancePaise, dues: dueText(fuDue) });
const dm = (await A.call("GET", `/dashboard?${dashQ}`)).mills.find((m: any) => m.merchantId === M.id);
check("dashboard mill card: the same", dm?.owedPaise === H.balance, dm?.owedPaise);
const regToday = await A.call("GET", `/parchas?to=${YEAR_TO}`);
const regDue = Object.fromEntries(regToday.filter((r: any) => r.status === "approved").map((r: any) => [r.loadId, r.duePaise]));
check("parcha register (its default end date, today): the same due on each parcha", billsByHand.every((b) => regDue[b.loadId] === H.due.get(b.loadId)), dueText(regDue));
const editing = await A.call("GET", millNow(M.id, r2.id, T));
check("the receipt form, editing a receipt, sees M as if it were not there", editing.totals.closingPaise === H.balance + 3_000_000, editing.totals.closingPaise);

console.log("\nThe parcha register to a past date");
const X = d(-5);
const HX = millByHand(X);
const regX = await A.call("GET", `/parchas?to=${X}`);
const regXDue = Object.fromEntries(regX.filter((r: any) => r.status === "approved").map((r: any) => [r.loadId, r.duePaise]));
const stX = await A.call("GET", `/mill-ledger/${M.id}?to=${X}`);
const stXDue = Object.fromEntries(stX.bills.map((b: any) => [b.loadId, b.duePaise]));
check(`to ${X}: each parcha's due on the register = the statement to that date = by hand (${dueText(HX.due)}); later money is not counted`,
  billsByHand.every((b) => regXDue[b.loadId] === HX.due.get(b.loadId) && stXDue[b.loadId] === HX.due.get(b.loadId)),
  { register: dueText(regXDue), statement: dueText(stXDue) });

console.log("\nThe money card: who owes whom today");
const money = await A.call("GET", `/dashboard/money?from=${FY.from}&to=${YEAR_TO}`);
// the To-pay tile beside the card (and the ledger page) ask for today; so does the mills list
const ledgerToday = await A.call("GET", `/ledger?asOf=${T}`);
const millsToday = await A.call("GET", `/mill-ledger?asOf=${T}`);
const weOwe = money.suppliers.toPayPaise - money.suppliers.paidAheadPaise;
check(`"we owe suppliers" ${rs(weOwe)} = the ledger today, and its "to pay" = the To-pay tile beside it (${rs(ledgerToday.totals.toPayPaise)})`,
  weOwe === ledgerToday.totals.toPayPaise - ledgerToday.totals.paidAheadPaise && money.suppliers.toPayPaise === ledgerToday.totals.toPayPaise,
  { card: [money.suppliers.toPayPaise, money.suppliers.paidAheadPaise], ledger: [ledgerToday.totals.toPayPaise, ledgerToday.totals.paidAheadPaise] });
check(`"mills owe us" ${rs(money.mills.toReceivePaise - money.mills.paidAheadPaise)} = the mills list today`,
  money.mills.toReceivePaise === millsToday.totals.toReceivePaise && money.mills.paidAheadPaise === millsToday.totals.paidAheadPaise,
  { card: [money.mills.toReceivePaise, money.mills.paidAheadPaise], list: [millsToday.totals.toReceivePaise, millsToday.totals.paidAheadPaise] });
const recsToday = await A.call("GET", `/mill-receipts?to=${T}`);
const paysToday = await A.call("GET", `/payments?to=${T}`);
check("cash: received and paid count only money dated up to today",
  money.cash.receivedFromMillsPaise === recsToday.totals.amountPaise && money.cash.paidToSuppliersPaise === paysToday.totals.amountPaise,
  { card: money.cash, received: recsToday.totals.amountPaise, paid: paysToday.totals.amountPaise });
const allPeriod = await A.call("GET", `/dashboard/money?to=${notAfterToday(undefined, T)}`);
check("…and the same on the \"all time\" period", allPeriod.suppliers.toPayPaise === ledgerToday.totals.toPayPaise && allPeriod.suppliers.paidAheadPaise === ledgerToday.totals.paidAheadPaise
  && allPeriod.mills.toReceivePaise === millsToday.totals.toReceivePaise && allPeriod.mills.paidAheadPaise === millsToday.totals.paidAheadPaise,
  { suppliers: [allPeriod.suppliers.toPayPaise, allPeriod.suppliers.paidAheadPaise], mills: [allPeriod.mills.toReceivePaise, allPeriod.mills.paidAheadPaise] });

console.log("\nA parcha dated before its truck was loaded");
{
  const netOf = (x: any) => (x.mills.toReceivePaise - x.mills.paidAheadPaise) + x.stock.valuePaise + x.stock.unbilledGoodsPaise
    + (x.cash.receivedFromMillsPaise - x.cash.paidToSuppliersPaise) - (x.suppliers.toPayPaise - x.suppliers.paidAheadPaise);
  // bought on day −30; the truck loaded on day −20 has its parcha dated day −25
  await slip(SD.id, N.id, d(-30), 2_000_000, 300_000);
  const tn = await truck(N, d(-20), d(-30), 1_980_000, 40, "88103", d(-25));
  const BETWEEN = d(-23), AFTER = d(-18);
  const before = { between: await A.call("GET", `/dashboard/money?from=${d(-40)}&to=${BETWEEN}`), after: await A.call("GET", `/dashboard/money?from=${d(-40)}&to=${AFTER}`) };
  const pn = await approve(tn);
  const doc = (await A.call("GET", `/parchas/${pn.id}`)).doc;
  const goods = doc.totals.goodsPaise, w = doc.totals.netGrams;
  const fair = pn.grandTotalPaise - goods;
  const between = await A.call("GET", `/dashboard/money?from=${d(-40)}&to=${BETWEEN}`);
  check(`as of ${BETWEEN} (billed, not yet loaded): approving moves the net by grand − goods = ${rs(fair)}, the goods counted once`,
    netOf(between) - netOf(before.between) === fair,
    { moved: rs(netOf(between) - netOf(before.between)), grand: rs(pn.grandTotalPaise), goods: rs(goods) });
  check(`  ...its ${(w / 100_000).toFixed(2)} qtl are off stock from the parcha's date`,
    between.stock.leftGrams === before.between.stock.leftGrams - w && between.mills.toReceivePaise - before.between.mills.toReceivePaise === pn.grandTotalPaise,
    { stockLeft: [before.between.stock.leftGrams, between.stock.leftGrams], w });
  const after = await A.call("GET", `/dashboard/money?from=${d(-40)}&to=${AFTER}`);
  check(`as of ${AFTER} (loaded and billed): the net moves by the same ${rs(fair)}`, netOf(after) - netOf(before.after) === fair, rs(netOf(after) - netOf(before.after)));
}

console.log("\nA truck with two rows at two rates");
{
  await slip(SD.id, M.id, d(-14), 1_500_000, 333_333);
  await slip(SD.id, M.id, d(-13), 1_500_000, 341_177);
  const t = await A.call("POST", "/loads", { loadDate: d(-12), merchantId: M.id, jinsId: j.id, stockDate: d(-14), truckNo: "UP82AS2ROW" });
  let s = await A.call("GET", `/loads/${t.id}`);
  await A.call("PUT", `/loads/${t.id}/lines/${s.lines[0].id}`, { stockDate: d(-14), netGrams: 1_000_000 });
  await A.call("POST", `/loads/${t.id}/lines`, { stockDate: d(-13) });
  await A.call("PUT", `/loads/${t.id}`, { millGrossGrams: 1_995_000, katteCount: 35, advancePaise: 0, daraPaise: 0, invoiceNo: "88104", invoiceDate: d(-12) });
  s = await A.call("GET", `/loads/${t.id}`);
  const two = s.doc;
  const one = (await A.call("GET", `/parchas/${pa.id}`)).doc;
  const printed = (doc: any) => { const g = goodsAt(doc); return g.average ? null : amountPaise(g.netGrams, g.ratePaisePerQtl); };
  check(`two rows (${two?.lines.map((l: any) => `${(l.netGrams / 100_000).toFixed(2)} qtl @ ${l.ratePaisePerQtl / 100}`).join(" + ")} = goods ${rs(two?.totals.goodsPaise ?? 0)}): `
    + `the rate ${((two?.totals.ratePaisePerQtl ?? 0) / 100).toFixed(2)} is shown as an average, since net × it is ${rs(amountPaise(two?.totals.netGrams ?? 0, two?.totals.ratePaisePerQtl ?? 0))}`,
    two?.lines.length === 2 && printed(two) === null, { lines: two?.lines.length, printed: printed(two) });
  check("one row: net × rate is printed, and is the goods to the paisa", one.lines.length === 1 && printed(one) === one.totals.goodsPaise, { printed: printed(one), goods: one.totals.goodsPaise });
  await A.call("DELETE", `/loads/${t.id}`);
}

console.log("\nThe books check re-works supplier terms to 4 decimals");
{
  const terms = await A.call("GET", "/settings/supplier-charges");
  await A.call("PUT", "/settings/supplier-charges", { ...terms, commissionPct: 0.6667, gaushalaPerQtl: 0.0625 });
  const s = await slip(SD.id, M.id, d(-9), 10_000_000, 350_000);
  // by hand: 0.6667 % of the amount, ₹0.0625 a quintal of net, each half up
  const commission = Number((BigInt(s.amountPaise) * 6667n + 500_000n) / 1_000_000n);
  const gaushala = Number((BigInt(s.netGrams) * 625n + 5_000_000n) / 10_000_000n);
  check(`the slip carries commission ${rs(commission)} and gaushala ${rs(gaushala)} on ${rs(s.amountPaise)}`, s.commissionPaise === commission && s.gaushalaPaise === gaushala, s);
  const bc = await A.call("GET", "/audit/books-check");
  const wrong = bc.businesses.flatMap((b: any) => b.sections.flatMap((x: any) => x.lines.filter((l: any) => l.ok === false && l.text.includes(`RST ${s.rstNo}:`)).map((l: any) => l.text)));
  check("the books check finds nothing wrong with it", wrong.length === 0, wrong);
  await A.call("PUT", "/settings/supplier-charges", terms);
  await A.call("DELETE", `/slips/${s.id}`);
}

console.log("\nThe other computer shows the same");
await internet(true);
const synced = await settleAll([A, B, C]);
check("the joined computers are in step", Array.isArray(synced) && synced.includes("A") && synced.includes("B"), synced);
{
  const bForm = (await B.call("GET", suppliersNow(T))).rows.find((r: any) => r.id === SA.id);
  const bList = (await B.call("GET", millsNow(T))).rows.find((r: any) => r.id === M.id);
  const bRegX = Object.fromEntries((await B.call("GET", `/parchas?to=${X}`)).filter((r: any) => r.status === "approved").map((r: any) => [r.loadId, r.duePaise]));
  const bFu = (await B.call("GET", followupNow(T))).rows.find((r: any) => r.id === M.id);
  check(`B: "owed now" ${rs(bForm?.balancePaise ?? 0)}, M owes ${rs(bList?.balancePaise ?? 0)}, the same dues to ${X} and today`,
    bForm?.balancePaise === saToday && bList?.balancePaise === H.balance && billsByHand.every((b) => bRegX[b.loadId] === HX.due.get(b.loadId))
    && bFu?.balancePaise === H.balance,
    { form: bForm?.balancePaise, list: bList?.balancePaise, regX: dueText(bRegX), fu: bFu?.balancePaise });
}
await internet(true);

console.log(bad === 0 ? "\nFigures as of a day count only what is dated up to it." : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
