import "./_guard.ts";
/* End-to-end: the figures and words an audit of a two-year book found out of
 * step, each checked the way the screen asks for it (test databases only).
 *   - A receipt or payment whose date moves into another financial year takes
 *     that year's next number; nothing else is renumbered.
 *   - Two computers that number a payment alike either side of 1 January get
 *     it settled after the sync, as within one calendar year.
 *   - The dashboard's "Mills owe us" and "We owe suppliers" are the figures the
 *     mills list, the follow-up and the ledger show; the net position is the same.
 *   - The mill statement names the truck of money received before its parcha.
 *   - "Paid in this period" stops at today, as the money card does.
 *   - A statement with its To box empty runs to today, as it says.
 *   - A past year's money card and ledger card say which day they are on.
 *   - A line of the day's rate, and a day row on a mill's stock page, open the
 *     daily list for that mill and commodity: the same net, average and amount.
 *   - The dara starts on a commodity the mill bought, not on 1509 regardless.
 *   - The notes under "Mills owe us" and "We owe suppliers" add up to the tile.
 *   - The stock page with no dates and the dashboard's "All time" stop at today.
 *   - A mill statement with its To box empty runs to today, as it says.
 *   - Nothing writes the old sync list (sync_outbox) any more; what it holds is
 *     cleared in the background after start-up.
 *   - A server on a computer set to London takes India's date for "today".
 * Runs after the sync test, on the books it leaves behind (A and B joined).
 * Run through: npm run test:e2e
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { shiftDay, dmy } from "../server/lib/parchaLabels.ts";
import { notAfterToday, suppliersNow, millsNow, followupNow, statementRange, millStatementRange, stockRange, dashboardPeriod } from "../src/lib/asOfToday.ts";
import { moneyTiles, moneyWords, ledgerProof, moneyNotes } from "../src/lib/moneyFigures.ts";
import { dayRateLink, stockDayLink, dailyListFrom, dailyListQuery, daraStartJins } from "../src/lib/dailyList.ts";
import { STRINGS, type StringKey } from "../src/lib/strings.ts";

const PIN = process.env.MANDI_PIN ?? "482915";
const PG = process.env.MANDI_FAKE_PG!;
const PG_SWITCH = `http://127.0.0.1:${Number(new URL(PG).port) + 2000}`;
let bad = 0;
const check = (label: string, ok: boolean, got?: unknown) => {
  if (!ok) bad++;
  console.log(` ${ok ? "PASS" : "FAIL"}  ${label}${ok || got === undefined ? "" : `   ${JSON.stringify(got).slice(0, 400)}`}`);
};
const internet = (on: boolean) => fetch(`${PG_SWITCH}/${on ? "up" : "down"}`, { method: "POST" });

function computer(name: string, base: string, dir: string) {
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
  function q<T = any>(sql: string, ...args: unknown[]): T[] {
    const d = new Database(path.join(dir, "mandi.db"), { readonly: true });
    try { return d.prepare(sql).all(...args) as T[]; } finally { d.close(); }
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
  const sync = () => call("POST", "/cloud/sync");
  return { name, raw, call, q, login, sync };
}
const A = computer("A", process.env.MANDI_API!, process.env.MANDI_DATA_DIR!);
const B = computer("B", process.env.MANDI_API_B!, process.env.MANDI_DATA_DIR_B!);

/** Sync until a whole round moves nothing. */
async function settle(who: ReturnType<typeof computer>[]) {
  for (let round = 0; round < 8; round++) {
    let moved = 0;
    for (const x of who) { const r = await x.sync(); moved += r.pushed + r.pulled; }
    if (!moved) return round;
  }
  return -1;
}

// the office's own dates, counted from today, so the checks mean the same on any day
const T = new Date().toLocaleDateString("en-CA");
const d = (n: number) => shiftDay(T, n);
const fyStart = Number(T.slice(5, 7)) >= 4 ? Number(T.slice(0, 4)) : Number(T.slice(0, 4)) - 1;
const FY = { from: `${fyStart}-04-01`, to: `${fyStart + 1}-03-31` };
const YEAR_TO = notAfterToday(FY.to, T);
// two years well ahead, so the voucher numbers below are this test's own
const Y = fyStart + 3;
const fyOf = (y: number) => ({ from: `${y}-04-01`, to: `${y + 1}-03-31`, label: `${y}-${String(y + 1).slice(2)}` });
const [Y0, Y1] = [fyOf(Y), fyOf(Y + 1)];
const en = (key: StringKey, vars?: Record<string, string | number>) => {
  let s = (STRINGS.en as Record<string, string>)[key] ?? key;
  for (const [k, v] of Object.entries(vars ?? {})) s = s.replaceAll(`{${k}}`, String(v));
  return s;
};
const hi = (key: StringKey, vars?: Record<string, string | number>) => {
  let s = (STRINGS.hi as Record<string, string>)[key] ?? key;
  for (const [k, v] of Object.entries(vars ?? {})) s = s.replaceAll(`{${k}}`, String(v));
  return s;
};

await internet(true);
await A.login();
const jinsAll = await A.call("GET", "/jins");
const j = jinsAll.find((x: any) => x.code === "1509") ?? jinsAll[0];
const lb = (await A.call("GET", "/merchants")).find((m: any) => m.code === "LB");
// mills and suppliers of this test's own, so every figure below is theirs alone
const M1 = await A.call("POST", "/merchants", { code: "MFX1", name: "Maths Fix Mill", chargeConfig: lb.chargeConfig });
const M2 = await A.call("POST", "/merchants", { code: "MFX2", name: "Maths Fix Draft Mill", chargeConfig: lb.chargeConfig });
const S1 = await A.call("POST", "/adati", { nameHi: "गणित जाँच एक" });
const S2 = await A.call("POST", "/adati", { nameHi: "गणित जाँच दो" });
const made = { receipts: [] as string[], payments: [] as string[], slips: [] as string[] };
const receipt = async (x: ReturnType<typeof computer>, merchantId: string, date: string, amountPaise: number, loadId: string | null = null) => {
  const r = await x.call("POST", "/mill-receipts", { merchantId, receiptDate: date, amountPaise, deductionPaise: 0, mode: "bank", loadId });
  made.receipts.push(r.id);
  return r as { id: string; voucherNo: number };
};
const payment = async (x: ReturnType<typeof computer>, adatiId: string, date: string, amountPaise: number) => {
  const p = await x.call("POST", "/payments", { adatiId, payDate: date, amountPaise, mode: "cash" });
  made.payments.push(p.id);
  return p as { id: string; voucherNo: number };
};
const receiptsIn = async (fy: { from: string; to: string }) =>
  (await A.call("GET", `/mill-receipts?from=${fy.from}&to=${fy.to}&showVoid=1`)).rows as { id: string; voucherNo: number; receiptDate: string }[];
const paymentsIn = async (fy: { from: string; to: string }) =>
  (await A.call("GET", `/payments?from=${fy.from}&to=${fy.to}&showVoid=1`)).rows as { id: string; voucherNo: number; payDate: string }[];
const topNo = (rows: { voucherNo: number }[]) => Math.max(0, ...rows.map((r) => r.voucherNo ?? 0));
const repeated = (rows: { voucherNo: number }[]) => {
  const seen = new Map<number, number>();
  for (const r of rows) seen.set(r.voucherNo, (seen.get(r.voucherNo) ?? 0) + 1);
  return [...seen].filter(([, n]) => n > 1).map(([no]) => no);
};
const numbersOf = (rows: { id: string; voucherNo: number }[], except: string[]) =>
  JSON.stringify(rows.filter((r) => !except.includes(r.id)).map((r) => [r.id, r.voucherNo]).sort());

console.log("A receipt or payment moved into another financial year");
{
  // a receipt in the later year, moved back into the earlier one, and one going the other way
  await receipt(A, M1.id, `${Y}-04-03`, 50_000);
  const late = await receipt(A, M1.id, `${Y + 1}-04-05`, 111_111);
  const early = await receipt(A, M1.id, `${Y}-10-02`, 222_222);
  const before0 = await receiptsIn(Y0), before1 = await receiptsIn(Y1);
  const moved1 = await A.call("PUT", `/mill-receipts/${late.id}`, { receiptDate: `${Y + 1}-01-10` });
  const after0 = await receiptsIn(Y0);
  check(`a receipt moved from ${Y1.label} into ${Y0.label} takes that year's next number (RV-${topNo(before0) + 1}), not its old RV-${late.voucherNo}`,
    after0.find((r) => r.id === late.id)?.voucherNo === topNo(before0) + 1 && moved1.voucherNo === topNo(before0) + 1, { moved1, list: after0.find((r) => r.id === late.id) });
  check(`  ...so no receipt number is used twice in ${Y0.label}`, repeated(after0).length === 0, repeated(after0));
  check("  ...and every other receipt keeps its number", numbersOf(after0, [late.id]) === numbersOf(before0, []));
  const audit = A.q<{ entity_label: string }>("select entity_label from audit_log where entity_id = ? and action = 'mill_receipt.update' order by at desc limit 1", late.id)[0];
  check("  ...and the audit trail says which number it had and which it has now",
    Boolean(audit?.entity_label.includes(`RV-${late.voucherNo} (${Y1.label})`) && audit.entity_label.includes(`RV-${topNo(before0) + 1} (${Y0.label})`)), audit);
  const moved2 = await A.call("PUT", `/mill-receipts/${early.id}`, { receiptDate: `${Y + 1}-04-05` });
  const after1 = await receiptsIn(Y1);
  check(`a receipt moved from ${Y0.label} into ${Y1.label} takes that year's next number`,
    after1.find((r) => r.id === early.id)?.voucherNo === topNo(before1.filter((r) => r.id !== late.id)) + 1 && moved2.voucherNo === after1.find((r) => r.id === early.id)?.voucherNo,
    { moved2, list: after1.map((r) => [r.receiptDate, r.voucherNo]) });
  check(`  ...so no receipt number is used twice in ${Y1.label}`, repeated(after1).length === 0, repeated(after1));
  const same = await A.call("PUT", `/mill-receipts/${early.id}`, { receiptDate: `${Y + 1}-06-01` });
  check("a date change inside the same year keeps the number", (await receiptsIn(Y1)).find((r) => r.id === early.id)?.voucherNo === moved2.voucherNo && same.voucherNo === moved2.voucherNo, same);

  // the same for a payment
  await payment(A, S1.id, `${Y}-04-01`, 10_000);
  const pLate = await payment(A, S1.id, `${Y + 1}-04-05`, 33_333);
  const pBefore0 = await paymentsIn(Y0);
  const pMoved = await A.call("PUT", `/payments/${pLate.id}`, { payDate: `${Y + 1}-01-10` });
  const pAfter0 = await paymentsIn(Y0);
  check(`a payment moved from ${Y1.label} into ${Y0.label} takes that year's next number (PV-${topNo(pBefore0) + 1}), not its old PV-${pLate.voucherNo}`,
    pAfter0.find((p) => p.id === pLate.id)?.voucherNo === topNo(pBefore0) + 1 && pMoved.voucherNo === topNo(pBefore0) + 1, { pMoved, list: pAfter0.find((p) => p.id === pLate.id) });
  check(`  ...so no payment number is used twice in ${Y0.label}`, repeated(pAfter0).length === 0, repeated(pAfter0));
  check("  ...and every other payment keeps its number", numbersOf(pAfter0, [pLate.id]) === numbersOf(pBefore0, []));
  const pSame = await A.call("PUT", `/payments/${pLate.id}`, { payDate: `${Y + 1}-02-10`, amountPaise: 33_334 });
  check("a payment's date and amount changed inside the same year: the number stays", pSame.voucherNo === pMoved.voucherNo
    && (await paymentsIn(Y0)).find((p) => p.id === pLate.id)?.voucherNo === pMoved.voucherNo, pSame);
}

console.log("\nTwo computers, one number, either side of 1 January");
{
  await B.login();
  await settle([A, B]);
  // both off the internet: each numbers its payment in the same financial year, one in December, one in January
  await internet(false);
  const onA = await payment(A, S1.id, `${Y}-12-30`, 70_000);
  const onB = await payment(B, S1.id, `${Y + 1}-01-05`, 80_000);
  const rA = await receipt(A, M1.id, `${Y}-12-30`, 70_000);
  const rB = await receipt(B, M1.id, `${Y + 1}-01-05`, 80_000);
  check("each computer gave its payment the same number while apart", onA.voucherNo === onB.voucherNo, { A: onA.voucherNo, B: onB.voucherNo });
  check("  ...and its receipt", rA.voucherNo === rB.voucherNo, { A: rA.voucherNo, B: rB.voucherNo });
  await internet(true);
  await settle([A, B]);
  const pay = (x: ReturnType<typeof computer>) => x.q<{ id: string; voucher_no: number }>("select id, voucher_no from payments where id in (?, ?) order by id", onA.id, onB.id);
  const rec = (x: ReturnType<typeof computer>) => x.q<{ id: string; voucher_no: number }>("select id, voucher_no from mill_receipts where id in (?, ?) order by id", rA.id, rB.id);
  check(`after the sync the two payments (${dmy(`${Y}-12-30`)} and ${dmy(`${Y + 1}-01-05`)}) no longer share a number`, new Set(pay(A).map((r) => r.voucher_no)).size === 2, pay(A));
  check("  ...nor the two receipts", new Set(rec(A).map((r) => r.voucher_no)).size === 2, rec(A));
  check("  ...settled the same way on both computers", JSON.stringify(pay(A)) === JSON.stringify(pay(B)) && JSON.stringify(rec(A)) === JSON.stringify(rec(B)), { A: [pay(A), rec(A)], B: [pay(B), rec(B)] });
  check("  ...the one entered first keeps the number", pay(A).find((r) => r.id === onA.id)?.voucher_no === onA.voucherNo, pay(A));
  check(`  ...and ${Y0.label} has no number twice`, repeated(await paymentsIn(Y0)).length === 0 && repeated(await receiptsIn(Y0)).length === 0);
}

console.log("\nThe dashboard's money card agrees with the mills list, the follow-up and the ledger");
{
  // a mill that has paid ahead (money in, nothing billed) and a supplier paid ahead
  await receipt(A, M1.id, d(-1), 500_000);
  await payment(A, S1.id, d(-1), 300_000);
  // the money card as the screen asks for it: the year so far, balances as of the period's end
  const money = await A.call("GET", `/dashboard/money?from=${FY.from}&to=${YEAR_TO}`);
  const mills = await A.call("GET", millsNow(T));
  const follow = await A.call("GET", followupNow(T));
  const ledger = await A.call("GET", suppliersNow(T));
  const tiles = moneyTiles(money);
  check(`"Mills owe us" on the dashboard (${tiles.millsOwe}) is the mills list's (${mills.totals.toReceivePaise}) and the follow-up's (${follow.totals.toReceivePaise})`,
    money.mills.paidAheadPaise > 0 && tiles.millsOwe === mills.totals.toReceivePaise && tiles.millsOwe === follow.totals.toReceivePaise,
    { tile: tiles.millsOwe, list: mills.totals.toReceivePaise, followup: follow.totals.toReceivePaise, paidAhead: money.mills.paidAheadPaise });
  const a = money.mills.allTime;
  check(`  ...its note is true: opening + billed − cuts − received − held back is the tile less the ${money.mills.paidAheadPaise} paid ahead it does not count`,
    a.openingPaise + a.billedPaise - a.shortagePaise - a.receivedPaise - a.deductedPaise === tiles.millsOwe - money.mills.paidAheadPaise,
    { sum: a.openingPaise + a.billedPaise - a.shortagePaise - a.receivedPaise - a.deductedPaise, tile: tiles.millsOwe, ahead: money.mills.paidAheadPaise });
  check(`"We owe suppliers" on the dashboard (${tiles.weOwe}) is the ledger's "Owed to suppliers" today (${ledger.totals.toPayPaise})`,
    money.suppliers.paidAheadPaise > 0 && tiles.weOwe === ledger.totals.toPayPaise, { tile: tiles.weOwe, ledger: ledger.totals.toPayPaise, paidAhead: money.suppliers.paidAheadPaise });
  const s = money.suppliers.allTime;
  check(`  ...its note is true: opening + purchases − paid is the tile less the ${money.suppliers.paidAheadPaise} paid ahead it does not count`,
    s.openingPaise + s.purchasesPaise - s.paidPaise === tiles.weOwe - money.suppliers.paidAheadPaise);
  const netBefore = (money.mills.toReceivePaise - money.mills.paidAheadPaise) + money.stock.valuePaise + money.stock.unbilledGoodsPaise
    + (money.cash.receivedFromMillsPaise - money.cash.paidToSuppliersPaise) - (money.suppliers.toPayPaise - money.suppliers.paidAheadPaise);
  check("the net position is unchanged: paid ahead still comes off both sides", tiles.net === netBefore, { tile: tiles.net, netBefore });
}

console.log("\nThe mill statement names the truck of money received before its parcha");
{
  const truck = await A.call("POST", "/loads", { loadDate: d(-2), merchantId: M2.id, jinsId: j.id, stockDate: d(-2), truckNo: "UP80MF5992" });
  const r = await receipt(A, M2.id, d(-1), 1_000_000, truck.id);
  const st = await A.call("GET", `/mill-ledger/${M2.id}?from=${FY.from}&to=${T}`);
  const e = st.entries.find((x: any) => x.id === r.id);
  check("money received against a truck with no parcha yet names that truck on the statement", e?.truckNo === "UP80MF5992" && !e?.parchaNo, e);
  check("  ...and it still counts on account, against the closing balance", st.totals.closingPaise === -1_000_000 && st.onAccount.leftPaise === 1_000_000, { closing: st.totals.closingPaise, onAccount: st.onAccount });
  const list = (await A.call("GET", `/mill-receipts?merchantId=${M2.id}`)).rows.find((x: any) => x.id === r.id);
  check("  ...the same truck the receipts list shows", list?.truckNo === e?.truckNo, { list: list?.truckNo, statement: e?.truckNo });
  // the truck goes again (its money moved off it first), so no empty draft is left behind
  await A.call("PUT", `/mill-receipts/${r.id}`, { loadId: null });
  await A.call("DELETE", `/loads/${truck.id}`);
}

console.log("\n\"Paid in this period\" stops at today, as the money card does");
{
  await payment(A, S1.id, d(5), 1_234_500);   // a post-dated cheque
  // "All": the dashboard sends no dates, only today for the balances
  const all = await A.call("GET", `/dashboard?asOf=${T}`);
  const cardAll = await A.call("GET", `/dashboard/money?to=${notAfterToday(undefined, T)}`);
  check(`"All": paid in this period (${all.kpis.paidPaise}) is the money card's cash paid to suppliers (${cardAll.cash.paidToSuppliersPaise}), without the cheque dated ${dmy(d(5))}`,
    all.kpis.paidPaise === cardAll.cash.paidToSuppliersPaise, { kpi: all.kpis.paidPaise, card: cardAll.cash.paidToSuppliersPaise });
  // "From – to" running past today
  const custom = await A.call("GET", `/dashboard?from=${FY.from}&to=${d(10)}&asOf=${T}`);
  const cardCustom = await A.call("GET", `/dashboard/money?from=${FY.from}&to=${notAfterToday(d(10), T)}`);
  check("a period ending after today: paid in it is counted up to today, as the money card counts it",
    custom.kpis.paidPaise === cardCustom.suppliers.paidPaise, { kpi: custom.kpis.paidPaise, card: cardCustom.suppliers.paidPaise });
  const year = await A.call("GET", `/dashboard?from=${FY.from}&to=${YEAR_TO}&asOf=${T}`);
  const cardYear = await A.call("GET", `/dashboard/money?from=${FY.from}&to=${YEAR_TO}`);
  check("the year so far is as it was", year.kpis.paidPaise === cardYear.suppliers.paidPaise, { kpi: year.kpis.paidPaise, card: cardYear.suppliers.paidPaise });
}

console.log("\nA statement with its To box empty runs to today");
{
  const s1 = await A.call("POST", "/slips", { slipDate: d(-3), rstNo: "MFX1", adatiId: S2.id, jinsId: j.id, merchantId: lb.id, grossGrams: 1_000_000, ratePaisePerQtl: 300_000 });
  const s2 = await A.call("POST", "/slips", { slipDate: d(3), rstNo: "MFX2", adatiId: S2.id, jinsId: j.id, merchantId: lb.id, grossGrams: 2_000_000, ratePaisePerQtl: 300_000 });
  made.slips.push(s1.id, s2.id);
  const st = await A.call("GET", `/ledger/${S2.id}?${statementRange(FY.from, "", T)}`);
  const row = (await A.call("GET", suppliersNow(T))).rows.find((r: any) => r.id === S2.id);
  check(`From ${dmy(FY.from)}, To empty: the closing (${st.totals.closingPaise}) is the supplier's "to pay" today (${row?.balancePaise}), without the slip dated ${dmy(d(3))}`,
    st.totals.closingPaise === row?.balancePaise && !st.entries.some((e: any) => e.id === s2.id), { closing: st.totals.closingPaise, toPay: row?.balancePaise });
  check("  ...and it says so: the period ends today's date", st.to === T, { to: st.to });
  check("both boxes empty is still all time", statementRange("", "", T) === "");
  check("both boxes filled are asked as they are", statementRange(FY.from, d(10), T) === `from=${FY.from}&to=${d(10)}`);
}

console.log("\nA past year says which day its balances are on");
{
  const past = `${fyStart}-03-31`;
  const w = moneyWords(en, past, T);
  check(`the money card for a year ended ${dmy(past)} says that day, not "today"`, w.sub.includes(dmy(past)) && !/today/i.test(w.sub), w);
  const weOweLine = en("dash.weOweSub", { o: "₹1", p: "₹2", d: "₹3", w: w.span });
  check("  ...and its \"We owe suppliers\" line runs to that day, not \"all time\"", weOweLine.includes(dmy(past)) && !weOweLine.includes("all time"), weOweLine);
  const wHi = moneyWords(hi, past, T);
  check("  ...in Hindi too", wHi.sub.includes(dmy(past)) && !wHi.sub.includes("आज"), wHi);
  const now = moneyWords(en, T, T);
  check("this year's card still says today", /today/i.test(now.sub) && en("dash.weOweSub", { o: "₹1", p: "₹2", d: "₹3", w: now.span }).includes("all time"), now);
  check("the ledger's sum card for a past year says 1 April to 31 March", /31 March/.test(ledgerProof(en, { current: false })) && !/to date/.test(ledgerProof(en, { current: false })), ledgerProof(en, { current: false }));
  check("  ...in Hindi too", ledgerProof(hi, { current: false }).includes("31 मार्च") && !ledgerProof(hi, { current: false }).includes("आज"), ledgerProof(hi, { current: false }));
  check("  ...and for this year, 1 April to date", /to date/.test(ledgerProof(en, { current: true })), ledgerProof(en, { current: true }));
}

console.log("\nA line of the day's rate opens the daily list for that mill and that commodity");
const S3 = await A.call("POST", "/adati", { nameHi: "गणित जाँच तीन" });
const M3 = await A.call("POST", "/merchants", { code: "MFX3", name: "Maths Fix Wheat Mill", chargeConfig: lb.chargeConfig });
const j2 = jinsAll.find((x: any) => x.id !== j.id && x.code !== "1509");
const DAY = d(-6);
const slip = async (rst: string, millId: string, jinsId: string, date: string, grossGrams: number, ratePaisePerQtl: number) => {
  const s = await A.call("POST", "/slips", { slipDate: date, rstNo: rst, adatiId: S3.id, jinsId, merchantId: millId, grossGrams, ratePaisePerQtl });
  made.slips.push(s.id);
  return s as { id: string; netGrams: number };
};
{
  // one mill, two commodities on one day; another mill the same day
  await slip("MFX21", M1.id, j.id, DAY, 1_234_000, 310_000);
  await slip("MFX22", M1.id, j.id, DAY, 2_000_000, 320_000);
  await slip("MFX23", M1.id, j2.id, DAY, 1_500_000, 230_000);
  await slip("MFX24", lb.id, j.id, DAY, 900_000, 300_000);
  // the card as the dashboard asks for it
  const card = await A.call("GET", `/dashboard/day-averages?${new URLSearchParams({ from: DAY, to: DAY, days: "1", mills: "all" })}`);
  const lines = (card.days[0]?.lines ?? []).filter((l: any) => l.millId === M1.id);
  check(`the card has a line for each commodity MFX1 bought on ${dmy(DAY)}`, lines.length === 2, lines.map((l: any) => l.jinsCode));
  // the list each line opens: its address, read the way the daily list reads it, then what the list asks for
  const opens = async (href: string) => {
    const o = dailyListFrom(href.slice(href.indexOf("?")));
    return { o, list: await A.call("GET", dailyListQuery(o.date ?? T, o.mill, o.jins)) };
  };
  for (const l of lines) {
    const { o, list } = await opens(dayRateLink(DAY, l));
    check(`  ${l.jinsCode}: the list it opens (${dmy(o.date ?? "")}, ${o.mill === M1.id ? "MFX1" : o.mill || "every mill"}, ${o.jins ? jinsAll.find((x: any) => x.id === o.jins)?.code : "every commodity"}) has the line's net, average and amount`,
      list.totals.pricedNetGrams === l.netGrams && list.totals.weightedAvgRatePaise === l.avgRatePaisePerQtl && list.totals.amountPaise === l.amountPaise,
      { line: [l.netGrams, l.avgRatePaisePerQtl, l.amountPaise], list: [list.totals.pricedNetGrams, list.totals.weightedAvgRatePaise, list.totals.amountPaise] });
  }

  console.log("\nA day row on a mill's stock page opens the daily list for that mill and commodity");
  for (const jinsId of [j.id, ""]) {
    const st = await A.call("GET", `/stock/${M1.id}?${stockRange({ jinsId })}`);
    const row = st.days.find((x: any) => x.date === DAY);
    const { o, list } = await opens(stockDayLink(DAY, M1.id, jinsId));
    check(`MFX1, ${jinsId ? j.code : "every commodity"}, ${dmy(DAY)}: the list it opens has the row's ${row?.slips} slips and ${row?.boughtNet} g`,
      Boolean(row) && list.totals.rows === row.slips && list.totals.netGrams === row.boughtNet,
      { row: row && [row.slips, row.boughtNet], list: [list.totals.rows, list.totals.netGrams], opened: o });
  }
}

console.log("\nThe dara starts on a commodity the mill bought");
{
  await slip("MFX25", M3.id, j2.id, DAY, 1_100_000, 225_000);
  // what the dialog asks: the commodities the mill bought in the period (an older server answers with a file)
  const bought = async (millId: string, from: string, to: string) => {
    try {
      const r = await A.raw("GET", `/reports/mill?${new URLSearchParams({ merchantId: millId, from, to, format: "jins" })}`);
      return r.status === 200 && Array.isArray(r.json?.jins) ? (r.json.jins as { jinsId: string }[]).map((x) => x.jinsId) : undefined;
    } catch { return undefined; }
  };
  const daraRows = async (millId: string, jinsId: string) =>
    (await A.call("GET", `/reports/mill?${new URLSearchParams({ merchantId: millId, from: DAY, to: DAY, jinsId, format: "json" })}`)).totals.count as number;
  const onlyOther = daraStartJins(jinsAll, await bought(M3.id, DAY, DAY));
  check(`a mill that bought only ${j2.code} on ${dmy(DAY)}: the dara starts on ${j2.code}, and it has that day's slip`,
    onlyOther === j2.id && (await daraRows(M3.id, onlyOther)) === 1, { startsOn: jinsAll.find((x: any) => x.id === onlyOther)?.code });
  const both = daraStartJins(jinsAll, await bought(M1.id, DAY, DAY));
  check(`  ...a mill that bought ${j.code} and ${j2.code}: it starts on ${j.code}, as before`, both === j.id && (await daraRows(M1.id, both)) === 2,
    { startsOn: jinsAll.find((x: any) => x.id === both)?.code });
  const none = daraStartJins(jinsAll, await bought(M3.id, d(-30), d(-30)));
  check(`  ...a day the mill bought nothing: ${j.code}, as before`, none === j.id, { startsOn: jinsAll.find((x: any) => x.id === none)?.code });
  check(`  ...the same rule on its own: bought only ${j2.code} → ${j2.code}; ${j.code} and ${j2.code} → ${j.code}`, daraStartJins(jinsAll, [j2.id]) === j2.id && daraStartJins(jinsAll, [j2.id, j.id]) === j.id);
}

console.log("\nThe notes under \"Mills owe us\" and \"We owe suppliers\" add up to the figure above them");
{
  const money = await A.call("GET", `/dashboard/money?from=${FY.from}&to=${YEAR_TO}`);
  const tiles = moneyTiles(money);
  const mills = await A.call("GET", millsNow(T));
  const follow = await A.call("GET", followupNow(T));
  const ledger = await A.call("GET", suppliersNow(T));
  // plain rupees, so the figures in the words can be read back and added: +, − and the first one
  const rs = (p: number) => `₹${(p / 100).toFixed(2)}`;
  const addUp = (note: string) => {
    let sum = 0, first = true;
    for (const m of note.matchAll(/(^|[+−-]\s*|·\s*)?₹(-?\d+\.\d{2})/g)) {
      const sign = (m[1] ?? "").trim();
      const v = Math.round(Number(m[2]) * 100);
      if (first && !sign.startsWith("·")) sum += v;
      else if (sign.startsWith("+")) sum += v;
      else if (sign.startsWith("−") || sign.startsWith("-")) sum -= v;
      first = false;
    }
    return sum;
  };
  for (const [lang, t] of [["English", en], ["Hindi", hi]] as const) {
    const n = moneyNotes(t, rs, money, moneyWords(t, YEAR_TO, T).span);
    check(`${lang}: "Mills owe us" ${rs(tiles.millsOwe)} (Mill accounts ${rs(mills.totals.toReceivePaise)}, follow-up ${rs(follow.totals.toReceivePaise)}): its note adds up to it`,
      money.mills.paidAheadPaise > 0 && addUp(n.millsOwe) === tiles.millsOwe && tiles.millsOwe === mills.totals.toReceivePaise && tiles.millsOwe === follow.totals.toReceivePaise,
      { note: n.millsOwe, addsUpTo: addUp(n.millsOwe), tile: tiles.millsOwe });
    check(`${lang}: "We owe suppliers" ${rs(tiles.weOwe)} (ledger "Owed to suppliers" ${rs(ledger.totals.toPayPaise)}): its note adds up to it`,
      money.suppliers.paidAheadPaise > 0 && addUp(n.weOwe) === tiles.weOwe && tiles.weOwe === ledger.totals.toPayPaise,
      { note: n.weOwe, addsUpTo: addUp(n.weOwe), tile: tiles.weOwe });
  }
  const words = moneyNotes(en, rs, money, moneyWords(en, YEAR_TO, T).span);
  check("  ...and each names what it adds back the way Mill accounts and the ledger name it",
    words.millsOwe.includes(en("mm.totalAhead").split(" (")[0].toLowerCase()) && words.weOwe.includes(en("ledger.totalPaidAhead").split(" (")[0].toLowerCase()), words);
  const none = moneyNotes(en, rs, { ...money, mills: { ...money.mills, paidAheadPaise: 0 }, suppliers: { ...money.suppliers, paidAheadPaise: 0 } }, "all time");
  check("  ...and with nothing paid ahead there is nothing to add back", !/ahead/.test(none.millsOwe + none.weOwe), none);
}

console.log("\nThe stock page with no dates and the dashboard's \"All time\" stop at today");
{
  const late = await slip("MFX26", M1.id, j.id, d(4), 3_000_000, 300_000);   // bought for a day still to come
  const row = (rows: any[]) => rows.find((r: any) => r.merchantId === M1.id);
  const page = row(await A.call("GET", `/stock?${stockRange({})}`));
  const today = row(await A.call("GET", `/stock?to=${T}`));
  check(`stock page, no dates: MFX1 bought ${page?.boughtNet} g = bought up to today ${today?.boughtNet} g, without the slip dated ${dmy(d(4))}`,
    page?.boughtNet === today?.boughtNet && page?.stockNet === today?.stockNet, { page: page && [page.boughtNet, page.stockNet], today: today && [today.boughtNet, today.stockNet] });
  const millPage = await A.call("GET", `/stock/${M1.id}?${stockRange({ jinsId: j.id })}`);
  check("  ...and the mill's own stock page has no row for that day yet", !millPage.days.some((x: any) => x.date === d(4)));
  const picked = row(await A.call("GET", `/stock?${stockRange({ from: d(-10), to: d(10) })}`));
  check("  ...until later dates are picked", picked?.boughtNet - row(await A.call("GET", `/stock?from=${d(-10)}&to=${T}`))?.boughtNet === late.netGrams);
  const ask = (r: { from?: string; to?: string }) => {
    const qs = new URLSearchParams(); if (r.from) qs.set("from", r.from); if (r.to) qs.set("to", r.to); qs.set("asOf", T);
    return A.call("GET", `/dashboard?${qs}`);
  };
  const all = (await ask(dashboardPeriod("all", "", "", FY, T))).kpis;
  const toToday = (await ask({ to: T })).kpis;
  check(`dashboard "All time": bought ${all.boughtNetGrams} g and left ${all.leftGrams} g are those up to today`,
    all.boughtNetGrams === toToday.boughtNetGrams && all.leftGrams === toToday.leftGrams, { all: [all.boughtNetGrams, all.leftGrams], toToday: [toToday.boughtNetGrams, toToday.leftGrams] });
  const card = await A.call("GET", `/dashboard/money?to=${notAfterToday(undefined, T)}`);
  check("  ...so its \"left\" (with the slips of no mill) is the money card's", all.leftGrams + all.noMillGrams === card.stock.leftGrams, { kpi: all.leftGrams + all.noMillGrams, card: card.stock.leftGrams });
  const year = (await ask(dashboardPeriod("fy", "", "", FY, T))).kpis;
  check("  ...as \"This year\" already did", year.leftGrams === (await ask({ from: FY.from, to: T })).kpis.leftGrams);
  const custom = (await ask(dashboardPeriod("custom", d(-10), d(10), FY, T))).kpis;
  const ahead = (await A.call("GET", `/slips?from=${d(1)}&to=${d(10)}`)).totals.netGrams;
  check(`  ...and dates picked past today still count what is dated after it (the slip dated ${dmy(d(4))} among it)`,
    ahead >= late.netGrams && custom.boughtNetGrams - (await ask({ from: d(-10), to: T })).kpis.boughtNetGrams === ahead);
}

console.log("\nA mill statement with its To box empty runs to today");
{
  const cheque = await receipt(A, M2.id, d(3), 777_700);   // a post-dated cheque
  const st = await A.call("GET", `/mill-ledger/${M2.id}?${millStatementRange(FY.from, "", T)}`);
  const row = (await A.call("GET", millsNow(T))).rows.find((r: any) => r.id === M2.id);
  check(`From ${dmy(FY.from)}, To empty: the closing (${st.totals.closingPaise}) is what MFX2 owes today (${row?.balancePaise}), without the cheque dated ${dmy(d(3))}`,
    st.totals.closingPaise === row?.balancePaise && !st.entries.some((e: any) => e.id === cheque.id), { closing: st.totals.closingPaise, owes: row?.balancePaise });
  check("  ...and its CSV and print say the date it runs to: today's", st.to === T, { to: st.to });
  check("both boxes empty is still all time", millStatementRange("", "", T) === "");
  check("both boxes filled are asked as they are", millStatementRange(FY.from, d(10), T) === `from=${FY.from}&to=${d(10)}`);
}

console.log("\nThe old sync list is no longer written");
{
  const outbox = () => A.q<{ n: number }>("select count(*) n from sync_outbox")[0].n;
  const before = outbox();
  const s = await slip("MFX27", M1.id, j.id, T, 800_000, 300_000);
  check(`a slip saved: no row added to sync_outbox (${before} before, ${outbox()} after)`, outbox() === before, { before, after: outbox() });
  check("  ...and the cloud sync still has it marked to send", A.q("select 1 from _sync_dirty where tbl = 'purchase_slips' and row_id = ?", s.id).length === 1);
}

console.log("\nA computer set to London, at night in India");
{
  /* A server of its own on a new book, so the clock and the zone are its alone:
     first started to set the book up, then given an old sync list of 45,000
     rows, then started again at 01:00 in India with the zone set to London
     (20:30 the evening before there). */
  const OFF = Number(new URL(process.env.MANDI_API!).port) - 8799;
  // its own port: the desktop scripts run their servers on 8804 and 8805
  const port = 8806 + OFF;
  const dir = path.resolve("data-test-tz");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const env = { ...process.env, MANDI_DATA_DIR: dir, PORT: String(port), MANDI_API: `http://127.0.0.1:${port}/api`, MANDI_NO_SEED: "0", FAKE_NOW: "" };
  // one process (node with tsx), so stopping it stops the server; the clock is set before anything loads
  const clock = pathToFileURL(path.resolve("scripts/fake-clock.mjs")).href;
  const start = (extra: Record<string, string>) =>
    spawn(process.execPath, ["--import", clock, "--import", "tsx", "server/index.ts"], { env: { ...env, ...extra }, stdio: "ignore" });
  const up = async () => {
    for (let i = 0; i < 160; i++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return true; } catch { /* not yet */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  };
  const down = async (p: ReturnType<typeof spawn>) => {
    p.kill();
    for (let i = 0; i < 80; i++) {
      try { await fetch(`http://127.0.0.1:${port}/api/health`); } catch { return; }
      await new Promise((r) => setTimeout(r, 250));
    }
  };
  // India's date now, and 01:00 on it
  const india = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
  const night = `${india}T01:00:00+05:30`;
  let srv = start({});
  try {
    check("a new book is set up", await up());
    await down(srv);
    {
      const db = new Database(path.join(dir, "mandi.db"));
      const add = db.prepare("insert into sync_outbox (id, business_id, entity, entity_id, op, payload, attempts, created_at) values (?, null, 'purchase_slip', ?, 'insert', '{}', 0, 0)");
      db.transaction(() => { for (let i = 0; i < 45_000; i++) add.run(`old-${i}`, `slip-${i}`); })();
      db.close();
    }
    const t0 = Date.now();
    srv = start({ TZ: "Europe/London", FAKE_NOW: night });
    check(`started again at ${night} (London ${new Date(Date.parse(night)).toLocaleString("en-GB", { timeZone: "Europe/London" })})`, await up());
    const firstScreen = Date.now() - t0;
    const atStart = new Database(path.join(dir, "mandi.db"), { readonly: true });
    const waiting = (atStart.prepare("select count(*) n from sync_outbox").get() as { n: number }).n;
    atStart.close();
    check(`the server answers first (in ${firstScreen} ms) and does not wait for the old sync list (${waiting} rows still there)`, waiting === 45_000, { waiting });
    const L = computer("London", `http://127.0.0.1:${port}/api`, dir);
    await L.login("Admin", "7747");
    const span = await L.call("GET", "/days/span");
    check(`the day list's today is India's ${dmy(india)}, not London's`, span.today === india, span);
    const lm = await L.call("POST", "/merchants", { code: "LDN1", name: "Night Mill" });
    await L.call("POST", "/mill-followup/notes", { merchantId: lm.id, note: "call back", nextDate: india });
    const fu = await L.call("GET", "/mill-followup");
    check(`the follow-up counts to ${dmy(india)} and a call promised for that day is due today`,
      fu.asOf === india && fu.rows.find((r: any) => r.id === lm.id)?.dueToday === true, { asOf: fu.asOf, row: fu.rows.find((r: any) => r.id === lm.id) });
    const closed = await L.raw("POST", "/days/close", { day: india });
    check(`${dmy(india)} can be closed: it has come in India`, closed.status === 200, closed);
    // the old list is emptied after the first screen, in the background
    let left = -1;
    for (let i = 0; i < 160; i++) {
      left = L.q<{ n: number }>("select count(*) n from sync_outbox")[0].n;
      if (left === 0) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    check(`  ...then empties it in the background: the 45,000 rows are gone (${left} left)`, left === 0, { left });
  } finally {
    await down(srv);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// leave the books as they were: what this test entered counts for nothing from here on
for (const id of made.payments) await A.raw("POST", `/payments/${id}/void`, { reason: "maths test" });
for (const id of made.receipts) await A.raw("POST", `/mill-receipts/${id}/void`, { reason: "maths test" });
for (const id of made.slips) await A.raw("DELETE", `/slips/${id}`);
await settle([A, B]);

console.log(bad === 0 ? "\nThe figures and their words agree." : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
