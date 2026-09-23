import "./_guard.ts";
import { sqlite } from "../server/db/client.ts";
/* End-to-end: the Tally Prime export, on the test database. The files must
   be well-formed, every voucher must add up to zero, the vouchers must carry
   exactly the app's own totals, nothing may go twice, and a change after
   sending must be caught. Run through: npm run test:e2e */
const BASE = process.env.MANDI_API!;
let bad = 0;
const check = (label: string, ok: boolean, got?: unknown) => {
  if (!ok) bad++;
  console.log(` ${ok ? "PASS" : "FAIL"}  ${label}${ok || got === undefined ? "" : `   ${JSON.stringify(got)}`}`);
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
const me = await owner.login("Test Owner", process.env.MANDI_PIN ?? "482915");
const biz = (await owner.req("GET", "/auth/me")).json.activeBusinessId;
const call = async (m: string, p: string, b?: unknown) => { const r = await owner.req(m, p, b); if (r.status >= 400) throw new Error(`${m} ${p} ${r.status} ${JSON.stringify(r.json)}`); return r.json; };
void me;

const from = "2026-04-01", to = "2027-03-31";
const all = { from, to, kinds: ["slip", "payment", "parcha", "receipt", "cut"], onlyNew: true };

console.log("Preview");
const pv = await call("POST", "/tally/preview", all);
check("something to send", pv.vouchers > 0, pv);
check("nothing sent before", pv.alreadySent === 0 && pv.changed.length === 0);

console.log("\nThe files");
const ex = await call("POST", "/tally/export", all);
const V = ex.vouchersXml as string, M = ex.ledgersXml as string;
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;
check("vouchers file is a Tally import of vouchers", V.includes("<TALLYREQUEST>Import Data</TALLYREQUEST>") && V.includes("<REPORTNAME>Vouchers</REPORTNAME>"));
check("ledgers file is a Tally import of masters", M.includes("<REPORTNAME>All Masters</REPORTNAME>"));
check("every tag is closed", count(V, /<VOUCHER /g) === count(V, /<\/VOUCHER>/g) && count(V, /<ALLLEDGERENTRIES\.LIST>/g) === count(V, /<\/ALLLEDGERENTRIES\.LIST>/g) && count(M, /<LEDGER /g) === count(M, /<\/LEDGER>/g));
check("no bare & or < in any value", !/&(?!amp;|lt;|gt;|quot;|apos;)/.test(V + M));
check("one voucher per entry counted", count(V, /<VOUCHER /g) === ex.vouchers, { xml: count(V, /<VOUCHER /g), said: ex.vouchers });
const vouchers = V.split("<VOUCHER ").slice(1).map((v) => {
  const lines = [...v.matchAll(/<LEDGERNAME>([^<]*)<\/LEDGERNAME><ISDEEMEDPOSITIVE>(Yes|No)<\/ISDEEMEDPOSITIVE><AMOUNT>(-?\d+\.\d\d)<\/AMOUNT>/g)]
    .map((m) => ({ ledger: m[1], deemed: m[2], paise: Math.round(Number(m[3]) * 100) }));
  return { type: v.match(/VCHTYPE="([^"]*)"/)![1], date: v.match(/<DATE>(\d{8})<\/DATE>/)?.[1], lines };
});
check("every voucher adds up to exactly zero", vouchers.every((v) => v.lines.reduce((s, l) => s + l.paise, 0) === 0), vouchers.filter((v) => v.lines.reduce((s, l) => s + l.paise, 0) !== 0).slice(0, 2));
check("a debit is negative and deemed positive, a credit positive", vouchers.every((v) => v.lines.every((l) => (l.paise < 0) === (l.deemed === "Yes"))));
check("dates are YYYYMMDD inside the year", vouchers.every((v) => v.date && v.date >= "20260401" && v.date <= "20270331"));
const ledgerNames = new Set([...M.matchAll(/<LEDGER NAME="([^"]*)"/g)].map((m) => m[1]));
check("every ledger a voucher uses is in the ledgers file", vouchers.every((v) => v.lines.every((l) => ledgerNames.has(l.ledger))),
  [...new Set(vouchers.flatMap((v) => v.lines.map((l) => l.ledger)).filter((n) => !ledgerNames.has(n)))]);

console.log("\nThe vouchers carry the app's own totals");
const credit = (type: string, ledger?: string) => vouchers.filter((v) => v.type === type).reduce((s, v) => s + v.lines.filter((l) => l.paise > 0 && (!ledger || l.ledger === ledger)).reduce((a, l) => a + l.paise, 0), 0);
const debit = (type: string, ledger?: string) => vouchers.filter((v) => v.type === type).reduce((s, v) => s + v.lines.filter((l) => l.paise < 0 && (!ledger || l.ledger === ledger)).reduce((a, l) => a - l.paise, 0), 0);
const q = <T,>(sql: string, ...a: unknown[]) => sqlite.prepare(sql).get(...a) as T;
const slips = q<{ amount: number; payable: number; commission: number; gaushala: number }>(
  "select coalesce(sum(amount_paise),0) as amount, coalesce(sum(payable_paise),0) as payable, coalesce(sum(commission_paise),0) as commission, coalesce(sum(gaushala_paise),0) as gaushala from purchase_slips where business_id = ? and slip_date between ? and ? and rate_paise_per_qtl > 0", biz, from, to);
check("purchases: suppliers credited with the net amount of every priced slip", credit("Purchase") === slips.payable, { tally: credit("Purchase"), app: slips.payable });
check("…purchase debited with the goods, commission and gaushala as their own lines",
  debit("Purchase", "Purchase") === slips.amount && debit("Purchase", "Commission Paid") === slips.commission && debit("Purchase", "Gaushala Paid") === slips.gaushala);
const pays = q<{ p: number }>("select coalesce(sum(amount_paise),0) as p from payments where business_id = ? and voided_at is null and pay_date between ? and ?", biz, from, to).p;
check("payments: suppliers debited with every payment not cancelled", debit("Payment") === pays, { tally: debit("Payment"), app: pays });
const sales = q<{ p: number }>("select coalesce(sum(grand_total_paise),0) as p from parchas where business_id = ? and status = 'approved' and invoice_date between ? and ?", biz, from, to).p;
check("sales: mills debited with every approved parcha's grand total", debit("Sales") === sales, { tally: debit("Sales"), app: sales });
const recs = q<{ p: number }>("select coalesce(sum(amount_paise + deduction_paise),0) as p from mill_receipts where business_id = ? and voided_at is null and receipt_date between ? and ?", biz, from, to).p;
check("receipts: mills credited with the money and what they held back", credit("Receipt") === recs, { tally: credit("Receipt"), app: recs });

console.log("\nNothing twice");
await call("POST", "/tally/mark", { entries: ex.entries });
const again = await call("POST", "/tally/preview", all);
check("after Tally took them, nothing is left to send", again.vouchers === 0 && again.alreadySent === ex.entries.length, again);
const full = await call("POST", "/tally/preview", { ...all, onlyNew: false });
check("…unless asked to send everything again", full.vouchers === pv.vouchers);

console.log("\nA change after sending");
const slip = sqlite.prepare("select id, rate_paise_per_qtl as r from purchase_slips where business_id = ? and rate_paise_per_qtl > 0 and slip_date between ? and ? limit 1").get(biz, from, to) as { id: string; r: number };
await call("PUT", `/slips/${slip.id}`, { ratePaisePerQtl: slip.r + 1000 });
const ch = await call("POST", "/tally/preview", all);
const it = ch.changed.find((c: any) => c.id === slip.id);
check("a slip re-priced after sending is listed for fixing in Tally", Boolean(it) && it.now !== it.sent, ch.changed);
check("…and is not sent again by itself", ch.vouchers === 0);
await call("POST", "/tally/fixed", { kind: it.kind, id: it.id, now: it.now });
check("once put right in Tally it leaves the list", !(await call("POST", "/tally/preview", all)).changed.some((c: any) => c.id === slip.id));
await call("PUT", `/slips/${slip.id}`, { ratePaisePerQtl: slip.r });

console.log("\nNames and rights");
const cfg = await call("GET", "/tally/settings");
await call("PUT", "/tally/settings", { ...cfg, ledgers: { ...cfg.ledgers, purchase: "Purchase A&B" } });
const named = await call("POST", "/tally/export", { ...all, onlyNew: false });
check("a ledger name from Settings is used, & written as &amp;", named.vouchersXml.includes("<LEDGERNAME>Purchase A&amp;B</LEDGERNAME>"));
check("the single file carries the ledgers before the vouchers", (() => {
  const A = named.allXml as string;
  const firstVoucher = A.indexOf("<VOUCHER ");
  const lastLedger = A.lastIndexOf("<LEDGER ");
  return A.includes("<REPORTNAME>All Masters</REPORTNAME>") && lastLedger > 0 && firstVoucher > lastLedger;
})());
check("…and every ledger a voucher uses is in it", (() => {
  const A = named.allXml as string;
  const made = new Set([...A.matchAll(/<LEDGER NAME="([^"]+)"/g)].map((m) => m[1]));
  const used = [...A.matchAll(/<LEDGERNAME>([^<]+)<\/LEDGERNAME>/g)].map((m) => m[1]);
  return used.every((u) => made.has(u));
})());

console.log("\nGroups and voucher types the company may not have");
await call("PUT", "/tally/settings", { ...cfg, supplierGroup: "Arhat Suppliers", voucherTypes: { ...cfg.voucherTypes, purchase: "Kaccha Kharid" } });
const custom = await call("POST", "/tally/export", { ...all, onlyNew: false });
check("a group of its own is created before it is used", (() => {
  const A = custom.allXml as string;
  return A.includes('<GROUP NAME="Arhat Suppliers"') && A.indexOf("<GROUP ") < A.indexOf("<LEDGER ");
})());
check("  ...under a group Tally has", (custom.allXml as string).includes("<PARENT>Sundry Creditors</PARENT>"));
check("a voucher type of its own is created too", (() => {
  const A = custom.allXml as string;
  return A.includes('<VOUCHERTYPE NAME="Kaccha Kharid"') && A.indexOf("<VOUCHERTYPE ") < A.indexOf("<VOUCHER ");
})());
check("  ...behaving like a purchase", /<VOUCHERTYPE NAME="Kaccha Kharid"[\s\S]{0,200}<PARENT>Purchase<\/PARENT>/.test(custom.allXml));
check("Tally's own groups and types are not re-created", !(custom.allXml as string).includes('<GROUP NAME="Sundry Debtors"') && !(custom.allXml as string).includes('<VOUCHERTYPE NAME="Payment"'));
await call("PUT", "/tally/settings", cfg);
const op = session();
await op.login("Munshi Ji", "271830");
check("an operator cannot export to Tally", (await op.req("POST", "/tally/preview", all)).status === 403);

console.log(bad === 0 ? "\nTally export ties out." : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
