import "./_guard.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { execFileSync, spawn, spawnSync } from "node:child_process";

/* The books survive what a shop PC does to them: the power going mid-save, a
 * damaged or missing books file, an update that cannot apply, a full disk, an
 * installer Windows will not start. Every check runs the real start-up path
 * (or the real server) on a throwaway copy of the test books; the test books
 * themselves are only read.
 * Run through: npm run test:e2e
 */

const OFF = Number(process.env.E2E_PORT_OFFSET ?? 0);
const PORT = 8804 + OFF;
const PIN = process.env.MANDI_PIN ?? "482915";
const ROOT = path.resolve("data-test-desk");
const SRC = path.join(process.env.MANDI_DATA_DIR!, "mandi.db");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A folder holding a copy of the test books as mandi.db (plus a probe table spanning many pages). */
function books(sub: string, opts: { probe?: boolean } = {}) {
  const dir = path.join(ROOT, sub);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("sqlite3", [SRC, `.backup ${path.join(dir, "mandi.db")}`]);
  if (opts.probe) {
    const d = new Database(path.join(dir, "mandi.db"));
    d.exec(`create table _desk_probe (id integer primary key, x text);
      with recursive n(i) as (select 1 union all select i + 1 from n where i < 3000)
      insert into _desk_probe (x) select hex(randomblob(40)) || i from n;
      create index _desk_probe_idx on _desk_probe(x);`);
    d.pragma("wal_checkpoint(TRUNCATE)");
    d.close();
  }
  return dir;
}
/** A good backup of the books in `dir`, under `name`, carrying a table that says where it came from. */
function backupInto(dir: string, name: string, mark: string) {
  fs.mkdirSync(path.join(dir, "backups"), { recursive: true });
  const file = path.join(dir, "backups", name);
  execFileSync("sqlite3", [path.join(dir, "mandi.db"), `.backup ${file}`]);
  const d = new Database(file);
  d.exec(`create table "${mark}" (x)`);
  d.pragma("journal_mode = DELETE");
  d.close();
  return file;
}
/** Read-only looks at a copy; a file that cannot be read answers false / -1 rather than stopping the checks. */
function look<T>(file: string, fn: (d: Database.Database) => T, otherwise: T): T {
  try {
    const d = new Database(file, { readonly: true, fileMustExist: true });
    try { return fn(d); } finally { d.close(); }
  } catch { return otherwise; }
}
const hasTable = (file: string, t: string) => look(file, (d) => Boolean(d.prepare("select 1 from sqlite_master where name = ?").get(t)), false);
const count = (file: string, t: string) => look(file, (d) => (d.prepare(`select count(*) as n from "${t}"`).get() as { n: number }).n, -1);
const whole = (file: string) => look(file, (d) => d.pragma("quick_check", { simple: true }) === "ok", false);
const migrationsIn = (file: string) => count(file, "__drizzle_migrations");
/** Scribbles over the body of one page of a table or index, as a torn write or a bad sector does. */
function damagePage(file: string, name: string) {
  const d = new Database(file, { readonly: true });
  const ps = d.pragma("page_size", { simple: true }) as number;
  const leaves = d.prepare("select pageno from dbstat where name = ? and pagetype = 'leaf' order by pageno").pluck().all(name) as number[];
  d.close();
  const page = leaves[Math.floor(leaves.length / 2)];
  const fd = fs.openSync(file, "r+");
  fs.writeSync(fd, Buffer.alloc(ps - 100, 0xff), 0, ps - 100, (page - 1) * ps + 50);
  fs.closeSync(fd);
}
/** A torn write in an index page's header (its free-space list): found by the check, mended by rebuilding the index. */
function damageIndexPage(file: string, name: string) {
  const d = new Database(file, { readonly: true });
  const ps = d.pragma("page_size", { simple: true }) as number;
  const leaves = d.prepare("select pageno from dbstat where name = ? and pagetype = 'leaf' order by pageno").pluck().all(name) as number[];
  d.close();
  const fd = fs.openSync(file, "r+");
  fs.writeSync(fd, Buffer.from([0xff, 0xf0]), 0, 2, (leaves[Math.floor(leaves.length / 2)] - 1) * ps + 1);
  fs.closeSync(fd);
}
function damageHeader(file: string) {
  const fd = fs.openSync(file, "r+");
  fs.writeSync(fd, Buffer.from("this is not a database any more, a torn write".padEnd(100, "#")), 0, 100, 0);
  fs.closeSync(fd);
}
/**
 * Commits in a -wal file since it was last reset: frames carrying a commit mark
 * under the file's current salt. With synchronous = FULL, each one is a flush to the disk.
 */
function walCommits(file: string) {
  let b: Buffer;
  try { b = fs.readFileSync(file); } catch { return 0; }
  if (b.length < 32) return 0;
  const ps = b.readUInt32BE(8), s1 = b.readUInt32BE(16), s2 = b.readUInt32BE(20);
  let n = 0;
  for (let at = 32; at + 24 + ps <= b.length; at += 24 + ps) {
    if (b.readUInt32BE(at + 8) !== s1 || b.readUInt32BE(at + 12) !== s2) break;
    if (b.readUInt32BE(at + 4) !== 0) n++;
  }
  return n;
}
/**
 * The newest rows only in the -wal side file, as a cut-off run leaves them: the
 * books are copied while a connection that wrote them is still open.
 */
function hotWal(dir: string) {
  const db = path.join(dir, "mandi.db");
  const w = path.join(dir, "wal-src");
  fs.mkdirSync(w, { recursive: true });
  fs.copyFileSync(db, path.join(w, "mandi.db"));
  const d = new Database(path.join(w, "mandi.db"));
  d.pragma("journal_mode = WAL");
  d.pragma("wal_autocheckpoint = 0");
  d.exec("create table _desk_in_wal (x); insert into _desk_in_wal values (1);");
  fs.copyFileSync(path.join(w, "mandi.db"), db);
  fs.copyFileSync(path.join(w, "mandi.db-wal"), `${db}-wal`);
  d.close();
  fs.rmSync(w, { recursive: true, force: true });
}
/** The books file and its -wal, byte for byte. */
const asTheyAre = (dir: string) => ({ db: fs.readFileSync(path.join(dir, "mandi.db")), wal: fs.readFileSync(path.join(dir, "mandi.db-wal")) });
/** The one damaged-… copy in backups/ is exactly `was` (the books file and its -wal). */
function keptExactly(dir: string, was: { db: Buffer; wal: Buffer }) {
  const kept = inBackups(dir, /^damaged-\d{8}-\d{6}\.db$/);
  if (kept.length !== 1) return false;
  const f = path.join(dir, "backups", kept[0]);
  try { return fs.readFileSync(f).equals(was.db) && fs.readFileSync(`${f}-wal`).equals(was.wal); } catch { return false; }
}
const MB = 1024 ** 2, GB = 1024 ** 3;
/** The time in a backup's name (local time, as server/lib/backup.ts writes it). */
const stampOf = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
/**
 * Half a year of backups as the counts leave them, each `bytes` long (sparse
 * files: they take no room on the disk): two automatic ones a day for the last
 * 15 days, one a week for 26 weeks before that, a before-update copy a month
 * and three by hand. Returns their names.
 */
function history(dir: string, bytes: number) {
  fs.mkdirSync(dir, { recursive: true });
  const at = (daysAgo: number, hour: number) => { const d = new Date(); d.setDate(d.getDate() - daysAgo); d.setHours(hour, 0, 0, 0); return stampOf(d); };
  const names: string[] = [];
  for (let i = 1; i <= 15; i++) for (const h of [9, 21]) names.push(`auto-${at(i, h)}.db`);
  for (let w = 0; w < 26; w++) names.push(`auto-${at(18 + 7 * w, 21)}.db`);
  for (let m = 0; m < 6; m++) names.push(`before-update-${at(10 + 30 * m, 8)}.db`);
  for (const d of [5, 40, 100]) names.push(`manual-${at(d, 12)}.db`);
  for (const n of names) { fs.writeFileSync(path.join(dir, n), ""); fs.truncateSync(path.join(dir, n), bytes); }
  return names;
}
/** This computer's sub-folder in the second folder (as server/lib/backup.ts names it). */
const hostDirOf = () => os.hostname().replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 40) || "this-computer";
/** As if the last run was cut off (power cut, crash, killed): the clean-close mark is still there. */
const cutOff = (dir: string) => fs.writeFileSync(path.join(dir, "books-open.json"), JSON.stringify({ pid: 1, at: new Date().toISOString() }));
const notice = (dir: string) => { try { return JSON.parse(fs.readFileSync(path.join(dir, "start-notice.json"), "utf8")); } catch { return null; } };
const backupCfg = (dir: string) => { try { return JSON.parse(fs.readFileSync(path.join(dir, "backup.json"), "utf8")); } catch { return null; } };
const inBackups = (dir: string, re: RegExp) => { try { return fs.readdirSync(path.join(dir, "backups")).filter((f) => re.test(f)); } catch { return []; } };

/** The start-up path (open the books, apply updates), in its own process, as the app runs it. */
function startup(dir: string, env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, ["--import", "tsx", "server/db/migrate.ts"], {
    env: { ...process.env, MANDI_DATA_DIR: dir, MANDI_NO_AUTO_BACKUP: "1", ...env }, encoding: "utf8",
  });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}
/** One of the unit checks below, in its own process on `dir`; its last line is JSON. */
function unitRun(dir: string, name: string, args: string[] = [], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/e2e-desk-safe.ts", "unit", name, ...args], {
    env: { ...process.env, MANDI_DATA_DIR: dir, MANDI_NO_AUTO_BACKUP: "1", ...env }, encoding: "utf8",
  });
  const lines = `${r.stdout}`.trim().split("\n");
  try { return JSON.parse(lines[lines.length - 1]); } catch { return { error: `${r.stdout}\n${r.stderr}`.slice(-1500) }; }
}
/** The real server on a copy. */
async function serve(dir: string, env: Record<string, string> = {}) {
  const child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    env: { ...process.env, MANDI_DATA_DIR: dir, PORT: String(PORT), MANDI_NO_AUTO_BACKUP: "1", MANDI_NO_SEED: "1", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout!.on("data", (d) => { log += d; });
  child.stderr!.on("data", (d) => { log += d; });
  const base = `http://127.0.0.1:${PORT}/api`;
  let up = false;
  for (let i = 0; i < 160 && child.exitCode === null && !up; i++) {
    try { up = (await fetch(`${base}/health`)).ok; } catch { await sleep(250); }
  }
  let cookie = "";
  const call = async (method: string, p: string, body?: unknown) => {
    let res: Response;
    try {
      res = await fetch(base + p, { method, headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e) { return { status: 0, json: String(e) as any }; } // the server is not there
    const sc = res.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, json };
  };
  const login = async () => {
    const users = (await call("GET", "/auth/users")).json;
    const owner = Array.isArray(users) ? users.find((u: { name: string }) => u.name === "Test Owner") : null;
    return owner ? (await call("POST", "/auth/login", { userId: owner.id, pin: PIN })).status === 200 : false;
  };
  const stop = async (sig: NodeJS.Signals = "SIGTERM") => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const gone = new Promise((r) => child.once("exit", r));
    child.kill(sig);
    await gone;
  };
  return { up, call, login, stop, log: () => log };
}
/** A slip as the clerk saves it. */
async function saveSlip(s: Awaited<ReturnType<typeof serve>>, rst: string) {
  const jins = (await s.call("GET", "/jins")).json;
  return s.call("POST", "/slips", { slipDate: "2026-12-03", rstNo: rst, adatiName: "डेस्क सेफ आढ़ती", jinsId: jins?.[0]?.id, grossGrams: 1_000_000, ratePaisePerQtl: 300000 });
}
/** This app's migrations, with one more (a new release's) or one fewer (the release before). */
function migrations(name: string, extra?: { tag: string; sql: string }, dropLast = false) {
  const from = path.resolve("server/db/migrations");
  const to = path.join(ROOT, `migrations-${name}`);
  fs.cpSync(from, to, { recursive: true });
  const jp = path.join(to, "meta", "_journal.json");
  const j = JSON.parse(fs.readFileSync(jp, "utf8")) as { entries: { idx: number; when: number; tag: string; version: string; breakpoints: boolean }[] };
  if (dropLast) j.entries.pop();
  if (extra) {
    const last = j.entries[j.entries.length - 1];
    j.entries.push({ idx: last.idx + 1, version: last.version, when: last.when + 1000, tag: extra.tag, breakpoints: true });
    fs.writeFileSync(path.join(to, `${extra.tag}.sql`), extra.sql);
  }
  fs.writeFileSync(jp, JSON.stringify(j, null, 2));
  return to;
}

/* ------------------------------------------------- one check in its own process */
if (process.argv[2] === "unit") {
  await unit(process.argv[3], process.argv.slice(4));
  process.exit(0);
}

let bad = 0;
const check = (label: string, ok: boolean, got?: unknown) => {
  if (!ok) bad++;
  console.log(` ${ok ? "PASS" : "FAIL"}  ${label}${ok || got === undefined ? "" : `   ${JSON.stringify(got)?.slice(0, 600)}`}`);
};
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });

try {
  /* ------------------------------------------------------------- power cut */
  console.log("A save shown as saved is on the disk (power cut)");
  {
    const d = books("sync");
    const r = unitRun(d, "sync");
    check("the books are opened with synchronous = FULL (every commit flushed to the disk)", r.synchronous === 2, r);
    const s = await serve(d);
    check("  the server starts on the copy", s.up, s.log().slice(-800));
    await s.login();
    const saved = await saveSlip(s, "DSAFE-KILL");
    await s.stop("SIGKILL");
    const kept = look(path.join(d, "mandi.db"), (db) => db.prepare("select count(*) as n from purchase_slips where rst_no = 'DSAFE-KILL'").get() as { n: number }, { n: 0 });
    check("a slip answered as saved is there after the app is killed mid-run", saved.status === 200 && kept.n === 1, { status: saved.status, kept });
    check("  ...and the run is known to have been cut off", fs.existsSync(path.join(d, "books-open.json")));
    const again = await serve(d);
    check("the next start checks the books file, then opens", again.up && /did not close cleanly: checking the books file/.test(again.log()), again.log().slice(-600));
    await again.stop("SIGTERM");
    check("  a clean close is remembered (no check at the start after it)", !fs.existsSync(path.join(d, "books-open.json")));
  }
  {
    // every commit is a flush to the disk (10 to 30 ms each on a shop PC's hard disk): a set-up of hundreds of rows is one commit
    const d = path.join(ROOT, "seed");
    fs.mkdirSync(d, { recursive: true });
    const r = unitRun(d, "seed", [], { MANDI_NO_SEED: "0", PORT: String(PORT) });
    check("a new install's first-run set-up (both firms, users, roles, commodities) is one commit, not one per row",
      r.seeded === true && r.rows > 200 && r.firstRun === 1, r);
    check("  ...and so is Add business (its roles and commodities)", r.added === 200 && r.businessRows > 50 && r.addBusiness <= 2, r);
  }

  /* ------------------------------------------------------ damaged books */
  console.log("\nDamaged books at start-up");
  {
    const d = books("header");
    backupInto(d, "auto-20260101-120000.db", "_from_older_auto");
    backupInto(d, "manual-20260201-090000.db", "_from_newest_good");
    backupInto(d, "before-restore-20991231-000000.db", "_from_another_timeline");
    // a correctly named backup the power cut left full of zeros: never chosen
    fs.writeFileSync(path.join(d, "backups", "auto-20261231-235959.db"), Buffer.alloc(64 * 1024));
    damageHeader(path.join(d, "mandi.db"));
    const damagedBytes = fs.readFileSync(path.join(d, "mandi.db"));
    const r = startup(d);
    check("a books file that will not open: the app still starts", r.code === 0 && /migrations up to date/.test(r.out), r.out.slice(-800));
    check("  ...on the newest good backup of its own (not a zero-filled one, not another timeline's)",
      hasTable(path.join(d, "mandi.db"), "_from_newest_good") && !hasTable(path.join(d, "mandi.db"), "_from_another_timeline"));
    const kept = inBackups(d, /^damaged-\d{8}-\d{6}\.db$/);
    check("  ...the damaged file is kept in backups/, byte for byte", kept.length === 1 && fs.readFileSync(path.join(d, "backups", kept[0])).equals(damagedBytes), kept);
    const n = notice(d);
    const at = new Date(n?.backupAt ?? 0);
    check("  ...and the screens are told which backup, from when",
      n?.kind === "restored" && n.why === "damaged" && n.backup === "manual-20260201-090000.db" && at.getFullYear() === 2026 && at.getMonth() === 1 && at.getDate() === 1 && at.getHours() === 9, n);
  }
  {
    const d = books("page", { probe: true });
    backupInto(d, "auto-20260301-100000.db", "_from_good_backup");
    hotWal(d);
    damagePage(path.join(d, "mandi.db"), "_desk_probe");
    const was = asTheyAre(d);
    cutOff(d);
    const r = startup(d);
    check("a damaged page found after a cut-off run: the good backup is put back", r.code === 0 && hasTable(path.join(d, "mandi.db"), "_from_good_backup") && whole(path.join(d, "mandi.db")), r.out.slice(-800));
    check("  ...the damaged file kept exactly as it was, with its -wal (nothing rebuilt or folded into it first)", keptExactly(d, was), inBackups(d, /^damaged-/));
  }
  {
    const d = books("index", { probe: true });
    const rows = count(path.join(d, "mandi.db"), "_desk_probe");
    hotWal(d);
    damageIndexPage(path.join(d, "mandi.db"), "_desk_probe_idx");
    check("  (the copy's index is damaged)", !whole(path.join(d, "mandi.db")));
    const was = asTheyAre(d);
    cutOff(d);
    const r = startup(d);
    check("a damaged index is rebuilt, nothing lost (the rows only in the -wal too) and nothing put back",
      r.code === 0 && whole(path.join(d, "mandi.db")) && count(path.join(d, "mandi.db"), "_desk_probe") === rows && count(path.join(d, "mandi.db"), "_desk_in_wal") === 1 && !notice(d), r.out.slice(-600));
    check("  ...on a copy: the file as it was is kept, byte for byte with its -wal", keptExactly(d, was), inBackups(d, /^damaged-/));
  }
  {
    const d = books("readonly", { probe: true });
    hotWal(d);
    damagePage(path.join(d, "mandi.db"), "_desk_probe");
    const ino = fs.statSync(path.join(d, "mandi.db")).ino;
    const was = asTheyAre(d);
    cutOff(d);
    const s = await serve(d);
    check("damaged, with no good backup: the app still opens", s.up, s.log().slice(-800));
    const signedIn = await s.login();
    const save = await saveSlip(s, "DSAFE-RO");
    check("  ...and refuses saves with one plain sentence", signedIn && save.status === 503 && save.json?.code === "books_read_only" && /nothing can be saved/.test(save.json?.error ?? ""), save);
    check("  ...while the books can still be read", (await s.call("GET", "/jins")).status === 200);
    const nt = (await s.call("GET", "/backup/notice")).json;
    check("  ...every screen is told", nt?.start?.kind === "readOnly", nt);
    await s.stop("SIGTERM");
    check("  ...the file stays where it is, and is checked again at the next start",
      fs.statSync(path.join(d, "mandi.db")).ino === ino && fs.existsSync(path.join(d, "books-open.json")));
    check("  ...a copy of it as it was (with its -wal) is kept in backups/ before anything is written to it (sign-ins, closing)", keptExactly(d, was), inBackups(d, /^damaged-/));
    const again = startup(d);
    check("  ...once: the next start (still damaged) makes no second copy", /open for reading only/.test(again.out) && inBackups(d, /^damaged-\d{8}-\d{6}\.db$/).length === 1, { out: again.out.slice(-300), kept: inBackups(d, /^damaged-/) });
  }
  {
    // damage that came during a clean run: no check at start, so the start-up jobs are the first to meet it
    const d = books("jobs", { probe: true });
    const db = path.join(d, "mandi.db");
    backupInto(d, "auto-20260302-100000.db", "_from_good_backup");
    damagePage(db, "_desk_probe_idx");
    const s = await serve(d);
    check("damage first met by the start-up jobs (query statistics read every index): the app still opens", s.up && /\[start\]/.test(s.log()), s.log().slice(-800));
    await s.stop("SIGTERM");
    check("  ...and that run is not taken as clean: the next start checks the books file", fs.existsSync(path.join(d, "books-open.json")));
    const r = startup(d);
    check("  ...and puts the good backup back there", r.code === 0 && /did not close cleanly: checking the books file/.test(r.out) && whole(db) && hasTable(db, "_from_good_backup"), r.out.slice(-600));
  }
  {
    const d = books("unavailable");
    damageHeader(path.join(d, "mandi.db"));
    const bytes = fs.readFileSync(path.join(d, "mandi.db"));
    const s = await serve(d);
    check("will not open, and no backup at all: the app still opens", s.up, s.log().slice(-800));
    const b = await s.call("GET", "/auth/bootstrap");
    check("  ...and says so in one sentence instead of showing empty books", b.status === 503 && b.json?.code === "books_unavailable" && /no backup could be put back/.test(b.json?.error ?? ""), b);
    await s.stop();
    check("  ...the damaged file is untouched and no new books were made", fs.readFileSync(path.join(d, "mandi.db")).equals(bytes) && !fs.existsSync(path.join(d, "backups")));
  }

  /* ------------------------------------------------------- missing books */
  console.log("\nMissing books at start-up");
  {
    const d = books("missing");
    backupInto(d, "auto-20260401-080000.db", "_from_good_backup");
    fs.rmSync(path.join(d, "mandi.db"));
    // the side file of the lost books: never replayed onto the backup
    fs.writeFileSync(path.join(d, "mandi.db-wal"), "left behind");
    const r = startup(d);
    const db = path.join(d, "mandi.db");
    check("mandi.db gone, backups there: the newest backup is put back, not empty books", r.code === 0 && fs.existsSync(db) && hasTable(db, "_from_good_backup") && count(db, "users") > 0, r.out.slice(-600));
    check("  ...said once on the screens", notice(d)?.kind === "restored" && notice(d)?.why === "missing", notice(d));
    check("  ...the lost file's side file is set aside, not deleted", inBackups(d, /^damaged-.*\.db-wal$/).length === 1);
  }
  {
    const d = books("empty");
    backupInto(d, "auto-20260402-080000.db", "_from_good_backup");
    fs.writeFileSync(path.join(d, "mandi.db"), "");
    const r = startup(d);
    check("an empty mandi.db where books were: treated as missing", r.code === 0 && hasTable(path.join(d, "mandi.db"), "_from_good_backup"), r.out.slice(-400));
  }
  {
    const d = path.join(ROOT, "new-install");
    fs.mkdirSync(d, { recursive: true });
    const r = startup(d);
    check("a new computer (nothing there before) still starts with new books", r.code === 0 && migrationsIn(path.join(d, "mandi.db")) > 0 && !notice(d), r.out.slice(-400));
  }
  {
    const d = books("missing-cloud");
    backupInto(d, "auto-20260403-080000.db", "_from_good_backup");
    fs.rmSync(path.join(d, "mandi.db"));
    fs.writeFileSync(path.join(d, "cloud.json"), JSON.stringify({ enc: "connected-test", live: true, cursor: 50, deviceId: "dev-test" }));
    const r = startup(d);
    let cfg: Record<string, unknown> = {};
    try { cfg = JSON.parse(fs.readFileSync(path.join(d, "cloud.json"), "utf8")); } catch { /* none */ }
    check("on a computer that syncs: the backup is put back and sync is paused (nothing old is sent up)",
      r.code === 0 && hasTable(path.join(d, "mandi.db"), "_from_good_backup") && cfg.live === false && cfg.enc === "connected-test" && cfg.cursor === 50 && notice(d)?.syncHeld === true, { cfg, n: notice(d) });
  }

  /* ------------------------------------------------- a restore asked for */
  console.log("\nGoing back to a backup at the next start");
  {
    const d = books("restore-damaged");
    const old = backupInto(d, "manual-20260501-100000.db", "_from_the_backup");
    damageHeader(path.join(d, "mandi.db"));
    fs.writeFileSync(path.join(d, "restore-pending.json"), JSON.stringify({ file: old }));
    const r = startup(d);
    check("current books damaged: the restore still happens, the damaged file kept",
      r.code === 0 && hasTable(path.join(d, "mandi.db"), "_from_the_backup") && inBackups(d, /^damaged-.*\.db$/).length === 1 && !fs.existsSync(path.join(d, "restore-pending.json")), r.out.slice(-600));
  }
  {
    const d = books("restore-fails");
    const old = backupInto(d, "manual-20260502-100000.db", "_from_the_backup");
    fs.writeFileSync(path.join(d, "restore-pending.json"), JSON.stringify({ file: old }));
    const users = count(path.join(d, "mandi.db"), "users");
    // the backup cannot be read when the time comes (a failing disk, a virus scanner)
    fs.chmodSync(old, 0o000);
    const r = startup(d);
    fs.chmodSync(old, 0o644);
    const db = path.join(d, "mandi.db");
    check("a restore that cannot copy the backup: the books stay as they were and the app starts",
      r.code === 0 && fs.existsSync(db) && !hasTable(db, "_from_the_backup") && count(db, "users") === users, r.out.slice(-600));
    check("  ...and the Backups card says why", /^Not gone back to manual-20260502-100000\.db: /.test(backupCfg(d)?.lastError ?? ""), backupCfg(d));
  }

  {
    const d = books("restore-locked");
    const old = backupInto(d, "manual-20260503-100000.db", "_from_the_backup");
    fs.writeFileSync(path.join(d, "restore-pending.json"), JSON.stringify({ file: old }));
    const users = count(path.join(d, "mandi.db"), "users");
    // the current books cannot be moved aside (a folder Windows or a virus scanner will not let go of)
    fs.chmodSync(path.join(d, "backups"), 0o555);
    const r = startup(d);
    fs.chmodSync(path.join(d, "backups"), 0o755);
    const db = path.join(d, "mandi.db");
    check("a restore that cannot move the current books aside: they stay as they were, never missing",
      r.code === 0 && fs.existsSync(db) && !hasTable(db, "_from_the_backup") && count(db, "users") === users && !fs.existsSync(`${db}.tmp`), r.out.slice(-600));
  }
  {
    const d = books("putback-locked");
    backupInto(d, "auto-20260504-100000.db", "_from_good_backup");
    damageHeader(path.join(d, "mandi.db"));
    const bytes = fs.readFileSync(path.join(d, "mandi.db"));
    fs.chmodSync(path.join(d, "backups"), 0o555);
    const r = startup(d);
    fs.chmodSync(path.join(d, "backups"), 0o755);
    check("damaged books that cannot be moved aside: the app still starts, the file untouched, and says so",
      r.code === 0 && fs.readFileSync(path.join(d, "mandi.db")).equals(bytes) && notice(d)?.kind === "unavailable", { out: r.out.slice(-500), n: notice(d) });
  }

  /* --------------------------------------------------------------- updates */
  console.log("\nUpdates");
  {
    // books as the release before left them (all but the newest migration), with its first-run rows
    const prev = migrations("prev", undefined, true);
    const d = path.join(ROOT, "update-prev");
    fs.mkdirSync(d, { recursive: true });
    const s = await serve(d, { MANDI_MIGRATIONS_DIR: prev, MANDI_NO_SEED: "0" });
    await s.stop();
    const db = path.join(d, "mandi.db");
    const n0 = migrationsIn(db);
    const users = count(db, "users");
    const r = startup(d);
    const copies = inBackups(d, /^before-update-.*\.db$/);
    check("the release before's books are updated, with a checked copy first",
      r.code === 0 && migrationsIn(db) === n0 + 1 && count(db, "users") === users && users > 0 && copies.length === 1 && whole(path.join(d, "backups", copies[0])) && /backed up before update/.test(r.out), { n0, out: r.out.slice(-500) });
  }
  {
    const bad = migrations("sql-error", { tag: "0099_desk_bad", sql: "ALTER TABLE no_such_table ADD COLUMN x integer;" });
    const d = books("upd-sql");
    const db = path.join(d, "mandi.db");
    const n0 = migrationsIn(db);
    const ino = fs.statSync(db).ino;
    const inst = path.join(d, "installers");
    fs.mkdirSync(inst, { recursive: true });
    fs.writeFileSync(path.join(inst, "MandiMitra-Setup-0.0.1.exe"), "the version before");
    const r = unitRun(d, "migrate", [], { MANDI_MIGRATIONS_DIR: bad, MANDI_DESKTOP: "1", MANDI_INSTALLERS_DIR: inst, MANDI_APP_VERSION: "9.9.8" });
    check("an update whose SQL fails is reported as a failed update (not a bare SQL error)", r.mandiUpdateFailed === true && r.name === "MigrationError" && /they are as they were/.test(r.message ?? ""), r);
    check("  ...the books are exactly as they were, the file never swapped", migrationsIn(db) === n0 && fs.statSync(db).ino === ino && whole(db) && !hasTable(db, "x"));
    check("  ...the kept earlier version is offered", r.goBack?.version === "0.0.1", r.goBack);
    let upd: { skip?: string[] } | null = null;
    try { upd = JSON.parse(fs.readFileSync(path.join(d, "update.json"), "utf8")); } catch { /* none written */ }
    check("  ...and the failed version is not offered again by it", Boolean(upd?.skip?.includes("9.9.8")), upd);
  }
  {
    const loss = migrations("loss", { tag: "0099_desk_loss", sql: "DELETE FROM role_permissions;" });
    const d = books("upd-loss");
    const db = path.join(d, "mandi.db");
    const rows = count(db, "role_permissions");
    const ino = fs.statSync(db).ino;
    const r = startup(d, { MANDI_MIGRATIONS_DIR: loss });
    check("an update that would lose rows is rolled back before it is kept", r.code !== 0 && /they are as they were/.test(r.out) && count(db, "role_permissions") === rows, r.out.slice(-500));
    check("  ...without copying any file over the books (a cut cannot leave none)", fs.statSync(db).ino === ino && !/put back from/.test(r.out));
  }
  {
    const ok = migrations("probe", { tag: "0099_desk_probe", sql: "CREATE TABLE _desk_after_update (x integer);" });
    const d = books("upd-damaged", { probe: true });
    const db = path.join(d, "mandi.db");
    damagePage(db, "_desk_probe");
    const r = startup(d, { MANDI_MIGRATIONS_DIR: ok });
    const copies = inBackups(d, /^before-update-.*\.db$/);
    check("one damaged page: the update still applies, the backup falls back to a plain copy",
      r.code === 0 && hasTable(db, "_desk_after_update") && copies.length === 1 && /plain copy/.test(r.out), r.out.slice(-800));
  }

  /* --------------------------------------------------------------- backups */
  console.log("\nBackups");
  {
    // half a year of backups as the counts leave them, each as big as 100 MB books (sparse files: they take no room)
    const r = unitRun(books("keep"), "keep-history");
    check("on a disk with room, a backup keeps the whole half-year history (no size limit removes the weekly copies)", r.made === true && r.kept === r.history && r.history === 65, r);
    check("  ...in the second folder too", r.keptInFolder === r.history, r);
  }
  {
    const r = unitRun(books("room"), "room");
    check("a disk is short of room under 2 GB free (a tenth of a small pen drive), or with room for fewer than 3 copies of the books",
      r.big === 2 * 1024 ** 3 && r.pen === Math.round(0.8 * 1024 ** 3) && r.huge === 3 * 1024 ** 3, r);
    check("  ...with room, no backup is removed for size", r.healthy?.length === 0, r.healthy);
    const same = (a: unknown, b: unknown) => Array.isArray(a) && Array.isArray(b) && a.length > 0 && JSON.stringify(a) === JSON.stringify(b);
    check("  ...short of room, the oldest daily copies go first, only as many as needed", same(r.short, r.want?.short), { got: r.short, want: r.want?.short });
    check("  ...the weekly copies of half a year are kept while daily ones remain", same(r.veryShort, r.want?.veryShort), { got: r.veryShort, want: r.want?.veryShort });
    check("  ...and go last: daily, then one-off (by hand, before an update), then weekly; never the newest of a kind nor the one just made",
      same(r.all, r.want?.all) && same(r.left, r.want?.left), { got: r.all, left: r.left, want: r.want });
  }
  {
    const r = unitRun(books("room-folder"), "room-folder");
    check("this computer's disk short of room: its oldest daily copies go, the second folder (its own disk has room) keeps all",
      r.hereShort?.here === 6 && r.hereShort?.folder === 0, r);
    check("  ...and the other way round: a full pen drive is pruned, this computer's copies are kept", r.folderShort?.here === 0 && r.folderShort?.folder === 6, r);
  }
  {
    const r = unitRun(books("sweep"), "sweep");
    check("half-written backup copies from a cut-off run are removed; one being written now is not", r.old === false && r.fresh === true, r);
  }
  {
    const r = unitRun(books("quit"), "quit");
    check("closing the app takes a checked backup of the day's work", /^auto-\d{8}-\d{6}\.db$/.test(r.first ?? "") && r.whole === true, r);
    check("  ...but not again within two hours", r.second === null, r);
  }
  {
    const r = unitRun(books("due"), "due");
    check("an automatic backup is also taken each evening after 6", r.evening === true && r.afterEvening === false && r.morning === false && r.old === true && r.future === true, r);
  }
  {
    const r = unitRun(books("cfg"), "cfg");
    check("backup.json cut short by a power cut: the second folder is not forgotten", r.folder === r.want, r);
  }
  {
    const d = books("failing");
    fs.writeFileSync(path.join(d, "backups"), "a file where the backups folder should be");
    const s = await serve(d);
    await s.login();
    const run = await s.call("POST", "/backup/run");
    check("a failing backup says why in plain words", run.status === 400 && /^The backup could not be made: /.test(run.json?.error ?? ""), run);
    const nt = (await s.call("GET", "/backup/notice")).json;
    check("  ...and shows above every screen, not only in Settings", /^The backup could not be made/.test(nt?.backupFailing ?? ""), nt);
    await s.stop();
  }

  /* --------------------------------------------------------------- updater */
  console.log("\nInstalling an update");
  {
    const r = unitRun(books("spawn-missing"), "spawn-missing");
    check("Windows will not start the installer: a plain message, and the app keeps working", r.threw === "Windows did not start the installer, so nothing was changed and the app keeps working. Try again in a minute." && r.open === true, r);
  }
  {
    const r = unitRun(books("spawn-ok"), "spawn-ok");
    check("the installer starts quietly, told to wait for the app (--updated)", r.args === "/S --force-run --updated", r);
    check("  ...and the books are closed before the app leaves", r.openAfter === false && r.markAfter === false && r.exitedClosed === true, r);
  }
  {
    const r = unitRun(books("upd-misc"), "upd-misc");
    check("installer copies earlier versions left in the temp folder are removed", r.swept === 1 && r.otherKept === true, r);
    check("an update is refused, plainly, when the disk is nearly full", /^The disk is nearly full: free at least \d+ MB/.test(r.space ?? ""), r);
    check("a version that could not open the books is not offered again; a newer one is", r.skippedPick === "9.9.9" && r.newerPick === "9.9.11", r);
  }

  /* ------------------------------------------------------- a full disk */
  if (process.platform === "darwin") {
    console.log("\nA full disk (a small disk image)");
    const img = path.join(ROOT, "disk-test.dmg");
    const vol = path.join(ROOT, "vol-test");
    let attached = false;
    try {
      execFileSync("hdiutil", ["create", "-size", "24m", "-fs", "HFS+", "-volname", "DSAFETEST", "-layout", "NONE", img], { stdio: "ignore" });
      fs.mkdirSync(vol, { recursive: true });
      execFileSync("hdiutil", ["attach", "-nobrowse", "-mountpoint", vol, img], { stdio: "ignore" });
      attached = true;
      const d = path.join(vol, "books-test");
      fs.mkdirSync(d);
      execFileSync("sqlite3", [SRC, `.backup ${path.join(d, "mandi.db")}`]);
      const free = () => { const s = fs.statfsSync(vol); return s.bavail * s.bsize; };
      // the disk filled to all but a little: no room for a copy of the books, room for a small update
      const fill = (leave: number) => {
        const f = path.join(vol, `filler-${Date.now()}`);
        fs.writeFileSync(f, Buffer.alloc(Math.max(0, free() - leave)));
      };
      fill(Math.floor(fs.statSync(path.join(d, "mandi.db")).size / 3));
      const ok = migrations("full", { tag: "0099_desk_full", sql: "CREATE TABLE _desk_after_update (x integer);" });
      const r = startup(d, { MANDI_MIGRATIONS_DIR: ok });
      check("no room for a backup before an update: the update still applies and the app starts", r.code === 0 && hasTable(path.join(d, "mandi.db"), "_desk_after_update"), r.out.slice(-800));
      check("  ...and every screen is told the disk is full", /^No copy could be made before the update: The disk is full/.test(backupCfg(d)?.localError ?? ""), backupCfg(d));
      const s = await serve(d, { MANDI_MIGRATIONS_DIR: ok });
      await s.login();
      fill(0);
      let saved = { status: 200, json: null as any };
      for (let i = 0; i < 400 && saved.status === 200; i++) saved = await saveSlip(s, `DSAFE-FULL-${i}`);
      check("a save on a full disk says plainly that the disk is full and nothing was saved", saved.status === 507 && saved.json?.code === "disk_full" && /^The disk is full, so this was not saved/.test(saved.json?.error ?? ""), saved);
      const b = await s.call("POST", "/backup/run");
      check("  ...and so does a backup", b.status === 400 && /The disk is full/.test(b.json?.error ?? ""), b);
      await s.stop();
    } catch (e) {
      check("the disk-image checks ran", false, String(e));
    } finally {
      if (attached) { try { execFileSync("hdiutil", ["detach", vol, "-force"], { stdio: "ignore" }); } catch { /* left mounted */ } }
      fs.rmSync(img, { force: true });
    }
  } else {
    console.log("\n(the full-disk checks use a macOS disk image; skipped here)");
  }
} finally {
  fs.rmSync(ROOT, { recursive: true, force: true });
}
console.log(bad === 0 ? "\nThe books survive power cuts, damage, a missing file, failed updates and a full disk." : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);

/* ======================================================= the unit checks */
async function unit(name: string, _args: string[]) {
  const out = (o: unknown) => console.log(JSON.stringify(o));
  const dir = process.env.MANDI_DATA_DIR!;
  if (name === "sync") {
    const { sqlite } = await import("../server/db/client.ts");
    return out({ synchronous: sqlite.pragma("synchronous", { simple: true }) });
  }
  if (name === "seed") {
    const { sqlite, DB_PATH } = await import("../server/db/client.ts");
    const { runMigrations } = await import("../server/db/migrate.ts");
    runMigrations();
    // nothing folded in meanwhile: every commit stays countable in the -wal
    sqlite.pragma("wal_autocheckpoint = 0");
    sqlite.pragma("wal_checkpoint(TRUNCATE)");
    const { seedFirstRun } = await import("../server/lib/businessSetup.ts");
    const seeded = await seedFirstRun();
    const firstRun = walCommits(`${DB_PATH}-wal`);
    const n = (t: string) => (sqlite.prepare(`select count(*) as n from "${t}"`).get() as { n: number }).n;
    const tables = ["users", "businesses", "roles", "role_permissions", "jins", "memberships"];
    const rows = tables.reduce((s, t) => s + n(t), 0);
    // Add business, as the Admin does it in the app (signed in on the first-run PIN)
    const { createApp } = await import("../server/app.ts");
    const app = createApp();
    const host = `127.0.0.1:${process.env.PORT}`;
    let cookie = "";
    const call = async (method: string, p: string, body?: unknown) => {
      const res = await app.fetch(new Request(`http://${host}/api${p}`, {
        method, body: body === undefined ? undefined : JSON.stringify(body),
        headers: { host, "content-type": "application/json", origin: `http://${host}`, "sec-fetch-site": "same-origin", ...(cookie ? { cookie } : {}) },
      }), { incoming: { socket: { remoteAddress: "127.0.0.1", remotePort: 50123, remoteFamily: "IPv4", localPort: Number(process.env.PORT) } }, outgoing: {} });
      const sc = res.headers.get("set-cookie");
      if (sc) cookie = sc.split(";")[0];
      return { status: res.status, json: await res.json().catch(() => null) };
    };
    const users = (await call("GET", "/auth/users")).json as { id: string; name: string }[];
    await call("POST", "/auth/login", { userId: users.find((u) => u.name === "Admin")!.id, pin: "7747" });
    sqlite.pragma("wal_checkpoint(TRUNCATE)");
    const before = rows;
    const added = await call("POST", "/auth/businesses", { name: "Desk Safe Test Firm", shortCode: "DSTF" });
    const addBusiness = walCommits(`${DB_PATH}-wal`);
    const businessRows = tables.reduce((s, t) => s + n(t), 0) - before;
    return out({ seeded, firstRun, rows, added: added.status, addBusiness, businessRows });
  }
  if (name === "migrate") {
    const { runMigrations } = await import("../server/db/migrate.ts");
    try { runMigrations(); return out({ ok: true }); } catch (e) {
      const x = e as { name?: string; message?: string; mandiUpdateFailed?: boolean; diskFull?: boolean; goBack?: unknown };
      return out({ name: x.name, message: x.message, mandiUpdateFailed: x.mandiUpdateFailed ?? false, diskFull: x.diskFull ?? false, goBack: x.goBack ?? null });
    }
  }
  if (name === "keep-history") {
    const b = await import("../server/lib/backup.ts");
    // a second folder outside the app's data folder (a pen drive)
    const folder = `${dir}-second-folder`;
    fs.mkdirSync(folder, { recursive: true });
    b.setBackupFolder(folder);
    const names = history(b.BACKUP_DIR, 100 * MB);
    const there = path.join(folder, "MandiMitra-backups", hostDirOf());
    history(there, 100 * MB);
    // the real disk, which has room (the history takes none: sparse files)
    const made = await b.backupNow("auto");
    const left = (d: string) => names.filter((n) => fs.existsSync(path.join(d, n))).length;
    return out({ made: Boolean(made?.name), history: names.length, kept: left(b.BACKUP_DIR), keptInFolder: left(there), free: Math.round(fs.statfsSync(dir).bavail * fs.statfsSync(dir).bsize / MB) });
  }
  if (name === "room") {
    const b = await import("../server/lib/backup.ts");
    const books = 100 * MB;
    const disk = (free: number) => ({ free, size: 500 * GB });
    const at = (sub: string) => { const f = path.join(dir, sub); fs.rmSync(f, { recursive: true, force: true }); return { f, names: history(f, books) }; };
    const kindOf = (n: string) => n.replace(/-\d{8}-\d{6}\.db$/, "");
    const byTime = (a: string, c: string) => a.replace(/^\D+/, "").localeCompare(c.replace(/^\D+/, ""));
    const left = (f: string) => fs.readdirSync(f).sort(byTime);
    // what history() made: 30 daily autos, 26 weekly ones before them, 6 before-update and 3 by-hand copies
    const { names } = at("room-short");
    const autos = names.filter((n) => kindOf(n) === "auto").sort(byTime);
    const weekly = autos.slice(0, autos.length - 30), daily = autos.slice(autos.length - 30);
    const oneOff = names.filter((n) => kindOf(n) !== "auto").sort(byTime);
    const newestOf = (k: string) => names.filter((n) => kindOf(n) === k).sort(byTime).pop()!;
    const justMade = weekly[0]; // made just now with the PC clock gone back: it sorts oldest
    const want = {
      short: daily.slice(0, 6), // 512 MB short: six 100 MB copies
      veryShort: daily.slice(0, 21), // 2 GB short
      all: [...daily.slice(0, -1), ...oneOff.filter((n) => n !== newestOf("manual") && n !== newestOf("before-update")), ...weekly.filter((n) => n !== justMade)],
      left: [justMade, newestOf("before-update"), newestOf("manual"), daily[daily.length - 1]].sort(byTime),
    };
    const short = b.makeRoom(path.join(dir, "room-short"), [], books, disk(1.5 * GB));
    const healthyDir = at("room-healthy").f;
    const healthy = b.makeRoom(healthyDir, [], books, disk(50 * GB));
    const veryShort = b.makeRoom(at("room-very").f, [], books, disk(0));
    const allDir = at("room-all").f;
    const all = b.makeRoom(allDir, [justMade], 50 * GB, disk(0));
    return out({
      big: b.roomKept(500 * GB, books), pen: Math.round(b.roomKept(8 * GB, 38 * MB)), huge: b.roomKept(500 * GB, GB),
      healthy, short, veryShort, all, left: left(allDir), want,
    });
  }
  if (name === "room-folder") {
    const b = await import("../server/lib/backup.ts");
    // a second folder outside the app's data folder (a pen drive)
    const folder = `${dir}-second-folder`;
    fs.mkdirSync(folder, { recursive: true });
    b.setBackupFolder(folder);
    const there = path.join(folder, "MandiMitra-backups", hostDirOf());
    const missing = (d: string, names: string[]) => names.filter((n) => !fs.existsSync(path.join(d, n))).length;
    const inFolder = (d: string) => path.resolve(d).startsWith(path.resolve(folder) + path.sep);
    const run = async (folderShort: boolean) => {
      const here = history(b.BACKUP_DIR, 100 * MB);
      const far = history(there, 100 * MB);
      b.disk.space = (d: string) => ({ free: inFolder(d) === folderShort ? 1.5 * GB : 50 * GB, size: 500 * GB });
      await b.backupNow("manual");
      return { here: missing(b.BACKUP_DIR, here), folder: missing(there, far) };
    };
    const hereShort = await run(false);
    await sleep(1100); // a backup's name has the time to the second
    const folderShort = await run(true);
    return out({ hereShort, folderShort });
  }
  if (name === "sweep") {
    const b = path.join(dir, "backups");
    fs.mkdirSync(b, { recursive: true });
    fs.writeFileSync(path.join(b, "auto-20260101-000000.db.tmp"), "cut off");
    const hourAgo = new Date(Date.now() - 3600_000);
    fs.utimesSync(path.join(b, "auto-20260101-000000.db.tmp"), hourAgo, hourAgo);
    fs.writeFileSync(path.join(b, "auto-20260102-000000.db.tmp"), "being written");
    const { startAutoBackups } = await import("../server/lib/backup.ts");
    startAutoBackups();
    return out({ old: fs.existsSync(path.join(b, "auto-20260101-000000.db.tmp")), fresh: fs.existsSync(path.join(b, "auto-20260102-000000.db.tmp")) });
  }
  if (name === "quit") {
    const { backupOnQuit } = await import("../server/lib/backup.ts");
    const first = backupOnQuit();
    const second = backupOnQuit();
    return out({ first, second, whole: first ? whole(path.join(dir, "backups", first)) : false });
  }
  if (name === "due") {
    const { autoBackupDue } = await import("../server/lib/backup.ts");
    const at = (h: number, m = 0, dayOff = 0) => { const d = new Date(); d.setDate(d.getDate() + dayOff); d.setHours(h, m, 0, 0); return d; };
    return out({
      evening: autoBackupDue(at(8).getTime(), at(19)),
      afterEvening: autoBackupDue(at(18, 30).getTime(), at(19)),
      morning: autoBackupDue(at(8).getTime(), at(12)),
      old: autoBackupDue(at(8, 0, -1).getTime(), at(12)),
      future: autoBackupDue(at(15).getTime(), at(12)),
    });
  }
  if (name === "cfg") {
    const { setBackupFolder, readBackupConfig } = await import("../server/lib/backup.ts");
    const want = path.join(os.tmpdir());
    setBackupFolder(want);
    setBackupFolder(want);
    const cfg = path.join(dir, "backup.json");
    const text = fs.readFileSync(cfg, "utf8");
    fs.writeFileSync(cfg, text.slice(0, Math.floor(text.length / 2)));
    return out({ want, folder: readBackupConfig().folder });
  }
  if (name === "spawn-missing") {
    const { runInstaller } = await import("../server/lib/updater.ts");
    const { sqlite } = await import("../server/db/client.ts");
    let threw: string | null = null;
    try { await runInstaller(path.join(dir, "no-such-installer.exe"), ["/S"]); } catch (e) { threw = (e as Error).message; }
    return out({ threw, open: sqlite.open });
  }
  if (name === "spawn-ok") {
    const { runInstaller } = await import("../server/lib/updater.ts");
    const { sqlite } = await import("../server/db/client.ts");
    const fake = path.join(dir, "fake-installer.sh");
    const argsFile = path.join(dir, "installer-args.txt");
    fs.writeFileSync(fake, `#!/bin/sh\necho "$@" > "${argsFile}"\n`);
    fs.chmodSync(fake, 0o755);
    const mark = path.join(dir, "books-open.json");
    const result: Record<string, unknown> = {};
    await new Promise<void>((resolve) => {
      (globalThis as { __mandiExit?: () => void }).__mandiExit = () => { result.exitedClosed = !sqlite.open; resolve(); };
      void runInstaller(fake, ["/S", "--force-run", "--updated"]).then(() => { result.openAfter = sqlite.open; result.markAfter = fs.existsSync(mark); });
    });
    for (let i = 0; i < 40 && !fs.existsSync(argsFile); i++) await sleep(50);
    result.args = fs.existsSync(argsFile) ? fs.readFileSync(argsFile, "utf8").trim() : null;
    return out(result);
  }
  if (name === "upd-misc") {
    const u = await import("../server/lib/updater.ts");
    const t = path.join(dir, "temp-test");
    fs.mkdirSync(t);
    fs.writeFileSync(path.join(t, "MandiMitra-Setup-0.3.17-0a1b2c3d.exe"), "old copy");
    fs.writeFileSync(path.join(t, "something-else.exe"), "not ours");
    const swept = u.sweepTempInstallers(t);
    const space = u.spaceProblem(dir, 1024 ** 5);
    const folder = path.join(dir, "downloads-test");
    fs.mkdirSync(folder);
    for (const v of ["9.9.9", "9.9.10"]) fs.writeFileSync(path.join(folder, `MandiMitra-Setup-${v}.exe`), v);
    u.setUpdateFolder(folder);
    u.rememberBadVersion("9.9.10");
    const skippedPick = u.findInstaller()?.version;
    fs.writeFileSync(path.join(folder, "MandiMitra-Setup-9.9.11.exe"), "newer");
    const newerPick = u.findInstaller()?.version;
    return out({ swept, otherKept: fs.existsSync(path.join(t, "something-else.exe")), space, skippedPick, newerPick });
  }
  out({ error: `no unit check named ${name}` });
}
