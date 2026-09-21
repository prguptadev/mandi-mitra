import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import pg from "pg";
import Database from "better-sqlite3";
import { sqlite, DB_PATH } from "../db/client.ts";
import { encryptSecret, decryptSecret } from "./secrets.ts";
import { backupNow } from "./backup.ts";

/* A copy of the data in a cloud Postgres (Supabase's free plan gives 500 MB).
 *
 * The computer stays the real database: the app works the same with no
 * internet. Every few minutes the rows that changed since the last push are
 * copied up — one JSON row per record in a single table, `mm_rows`, keyed by
 * table and id — and rows deleted here are marked deleted there. Scanned
 * images stay on the computer. "Restore from cloud" rebuilds this computer's
 * data from the copy (a new PC, a dead disk).
 *
 * The connection string (it holds the database password) is encrypted with
 * this computer's key and never shown back. What was last pushed is tracked
 * in a small separate file (cloud-state.db), so a push sends only changes.
 */

const DATA_DIR = path.dirname(DB_PATH);
const CFG_PATH = path.join(DATA_DIR, "cloud.json");
const STATE_PATH = path.join(DATA_DIR, "cloud-state.db");
export const FREE_BYTES = 500 * 1024 * 1024;

/** Never leave this computer: logins, the change queue, the migration log. */
const SKIP_TABLES = new Set(["sessions", "sync_outbox", "__drizzle_migrations"]);
/** Large and only for debugging: the model's raw reply. */
const DROP_COLUMNS: Record<string, string[]> = { scan_batches: ["raw_response"] };
/** Stays here even encrypted. */
const skipRow = (tbl: string, row: Record<string, unknown>) => tbl === "settings" && row.key === "gemini.apiKey";

export interface CloudConfig {
  enc: string | null; host: string | null;
  lastSyncAt: string | null; lastError: string | null; pushedLast: number; rowsInCloud: number | null; sizeBytes: number | null;
}
const EMPTY: CloudConfig = { enc: null, host: null, lastSyncAt: null, lastError: null, pushedLast: 0, rowsInCloud: null, sizeBytes: null };

export function readCloudConfig(): CloudConfig {
  try { return { ...EMPTY, ...JSON.parse(fs.readFileSync(CFG_PATH, "utf8")) }; } catch { return { ...EMPTY }; }
}
function writeCloudConfig(c: CloudConfig) { fs.writeFileSync(CFG_PATH, JSON.stringify(c, null, 2)); }

/** "db.abcd.supabase.co / postgres" — never the password. */
export function describeConnection(conn: string): string {
  const u = new URL(conn);
  return `${u.hostname}${u.port ? `:${u.port}` : ""}/${u.pathname.replace(/^\//, "") || "postgres"}`;
}

function pool(conn: string) {
  const u = new URL(conn);
  const local = ["127.0.0.1", "localhost", "::1"].includes(u.hostname);
  // Supabase requires TLS; its pooler certificate is not in Node's store, so the
  // link is encrypted without pinning the certificate
  return new pg.Pool({
    connectionString: conn, max: 1, connectionTimeoutMillis: 20_000, idleTimeoutMillis: 5_000,
    ssl: local ? false : { rejectUnauthorized: false },
  });
}

const DDL = `
create table if not exists mm_rows (
  tbl text not null,
  row_id text not null,
  business_id text,
  data jsonb not null,
  deleted boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (tbl, row_id)
);
create index if not exists mm_rows_business on mm_rows (business_id, tbl);
create table if not exists mm_meta (key text primary key, value jsonb not null, updated_at timestamptz not null default now());
`;

function explain(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (/password authentication failed/i.test(m)) return "The cloud database refused the password. Copy the connection string again from Supabase and put your database password in it.";
  if (/ENOTFOUND|getaddrinfo/i.test(m)) return "The cloud database's address was not found. Check the internet connection and the connection string.";
  if (/ECONNREFUSED|ETIMEDOUT|timeout/i.test(m)) return "Could not reach the cloud database (no internet, or it is paused). The data is safe here; it will try again.";
  if (/Tenant or user not found/i.test(m)) return "Supabase did not recognise that user. Use the connection string exactly as Supabase shows it (the user looks like postgres.abcdxyz).";
  return m.slice(0, 300);
}

/** Checks the connection, creates the two tables, and saves it (encrypted). */
export async function connectCloud(conn: string) {
  let u: URL;
  try { u = new URL(conn); } catch { throw new Error("That is not a connection string. It starts with postgresql://"); }
  if (!/^postgres(ql)?:$/.test(u.protocol)) throw new Error("That is not a Postgres connection string. It starts with postgresql://");
  if (u.password.includes("[YOUR-PASSWORD]") || u.password === "") throw new Error("Put your database password in place of [YOUR-PASSWORD].");
  const p = pool(conn);
  try {
    await p.query(DDL);
  } catch (e) {
    throw new Error(explain(e));
  } finally {
    await p.end();
  }
  const c = readCloudConfig();
  writeCloudConfig({ ...c, enc: encryptSecret(conn), host: describeConnection(conn), lastError: null });
}

export function disconnectCloud() {
  writeCloudConfig({ ...readCloudConfig(), enc: null, host: null });
  fs.rmSync(STATE_PATH, { force: true });
}

let stateDb: Database.Database | null = null;
function state() {
  if (!stateDb) {
    stateDb = new Database(STATE_PATH);
    stateDb.exec("create table if not exists pushed (tbl text not null, row_id text not null, hash text not null, primary key (tbl, row_id)) without rowid");
  }
  return stateDb;
}

const localTables = () => (sqlite.prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%'").all() as { name: string }[])
  .map((t) => t.name).filter((t) => !SKIP_TABLES.has(t));

/** A row as it goes to the cloud, and its fingerprint. */
function prepare(tbl: string, row: Record<string, unknown>) {
  for (const c of DROP_COLUMNS[tbl] ?? []) row[c] = null;
  // Postgres text cannot hold a NUL character
  const json = JSON.stringify(row).replace(/\\u0000/g, "");
  return { json, hash: crypto.createHash("sha1").update(json).digest("hex") };
}

let running: Promise<{ pushed: number; deleted: number }> | null = null;

/** Pushes everything that changed since the last push. One at a time. */
export function syncNow() {
  if (!running) running = doSync().finally(() => { running = null; });
  return running;
}
export const cloudBusy = () => running !== null;

async function doSync() {
  const cfg = readCloudConfig();
  const conn = cfg.enc ? decryptSecret(cfg.enc) : null;
  if (!conn) throw new Error("The cloud copy is not set up");
  const p = pool(conn);
  let pushed = 0, deleted = 0;
  try {
    const client = await p.connect();
    try {
      await client.query(DDL);
      const st = state();
      for (const tbl of localTables()) {
        const known = new Map((st.prepare("select row_id, hash from pushed where tbl = ?").all(tbl) as { row_id: string; hash: string }[]).map((r) => [r.row_id, r.hash]));
        const seen = new Set<string>();
        const changed: { id: string; biz: string | null; json: string; hash: string }[] = [];
        for (const row of sqlite.prepare(`select * from "${tbl}"`).iterate() as Iterable<Record<string, unknown>>) {
          if (skipRow(tbl, row)) continue;
          const id = String(row.id);
          seen.add(id);
          const { json, hash } = prepare(tbl, row);
          if (known.get(id) !== hash) changed.push({ id, biz: (row.business_id as string | undefined) ?? null, json, hash });
        }
        for (let i = 0; i < changed.length; i += 200) {
          const batch = changed.slice(i, i + 200);
          const values: unknown[] = [];
          const tuples = batch.map((r, k) => {
            values.push(tbl, r.id, r.biz, r.json);
            return `($${k * 4 + 1}, $${k * 4 + 2}, $${k * 4 + 3}, $${k * 4 + 4}::jsonb, false, now())`;
          });
          await client.query(
            `insert into mm_rows (tbl, row_id, business_id, data, deleted, updated_at) values ${tuples.join(", ")}
             on conflict (tbl, row_id) do update set data = excluded.data, business_id = excluded.business_id, deleted = false, updated_at = now()`,
            values,
          );
          const put = st.prepare("insert or replace into pushed (tbl, row_id, hash) values (?, ?, ?)");
          st.transaction(() => { for (const r of batch) put.run(tbl, r.id, r.hash); })();
          pushed += batch.length;
        }
        const gone = [...known.keys()].filter((id) => !seen.has(id));
        for (let i = 0; i < gone.length; i += 500) {
          const batch = gone.slice(i, i + 500);
          await client.query("update mm_rows set deleted = true, updated_at = now() where tbl = $1 and row_id = any($2)", [tbl, batch]);
          const del = st.prepare("delete from pushed where tbl = ? and row_id = ?");
          st.transaction(() => { for (const id of batch) del.run(tbl, id); })();
          deleted += batch.length;
        }
      }
      const migrations = (sqlite.prepare("select count(*) as n from __drizzle_migrations").get() as { n: number }).n;
      await client.query(
        "insert into mm_meta (key, value, updated_at) values ('app', $1::jsonb, now()) on conflict (key) do update set value = excluded.value, updated_at = now()",
        [JSON.stringify({ migrations, device: os.hostname(), lastSync: new Date().toISOString() })],
      );
      const size = await client.query("select pg_total_relation_size('mm_rows') + pg_total_relation_size('mm_meta') as b, (select count(*) from mm_rows where not deleted) as n");
      writeCloudConfig({
        ...readCloudConfig(), lastSyncAt: new Date().toISOString(), lastError: null, pushedLast: pushed + deleted,
        sizeBytes: Number(size.rows[0].b), rowsInCloud: Number(size.rows[0].n),
      });
    } finally {
      client.release();
    }
  } catch (e) {
    writeCloudConfig({ ...readCloudConfig(), lastError: explain(e) });
    throw new Error(explain(e));
  } finally {
    await p.end();
  }
  return { pushed, deleted };
}

/**
 * Replaces this computer's data with the cloud copy. A backup is taken first.
 * Refused if the copy was made by a newer version of the app than this one.
 */
export async function restoreFromCloud() {
  const cfg = readCloudConfig();
  const conn = cfg.enc ? decryptSecret(cfg.enc) : null;
  if (!conn) throw new Error("The cloud copy is not set up");
  if (running) await running.catch(() => undefined);
  const p = pool(conn);
  const byTable = new Map<string, Record<string, unknown>[]>();
  try {
    const meta = await p.query("select value from mm_meta where key = 'app'");
    if (!meta.rows.length) throw new Error("The cloud copy is empty");
    const localMigrations = (sqlite.prepare("select count(*) as n from __drizzle_migrations").get() as { n: number }).n;
    if (Number(meta.rows[0].value.migrations) > localMigrations) {
      throw new Error("The cloud copy was made by a newer version of Mandi Mitra. Install the update first, then restore.");
    }
    // page through, so a large copy never has to fit in one reply
    let after: [string, string] = ["", ""];
    for (;;) {
      const r = await p.query(
        "select tbl, row_id, data from mm_rows where not deleted and (tbl, row_id) > ($1, $2) order by tbl, row_id limit 2000",
        after,
      );
      for (const x of r.rows) {
        if (!byTable.has(x.tbl)) byTable.set(x.tbl, []);
        byTable.get(x.tbl)!.push(x.data);
      }
      if (r.rows.length < 2000) break;
      after = [r.rows[r.rows.length - 1].tbl, r.rows[r.rows.length - 1].row_id];
    }
  } catch (e) {
    throw new Error(e instanceof Error && /cloud copy|newer version/.test(e.message) ? e.message : explain(e));
  } finally {
    await p.end();
  }

  const backup = await backupNow("manual");
  const tables = localTables();
  const counts: Record<string, number> = {};
  sqlite.pragma("foreign_keys = OFF");
  try {
    sqlite.transaction(() => {
      for (const tbl of tables) {
        const cols = new Set((sqlite.prepare(`select name from pragma_table_info('${tbl}')`).all() as { name: string }[]).map((c) => c.name));
        // this computer's Gemini key was never copied up, so it is kept
        if (tbl === "settings") sqlite.prepare("delete from settings where key <> 'gemini.apiKey'").run();
        else sqlite.prepare(`delete from "${tbl}"`).run();
        const cache = new Map<string, Database.Statement>();
        for (const row of byTable.get(tbl) ?? []) {
          if (tbl === "settings" && row.key === "gemini.apiKey") continue;
          const keys = Object.keys(row).filter((k) => cols.has(k));
          const sig = keys.join(",");
          if (!cache.has(sig)) cache.set(sig, sqlite.prepare(`insert or replace into "${tbl}" (${keys.map((k) => `"${k}"`).join(", ")}) values (${keys.map(() => "?").join(", ")})`));
          cache.get(sig)!.run(...keys.map((k) => row[k] as never));
          counts[tbl] = (counts[tbl] ?? 0) + 1;
        }
      }
      // everyone signs in again against the restored users
      sqlite.prepare("delete from sessions").run();
    })();
  } finally {
    sqlite.pragma("foreign_keys = ON");
  }
  const broken = (sqlite.prepare("pragma foreign_key_check").all() as unknown[]).length;

  // what is here now is exactly what is in the cloud: nothing to push next time
  const st = state();
  st.exec("delete from pushed");
  const put = st.prepare("insert into pushed (tbl, row_id, hash) values (?, ?, ?)");
  st.transaction(() => {
    for (const tbl of tables) {
      for (const row of sqlite.prepare(`select * from "${tbl}"`).iterate() as Iterable<Record<string, unknown>>) {
        if (skipRow(tbl, row)) continue;
        put.run(tbl, String(row.id), prepare(tbl, row).hash);
      }
    }
  })();
  return { counts, backup: backup.name, brokenLinks: broken };
}

let timer: NodeJS.Timeout | null = null;
/** Every 5 minutes, when set up, push what changed. Failures are kept for the Settings screen. */
export function startCloudSync() {
  if (timer || process.env.MANDI_NO_AUTO_BACKUP === "1") return;
  const tick = () => { if (readCloudConfig().enc) void syncNow().catch(() => undefined); };
  setTimeout(tick, 90_000).unref();
  timer = setInterval(tick, 5 * 60_000);
  timer.unref();
}
