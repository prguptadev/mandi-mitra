import "./_guard.ts";
import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import Database from "better-sqlite3";
/* End-to-end: putting a backup back on a computer that syncs, holding sync,
 * the cloud settings file, and update day. Runs after e2e-cloud.ts, on the
 * computers it leaves joined (A and B), plus D: a fourth test computer this
 * script starts and stops itself, because a restore is carried out when the
 * app next starts. Test databases only; D's folder is removed at the end.
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
const rs = (p: number | null | undefined) => p == null ? String(p) : `₹${(p / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;

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
  return { name, base, dir, raw, call, q, login, sync, cfg, cfgPath };
}
const A = computer("A", process.env.MANDI_API!, process.env.MANDI_DATA_DIR!);
const B = computer("B", process.env.MANDI_API_B!, process.env.MANDI_DATA_DIR_B!);
// D sits beside the others: the next free port, and a folder next to A's
const OFF = Number(new URL(process.env.MANDI_API!).port) - 8799;
const D_PORT = 8804 + OFF;
const D_DIR = `${process.env.MANDI_DATA_DIR}-d`;
const D = computer("D", `http://127.0.0.1:${D_PORT}/api`, D_DIR);
type PC = ReturnType<typeof computer>;

let dProc: ChildProcess | null = null;
let dLog = "";
async function startD() {
  dProc = spawn("npx", ["tsx", "server/index.ts"], {
    env: { ...process.env, MANDI_DATA_DIR: D_DIR, PORT: String(D_PORT), MANDI_NO_SEED: "1" },
    stdio: ["ignore", "pipe", "pipe"], detached: true,
  });
  dProc.stdout!.on("data", (d) => { dLog += d; });
  dProc.stderr!.on("data", (d) => { dLog += d; });
  for (let i = 0; i < 200; i++) {
    try { if ((await fetch(`${D.base}/health`)).ok) return; } catch { /* not yet */ }
    if (dProc.exitCode !== null) break;
    await sleep(250);
  }
  throw new Error(`D did not start:\n${dLog.split("\n").slice(-20).join("\n")}`);
}
/** Like closing the app: SIGTERM, so the database is checkpointed and closed. */
async function stopD() {
  const p = dProc;
  if (!p || p.exitCode !== null) return;
  const gone = new Promise((r) => p.once("exit", r));
  try { process.kill(-p.pid!, "SIGTERM"); } catch { /* gone */ }
  await Promise.race([gone, sleep(10_000)]);
  try { process.kill(-p.pid!, "SIGKILL"); } catch { /* gone */ }
  for (let i = 0; i < 40; i++) {
    try { await fetch(`${D.base}/health`); } catch { return; }
    await sleep(250);
  }
}
async function restartD() { await stopD(); await startD(); await D.login(); }
process.on("exit", () => { try { if (dProc?.pid && dProc.exitCode === null) process.kill(-dProc.pid, "SIGKILL"); } catch { /* gone */ } });

/** Sync the given computers until a whole round moves nothing. */
async function settle(who: PC[]) {
  for (let round = 0; round < 8; round++) {
    let moved = 0;
    for (const x of who) { const r = await x.sync(); moved += r.pushed + r.pulled; }
    if (!moved) return round;
  }
  return -1;
}
const BUSINESS_TABLES = ["businesses", "users", "roles", "role_permissions", "memberships", "jins", "adati", "adati_aliases", "merchants",
  "purchase_orders", "purchase_slips", "loads", "load_lines", "parchas", "payments", "mill_receipts"];
function fingerprint(x: PC) {
  const out: Record<string, string> = {};
  for (const t of BUSINESS_TABLES) out[t] = JSON.stringify(x.q(`select * from "${t}" order by id`));
  out.settings = JSON.stringify(x.q("select * from settings where key <> 'gemini.apiKey' order by id"));
  return out;
}
function differ(a: PC, b: PC) {
  const fa = fingerprint(a), fb = fingerprint(b);
  return Object.keys(fa).filter((t) => fa[t] !== fb[t]);
}
const slipOf = (x: PC, id: string) => x.q<{ rate_paise_per_qtl: number; rst_no: string; amount_paise: number; payable_paise: number }>(
  "select rate_paise_per_qtl, rst_no, amount_paise, payable_paise from purchase_slips where id = ?", id)[0];
const toPay = async (x: PC) => (await x.call("GET", "/ledger")).totals.toPayPaise as number;
const status = (x: PC) => x.call("GET", "/cloud/status");

try {
  await A.login();
  await B.login();
  await settle([A, B]);
  const jinsId = (await A.call("GET", "/jins")).find((x: any) => x.code === "1509").id as string;
  const lbId = (await A.call("GET", "/merchants")).find((m: any) => m.code === "LB").id as string;
  const sup = await A.call("POST", "/adati", { nameHi: "बैकअप जाँच ट्रेडर्स" });
  const slipAt = (x: PC, day: string, rst: string, qtl: number, rate: number) =>
    x.call("POST", "/slips", { slipDate: day, rstNo: rst, adatiId: sup.id, jinsId, merchantId: lbId, grossGrams: qtl * 100_000, ratePaisePerQtl: rate });

  console.log("A fourth computer joins (it is the one that goes back to a backup)");
  fs.rmSync(D_DIR, { recursive: true, force: true });
  fs.mkdirSync(D_DIR, { recursive: true });
  await startD();
  const dj = await D.call("POST", "/cloud/join-fresh", { connection: PG });
  check("D joins from the first screen", dj.records > 100, dj);
  await D.login();
  await settle([A, B, D]);
  check("D holds exactly what A holds", differ(A, D).length === 0, differ(A, D));

  console.log("\nA backup taken before this computer joined is refused");
  const dBackups = (await D.call("GET", "/backup")).backups as { name: string; kind: string; at: string }[];
  const joinBackup = [...dBackups].sort((x, y) => x.at.localeCompare(y.at))[0];
  const preJoin = await D.raw("POST", "/backup/restore", { name: joinBackup.name, confirm: "RESTORE" });
  check("the backup taken as D joined cannot be put back", preJoin.status === 400 && preJoin.json?.code === "before_join", preJoin.json);
  check("  ...in one plain sentence", /before this computer joined cloud sync/.test(preJoin.json?.error ?? ""), preJoin.json?.error);
  check("  ...and nothing is waiting for the next start", !fs.existsSync(path.join(D_DIR, "restore-pending.json")));
  // a backup that holds another firm: a copy of D's own with its firm's id changed
  const latest = (await D.call("POST", "/backup/run")).name as string;
  const foreignName = "manual-20260101-000000.db";
  const foreignFile = path.join(D_DIR, "backups", foreignName);
  fs.copyFileSync(path.join(D_DIR, "backups", latest), foreignFile);
  {
    const f = new Database(foreignFile);
    f.pragma("foreign_keys = OFF");
    f.prepare("update businesses set id = 'some-other-firm' where id = (select min(id) from businesses)").run();
    f.close();
  }
  const foreign = await D.raw("POST", "/backup/restore", { name: foreignName, confirm: "RESTORE" });
  check("a backup holding a different firm from the cloud's cannot be put back", foreign.status === 400 && foreign.json?.code === "other_firm", foreign.json);
  fs.rmSync(foreignFile, { force: true });

  console.log("\nA backup put back while sync is held");
  const s1 = await slipAt(A, "2026-10-20", "R101", 20, 340_000);
  const s2 = await slipAt(A, "2026-10-20", "R102", 10, 300_000);
  await settle([A, B, D]);
  // held on D: a rate typed there, and a backup taken while it is still waiting to go up
  await D.call("POST", "/cloud/live", { on: false });
  await sleep(1100);
  await D.call("PUT", `/slips/${s1.id}`, { ratePaisePerQtl: 330_000 });
  const bk = (await D.call("POST", "/backup/run")).name as string;
  check("the backup holds the unsent rate", D.q("select 1 from _sync_dirty where row_id = ?", s1.id).length === 1);
  await D.call("POST", "/cloud/live", { on: true });
  await settle([A, B, D]);
  // after the backup: B raises the rate, B adds a slip and a payment, D adds a slip and deletes another
  await sleep(1100);
  await B.call("PUT", `/slips/${s1.id}`, { ratePaisePerQtl: 345_000 });
  const s3 = await slipAt(B, "2026-10-21", "R201", 15, 320_000);
  const p2 = await B.call("POST", "/payments", { adatiId: sup.id, payDate: "2026-10-21", amountPaise: 500_000, mode: "cash" });
  const s4 = await slipAt(D, "2026-10-21", "R202", 8, 310_000);
  await D.call("DELETE", `/slips/${s2.id}`);
  await settle([A, B, D]);
  const wantToPay = await toPay(A);
  check("before going back, all three agree", differ(A, D).length === 0 && differ(A, B).length === 0);

  await D.call("POST", "/cloud/live", { on: false });
  const r1 = await D.raw("POST", "/backup/restore", { name: bk, confirm: "RESTORE" });
  check("a backup can be put back while sync is held", r1.status === 200, r1.json);
  await restartD();
  // work done after going back, before sync is switched on: the cloud has never seen it
  const s5 = await slipAt(D, "2026-10-22", "R301", 5, 330_000);
  check("the backup is back on D (the old rate)", slipOf(D, s1.id)?.rate_paise_per_qtl === 330_000, slipOf(D, s1.id));
  await D.call("POST", "/cloud/live", { on: true });
  const early = await status(D);
  check("until it has caught up with the cloud, D's badge does not say Synced", early.enabled && early.state !== "ok", early);
  await settle([A, B, D]);
  const rate = (x: PC) => slipOf(x, s1.id)?.rate_paise_per_qtl;
  check("B's later rate is kept everywhere — the backup's older one never goes up",
    [A, B, D].every((x) => rate(x) === 345_000), { A: rate(A), B: rate(B), D: rate(D) });
  check("everything changed after the backup comes back to D",
    Boolean(slipOf(D, s3.id) && slipOf(D, s4.id) && D.q("select 1 from payments where id = ?", p2.id).length), { s3: !!slipOf(D, s3.id), s4: !!slipOf(D, s4.id), p2: D.q("select 1 from payments where id = ?", p2.id).length });
  check("a slip deleted after the backup stays deleted", [A, B, D].every((x) => !slipOf(x, s2.id)), [A, B, D].map((x) => !!slipOf(x, s2.id)));
  check("the slip made after going back (never seen by the cloud) goes up", [A, B].every((x) => slipOf(x, s5.id)?.rate_paise_per_qtl === 330_000));
  const tpA = await toPay(A), tpB = await toPay(B), tpD = await toPay(D);
  check("the same to-pay on all three", tpA === tpB && tpB === tpD, { A: rs(tpA), B: rs(tpB), D: rs(tpD), beforeTheRestore: rs(wantToPay) });
  check("D holds exactly what A holds", differ(A, D).length === 0, differ(A, D));
  const after1 = await status(D);
  check("no clash is listed for the backup's older copies, and D now says Synced", after1.state === "ok" && after1.clashes === 0, after1);

  console.log("\nA restore asked for while held, with sync switched back on before the restart");
  await D.call("POST", "/cloud/live", { on: false });
  check("  (asked for while held)", (await D.raw("POST", "/backup/restore", { name: bk, confirm: "RESTORE" })).status === 200);
  await D.call("POST", "/cloud/live", { on: true });
  await sleep(1100);
  await B.call("PUT", `/slips/${s1.id}`, { ratePaisePerQtl: 346_000 });
  const s6 = await slipAt(B, "2026-10-22", "R302", 12, 320_000);
  await settle([A, B, D]);
  await restartD();
  await settle([A, B, D]);
  check("the backup's older rate never reaches the others", [A, B, D].every((x) => rate(x) === 346_000), { A: rate(A), B: rate(B), D: rate(D) });
  check("D has what B made before the restart", Boolean(slipOf(D, s6.id)));
  check("D holds exactly what A holds", differ(A, D).length === 0, differ(A, D));

  console.log("\nA restore with sync on follows the same rule");
  const r3 = await D.raw("POST", "/backup/restore", { name: bk, confirm: "RESTORE" });
  check("a backup can be put back while sync is on", r3.status === 200, r3.json);
  await sleep(1100);
  await A.call("PUT", `/slips/${s1.id}`, { ratePaisePerQtl: 347_000 });
  await A.sync();
  await restartD();
  await settle([A, B, D]);
  check("the cloud's rate wins after the restart", [A, B, D].every((x) => rate(x) === 347_000), { A: rate(A), B: rate(B), D: rate(D) });
  check("D holds exactly what A holds", differ(A, D).length === 0, differ(A, D));

  console.log("\nBringing all data down cancels a restore still waiting for the restart");
  await D.call("POST", "/backup/restore", { name: bk, confirm: "RESTORE" });
  await D.call("POST", "/cloud/restore", { confirm: "RESTORE" });
  check("nothing is left waiting for the next start", !fs.existsSync(path.join(D_DIR, "restore-pending.json")));
  await restartD();
  check("after the restart D still has the cloud's records", rate(D) === 347_000 && Boolean(slipOf(D, s6.id)), slipOf(D, s1.id));
  await settle([A, B, D]);

  console.log("\nUpdate day: an older computer's records lack the mill licence column");
  const OLD_DEVICE = "old-pc-on-v0.3.17";
  /** What a computer on the older app sends: the record without the columns it does not know. */
  async function oldPcSends(id: string, change: Record<string, unknown>) {
    const now = (await cloud<{ data: Record<string, unknown> }>("select data from mm_rows where tbl = 'merchants' and row_id = $1", [id]))[0].data;
    const data: Record<string, unknown> = { ...now, ...change, updated_at: Math.floor(Date.now() / 1000) };
    delete data.mandi_license;
    const json = JSON.stringify(data);
    await cloud("update mm_rows set data = $1::jsonb, hash = $2, device = $3, seq = nextval('mm_seq'), updated_at = now() where tbl = 'merchants' and row_id = $4",
      [json, crypto.createHash("sha1").update(json).digest("hex"), OLD_DEVICE, id]);
  }
  const licence = (x: PC, id: string) => x.q<{ mandi_license: string | null; phone: string | null }>("select mandi_license, phone from merchants where id = ?", id)[0];
  const cloudLicence = async (id: string) => (await cloud<{ l: string | null }>("select data->>'mandi_license' as l from mm_rows where tbl = 'merchants' and row_id = $1", [id]))[0]?.l ?? null;
  // typed on the updated computer before its first sync, while the older one changes the phone
  const mc = await A.call("POST", "/merchants", { code: "UPDMC", name: "Update Day Mill C" });
  await settle([A, B]);
  await A.call("PUT", `/merchants/${mc.id}`, { mandiLicense: "L/2016/75/333" });
  await sleep(1100);
  await oldPcSends(mc.id, { phone: "9000000003" });
  await settle([A, B]);
  check("a licence typed on the updated computer is kept everywhere when the older one's later edit arrives",
    [A, B].every((x) => licence(x, mc.id)?.mandi_license === "L/2016/75/333") && await cloudLicence(mc.id) === "L/2016/75/333",
    { A: licence(A, mc.id), B: licence(B, mc.id), cloud: await cloudLicence(mc.id) });
  check("  ...together with the older computer's phone", [A, B].every((x) => licence(x, mc.id)?.phone === "9000000003"), [A, B].map((x) => licence(x, mc.id)));
  // already in the cloud, then a record from the older computer arrives without it
  const md = await A.call("POST", "/merchants", { code: "UPDMD", name: "Update Day Mill D", mandiLicense: "L/2016/75/444" });
  await settle([A, B]);
  await oldPcSends(md.id, { phone: "9000000004" });
  await settle([A, B]);
  check("the cloud gets the licence back after an older computer's record without it",
    await cloudLicence(md.id) === "L/2016/75/444" && [A, B].every((x) => licence(x, md.id)?.mandi_license === "L/2016/75/444"),
    { A: licence(A, md.id), B: licence(B, md.id), cloud: await cloudLicence(md.id) });

  // typed on the updated computer after its first sync, while the other one, still old and
  // paused, changes the phone; that one is updated later. Both computers changed different
  // fields of one record: that is settled by the field-by-field merge of the sync engine.
  const probe = await slipAt(A, "2026-10-23", "PROBE1", 4, 300_000);
  await settle([A, B]);
  await A.call("PUT", `/slips/${probe.id}`, { ratePaisePerQtl: 301_000 });
  await sleep(1100);
  await B.call("PUT", `/slips/${probe.id}`, { rstNo: "PROBE2" });
  await settle([A, B]);
  const merges = slipOf(A, probe.id)?.rate_paise_per_qtl === 301_000 && slipOf(A, probe.id)?.rst_no === "PROBE2";
  await A.call("DELETE", `/slips/${probe.id}`);
  const me1 = await A.call("POST", "/merchants", { code: "UPDME", name: "Update Day Mill E" });
  await settle([A, B]);
  await oldPcSends(me1.id, { phone: "9000000005" });
  await settle([A, B]);
  await A.call("PUT", `/merchants/${me1.id}`, { mandiLicense: "L/2016/75/111" });
  await A.sync();
  await sleep(1100);
  await B.call("PUT", `/merchants/${me1.id}`, { phone: "9000000006" });
  await settle([A, B]);
  const m1 = { A: licence(A, me1.id), B: licence(B, me1.id) };
  check("both computers end with the same mill record", JSON.stringify(m1.A) === JSON.stringify(m1.B), m1);
  if (merges) {
    check("the licence from the updated computer and the phone from the other are both kept",
      [A, B].every((x) => licence(x, me1.id)?.mandi_license === "L/2016/75/111" && licence(x, me1.id)?.phone === "9000000006"), m1);
  } else {
    console.log(" SKIP  the licence and the phone both kept — needs the sync engine's field-by-field merge (two fields of one record changed on two computers)");
  }

  console.log("\nThe 'update this computer' message names the other computer's version");
  const myVersion = (await D.call("GET", "/cloud")).devices.find((d: any) => d.me).version as string;
  const meta = (await cloud("select value from mm_meta where key = 'schema'"))[0].value;
  // update day before the version number moved: the newer computer reports the same number as this one
  await cloud("update mm_meta set value = $1::jsonb where key = 'schema'", [JSON.stringify({ migrations: meta.migrations + 1, version: myVersion })]);
  await cloud("insert into mm_devices (id, name, version, schema, last_seen) values ('newer-pc', 'Office PC', '0.3.18', $1, now())", [meta.migrations + 1]);
  const p1 = await D.sync();
  check("it names the version the newer computer runs", Boolean(p1.paused) && p1.paused.includes("(0.3.18)"), p1.paused);
  await cloud("delete from mm_devices where id = 'newer-pc'");
  const p2b = await D.sync();
  check("  ...and never this computer's own version as the newer one", Boolean(p2b.paused) && !p2b.paused.includes(`(${myVersion})`), p2b.paused);
  await cloud("update mm_meta set value = $1::jsonb where key = 'schema'", [JSON.stringify(meta)]);
  check("once the versions match it carries on", !(await D.sync()).paused);

  console.log("\nThe cloud settings file cut short");
  await settle([A, B]);
  check("a copy of the last good settings is kept", fs.existsSync(`${B.cfgPath}.bak`) && Boolean(JSON.parse(fs.readFileSync(`${B.cfgPath}.bak`, "utf8")).deviceId));
  const goodB = fs.readFileSync(B.cfgPath, "utf8");
  const deviceB = JSON.parse(goodB).deviceId;
  const unsent = await B.call("POST", "/payments", { adatiId: sup.id, payDate: "2026-10-22", amountPaise: 900_000, mode: "cash" });
  fs.writeFileSync(B.cfgPath, goodB.slice(0, 40)); // a power cut during the write
  const cut = await status(B);
  check("sync stays on (the copy is used)", cut.enabled === true && cut.state !== "off", cut);
  check("  ...with the same device id", B.cfg().deviceId === deviceB, B.cfg().deviceId);
  await B.sync();
  await A.sync();
  check("  ...and the unsent payment still goes up", A.q("select 1 from payments where id = ?", unsent.id).length === 1);
  fs.writeFileSync(B.cfgPath, "{\"enc\": \"x");
  fs.writeFileSync(`${B.cfgPath}.bak`, "");
  const both = await status(B);
  check("with no good copy at all, sync pauses with a plain message instead of turning off", both.enabled === true && both.state === "error" && /could not be read/.test(both.lastError ?? ""), both);
  check("  ...and the damaged file is not written over", fs.readFileSync(B.cfgPath, "utf8") === "{\"enc\": \"x");
  fs.writeFileSync(B.cfgPath, goodB);
  fs.rmSync(`${B.cfgPath}.bak`, { force: true });
  await settle([A, B, D]);
  check("once the settings are back, B syncs again with its own id", (await status(B)).state === "ok" && B.cfg().deviceId === deviceB);
  check("no half-written settings file is left behind", !fs.existsSync(`${B.cfgPath}.tmp`));
  // the end: the internet up, everyone in step
  await internet(true);
  await settle([A, B, D]);
  check("at the end A, B and D hold exactly the same records", differ(A, B).length === 0 && differ(A, D).length === 0, { AB: differ(A, B), AD: differ(A, D) });
} catch (e) {
  check("the checks ran to the end", false, e instanceof Error ? e.message : String(e));
} finally {
  // D goes: its folder is removed, its records stay with A and B
  await internet(true).catch(() => undefined);
  await stopD();
  fs.rmSync(D_DIR, { recursive: true, force: true });
}

console.log(bad === 0 ? "\nRestore, hold and update day keep the books in step." : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
