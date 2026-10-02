import fs from "node:fs";
import path from "node:path";

/*
 * Files that must survive the power going. A file is written whole under a
 * temporary name, flushed to the disk, then renamed over the real one, so
 * after a cut there is the old file or the whole new one, never a part, and
 * never a correctly named file full of zeros. Nothing here imports the
 * database: db/client.ts uses it before the books are open.
 */

/** Flushes a file's contents to the disk (FlushFileBuffers on Windows, which needs write access). */
export function fsyncFile(file: string) {
  const fd = fs.openSync(file, "r+");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** Flushes a folder's list of names (a rename) on macOS and Linux; NTFS journals its own renames. */
export function fsyncDir(dir: string) {
  if (process.platform === "win32") return;
  try {
    const fd = fs.openSync(dir, "r");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch { /* a file system that cannot: the rename itself still happened */ }
}

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** A rename that waits out a virus scanner holding the file for a moment (Windows). */
export function renameRetry(from: string, to: string) {
  for (let i = 0; ; i++) {
    try { fs.renameSync(from, to); return; } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (i >= 8 || !(code === "EPERM" || code === "EBUSY" || code === "EACCES")) throw e;
      pause(150);
    }
  }
}

/** tmp (already written) becomes `to`: flushed, renamed, and the rename flushed. */
export function renameDurable(tmp: string, to: string) {
  fsyncFile(tmp);
  renameRetry(tmp, to);
  fsyncDir(path.dirname(to));
}

/** A copy that is either absent or whole, under its own name. */
export function copyDurable(from: string, to: string) {
  const tmp = `${to}.tmp`;
  try {
    fs.copyFileSync(from, tmp);
    renameDurable(tmp, to);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

/** A small settings file: read, falling back to its earlier copy (.bak) when the main one is cut short. */
export function readJsonFile<T extends object>(file: string): { value: T | null; unreadable: boolean } {
  let unreadable = false;
  for (const f of [file, `${file}.bak`]) {
    try {
      const v = JSON.parse(fs.readFileSync(f, "utf8"));
      if (v && typeof v === "object" && !Array.isArray(v)) return { value: v as T, unreadable: false };
      unreadable = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") unreadable = true;
    }
  }
  return { value: null, unreadable };
}

/**
 * Writes a small settings file whole: tmp, flush, keep the previous readable
 * copy as .bak (a damaged one is set aside as .damaged, never lost), rename.
 */
export function writeJsonFile(file: string, value: unknown) {
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, "w");
  try { fs.writeSync(fd, JSON.stringify(value, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try {
    const before = fs.readFileSync(file, "utf8");
    let readable = false;
    try { readable = typeof JSON.parse(before) === "object"; } catch { /* cut short */ }
    fs.writeFileSync(readable ? `${file}.bak` : `${file}.damaged`, before);
  } catch { /* no earlier file */ }
  try {
    renameRetry(tmp, file);
  } catch {
    // held by another program: written in place, the .bak beside it meanwhile
    fs.copyFileSync(tmp, file);
    fs.rmSync(tmp, { force: true });
  }
  fsyncDir(path.dirname(file));
}

/* ------------------------------------------------------------ plain words */

/** The disk (or SQLite's file) has no room left. */
export function isDiskFull(e: unknown) {
  const x = e as { code?: string; message?: string } | null;
  return x?.code === "ENOSPC" || x?.code === "SQLITE_FULL" || /ENOSPC|SQLITE_FULL|database or disk is full|no space left/i.test(x?.message ?? "");
}
/** Damage SQLite reports in the books file itself. */
export function isDamage(e: unknown) {
  const x = e as { code?: string } | null;
  return typeof x?.code === "string" && /^SQLITE_(CORRUPT|NOTADB)/.test(x.code);
}

export const DISK_FULL = "The disk is full. Free some space on this computer and try again.";
export const COULD_NOT_WRITE = "This computer could not write the books file. Try again; if it keeps happening, restart the computer.";

/** Free bytes on the disk holding `dir` (Infinity when it cannot be told). */
export function freeBytes(dir: string) {
  try { const s = fs.statfsSync(dir); return s.bavail * s.bsize; } catch { return Infinity; }
}

/**
 * One plain sentence for an error from the disk or SQLite; others keep their
 * own words. With `dir`, a disk with (almost) nothing left is named as the
 * cause even when SQLite only says it could not open or write a file.
 */
export function plainError(e: unknown, dir?: string): string {
  if (isDiskFull(e) || (dir !== undefined && freeBytes(dir) < 1024 * 1024)) return DISK_FULL;
  const code = (e as { code?: string } | null)?.code ?? "";
  if (/^SQLITE_IOERR/.test(code) || code === "EIO") return COULD_NOT_WRITE;
  if (isDamage(e)) return "The file is damaged";
  return e instanceof Error ? e.message : String(e);
}
