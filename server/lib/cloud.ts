import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import pg from "pg";
import Database from "better-sqlite3";
import { sqlite, DB_PATH } from "../db/client.ts";
import { encryptSecret, decryptSecret } from "./secrets.ts";
import { backupNow } from "./backup.ts";
import { newId } from "./ids.ts";

/* Two-way sync of several computers through one cloud Postgres (Supabase).
 *
 * Every computer keeps its own full database and works the same with no
 * internet. In the background, every few seconds:
 *   pull — bring down every change other computers made since the last pull
 *   push — send up every record changed here since the last push
 *
 * Here, database triggers mark each changed record (`_sync_dirty`, with a
 * counter so an edit made while a push is in flight is never lost). In the
 * cloud, every record is one row of `mm_rows` (table, id, jsonb) with a
 * sequence number; pushes take a lock, so sequence numbers are handed out in
 * commit order and "everything after N" never skips a change.
 *
 * Clashes — the same record changed on two computers between syncs — are
 * settled by the record's own updated_at (the later edit wins); the losing
 * version is kept in a clashes list. An edit always beats a delete: nothing
 * edited is silently thrown away.
 *
 * A computer on an older app version than the cloud pauses (it could drop
 * fields it does not know) and says "update this computer".
 *
 * Images stay on the computer that scanned them. Logins, the Gemini key and
 * the model's raw replies never leave the computer.
 */

const DATA_DIR = path.dirname(DB_PATH);
const CFG_PATH = path.join(DATA_DIR, "cloud.json");
const STATE_PATH = path.join(DATA_DIR, "cloud-state.db");
export const FREE_BYTES = 500 * 1024 * 1024;
const LOCK = 424242;
/** The fingerprint of a deleted record. */
const DELETED = "deleted";

/** Never leave this computer. */
const SKIP_TABLES = new Set(["sessions", "sync_outbox", "__drizzle_migrations", "_sync_dirty"]);
/** Columns kept only where they were made (large, debug only). */
const LOCAL_COLUMNS: Record<string, string[]> = { scan_batches: ["raw_response"] };
const skipRow = (tbl: string, row: Record<string, unknown>) => tbl === "settings" && row.key === "gemini.apiKey";
/** Rows with nothing pointing at them: a unique clash is settled by taking the incoming row. */
const REPLACEABLE = new Set(["settings", "role_permissions", "adati_aliases", "user_permission_overrides", "gemini_calls"]);

export type SyncState = "off" | "ok" | "syncing" | "offline" | "paused" | "error";
export interface CloudConfig {
  enc: string | null; host: string | null;
  deviceId: string; deviceName: string;
  /** Sync is running (not only connected). */
  live: boolean;
  cursor: number;
  lastSyncAt: string | null; lastError: string | null; pausedReason: string | null;
  pushedLast: number; pulledLast: number;
  rowsInCloud: number | null; sizeBytes: number | null;
  /** Grows whenever changes from other computers are applied: screens refresh on it. */
  changeCounter: number;
  /** Set up by v0.2's one-way cloud copy: the first sync takes the cloud as already seen. */
  fromCopy?: boolean;
}

export function readCloudConfig(): CloudConfig {
  let c: Partial<CloudConfig> = {};
  try { c = JSON.parse(fs.readFileSync(CFG_PATH, "utf8")); } catch { /* first run */ }
  const out: CloudConfig = {
    enc: c.enc ?? null, host: c.host ?? null,
    deviceId: c.deviceId ?? newId(), deviceName: c.deviceName ?? os.hostname(),
    live: c.live ?? Boolean(c.enc), cursor: c.cursor ?? 0,
    lastSyncAt: c.lastSyncAt ?? null, lastError: c.lastError ?? null, pausedReason: c.pausedReason ?? null,
    pushedLast: c.pushedLast ?? 0, pulledLast: c.pulledLast ?? 0,
    rowsInCloud: c.rowsInCloud ?? null, sizeBytes: c.sizeBytes ?? null, changeCounter: c.changeCounter ?? 0,
    // v0.2 wrote no "live": its cloud holds only this computer's own copy
    fromCopy: c.fromCopy ?? (Boolean(c.enc) && c.live === undefined),
  };
  if (!c.deviceId) writeCloudConfig(out);
  return out;
}
function writeCloudConfig(c: CloudConfig) { fs.writeFileSync(CFG_PATH, JSON.stringify(c, null, 2)); }
function patchConfig(p: Partial<CloudConfig>) { const c = { ...readCloudConfig(), ...p }; writeCloudConfig(c); return c; }

/** "db.abcd.supabase.co:6543/postgres" — never the password. */
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
    connectionString: conn, max: 1, connectionTimeoutMillis: 15_000, idleTimeoutMillis: 2_000,
    ssl: local ? false : { rejectUnauthorized: false },
  });
}

const DDL = `
create sequence if not exists mm_seq;
create table if not exists mm_rows (
  tbl text not null, row_id text not null, business_id text, data jsonb not null,
  deleted boolean not null default false, updated_at timestamptz not null default now(),
  primary key (tbl, row_id)
);
alter table mm_rows add column if not exists seq bigint;
alter table mm_rows add column if not exists device text;
alter table mm_rows add column if not exists hash text;
update mm_rows set seq = nextval('mm_seq') where seq is null;
create index if not exists mm_rows_seq on mm_rows (seq);
create index if not exists mm_rows_business on mm_rows (business_id, tbl);
create table if not exists mm_meta (key text primary key, value jsonb not null, updated_at timestamptz not null default now());
create table if not exists mm_claims (
  business_id text not null, kind text not null, value text not null, load_id text, device text,
  at timestamptz not null default now(), primary key (business_id, kind, value)
);
create table if not exists mm_devices (id text primary key, name text, version text, schema int, last_seen timestamptz);
`;
const prepared = new Set<string>();
async function ensureCloud(client: pg.PoolClient, conn: string) {
  if (prepared.has(conn)) return;
  await client.query(DDL);
  prepared.add(conn);
}

export class CloudError extends Error {
  constructor(message: string, public offline = false) { super(message); }
}
function explain(e: unknown): CloudError {
  if (e instanceof CloudError) return e;
  const m = e instanceof Error ? e.message : String(e);
  if (/password authentication failed/i.test(m)) return new CloudError("The cloud database refused the password. Copy the connection string again from Supabase and put your database password in it.");
  if (/Tenant or user not found/i.test(m)) return new CloudError("Supabase did not recognise that user. Use the connection string exactly as Supabase shows it (the user looks like postgres.abcdxyz).");
  if (/ENOTFOUND|getaddrinfo|ECONNREFUSED|ETIMEDOUT|ECONNRESET|EHOSTUNREACH|ENETUNREACH|timeout|Connection terminated/i.test(m)) {
    return new CloudError("No connection to the cloud (internet off, or the Supabase project is paused). Work goes on here and catches up by itself.", true);
  }
  return new CloudError(m.slice(0, 300));
}

/* ------------------------------------------------------------ local side */

let stateDb: Database.Database | null = null;
function state() {
  if (!stateDb) {
    stateDb = new Database(STATE_PATH);
    stateDb.exec(`
      create table if not exists pushed (tbl text not null, row_id text not null, hash text not null, primary key (tbl, row_id)) without rowid;
      create table if not exists clashes (id integer primary key, at text not null, tbl text not null, row_id text not null,
        kept text not null, other_device text, lost text not null, note text);
      create table if not exists retry (tbl text not null, row_id text not null, primary key (tbl, row_id)) without rowid;
    `);
  }
  return stateDb;
}

export const syncedTables = () => (sqlite.prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%'").all() as { name: string }[])
  .map((t) => t.name).filter((t) => !SKIP_TABLES.has(t) && !t.startsWith("_"));
const columnsOf = (tbl: string) => new Set((sqlite.prepare(`select name from pragma_table_info('${tbl}')`).all() as { name: string }[]).map((c) => c.name));
const localSchema = () => (sqlite.prepare("select count(*) as n from __drizzle_migrations").get() as { n: number }).n;
export function appVersion() {
  try { return process.env.MANDI_APP_VERSION ?? JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf8")).version; } catch { return "?"; }
}

/** Triggers that mark every changed record for the next push. Idempotent. */
export function installTriggers() {
  sqlite.exec("create table if not exists _sync_dirty (tbl text not null, row_id text not null, n integer not null default 1, primary key (tbl, row_id)) without rowid");
  for (const t of syncedTables()) {
    const mark = (ref: string) => `insert into _sync_dirty (tbl, row_id, n) values ('${t}', ${ref}.id, 1) on conflict (tbl, row_id) do update set n = n + 1;`;
    sqlite.exec(`
      create trigger if not exists _sync_ai_${t} after insert on "${t}" begin ${mark("new")} end;
      create trigger if not exists _sync_au_${t} after update on "${t}" begin ${mark("new")} end;
      create trigger if not exists _sync_ad_${t} after delete on "${t}" begin ${mark("old")} end;
    `);
  }
}
function dropTriggers() {
  for (const r of sqlite.prepare("select name from sqlite_master where type = 'trigger' and name like '\\_sync\\_%' escape '\\'").all() as { name: string }[]) {
    sqlite.exec(`drop trigger if exists "${r.name}"`);
  }
  sqlite.exec("drop table if exists _sync_dirty");
}
/** Everything here counts as changed: the first push sends it all. */
function markAll() {
  installTriggers();
  const ins = sqlite.prepare("insert into _sync_dirty (tbl, row_id, n) values (?, ?, 1) on conflict (tbl, row_id) do update set n = n + 1");
  sqlite.transaction(() => {
    // read each table fully first: better-sqlite3 cannot write while a read is still open
    for (const t of syncedTables()) for (const id of sqlite.prepare(`select id from "${t}"`).pluck().all() as string[]) ins.run(t, String(id));
  })();
}

/** A record as it travels: local-only columns out, fingerprinted. */
function wire(tbl: string, row: Record<string, unknown>) {
  const out: Record<string, unknown> = { ...row };
  for (const c of LOCAL_COLUMNS[tbl] ?? []) delete out[c];
  const json = JSON.stringify(out).replace(/\\u0000/g, "");
  return { json, data: out, hash: crypto.createHash("sha1").update(json).digest("hex") };
}

/* ------------------------------------------------------------ connect / join */

/** Checks the string, the connection and the cloud tables; says whether the cloud already has data. */
export async function inspectCloud(conn: string) {
  let u: URL;
  try { u = new URL(conn); } catch { throw new CloudError("That is not a connection string. It starts with postgresql://"); }
  if (!/^postgres(ql)?:$/.test(u.protocol)) throw new CloudError("That is not a Postgres connection string. It starts with postgresql://");
  if (u.password.includes("[YOUR-PASSWORD]") || u.password === "") throw new CloudError("Put your database password in place of [YOUR-PASSWORD].");
  const p = pool(conn);
  try {
    const client = await p.connect();
    try {
      await ensureCloud(client, conn);
      const rows = await client.query("select count(*)::int as n from mm_rows where not deleted");
      const devs = await client.query("select id, name, version, last_seen from mm_devices order by last_seen desc nulls last");
      return { rows: rows.rows[0].n as number, devices: devs.rows as { id: string; name: string; version: string; last_seen: string }[] };
    } finally { client.release(); }
  } catch (e) { throw explain(e); } finally { await p.end(); }
}

/**
 * Connects this computer. An empty cloud is started from this computer's
 * data; a cloud that already holds data must be joined (see joinCloud),
 * unless it is this same computer coming back.
 */
export async function connectCloud(conn: string): Promise<{ started?: boolean; resumed?: boolean; needsJoin?: { rows: number; devices: string[] } }> {
  const info = await inspectCloud(conn);
  const me = readCloudConfig();
  const others = info.devices.filter((d) => d.id !== me.deviceId);
  if (info.rows > 0 && info.devices.some((d) => d.id === me.deviceId) && me.cursor > 0) {
    installTriggers();
    patchConfig({ enc: encryptSecret(conn), host: describeConnection(conn), live: true, lastError: null, pausedReason: null });
    return { resumed: true };
  }
  if (info.rows > 0) return { needsJoin: { rows: info.rows, devices: others.map((d) => d.name || d.id) } };
  state().exec("delete from pushed");
  markAll();
  patchConfig({ enc: encryptSecret(conn), host: describeConnection(conn), live: true, cursor: 0, lastError: null, pausedReason: null });
  await backfillClaims(conn);
  return { started: true };
}

/** Joins a cloud that other computers already use: this computer's data is replaced by the cloud's. */
export async function joinCloud(conn: string) {
  await inspectCloud(conn);
  patchConfig({ enc: encryptSecret(conn), host: describeConnection(conn), live: false });
  const r = await restoreFromCloud();
  patchConfig({ live: true, lastError: null, pausedReason: null });
  return r;
}

export function disconnectCloud() {
  dropTriggers();
  patchConfig({ enc: null, host: null, live: false, cursor: 0, pausedReason: null, lastError: null });
  try { state().exec("delete from pushed; delete from retry;"); } catch { /* ignore */ }
}

/** Parcha numbers approved before sync began are claimed, so no other computer reuses them. */
async function backfillClaims(conn: string) {
  const rows = sqlite.prepare("select business_id, parcha_no, load_id from parchas").all() as { business_id: string; parcha_no: string; load_id: string }[];
  if (!rows.length) return;
  const p = pool(conn);
  try {
    for (const r of rows) {
      await p.query("insert into mm_claims (business_id, kind, value, load_id, device) values ($1, 'parcha', $2, $3, $4) on conflict do nothing",
        [r.business_id, r.parcha_no, r.load_id, readCloudConfig().deviceId]);
    }
  } catch (e) { throw explain(e); } finally { await p.end(); }
}

/* ------------------------------------------------------------ sync */

let running: Promise<SyncResult> | null = null;
export interface SyncResult { pushed: number; pulled: number; clashes: number; paused?: string }
export const cloudBusy = () => running !== null;
export const syncEnabled = () => { const c = readCloudConfig(); return Boolean(c.enc && c.live); };

/** One pull + push. One at a time; a second call waits for the running one. */
export function syncNow(): Promise<SyncResult> {
  if (!running) running = doSync().finally(() => { running = null; });
  return running;
}

async function doSync(): Promise<SyncResult> {
  const cfg = readCloudConfig();
  const conn = cfg.enc ? decryptSecret(cfg.enc) : null;
  if (!conn || !cfg.live) throw new CloudError("Cloud sync is not set up");
  installTriggers();
  const p = pool(conn);
  try {
    const client = await p.connect();
    try {
      await ensureCloud(client, conn);
      // an older app must not touch data a newer one has shaped
      const mine = localSchema();
      const meta = await client.query("select value from mm_meta where key = 'schema'");
      const cloudSchema = meta.rows[0] ? Number(meta.rows[0].value.migrations) : 0;
      if (cloudSchema > mine) {
        const v = meta.rows[0].value.version ?? "the newest";
        const reason = `Another computer runs a newer Mandi Mitra (${v}). Update this computer to keep syncing — its work is kept here meanwhile.`;
        patchConfig({ pausedReason: reason, lastError: null });
        return { pushed: 0, pulled: 0, clashes: 0, paused: reason };
      }
      if (cloudSchema < mine) {
        await client.query("insert into mm_meta (key, value, updated_at) values ('schema', $1::jsonb, now()) on conflict (key) do update set value = excluded.value, updated_at = now()",
          [JSON.stringify({ migrations: mine, version: appVersion() })]);
      }
      if (cfg.fromCopy) {
        // everything up there came from here: skip pulling it back, and send whatever changed since
        const top = Number((await client.query("select coalesce(max(seq), 0) as s from mm_rows")).rows[0].s);
        markAll();
        Object.assign(cfg, patchConfig({ cursor: top, fromCopy: false }));
      }
      const pulled = await pull(client, cfg);
      let pushed = await push(client, cfg);
      if (pushed.waiting) {
        // another computer changed some of the same records a moment ago: take their
        // version in (the later edit wins), then send ours
        const again = await pull(client, readCloudConfig());
        pulled.applied += again.applied; pulled.clashes += again.clashes;
        const p2 = await push(client, readCloudConfig());
        pushed = { sent: pushed.sent + p2.sent, waiting: p2.waiting };
      }
      await client.query("insert into mm_devices (id, name, version, schema, last_seen) values ($1, $2, $3, $4, now()) on conflict (id) do update set name = excluded.name, version = excluded.version, schema = excluded.schema, last_seen = now()",
        [cfg.deviceId, cfg.deviceName, appVersion(), mine]);
      const size = await client.query("select pg_total_relation_size('mm_rows') + pg_total_relation_size('mm_meta') + pg_total_relation_size('mm_claims') as b, (select count(*) from mm_rows where not deleted) as n");
      patchConfig({
        lastSyncAt: new Date().toISOString(), lastError: null, pausedReason: null,
        pushedLast: pushed.sent, pulledLast: pulled.applied, sizeBytes: Number(size.rows[0].b), rowsInCloud: Number(size.rows[0].n),
      });
      return { pushed: pushed.sent, pulled: pulled.applied, clashes: pulled.clashes };
    } finally { client.release(); }
  } catch (e) {
    const err = explain(e);
    patchConfig({ lastError: err.message });
    throw err;
  } finally {
    await p.end();
  }
}

/**
 * Sends every record marked changed. Under the lock, so sequence numbers follow
 * commit order. `pushed` holds, per record, the cloud version this computer last
 * saw; a record another computer changed since then is not overwritten — it
 * waits for the next pull, which settles the clash (the later edit wins).
 */
async function push(client: pg.PoolClient, cfg: CloudConfig): Promise<{ sent: number; waiting: number }> {
  const marks = sqlite.prepare("select tbl, row_id, n from _sync_dirty").all() as { tbl: string; row_id: string; n: number }[];
  if (!marks.length) return { sent: 0, waiting: 0 };
  const st = state();
  const known = st.prepare("select hash from pushed where tbl = ? and row_id = ?");
  const tables = new Set(syncedTables());
  type Out = { tbl: string; id: string; biz: string | null; json: string; hash: string; deleted: boolean; n: number };
  const out: Out[] = [];
  const clearOnly: { tbl: string; id: string; n: number }[] = [];
  for (const m of marks) {
    if (!tables.has(m.tbl)) { clearOnly.push({ tbl: m.tbl, id: m.row_id, n: m.n }); continue; }
    const row = sqlite.prepare(`select * from "${m.tbl}" where id = ?`).get(m.row_id) as Record<string, unknown> | undefined;
    const last = (known.get(m.tbl, m.row_id) as { hash: string } | undefined)?.hash;
    if (!row) {
      // deleted here: tell the others, unless the cloud never had it
      if (last && last !== DELETED) out.push({ tbl: m.tbl, id: m.row_id, biz: null, json: "{}", hash: "deleted", deleted: true, n: m.n });
      else clearOnly.push({ tbl: m.tbl, id: m.row_id, n: m.n });
      continue;
    }
    if (skipRow(m.tbl, row)) { clearOnly.push({ tbl: m.tbl, id: m.row_id, n: m.n }); continue; }
    const w = wire(m.tbl, row);
    if (w.hash === last) { clearOnly.push({ tbl: m.tbl, id: m.row_id, n: m.n }); continue; }
    out.push({ tbl: m.tbl, id: m.row_id, biz: (row.business_id as string | undefined) ?? null, json: w.json, hash: w.hash, deleted: false, n: m.n });
  }

  let sent: Out[] = [];
  let waiting = 0;
  if (out.length) {
    await client.query("begin");
    try {
      await client.query("select pg_advisory_xact_lock($1)", [LOCK]);
      // what the cloud holds now for these records
      const theirs = new Map<string, { hash: string | null; device: string | null }>();
      for (let i = 0; i < out.length; i += 500) {
        const batch = out.slice(i, i + 500);
        const r = await client.query(
          "select tbl, row_id, hash, device from mm_rows where (tbl, row_id) in (select * from unnest($1::text[], $2::text[]))",
          [batch.map((x) => x.tbl), batch.map((x) => x.id)]);
        for (const x of r.rows) theirs.set(`${x.tbl}\u0001${x.row_id}`, { hash: x.hash, device: x.device });
      }
      sent = out.filter((r) => {
        const c = theirs.get(`${r.tbl}\u0001${r.id}`);
        const seen = (known.get(r.tbl, r.id) as { hash: string } | undefined)?.hash ?? null;
        // unseen: another computer's version this one has not pulled yet (v0.2 rows carry no hash)
        const unseen = c && c.hash !== null && c.device !== cfg.deviceId && c.hash !== seen;
        if (unseen) waiting++;
        return !unseen;
      });
      for (let i = 0; i < sent.length; i += 200) {
        const batch = sent.slice(i, i + 200);
        const values: unknown[] = [];
        const tuples = batch.map((r, k) => {
          values.push(r.tbl, r.id, r.biz, r.json, r.deleted, r.hash, cfg.deviceId);
          const b = k * 7;
          return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}::jsonb, $${b + 5}, $${b + 6}, $${b + 7}, nextval('mm_seq'), now())`;
        });
        // a delete keeps the last known data in the cloud (deleted = true)
        await client.query(
          `insert into mm_rows (tbl, row_id, business_id, data, deleted, hash, device, seq, updated_at) values ${tuples.join(", ")}
           on conflict (tbl, row_id) do update set
             data = case when excluded.deleted then mm_rows.data else excluded.data end,
             business_id = coalesce(excluded.business_id, mm_rows.business_id),
             deleted = excluded.deleted, hash = excluded.hash, device = excluded.device, seq = excluded.seq, updated_at = now()`,
          values,
        );
      }
      await client.query("commit");
    } catch (e) {
      await client.query("rollback").catch(() => undefined);
      throw e;
    }
  }
  // clear only marks that did not move while we were away (an edit meanwhile keeps its mark)
  const clear = sqlite.prepare("delete from _sync_dirty where tbl = ? and row_id = ? and n = ?");
  const putHash = st.prepare("insert or replace into pushed (tbl, row_id, hash) values (?, ?, ?)");
  sqlite.transaction(() => {
    for (const r of sent) clear.run(r.tbl, r.id, r.n);
    for (const r of clearOnly) clear.run(r.tbl, r.id, r.n);
  })();
  st.transaction(() => { for (const r of sent) putHash.run(r.tbl, r.id, r.deleted ? DELETED : r.hash); })();
  return { sent: sent.length, waiting };
}

/** Brings down every change since the cursor, applying what other computers made. */
async function pull(client: pg.PoolClient, cfg: CloudConfig) {
  let cursor = cfg.cursor;
  let applied = 0, clashes = 0;
  // records that could not be applied before (e.g. the same mill code made on two
  // computers): tried again every sync, so they arrive once the clash is fixed
  const again = state().prepare("select tbl, row_id from retry").all() as { tbl: string; row_id: string }[];
  if (again.length) {
    const r = await client.query(
      "select tbl, row_id, data, deleted, hash, device, seq from mm_rows where (tbl, row_id) in (select * from unnest($1::text[], $2::text[])) and seq <= $3 order by seq",
      [again.map((x) => x.tbl), again.map((x) => x.row_id), cursor]);
    const res = applyRemote(r.rows, cfg.deviceId, true);
    applied += res.applied;
    const found = new Set(r.rows.map((x) => `${x.tbl}\u0001${x.row_id}`));
    const del = state().prepare("delete from retry where tbl = ? and row_id = ?");
    for (const x of again) if (!found.has(`${x.tbl}\u0001${x.row_id}`)) del.run(x.tbl, x.row_id);
    if (res.applied) patchConfig({ changeCounter: readCloudConfig().changeCounter + res.applied });
  }
  for (;;) {
    const r = await client.query(
      "select tbl, row_id, data, deleted, hash, device, seq from mm_rows where seq > $1 order by seq limit 1000", [cursor]);
    if (!r.rows.length) break;
    const res = applyRemote(r.rows, cfg.deviceId);
    applied += res.applied; clashes += res.clashes;
    cursor = Number(r.rows[r.rows.length - 1].seq);
    patchConfig({ cursor, ...(res.applied ? { changeCounter: readCloudConfig().changeCounter + res.applied } : {}) });
    if (r.rows.length < 1000) break;
  }
  return { applied, clashes };
}

type RemoteRow = { tbl: string; row_id: string; data: Record<string, unknown>; deleted: boolean; hash: string | null; device: string | null; seq: string };

function applyRemote(rows: RemoteRow[], me: string, retrying = false) {
  const st = state();
  const tables = new Set(syncedTables());
  const cols = new Map<string, Set<string>>();
  const getCols = (t: string) => { if (!cols.has(t)) cols.set(t, columnsOf(t)); return cols.get(t)!; };
  const dirty = sqlite.prepare("select n from _sync_dirty where tbl = ? and row_id = ?");
  const unmark = sqlite.prepare("delete from _sync_dirty where tbl = ? and row_id = ?");
  const putHash = st.prepare("insert or replace into pushed (tbl, row_id, hash) values (?, ?, ?)");
  const clash = st.prepare("insert into clashes (at, tbl, row_id, kept, other_device, lost, note) values (?, ?, ?, ?, ?, ?, ?)");
  const toRetry = st.prepare("insert or ignore into retry (tbl, row_id) values (?, ?)");
  const retried = st.prepare("delete from retry where tbl = ? and row_id = ?");
  let applied = 0, clashes = 0;
  const hashes: { tbl: string; id: string; hash: string }[] = [];
  // v0.2's copy stored no fingerprint: work it out
  const seenHash = (r: RemoteRow) => r.deleted ? DELETED : r.hash ?? wire(r.tbl, r.data).hash;

  sqlite.pragma("foreign_keys = OFF");
  try {
    sqlite.transaction(() => {
      for (const r of rows) {
        if (r.device === me) continue; // our own change coming back
        if (!tables.has(r.tbl)) continue;
        const local = sqlite.prepare(`select * from "${r.tbl}" where id = ?`).get(r.row_id) as Record<string, unknown> | undefined;
        const pending = dirty.get(r.tbl, r.row_id) as { n: number } | undefined;
        const now = new Date().toISOString();

        if (pending) {
          // changed here too since the last sync
          const mine = local ? wire(r.tbl, local) : null;
          if (mine && !r.deleted && mine.hash === r.hash) { unmark.run(r.tbl, r.row_id); hashes.push({ tbl: r.tbl, id: r.row_id, hash: r.hash }); continue; }
          if (!local && r.deleted) { unmark.run(r.tbl, r.row_id); hashes.push({ tbl: r.tbl, id: r.row_id, hash: DELETED }); continue; }
          let remoteWins: boolean;
          let note: string;
          if (r.deleted) { remoteWins = false; note = "deleted on another computer, but changed here — the change is kept"; }
          else if (!local) { remoteWins = true; note = "deleted here, but changed on another computer — the change is kept"; }
          else {
            const lu = Number(local.updated_at ?? 0), ru = Number(r.data.updated_at ?? 0);
            remoteWins = ru > lu;
            note = remoteWins ? "changed on both computers — the later change (the other computer's) is kept" : "changed on both computers — the later change (this computer's) is kept";
          }
          clash.run(now, r.tbl, r.row_id, remoteWins ? "theirs" : "mine", r.device,
            JSON.stringify(remoteWins ? (local ?? null) : (r.deleted ? { deleted: true } : r.data)), note);
          clashes++;
          // ours goes up on the next push and wins there too: this version counts as seen
          if (!remoteWins) { hashes.push({ tbl: r.tbl, id: r.row_id, hash: seenHash(r) }); continue; }
          unmark.run(r.tbl, r.row_id);
        }

        if (r.deleted) {
          if (local) { sqlite.prepare(`delete from "${r.tbl}" where id = ?`).run(r.row_id); applied++; }
          unmark.run(r.tbl, r.row_id);
          retried.run(r.tbl, r.row_id);
          hashes.push({ tbl: r.tbl, id: r.row_id, hash: DELETED });
          continue;
        }
        const c = getCols(r.tbl);
        const keys = Object.keys(r.data).filter((k) => c.has(k));
        if (!keys.includes("id")) continue;
        const vals = keys.map((k) => r.data[k] as never);
        const sets = keys.filter((k) => k !== "id").map((k) => `"${k}" = excluded."${k}"`).join(", ");
        const sqlUpsert = `insert into "${r.tbl}" (${keys.map((k) => `"${k}"`).join(", ")}) values (${keys.map(() => "?").join(", ")})
          on conflict (id) do update set ${sets || `"id" = excluded."id"`}`;
        try {
          sqlite.prepare(sqlUpsert).run(...vals);
        } catch (e) {
          const msg = String((e as Error).message);
          if (/UNIQUE/i.test(msg) && REPLACEABLE.has(r.tbl)) {
            sqlite.prepare(`insert or replace into "${r.tbl}" (${keys.map((k) => `"${k}"`).join(", ")}) values (${keys.map(() => "?").join(", ")})`).run(...vals);
          } else {
            // e.g. the same mill code made on two computers: this one's is kept and the
            // other's is listed for the owner, then tried again every sync (it arrives
            // once one of them is renamed). One bad record never stops the sync.
            toRetry.run(r.tbl, r.row_id);
            if (!retrying) {
              clash.run(now, r.tbl, r.row_id, "mine", r.device, JSON.stringify(r.data),
                /UNIQUE/i.test(msg) ? "the same code or number was made on two computers — this computer's record is kept; rename one of them and the other arrives by itself"
                  : `could not be applied here (${msg.slice(0, 120)})`);
              clashes++;
            }
            continue;
          }
        }
        unmark.run(r.tbl, r.row_id);
        retried.run(r.tbl, r.row_id);
        hashes.push({ tbl: r.tbl, id: r.row_id, hash: seenHash(r) });
        applied++;
      }
      // the deletes above may have removed rows others point at: the triggers marked
      // nothing of ours (unmark), and foreign keys are checked again below
    })();
  } finally {
    sqlite.pragma("foreign_keys = ON");
  }
  st.transaction(() => { for (const h of hashes) putHash.run(h.tbl, h.id, h.hash); })();
  return { applied, clashes };
}

/* ------------------------------------------------------------ restore / join */

/**
 * Replaces this computer's data with the cloud's (joining, or a new PC).
 * A backup is taken first. Refused if the cloud was shaped by a newer app.
 */
export async function restoreFromCloud() {
  const cfg = readCloudConfig();
  const conn = cfg.enc ? decryptSecret(cfg.enc) : null;
  if (!conn) throw new CloudError("Cloud sync is not set up");
  if (running) await running.catch(() => undefined);
  const p = pool(conn);
  const byTable = new Map<string, { data: Record<string, unknown>; hash: string }[]>();
  let top = 0;
  try {
    const client = await p.connect();
    try {
      await ensureCloud(client, conn);
      const meta = await client.query("select value from mm_meta where key = 'schema'");
      if (meta.rows[0] && Number(meta.rows[0].value.migrations) > localSchema()) {
        throw new CloudError(`The cloud was set up by a newer Mandi Mitra (${meta.rows[0].value.version ?? "newer"}). Install that version on this computer first.`);
      }
      // the snapshot point: anything changed after it arrives by the normal pull
      top = Number((await client.query("select coalesce(max(seq), 0) as s from mm_rows")).rows[0].s);
      let after: [string, string] = ["", ""];
      for (;;) {
        const r = await client.query(
          "select tbl, row_id, data, hash from mm_rows where not deleted and (tbl, row_id) > ($1, $2) order by tbl, row_id limit 2000", after);
        for (const x of r.rows) {
          if (!byTable.has(x.tbl)) byTable.set(x.tbl, []);
          byTable.get(x.tbl)!.push({ data: x.data, hash: x.hash });
        }
        if (r.rows.length < 2000) break;
        after = [r.rows[r.rows.length - 1].tbl, r.rows[r.rows.length - 1].row_id];
      }
    } finally { client.release(); }
  } catch (e) { throw explain(e); } finally { await p.end(); }
  if (!byTable.size) throw new CloudError("The cloud is empty — there is nothing to bring down.");

  const backup = await backupNow("manual");
  installTriggers();
  const tables = syncedTables();
  const counts: Record<string, number> = {};
  sqlite.pragma("foreign_keys = OFF");
  try {
    sqlite.transaction(() => {
      for (const tbl of tables) {
        const cols = columnsOf(tbl);
        // this computer's Gemini key never went up, so it is kept
        if (tbl === "settings") sqlite.prepare("delete from settings where key <> 'gemini.apiKey'").run();
        else sqlite.prepare(`delete from "${tbl}"`).run();
        const cache = new Map<string, Database.Statement>();
        for (const { data } of byTable.get(tbl) ?? []) {
          if (tbl === "settings" && data.key === "gemini.apiKey") continue;
          const keys = Object.keys(data).filter((k) => cols.has(k));
          const sig = keys.join(",");
          if (!cache.has(sig)) cache.set(sig, sqlite.prepare(`insert or replace into "${tbl}" (${keys.map((k) => `"${k}"`).join(", ")}) values (${keys.map(() => "?").join(", ")})`));
          cache.get(sig)!.run(...keys.map((k) => data[k] as never));
          counts[tbl] = (counts[tbl] ?? 0) + 1;
        }
      }
      sqlite.prepare("delete from sessions").run();
      // what is here is exactly the cloud: nothing to push
      sqlite.prepare("delete from _sync_dirty").run();
    })();
  } finally {
    sqlite.pragma("foreign_keys = ON");
  }
  const broken = (sqlite.prepare("pragma foreign_key_check").all() as unknown[]).length;
  const st = state();
  st.exec("delete from pushed; delete from retry;");
  const put = st.prepare("insert into pushed (tbl, row_id, hash) values (?, ?, ?)");
  st.transaction(() => {
    for (const [tbl, rows] of byTable) for (const r of rows) put.run(tbl, String(r.data.id), r.hash ?? wire(tbl, r.data).hash);
  })();
  patchConfig({ cursor: top, changeCounter: readCloudConfig().changeCounter + 1 });
  return { counts, backup: backup.name, brokenLinks: broken };
}

/* ------------------------------------------------------------ parcha numbers */

/**
 * With sync on, a parcha number is claimed in the cloud before it is used,
 * so two computers can never bill the same number. Needs the internet.
 * Re-approving the same truck (a new version) keeps its number.
 */
export async function claimParchaNumber(businessId: string, parchaNo: string, loadId: string) {
  if (!syncEnabled()) return;
  const cfg = readCloudConfig();
  const conn = decryptSecret(cfg.enc!);
  if (!conn) return;
  const p = pool(conn);
  try {
    const client = await p.connect();
    try {
      await ensureCloud(client, conn);
      const got = await client.query(
        "insert into mm_claims (business_id, kind, value, load_id, device) values ($1, 'parcha', $2, $3, $4) on conflict do nothing returning load_id",
        [businessId, parchaNo, loadId, cfg.deviceId]);
      if (got.rows.length) return;
      const who = await client.query("select load_id from mm_claims where business_id = $1 and kind = 'parcha' and value = $2", [businessId, parchaNo]);
      if (who.rows[0]?.load_id !== loadId) {
        throw new CloudError(`Parcha #${parchaNo} is already used on another computer. Pick the next number and approve again.`);
      }
    } finally { client.release(); }
  } catch (e) {
    const err = explain(e);
    throw err.offline ? new CloudError("Approving a parcha needs the internet, so two computers never use the same number. Connect and approve again — everything else keeps working offline.", true) : err;
  } finally { await p.end(); }
}

/* ------------------------------------------------------------ status / clashes */

export function clashList(limit = 100) {
  return state().prepare("select id, at, tbl, row_id, kept, other_device, lost, note from clashes order by id desc limit ?").all(limit) as
    { id: number; at: string; tbl: string; row_id: string; kept: string; other_device: string | null; lost: string; note: string }[];
}
export function clearClashes() { state().exec("delete from clashes"); }
export const clashCount = () => (state().prepare("select count(*) as n from clashes").get() as { n: number }).n;
export const pendingCount = () => {
  try { return (sqlite.prepare("select count(*) as n from _sync_dirty").get() as { n: number }).n; } catch { return 0; }
};

export function syncStatus() {
  const c = readCloudConfig();
  if (!c.enc || !c.live) return { enabled: false as const, state: "off" as SyncState };
  const st: SyncState = running ? "syncing" : c.pausedReason ? "paused" : c.lastError ? (/No connection/.test(c.lastError) ? "offline" : "error") : "ok";
  return {
    enabled: true as const, state: st, lastSyncAt: c.lastSyncAt, changeCounter: c.changeCounter,
    pausedReason: c.pausedReason, lastError: c.lastError, pending: pendingCount(), clashes: clashCount(),
  };
}

export async function cloudDevices() {
  const c = readCloudConfig();
  const conn = c.enc ? decryptSecret(c.enc) : null;
  if (!conn) return [];
  const p = pool(conn);
  try {
    const r = await p.query("select id, name, version, last_seen from mm_devices order by last_seen desc nulls last");
    return r.rows.map((d) => ({ id: d.id as string, name: d.name as string, version: d.version as string, lastSeen: d.last_seen as string, me: d.id === c.deviceId }));
  } catch { return []; } finally { await p.end(); }
}

/* ------------------------------------------------------------ schedule */

let timer: NodeJS.Timeout | null = null;
let soon: NodeJS.Timeout | null = null;
/** Every 10 seconds while sync is on; failures are shown as a status, never thrown at screens. */
export function startCloudSync() {
  if (timer || process.env.MANDI_NO_AUTO_BACKUP === "1") return;
  if (syncEnabled()) installTriggers();
  const tick = () => { if (syncEnabled()) void syncNow().catch(() => undefined); };
  setTimeout(tick, 3_000).unref();
  timer = setInterval(tick, 10_000);
  timer.unref();
}
/** After a change here, push within a couple of seconds instead of waiting for the next tick. */
export function syncSoon() {
  if (process.env.MANDI_NO_AUTO_BACKUP === "1" || !syncEnabled()) return;
  if (soon) clearTimeout(soon);
  soon = setTimeout(() => { soon = null; void syncNow().catch(() => undefined); }, 1_500);
  soon.unref();
}

/** How this computer is named to the others ("Office PC", "Munshi ji's laptop"). */
export function patchDeviceName(name: string) { patchConfig({ deviceName: name }); }
