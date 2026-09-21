import "./_guard.ts";
/* End-to-end: two businesses on one computer are two separate sets of books.
   Everything business A sees is recorded, then a whole day of work is done
   in business B — a supplier and a mill with the same names and codes as
   A's, slips with A's RST numbers on A's busiest day, a payment, money from
   the mill, a truck billed with A's parcha number, a closed day, a call
   note, Tally sent, and B's own charges and Tally names. Afterwards A must
   see exactly what it saw before, and neither business can read, change or
   use the other's records. Run through: npm run test:e2e */
const BASE = process.env.MANDI_API!;
let bad = 0;
const check = (label: string, ok: boolean, got?: unknown) => {
  if (!ok) bad++;
  console.log(` ${ok ? "PASS" : "FAIL"}  ${label}${ok || got === undefined ? "" : `   ${JSON.stringify(got).slice(0, 400)}`}`);
};
let cookie = "";
const req = async (method: string, p: string, body?: unknown) => {
  const res = await fetch(BASE + p, { method, headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = res.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
};
const call = async (m: string, p: string, b?: unknown) => { const r = await req(m, p, b); if (r.status >= 400) throw new Error(`${m} ${p} ${r.status} ${JSON.stringify(r.json)}`); return r.json; };
const users = (await req("GET", "/auth/users")).json;
await call("POST", "/auth/login", { userId: users.find((u: any) => u.name === "Test Owner").id, pin: process.env.MANDI_PIN ?? "482915" });
let me = await call("GET", "/auth/me");
const A = me.businesses.find((b: any) => b.shortCode === "VLDM").businessId;
const use = async (biz: string) => { await call("POST", "/auth/switch-business", { businessId: biz }); };
await use(A);

const FY = "from=2026-04-01&to=2027-03-31";
const all = { from: "2026-04-01", to: "2027-03-31", kinds: ["slip", "payment", "parcha", "receipt", "cut"], onlyNew: true };
// A's busiest day up to today (a day to come cannot be closed)
const today = new Date().toLocaleDateString("en-CA");
const aDays = (await call("GET", `/days?${FY}`)).days.filter((d: any) => d.day <= today).sort((x: any, y: any) => y.slips - x.slips);
const D: string = aDays[0]?.day ?? today;
/** Everything business A shows: lists, ledgers, reports, the dashboard, Tally, day close, follow-up, settings. */
async function seen() {
  const out: Record<string, unknown> = {};
  for (const p of [
    `/slips?${FY}`, `/slips?date=${D}`, "/adati", "/merchants", "/jins", "/orders", "/loads", `/parchas?${FY}`,
    `/payments?${FY}`, `/mill-receipts?${FY}`, "/ledger", "/mill-ledger", "/mill-followup", `/days?${FY}`, `/days/one?day=${D}`,
    `/dashboard?${FY}`, "/settings/supplier-charges", "/tally/settings", `/tally/flags?kind=slip&${FY}`, `/tally/flags?kind=parcha&${FY}`,
  ]) out[p] = (await call("GET", p));
  out["tally/preview"] = await call("POST", "/tally/preview", all);
  out["tally/days"] = await call("POST", "/tally/days", all);
  const ex = await call("POST", "/tally/export", all);
  out["tally/export"] = { v: ex.vouchersXml, l: ex.ledgersXml };
  return out;
}
const before = await seen();
const aSup = (before["/adati"] as any[])[0];
const aMill = (before["/merchants"] as any[]).find((m: any) => m.code === "LB");
const aSlipsD = (before[`/slips?date=${D}`] as any).rows;
check("business A has work to compare against", aSlipsD.length > 5 && Boolean(aSup) && Boolean(aMill), { slips: aSlipsD.length });

console.log("A second business, set up like the first");
const made = await call("POST", "/auth/businesses", { name: "Isolation Test Traders", nameHi: "अलग जाँच ट्रेडर्स", shortCode: "ISO" });
me = await call("GET", "/auth/me");
const B = me.businesses.find((b: any) => b.shortCode === "ISO").businessId;
check("the new business exists", Boolean(B) && B !== A, made);
await use(B);
check("…and starts empty", (await call("GET", `/slips?${FY}`)).rows.length === 0 && (await call("GET", "/adati")).length === 0 && (await call("GET", "/merchants")).length === 0);
const bJins = (await call("GET", "/jins"))[0];
check("…with its own commodity list", Boolean(bJins) && !(before["/jins"] as any[]).some((j: any) => j.id === bJins.id));
const bSup = await call("POST", "/adati", { nameHi: aSup.nameHi, openingBalanceRupees: 1000 });
check("a supplier with A's exact Hindi name is allowed in B", Boolean(bSup.id) && bSup.id !== aSup.id);
const bMill = await call("POST", "/merchants", { code: "LB", name: "Isolation Mill" });
check("a mill with A's short code LB is allowed in B", Boolean(bMill.id) && bMill.id !== aMill.id);
// B charges suppliers differently and names things its own way in Tally
const sc = await call("GET", "/settings/supplier-charges");
await call("PUT", "/settings/supplier-charges", { ...sc, commissionPct: 2, gaushalaPerQtl: 3 });
const ts = await call("GET", "/tally/settings");
await call("PUT", "/tally/settings", { ...ts, companyName: "ISO Books", ledgers: { ...ts.ledgers, purchase: "ISO Purchase" } });

const q = (qtl: number) => Math.round(qtl * 100_000);
const bSlips = [];
for (const [rst, gross] of [[aSlipsD[0].rstNo, 20], [aSlipsD[1].rstNo, 30.5]] as [string, number][]) {
  const s = await call("POST", "/slips", { slipDate: D, rstNo: rst, adatiId: bSup.id, jinsId: bJins.id, merchantId: bMill.id, grossGrams: q(gross), ratePaisePerQtl: 350_000 });
  check(`B's slip with A's RST ${rst} is not flagged as a repeat`, s.rstRepeated === false, s);
  bSlips.push(s);
}
check("B's slips take B's charges (2 %)", bSlips[0].commissionPaise === Math.round(bSlips[0].amountPaise * 0.02), bSlips[0]);
const bPay = await call("POST", "/payments", { adatiId: bSup.id, payDate: D, amountPaise: 1_000_000, mode: "cash" });
const bRec = await call("POST", "/mill-receipts", { merchantId: bMill.id, receiptDate: D, amountPaise: 500_000 });
// a truck billed with a parcha number A already uses
const aParchaNo = (before[`/parchas?${FY}`] as any[]).find((p: any) => p.status === "approved")?.parchaNo ?? "196";
const bLoad = await call("POST", "/loads", { loadDate: D, merchantId: bMill.id, jinsId: bJins.id, stockDate: D, truckNo: "UP00ISO1" });
await call("PUT", `/loads/${bLoad.id}`, { millGrossGrams: q(50.3), katteCount: 100, boreCount: 0, invoiceNo: aParchaNo, invoiceDate: D });
const bState = await call("GET", `/loads/${bLoad.id}`);
check("B's truck is ready to bill", bState.blockers.length === 0, bState.blockers);
const ap = await req("POST", `/loads/${bLoad.id}/approve`, { expectedGrandTotalPaise: bState.doc?.result.grandTotalPaise });
check(`B bills its truck as parcha #${aParchaNo}, a number A already used`, ap.status === 200, ap.json);
await call("POST", "/mill-followup/notes", { merchantId: bMill.id, note: "ISO call", nextDate: D });
await call("POST", "/days/close", { day: D });
const bEx = await call("POST", "/tally/export", all);
check("B's Tally file carries B's own company and ledger names", bEx.vouchersXml.includes("ISO Books") && bEx.vouchersXml.includes("ISO Purchase"));
await call("POST", "/tally/mark", { entries: bEx.entries });

console.log("\nB sees only its own work");
const bDay = await call("GET", `/slips?date=${D}`);
check("B's daily list holds exactly B's two slips", bDay.rows.length === 2 && bDay.rows.every((r: any) => bSlips.some((s: any) => s.id === r.id)), bDay.rows.length);
const bLedger = await call("GET", "/ledger");
check("B's supplier ledger has only B's supplier", bLedger.rows.every((r: any) => r.adatiId === bSup.id || r.id === bSup.id), bLedger.rows.length);
const bMills = await call("GET", "/mill-ledger");
check("B's mill accounts have only B's mill", bMills.rows.length === 1 && bMills.rows[0].id === bMill.id, bMills.rows.map((r: any) => r.code));
check("B's day is closed in B", Boolean((await call("GET", `/days/one?day=${D}`)).closed));

console.log("\nA sees exactly what it saw before");
await use(A);
const after = await seen();
for (const k of Object.keys(before)) {
  check(`A: ${k} unchanged`, JSON.stringify(after[k]) === JSON.stringify(before[k]));
}

console.log("\nA cannot reach B's records");
const refused = (r: { status: number }) => r.status === 404 || r.status === 400;
check("A cannot change B's slip", refused(await req("PUT", `/slips/${bSlips[0].id}`, { ratePaisePerQtl: 1 })));
check("A cannot delete B's slip", refused(await req("DELETE", `/slips/${bSlips[0].id}`)));
check("A cannot move B's slips", refused(await req("POST", "/slips/reassign", { slipIds: [bSlips[0].id], merchantId: null })));
check("A cannot change B's payment", refused(await req("PUT", `/payments/${bPay.id}`, { amountPaise: 1 })));
check("A cannot cancel B's payment", refused(await req("POST", `/payments/${bPay.id}/void`, { reason: "cross check" })));
check("A cannot change B's money from the mill", refused(await req("PUT", `/mill-receipts/${bRec.id}`, { amountPaise: 1 })));
check("A cannot cancel it", refused(await req("POST", `/mill-receipts/${bRec.id}/void`, { reason: "cross check" })));
check("A cannot open B's truck", refused(await req("GET", `/loads/${bLoad.id}`)));
check("A cannot change B's truck", refused(await req("PUT", `/loads/${bLoad.id}`, { truckNo: "X" })));
check("A cannot put a mill cut on B's truck", refused(await req("PUT", `/challan/${bLoad.id}`, { deductionGrams: 1000 })));
check("A cannot void B's parcha", refused(await req("POST", `/parchas/${ap.json?.id}/void`, { reason: "cross check" })));
check("A cannot open B's mill statement", refused(await req("GET", `/mill-ledger/${bMill.id}`)));
check("A cannot change B's mill", refused(await req("PUT", `/merchants/${bMill.id}`, { name: "X" })));
check("A cannot change B's supplier", refused(await req("PUT", `/adati/${bSup.id}`, { nameHi: "एक्स" })));
check("A sees none of B's call notes", (await call("GET", `/mill-followup/notes/${bMill.id}`)).rows.length === 0);
console.log("\nA cannot use B's suppliers, mills or commodities");
check("no slip in A for B's supplier", refused(await req("POST", "/slips", { slipDate: "2026-09-26", rstNo: "ISO1", adatiId: bSup.id, jinsId: (before["/jins"] as any[])[0].id, merchantId: aMill.id, grossGrams: q(10), ratePaisePerQtl: 0 })));
check("no slip in A for B's mill", refused(await req("POST", "/slips", { slipDate: "2026-09-26", rstNo: "ISO2", adatiId: aSup.id, jinsId: (before["/jins"] as any[])[0].id, merchantId: bMill.id, grossGrams: q(10), ratePaisePerQtl: 0 })));
check("no slip in A with B's commodity", refused(await req("POST", "/slips", { slipDate: "2026-09-26", rstNo: "ISO3", adatiId: aSup.id, jinsId: bJins.id, merchantId: aMill.id, grossGrams: q(10), ratePaisePerQtl: 0 })));
check("no payment in A to B's supplier", refused(await req("POST", "/payments", { adatiId: bSup.id, payDate: "2026-09-26", amountPaise: 100, mode: "cash" })));
check("no money from B's mill recorded in A", refused(await req("POST", "/mill-receipts", { merchantId: bMill.id, receiptDate: "2026-09-26", amountPaise: 100 })));
check("no truck in A for B's mill", refused(await req("POST", "/loads", { loadDate: "2026-09-26", merchantId: bMill.id, jinsId: (before["/jins"] as any[])[0].id })));
check("no call note in A for B's mill", refused(await req("POST", "/mill-followup/notes", { merchantId: bMill.id, note: "x" })));
const mk = await call("POST", "/tally/mark", { entries: bEx.entries.slice(0, 3) });
check("A cannot mark B's entries as sent to Tally", mk.marked === 0 && mk.notThisBusiness === Math.min(3, bEx.entries.length), mk);
const onlyB = await call("POST", "/tally/export", { ...all, adatiId: bSup.id });
check("A's Tally file for B's supplier is empty", onlyB.vouchers === 0);

console.log("\nB's closed day does not lock A");
const aNew = await req("POST", "/slips", { slipDate: D, rstNo: "ISO-A", adatiId: aSup.id, jinsId: (before["/jins"] as any[])[0].id, merchantId: aMill.id, grossGrams: q(10), ratePaisePerQtl: 0 });
check("A adds a slip on the day B closed", aNew.status === 200, aNew.json);
check("…and removes it again", (await req("DELETE", `/slips/${aNew.json?.id}`)).status === 200);
check("A's day shows open", (await call("GET", `/days/one?day=${D}`)).closed === null);

console.log("\nB cannot reach A's records either");
await use(B);
check("B cannot change A's slip", refused(await req("PUT", `/slips/${aSlipsD[0].id}`, { ratePaisePerQtl: 1 })));
check("B cannot open A's mill statement", refused(await req("GET", `/mill-ledger/${aMill.id}`)));
check("B cannot pay A's supplier", refused(await req("POST", "/payments", { adatiId: aSup.id, payDate: "2026-09-26", amountPaise: 100, mode: "cash" })));
check("B's lists still hold only B's", (await call("GET", `/slips?${FY}`)).rows.length === 2 && (await call("GET", "/adati")).length === 1);
await use(A);

console.log(bad ? `\n${bad} FAILED` : "\nall passed");
process.exit(bad ? 1 : 0);
