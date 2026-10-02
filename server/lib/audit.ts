import { db, schema, sqlite } from "../db/client.ts";
import { newId } from "./ids.ts";

export interface AuditActor {
  userId?: string | null;
  userName?: string | null;
  businessId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

const REDACT = new Set(["pinHash", "pinSalt", "pin", "token", "chargeConfig"]);

function scrub(o: unknown): unknown {
  if (o === null || typeof o !== "object") return o;
  if (Array.isArray(o)) return o.map(scrub);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    if (REDACT.has(k)) { out[k] = "[redacted]"; continue; }
    out[k] = scrub(v);
  }
  return out;
}

function changedKeys(before: unknown, after: unknown): string[] {
  if (!before || !after || typeof before !== "object" || typeof after !== "object") return [];
  const b = before as Record<string, unknown>;
  const a = after as Record<string, unknown>;
  const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
  const out: string[] = [];
  for (const k of keys) {
    if (k === "updatedAt") continue;
    if (JSON.stringify(b[k]) !== JSON.stringify(a[k])) out.push(k);
  }
  return out;
}

/**
 * Append-only audit trail. Called for every mutation — nothing in this app
 * changes without a row here saying who, what, when, and what the value was
 * before. The audit screen is read-only; there is no delete path.
 */
export async function audit(opts: {
  actor: AuditActor;
  action: string;
  entity: string;
  entityId?: string | null;
  entityLabel?: string | null;
  before?: unknown;
  after?: unknown;
}) {
  const ck = changedKeys(opts.before, opts.after);
  await db.insert(schema.auditLog).values({
    id: newId(),
    businessId: opts.actor.businessId ?? null,
    userId: opts.actor.userId ?? null,
    userName: opts.actor.userName ?? null,
    action: opts.action,
    entity: opts.entity,
    entityId: opts.entityId ?? null,
    entityLabel: opts.entityLabel ?? null,
    before: opts.before === undefined ? null : JSON.stringify(scrub(opts.before)),
    after: opts.after === undefined ? null : JSON.stringify(scrub(opts.after)),
    changedKeys: ck.length ? JSON.stringify(ck) : null,
    ip: opts.actor.ip ?? null,
    userAgent: opts.actor.userAgent?.slice(0, 250) ?? null,
  });
}

/**
 * Once queued a row in sync_outbox for a cloud push. Nothing ever read that
 * list — cloud sync sends what the _sync_dirty triggers mark (lib/cloud.ts) —
 * so it only grew, a row for every change. It now does nothing; the callers
 * are left as they are.
 */
export async function enqueueSync(_businessId: string | null, _entity: string, _entityId: string, _op: "insert" | "update" | "delete", _payload?: unknown) {
  // nothing to do: see above
}

/**
 * Empties the old sync list (sync_outbox) once, in the background after the
 * server is up, so the first screen does not wait for it: a batch of rows at a
 * time with a short pause between, so screens stay quick while it runs. If
 * anything goes wrong it is logged and left for the next start; nothing else
 * reads the table, and it stays (empty), so no migration is needed.
 */
// 5,000 rows a batch: on a two-year book (116,328 rows, 65 MB) each takes well under 0.2 s,
// where 20,000 at once held the database for 0.6–0.8 s
export function emptyOldSyncListLater(delayMs = 10_000, batch = 5_000, pauseMs = 200) {
  let removed = 0;
  const step = () => {
    try {
      const n = sqlite.prepare("delete from sync_outbox where rowid in (select rowid from sync_outbox limit ?)").run(batch).changes;
      removed += n;
      if (n === batch) { setTimeout(step, pauseMs).unref(); return; }
      if (removed) console.log(`[sync] emptied the old sync list (${removed} rows, no longer used)`);
    } catch (e) {
      console.warn(`[sync] could not empty the old sync list, will try at the next start: ${(e as Error).message}`);
    }
  };
  setTimeout(step, delayMs).unref();
}
