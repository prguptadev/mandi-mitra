import { db, schema } from "../db/client.ts";
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

/** Queue a row for the future cloud push. */
export async function enqueueSync(businessId: string | null, entity: string, entityId: string, op: "insert" | "update" | "delete", payload?: unknown) {
  await db.insert(schema.syncOutbox).values({
    id: newId(), businessId, entity, entityId, op,
    payload: payload === undefined ? null : JSON.stringify(payload),
  });
}
