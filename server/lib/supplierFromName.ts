import { and, eq, ne } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { newId, nowSec } from "./ids.ts";
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

/* Two rows in the master that are one trader — "धर्मपाल" entered by hand while
   "धर्मपाल सिंह" already existed — are joined here. Every slip, every payment
   and every learnt spelling moves to the one that stays, its opening balance is
   added on, and the name that goes is kept as a spelling of the one that stays,
   so the same handwriting resolves to it from now on. No figure changes. */
export interface MergeResult {
  slips: number; payments: number; aliases: number; scanRows: number;
  from: { id: string; nameHi: string; nameHinglish: string };
  into: { id: string; nameHi: string; nameHinglish: string };
  openingAddedPaise: number;
}

export async function mergeSuppliers(biz: string, fromId: string, intoId: string, actor: AuditActor): Promise<MergeResult> {
  if (fromId === intoId) throw bad("Pick two different suppliers", "same_adati");
  const one = async (id: string) => db.select().from(schema.adati)
    .where(and(eq(schema.adati.id, id), eq(schema.adati.businessId, biz))).get();
  const from = await one(fromId);
  const into = await one(intoId);
  if (!from) throw bad("The supplier to join was not found", "no_adati");
  if (!into) throw bad("The supplier to keep was not found", "no_adati");

  const slips = db.select({ id: schema.purchaseSlips.id }).from(schema.purchaseSlips)
    .where(and(eq(schema.purchaseSlips.businessId, biz), eq(schema.purchaseSlips.adatiId, fromId))).all().length;
  const payments = db.select({ id: schema.payments.id }).from(schema.payments)
    .where(and(eq(schema.payments.businessId, biz), eq(schema.payments.adatiId, fromId))).all().length;

  await db.update(schema.purchaseSlips).set({ adatiId: intoId, updatedAt: nowSec() })
    .where(and(eq(schema.purchaseSlips.businessId, biz), eq(schema.purchaseSlips.adatiId, fromId)));
  await db.update(schema.payments).set({ adatiId: intoId })
    .where(and(eq(schema.payments.businessId, biz), eq(schema.payments.adatiId, fromId)));

  // spellings move across; one the survivor already has is dropped rather than duplicated
  const mine = new Set(db.select({ rawText: schema.adatiAliases.rawText }).from(schema.adatiAliases)
    .where(and(eq(schema.adatiAliases.businessId, biz), eq(schema.adatiAliases.adatiId, intoId))).all().map((a) => a.rawText));
  const theirs = db.select().from(schema.adatiAliases)
    .where(and(eq(schema.adatiAliases.businessId, biz), eq(schema.adatiAliases.adatiId, fromId))).all();
  let aliases = 0;
  for (const a of theirs) {
    if (mine.has(a.rawText)) { await db.delete(schema.adatiAliases).where(eq(schema.adatiAliases.id, a.id)); continue; }
    await db.update(schema.adatiAliases).set({ adatiId: intoId, source: "merge" }).where(eq(schema.adatiAliases.id, a.id));
    mine.add(a.rawText);
    aliases++;
  }
  for (const raw of [from.nameHi, from.nameHinglish]) {
    if (!raw || mine.has(raw)) continue;
    await db.insert(schema.adatiAliases).values({
      id: newId(), businessId: biz, adatiId: intoId, rawText: raw, normKey: normKey(raw), source: "merge", createdBy: actor.userId ?? null,
    }).onConflictDoNothing();
    mine.add(raw);
    aliases++;
  }

  /* A sheet still being checked may point at the name that goes. Those rows
     are moved too, so no sheet is left naming a supplier that is no longer
     there. Sheets already on the daily list hold slips, which moved above. */
  let scanRows = 0;
  const sheets = db.select({ id: schema.scanBatches.id, parsedRows: schema.scanBatches.parsedRows })
    .from(schema.scanBatches)
    .where(and(eq(schema.scanBatches.businessId, biz), ne(schema.scanBatches.status, "committed"))).all();
  for (const sheet of sheets) {
    if (!sheet.parsedRows?.includes(fromId)) continue;
    const rows = JSON.parse(sheet.parsedRows) as { adatiId?: string | null }[];
    let touched = 0;
    for (const r of rows) if (r.adatiId === fromId) { r.adatiId = intoId; touched++; }
    if (!touched) continue;
    await db.update(schema.scanBatches).set({ parsedRows: JSON.stringify(rows) }).where(eq(schema.scanBatches.id, sheet.id));
    scanRows += touched;
  }

  const openingAddedPaise = from.openingBalancePaise;
  if (openingAddedPaise !== 0) {
    await db.update(schema.adati).set({ openingBalancePaise: into.openingBalancePaise + openingAddedPaise, updatedAt: nowSec() })
      .where(eq(schema.adati.id, intoId));
  }
  await db.delete(schema.adati).where(eq(schema.adati.id, fromId));
  await enqueueSync(biz, "adati", fromId, "delete");

  await audit({
    actor, action: "adati.merge", entity: "adati", entityId: intoId,
    entityLabel: `${from.nameHinglish} → ${into.nameHinglish}`,
    before: from,
    after: { keptId: intoId, keptName: into.nameHinglish, slipsMoved: slips, paymentsMoved: payments, spellingsMoved: aliases, sheetRowsMoved: scanRows, openingAddedPaise },
  });
  return {
    slips, payments, aliases, scanRows, openingAddedPaise,
    from: { id: from.id, nameHi: from.nameHi, nameHinglish: from.nameHinglish },
    into: { id: into.id, nameHi: into.nameHi, nameHinglish: into.nameHinglish },
  };
}
