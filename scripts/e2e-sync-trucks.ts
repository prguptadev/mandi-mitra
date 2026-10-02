import "./_guard.ts";
import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { checkBooks } from "../server/lib/booksCheck.ts";
/* End-to-end: trucks and their parchas across computers. Runs after
 * e2e-cloud.ts, on the three computers it leaves (A, B, and C joined again
 * here), through the same stand-in cloud. A truck and its parcha are separate
 * records that two computers settle apart; these checks hold the books to one
 * answer on every computer: one live parcha per truck, the truck billed
 * exactly when it has one, its stored figures the ones the parcha billed, and
 * parcha numbers claimed per financial year.
 * Run through: npm run test:e2e
 */
const PG = process.env.MANDI_FAKE_PG!;
const PG_SWITCH = `http://127.0.0.1:${Number(new URL(PG).port) + 2000}`;
const PIN = process.env.MANDI_PIN ?? "482915";
const TWICE = "this truck was approved on two computers — the earlier parcha is kept";
let bad = 0;
const check = (label: string, ok: boolean, got?: unknown) => {
  if (!ok) bad++;
  console.log(` ${ok ? "PASS" : "FAIL"}  ${label}${ok || got === undefined ? "" : `   ${JSON.stringify(got)}`}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function cloud<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: PG });
  await c.connect();
  try { return (await c.query(sql, params)).rows as T[]; } finally { await c.end(); }
}
const internet = (on: boolean) => fetch(`${PG_SWITCH}/${on ? "up" : "down"}`);

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
    if (!u) throw new Error(`${name}: nobody called ${user} (${users.map((x: any) => x.name).join(", ")})`);
    await call("POST", "/auth/login", { userId: u.id, pin });
    const me = await call("GET", "/auth/me");
    const vldm = me.businesses.find((b: any) => b.shortCode === "VLDM");
    if (vldm && me.activeBusinessId !== vldm.businessId) await call("POST", "/auth/switch-business", { businessId: vldm.businessId });
    return (await call("GET", "/auth/me")).activeBusinessId as string;
  }
  const sync = () => call("POST", "/cloud/sync");
  /** The computer's own sync bookkeeping (cloud-state.db), not the books. */
  function state<T = any>(sql: string, ...args: unknown[]): T[] {
    const d = new Database(path.join(dir, "cloud-state.db"), { readonly: true });
    try { return d.prepare(sql).all(...args) as T[]; } finally { d.close(); }
  }
  return { name, dir, raw, call, q, state, login, sync };
}
const A = computer("A", process.env.MANDI_API!, process.env.MANDI_DATA_DIR!);
const B = computer("B", process.env.MANDI_API_B!, process.env.MANDI_DATA_DIR_B!);
const C = computer("C", process.env.MANDI_API_C!, process.env.MANDI_DATA_DIR_C!);
const ALL = [A, B, C];
type PC = typeof A;

/** Sync every computer until a whole round moves nothing. */
async function settle(who = ALL) {
  for (let round = 0; round < 8; round++) {
    let moved = 0;
    for (const x of who) { const r = await x.sync(); moved += r.pushed + r.pulled; }
    if (!moved) return round;
  }
  return -1;
}
/** The same answer on every computer. */
function same(label: string, f: (x: PC) => unknown) {
  const v = ALL.map((x) => JSON.stringify(f(x)));
  check(label, v.every((s) => s === v[0]), Object.fromEntries(ALL.map((x, i) => [x.name, v[i]])));
}
async function sameAsync(label: string, f: (x: PC) => Promise<unknown>) {
  const v: string[] = [];
  for (const x of ALL) v.push(JSON.stringify(await f(x)));
  check(label, v.every((s) => s === v[0]), Object.fromEntries(ALL.map((x, i) => [x.name, v[i]])));
}
const truck = (x: PC, id: string) => x.q<any>(
  `select status, invoice_no, invoice_date, advance_paise, mill_gross_grams, katte_count, bore_count, katte_bardana_grams, bore_bardana_grams,
     bags, mill_bardana_grams, mill_net_grams, mill_deduction_grams from loads where id = ?`, id)[0];
const parchasOf = (x: PC, loadId: string) => x.q<any>("select * from parchas where load_id = ? order by id", loadId);
const live = (x: PC, loadId: string) => parchasOf(x, loadId).filter((p) => p.status === "approved");
/** What the screens say about one mill: its balance, its parchas with their dues, its stock. */
async function millView(x: PC, millId: string, code: string) {
  const led = (await x.call("GET", "/mill-ledger")).rows.find((r: any) => r.id === millId);
  const reg = (await x.call("GET", "/parchas")).filter((p: any) => p.millCode === code);
  const stock = (await x.call("GET", "/stock")).find((s: any) => s.merchantId === millId);
  return {
    balance: led?.balancePaise ?? 0, parchas: led?.parchas ?? 0,
    register: reg.map((p: any) => `${p.parchaNo}|${p.truckNo}|${p.status}|${p.grandTotalPaise}|due ${p.duePaise}`).sort(),
    stockNet: stock?.stockNet ?? null, loadedNet: stock?.loadedNet ?? null,
  };
}
async function moneyView(x: PC) {
  const m = await x.call("GET", "/dashboard/money");
  return { draftTrucks: m.stock.draftTrucks, unbilledGoods: m.stock.unbilledGoodsPaise, stockLeft: m.stock.leftGrams, millsToReceive: m.mills.toReceivePaise };
}

await A.login();
await B.login();
// e2e-cloud.ts ends by taking C off the cloud: it joins again, so three computers take part
await C.login();
if (!(await C.call("GET", "/cloud")).configured) {
  const ask = await C.call("PUT", "/cloud", { connection: PG });
  if (ask.needsJoin) await C.call("POST", "/cloud/join", { connection: PG, confirm: "JOIN" });
  await C.login();
}
await settle();
const biz = (await A.call("GET", "/auth/me")).activeBusinessId as string;
const jins = (await A.call("GET", "/jins")).find((x: any) => x.code === "1509");
const sup = await A.call("POST", "/adati", { nameHi: "ट्रक सिंक जाँच ट्रेडर्स" });
let rst = 0;
/** A mill of its own for each check, so one check's money never mixes with another's. */
async function mill(code: string) {
  const m = await A.call("POST", "/merchants", { code, name: `Truck Sync ${code}` });
  await settle();
  return m;
}
/** A truck with its own day's stock; weighed unless `weigh` is false. */
async function makeTruck(x: PC, o: { millId: string; day: string; truckNo?: string; gross?: number; katte?: number; weigh?: boolean }) {
  await x.call("POST", "/slips", { slipDate: o.day, rstNo: `TS${++rst}`, adatiId: sup.id, jinsId: jins.id, merchantId: o.millId, grossGrams: 3_000_000, ratePaisePerQtl: 340_000 });
  const t = await x.call("POST", "/loads", { loadDate: o.day, merchantId: o.millId, jinsId: jins.id, stockDate: o.day, truckNo: o.truckNo });
  if (o.weigh !== false) await x.call("PUT", `/loads/${t.id}`, { millGrossGrams: o.gross ?? 950_000, katteCount: o.katte ?? 20, advancePaise: 0, daraPaise: 0 });
  return t.id as string;
}

console.log("\nThe same truck approved on two computers");
{
  const m = await mill("TSK");
  const t = await makeTruck(A, { millId: m.id, day: "2026-11-02", truckNo: "UP84K0001" });
  await settle();
  await internet(false);
  const a = await A.raw("POST", `/loads/${t}/approve`, { invoiceNo: "8101" });
  await sleep(1100);
  // B also types a ₹5,000 advance before approving the same truck
  await B.call("PUT", `/loads/${t}`, { advancePaise: 500_000 });
  const b = await B.raw("POST", `/loads/${t}/approve`, { invoiceNo: "8151" });
  check("each computer approves it while apart", a.status === 200 && b.status === 200, [a.json, b.json]);
  await internet(true);
  await settle();
  const kept = [a.json.id, b.json.id].sort()[0];
  same("every computer keeps the same one live parcha: the earlier", (x) => live(x, t).map((p) => p.id));
  check("  ...which is A's #8101", live(A, t).length === 1 && live(A, t)[0].id === kept && kept === a.json.id && live(A, t)[0].parcha_no === "8101",
    live(A, t).map((p) => [p.parcha_no, p.id === a.json.id ? "A's" : "B's"]));
  same("  ...and the other is voided the same way everywhere, saying why", (x) => parchasOf(x, t).map((p) => [p.parcha_no, p.status, p.void_reason, p.voided_at]));
  check("  ...in plain words", parchasOf(A, t).some((p) => p.status === "void" && p.void_reason === TWICE), parchasOf(A, t).map((p) => p.void_reason));
  same("the truck carries the kept parcha's number and advance on every computer", (x) => truck(x, t));
  check("  ...billed as #8101 with no advance", truck(A, t).status === "billed" && truck(A, t).invoice_no === "8101" && truck(A, t).advance_paise === 0, truck(A, t));
  check("nothing is left waiting to be tried again", ALL.every((x) => x.state("select 1 from retry where tbl = 'parchas'").length === 0),
    ALL.map((x) => x.state("select row_id from retry")));
  const notes = ALL.flatMap((x) => x.state<{ note: string }>("select note from clashes where tbl = 'parchas'").map((c) => c.note));
  check("the computer whose approval was voided is told, in words that fit a parcha", notes.some((n) => n === TWICE) && !notes.some((n) => /rename/.test(n)), notes);
  await sameAsync("the mill's dues, register and stock are the same on every computer", (x) => millView(x, m.id, "TSK"));
  const v = await millView(A, m.id, "TSK");
  check("  ...one bill, not two: the mill owes what #8101 says", v.parchas === 1 && v.balance === a.json.grandTotalPaise, { v, billed: a.json.grandTotalPaise });

  // the other way round: the later approval reaches the third computer first, so it too has a parcha to void
  const t2 = await makeTruck(A, { millId: m.id, day: "2026-11-02", truckNo: "UP84K0002" });
  await settle();
  for (const x of ALL) await x.call("DELETE", "/cloud/clashes");
  await internet(false);
  const a2 = await A.raw("POST", `/loads/${t2}/approve`, { invoiceNo: "8102" });
  await sleep(1100);
  const b2 = await B.raw("POST", `/loads/${t2}/approve`, { invoiceNo: "8152" });
  await internet(true);
  for (const x of [B, C, A, C, B]) await x.sync();
  await settle();
  check("approved on both again, B's reaching C first", a2.status === 200 && b2.status === 200 && a2.json.id < b2.json.id, [a2.json, b2.json]);
  same("  ...every computer still keeps the earlier parcha, #8102", (x) => live(x, t2).map((p) => [p.id, p.parcha_no]));
  same("  ...and holds the same voided #8152, to the last field", (x) => parchasOf(x, t2));
  check("  ...which reads #8102 on the truck", truck(A, t2).invoice_no === "8102" && live(A, t2)[0]?.id === a2.json.id, truck(A, t2));
  const odd = ALL.flatMap((x) => x.state<{ note: string }>("select note from clashes where tbl = 'parchas'").map((c) => c.note)).filter((n) => n !== TWICE);
  check("  ...with no other clash about the parcha on any computer", odd.length === 0, odd);
  check("  ...and nothing left waiting", ALL.every((x) => x.state("select 1 from retry").length === 0), ALL.map((x) => x.state("select tbl, row_id from retry")));
  await sameAsync("  ...and the same dues everywhere", (x) => millView(x, m.id, "TSK"));
}

console.log("\nApproved on one computer, edited on the other");
{
  const m = await mill("TSE");
  const t = await makeTruck(A, { millId: m.id, day: "2026-11-03", gross: 1_000_000 });
  await settle();
  await internet(false);
  const ap = await A.raw("POST", `/loads/${t}/approve`, { invoiceNo: "8201" });
  await sleep(1100);
  // B still sees a draft, and changes the mill's gross a moment later
  const ed = await B.raw("PUT", `/loads/${t}`, { millGrossGrams: 1_100_000 });
  check("A approves, and B (not yet told) changes the gross", ap.status === 200 && ed.status === 200, [ap.json, ed.json]);
  await internet(true);
  await settle();
  const doc = (await A.call("GET", `/parchas/${ap.json.id}`)).doc;
  same("the truck is the same on every computer", (x) => truck(x, t));
  const tr = truck(A, t);
  check("  ...billed, holding the figures its parcha billed", tr.status === "billed" && tr.mill_gross_grams === doc.weights.grossGrams && tr.mill_net_grams === doc.weights.netGrams,
    { truck: tr, billed: doc.weights });
  check("  ...and locked again", (await B.raw("PUT", `/loads/${t}`, { notes: "x" })).status === 409);
  const drafts = await Promise.all(ALL.map(async (x) => (await x.call("GET", "/loads?status=draft")).some((l: any) => l.id === t)));
  check("no computer lists it among the trucks not yet billed", drafts.every((d) => !d), drafts);
  await sameAsync("the dashboard's money is the same on every computer", moneyView);
  await sameAsync("the mill's dues, register and stock are the same on every computer", (x) => millView(x, m.id, "TSE"));
}

console.log("\nParcha voided on one computer while the mill's cut is typed on the other");
{
  const m = await mill("TSV");
  const t = await makeTruck(A, { millId: m.id, day: "2026-11-04" });
  const ap = await A.call("POST", `/loads/${t}/approve`, { invoiceNo: "8301" });
  await settle();
  await internet(false);
  await A.call("POST", `/parchas/${ap.id}/void`, { reason: "wrong rate" });
  await sleep(1100);
  const cut = await B.raw("PUT", `/challan/${t}`, { deductionGrams: 20_000, note: "moisture" });
  check("A voids, and B (not yet told) types the mill's 20 kg cut", cut.status === 200, cut.json);
  await internet(true);
  await settle();
  same("the truck is the same on every computer", (x) => [truck(x, t), live(x, t).length]);
  check("  ...a draft again, since it has no live parcha", truck(A, t).status === "draft" && live(A, t).length === 0, truck(A, t));
  check("  ...keeping the mill's cut", truck(A, t).mill_deduction_grams === 20_000, truck(A, t));
  const again = await A.raw("POST", `/loads/${t}/approve`, { invoiceNo: "8302" });
  check("it can be approved again", again.status === 200, again.json);
  await settle();
  same("  ...and every computer has it billed as #8302", (x) => [truck(x, t).status, live(x, t).map((p) => p.parcha_no)]);
  await sameAsync("  ...with the same dues on every computer", (x) => millView(x, m.id, "TSV"));
}

console.log("\nA mill's bardana changed on one computer while the other weighs a draft truck");
{
  const m = await mill("TSB");
  const t = await makeTruck(A, { millId: m.id, day: "2026-11-05", weigh: false });
  await settle();
  const terms = (await A.call("GET", `/merchants/${m.id}`)).chargeConfig;
  await internet(false);
  await A.call("PUT", `/merchants/${m.id}`, { chargeConfig: { ...terms, millBardanaKgPerBag: 0.7 } });
  await sleep(1100);
  await B.call("PUT", `/loads/${t}`, { millGrossGrams: 3_000_000, katteCount: 100 });
  await internet(true);
  await settle();
  same("the truck is the same on every computer", (x) => truck(x, t));
  check("  ...its stored net worked out on the mill's terms as they stand (0.70 kg a bag)", truck(A, t).mill_net_grams === 3_000_000 - 100 * 700,
    { stored: truck(A, t).mill_net_grams, right: 3_000_000 - 100 * 700 });
  await sameAsync("the mill's stock is the same on every computer", (x) => millView(x, m.id, "TSB"));
}

console.log("\nOne number on two trucks on the same day: which is still unpaid");
{
  const m = await mill("TSN");
  const ta = await makeTruck(A, { millId: m.id, day: "2026-11-06", truckNo: "UP84N000A", gross: 950_000 });
  const tb = await makeTruck(B, { millId: m.id, day: "2026-11-06", truckNo: "UP84N000B", gross: 980_000 });
  await settle();
  await internet(false);
  const a = await A.raw("POST", `/loads/${ta}/approve`, { invoiceNo: "8501" });
  const b = await B.raw("POST", `/loads/${tb}/approve`, { invoiceNo: "8501" });
  check("both computers give #8501 while apart", a.status === 200 && b.status === 200, [a.json, b.json]);
  await internet(true);
  await settle();
  // ₹20,000 on account pays part of one of the two: the same one everywhere
  await A.call("POST", "/mill-receipts", { merchantId: m.id, receiptDate: "2026-11-07", amountPaise: 2_000_000, mode: "bank" });
  await settle();
  await sameAsync("every computer shows the same parcha as part-paid", (x) => millView(x, m.id, "TSN"));
  await sameAsync("  ...and the same unpaid list to follow up", async (x) => {
    const f = await x.call("GET", "/mill-followup");
    const row = (Array.isArray(f) ? f : f.rows ?? f.mills ?? []).find((r: any) => r.id === m.id || r.merchantId === m.id);
    return (row?.unpaid ?? []).map((u: any) => `${u.parchaNo}/${u.truckNo} due ${u.duePaise}`);
  });
}

console.log("\nParcha numbers across the year end");
{
  const m = await mill("TSY");
  const old = await makeTruck(A, { millId: m.id, day: "2026-03-31", truckNo: "UP84Y0331" });
  const neu = await makeTruck(B, { millId: m.id, day: "2026-04-01", truckNo: "UP84Y0401" });
  await settle();
  const a = await A.raw("POST", `/loads/${old}/approve`, { invoiceNo: "8601" });
  // B has not pulled A's parcha: a 31-03 #8601 is last year's number, a 01-04 #8601 this year's
  const b = await B.raw("POST", `/loads/${neu}/approve`, { invoiceNo: "8601" });
  check("A bills a 31-03 truck as #8601", a.status === 200, a.json);
  check("  ...and B a 01-04 truck as #8601 with no warning: two financial years", b.status === 200, b.json);
  const old2 = await makeTruck(A, { millId: m.id, day: "2026-03-31", truckNo: "UP84Y0332" });
  const neu2 = await makeTruck(B, { millId: m.id, day: "2026-04-01", truckNo: "UP84Y0402" });
  await settle();
  await internet(false);
  const a2 = await A.raw("POST", `/loads/${old2}/approve`, { invoiceNo: "8602" });
  const b2 = await B.raw("POST", `/loads/${neu2}/approve`, { invoiceNo: "8602" });
  await internet(true);
  await settle();
  const notes = [A, B].flatMap((x) => x.state<{ note: string }>("select note from clashes").map((c) => c.note)).filter((n) => /#8602/.test(n));
  check("the same with no internet: no 'void this parcha' note afterwards", a2.status === 200 && b2.status === 200 && notes.length === 0, { a2: a2.status, b2: b2.status, notes });
  await sameAsync("the register is the same on every computer, neither number marked as used twice", async (x) =>
    (await x.call("GET", "/parchas")).filter((p: any) => p.millCode === "TSY").map((p: any) => `${p.parchaNo}|${p.invoiceDate}|${p.numberRepeated}`).sort());
}

console.log("\nA number given again to the same truck stays claimed");
{
  const m = await mill("TSH");
  const x = await makeTruck(A, { millId: m.id, day: "2026-11-08", truckNo: "UP84H000X" });
  const y = await makeTruck(B, { millId: m.id, day: "2026-11-08", truckNo: "UP84H000Y" });
  await settle();
  const a1 = await A.call("POST", `/loads/${x}/approve`, { invoiceNo: "8701" });
  await settle();
  await A.call("POST", `/parchas/${a1.id}/void`, { reason: "fix the gross" });
  await A.sync(); await B.sync(); // B now has X's #8701 as voided
  await A.call("PUT", `/loads/${x}`, { millGrossGrams: 960_000 });
  await A.call("POST", `/loads/${x}/approve`, { invoiceNo: "8701" });
  // B has not pulled the new approval yet
  const b = await B.raw("POST", `/loads/${y}/approve`, { invoiceNo: "8701" });
  check("the other computer is warned that #8701 is live again", b.status === 409 && b.json.code === "number_repeated", b.json);
  await settle();
}

console.log("\nA parcha approved while sync is held is claimed when it resumes");
{
  const m = await mill("TSQ");
  const t = await makeTruck(A, { millId: m.id, day: "2026-11-09" });
  await settle();
  await A.call("POST", "/cloud/live", { on: false });
  const ap = await A.raw("POST", `/loads/${t}/approve`, { invoiceNo: "8801" });
  check("approving works with sync held", ap.status === 200, ap.json);
  check("  ...and the number waits to be claimed", A.state("select 1 from claims_waiting where value = ?", "8801 (2026-27)").length === 1,
    A.state("select value, load_id from claims_waiting"));
  await A.call("POST", "/cloud/live", { on: true });
  await settle();
  check("  ...claimed once sync is back on", (await cloud("select load_id from mm_claims where business_id = $1 and value = '8801 (2026-27)'", [biz]))[0]?.load_id === t,
    await cloud("select value, load_id from mm_claims where business_id = $1 and value like '8801%'", [biz]));
}

console.log("\nA refused approval gives its number back");
{
  const m = await mill("TSR");
  const t = await makeTruck(A, { millId: m.id, day: "2026-11-10", truckNo: "UP84R000A" });
  const u = await makeTruck(B, { millId: m.id, day: "2026-11-10", truckNo: "UP84R000B" });
  await settle();
  // two approvals of one truck at once (two screens): one goes through, the other is refused
  const [r1, r2] = await Promise.all([A.raw("POST", `/loads/${t}/approve`, { invoiceNo: "8901" }), A.raw("POST", `/loads/${t}/approve`, { invoiceNo: "8902" })]);
  const won = r1.status === 200 ? r1 : r2, lost = r1.status === 200 ? r2 : r1;
  const refusedNo = won === r1 ? "8902" : "8901";
  check("one approval goes through and the other is refused", won.status === 200 && lost.status === 409 && ["changed", "already_approved"].includes(lost.json.code),
    [r1.status, r1.json?.code, r2.status, r2.json?.code]);
  const claims = await cloud<{ value: string }>("select value from mm_claims where business_id = $1 and load_id = $2 order by value", [biz, t]);
  check("  ...and only the approved number stays claimed for the truck", claims.every((c) => c.value.startsWith(won.json.parchaNo)), claims.map((c) => c.value));
  await settle();
  const other = await B.raw("POST", `/loads/${u}/approve`, { invoiceNo: refusedNo });
  check("another computer may give the refused number with no warning", other.status === 200, other.json);
  await settle();
}

console.log("\nThe books check names a truck out of step with its parcha");
{
  // a copy of A's books (in its test folder), put out of step by hand: A's own books are never touched
  const copy = path.join(A.dir, "trucks-check-copy.db");
  const src = new Database(path.join(A.dir, "mandi.db"), { readonly: true });
  await src.backup(copy);
  src.close();
  const text = (r: ReturnType<typeof checkBooks>) => r.businesses.flatMap((x) => x.sections.flatMap((s) => s.lines.filter((l) => l.ok === false).map((l) => l.text)));
  const d = new Database(copy);
  const before = text(checkBooks(d, biz));
  check("every truck is in step to begin with", !before.some((l) => /truck/.test(l)), before);
  const billedOne = d.prepare("select l.id from loads l join parchas p on p.load_id = l.id and p.status = 'approved' where l.business_id = ? order by l.id limit 2").pluck().all(biz) as string[];
  const draftOne = d.prepare("select l.id from loads l where l.business_id = ? and l.status = 'draft' and not exists (select 1 from parchas p where p.load_id = l.id and p.status = 'approved') limit 1").pluck().get(biz) as string;
  d.prepare("update loads set status = 'draft' where id = ?").run(billedOne[0]);
  d.prepare("update loads set mill_net_grams = mill_net_grams + 10000 where id = ?").run(billedOne[1]);
  d.prepare("update loads set status = 'billed' where id = ?").run(draftOne);
  const after = text(checkBooks(d, biz));
  d.close();
  fs.rmSync(copy, { force: true });
  check("  ...it names a draft truck with a live parcha", after.some((l) => /draft truck\(s\) have a live parcha/.test(l)), after);
  check("  ...a billed truck with no live parcha", after.some((l) => /marked billed but have no live parcha/.test(l)), after);
  check("  ...and a stored net other than the parcha billed", after.some((l) => /store a net weight other than what their parcha billed/.test(l)), after);
}

// leave every computer in step, with the internet on, for the checks that follow
await internet(true);
await settle();
same("at the end, every computer holds the same trucks and parchas", (x) => [x.q("select * from loads order by id"), x.q("select * from parchas order by id")]);

console.log(bad === 0 ? "\nTrucks and parchas agree on every computer." : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
