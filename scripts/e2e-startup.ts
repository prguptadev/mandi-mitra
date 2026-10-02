import "./_guard.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";

/* The app must start on books that already carry a dangling link — a row whose
 * user or master was deleted long ago. Until v0.3.15 such a link stopped the
 * Windows app at start-up and blamed the update for it.
 *
 * A copy of the test database is given an orphan on purpose, then the real
 * start-up path (server/db/migrate.ts) is run against the copy.
 * Run through: npm run test:e2e
 */
let bad = 0;
const check = (label: string, ok: boolean, got?: unknown) => {
  if (!ok) bad++;
  console.log(` ${ok ? "PASS" : "FAIL"}  ${label}${ok || got === undefined ? "" : `   ${JSON.stringify(got)}`}`);
};

const source = path.join(process.env.MANDI_DATA_DIR!, "mandi.db");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mandi-e2e-start-"));
execFileSync("sqlite3", [source, `.backup ${path.join(dir, "mandi.db")}`]);
const file = path.join(dir, "mandi.db");

console.log("Starting up on books that already have a dangling link");
{
  const db = new Database(file);
  db.pragma("foreign_keys = OFF");
  // a payment entered by a user who was deleted afterwards
  const row = db.prepare("select id from payments limit 1").get() as { id: string } | undefined;
  if (!row) { console.log(" (no payment to work with)"); process.exit(0); }
  db.prepare("update payments set created_by = 'user-deleted-long-ago' where id = ?").run(row.id);
  const links = db.prepare("pragma foreign_key_check").all();
  check("the copy now has exactly one dangling link", links.length === 1, links);
  db.close();
}

// the start-up path, in its own process, against the copy
const out = execFileSync("npx", ["tsx", "server/db/migrate.ts"], {
  env: { ...process.env, MANDI_DATA_DIR: dir, MANDI_NO_AUTO_BACKUP: "1" },
  encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
});
check("the app starts instead of refusing", /migrations up to date/.test(out), out.trim().split("\n").slice(-3));
check("  ...and says plainly what is dangling", /point at something that is no longer there/.test(out) && /payments → users/.test(out), out.trim());

// the books check names it too, without calling any figure wrong
const books = execFileSync("npx", ["tsx", "scripts/money-check.ts", file], { encoding: "utf8" });
check("the books check lists it as a note, not a problem",
  /point at something that is no longer there/.test(books) && /Every figure re-works exactly/.test(books),
  books.trim().split("\n").slice(-4));

// and a clean copy says nothing about links
const clean = path.join(dir, "clean.db");
execFileSync("sqlite3", [source, `.backup ${clean}`]);
fs.mkdirSync(path.join(dir, "c"), { recursive: true });
fs.copyFileSync(clean, path.join(dir, "c", "mandi.db"));
const out2 = execFileSync("npx", ["tsx", "server/db/migrate.ts"], {
  env: { ...process.env, MANDI_DATA_DIR: path.join(dir, "c"), MANDI_NO_AUTO_BACKUP: "1" },
  encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
});
check("books with nothing dangling are not told about links", !/no longer there/.test(out2), out2.trim());

/* A restore waiting for the next start (asked for by v0.3.17 while sync was
   only held, or just before connecting) must not land on a computer that
   syncs: its old records would be sent up over the other computers' newer work. */
console.log("\nA backup waiting to be put back, on a computer that syncs");
function startWithPendingRestore(sub: string, cloud: Record<string, unknown> | null) {
  const d = path.join(dir, sub);
  fs.mkdirSync(d, { recursive: true });
  execFileSync("sqlite3", [source, `.backup ${path.join(d, "mandi.db")}`]);
  const old = path.join(d, "old.db");
  execFileSync("sqlite3", [source, `.backup ${old}`]);
  execFileSync("sqlite3", [old, "create table _from_the_backup (x)"]);
  if (cloud) fs.writeFileSync(path.join(d, "cloud.json"), JSON.stringify(cloud));
  fs.writeFileSync(path.join(d, "restore-pending.json"), JSON.stringify({ file: old, at: new Date().toISOString() }));
  execFileSync("npx", ["tsx", "server/db/migrate.ts"], {
    env: { ...process.env, MANDI_DATA_DIR: d, MANDI_NO_AUTO_BACKUP: "1" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  const db = new Database(path.join(d, "mandi.db"), { readonly: true });
  const restored = Boolean(db.prepare("select 1 from sqlite_master where name = '_from_the_backup'").get());
  db.close();
  let note: string | null = null;
  try { note = JSON.parse(fs.readFileSync(path.join(d, "backup.json"), "utf8")).lastError ?? null; } catch { /* none */ }
  return { restored, stillWaiting: fs.existsSync(path.join(d, "restore-pending.json")), note };
}
const held = startWithPendingRestore("held", { enc: "connected", live: false, cursor: 120 });
check("sync only held: the backup is not put back", !held.restored && !held.stillWaiting, held);
check("  ...and the backup card says why", /Not gone back to old\.db/.test(held.note ?? "") && /Bring all data down/.test(held.note ?? ""), held.note);
const live = startWithPendingRestore("live", { enc: "connected", live: true, cursor: 120 });
check("sync on: the backup is not put back either", !live.restored && !live.stillWaiting, live);
const off = startWithPendingRestore("off", { enc: null, live: false, cursor: 0 });
check("sync turned off: the backup is put back", off.restored && !off.stillWaiting && off.note === null, off);
const never = startWithPendingRestore("never", null);
check("never connected: the backup is put back", never.restored && !never.stillWaiting, never);

fs.rmSync(dir, { recursive: true, force: true });
console.log(bad === 0 ? "\nStart-up survives an old dangling link." : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
