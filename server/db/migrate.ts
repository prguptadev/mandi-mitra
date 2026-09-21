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
  sqlite.pragma("foreign_keys = OFF");
  let problem: string | null = null;
  try {
    migrate(db, { migrationsFolder: FOLDER });
    const broken = sqlite.prepare("pragma foreign_key_check").all();
    if (broken.length) problem = `the update left ${broken.length} broken link(s) between records`;
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
    throw new MigrationError(`Database update stopped: ${problem}. Your data was put back from ${backup ? path.basename(backup) : "—"}; nothing was lost. Please send this message to support.`);
  }
  console.log("[db] migrations up to date");
}

// pathToFileURL, not string concat — the data dir can contain spaces
// run directly (npm run db:push), not when bundled into the desktop server
if (process.argv[1]?.endsWith("migrate.ts") && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMigrations();
}
