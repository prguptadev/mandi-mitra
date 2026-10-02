import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { sqlite, DB_PATH, RESTORE_PENDING } from "../db/client.ts";

/* Backups of the whole database (every business in it), taken with SQLite's
   own online backup, so a copy is consistent even while the app is in use.
     auto-…           every 12 hours while the app runs (the last 30, plus
                      one a week for half a year)
     before-update-…  just before a database update is applied (20 kept)
     manual-…         "Back up now" (20 kept)
     before-cloud-…   this computer's own data, just before the cloud's
                      replaced it (joining, or "Bring all data down"; 10 kept)
   The scan pictures are files beside the database (data/scans), not in it:
   they go into the second folder only, below, next to the database copies.
   Each is written under a temporary name, checked, then renamed: a file with
   a backup's name is always a whole, readable database.
   With a second folder set — a pen drive, or a Google Drive / OneDrive folder
   that syncs itself — every backup is copied there too, into a sub-folder
   named after this computer (two computers sharing one Drive folder never
   prune each other's copies).
   The settings live in a small file next to the database, not inside it:
   restoring an old backup must not change where backups go. */

const DATA_DIR = path.dirname(DB_PATH);
export const BACKUP_DIR = path.join(DATA_DIR, "backups");
const CFG_PATH = path.join(DATA_DIR, "backup.json");
const KEEP = { auto: 30, "before-update": 20, manual: 20, "before-restore": 10, "before-cloud": 10 } as const;
export type BackupKind = keyof typeof KEEP;
export const BACKUP_NAME = /^(auto|before-update|manual|before-restore|before-cloud)-\d{8}-\d{6}\.db$/;

export interface BackupConfig {
  folder: string | null; lastAt: string | null; lastError: string | null; copiedAt: string | null;
  /** Scan pictures in the second folder after the last copy: how many there are, of how many on this computer. */
  pictures: { inFolder: number; here: number; at: string } | null;
}

export function readBackupConfig(): BackupConfig {
  try {
    const c = JSON.parse(fs.readFileSync(CFG_PATH, "utf8"));
    return { folder: c.folder ?? null, lastAt: c.lastAt ?? null, lastError: c.lastError ?? null, copiedAt: c.copiedAt ?? null, pictures: c.pictures ?? null };
  } catch {
    return { folder: null, lastAt: null, lastError: null, copiedAt: null, pictures: null };
  }
}
function writeBackupConfig(c: BackupConfig) {
  fs.writeFileSync(CFG_PATH, JSON.stringify(c, null, 2));
}

const stamp = (d = new Date()) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

const WEEKS_KEPT = 26;
/**
 * Keep the newest backups of one kind in a folder, delete older ones of that
 * kind only — never `keepAlso` (the one just made, even if the PC clock went
 * back and it sorts oldest). Automatic backups past the newest 30 keep one a
 * week for half a year.
 */
function prune(dir: string, kind: BackupKind, keepAlso?: string) {
  const mine = fs.readdirSync(dir).filter((f) => BACKUP_NAME.test(f) && f.startsWith(`${kind}-`) && f !== keepAlso).sort();
  const old = mine.slice(0, Math.max(0, mine.length - KEEP[kind]));
  const weekly = new Set<string>();
  if (kind === "auto") {
    const seen = new Set<string>();
    for (const f of [...old].reverse()) {
      const d = f.match(/(\d{4})(\d{2})(\d{2})-/);
      if (!d) continue;
      const week = Math.floor(Date.UTC(+d[1], +d[2] - 1, +d[3]) / (7 * 86400_000));
      if (!seen.has(String(week)) && seen.size < WEEKS_KEPT) { seen.add(String(week)); weekly.add(f); }
    }
  }
  for (const f of old) if (!weekly.has(f)) fs.rmSync(path.join(dir, f), { force: true });
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

export async function backupNow(kind: BackupKind) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const name = `${kind}-${stamp()}.db`;
  const file = path.join(BACKUP_DIR, name);
  const tmp = `${file}.tmp`;
  try {
    await sqlite.backup(tmp);
    verify(tmp);
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
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
      out = path.join(c.folder, "MandiMitra-backups", hostDir());
      try {
        fs.mkdirSync(out, { recursive: true });
        // a pen drive is slow: the copy runs off the app's only thread
        await fsp.copyFile(file, path.join(out, `${name}.tmp`));
        fs.renameSync(path.join(out, `${name}.tmp`), path.join(out, name));
        prune(out, kind, name);
        copiedAt = new Date().toISOString();
      } catch (e) {
        lastError = `Could not copy to ${c.folder}: ${e instanceof Error ? e.message : "failed"}`;
      }
    }
  }
  writeBackupConfig({ ...c, lastAt: new Date().toISOString(), lastError, copiedAt });
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

/**
 * A copy of the database just before an update changes its tables. Runs at
 * start-up, before anything else touches the database. VACUUM INTO writes a
 * whole, consistent copy (WAL included); it is checked before it counts.
 * Throws if no good copy could be made: the update must not go ahead then.
 */
export function backupBeforeUpdate() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const name = `before-update-${stamp()}.db`;
  const file = path.join(BACKUP_DIR, name);
  const tmp = `${file}.tmp`;
  fs.rmSync(tmp, { force: true });
  try {
    sqlite.prepare("vacuum into ?").run(tmp);
    verify(tmp);
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  prune(BACKUP_DIR, "before-update", name);
  return file;
}

let timer: NodeJS.Timeout | null = null;
/** Every hour, take an automatic backup if the last one is 12 hours old or more. */
export function startAutoBackups() {
  if (timer || process.env.MANDI_NO_AUTO_BACKUP === "1") return;
  const tick = async () => {
    try {
      const last = listBackups().find((b) => b.kind === "auto");
      const age = last ? Date.now() - new Date(last.at).getTime() : Infinity;
      // a "future" backup means the PC clock went back: take one anyway
      if (age > 12 * 3600_000 || age < 0) await backupNow("auto");
    } catch (e) {
      const c = readBackupConfig();
      writeBackupConfig({ ...c, lastError: e instanceof Error ? e.message : "Backup failed" });
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
  fs.writeFileSync(RESTORE_PENDING, JSON.stringify({ file, at: new Date().toISOString() }));
  return { name };
}
