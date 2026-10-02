import { eq, and, inArray } from "drizzle-orm";
import { db, schema, sqlite } from "../db/client.ts";
import { ChargeConfigSchema, type ChargeConfig } from "./charges.ts";
import { billedFigures, storedWeighment, type LoadRow } from "./parcha.ts";
import { newId } from "./ids.ts";

/* Truck and parcha repairs after a cloud pull, and the rule for a truck
 * approved on two computers. Every computer runs them on the same records and
 * so comes to the same result; whatever they change is marked by the sync
 * triggers and sent up like any other edit.
 *
 * A truck's status and stored weights live on its own record; its approval
 * and void live on parcha records. Sync settles each record on its own, so a
 * truck can arrive "draft" beside a live parcha (approved here, edited there),
 * or "billed" with none (voided here, the mill's cut typed there). The parcha
 * is what the mill was billed, so the truck follows it:
 *   - a truck with a live parcha is billed, and holds the figures the parcha froze;
 *   - a truck with no live parcha is a draft, its stored net worked out from
 *     its mill's terms as they stand now (as every draft's is).
 * The truck's own updated_at is left alone: a repair is not a new edit, so a
 * real change made later on another computer still wins, and two computers
 * repairing the same truck write the same record. */

/** The void reason, and the clash note, when one truck was approved on two computers. */
export const APPROVED_TWICE = "this truck was approved on two computers — the earlier parcha is kept";

/** The audit trail names the app itself, not a person, for what sync puts right. */
function auditSync(businessId: string, action: string, entity: string, entityId: string, label: string, before: unknown, after: Record<string, unknown>) {
  db.insert(schema.auditLog).values({
    id: newId(), businessId, userId: null, userName: "Mandi Mitra", action, entity, entityId, entityLabel: label,
    before: JSON.stringify(before), after: JSON.stringify(after), changedKeys: JSON.stringify(Object.keys(after)),
  }).run();
}

/**
 * Another computer's approved parcha arrived for a truck that already has a
 * live parcha here (unique index parcha_one_approved_uq). Every computer keeps
 * the earlier one: ids are UUIDv7, so the smaller id was approved first, and
 * the same two ids give the same answer everywhere. The other is voided with a
 * plain reason, written the same way on every computer (no clock, no user), so
 * two computers voiding it send the same record.
 *   "take-incoming": the local live parcha has just been voided; the caller stores the incoming one.
 *   "keep-local": the caller leaves the incoming one to be tried again (it arrives voided from the other computer).
 */
export function parchaUniqueClash(incoming: Record<string, unknown>): "take-incoming" | "keep-local" {
  const id = String(incoming.id ?? "");
  const loadId = String(incoming.load_id ?? "");
  if (!id || !loadId || incoming.status !== "approved") return "keep-local";
  // this runs inside a pull: anything unreadable leaves the incoming parcha to be tried again, never stops the sync
  let local: { id: string; business_id: string; parcha_no: string; approved_at: number | null } | undefined;
  try {
    local = sqlite.prepare("select id, business_id, parcha_no, approved_at from parchas where load_id = ? and status = 'approved' and id <> ?")
      .get(loadId, id) as typeof local;
    if (!local || local.id < id) return "keep-local";
    // voided just after the later approval: a time every computer works out alike, and after that number's claim
    const later = Math.max(Number(local.approved_at ?? 0), Number(incoming.approved_at ?? 0));
    const at = later ? later + 1 : null;
    sqlite.prepare("update parchas set status = 'void', voided_by = null, voided_at = ?, void_reason = ? where id = ?").run(at, APPROVED_TWICE, local.id);
  } catch { return "keep-local"; }
  try {
    auditSync(local.business_id, "parcha.void", "parcha", local.id, `Parcha ${local.parcha_no} — ${APPROVED_TWICE} (#${String(incoming.parcha_no ?? "")})`,
      { status: "approved" }, { status: "void", reason: APPROVED_TWICE });
  } catch { /* the void stands; only its line in the audit trail is missing */ }
  return "take-incoming";
}

/**
 * Puts trucks in step with their parchas (all of them, or the ones named).
 * Deterministic and idempotent: the same records give the same result on
 * every computer, and a second run changes nothing. Returns how many trucks
 * it changed. `audit: false` when the caller writes its own audit row.
 */
export function repairTrucks(only?: string[], opts: { audit?: boolean } = {}): number {
  const L = schema.loads;
  const P = schema.parchas;
  if (only && !only.length) return 0;
  const loads = (only ? db.select().from(L).where(inArray(L.id, only)) : db.select().from(L)).all();
  if (!loads.length) return 0;
  const live = new Map(db.select({ loadId: P.loadId, parchaNo: P.parchaNo, invoiceDate: P.invoiceDate, snapshot: P.snapshot }).from(P)
    .where(only ? and(eq(P.status, "approved"), inArray(P.loadId, only)) : eq(P.status, "approved")).all().map((p) => [p.loadId, p]));
  const terms = new Map<string, ChargeConfig | null>();
  const termsOf = (merchantId: string) => {
    if (!terms.has(merchantId)) {
      const m = db.select({ cfg: schema.merchants.chargeConfig }).from(schema.merchants).where(eq(schema.merchants.id, merchantId)).get();
      let cfg: ChargeConfig | null = null;
      try { const r = m ? ChargeConfigSchema.safeParse(JSON.parse(m.cfg)) : null; cfg = r?.success ? r.data : null; } catch { /* unreadable terms: leave the truck */ }
      terms.set(merchantId, cfg);
    }
    return terms.get(merchantId)!;
  };
  let changed = 0;
  sqlite.transaction(() => {
    for (const l of loads) {
      // one unreadable record never stops the others, nor the sync that called this
      try {
        const p = live.get(l.id);
        const want: Partial<LoadRow> = p ? billedFigures(l, p) : { status: "draft" };
        if (!p) {
          const cfg = termsOf(l.merchantId);
          const s = cfg ? storedWeighment(l, cfg) : null;
          // a truck not weighed yet keeps its blanks; anything else follows the mill's terms
          if (s && (s.millNetGrams !== l.millNetGrams || s.bags !== (l.bags ?? 0) || s.millBardanaGrams !== (l.millBardanaGrams ?? 0))) Object.assign(want, s);
        }
        const patch = Object.fromEntries(Object.entries(want).filter(([k, v]) => l[k as keyof LoadRow] !== v)) as Partial<LoadRow>;
        const keys = Object.keys(patch);
        if (!keys.length) continue;
        db.update(L).set(patch).where(eq(L.id, l.id)).run();
        changed++;
        if (opts.audit === false) continue;
        const why = p ? `put in step with parcha #${p.parchaNo}` : l.status === "billed" ? "back to draft: it has no live parcha" : "stored weight worked out again from the mill's terms";
        auditSync(l.businessId, "load.resync", "load", l.id, `${l.truckNo ?? "truck"} ${l.loadDate}: ${why}`,
          Object.fromEntries(keys.map((k) => [k, l[k as keyof LoadRow]])), patch as Record<string, unknown>);
      } catch { /* leave this truck as it is */ }
    }
  })();
  return changed;
}

/** Called after every pull that applied something, inside no transaction. Returns how many records it changed. */
export function repairTrucksAfterPull(): number {
  try { return repairTrucks(); } catch { return 0; }
}
