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
  return { name, raw, call, q, login, sync, cfg, setCfg };
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
check("a backup of what was there is taken first", /^manual-/.test(joined.backup), joined.backup);
check("no broken links after joining", joined.brokenLinks === 0, joined.brokenLinks);
check("everyone signs in again after joining", (await B.raw("GET", "/auth/me")).status === 401);
check("the office's people are now here (Admin was replaced)", (await B.call("GET", "/auth/users")).some((u: any) => u.name === "Test Owner"));
await B.login();
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
await cloud("insert into mm_claims (business_id, kind, value, load_id, device) values ($1, 'parcha', '7001', 'another-truck', 'another-computer')", [biz]);
const taken = await A.raw("POST", `/loads/${truck.id}/approve`, { invoiceNo: "7001" });
check("a number already used on another computer is refused", taken.status === 409 && taken.json.code === "number_taken", taken.json);
await internet(false);
const offline = await A.raw("POST", `/loads/${truck.id}/approve`, { invoiceNo: "7002" });
check("approving with no internet is refused, saying why", offline.status === 409 && offline.json.code === "offline", offline.json);
const offSlip = await A.raw("POST", "/slips", { slipDate: "2026-10-06", rstNo: "9102", adatiId: sup.id, jinsId: j.id, merchantId: lb.id, grossGrams: 400_000, ratePaisePerQtl: 340_000 });
check("everything else keeps working with no internet", offSlip.status === 200);
const offSync = await A.raw("POST", "/cloud/sync");
check("a sync with no internet says offline", offSync.status === 400 && offSync.json.code === "offline", offSync.json);
const offStatus = await A.call("GET", "/cloud/status");
check("the status shows offline, with the waiting changes", offStatus.state === "offline" && offStatus.pending > 0, offStatus);
await internet(true);
await A.sync();
check("back online, the waiting slip goes up", (await cloud("select 1 from mm_rows where row_id = $1", [offSlip.json.id])).length === 1);
const ok = await A.call("POST", `/loads/${truck.id}/approve`, { invoiceNo: "7002" });
check("approving works once online", ok.parchaNo === "7002");
check("…and the number is claimed in the cloud", (await cloud("select load_id from mm_claims where business_id = $1 and value = '7002'", [biz]))[0]?.load_id === truck.id);
await settle();
check("the parcha arrives on every computer", ALL.every((x) => x.q("select 1 from parchas where load_id = ?", truck.id).length === 1));

console.log("\nAn older app pauses instead of damaging newer data");
const meta = (await cloud("select value from mm_meta where key = 'schema'"))[0].value;
await cloud("update mm_meta set value = $1::jsonb where key = 'schema'", [JSON.stringify({ migrations: meta.migrations + 1, version: "9.9.9" })]);
const paused = await C.sync();
check("a computer on an older version pauses", Boolean(paused.paused) && paused.pushed === 0 && paused.pulled === 0, paused);
check("…and says to update", (await C.call("GET", "/cloud/status")).state === "paused");
await cloud("update mm_meta set value = $1::jsonb where key = 'schema'", [JSON.stringify(meta)]);
check("once the versions match it carries on", !(await C.sync()).paused);

console.log("\nDevices");
await B.call("PUT", "/cloud/device", { name: "Munshi laptop" });
await B.sync();
const devs = (await A.call("GET", "/cloud")).devices;
check("every computer is listed, with its name", devs.length === 3 && devs.some((d: any) => d.name === "Munshi laptop"), devs.map((d: any) => d.name));

console.log("\nBring everything down again (a computer's data replaced by the cloud's)");
check("needs RESTORE typed", (await A.raw("POST", "/cloud/restore", { confirm: "yes" })).status === 400);
const before = fingerprint(A);
const r = await A.call("POST", "/cloud/restore", { confirm: "RESTORE" });
check("a backup is taken first", /^manual-/.test(r.backup), r.backup);
check("no broken links", r.brokenLinks === 0, r.brokenLinks);
const after = fingerprint(A);
check("every record comes back the same", Object.keys(before).every((t) => before[t] === after[t]), Object.keys(before).filter((t) => before[t] !== after[t]));
check("everyone signs in again", (await A.raw("GET", "/auth/me")).status === 401);
await A.login();
const afterRestore = await A.sync();
check("afterwards only the sign-in itself goes up", afterRestore.pushed < 10 && afterRestore.pulled === 0, afterRestore);

await settle();
sameEverywhere("at the end, all three computers hold exactly the same records");

const off = await C.call("PUT", "/cloud", { connection: null });
check("sync can be turned off on one computer", off.configured === false && (await C.call("GET", "/cloud/status")).enabled === false);
check("…keeping its data", C.q("select 1 from purchase_slips where id = ?", slip.id).length === 1);

console.log(bad === 0 ? "\nSync works." : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
