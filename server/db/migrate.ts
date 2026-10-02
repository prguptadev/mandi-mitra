import { readMigrationFiles } from "drizzle-orm/migrator";
import { sqlite, MIGRATIONS_DIR } from "./client.ts";
import { isDamage, isDiskFull } from "./durable.ts";
import { backupBeforeUpdate, type CopyBeforeUpdate } from "../lib/backup.ts";
import { appVersion, previousInstaller, rememberBadVersion, rememberSchema } from "../lib/updater.ts";
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

// the packaged app ships the migrations next to its server bundle
const FOLDER = MIGRATIONS_DIR;

/** Tables a migration may shrink on purpose (none so far). */
const SHRINK_OK = new Set<string>();

const tables = () => sqlite.prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name <> '__drizzle_migrations'").pluck().all() as string[];
/** A damaged table is left out and said in the log: damage the update did not cause never stops the app. */
function eachTable<T>(what: string, fn: (t: string) => T): Map<string, T> {
  const out = new Map<string, T>();
  for (const t of tables()) {
    try { out.set(t, fn(t)); } catch (e) {
      if (!isDamage(e)) throw e;
      console.warn(`[db] ${what}: table ${t} is damaged and was skipped`);
    }
  }
  return out;
}
const rowCounts = () => Object.fromEntries(eachTable("counting rows", (t) => (sqlite.prepare(`select count(*) as n from "${t}"`).get() as { n: number }).n)) as Record<string, number>;

/**
 * The update could not be applied, and the books are exactly as they were
 * (it is all one transaction, rolled back). The desktop app reads the extra
 * fields to offer going back to the version that was there before.
 */
export class MigrationError extends Error {
  override name = "MigrationError";
  /** Read by electron/main.cjs: this start-up failed while updating the books. */
  readonly mandiUpdateFailed = true;
  constructor(message: string, readonly diskFull = false, readonly goBack: { version: string; file: string } | null = null) {
    super(message);
  }
}

interface BrokenLink { table: string; rowid: number | null; parent: string; fkid: number }
/** Records pointing at something that is not there. Read-only. */
function brokenLinks(): BrokenLink[] {
  return [...eachTable("checking links", (t) => sqlite.prepare(`pragma foreign_key_check("${t}")`).all() as { table: string; rowid: number | null; parent: string; fkid: number }[]).values()]
    .flat().map((r) => ({ table: r.table, rowid: r.rowid ?? null, parent: r.parent, fkid: r.fkid }));
}
const describe = (links: BrokenLink[]) => {
  const by = new Map<string, number>();
  for (const l of links) by.set(`${l.table} → ${l.parent}`, (by.get(`${l.table} → ${l.parent}`) ?? 0) + 1);
  return [...by].map(([k, n]) => `${k}${n > 1 ? ` x${n}` : ""}`).join(", ");
};
/** Set when the database was already carrying broken links before this start. */
export let brokenLinksOnStart: BrokenLink[] = [];

const TABLE = "__drizzle_migrations";

/* Said plainly in the log, once, and again on the Audit screen's "Check the
   books". Not an alarm: no figure depends on these, and an update must never
   be blamed for what it did not do. */
function sayBrokenLinks(links: BrokenLink[]) {
  brokenLinksOnStart = links;
  if (links.length) {
    console.log(`[db] ${links.length} record(s) point at something that is no longer there (${describe(links)}). Nothing is blocked; the books check lists them.`);
  }
}

/**
 * With no update to apply, nothing at start-up can break a link, so the check
 * (a pass over every table) is only for the log: runMigrations leaves it to
 * this, which the server calls once it is answering. Never throws.
 */
export function reportBrokenLinks() {
  try { sayBrokenLinks(brokenLinks()); } catch { /* closing, or the books check says it */ }
}

const journalThere = () => fs.existsSync(path.join(FOLDER, "meta", "_journal.json"));
/** This version's updates, how many these books already have, and the ones still to apply (as drizzle picks them: newer than the newest recorded). Reads only. */
function updatesState() {
  const migrations = readMigrationFiles({ migrationsFolder: FOLDER });
  const has = (sqlite.prepare("select count(*) as n from sqlite_master where type = 'table' and name = ?").get(TABLE) as { n: number }).n > 0;
  const applied = has ? (sqlite.prepare(`select count(*) as n from "${TABLE}"`).get() as { n: number }).n : 0;
  const last = has ? sqlite.prepare(`select created_at from "${TABLE}" order by created_at desc limit 1`).pluck().get() as number | string | undefined : undefined;
  const pending = migrations.filter((m) => last === undefined || Number(last) < m.folderMillis);
  return { migrations, applied, pending };
}

/** An update is about to change these books' tables: runMigrations() will want a copy first. Reads only. */
export function updateNeeded(): boolean {
  if (!journalThere()) return false;
  const { applied, pending } = updatesState();
  return applied > 0 && pending.length > 0;
}

/*
 * The update is applied as drizzle applies it (the same table, hashes and
 * order), but checked BEFORE it is committed: a new broken link between
 * records, or rows lost in any table, rolls the whole update back, and so does
 * any SQL error in it. The books file is never swapped or copied over, so a
 * failed update leaves it exactly as it was, and a cut at any moment leaves
 * the old books or the updated ones.
 * `copyMade` is the copy already made for this update (backupBeforeUpdateAside,
 * on a thread of its own at the app's start, made or not); without it the copy
 * is made here. Either way a copy that could not be made never stops the update.
 * Returns true when nothing needed applying, in which case the dangling-link
 * note is left to reportBrokenLinks() (a pass over every table, not worth
 * holding up the start for).
 */
export function runMigrations(copyMade?: CopyBeforeUpdate | null): boolean {
  if (!journalThere()) {
    console.warn("[db] no migrations found — run: npx drizzle-kit generate");
    return false;
  }
  sqlite.exec(`CREATE TABLE IF NOT EXISTS "${TABLE}" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)`);
  const { migrations, applied, pending } = updatesState();
  const updating = applied > 0 && pending.length > 0;
  // an update about to change the tables: a copy first if one can be made (it never stops the app: the update is checked before it is kept)
  if (updating) {
    const b = copyMade ?? backupBeforeUpdate();
    if (b.file) console.log(`[db] backed up before update: ${path.basename(b.file)}${b.plain ? " (plain copy)" : ""}`);
    else console.warn(`[db] no copy before the update: ${b.problem}`);
  }

  // Keys are off for the update (a table rebuild — create new, copy, drop old —
  // would otherwise cascade-delete every row pointing at the old table) and
  // checked inside the same transaction instead.
  /* Links that were already broken before today — a row whose user was deleted,
     a mill removed years ago. They are not this update's doing, so they must
     never stop the app: they are reported and the books check names them.
     With nothing to apply nothing can break one, so the check (a pass over
     every table) waits for reportBrokenLinks() instead of holding up the start. */
  const wasBroken = pending.length ? brokenLinks() : [];
  if (pending.length) {
    const before = updating ? rowCounts() : null;
    sqlite.pragma("foreign_keys = OFF");
    try {
      sqlite.exec("BEGIN");
      try {
        for (const m of pending) {
          for (const stmt of m.sql) sqlite.prepare(stmt).run();
          sqlite.prepare(`INSERT INTO "${TABLE}" ("hash", "created_at") VALUES(?, ?)`).run(m.hash, m.folderMillis);
        }
        let problem: string | null = null;
        const broken = brokenLinks();
        const newly = broken.length - wasBroken.length;
        if (newly > 0) problem = `the update left ${newly} broken link(s) between records (${describe(broken)})`;
        if (!problem && before) {
          const after = rowCounts();
          const lost = Object.keys(before).filter((t) => t in after && after[t] < before[t] && !SHRINK_OK.has(t));
          if (lost.length) problem = `the update lost rows in ${lost.map((t) => `${t} (${before[t]} → ${after[t]})`).join(", ")}`;
        }
        if (problem) throw new Error(problem);
        sqlite.exec("COMMIT");
      } catch (e) {
        if (sqlite.inTransaction) sqlite.exec("ROLLBACK");
        throw e;
      }
    } catch (e) {
      throw updateFailed(e, applied);
    } finally {
      sqlite.pragma("foreign_keys = ON");
    }
  }
  try { rememberSchema(appVersion(), migrations.length); } catch { /* only an offer to go back */ }
  if (pending.length) sayBrokenLinks(wasBroken);
  console.log("[db] migrations up to date");
  return pending.length === 0;
}

/** One plain sentence for the start-up screen; the cause goes to the log. */
function updateFailed(e: unknown, applied: number): MigrationError {
  const diskFull = isDiskFull(e);
  console.error("[db] the update was rolled back; the books are as they were. Cause:", e);
  // an update over books that were already in use: the version before can open them again
  let goBack: { version: string; file: string } | null = null;
  if (applied > 0) {
    try { rememberBadVersion(appVersion()); goBack = diskFull ? null : previousInstaller(applied); } catch { /* no way back offered */ }
  }
  const msg = diskFull
    ? "The disk is full, so the update could not open your books; they are as they were. Free some space and open the app again."
    : `This update could not open your books; they are as they were. ${goBack ? `Go back to version ${goBack.version}, or send` : "Send"} this to support: ${e instanceof Error ? e.message : String(e)}`;
  return new MigrationError(msg, diskFull, goBack);
}

// pathToFileURL, not string concat — the data dir can contain spaces
// run directly (npm run db:push), not when bundled into the desktop server
if (process.argv[1]?.endsWith("migrate.ts") && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (runMigrations()) reportBrokenLinks();
}
