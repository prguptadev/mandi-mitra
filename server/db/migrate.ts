import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { db } from "./client.ts";
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const FOLDER = path.resolve(import.meta.dirname, "migrations");

export function runMigrations() {
  if (!fs.existsSync(path.join(FOLDER, "meta", "_journal.json"))) {
    console.warn("[db] no migrations found — run: npx drizzle-kit generate");
    return;
  }
  migrate(db, { migrationsFolder: FOLDER });
  console.log("[db] migrations up to date");
}

// pathToFileURL, not string concat — the data dir can contain spaces
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMigrations();
}
