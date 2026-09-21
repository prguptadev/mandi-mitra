import "./_guard.ts";
import pg from "pg";
import { sqlite } from "../server/db/client.ts";
/* End-to-end: the cloud copy, against a real Postgres running in-process
 * (scripts/fake-postgres.ts), on the test database only. Runs after every
 * other script, so the copy holds everything the tests created; the money
 * audit then runs over the data restored from it.
 * Run through: npm run test:e2e
 */
const BASE = process.env.MANDI_API!;
const PG = process.env.MANDI_FAKE_PG!;
let cookie = "";
let bad = 0;
async function raw(method: string, p: string, body?: unknown) {
  const res = await fetch(BASE + p, {
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
  if (r.status >= 400) throw new Error(`${method} ${p} -> ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
}
const check = (label: string, ok: boolean, got?: unknown) => {
  if (!ok) bad++;
  console.log(` ${ok ? "PASS" : "FAIL"}  ${label}${got === undefined ? "" : `   ${JSON.stringify(got)}`}`);
};
async function cloud<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: PG });
  await c.connect();
  try { return (await c.query(sql, params)).rows as T[]; } finally { await c.end(); }
}
async function login() {
  const users = await call("GET", "/auth/users");
  await call("POST", "/auth/login", { userId: users.find((u: any) => u.name === "Test Owner").id, pin: process.env.MANDI_PIN ?? "482915" });
  const me = await call("GET", "/auth/me");
  const vldm = me.businesses.find((b: any) => b.shortCode === "VLDM");
  if (vldm && me.activeBusinessId !== vldm.businessId) await call("POST", "/auth/switch-business", { businessId: vldm.businessId });
}
const localCount = (t: string) => (sqlite.prepare(`select count(*) as n from "${t}"`).get() as { n: number }).n;
const SYNCED = ["purchase_slips", "adati", "merchants", "loads", "load_lines", "parchas", "payments", "mill_receipts", "audit_log", "users", "roles", "role_permissions", "scan_batches"];

await login();
console.log("Set up");
check("not set up to begin with", (await call("GET", "/cloud")).configured === false);
check("a string that is not a database address is refused", (await raw("PUT", "/cloud", { connection: "hello" })).status === 400);
check("Supabase's [YOUR-PASSWORD] left in is caught", (await raw("PUT", "/cloud", { connection: "postgresql://postgres.abc:[YOUR-PASSWORD]@aws-0.pooler.supabase.com:6543/postgres" })).status === 400);
const set = await call("PUT", "/cloud", { connection: PG });
check("a working database is accepted", set.configured === true && set.host === new URL(PG).hostname + ":" + new URL(PG).port + "/postgres", set.host);
check("the password is never shown back", !JSON.stringify(await call("GET", "/cloud")).includes(new URL(PG).password));

console.log("\nFirst push");
const s1 = await call("POST", "/cloud/sync");
check("everything goes up", s1.pushed > 100 && s1.lastError === null, { pushed: s1.pushed });
const counts = await cloud<{ tbl: string; n: string }>("select tbl, count(*) as n from mm_rows where not deleted group by tbl");
const cnt = (t: string) => Number(counts.find((x) => x.tbl === t)?.n ?? 0);
const mismatched = SYNCED.filter((t) => cnt(t) !== localCount(t) && !(t === "settings"));
check("every table has the same number of rows up there", mismatched.length === 0, mismatched.map((t) => `${t}: ${localCount(t)} here, ${cnt(t)} there`));
check("logins and the change queue stay here", cnt("sessions") === 0 && cnt("sync_outbox") === 0 && cnt("__drizzle_migrations") === 0);
check("the Gemini key stays here", (await cloud("select 1 from mm_rows where tbl = 'settings' and data->>'key' = 'gemini.apiKey'")).length === 0);
check("the model's raw replies are left out", (await cloud("select 1 from mm_rows where tbl = 'scan_batches' and data->>'raw_response' is not null")).length === 0);
const st1 = await call("GET", "/cloud");
check("the space used is reported against the free 500 MB", st1.sizeBytes > 0 && st1.freeBytes === 500 * 1024 * 1024, { mb: (st1.sizeBytes / 1048576).toFixed(2) });

console.log("\nOnly changes go up");
check("a second push sends nothing", (await call("POST", "/cloud/sync")).pushed === 0);
const slip = sqlite.prepare("select id, rate_paise_per_qtl as r from purchase_slips where rate_paise_per_qtl > 0 limit 1").get() as { id: string; r: number };
await call("PUT", `/slips/${slip.id}`, { ratePaisePerQtl: slip.r + 100 });
const s2 = await call("POST", "/cloud/sync");
check("one edited slip goes up (with its audit line)", s2.pushed >= 1 && s2.pushed <= 4, s2.pushed);
const up = await cloud<{ r: number }>("select (data->>'rate_paise_per_qtl')::int as r from mm_rows where tbl = 'purchase_slips' and row_id = $1", [slip.id]);
check("…with the new rate", up[0]?.r === slip.r + 100, up[0]);
const victim = sqlite.prepare("select id from purchase_slips order by created_at desc limit 1").get() as { id: string };
await call("DELETE", `/slips/${victim.id}`);
await call("POST", "/cloud/sync");
const gone = await cloud<{ deleted: boolean }>("select deleted from mm_rows where tbl = 'purchase_slips' and row_id = $1", [victim.id]);
check("a deleted slip is marked deleted up there, not lost", gone[0]?.deleted === true, gone[0]);

console.log("\nRestore");
check("restore needs RESTORE typed", (await raw("POST", "/cloud/restore", { confirm: "yes" })).status === 400);
const before = Object.fromEntries(SYNCED.map((t) => [t, localCount(t)]));
const r = await call("POST", "/cloud/restore", { confirm: "RESTORE" });
check("a backup is taken before anything is replaced", /^manual-/.test(r.backup), r.backup);
check("no broken links after restoring", r.brokenLinks === 0, r.brokenLinks);
const after = Object.fromEntries(SYNCED.map((t) => [t, localCount(t)]));
const diff = SYNCED.filter((t) => before[t] !== after[t] && t !== "audit_log");
check("every table comes back with the same rows", diff.length === 0, diff.map((t) => `${t}: ${before[t]} → ${after[t]}`));
check("the deleted slip stays deleted", !(sqlite.prepare("select 1 from purchase_slips where id = ?").get(victim.id)));
check("everyone signs in again", (await raw("GET", "/auth/me")).status === 401);
await login();
const slipsUp = async () => Number((await cloud<{ n: string }>("select count(*) as n from mm_rows where tbl = 'purchase_slips' and not deleted"))[0].n);
const slipsBefore = await slipsUp();
const afterRestore = (await call("POST", "/cloud/sync")).pushed;
// signing in again writes the user's last sign-in and an audit line; nothing else may go up
check("after a restore only the sign-in itself goes up", afterRestore < 10 && (await slipsUp()) === slipsBefore, afterRestore);
const off = await call("PUT", "/cloud", { connection: null });
check("the cloud copy can be turned off", off.configured === false);

console.log(bad === 0 ? "\nCloud copy works." : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
