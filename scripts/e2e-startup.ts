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

fs.rmSync(dir, { recursive: true, force: true });
console.log(bad === 0 ? "\nStart-up survives an old dangling link." : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
