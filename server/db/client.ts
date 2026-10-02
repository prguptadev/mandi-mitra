import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.ts";
import fs from "node:fs";
import path from "node:path";
import { fsyncDir, fsyncFile, isDamage, plainError, readJsonFile, renameRetry, writeJsonFile } from "./durable.ts";

/** In Electron this becomes app.getPath("userData"). */
const DATA_DIR = process.env.MANDI_DATA_DIR ?? path.resolve(process.cwd(), "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

export const DB_PATH = path.join(DATA_DIR, "mandi.db");
/** Written by "Restore" in Settings; carried out here, before the database is opened. */
export const RESTORE_PENDING = path.join(DATA_DIR, "restore-pending.json");
/** The migrations this version of the app carries (the packaged app ships them beside its server bundle). */
export const MIGRATIONS_DIR = process.env.MANDI_MIGRATIONS_DIR ?? path.resolve(import.meta.dirname, "migrations");
export const BACKUP_DIR = path.join(DATA_DIR, "backups");
export const BACKUP_NAME = /^(auto|before-update|manual|before-restore|before-cloud)-\d{8}-\d{6}\.db$/;
/** Backups of this computer's own books, in the order they were made: the ones put back without asking. */
const OWN_BACKUP = /^(auto|manual|before-update)-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.db$/;
/** There while the books are open; a clean close removes it. Found at start: the last run was cut off. */
const OPEN_MARK = path.join(DATA_DIR, "books-open.json");
/** What start-up did to the books, said once on the screens until someone closes it. */
const START_NOTICE = path.join(DATA_DIR, "start-notice.json");

/** Why a backup is not put back on a computer that syncs (Settings › Backups says it). */
export const RESTORE_WHILE_CONNECTED =
  "This computer syncs with the cloud, so going back to a backup here would undo the other computers' newer work. Use Cloud sync › Bring all data down instead.";

/** Said for every save while the books are only readable. */
export const BOOKS_READ_ONLY = "The books file is damaged and no backup could be put back, so nothing can be saved: call support (nothing has been deleted).";
/** Said for everything while there are no books to open. */
export const BOOKS_UNAVAILABLE = "The books file could not be opened and no backup could be put back: call support (nothing has been deleted).";

export interface StartNotice {
  /** restored: a backup was put back; readOnly: damaged, kept, nothing saved; unavailable: no books open. */
  kind: "restored" | "readOnly" | "unavailable";
  why: "missing" | "damaged";
  backup?: string; backupAt?: string;
  /** The file set aside, in backups/ (never deleted). */
  keptAs?: string | null;
  /** This computer syncs: sync was paused so the older records are not sent up. */
  syncHeld?: boolean;
  /** Why a backup could not be put back (the disk is full…). */
  detail?: string;
  at: string;
}
let mode: "ok" | "readOnly" | "unavailable" = "ok";
/** Why a backup could not be put back, for the screens. */
let lastDetail: string | undefined;
/** ok, or the books are damaged (readOnly) or not there at all (unavailable). */
export const booksMode = () => mode;

/**
 * Connected to cloud sync, held or not (cloud.json, read before anything else
 * is open, as lib/cloud.ts reads it: its earlier copy if it is damaged, and
 * "connected" when neither can be read, to be safe).
 */
function cloudConnectedOnDisk() {
  const { value, unreadable } = readJsonFile<{ enc?: unknown }>(path.join(DATA_DIR, "cloud.json"));
  return value ? Boolean(value.enc) : unreadable;
}

const p2 = (n: number) => String(n).padStart(2, "0");
const stampNow = (d = new Date()) => `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;

/**
 * `tmp` (a whole, flushed copy) becomes mandi.db. What was there goes to
 * `aside` in backups/ with its side files, as a set SQLite can still pair, or
 * its side files are removed when `dropSides` (books already folded into one
 * file). If any step fails, every move is undone: the books are never left
 * missing. Returns the name kept aside, if any.
 */
function swapIn(tmp: string, aside: string, dropSides: boolean): string | null {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const moved: [string, string][] = [];
  try {
    for (const s of ["", "-wal", "-shm"]) {
      if (!fs.existsSync(DB_PATH + s)) continue;
      if (s && dropSides) { fs.rmSync(DB_PATH + s, { force: true }); continue; }
      renameRetry(DB_PATH + s, aside + s);
      moved.push([DB_PATH + s, aside + s]);
    }
    renameRetry(tmp, DB_PATH);
  } catch (e) {
    for (const [from, to] of moved.reverse()) { try { renameRetry(to, from); } catch { /* still in backups/, never lost */ } }
    throw e;
  }
  fsyncDir(BACKUP_DIR);
  fsyncDir(DATA_DIR);
  return moved.some(([from]) => from === DB_PATH) ? path.basename(aside) : null;
}

/** A note on the Backups card (backup.json), written whole. */
function backupNote(text: string) {
  const cfg = path.join(DATA_DIR, "backup.json");
  try { writeJsonFile(cfg, { ...(readJsonFile<Record<string, unknown>>(cfg).value ?? {}), lastError: text }); } catch { /* the log says it */ }
}

/*
 * A backup is put back while nothing has the database open: the current
 * database (with its -wal and -shm side files, which hold its latest changes)
 * is first folded into one file and kept in backups/ as before-restore-…, then
 * the backup is copied in. Nothing is deleted.
 * The copy is made whole beside the books first; only then is anything moved,
 * so a full disk or a cut leaves the books as they were. Books too damaged to
 * fold are kept as they are, with their side files, as damaged-….
 * Not on a computer connected to cloud sync: its sync bookkeeping (cloud.json,
 * cloud-state.db) describes the database it has now, so old records put back
 * would be sent up over newer ones, and what changed since would never come
 * down again. A restore asked for before connecting, or by v0.3.17 while sync
 * was only held, is dropped here and the backup card says why.
 */
function restorePending() {
  if (!fs.existsSync(RESTORE_PENDING)) return;
  let file: string | undefined;
  const tmp = `${DB_PATH}.tmp`;
  try {
    try { file = (JSON.parse(fs.readFileSync(RESTORE_PENDING, "utf8")) as { file?: string }).file; } catch { return; }
    if (!file || !fs.existsSync(file)) return;
    if (cloudConnectedOnDisk()) {
      console.warn(`[db] not going back to ${path.basename(file)}: this computer is connected to cloud sync`);
      backupNote(`Not gone back to ${path.basename(file)}. ${RESTORE_WHILE_CONNECTED}`);
      return;
    }
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    fs.copyFileSync(file, tmp);
    fsyncFile(tmp);
    // the current books folded into one file first; books too damaged to fold go aside whole, side files and all
    let folded = !fs.existsSync(DB_PATH);
    if (!folded) {
      try {
        const cur = new Database(DB_PATH);
        try { cur.pragma("wal_checkpoint(TRUNCATE)"); folded = true; } finally { cur.close(); }
      } catch (e) {
        if (!isDamage(e)) throw e;
      }
    }
    const aside = swapIn(tmp, path.join(BACKUP_DIR, `${folded ? "before-restore" : "damaged"}-${stampNow()}.db`), folded);
    console.log(`[db] restored ${path.basename(file)}; the database it replaced is kept as ${aside ?? "(there was none)"}`);
  } catch (e) {
    // fail open: the books stay as they were, and the backup card says why
    fs.rmSync(tmp, { force: true });
    console.error(`[db] could not go back to ${file ? path.basename(file) : "the backup"}:`, e);
    backupNote(`Not gone back to ${file ? path.basename(file) : "the backup"}: ${plainError(e)}`);
  } finally {
    for (const f of [RESTORE_PENDING, `${RESTORE_PENDING}.bak`]) fs.rmSync(f, { force: true });
  }
}

/*
 * Damaged or missing books at start-up.
 * The file is set aside in backups/ as damaged-… (never deleted) and the
 * newest of this computer's own backups that SQLite reads through whole is put
 * back; the screens say which one, once. A missing file where books have been
 * (any backup, or the backup/sync settings beside it) is never replaced by
 * new, empty books. Damaged books with no good backup stay where they are:
 * readable but not saved to, or, if they cannot be opened at all, the screens
 * say so and nothing is opened. A full check of the file (quick_check) runs
 * only after a run that did not close cleanly (power cut, crash, killed).
 */
interface Good { file: string; name: string; at: string }
function journalLength() {
  try { return (JSON.parse(fs.readFileSync(path.join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8")) as { entries: unknown[] }).entries.length; } catch { return Infinity; }
}
/** The newest own backup that is whole and not made by a newer version of the app. */
function newestGoodBackup(): Good | null {
  let names: string[];
  try { names = fs.readdirSync(BACKUP_DIR).filter((n) => OWN_BACKUP.test(n)); } catch { return null; }
  // by the time in the name, not the file's date (a copy changes that)
  names.sort((a, b) => b.replace(/^\D+/, "").localeCompare(a.replace(/^\D+/, "")));
  const max = journalLength();
  for (const name of names.slice(0, 12)) {
    const file = path.join(BACKUP_DIR, name);
    try {
      const d = new Database(file, { readonly: true, fileMustExist: true });
      try {
        if (d.pragma("quick_check", { simple: true }) !== "ok") continue;
        let theirs = 0;
        try { theirs = (d.prepare("select count(*) as n from __drizzle_migrations").get() as { n: number }).n; } catch { /* very old */ }
        if (theirs > max) continue;
      } finally { d.close(); }
      const m = name.match(OWN_BACKUP)!;
      return { file, name, at: new Date(+m[2], +m[3] - 1, +m[4], +m[5], +m[6], +m[7]).toISOString() };
    } catch { /* unreadable: the next one */ }
  }
  return null;
}
/** Books have been kept in this folder before (so a missing file is lost books, not a new install). */
function usedBefore() {
  try { if (fs.readdirSync(BACKUP_DIR).some((n) => BACKUP_NAME.test(n) || n.startsWith("damaged-"))) return true; } catch { /* none */ }
  return ["backup.json", "cloud.json", "cloud.json.bak", "cloud-state.db", "start-notice.json"].some((f) => fs.existsSync(path.join(DATA_DIR, f)));
}
function quickCheck(db: Database.Database) {
  try { return db.pragma("quick_check", { simple: true }) === "ok"; } catch (e) {
    if (isDamage(e)) return false;
    console.warn("[db] could not check the books file:", e);
    return true; // cannot tell: open as before
  }
}
/** Pauses cloud sync, so records from the backup are not sent up over the other computers' newer ones. */
function holdSync() {
  const file = path.join(DATA_DIR, "cloud.json");
  const { value } = readJsonFile<Record<string, unknown>>(file);
  if (!value?.enc) return false; // unreadable: lib/cloud.ts holds sync by itself then
  try { writeJsonFile(file, { ...value, live: false }); return true; } catch { return false; }
}
function notice(n: Omit<StartNotice, "at">) {
  try { writeJsonFile(START_NOTICE, { ...n, at: new Date().toISOString() }); } catch { /* the log says it */ }
}
/** The backup copied in whole beside the books, then what is there set aside, then renamed in. */
function putBack(good: Good, why: StartNotice["why"]): boolean {
  const tmp = `${DB_PATH}.tmp`;
  try {
    fs.copyFileSync(good.file, tmp);
    fsyncFile(tmp);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    console.error(`[db] could not put back ${good.name}: ${plainError(e)}`);
    lastDetail = plainError(e);
    return false;
  }
  let keptAs: string | null;
  try {
    keptAs = swapIn(tmp, path.join(BACKUP_DIR, `damaged-${stampNow()}.db`), false);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    console.error(`[db] could not put back ${good.name}: ${plainError(e)}`);
    lastDetail = plainError(e);
    return false;
  }
  const syncHeld = cloudConnectedOnDisk() && holdSync();
  notice({ kind: "restored", why, backup: good.name, backupAt: good.at, keptAs, syncHeld });
  console.warn(`[db] the books file was ${why}: put back ${good.name}${keptAs ? `; the old one is kept as backups/${keptAs}` : ""}${syncHeld ? "; cloud sync paused" : ""}`);
  return true;
}
function markOpen() {
  try {
    const fd = fs.openSync(OPEN_MARK, "w");
    try { fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch { /* only a check skipped next time */ }
}
/** No books to open: an empty in-memory stand-in, never seeded, never backed up or synced. */
function unavailable(why: StartNotice["why"]) {
  mode = "unavailable";
  // read by lib/businessSetup.ts, lib/backup.ts and lib/cloud.ts before they start anything
  process.env.MANDI_NO_SEED = "1";
  process.env.MANDI_NO_AUTO_BACKUP = "1";
  notice({ kind: "unavailable", why, detail: lastDetail });
  console.error(`[db] the books file is ${why} and no backup could be put back${lastDetail ? ` (${lastDetail})` : ""}; nothing is opened (nothing was deleted)`);
  return new Database(":memory:");
}

function openBooks(): Database.Database {
  restorePending();
  const unclean = fs.existsSync(OPEN_MARK);
  let size: number | null = null;
  try { size = fs.statSync(DB_PATH).size; } catch { /* missing */ }
  if ((size === null || size === 0) && usedBefore()) {
    const good = newestGoodBackup();
    if (!good || !putBack(good, "missing")) return unavailable("missing");
  }
  let db: Database.Database | null = null;
  let damaged = false;
  try {
    db = new Database(DB_PATH);
    db.pragma("busy_timeout = 5000");
    // the first read of the file: a damaged header shows here
    db.pragma("journal_mode = WAL");
    if (unclean) console.warn("[db] the last run did not close cleanly: checking the books file");
    if (unclean && !quickCheck(db)) {
      // a damaged index is rebuilt from its table, with nothing lost
      try { db.exec("REINDEX"); } catch { /* the table itself is damaged */ }
      damaged = !quickCheck(db);
      if (!damaged) console.warn("[db] the books file had a damaged index; it was rebuilt and nothing was lost");
    }
  } catch (e) {
    if (!isDamage(e)) throw e;
    damaged = true;
    try { db?.close(); } catch { /* not open */ }
    db = null;
  }
  if (!damaged) {
    markOpen();
    // books that open and check whole again: an old "damaged" message no longer applies
    if (readStartNotice()?.kind !== "restored") dismissStartNotice();
    return db!;
  }
  const good = newestGoodBackup();
  if (good) {
    try { db?.close(); } catch { /* not open */ }
    if (putBack(good, "damaged")) { markOpen(); return new Database(DB_PATH); }
    if (fs.existsSync(DB_PATH)) {
      try { db = new Database(DB_PATH); db.pragma("journal_mode = WAL"); } catch { db = null; }
    }
  }
  if (db) {
    // readable, so it stays where it is and is checked again at the next start (the mark stays);
    // nothing writes to it meanwhile: no automatic backups (they would fail) and no sync
    mode = "readOnly";
    process.env.MANDI_NO_AUTO_BACKUP = "1";
    notice({ kind: "readOnly", why: "damaged", detail: lastDetail });
    console.error(`[db] the books file is damaged and no backup could be put back${lastDetail ? ` (${lastDetail})` : ""}: open for reading only`);
    markOpen();
    return db;
  }
  return unavailable("damaged");
}

export const sqlite = openBooks();
sqlite.pragma("journal_mode = WAL");
// every saved entry is on the disk before "saved" is shown: a power cut cannot take it back
sqlite.pragma("synchronous = FULL");
sqlite.pragma("foreign_keys = ON");
sqlite.pragma("busy_timeout = 5000");
// a year of a mandi's data is a few tens of MB: keep the busy part of it in memory
sqlite.pragma("cache_size = -32000");
sqlite.pragma("temp_store = MEMORY");

export const db = drizzle(sqlite, { schema });
export { schema };

/**
 * Damage met in the books while they are open (a start-up job, a screen):
 * this run is then not taken as clean, so the next start checks the file and
 * mends it or puts a backup back. True when `e` is such damage.
 */
let damageMet = false;
export function noteDamage(e: unknown) {
  if (!isDamage(e)) return false;
  if (!damageMet) console.error("[db] the books file is damaged: it is checked at the next start");
  damageMet = true;
  return true;
}

/** Everything into the main file, then closed; a clean close is remembered (no check at the next start). */
export function closeBooks() {
  if (!sqlite.open) return;
  try { sqlite.pragma("wal_checkpoint(TRUNCATE)"); } catch { /* folded in at the next open */ }
  try { sqlite.close(); } catch { return; }
  if (mode === "ok" && !damageMet) fs.rmSync(OPEN_MARK, { force: true });
}

/** What start-up did to the books, until someone closes the message. */
export function readStartNotice(): StartNotice | null {
  return readJsonFile<StartNotice>(START_NOTICE).value;
}
export function dismissStartNotice() {
  for (const f of [START_NOTICE, `${START_NOTICE}.bak`]) fs.rmSync(f, { force: true });
}
