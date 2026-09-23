import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { db, sqlite, DB_PATH } from "./client.ts";
import { backupBeforeUpdate } from "../lib/backup.ts";
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

// the packaged app ships the migrations next to its server bundle
const FOLDER = process.env.MANDI_MIGRATIONS_DIR ?? path.resolve(import.meta.dirname, "migrations");

/** Tables a migration may shrink on purpose (none so far). */
const SHRINK_OK = new Set<string>();

const rowCounts = () => Object.fromEntries(
  (sqlite.prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name <> '__drizzle_migrations'").pluck().all() as string[])
    .map((t) => [t, (sqlite.prepare(`select count(*) as n from "${t}"`).get() as { n: number }).n]),
) as Record<string, number>;

export class MigrationError extends Error {}

interface BrokenLink { table: string; rowid: number | null; parent: string; fkid: number }
/** Records pointing at something that is not there. Read-only. */
function brokenLinks(): BrokenLink[] {
  const rows = sqlite.prepare("pragma foreign_key_check").all() as { table: string; rowid: number | null; parent: string; fkid: number }[];
  return rows.map((r) => ({ table: r.table, rowid: r.rowid ?? null, parent: r.parent, fkid: r.fkid }));
}
const describe = (links: BrokenLink[]) => {
  const by = new Map<string, number>();
  for (const l of links) by.set(`${l.table} → ${l.parent}`, (by.get(`${l.table} → ${l.parent}`) ?? 0) + 1);
  return [...by].map(([k, n]) => `${k}${n > 1 ? ` x${n}` : ""}`).join(", ");
};
/** Set when the database was already carrying broken links before this start. */
export let brokenLinksOnStart: BrokenLink[] = [];

export function runMigrations() {
  if (!fs.existsSync(path.join(FOLDER, "meta", "_journal.json"))) {
    console.warn("[db] no migrations found — run: npx drizzle-kit generate");
    return;
  }
  const journal = JSON.parse(fs.readFileSync(path.join(FOLDER, "meta", "_journal.json"), "utf8")) as { entries: unknown[] };
  const has = sqlite.prepare("select count(*) as n from sqlite_master where type = 'table' and name = '__drizzle_migrations'").get() as { n: number };
  const applied = has.n ? (sqlite.prepare("select count(*) as n from __drizzle_migrations").get() as { n: number }).n : 0;
  const updating = applied > 0 && applied < journal.entries.length;
  // an update about to change the tables: a checked copy first, or no update at all
  const backup = updating ? backupBeforeUpdate() : null;
  if (backup) console.log(`[db] backed up before update: ${path.basename(backup)}`);
  const before = updating ? rowCounts() : null;

  // Drizzle applies every pending migration inside one transaction, where
  // PRAGMA foreign_keys cannot be switched off — so a table rebuild (create
  // new, copy, drop old) would cascade-delete every row pointing at the old
  // table. Keys are off for the update and checked right after it instead.
  /* Links that were already broken before today — a row whose user was deleted,
     a mill removed years ago. They are not this update's doing, so they must
     never stop the app: they are reported and the books check names them. */
  const wasBroken = brokenLinks();
  sqlite.pragma("foreign_keys = OFF");
  let problem: string | null = null;
  try {
    migrate(db, { migrationsFolder: FOLDER });
    const broken = brokenLinks();
    const newly = broken.length - wasBroken.length;
    if (newly > 0) problem = `the update left ${newly} broken link(s) between records (${describe(broken)})`;
    if (!problem && before) {
      const after = rowCounts();
      const lost = Object.keys(before).filter((t) => t in after && after[t] < before[t] && !SHRINK_OK.has(t));
      if (lost.length) problem = `the update lost rows in ${lost.map((t) => `${t} (${before[t]} → ${after[t]})`).join(", ")}`;
    }
  } finally {
    sqlite.pragma("foreign_keys = ON");
  }
  if (problem) {
    // put the copy back and stop: no screen may open on damaged data
    if (backup) {
      sqlite.close();
      for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(f, { force: true });
      fs.copyFileSync(backup, DB_PATH);
    }
    throw new MigrationError(`Database update stopped: ${problem}. ${
      backup ? `Your data was put back from ${path.basename(backup)}; nothing was lost.` : "Your data is as it was; nothing was changed."
    } Please send this message to support.`);
  }
  brokenLinksOnStart = wasBroken;
  if (wasBroken.length) {
    /* Said plainly in the log, once, and again on the Audit screen's "Check
       the books". Not an alarm: no figure depends on these, and an update
       must never be blamed for what it did not do. */
    console.log(`[db] ${wasBroken.length} record(s) point at something that is no longer there (${describe(wasBroken)}). Nothing is blocked; the books check lists them.`);
  }
  console.log("[db] migrations up to date");
}

// pathToFileURL, not string concat — the data dir can contain spaces
// run directly (npm run db:push), not when bundled into the desktop server
if (process.argv[1]?.endsWith("migrate.ts") && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMigrations();
}
