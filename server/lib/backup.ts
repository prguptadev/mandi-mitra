import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { sqlite, DB_PATH, RESTORE_PENDING, BACKUP_DIR, BACKUP_NAME, BOOKS_UNAVAILABLE, booksMode } from "../db/client.ts";
import { plainError, readJsonFile, renameDurable, writeJsonFile } from "../db/durable.ts";

export { BACKUP_DIR, BACKUP_NAME };

/* Backups of the whole database (every business in it), taken with SQLite's
   own online backup, so a copy is consistent even while the app is in use.
     auto-…           every 12 hours while the app runs, once each evening,
                      and on closing the app when the last one is 2 hours old
                      (the last 30, plus one a week for half a year)
     before-update-…  just before a database update is applied (20 kept)
     manual-…         "Back up now" (20 kept)
     before-cloud-…   this computer's own data, just before the cloud's
                      replaced it (joining, or "Bring all data down"; 10 kept)
   Nothing is removed for size while the disk holding them has room. Only
   when it is short of room (under 2 GB free, a tenth of a small pen drive,
   or room for fewer than 3 more copies of the books) are old ones removed,
   until it is not: the oldest daily copies first, the weekly ones of half a
   year last, never the newest of a kind. Each folder goes by its own disk.
   The scan pictures are files beside the database (data/scans), not in it:
   they go into the second folder only, below, next to the database copies.
   Each is written under a temporary name, checked, flushed to the disk, then
   renamed: a file with a backup's name is always a whole, readable database.
   With a second folder set — a pen drive, or a Google Drive / OneDrive folder
   that syncs itself — every backup is copied there too, into a sub-folder
   named after this computer (two computers sharing one Drive folder never
   prune each other's copies).
   The settings live in a small file next to the database, not inside it:
   restoring an old backup must not change where backups go. */

const DATA_DIR = path.dirname(DB_PATH);
const CFG_PATH = path.join(DATA_DIR, "backup.json");
const KEEP = { auto: 30, "before-update": 20, manual: 20, "before-restore": 10, "before-cloud": 10 } as const;
export type BackupKind = keyof typeof KEEP;

export interface BackupConfig {
  folder: string | null; lastAt: string | null; lastError: string | null; copiedAt: string | null;
  /** The backup on this computer itself failed (not the second folder): said on every screen until one succeeds. */
  localError: string | null;
  /** Scan pictures in the second folder after the last copy: how many there are, of how many on this computer. */
  pictures: { inFolder: number; here: number; at: string } | null;
}

/* backup.json is written whole (tmp, flushed, renamed) with its earlier copy
   kept as backup.json.bak, which is read if the main file is ever cut short:
   a power cut must not quietly forget the second folder. */
export function readBackupConfig(): BackupConfig {
  const c = readJsonFile<Partial<BackupConfig>>(CFG_PATH).value ?? {};
  return {
    folder: c.folder ?? null, lastAt: c.lastAt ?? null, lastError: c.lastError ?? null, copiedAt: c.copiedAt ?? null,
    localError: c.localError ?? null, pictures: c.pictures ?? null,
  };
}
function writeBackupConfig(c: BackupConfig) {
  writeJsonFile(CFG_PATH, c);
}
function patchBackupConfig(p: Partial<BackupConfig>) {
  try { writeBackupConfig({ ...readBackupConfig(), ...p }); } catch { /* the disk is full: the log says it */ }
}

const stamp = (d = new Date()) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
/** Files in the order they were made (the time in the name). */
const byStamp = (a: string, b: string) => a.replace(/^\D+/, "").localeCompare(b.replace(/^\D+/, ""));
/** A half-written copy removed; a folder that is not there (or not a folder) is no matter. */
const rmQuiet = (f: string) => { try { fs.rmSync(f, { force: true }); } catch { /* nothing to remove */ } };
const removeBackup = (dir: string, f: string) => {
  for (const s of ["", "-wal", "-shm"]) fs.rmSync(path.join(dir, f + s), { force: true });
};

const WEEKS_KEPT = 26;
/** Of the automatic backups past the newest 30 (oldest first), the ones kept: the newest of each week, for half a year. */
function weeklyKeepers(old: string[]) {
  const weekly = new Set<string>();
  const seen = new Set<number>();
  for (const f of [...old].reverse()) {
    const d = f.match(/(\d{4})(\d{2})(\d{2})-/);
    if (!d) continue;
    const week = Math.floor(Date.UTC(+d[1], +d[2] - 1, +d[3]) / (7 * 86400_000));
    if (!seen.has(week) && seen.size < WEEKS_KEPT) { seen.add(week); weekly.add(f); }
  }
  return weekly;
}
/**
 * Keep the newest backups of one kind in a folder, delete older ones of that
 * kind only — never `keepAlso` (the one just made, even if the PC clock went
 * back and it sorts oldest). Automatic backups past the newest 30 keep one a
 * week for half a year.
 */
function prune(dir: string, kind: BackupKind, keepAlso?: string) {
  const mine = fs.readdirSync(dir).filter((f) => BACKUP_NAME.test(f) && f.startsWith(`${kind}-`) && f !== keepAlso).sort();
  const old = mine.slice(0, Math.max(0, mine.length - KEEP[kind]));
  const weekly = kind === "auto" ? weeklyKeepers(old) : new Set<string>();
  for (const f of old) if (!weekly.has(f)) removeBackup(dir, f);
}

/** Free and total bytes on the disk holding `dir`, or null when they cannot be told. (An object, so the checks can stand in for a disk.) */
export const disk = {
  space(dir: string): { free: number; size: number } | null {
    try {
      const s = fs.statfsSync(dir);
      return { free: s.bavail * s.bsize, size: s.blocks * s.bsize };
    } catch { return null; }
  },
};
const GB = 1024 ** 3;
/** The room a disk holding backups keeps free: 2 GB (a tenth of a small pen drive), and at least 3 copies of the books. */
export const roomKept = (diskBytes: number, books: number) => Math.max(Math.min(2 * GB, diskBytes / 10), 3 * books);
const kindOf = (f: string) => f.replace(/-\d{8}-\d{6}\.db$/, "");
/**
 * Only when the disk holding `dir` is short of room (roomKept): old backups
 * are removed until it is not. The oldest daily copies go first, then the
 * one-off ones (by hand, before an update…), and the weekly ones of half a
 * year last; never `keep` nor the newest of each kind. On a disk with room,
 * or one that cannot be measured, nothing is removed. Returns the names removed.
 */
export function makeRoom(dir: string, keep: string[] = [], books = dbBytes(), room = disk.space(dir)): string[] {
  if (!room) return [];
  let short = roomKept(room.size, books) - room.free;
  if (short <= 0) return [];
  let files: string[];
  try { files = fs.readdirSync(dir).filter((f) => BACKUP_NAME.test(f)).sort(byStamp); } catch { return []; }
  const newestOfKind = new Set<string>();
  const kinds = new Set<string>();
  for (const f of [...files].reverse()) if (!kinds.has(kindOf(f))) { kinds.add(kindOf(f)); newestOfKind.add(f); }
  const autos = files.filter((f) => kindOf(f) === "auto");
  const weekly = weeklyKeepers(autos.slice(0, Math.max(0, autos.length - KEEP.auto)));
  const order = [
    ...autos.filter((f) => !weekly.has(f)),
    ...files.filter((f) => kindOf(f) !== "auto"),
    ...autos.filter((f) => weekly.has(f)),
  ];
  const removed: string[] = [];
  for (const f of order) {
    if (short <= 0) break;
    if (keep.includes(f) || newestOfKind.has(f)) continue;
    let bytes = 0;
    for (const side of ["", "-wal", "-shm"]) { try { bytes += fs.statSync(path.join(dir, f + side)).size; } catch { /* none */ } }
    try { removeBackup(dir, f); } catch { continue; }
    short -= bytes;
    removed.push(f);
  }
  if (removed.length) console.warn(`[backup] the disk holding ${dir} is short of room: removed ${removed.length} old backup(s), the oldest daily ones first`);
  return removed;
}
const dbBytes = () => { try { return fs.statSync(DB_PATH).size; } catch { return 0; } };

/**
 * Half-written copies left by a backup cut short (the app closed, killed, or
 * the power going): the size of the books each, and nothing ever removed them.
 * Only ones older than ten minutes: a backup running now is never touched.
 */
export function sweepStaleTemps(dir = BACKUP_DIR) {
  let n = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!/\.tmp(-wal|-shm|-journal)?$/.test(f)) continue;
      const file = path.join(dir, f);
      try {
        if (Date.now() - fs.statSync(file).mtimeMs < 10 * 60_000) continue;
        fs.rmSync(file, { force: true });
        n++;
      } catch { /* gone already */ }
    }
  } catch { /* no folder yet */ }
  return n;
}

/** A copy is only kept if SQLite can read it through. */
function verify(file: string) {
  const d = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const r = d.pragma("quick_check", { simple: true });
    if (r !== "ok") throw new Error(`the copy is damaged (${String(r).slice(0, 80)})`);
  } finally { d.close(); }
}
const hostDir = () => os.hostname().replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 40) || "this-computer";

/** A second folder must exist and take a file; says why not in plain words. */
export function checkFolder(folder: string): string | null {
  if (!path.isAbsolute(folder)) return "Give the full path of the folder, e.g. D:\\\\Backups or C:\\\\Users\\\\you\\\\Google Drive\\\\Mandi";
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) return "That folder does not exist";
  const probe = path.join(folder, `.mandi-write-test-${process.pid}`);
  try { fs.writeFileSync(probe, "ok"); fs.rmSync(probe); } catch { return "The app cannot write into that folder"; }
  // inside the data folder, not merely starting with its name ("…\\Mandi Mitra Backups" beside "…\\Mandi Mitra" is fine)
  const rel = path.relative(path.resolve(DATA_DIR), path.resolve(folder));
  if (rel === "" || !(rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))) return "Pick a folder outside the app's own data folder";
  return null;
}

export function setBackupFolder(folder: string | null) {
  const c = readBackupConfig();
  writeBackupConfig({ ...c, folder });
}

/** Where the scan pictures live: beside the database, on this computer only. */
export const SCAN_PICTURES_DIR = path.join(DATA_DIR, "scans");

/** The picture copy running now, if any: a second backup meanwhile waits for it rather than starting another. */
let picturesRun: Promise<void> | null = null;

/**
 * The scan pictures, copied into the second folder beside the database
 * backups (in scans/<sheet>/). A picture is the paper behind every scanned
 * slip, and the database backup does not hold it. Only what is new or
 * changed is copied, and nothing in the folder is ever deleted, so a sheet
 * deleted here by mistake can still be found there.
 * The first copy after the update can be a whole season of pictures to a
 * slow pen drive: it runs in the background, one file at a time, and the
 * app answers meanwhile. A picture that cannot be read is skipped, counted
 * and said; the rest are still copied.
 */
export function copyScanPictures(out: string, folder: string): Promise<void> {
  if (picturesRun) return picturesRun;
  picturesRun = (async () => {
    let inFolder = 0, here = 0, failed = 0;
    const ids = await fsp.readdir(SCAN_PICTURES_DIR).catch(() => [] as string[]);
    for (const id of ids) {
      if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) continue;
      const dir = path.join(SCAN_PICTURES_DIR, id);
      const files = await fsp.readdir(dir).catch(() => null);
      if (!files) {
        // a sheet's folder that cannot be opened is said, not passed over
        if ((await fsp.stat(dir).catch(() => null))?.isDirectory()) failed++;
        continue;
      }
      for (const f of files) {
        if (f.endsWith(".tmp")) continue;
        const from = path.join(dir, f);
        const picture = f !== "meta.json";
        const to = path.join(out, "scans", id, f);
        try {
          const st = await fsp.stat(from);
          if (!st.isFile()) continue;
          if (picture) here++;
          // pictures never change once saved; the small meta.json beside them does
          const there = await fsp.stat(to).catch(() => null);
          if (picture && there?.size === st.size) { inFolder++; continue; }
          await fsp.mkdir(path.dirname(to), { recursive: true });
          await fsp.copyFile(from, `${to}.tmp`);
          await fsp.rename(`${to}.tmp`, to);
          if (picture) inFolder++;
        } catch {
          if (picture) failed++;
          await fsp.rm(`${to}.tmp`, { force: true }).catch(() => undefined);
        }
      }
    }
    const c = readBackupConfig();
    writeBackupConfig({
      ...c, pictures: { inFolder, here, at: new Date().toISOString() },
      lastError: c.lastError ?? (failed ? `${failed} scan picture(s) could not be copied to ${folder}. The others were copied.` : null),
    });
  })().catch(() => undefined).finally(() => { picturesRun = null; });
  return picturesRun;
}

/** How long "Back up now" waits for the pictures before it answers; the rest carry on behind it. */
const PICTURES_WAIT_MS = 2_000;

/** A copy in the second folder, flushed off the app's only thread (a pen drive is slow). */
async function copyToFolder(folder: string, name: string, kind: BackupKind) {
  const out = path.join(folder, "MandiMitra-backups", hostDir());
  fs.mkdirSync(out, { recursive: true });
  // the second folder's own disk (a pen drive, a Drive folder) decides whether it is short of room
  makeRoom(out);
  const tmp = path.join(out, `${name}.tmp`);
  await fsp.copyFile(path.join(BACKUP_DIR, name), tmp);
  const h = await fsp.open(tmp, "r+");
  try { await h.sync(); } finally { await h.close(); }
  await fsp.rename(tmp, path.join(out, name));
  prune(out, kind, name);
  return out;
}

/** The backup on this computer failed: one plain line, on every screen, until one succeeds. */
function localFailed(e: unknown, what = "The backup could not be made") {
  const text = `${what}: ${plainError(e, DATA_DIR)}`;
  patchBackupConfig({ localError: text });
  return text;
}

export async function backupNow(kind: BackupKind) {
  if (booksMode() === "unavailable") throw new Error(BOOKS_UNAVAILABLE);
  const name = `${kind}-${stamp()}.db`;
  const file = path.join(BACKUP_DIR, name);
  const tmp = `${file}.tmp`;
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    makeRoom(BACKUP_DIR);
    await sqlite.backup(tmp);
    verify(tmp);
    renameDurable(tmp, file);
  } catch (e) {
    rmQuiet(tmp);
    throw new Error(localFailed(e));
  }
  prune(BACKUP_DIR, kind, name);
  const c = readBackupConfig();
  let copiedAt = c.copiedAt;
  let lastError: string | null = null;
  let out: string | null = null;
  if (c.folder) {
    const problem = checkFolder(c.folder);
    if (problem) lastError = `Could not copy to ${c.folder}: ${problem}`;
    else {
      try {
        out = await copyToFolder(c.folder, name, kind);
        copiedAt = new Date().toISOString();
      } catch (e) {
        out = null;
        lastError = `Could not copy to ${c.folder}: ${plainError(e, c.folder)}`;
      }
    }
  }
  patchBackupConfig({ lastAt: new Date().toISOString(), lastError, copiedAt, localError: null });
  // the pictures go after the database, and a failure with them never costs the backup itself
  if (c.folder && out) {
    const job = copyScanPictures(out, c.folder);
    await Promise.race([job, new Promise((r) => setTimeout(r, PICTURES_WAIT_MS).unref())]);
  }
  return { name, bytes: fs.statSync(file).size };
}

export function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR).filter((f) => BACKUP_NAME.test(f)).flatMap((f) => {
    try {
      const st = fs.statSync(path.join(BACKUP_DIR, f));
      return [{ name: f, kind: f.split("-").slice(0, -2).join("-") as BackupKind, bytes: st.size, at: st.mtime.toISOString() }];
    } catch { return []; } // pruned a moment ago
  }).sort((a, b) => b.at.localeCompare(a.at));
}

/** VACUUM INTO a checked copy, synchronously (start-up and closing, when nothing else runs). */
function vacuumCopy(kind: BackupKind) {
  const name = `${kind}-${stamp()}.db`;
  const file = path.join(BACKUP_DIR, name);
  const tmp = `${file}.tmp`;
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    rmQuiet(tmp);
    makeRoom(BACKUP_DIR);
    sqlite.prepare("vacuum into ?").run(tmp);
    verify(tmp);
    renameDurable(tmp, file);
  } catch (e) {
    rmQuiet(tmp);
    throw e;
  }
  prune(BACKUP_DIR, kind, name);
  return file;
}

/**
 * A copy of the database just before an update changes its tables. Runs at
 * start-up, before anything else touches the database. VACUUM INTO writes a
 * whole, consistent copy (WAL included); it is checked before it counts.
 * When it cannot be made (a damaged page, or not enough room for VACUUM's own
 * work), the file is copied as it is instead. When even that fails (the disk
 * is full), the update still goes ahead — it is all one transaction, checked
 * before it is kept, so the books are never left half-updated — and every
 * screen says the backup failed. A backup must never stop the app opening.
 */
export function backupBeforeUpdate(): { file: string | null; plain?: boolean; problem?: string } {
  try {
    return { file: vacuumCopy("before-update") };
  } catch (e) {
    console.warn(`[db] could not VACUUM INTO a copy before the update (${plainError(e)}); copying the file as it is`);
  }
  const name = `before-update-${stamp()}.db`;
  const file = path.join(BACKUP_DIR, name);
  const tmp = `${file}.tmp`;
  try {
    try { sqlite.pragma("wal_checkpoint(TRUNCATE)"); } catch (e) { console.warn("[db] could not fold the -wal in before copying; the plain copy may miss the latest changes", e); }
    makeRoom(BACKUP_DIR);
    fs.copyFileSync(DB_PATH, tmp);
    renameDurable(tmp, file);
    prune(BACKUP_DIR, "before-update", name);
    return { file, plain: true };
  } catch (e) {
    rmQuiet(tmp);
    return { file: null, problem: localFailed(e, "No copy could be made before the update") };
  }
}

/** The last automatic or by-hand backup on this computer, by the time in its name. */
function lastLocalAt(): number | null {
  try {
    const f = fs.readdirSync(BACKUP_DIR).filter((n) => /^(auto|manual)-\d{8}-\d{6}\.db$/.test(n)).sort(byStamp).pop();
    const m = f?.match(/(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/);
    return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : null;
  } catch { return null; }
}

/**
 * An automatic backup is due when the last one is 12 hours old, from "the
 * future" (the PC clock went back), or the day's work has not been backed up
 * yet after 6 in the evening.
 */
export function autoBackupDue(lastAt: number | null, now = new Date()) {
  if (lastAt === null) return true;
  const age = now.getTime() - lastAt;
  if (age < 0 || age > 12 * 3600_000) return true;
  const evening = new Date(now);
  evening.setHours(18, 0, 0, 0);
  return now >= evening && lastAt < evening.getTime();
}

/** Books larger than this are not copied while closing (closing must stay quick). */
const QUIT_MAX_BYTES = 500 * 1024 * 1024;
/**
 * On closing the app normally: the day's work into a backup, if the last one
 * is more than 2 hours old. Local only (a pen drive could hold the closing
 * app for minutes); the next start copies it to the second folder.
 * Never on a Windows shut-down, which must not be held up.
 */
export function backupOnQuit(): string | null {
  if (booksMode() !== "ok" || !sqlite.open) return null;
  const last = lastLocalAt();
  if (last !== null && Date.now() - last >= 0 && Date.now() - last < 2 * 3600_000) return null;
  if (dbBytes() > QUIT_MAX_BYTES) return null;
  try {
    const file = vacuumCopy("auto");
    patchBackupConfig({ lastAt: new Date().toISOString(), localError: null });
    return path.basename(file);
  } catch (e) {
    localFailed(e);
    return null;
  }
}

/** The newest local backup not yet in the second folder (one made while closing): copied at the next start. */
async function copyLatestToFolder() {
  const c = readBackupConfig();
  if (!c.folder || checkFolder(c.folder)) return;
  let f: string | undefined;
  try { f = fs.readdirSync(BACKUP_DIR).filter((n) => BACKUP_NAME.test(n)).sort(byStamp).pop(); } catch { return; }
  if (!f || fs.existsSync(path.join(c.folder, "MandiMitra-backups", hostDir(), f))) return;
  try {
    await copyToFolder(c.folder, f, f.replace(/-\d{8}-\d{6}\.db$/, "") as BackupKind);
    patchBackupConfig({ copiedAt: new Date().toISOString() });
  } catch (e) {
    patchBackupConfig({ lastError: `Could not copy to ${c.folder}: ${plainError(e)}` });
  }
}

let timer: NodeJS.Timeout | null = null;
/** Every hour, take an automatic backup when one is due (see autoBackupDue). */
export function startAutoBackups() {
  sweepStaleTemps();
  if (timer || process.env.MANDI_NO_AUTO_BACKUP === "1" || booksMode() === "unavailable") return;
  (globalThis as { __mandiBackupOnQuit?: () => string | null }).__mandiBackupOnQuit = backupOnQuit;
  const tick = async () => {
    try {
      const last = listBackups().find((b) => b.kind === "auto");
      if (autoBackupDue(last ? new Date(last.at).getTime() : null)) await backupNow("auto");
      else await copyLatestToFolder();
    } catch (e) {
      if (!readBackupConfig().localError) localFailed(e);
    }
  };
  setTimeout(() => void tick(), 60_000).unref();
  timer = setInterval(() => void tick(), 3600_000);
  timer.unref();
}

/**
 * Puts a backup back: checked now, carried out at the next start (before the
 * database is opened; see db/client.ts). The desktop app restarts itself.
 */
export function scheduleRestore(name: string, migrationsHere: number) {
  if (!BACKUP_NAME.test(name)) throw new Error("Not a backup file");
  const file = path.join(BACKUP_DIR, name);
  if (!fs.existsSync(file)) throw new Error("That backup is no longer there");
  verify(file);
  const d = new Database(file, { readonly: true });
  let theirs = 0;
  try { theirs = (d.prepare("select count(*) as n from __drizzle_migrations").get() as { n: number }).n; } catch { /* very old */ } finally { d.close(); }
  if (theirs > migrationsHere) throw new Error("That backup was made by a newer Mandi Mitra. Install that version first.");
  writeJsonFile(RESTORE_PENDING, { file, at: new Date().toISOString() });
  return { name };
}
