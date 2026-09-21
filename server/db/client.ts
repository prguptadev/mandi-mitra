import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.ts";
import fs from "node:fs";
import path from "node:path";

/** In Electron this becomes app.getPath("userData"). */
const DATA_DIR = process.env.MANDI_DATA_DIR ?? path.resolve(process.cwd(), "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

export const DB_PATH = path.join(DATA_DIR, "mandi.db");
/** Written by "Restore" in Settings; carried out here, before the database is opened. */
export const RESTORE_PENDING = path.join(DATA_DIR, "restore-pending.json");

/*
 * A backup is put back while nothing has the database open: the current
 * database (with its -wal and -shm side files, which hold its latest changes)
 * is first folded into one file and kept in backups/ as before-restore-…, then
 * the backup is copied in. Nothing is deleted.
 */
function restorePending() {
  if (!fs.existsSync(RESTORE_PENDING)) return;
  try {
    const { file } = JSON.parse(fs.readFileSync(RESTORE_PENDING, "utf8")) as { file?: string };
    if (!file || !fs.existsSync(file)) return;
    const d = new Date();
    const p2 = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
    const aside = path.join(DATA_DIR, "backups", `before-restore-${stamp}.db`);
    fs.mkdirSync(path.dirname(aside), { recursive: true });
    if (fs.existsSync(DB_PATH)) {
      const cur = new Database(DB_PATH);
      cur.pragma("wal_checkpoint(TRUNCATE)");
      cur.close();
      fs.renameSync(DB_PATH, aside);
    }
    for (const side of ["-wal", "-shm"]) fs.rmSync(DB_PATH + side, { force: true });
    fs.copyFileSync(file, DB_PATH);
    console.log(`[db] restored ${path.basename(file)}; the database it replaced is kept as ${path.basename(aside)}`);
  } finally {
    fs.rmSync(RESTORE_PENDING, { force: true });
  }
}
restorePending();

export const sqlite = new Database(DB_PATH);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");
sqlite.pragma("busy_timeout = 5000");
// a year of a mandi's data is a few tens of MB: keep the busy part of it in memory
sqlite.pragma("cache_size = -32000");
sqlite.pragma("temp_store = MEMORY");

export const db = drizzle(sqlite, { schema });
export { schema };
