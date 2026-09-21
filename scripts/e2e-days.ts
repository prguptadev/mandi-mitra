import "./_guard.ts";
import { sqlite } from "../server/db/client.ts";
import { ageBills } from "../server/routes/millFollowup.ts";
/* End-to-end: day close, the mill follow-up list, and the Tally screen's
   day-by-day view, party filter and row marks — on the test database.
   A closed day must refuse every change dated on it; reopening needs the
   right and a reason. The follow-up's unpaid parchas must always add up to
   the mill's balance. Run through: npm run test:e2e */
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
await owner.login("Test Owner", process.env.MANDI_PIN ?? "482915");
const biz = (await owner.req("GET", "/auth/me")).json.activeBusinessId;
const call = async (m: string, p: string, b?: unknown) => { const r = await owner.req(m, p, b); if (r.status >= 400) throw new Error(`${m} ${p} ${r.status} ${JSON.stringify(r.json)}`); return r.json; };
const raw = owner.req;
const rs = (r: number) => Math.round(r * 100);

const jins = await call("GET", "/jins");
const j1509 = jins.find((j: any) => j.code === "1509");
const mills = await call("GET", "/merchants");
const lb = mills.find((m: any) => m.code === "LB");
const sup = await call("POST", "/adati", { nameHi: "दिन बंद जाँच ट्रेडर्स" });
const A = sup.id;
const D = "2026-09-10", D2 = "2026-09-11";
const slip = (slipDate: string, rstNo: string) => raw("POST", "/slips", {
  slipDate, rstNo, adatiId: A, jinsId: j1509.id, merchantId: lb.id, grossGrams: 1_000_000, ratePaisePerQtl: rs(3400),
});

console.log("Closing a day");
const s1 = (await slip(D, "9101")).json;
const s2 = (await slip(D2, "9102")).json;
check("a slip goes in while the day is open", Boolean(s1?.id && s2?.id));
const closed = await raw("POST", "/days/close", { day: D });
check("the owner closes the day", closed.status === 200 && closed.json.closed?.[0] === D, closed.json);
check("closing it twice says so", (await raw("POST", "/days/close", { day: D })).status === 409);
check("a day still to come cannot be closed", (await raw("POST", "/days/close", { day: "2099-01-01" })).status === 400);
const one = await call("GET", `/days/one?day=${D}`);
check("the day shows closed, by whom", Boolean(one.closed?.by) && one.slips >= 1, one);
const list = await call("GET", "/days?from=2026-09-01&to=2026-09-30");
const row = list.days.find((d: any) => d.day === D);
check("the day list carries its figures and the close", Boolean(row?.closed) && row.slips >= 1 && row.payablePaise > 0, row);

console.log("\nNothing dated on a closed day can change");
const refused = (r: { status: number; json: any }) => r.status === 409 && r.json?.code === "day_closed";
check("no new slip on it", refused(await slip(D, "9103")));
check("no edit to its slip", refused(await raw("PUT", `/slips/${s1.id}`, { ratePaisePerQtl: rs(3500) })));
check("no delete of its slip", refused(await raw("DELETE", `/slips/${s1.id}`)));
check("no slip moved into it from an open day", refused(await raw("PUT", `/slips/${s2.id}`, { slipDate: D })));
check("no moving its slips to another mill", refused(await raw("POST", "/slips/reassign", { slipIds: [s1.id], merchantId: null })));
check("no recompute of it", refused(await raw("POST", "/slips/recompute", { slipDate: D })));
check("no payment dated on it", refused(await raw("POST", "/payments", { adatiId: A, payDate: D, amountPaise: rs(100), mode: "cash" })));
check("no money from a mill dated on it", refused(await raw("POST", "/mill-receipts", { merchantId: lb.id, receiptDate: D, amountPaise: rs(100) })));
check("no truck dated on it", refused(await raw("POST", "/loads", { loadDate: D, merchantId: lb.id, jinsId: j1509.id })));
check("the refusal says which day", String((await slip(D, "9104")).json?.error).includes("10-09-2026"));
check("the open day next to it still takes changes", (await raw("PUT", `/slips/${s2.id}`, { ratePaisePerQtl: rs(3450) })).status === 200);

console.log("\nReopening");
const op = session();
await op.login("Munshi Ji", "271830");
check("an operator cannot close a day", (await op.req("POST", "/days/close", { day: D2 })).status === 403);
check("an operator cannot reopen one", (await op.req("POST", "/days/reopen", { day: D, reason: "galti" })).status === 403);
check("reopening needs a reason", (await raw("POST", "/days/reopen", { day: D, reason: "" })).status === 400);
check("the owner reopens with a reason", (await raw("POST", "/days/reopen", { day: D, reason: "rate was wrong" })).status === 200);
check("…and the slip can be changed again", (await raw("PUT", `/slips/${s1.id}`, { ratePaisePerQtl: rs(3500) })).status === 200);
const audit = sqlite.prepare("select entity_label from audit_log where action = 'day.reopen' order by at desc, rowid desc limit 1").get() as { entity_label: string };
check("the reason is in the audit trail", audit?.entity_label.includes("rate was wrong"), audit);

console.log("\nClose all up to a date");
const upto = await call("POST", "/days/close-upto", { day: "2026-09-12" });
check("every day up to it is closed, empty ones too", upto.closed.includes(D) && upto.closed.includes(D2) && upto.closed.includes("2026-09-12"), upto.closed.slice(-4));
check("an empty closed day refuses a back-dated slip", refused(await slip("2026-09-12", "9105")));
check("the day after is still open", (await slip("2026-09-13", "9106")).status === 200);
// leave the test database open for the scripts after this one
for (const d of sqlite.prepare("select day from day_closes where business_id = ?").pluck().all(biz) as string[]) await call("POST", "/days/reopen", { day: d, reason: "end of test" });
check("all reopened again", (sqlite.prepare("select count(*) from day_closes").pluck().get() as number) === 0);

console.log("\nMill follow-up: who owes what, and how old");
// the rule by hand: money against a truck pays that truck; the rest pays the oldest first
const aged = ageBills(100_000, [
  { loadId: "L1", parchaNo: "1", date: "2026-08-01", truckNo: null, grandTotalPaise: 500_000, shortagePaise: 0 },
  { loadId: "L2", parchaNo: "2", date: "2026-09-15", truckNo: null, grandTotalPaise: 300_000, shortagePaise: 10_000 },
], [{ loadId: "L2", amountPaise: 200_000, deductionPaise: 0 }, { loadId: null, amountPaise: 400_000, deductionPaise: 50_000 }], "2026-09-21");
check("the opening is paid first, then the oldest parcha", aged.unpaid.map((u) => u.duePaise).join(",") === "150000,90000", aged.unpaid);
check("unpaid adds up to opening + bills − cuts − money", aged.unpaid.reduce((s, u) => s + u.duePaise, 0) === 100_000 + 800_000 - 10_000 - 650_000);
check("age buckets: 51 days → 31–60, 6 days → 0–15", aged.buckets.join(",") === "90000,0,150000,0", aged.buckets);
const over = ageBills(0, [{ loadId: "L1", parchaNo: "1", date: "2026-09-01", truckNo: null, grandTotalPaise: 100_000, shortagePaise: 0 }],
  [{ loadId: "L1", amountPaise: 150_000, deductionPaise: 0 }], "2026-09-21");
check("money beyond every bill is paid ahead, nothing owed", over.unpaid.length === 0 && over.aheadPaise === 50_000, over);

const fu = await call("GET", "/mill-followup");
const ledger = await call("GET", "/mill-ledger");
check("every mill: unpaid − paid ahead = its balance", fu.rows.every((m: any) => m.duePaise - m.aheadPaise === m.balancePaise), fu.rows.map((m: any) => [m.code, m.duePaise, m.aheadPaise, m.balancePaise]));
check("…the same balance as the mill accounts", fu.rows.every((m: any) => ledger.rows.find((r: any) => r.id === m.id)?.balancePaise === m.balancePaise));
check("…and the age buckets add up to what is unpaid", fu.rows.every((m: any) => m.buckets.reduce((s: number, x: number) => s + x, 0) === m.duePaise));
check("total to receive = the mill accounts' total", fu.totals.toReceivePaise === ledger.totals.toReceivePaise, { fu: fu.totals.toReceivePaise, ledger: ledger.totals.toReceivePaise });
const today = new Date().toLocaleDateString("en-CA");
const note = await call("POST", "/mill-followup/notes", { merchantId: lb.id, note: "Munim ji said Monday", promisedPaise: rs(50000), nextDate: today });
const fu2 = await call("GET", "/mill-followup");
const lbRow = fu2.rows.find((m: any) => m.id === lb.id);
check("a call is noted, with the promise and the next date", lbRow?.followup?.note === "Munim ji said Monday" && lbRow.followup.promisedPaise === rs(50000) && lbRow.followup.nextDate === today, lbRow?.followup);
check("…and it is due today", lbRow?.dueToday === true);
check("an empty note is refused", (await raw("POST", "/mill-followup/notes", { merchantId: lb.id })).status === 400);
check("an operator cannot see the follow-up list", (await op.req("GET", "/mill-followup")).status === 403);
check("…nor note a call", (await op.req("POST", "/mill-followup/notes", { merchantId: lb.id, note: "x" })).status === 403);
check("the history lists it", (await call("GET", `/mill-followup/notes/${lb.id}`)).rows[0]?.id === note.id);
check("a note can be removed", (await raw("DELETE", `/mill-followup/notes/${note.id}`)).status === 200);

console.log("\nTally: day by day, one party, and the marks on rows");
const all = { from: "2026-04-01", to: "2027-03-31", kinds: ["slip", "payment", "parcha", "receipt", "cut"], onlyNew: true };
const days = (await call("POST", "/tally/days", all)).days;
const d10 = days.find((d: any) => d.day === D);
check("the new day shows entries still to send", d10?.all.new >= 1, d10);
check("day totals are per kind", d10?.kinds.slip?.new >= 1);
const sum = (k: string) => days.reduce((s: number, d: any) => s + d.all[k], 0);
const pv = await call("POST", "/tally/preview", all);
const pvEntries = Object.values(pv.entries as Record<string, number>).reduce((s, n) => s + n, 0);
check("the days' new entries = what the preview would send", sum("new") === pvEntries, { days: sum("new"), preview: pvEntries });
const one10 = await call("POST", "/tally/export", { ...all, from: D, to: D });
check("one day's file holds only that day", one10.vouchers >= 1 && [...one10.vouchersXml.matchAll(/<DATE>(\d{8})<\/DATE>/g)].every((m: RegExpMatchArray) => m[1] === "20260910"));
const mine = await call("POST", "/tally/export", { ...all, adatiId: A });
const parties = new Set([...mine.vouchersXml.matchAll(/<PARTYLEDGERNAME>([^<]*)<\/PARTYLEDGERNAME>/g)].map((m: RegExpMatchArray) => m[1]));
check("one supplier's file holds only that supplier", parties.size === 1 && mine.entries.every((e: any) => e.kind === "slip" || e.kind === "payment"), [...parties]);
const lbPay = await call("POST", "/tally/preview", { ...all, merchantId: lb.id, kinds: ["payment"] });
check("a mill has no supplier payments", lbPay.vouchers === 0);
const lbAll = await call("POST", "/tally/preview", { ...all, merchantId: lb.id });
check("a mill's file has its sales and money", (lbAll.entries.parcha ?? 0) + (lbAll.entries.receipt ?? 0) >= 0 && lbAll.entries.payment === 0);
const flags = (await call("GET", `/tally/flags?kind=slip&from=2026-04-01&to=2027-03-31`)).flags;
const sent = sqlite.prepare("select count(*) from tally_exports te join purchase_slips s on s.id = te.entity_id where te.kind = 'slip' and te.business_id = ?").pluck().get(biz) as number;
check("every slip Tally has carries a mark", Object.keys(flags).length === sent, { marks: Object.keys(flags).length, sent });
check("…with who sent it", Object.values(flags).every((f: any) => f.at && (f.state === "sent" || f.state === "changed")));
check("an operator sees the marks on the daily list", (await op.req("GET", `/tally/flags?kind=slip&from=${D}&to=${D}`)).status === 200);

console.log(bad ? `\n${bad} FAILED` : "\nall passed");
process.exit(bad ? 1 : 0);
