import fs from "node:fs";
import path from "node:path";
import { sqlite, DB_PATH } from "../db/client.ts";

/* Backups of the whole database (every business in it), taken with SQLite's
   own online backup, so a copy is consistent even while the app is in use.
     auto-…           every 12 hours while the app runs (30 kept)
     before-update-…  just before a database update is applied (20 kept)
     manual-…         "Back up now" (20 kept)
   With a second folder set — a pen drive, or a Google Drive / OneDrive folder
   that syncs itself — every backup is copied there too.
   The settings live in a small file next to the database, not inside it:
   restoring an old backup must not change where backups go. */

const DATA_DIR = path.dirname(DB_PATH);
export const BACKUP_DIR = path.join(DATA_DIR, "backups");
const CFG_PATH = path.join(DATA_DIR, "backup.json");
const KEEP = { auto: 30, "before-update": 20, manual: 20 } as const;
export type BackupKind = keyof typeof KEEP;
export const BACKUP_NAME = /^(auto|before-update|manual)-\d{8}-\d{6}\.db$/;

export interface BackupConfig { folder: string | null; lastAt: string | null; lastError: string | null; copiedAt: string | null }

export function readBackupConfig(): BackupConfig {
  try {
    const c = JSON.parse(fs.readFileSync(CFG_PATH, "utf8"));
    return { folder: c.folder ?? null, lastAt: c.lastAt ?? null, lastError: c.lastError ?? null, copiedAt: c.copiedAt ?? null };
  } catch {
    return { folder: null, lastAt: null, lastError: null, copiedAt: null };
  }
}
function writeBackupConfig(c: BackupConfig) {
  fs.writeFileSync(CFG_PATH, JSON.stringify(c, null, 2));
}

const stamp = (d = new Date()) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

/** Keep the newest `keep` backups of one kind in a folder; delete older ones of that kind only. */
function prune(dir: string, kind: BackupKind) {
  const mine = fs.readdirSync(dir).filter((f) => BACKUP_NAME.test(f) && f.startsWith(`${kind}-`)).sort();
  for (const f of mine.slice(0, Math.max(0, mine.length - KEEP[kind]))) fs.rmSync(path.join(dir, f), { force: true });
}

/** A second folder must exist and take a file; says why not in plain words. */
export function checkFolder(folder: string): string | null {
  if (!path.isAbsolute(folder)) return "Give the full path of the folder, e.g. D:\\\\Backups or C:\\\\Users\\\\you\\\\Google Drive\\\\Mandi";
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) return "That folder does not exist";
  const probe = path.join(folder, `.mandi-write-test-${process.pid}`);
  try { fs.writeFileSync(probe, "ok"); fs.rmSync(probe); } catch { return "The app cannot write into that folder"; }
  if (path.resolve(folder).startsWith(path.resolve(DATA_DIR))) return "Pick a folder outside the app's own data folder";
  return null;
}

export function setBackupFolder(folder: string | null) {
  const c = readBackupConfig();
  writeBackupConfig({ ...c, folder });
}

export async function backupNow(kind: BackupKind) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const name = `${kind}-${stamp()}.db`;
  const file = path.join(BACKUP_DIR, name);
  await sqlite.backup(file);
  prune(BACKUP_DIR, kind);
  const c = readBackupConfig();
  let copiedAt = c.copiedAt;
  let lastError: string | null = null;
  if (c.folder) {
    const problem = checkFolder(c.folder);
    if (problem) lastError = `Could not copy to ${c.folder}: ${problem}`;
    else {
      try {
        const out = path.join(c.folder, "MandiMitra-backups");
        fs.mkdirSync(out, { recursive: true });
        fs.copyFileSync(file, path.join(out, name));
        prune(out, kind);
        copiedAt = new Date().toISOString();
      } catch (e) {
        lastError = `Could not copy to ${c.folder}: ${e instanceof Error ? e.message : "failed"}`;
      }
    }
  }
  writeBackupConfig({ ...c, lastAt: new Date().toISOString(), lastError, copiedAt });
  return { name, bytes: fs.statSync(file).size };
}

export function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR).filter((f) => BACKUP_NAME.test(f)).map((f) => {
    const st = fs.statSync(path.join(BACKUP_DIR, f));
    return { name: f, kind: f.split("-").slice(0, -2).join("-") as BackupKind, bytes: st.size, at: st.mtime.toISOString() };
  }).sort((a, b) => b.at.localeCompare(a.at));
}

/**
 * A copy of the database file just before an update changes its tables.
 * Runs at start-up, before anything else touches the database, so a plain
 * file copy after a checkpoint is consistent.
 */
export function backupBeforeUpdate() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  sqlite.pragma("wal_checkpoint(TRUNCATE)");
  const name = `before-update-${stamp()}.db`;
  fs.copyFileSync(DB_PATH, path.join(BACKUP_DIR, name));
  prune(BACKUP_DIR, "before-update");
  return name;
}

let timer: NodeJS.Timeout | null = null;
/** Every hour, take an automatic backup if the last one is 12 hours old or more. */
export function startAutoBackups() {
  if (timer || process.env.MANDI_NO_AUTO_BACKUP === "1") return;
  const tick = async () => {
    try {
      const last = listBackups().find((b) => b.kind === "auto");
      if (!last || Date.now() - new Date(last.at).getTime() > 12 * 3600_000) await backupNow("auto");
    } catch (e) {
      const c = readBackupConfig();
      writeBackupConfig({ ...c, lastError: e instanceof Error ? e.message : "Backup failed" });
    }
  };
  setTimeout(() => void tick(), 60_000).unref();
  timer = setInterval(() => void tick(), 3600_000);
  timer.unref();
}
