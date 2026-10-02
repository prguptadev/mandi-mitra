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
 * Runs after the sync test, on the books it leaves behind (A and B joined).
 * Run through: npm run test:e2e
 */
import path from "node:path";
import Database from "better-sqlite3";
import { shiftDay, dmy } from "../server/lib/parchaLabels.ts";
import { notAfterToday, suppliersNow, millsNow, followupNow, statementRange } from "../src/lib/asOfToday.ts";
import { moneyTiles, moneyWords, ledgerProof } from "../src/lib/moneyFigures.ts";
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

// leave the books as they were: what this test entered counts for nothing from here on
for (const id of made.payments) await A.raw("POST", `/payments/${id}/void`, { reason: "maths test" });
for (const id of made.receipts) await A.raw("POST", `/mill-receipts/${id}/void`, { reason: "maths test" });
for (const id of made.slips) await A.raw("DELETE", `/slips/${id}`);
await settle([A, B]);

console.log(bad === 0 ? "\nThe figures and their words agree." : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
