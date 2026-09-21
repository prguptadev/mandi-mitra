import "./_guard.ts";
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
check("a slip with no rate yet is worth 0 until priced", s3.amountPaise === 0);

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
check("balance = 5,000 + 67,320 + 35,845.50 − 50,000 − 30,000 = 28,165.50", row.balancePaise === rs(28165.50), row.balancePaise);
check("purchases 1,03,165.50 over 3 slips, 1 without a rate", row.purchasesPaise === rs(103165.50) && row.slips === 3 && row.unpriced === 1, row);
const sum = list.rows.reduce((s: number, r: any) => s + r.balancePaise, 0);
check("the list's total is the sum of its rows", list.totals.balancePaise === sum);
check("opening + purchases − payments = total balance", list.totals.openingPaise + list.totals.purchasesPaise - list.totals.paymentsPaise === list.totals.balancePaise);

let st = await call("GET", `/ledger/${A}`);
check("statement starts from the opening 5,000.00", st.broughtForwardPaise === rs(5000));
check("entries in date order, purchases before payments within a day",
  st.entries.map((e: any) => `${e.date}:${e.kind[1]}`).join(" ") === "2026-09-27:u 2026-09-27:u 2026-09-27:a 2026-09-28:u 2026-09-28:a",
  st.entries.map((e: any) => `${e.date}:${e.kind}`));
const runs = st.entries.map((e: any) => e.balancePaise);
check("running balance: 72,320 → 1,08,165.50 → 58,165.50 → 58,165.50 → 28,165.50",
  JSON.stringify(runs) === JSON.stringify([rs(72320), rs(108165.50), rs(58165.50), rs(58165.50), rs(28165.50)]), runs.map((x: number) => x / 100));
check("closing matches the list", st.totals.closingPaise === row.balancePaise);

st = await call("GET", `/ledger/${A}?from=2026-09-28`);
check("from 28-09: brought forward 58,165.50", st.broughtForwardPaise === rs(58165.50), st.broughtForwardPaise);
check("from 28-09: two entries, closing still 28,165.50", st.entries.length === 2 && st.totals.closingPaise === rs(28165.50));
st = await call("GET", `/ledger/${A}?to=2026-09-27`);
check("to 27-09: closing 58,165.50", st.totals.closingPaise === rs(58165.50), st.totals.closingPaise);
const asOf = await call("GET", "/ledger?asOf=2026-09-27");
check("list as of 27-09 agrees", asOf.rows.find((r: any) => r.id === A).balancePaise === rs(58165.50));

console.log("\nEdit, delete, overpay, price a slip");
await call("PUT", `/payments/${p2.id}`, { amountPaise: rs(32000) });
row = (await call("GET", "/ledger")).rows.find((r: any) => r.id === A);
check("editing 30,000 → 32,000 lowers the balance by 2,000", row.balancePaise === rs(26165.50), row.balancePaise);
const noWhy = await raw("POST", `/payments/${p2.id}/void`, { reason: "" });
check("cancelling a payment needs a reason", noWhy.status === 400);
await call("POST", `/payments/${p2.id}/void`, { reason: "paid twice by mistake" });
row = (await call("GET", "/ledger")).rows.find((r: any) => r.id === A);
check("cancelling it puts 32,000 back", row.balancePaise === rs(58165.50), row.balancePaise);
check("a cancelled payment cannot be edited", (await raw("PUT", `/payments/${p2.id}`, { amountPaise: 1 })).status === 409);
const stV = await call("GET", `/ledger/${A}`);
check("…but stays on the statement, struck, counting nothing", stV.entries.some((e: any) => e.id === p2.id && e.voided && e.debitPaise === 0));
const withVoid = await call("GET", `/payments?adatiId=${A}&showVoid=1`);
check("the payments list shows it only when asked", withVoid.rows.some((p: any) => p.id === p2.id && p.voidedAt));
const p3 = await call("POST", "/payments", { adatiId: A, payDate: "2026-09-29", amountPaise: rs(60000), mode: "bank" });
list = await call("GET", "/ledger");
row = list.rows.find((r: any) => r.id === A);
check("paying 60,000 against 58,165.50 leaves 1,834.50 paid ahead", row.balancePaise === -rs(1834.50), row.balancePaise);
check("paid-ahead total includes it", list.totals.paidAheadPaise >= rs(1834.50));
await call("PUT", `/slips/${s3.id}`, { ratePaisePerQtl: 350_000 });
row = (await call("GET", "/ledger")).rows.find((r: any) => r.id === A);
check("pricing the 4.95 qtl slip at 3500 adds 17,325.00", row.balancePaise === -rs(1834.50) + rs(17325), row.balancePaise);

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
check("…and stays on the ledger with its balance", Boolean(still) && still.balancePaise === -rs(1834.50) + rs(17325), still?.balancePaise);

console.log(bad === 0 ? "\nLedger and payments add up." : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
