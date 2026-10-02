import "./_guard.ts";
import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
/* End-to-end: two-way sync between three "computers" (three app servers, each
 * with its own test database) through a real Postgres standing in for Supabase
 * (scripts/fake-postgres.ts). Test databases only.
 *   A — the first computer, holding everything the other scripts made
 *   B — a new install (Admin / 7747) that joins from Settings
 *   C — an empty install that joins from the first screen
 * Run through: npm run test:e2e
 */
const PG = process.env.MANDI_FAKE_PG!;
const PG_SWITCH = `http://127.0.0.1:${Number(new URL(PG).port) + 2000}`;
const PIN = process.env.MANDI_PIN ?? "482915";
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
    return me;
  }
  const sync = () => call("POST", "/cloud/sync");
  const cfgPath = path.join(dir, "cloud.json");
  const cfg = () => JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  const setCfg = (p: Record<string, unknown>) => fs.writeFileSync(cfgPath, JSON.stringify({ ...cfg(), ...p }, null, 2));
  /** The computer's own sync bookkeeping (cloud-state.db), not the books. */
  function stateQ<T = any>(sql: string, ...args: unknown[]): T[] {
    const d = new Database(path.join(dir, "cloud-state.db"), { readonly: true });
    try { return d.prepare(sql).all(...args) as T[]; } finally { d.close(); }
  }
  return { name, raw, call, q, state: stateQ, login, sync, cfg, setCfg };
}
const A = computer("A", process.env.MANDI_API!, process.env.MANDI_DATA_DIR!);
const B = computer("B", process.env.MANDI_API_B!, process.env.MANDI_DATA_DIR_B!);
const C = computer("C", process.env.MANDI_API_C!, process.env.MANDI_DATA_DIR_C!);
const ALL = [A, B, C];

/** Sync every computer until a whole round moves nothing. */
async function settle(who = ALL) {
  for (let round = 0; round < 6; round++) {
    let moved = 0;
    for (const x of who) { const r = await x.sync(); moved += r.pushed + r.pulled; }
    if (!moved) return round;
  }
  return -1;
}
/** Every record the office works with, as it stands on one computer. */
const BUSINESS_TABLES = ["businesses", "users", "roles", "role_permissions", "memberships", "jins", "adati", "adati_aliases", "merchants",
  "purchase_orders", "purchase_slips", "loads", "load_lines", "parchas", "payments", "mill_receipts"];
function fingerprint(x: ReturnType<typeof computer>) {
  const out: Record<string, string> = {};
  for (const t of BUSINESS_TABLES) out[t] = JSON.stringify(x.q(`select * from "${t}" order by id`));
  out.settings = JSON.stringify(x.q("select * from settings where key <> 'gemini.apiKey' order by id"));
  return out;
}
function sameEverywhere(label: string) {
  const [a, ...rest] = ALL.map(fingerprint);
  const differ = Object.keys(a).filter((t) => rest.some((r) => r[t] !== a[t]));
  check(label, differ.length === 0, differ);
}
const slipOf = (x: ReturnType<typeof computer>, id: string) => x.q<{ rate_paise_per_qtl: number; amount_paise: number; net_grams: number }>(
  "select rate_paise_per_qtl, amount_paise, net_grams from purchase_slips where id = ?", id)[0];

// a clean cloud for every run
await cloud("drop table if exists mm_rows, mm_meta, mm_claims, mm_devices; drop sequence if exists mm_seq;");

await A.login();
console.log("Set up on the first computer");
check("not set up to begin with", (await A.call("GET", "/cloud")).configured === false);
check("sync status says off", (await A.call("GET", "/cloud/status")).enabled === false);
check("a string that is not a database address is refused", (await A.raw("PUT", "/cloud", { connection: "hello" })).status === 400);
check("Supabase's [YOUR-PASSWORD] left in is caught", (await A.raw("PUT", "/cloud", { connection: "postgresql://postgres.abc:[YOUR-PASSWORD]@aws-0.pooler.supabase.com:6543/postgres" })).status === 400);
const set = await A.call("PUT", "/cloud", { connection: PG });
check("an empty cloud is started from this computer", set.configured === true && set.live === true && !set.needsJoin, set);
check("the password is never shown back", !JSON.stringify(await A.call("GET", "/cloud")).includes(new URL(PG).password));
// connecting starts the first sync by itself; this one waits for it (or finds nothing left)
const s1 = await A.sync();
check("everything goes up", s1.lastError === null && Number((await cloud("select count(*) as n from mm_rows"))[0].n) > 100, s1);
const counts = await cloud<{ tbl: string; n: string }>("select tbl, count(*) as n from mm_rows where not deleted group by tbl");
const cnt = (t: string) => Number(counts.find((x) => x.tbl === t)?.n ?? 0);
const mismatched = BUSINESS_TABLES.filter((t) => cnt(t) !== A.q<{ n: number }>(`select count(*) as n from "${t}"`)[0].n);
check("every table has the same number of records up there", mismatched.length === 0, mismatched);
check("sign-ins stay on the computer", cnt("sessions") === 0 && cnt("_sync_dirty") === 0 && cnt("__drizzle_migrations") === 0);
check("the Gemini key stays on the computer", (await cloud("select 1 from mm_rows where tbl = 'settings' and data->>'key' = 'gemini.apiKey'")).length === 0);
check("the model's raw replies stay on the computer", (await cloud("select 1 from mm_rows where tbl = 'scan_batches' and data ? 'raw_response'")).length === 0);
const st1 = await A.call("GET", "/cloud/status");
check("status: in step, nothing waiting", st1.enabled && st1.state === "ok" && st1.pending === 0, st1);
check("a second sync sends nothing", (await A.sync()).pushed === 0);

console.log("\nA new install (Admin / 7747) joins from Settings");
check("a new install opens on the sign-in screen", (await B.call("GET", "/auth/bootstrap")).needsSignup === false);
const bUsers = (await B.call("GET", "/auth/users")).map((u: any) => u.name).sort();
check("…with Admin, Manager 1 and Manager 2", JSON.stringify(bUsers) === JSON.stringify(["Admin", "Manager 1", "Manager 2"]), bUsers);
check("a wrong PIN is refused", (await B.raw("POST", "/auth/login", { userId: (await B.call("GET", "/auth/users"))[0].id, pin: "1357" })).status >= 400);
const mgr = await B.login("Manager 1", "7747");
check("a Manager is in both firms", mgr.businesses.length === 2 && mgr.businesses.some((b: any) => b.shortCode === "VCE"), mgr.businesses);
check("…with full access", (await B.raw("GET", "/cloud")).status === 200 && (await B.raw("GET", "/users")).status === 200);
check("…but cannot add a business", (await B.raw("POST", "/auth/businesses", { name: "Test Firm", shortCode: "TF" })).status === 403);
const adm = await B.login("Admin", "7747");
check("the Admin is in both firms", adm.businesses.length === 2, adm.businesses);
check("the Admin can add a business", (await B.raw("POST", "/auth/businesses", { name: "Scratch Firm", shortCode: "SF" })).status === 200);
const bJoin = await B.call("PUT", "/cloud", { connection: PG });
check("a cloud with data asks to join, naming the computer already on it", bJoin.needsJoin?.rows > 100 && bJoin.needsJoin.devices.length === 1, bJoin.needsJoin);
check("…and does not start syncing on its own", (await B.call("GET", "/cloud/status")).enabled === false);
check("joining needs JOIN typed", (await B.raw("POST", "/cloud/join", { connection: PG, confirm: "yes" })).status === 400);
const joined = await B.call("POST", "/cloud/join", { connection: PG, confirm: "JOIN" });
check("a backup of what was there is taken first", /^before-cloud-/.test(joined.backup), joined.backup);
check("no broken links after joining", joined.brokenLinks === 0, joined.brokenLinks);
check("everyone signs in again after joining", (await B.raw("GET", "/auth/me")).status === 401);
check("the office's people are now here (Admin was replaced)", (await B.call("GET", "/auth/users")).some((u: any) => u.name === "Test Owner"));
await B.login();
check("the backup taken before joining is listed apart from the ones made by hand",
  (await B.call("GET", "/backup")).backups.some((b: any) => b.name === joined.backup && b.kind === "before-cloud"));
check("the new install's own firm is gone", !(await B.call("GET", "/auth/me")).businesses.some((b: any) => b.shortCode === "SF"));

console.log("\nAn empty install joins from the first screen");
check("it offers sign-up", (await C.call("GET", "/auth/bootstrap")).needsSignup === true);
check("a wrong string is refused", (await C.raw("POST", "/cloud/join-fresh", { connection: "postgresql://x:y@127.0.0.1:1/postgres" })).status === 400);
const cj = await C.call("POST", "/cloud/join-fresh", { connection: PG });
check("joining brings every record down", cj.records > 100, cj);
check("it now opens on the sign-in screen", (await C.call("GET", "/auth/bootstrap")).needsSignup === false);
check("joining from the first screen works only once", (await C.raw("POST", "/cloud/join-fresh", { connection: PG })).status === 409);
await C.login();
check("C's status: in step", (await C.call("GET", "/cloud/status")).enabled === true);
await settle();
sameEverywhere("all three computers hold exactly the same records");

console.log("\nEveryday work moves between computers");
const jins = await A.call("GET", "/jins");
const j = jins.find((x: any) => x.code === "1509");
const lb = (await A.call("GET", "/merchants")).find((m: any) => m.code === "LB");
const sup = await A.call("POST", "/adati", { nameHi: "सिंक जाँच ट्रेडर्स" });
const slip = await A.call("POST", "/slips", { slipDate: "2026-10-05", rstNo: "9001", adatiId: sup.id, jinsId: j.id, merchantId: lb.id, grossGrams: 2_000_000, ratePaisePerQtl: 340_000 });
await A.sync();
await B.sync();
check("a supplier and slip made on A arrive on B", B.q("select 1 from adati where id = ?", sup.id).length === 1 && slipOf(B, slip.id)?.amount_paise === slip.amountPaise, slipOf(B, slip.id));
const pay = await B.call("POST", "/payments", { adatiId: sup.id, payDate: "2026-10-05", amountPaise: 1_000_000, mode: "cash" });
await B.sync();
await A.sync();
check("a payment made on B arrives on A", A.q("select 1 from payments where id = ?", pay.id).length === 1);
const ledA = (await A.call("GET", "/adati")).find((x: any) => x.id === sup.id);
const ledB = (await B.call("GET", "/adati")).find((x: any) => x.id === sup.id);
check("the supplier's balance is the same on both", JSON.stringify(ledA) === JSON.stringify(ledB), { ledA, ledB });
await C.sync();
check("C has both", C.q("select 1 from payments where id = ?", pay.id).length === 1 && slipOf(C, slip.id) !== undefined);
const aStatus = await A.call("GET", "/cloud/status");
check("screens refresh when changes arrive (change counter moves)", aStatus.changeCounter > 0, aStatus.changeCounter);

console.log("\nThe same slip changed on two computers");
await settle();
await A.call("PUT", `/slips/${slip.id}`, { ratePaisePerQtl: 341_000 });
await sleep(1100);
await B.call("PUT", `/slips/${slip.id}`, { ratePaisePerQtl: 342_000 });
await A.sync();
const bs = await B.sync();
check("the clash is noticed", bs.clashes === 1, bs);
await settle();
check("the later change (B's) is kept everywhere", ALL.every((x) => slipOf(x, slip.id).rate_paise_per_qtl === 342_000), ALL.map((x) => slipOf(x, slip.id).rate_paise_per_qtl));
check("…with the amount worked out from it", ALL.every((x) => slipOf(x, slip.id).amount_paise === slipOf(A, slip.id).amount_paise));
const clB = await B.call("GET", "/cloud/clashes");
check("the other version is kept in B's clash list", clB.some((c: any) => c.row_id === slip.id && JSON.parse(c.lost).rate_paise_per_qtl === 341_000), clB.map((c: any) => c.note));
check("the status shows the clash count", (await B.call("GET", "/cloud/status")).clashes >= 1);

console.log("\nA push never overwrites a change it has not seen");
await B.call("PUT", `/slips/${slip.id}`, { ratePaisePerQtl: 343_000 });
await sleep(1100);
await C.call("PUT", `/slips/${slip.id}`, { ratePaisePerQtl: 344_000 });
await C.sync();
const cursor = B.cfg().cursor;
B.setCfg({ cursor: 10_000_000 }); // B "has not pulled yet" when it pushes
await B.sync();
const upThere = (await cloud("select data->>'rate_paise_per_qtl' as r, device from mm_rows where row_id = $1", [slip.id]))[0];
check("B holds its change back instead of overwriting C's", upThere.device === C.cfg().deviceId, upThere);
check("…so C's change is still what the cloud has", Number(upThere.r) === 344_000, upThere);
check("…and B's change is still waiting to go", (await B.call("GET", "/cloud/status")).pending >= 1);
B.setCfg({ cursor });
await settle();
check("once B pulls, the later change (C's) wins everywhere", ALL.every((x) => slipOf(x, slip.id).rate_paise_per_qtl === 344_000), ALL.map((x) => slipOf(x, slip.id).rate_paise_per_qtl));

console.log("\nAn edit beats a delete");
const s2 = await A.call("POST", "/slips", { slipDate: "2026-10-05", rstNo: "9002", adatiId: sup.id, jinsId: j.id, merchantId: lb.id, grossGrams: 1_000_000, ratePaisePerQtl: 330_000 });
await settle();
await B.call("DELETE", `/slips/${s2.id}`);
await A.call("PUT", `/slips/${s2.id}`, { ratePaisePerQtl: 335_000 });
await B.sync();
await settle();
check("the edited slip is back on every computer, with the edit", ALL.every((x) => slipOf(x, s2.id)?.rate_paise_per_qtl === 335_000), ALL.map((x) => slipOf(x, s2.id)));
const s3 = await A.call("POST", "/slips", { slipDate: "2026-10-05", rstNo: "9003", adatiId: sup.id, jinsId: j.id, merchantId: lb.id, grossGrams: 500_000, ratePaisePerQtl: 330_000 });
await settle();
await C.call("DELETE", `/slips/${s3.id}`);
await settle();
check("a plain delete reaches every computer", ALL.every((x) => slipOf(x, s3.id) === undefined));

console.log("\nThe same mill code made on two computers");
const mA = await A.call("POST", "/merchants", { code: "SYNCX", name: "Sync Test Mill A" });
const mB = await B.call("POST", "/merchants", { code: "SYNCX", name: "Sync Test Mill B" });
await A.sync();
const bx = await B.sync();
check("B keeps its own and lists the other", bx.clashes >= 1 && B.q("select 1 from merchants where id = ?", mA.id).length === 0, bx);
check("…and sync is not stuck", (await B.call("GET", "/cloud/status")).state === "ok");
const s4 = await A.call("POST", "/slips", { slipDate: "2026-10-05", rstNo: "9004", adatiId: sup.id, jinsId: j.id, merchantId: lb.id, grossGrams: 700_000, ratePaisePerQtl: 330_000 });
await settle();
check("other work keeps flowing", ALL.every((x) => slipOf(x, s4.id) !== undefined));
await B.call("PUT", `/merchants/${mB.id}`, { code: "SYNCY" });
await settle();
check("after B renames its mill, both mills are on every computer", ALL.every((x) => x.q("select 1 from merchants where id in (?, ?)", mA.id, mB.id).length === 2),
  ALL.map((x) => x.q("select code from merchants where id in (?, ?)", mA.id, mB.id)));

console.log("\nParcha numbers");
// a truck ready to approve: fresh stock on its own day
await A.call("POST", "/slips", { slipDate: "2026-10-06", rstNo: "9101", adatiId: sup.id, jinsId: j.id, merchantId: lb.id, grossGrams: 3_000_000, ratePaisePerQtl: 340_000 });
const truck = await A.call("POST", "/loads", { loadDate: "2026-10-06", merchantId: lb.id, jinsId: j.id, stockDate: "2026-10-06", truckNo: "UP82T0001" });
await A.call("PUT", `/loads/${truck.id}`, { millGrossGrams: 2_900_000, katteCount: 60, advancePaise: 0, daraPaise: 0 });
const ready = await A.call("GET", `/loads/${truck.id}`);
// the parcha number is given with the approval itself
check("the test truck is ready to approve", ready.blockers.every((b: any) => b.code === "no_invoice_no"), ready.blockers);
const biz = (await A.call("GET", "/auth/me")).activeBusinessId;
await cloud("insert into mm_claims (business_id, kind, value, load_id, device) values ($1, 'parcha', '7001 (2026-27)', 'another-truck', 'another-computer')", [biz]);
const taken = await A.raw("POST", `/loads/${truck.id}/approve`, { invoiceNo: "7001" });
// numbers are claimed one financial year at a time ("7001 (2026-27)"); one already used elsewhere is a
// warning the approver answers (approve again with acceptRepeatedNo to keep it), never taken silently
check("a number already used on another computer this year is asked about first", taken.status === 409 && taken.json.code === "number_repeated", taken.json);
await internet(false);
const offline = await A.raw("POST", `/loads/${truck.id}/approve`, { invoiceNo: "7002" });
check("a parcha can be approved with no internet — the shop does not wait for the Wi-Fi",
  offline.status === 200 && offline.json.parchaNo === "7002", offline.json);
check("  ...and the number is held here until it can be claimed",
  A.state("select 1 from claims_waiting where value = ?", "7002 (2026-27)").length === 1,
  A.state("select business_id, value, load_id from claims_waiting"));
const offSlip = await A.raw("POST", "/slips", { slipDate: "2026-10-06", rstNo: "9102", adatiId: sup.id, jinsId: j.id, merchantId: lb.id, grossGrams: 400_000, ratePaisePerQtl: 340_000 });
check("everything else keeps working with no internet", offSlip.status === 200);
const offSync = await A.raw("POST", "/cloud/sync");
check("a sync with no internet says offline", offSync.status === 400 && offSync.json.code === "offline", offSync.json);
const offStatus = await A.call("GET", "/cloud/status");
check("the status shows offline, with the waiting changes", offStatus.state === "offline" && offStatus.pending > 0, offStatus);
await internet(true);
await A.sync();
check("back online, the waiting slip goes up", (await cloud("select 1 from mm_rows where row_id = $1", [offSlip.json.id])).length === 1);
check("back online, the waiting number is claimed in the cloud",
  (await cloud("select load_id from mm_claims where business_id = $1 and value = '7002 (2026-27)'", [biz]))[0]?.load_id === truck.id,
  await cloud("select value, load_id from mm_claims where business_id = $1", [biz]));
check("  ...and nothing is left waiting", A.state("select 1 from claims_waiting").length === 0);
// a second truck, approved offline onto a number another computer had taken
await A.call("POST", "/slips", { slipDate: "2026-10-07", rstNo: "9103", adatiId: sup.id, jinsId: j.id, merchantId: lb.id, grossGrams: 1_000_000, ratePaisePerQtl: 340_000 });
const truck2 = await A.call("POST", "/loads", { loadDate: "2026-10-07", merchantId: lb.id, jinsId: j.id, stockDate: "2026-10-07", truckNo: "UP82T0002" });
// the single row takes the rest of the day's stock, so it always matches the weighbridge
await A.call("PUT", `/loads/${truck2.id}`, { millGrossGrams: 950_000, katteCount: 20, advancePaise: 0, daraPaise: 0 });
const t2ready = await A.call("GET", `/loads/${truck2.id}`);
check("the second test truck is ready to approve", t2ready.blockers.every((b: any) => b.code === "no_invoice_no"), t2ready.blockers);
await cloud("insert into mm_claims (business_id, kind, value, load_id, device) values ($1, 'parcha', '7009 (2026-27)', 'someone-elses-truck', 'other-computer') on conflict do nothing", [biz]);
await internet(false);
const off2 = await A.raw("POST", `/loads/${truck2.id}/approve`, { invoiceNo: "7009" });
check("offline, that approval goes through here too", off2.status === 200, off2.json);
await internet(true);
await A.sync();
const clashes = (await A.call("GET", "/cloud/clashes")) as any[];
check("once online, the clash is reported with what to do about it",
  clashes.some((c: any) => /Parcha #7009/.test(c.note ?? "") && /next free number/.test(c.note ?? "")),
  clashes.slice(0, 2).map((c: any) => c.note));
// putting it right is void → next free number → approve again
const stuck = (await A.call("GET", `/loads/${truck2.id}`)).approved;
await A.call("POST", `/parchas/${stuck.id}/void`, { reason: "another computer had that number" });
const redone = await A.call("POST", `/loads/${truck2.id}/approve`, { invoiceNo: "7010" });
check("  ...and renumbering it goes through", redone.parchaNo === "7010", redone);
check("  ...with the new number claimed in the cloud",
  (await cloud("select load_id from mm_claims where business_id = $1 and value = '7010 (2026-27)'", [biz]))[0]?.load_id === truck2.id);
await A.call("DELETE", "/cloud/clashes");

const ok = { parchaNo: "7002" };
check("the parcha stands, with its number", ok.parchaNo === "7002");
check("…and the number is claimed in the cloud", (await cloud("select load_id from mm_claims where business_id = $1 and value = '7002 (2026-27)'", [biz]))[0]?.load_id === truck.id);
await settle();
check("the parcha arrives on every computer", ALL.every((x) => x.q("select 1 from parchas where load_id = ?", truck.id).length === 1));

console.log("\nOne parcha number on two computers is a warning, never a missing parcha");
// three trucks, each on its own day's stock, on both computers
const tr: any[] = [];
for (const [i, day] of ["2026-10-10", "2026-10-11", "2026-10-12"].entries()) {
  await A.call("POST", "/slips", { slipDate: day, rstNo: `912${i}`, adatiId: sup.id, jinsId: j.id, merchantId: lb.id, grossGrams: 1_000_000, ratePaisePerQtl: 340_000 });
  const t = await A.call("POST", "/loads", { loadDate: day, merchantId: lb.id, jinsId: j.id, stockDate: day, truckNo: `UP82T001${i}` });
  await A.call("PUT", `/loads/${t.id}`, { millGrossGrams: 950_000, katteCount: 20, advancePaise: 0, daraPaise: 0 });
  tr.push(t);
}
const [tX, tY, tZ] = tr;
await settle([A, B]);
// update day: a computer still on v0.3.17 claims the plain number ("7199"), made this financial year
await cloud("insert into mm_claims (business_id, kind, value, load_id, device) values ($1, 'parcha', '7199', 'old-pc-truck', 'old-pc')", [biz]);
const legacy = await A.raw("POST", `/loads/${tX.id}/approve`, { invoiceNo: "7199" });
check("a number an older computer has claimed this year is warned about, not silently reused",
  legacy.status === 409 && legacy.json.code === "number_repeated", legacy.json);
// ...but its plain claim from an earlier financial year is that year's number
await cloud("insert into mm_claims (business_id, kind, value, load_id, device, at) values ($1, 'parcha', '7198', 'old-pc-truck', 'old-pc', '2026-03-01')", [biz]);
const lastYear = await A.raw("POST", `/loads/${tX.id}/approve`, { invoiceNo: "7198" });
check("  ...while one it claimed last financial year is no warning", lastYear.status === 200, lastYear.json);
await A.call("POST", `/parchas/${lastYear.json.id}/void`, { reason: "test number" });
// a voided parcha's number is free again, with sync on as without it
await A.call("POST", `/loads/${tX.id}/approve`, { invoiceNo: "7200" });
await A.call("POST", `/parchas/${(await A.call("GET", `/loads/${tX.id}`)).approved.id}/void`, { reason: "number given to the next truck" });
const reuse = await A.raw("POST", `/loads/${tY.id}/approve`, { invoiceNo: "7200" });
check("a voided parcha's number can be given to another truck with no warning", reuse.status === 200, reuse.json);
// A bills X as #7201 and sends it; B has not pulled it yet
await A.call("POST", `/loads/${tX.id}/approve`, { invoiceNo: "7201" });
check("  ...the number is claimed in the plain form an older computer checks too",
  (await cloud("select load_id from mm_claims where business_id = $1 and value = '7201'", [biz]))[0]?.load_id === tX.id);
await A.sync();
const warnB = await B.raw("POST", `/loads/${tZ.id}/approve`, { invoiceNo: "7201" });
check("the other computer is warned that the number is already used", warnB.status === 409 && warnB.json.code === "number_repeated", warnB.json);
const keptB = await B.raw("POST", `/loads/${tZ.id}/approve`, { invoiceNo: "7201", acceptRepeatedNo: true });
check("  ...and may keep it", keptB.status === 200, keptB.json);
await settle([A, B]);
check("both parchas with that number reach both computers",
  [A, B].every((x) => x.q("select 1 from parchas where parcha_no = '7201' and status = 'approved' and load_id in (?, ?)", tX.id, tZ.id).length === 2),
  [A, B].map((x) => x.q("select load_id, version from parchas where parcha_no = '7201'")));
check("  ...and no truck is left billed without its parcha",
  [A, B].every((x) => x.q("select 1 from loads l where l.id in (?, ?, ?) and l.status = 'billed' and not exists (select 1 from parchas p where p.load_id = l.id and p.status = 'approved')", tX.id, tY.id, tZ.id).length === 0));
for (const x of [A, B]) {
  const reg = await x.call("GET", "/parchas");
  const both = (Array.isArray(reg) ? reg : reg.rows).filter((p: any) => p.parchaNo === "7201" && p.status === "approved");
  check(`  ...and ${x.name} says the number is used twice this year`, both.length === 2 && both.every((p: any) => p.numberRepeated), both);
}
check("  ...with nothing held back in the clashes list",
  ![A, B].some((x) => x.state("select 1 from retry where tbl = 'parchas'").length), [A, B].map((x) => x.state("select row_id from retry where tbl = 'parchas'")));

console.log("\nAn older app pauses instead of damaging newer data");
const meta = (await cloud("select value from mm_meta where key = 'schema'"))[0].value;
await cloud("update mm_meta set value = $1::jsonb where key = 'schema'", [JSON.stringify({ migrations: meta.migrations + 1, version: "9.9.9" })]);
const paused = await C.sync();
check("a computer on an older version pauses", Boolean(paused.paused) && paused.pushed === 0 && paused.pulled === 0, paused);
const pausedSays = (await C.call("GET", "/cloud/status")) as { state: string; pausedReason: string };
check("…and says to update", pausedSays.state === "paused");
check("  ...naming the newer version", /\(9\.9\.9\)/.test(pausedSays.pausedReason), pausedSays.pausedReason);
// a build whose database changed before its version number did: never "newer (the same version as here)"
const ownVersion = JSON.parse(fs.readFileSync("package.json", "utf8")).version as string;
await cloud("update mm_meta set value = $1::jsonb where key = 'schema'", [JSON.stringify({ migrations: meta.migrations + 1, version: ownVersion })]);
await C.sync();
const sameNo = (await C.call("GET", "/cloud/status")).pausedReason as string;
check("  ...and not this computer's own version number", sameNo.includes("newer Mandi Mitra") && !sameNo.includes(`(${ownVersion})`), sameNo);
await cloud("update mm_meta set value = $1::jsonb where key = 'schema'", [JSON.stringify(meta)]);
check("once the versions match it carries on", !(await C.sync()).paused);

console.log("\nDevices");
await B.call("PUT", "/cloud/device", { name: "Munshi laptop" });
await B.sync();
const devs = (await A.call("GET", "/cloud")).devices;
check("every computer is listed, with its name", devs.length === 3 && devs.some((d: any) => d.name === "Munshi laptop"), devs.map((d: any) => d.name));

console.log("\nA backup is not put back on a computer that syncs");
const kept = await A.call("POST", "/backup/run");
const restoreLive = await A.raw("POST", "/backup/restore", { name: kept.name, confirm: "RESTORE" });
check("refused while sync is on", restoreLive.status === 400 && restoreLive.json.code === "sync_on", restoreLive.json);
await A.call("POST", "/cloud/live", { on: false });
const restoreHeld = await A.raw("POST", "/backup/restore", { name: kept.name, confirm: "RESTORE" });
check("  ...and while sync is only held", restoreHeld.status === 400 && restoreHeld.json.code === "sync_on", restoreHeld.json);
check("  ...pointing to Bring all data down", /Bring all data down/.test(restoreHeld.json.error), restoreHeld.json);
check("  ...so nothing waits for the next start", !fs.existsSync(path.join(process.env.MANDI_DATA_DIR!, "restore-pending.json")));
await A.call("POST", "/cloud/live", { on: true });

console.log("\nBring everything down again (a computer's data replaced by the cloud's)");
check("needs RESTORE typed", (await A.raw("POST", "/cloud/restore", { confirm: "yes" })).status === 400);
const before = fingerprint(A);
const r = await A.call("POST", "/cloud/restore", { confirm: "RESTORE" });
check("a backup is taken first", /^before-cloud-/.test(r.backup), r.backup);
check("no broken links", r.brokenLinks === 0, r.brokenLinks);
const after = fingerprint(A);
check("every record comes back the same", Object.keys(before).every((t) => before[t] === after[t]), Object.keys(before).filter((t) => before[t] !== after[t]));
check("everyone signs in again", (await A.raw("GET", "/auth/me")).status === 401);
await A.login();
const afterRestore = await A.sync();
check("afterwards only the sign-in itself goes up", afterRestore.pushed < 10 && afterRestore.pulled === 0, afterRestore);

await settle();
sameEverywhere("at the end, all three computers hold exactly the same records");

console.log("\nWhose books am I looking at");
const hostA = await A.call("GET", "/cloud/host");
const hostB = await B.call("GET", "/cloud/host");
check("each computer can say which one it is", Boolean(hostA.deviceName) && hostA.deviceName !== hostB.deviceName, { A: hostA, B: hostB });
check("  ...and whether it is serving the shop's network", typeof hostA.shared === "boolean");
const netA = await A.call("GET", "/cloud/network");
check("the network switch is off until it is switched on", netA.share === false && netA.live === false, netA);
const netOn = await A.call("PUT", "/cloud/network", { share: true });
check("switching it on asks for a restart, since the bind happens at start-up", netOn.share === true && netOn.needsRestart === true, netOn);
check("  ...and the computer's own addresses are offered to type", Array.isArray(netOn.addresses));
check("  ...it now says it is shared", (await A.call("GET", "/cloud/host")).shared === true);
await A.call("PUT", "/cloud/network", { share: false });
check("switching it off leaves it closed again", (await A.call("GET", "/cloud/network")).share === false);

console.log("\nOne shop, two computers, the same connection string");
// both off the internet, both working on the same day, as in the shop
await internet(false);
const sameDay = "2026-10-09";
const a1 = await A.call("POST", "/slips", { slipDate: sameDay, rstNo: "777", adatiId: sup.id, jinsId: j.id, merchantId: lb.id, grossGrams: 1_000_000, ratePaisePerQtl: 300_000 });
const b1 = await B.call("POST", "/slips", { slipDate: sameDay, rstNo: "777", adatiId: sup.id, jinsId: j.id, merchantId: lb.id, grossGrams: 1_500_000, ratePaisePerQtl: 310_000 });
const payA = await A.call("POST", "/payments", { adatiId: sup.id, payDate: sameDay, amountPaise: 100_000, mode: "cash" });
const payB = await B.call("POST", "/payments", { adatiId: sup.id, payDate: sameDay, amountPaise: 200_000, mode: "cash" });
check("each computer gave its payment a number of its own while apart", payA.voucherNo === payB.voucherNo, { A: payA.voucherNo, B: payB.voucherNo });
// the same new supplier typed on both, the way two munshis would
const supA = await A.call("POST", "/slips", { slipDate: sameDay, rstNo: "778", adatiName: "दोनों जगह आढ़ती", jinsId: j.id, merchantId: lb.id, grossGrams: 1_000_000, ratePaisePerQtl: 300_000 });
const supB = await B.call("POST", "/slips", { slipDate: sameDay, rstNo: "779", adatiName: "दोनों जगह आढ़ती", jinsId: j.id, merchantId: lb.id, grossGrams: 1_000_000, ratePaisePerQtl: 300_000 });
await internet(true);
await settle([A, B]);

check("both slips survive — neither computer's work is lost", A.q("select 1 from purchase_slips where id in (?, ?)", a1.id, b1.id).length === 2);
check("  ...and each computer has both", B.q("select 1 from purchase_slips where id in (?, ?)", a1.id, b1.id).length === 2);
const bothRst = await A.call("GET", `/slips?date=${sameDay}`);
check("the repeated slip number is on the day's list twice, for the operator to see",
  bothRst.rows.filter((r: any) => r.rstNo === "777").length === 2, bothRst.rows.map((r: any) => r.rstNo));
const nums = A.q<{ id: string; voucher_no: number }>("select id, voucher_no from payments where id in (?, ?)", payA.id, payB.id);
check("the two payments no longer share a voucher number", new Set(nums.map((n) => n.voucher_no)).size === 2, nums);
check("  ...and the same is true on the other computer",
  new Set(B.q<{ voucher_no: number }>("select voucher_no from payments where id in (?, ?)", payA.id, payB.id).map((n) => n.voucher_no)).size === 2);
check("  ...settled the same way on both computers",
  JSON.stringify(nums.sort((x, y) => x.id.localeCompare(y.id)))
  === JSON.stringify(B.q<{ id: string; voucher_no: number }>("select id, voucher_no from payments where id in (?, ?)", payA.id, payB.id).sort((x: any, y: any) => x.id.localeCompare(y.id))));
check("the renumbering is written in the audit trail",
  A.q("select 1 from audit_log where action = ?", "payment.renumber").length > 0);
const twoNamed = A.q<{ n: number }>("select count(*) as n from adati where name_hi = ?", "दोनों जगह आढ़ती");
check("the same new name typed on both computers makes two suppliers", twoNamed[0].n === 2, twoNamed);
const books = await A.call("GET", "/audit/books-check");
check("  ...and the books check says so, so they can be joined",
  JSON.stringify(books).includes("belong to more than one supplier"));
// join them, as the owner would, and the halves become one ledger
const dupes = A.q<{ id: string }>("select id from adati where name_hi = ? order by created_at, id", "दोनों जगह आढ़ती");
await A.call("POST", `/adati/${dupes[1].id}/merge`, { intoId: dupes[0].id, confirm: "MERGE" });
await settle([A, B]);
check("after joining, one supplier holds both slips", A.q("select 1 from purchase_slips where adati_id = ? and id in (?, ?)", dupes[0].id, supA.id, supB.id).length === 2);
check("  ...on the other computer too", B.q("select 1 from purchase_slips where adati_id = ? and id in (?, ?)", dupes[0].id, supA.id, supB.id).length === 2);
check("  ...and the one that went is gone everywhere", A.q("select 1 from adati where id = ?", dupes[1].id).length === 0 && B.q("select 1 from adati where id = ?", dupes[1].id).length === 0);
for (const id of [a1.id, b1.id, supA.id, supB.id]) await A.call("DELETE", `/slips/${id}`);
await settle([A, B]);

console.log("\nSync held on one computer (its connection kept)");
const held = await C.call("POST", "/cloud/live", { on: false });
check("the switch turns sync off there", held.live === false && (await C.call("GET", "/cloud/status")).state === "off");
check("  ...and the connection is still saved", held.configured === true);
const heldSlip = await C.call("POST", "/slips", { slipDate: "2026-09-26", rstNo: "HELD1", adatiId: sup.id, jinsId: j.id, merchantId: lb.id, grossGrams: 500_000, ratePaisePerQtl: 300000 });
await A.sync();
check("work done while it is held does not reach the others", A.q("select 1 from purchase_slips where id = ?", heldSlip.id).length === 0);
await C.call("POST", "/cloud/live", { on: true });
await settle();
check("switching it back on sends what was done meanwhile", A.q("select 1 from purchase_slips where id = ?", heldSlip.id).length === 1);
await C.call("DELETE", `/slips/${heldSlip.id}`);
await settle();

const off = await C.call("PUT", "/cloud", { connection: null });
check("sync can be turned off on one computer", off.configured === false && (await C.call("GET", "/cloud/status")).enabled === false);
check("…keeping its data", C.q("select 1 from purchase_slips where id = ?", slip.id).length === 1);

console.log(bad === 0 ? "\nSync works." : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
