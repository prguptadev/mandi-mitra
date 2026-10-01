import "./_guard.ts";
/* End-to-end: what an accountant checks. Voucher numbers run 1, 2, 3… per
   business and start again each financial year; a cancelled voucher keeps
   its number; the Tally files carry the numbers and the parties' opening
   balances; the books check re-works every figure and finds nothing wrong;
   an operator cannot run it. Run through: npm run test:e2e */
const BASE = process.env.MANDI_API!;
let bad = 0;
const check = (label: string, ok: boolean, got?: unknown) => {
  if (!ok) bad++;
  console.log(` ${ok ? "PASS" : "FAIL"}  ${label}${ok || got === undefined ? "" : `   ${JSON.stringify(got).slice(0, 300)}`}`);
};
function session() {
  let cookie = "";
  const req = async (method: string, p: string, body?: unknown) => {
    const res = await fetch(BASE + p, { method, headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = res.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  const login = async (name: string, pin: string) => {
    const users = (await req("GET", "/auth/users")).json;
    await req("POST", "/auth/login", { userId: users.find((u: any) => u.name === name).id, pin });
    const me = (await req("GET", "/auth/me")).json;
    const v = me.businesses.find((b: any) => b.shortCode === "VLDM");
    if (v && me.activeBusinessId !== v.businessId) await req("POST", "/auth/switch-business", { businessId: v.businessId });
    return me;
  };
  return { req, login };
}
const owner = session();
await owner.login("Test Owner", process.env.MANDI_PIN ?? "482915");
const call = async (m: string, p: string, b?: unknown) => { const r = await owner.req(m, p, b); if (r.status >= 400) throw new Error(`${m} ${p} ${r.status} ${JSON.stringify(r.json)}`); return r.json; };
const rs = (r: number) => Math.round(r * 100);

console.log("Voucher numbers");
const sup = (await call("GET", "/adati")).find((a: any) => a.nameHi === "खाता जाँच ट्रेडर्स") ?? (await call("GET", "/adati"))[0];
const mills = await call("GET", "/merchants");
const lb = mills.find((m: any) => m.code === "LB");
const before = (await call("GET", "/payments?from=2026-04-01&to=2027-03-31")).rows;
const maxPv = Math.max(0, ...before.map((p: any) => p.voucherNo ?? 0));
check("every payment already on file carries a number", before.every((p: any) => p.voucherNo >= 1), before.map((p: any) => p.voucherNo));
const p1 = await call("POST", "/payments", { adatiId: sup.id, payDate: "2026-10-05", amountPaise: rs(1000), mode: "cash" });
const p2 = await call("POST", "/payments", { adatiId: sup.id, payDate: "2026-10-05", amountPaise: rs(2000), mode: "bank", reference: "UTR1" });
check("two new payments take the next two numbers", p1.voucherNo === maxPv + 1 && p2.voucherNo === maxPv + 2, { maxPv, p1: p1.voucherNo, p2: p2.voucherNo });
const pNext = await call("POST", "/payments", { adatiId: sup.id, payDate: "2027-04-02", amountPaise: rs(500), mode: "cash" });
check("a payment in the next financial year starts again at 1", pNext.voucherNo === 1, pNext);
await call("POST", `/payments/${p1.id}/void`, { reason: "ca test" });
const after = (await call("GET", "/payments?from=2026-04-01&to=2027-03-31&showVoid=1")).rows;
check("a cancelled payment keeps its number", after.find((p: any) => p.id === p1.id)?.voucherNo === maxPv + 1);
const p3 = await call("POST", "/payments", { adatiId: sup.id, payDate: "2026-10-06", amountPaise: rs(300), mode: "cash" });
check("…and the next one is not given that number again", p3.voucherNo === maxPv + 3, p3);
const st = await call("GET", `/ledger/${sup.id}`);
check("the supplier statement shows the number on the payment", st.entries.some((e: any) => e.kind === "payment" && e.voucherNo === p2.voucherNo));
const r1 = await call("POST", "/mill-receipts", { merchantId: lb.id, receiptDate: "2026-10-05", amountPaise: rs(10000), mode: "bank" });
const r2 = await call("POST", "/mill-receipts", { merchantId: lb.id, receiptDate: "2026-10-05", amountPaise: rs(20000), mode: "rtgs" });
check("mill receipts are numbered on their own", r1.voucherNo >= 1 && r2.voucherNo === r1.voucherNo + 1, { r1: r1.voucherNo, r2: r2.voucherNo });
const ms = await call("GET", `/mill-ledger/${lb.id}`);
check("the mill statement shows the number on the receipt", ms.entries.some((e: any) => e.kind === "receipt" && e.voucherNo === r2.voucherNo));

console.log("\nTally carries the numbers and the openings");
const ex = await call("POST", "/tally/export", { from: "2026-04-01", to: "2027-03-31", kinds: ["slip", "payment", "parcha", "receipt", "cut"], onlyNew: false });
check("payment vouchers carry PV numbers", ex.vouchersXml.includes(`<VOUCHERNUMBER>PV-${p2.voucherNo}</VOUCHERNUMBER>`));
check("receipt vouchers carry RV numbers", ex.vouchersXml.includes(`<VOUCHERNUMBER>RV-${r2.voucherNo}</VOUCHERNUMBER>`));
const supFull = await call("GET", `/adati/${sup.id}`);
if (supFull.openingBalancePaise) {
  const sign = supFull.openingBalancePaise > 0 ? "" : "-";
  check("a supplier's opening balance goes on its ledger (credit positive)", ex.ledgersXml.includes(`<OPENINGBALANCE>${sign}${Math.abs(supFull.openingBalancePaise / 100).toFixed(2)}</OPENINGBALANCE>`), supFull.openingBalancePaise);
} else console.log(" skip  the test supplier has no opening balance");
const lbFull = mills.find((m: any) => m.id === lb.id);
const lbOpening = (await call("GET", "/mill-ledger")).rows.find((m: any) => m.id === lb.id)?.openingBalancePaise ?? 0;
if (lbOpening) {
  check("a mill's opening balance goes on its ledger as a debit (negative in Tally)", ex.ledgersXml.includes(`<OPENINGBALANCE>-${(lbOpening / 100).toFixed(2)}</OPENINGBALANCE>`), { lbOpening, name: lbFull?.name });
} else console.log(" skip  the test mill has no opening balance");
check("a ledger with no opening has no opening line", !/<PARENT>Purchase Accounts<\/PARENT>\n<OPENINGBALANCE>/.test(ex.ledgersXml));

console.log("\nThe books check");
/* A truck row taken from a day with no slips under that mill (the firm's own
   stock sold to it, or a truck entered before its slips): it is goods gone out
   that were never counted in, so both screens take it off stock — once. */
const jAll = await call("GET", "/jins");
const noSlipDay = await call("POST", "/loads", { loadDate: "2026-10-05", merchantId: lb.id, jinsId: (jAll.find((j: any) => j.code === "1509") ?? jAll[0]).id, stockDate: "2026-08-20" });
{
  const st = await call("GET", `/loads/${noSlipDay.id}`);
  await call("PUT", `/loads/${noSlipDay.id}/lines/${st.lines[0].id}`, { netGrams: 2_000_000, ratePaisePerQtl: rs(3500) });
}
const bc = await call("GET", "/audit/books-check");
check("it re-works this business only", bc.businesses.length === 1);
check("every figure re-works exactly", bc.problems === 0, bc.businesses[0]?.sections.flatMap((s: any) => s.lines.filter((l: any) => l.ok === false).map((l: any) => l.text)));
check("it covers slips, ledgers, parchas, mills, stock and voucher numbers", bc.businesses[0]?.sections.length >= 7, bc.businesses[0]?.sections.map((s: any) => s.title));
check("voucher numbers are one each, none repeated", bc.businesses[0]?.sections.find((s: any) => s.title.startsWith("6."))?.lines.every((l: any) => l.ok !== false));
{
  // one story for a CA: the audit's net position is the dashboard money card's, to the paisa
  const m = await call("GET", "/dashboard/money");
  const dashNet = (m.mills.toReceivePaise - m.mills.paidAheadPaise) + m.stock.valuePaise + m.stock.unbilledGoodsPaise
    + (m.cash.receivedFromMillsPaise - m.cash.paidToSuppliersPaise) - (m.suppliers.toPayPaise - m.suppliers.paidAheadPaise);
  const rsOf = (p: number) => (p / 100 + 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const lines7 = bc.businesses[0]?.sections.find((s: any) => s.title.startsWith("7."))?.lines ?? [];
  const netLine = lines7.find((l: any) => l.text.startsWith("net ("))?.text ?? "";
  check("the books check's net position is the dashboard's (with a truck row from a day with no slips)", netLine.includes(`₹${rsOf(dashNet)} `), { netLine, dashNet });
  check("  ...its stock is valued the way the dashboard values it", lines7.some((l: any) => l.text.startsWith(`stock in hand ₹${rsOf(m.stock.valuePaise)} (${(m.stock.leftGrams / 100_000).toFixed(2)} qtl`)), { lines7, stock: m.stock });
  // more loaded than bought is never shown with a tick: it is a line to look at
  const stock5 = bc.businesses[0]?.sections.find((s: any) => s.title.startsWith("5."))?.lines ?? [];
  check("negative stock is never a tick", stock5.filter((l: any) => /more loaded than bought|took more from/.test(l.text)).every((l: any) => l.ok === null && l.warn === true), stock5);
}
const op = session();
await op.login("Munshi Ji", "271830");
check("an operator cannot run the books check", (await op.req("GET", "/audit/books-check")).status === 403);
// leave the ledger as the money tests expect it: the extra payments and receipts are cancelled
for (const id of [p2.id, pNext.id, p3.id]) await call("POST", `/payments/${id}/void`, { reason: "ca test cleanup" });
for (const id of [r1.id, r2.id]) await call("POST", `/mill-receipts/${id}/void`, { reason: "ca test cleanup" });
await call("DELETE", `/loads/${noSlipDay.id}`);

console.log(bad ? `\n${bad} FAILED` : "\nall passed");
process.exit(bad ? 1 : 0);
