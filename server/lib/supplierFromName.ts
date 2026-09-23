import { and, eq } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { newId } from "./ids.ts";
import { audit, enqueueSync, type AuditActor } from "./audit.ts";
import { toHinglish, normKey } from "./translit.ts";
import { toDevanagari, hasDevanagari, hasLatin } from "./devanagari.ts";
import { bad } from "./http.ts";

/* A supplier from a typed name, without a dialog: the name is looked up the
   way the scanner's reader is (an earlier spelling, the exact name, the
   same name ignoring vowel signs) and, when nobody matches, the supplier is
   made on the spot — in Devanagari, with the Hinglish spelling the operator
   typed if they typed in Latin letters. Every creation is audited. */

export async function ensureSupplier(biz: string, typed: string, actor: AuditActor): Promise<{ id: string; nameHi: string; nameHinglish: string; created: boolean }> {
  const text = (typed ?? "").trim().replace(/\s+/g, " ");
  if (!text) throw bad("Pick a supplier", "bad_adati");
  const latinOnly = hasLatin(text) && !hasDevanagari(text);
  const nameHi = latinOnly ? toDevanagari(text) : text;
  const nameHinglish = latinOnly ? text.toUpperCase() : toHinglish(nameHi);
  const found = (id: string, created = false) => {
    const a = db.select({ id: schema.adati.id, nameHi: schema.adati.nameHi, nameHinglish: schema.adati.nameHinglish }).from(schema.adati)
      .where(and(eq(schema.adati.id, id), eq(schema.adati.businessId, biz))).get();
    return a ? { ...a, created } : null;
  };
  // 1. a spelling seen before (an alias), for either script typed
  for (const raw of [...new Set([text, nameHi])]) {
    const al = db.select({ adatiId: schema.adatiAliases.adatiId }).from(schema.adatiAliases)
      .where(and(eq(schema.adatiAliases.businessId, biz), eq(schema.adatiAliases.rawText, raw))).get();
    const hit = al && found(al.adatiId);
    if (hit) return hit;
  }
  // 2. the exact name, or the Hinglish spelling
  const exact = db.select({ id: schema.adati.id }).from(schema.adati)
    .where(and(eq(schema.adati.businessId, biz), eq(schema.adati.nameHi, nameHi))).get()
    ?? (latinOnly ? db.select({ id: schema.adati.id }).from(schema.adati)
      .where(and(eq(schema.adati.businessId, biz), eq(schema.adati.nameHinglish, text.toUpperCase()))).get() : undefined);
  if (exact) { const hit = found(exact.id); if (hit) return hit; }
  // 3. the same name ignoring vowel signs, when it names exactly one supplier
  const nk = db.select({ adatiId: schema.adatiAliases.adatiId }).from(schema.adatiAliases)
    .where(and(eq(schema.adatiAliases.businessId, biz), eq(schema.adatiAliases.normKey, normKey(nameHi)))).all();
  const ids = [...new Set(nk.map((x) => x.adatiId))];
  if (ids.length === 1) { const hit = found(ids[0]); if (hit) return hit; }
  // 4. nobody: a new supplier
  const id = newId();
  const values = { id, businessId: biz, nameHi, nameHinglish, nameHinglishLocked: latinOnly, active: true };
  await db.insert(schema.adati).values(values);
  await db.insert(schema.adatiAliases).values({
    id: newId(), businessId: biz, adatiId: id, rawText: nameHi, normKey: normKey(nameHi), source: "canonical", createdBy: actor.userId ?? null,
  }).onConflictDoNothing();
  await audit({ actor, action: "adati.create", entity: "adati", entityId: id, entityLabel: nameHinglish, after: { ...values, typed: text, madeFrom: "a typed name" } });
  await enqueueSync(biz, "adati", id, "insert", values);
  return { id, nameHi, nameHinglish, created: true };
}
