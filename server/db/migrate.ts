import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { db, sqlite } from "./client.ts";
import { backupBeforeUpdate } from "../lib/backup.ts";
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

// the packaged app ships the migrations next to its server bundle
const FOLDER = process.env.MANDI_MIGRATIONS_DIR ?? path.resolve(import.meta.dirname, "migrations");

export function runMigrations() {
  if (!fs.existsSync(path.join(FOLDER, "meta", "_journal.json"))) {
    console.warn("[db] no migrations found — run: npx drizzle-kit generate");
    return;
  }
  // an update about to change the tables: keep a copy of the database first
  try {
    const journal = JSON.parse(fs.readFileSync(path.join(FOLDER, "meta", "_journal.json"), "utf8")) as { entries: unknown[] };
    const has = sqlite.prepare("select count(*) as n from sqlite_master where type = 'table' and name = '__drizzle_migrations'").get() as { n: number };
    const applied = has.n ? (sqlite.prepare("select count(*) as n from __drizzle_migrations").get() as { n: number }).n : 0;
    if (applied > 0 && applied < journal.entries.length) console.log(`[db] backed up before update: ${backupBeforeUpdate()}`);
  } catch (e) {
    console.warn("[db] could not back up before the update:", e);
  }
  migrate(db, { migrationsFolder: FOLDER });
  console.log("[db] migrations up to date");
}

// pathToFileURL, not string concat — the data dir can contain spaces
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMigrations();
}
