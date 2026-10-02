import { eq, and, sql } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { normKey, similarity } from "./translit.ts";

export interface AdatiSuggestion {
  adatiId: string; nameHi: string; nameHinglish: string;
  village: string | null; confidence: number;
}

export interface AdatiMatch {
  adatiId: string; nameHi: string; nameHinglish: string;
  confidence: number; via: "alias" | "normkey" | "model" | "fuzzy";
}

/** Auto-accept at or above this; below it the operator picks from suggestions. */
export const AUTO_ACCEPT = 0.82;
const SUGGEST_FLOOR = 0.6;
/** The reader's pick from the list counts only if it looks this much like what it wrote. */
const PICK_CLOSE = 0.75;

/** Hindi name order: what localeCompare(b, "hi") gives, without building a collator for every comparison. */
const hindiOrder = new Intl.Collator("hi").compare;

/** Loaded once per batch so a 30-row sheet does not hit the DB 30 times. */
export async function loadResolver(businessId: string) {
  const all = await db.select().from(schema.adati)
    .where(and(eq(schema.adati.businessId, businessId), eq(schema.adati.active, true)));
  const usage = await db.select({ id: schema.purchaseSlips.adatiId, n: sql<number>`count(*)`.as("n") })
    .from(schema.purchaseSlips)
    .where(eq(schema.purchaseSlips.businessId, businessId))
    .groupBy(schema.purchaseSlips.adatiId);
  const used = new Map(usage.map((u) => [u.id, u.n]));
  const suppliers = all.sort((a, b) => (used.get(b.id) ?? 0) - (used.get(a.id) ?? 0)
    || hindiOrder(a.nameHi, b.nameHi));
  const aliases = await db.select().from(schema.adatiAliases)
    .where(eq(schema.adatiAliases.businessId, businessId));

  const byId = new Map(suppliers.map((s) => [s.id, s]));
  const byRaw = new Map<string, string>();
  /* The loose key drops vowel signs, so सोनू and सोना share one: every supplier
     under a key is kept, and a key shared by two is never a match on its own. */
  const byNorm = new Map<string, Set<string>>();
  const addNorm = (k: string, id: string) => { if (!byNorm.has(k)) byNorm.set(k, new Set()); byNorm.get(k)!.add(id); };
  for (const a of aliases) {
    if (!byId.has(a.adatiId)) continue;
    byRaw.set(a.rawText, a.adatiId);
    addNorm(a.normKey, a.adatiId);
  }
  // the canonical names are matchable even without an alias row
  for (const s of suppliers) {
    if (!byRaw.has(s.nameHi)) byRaw.set(s.nameHi, s.id);
    addNorm(normKey(s.nameHi), s.id);
  }
  const suggestion = (a: (typeof suppliers)[number], confidence: number): AdatiSuggestion =>
    ({ adatiId: a.id, nameHi: a.nameHi, nameHinglish: a.nameHinglish, village: a.village ?? null, confidence });

  /* Named, not a method: callers pass it around unbound (resolve: resolver.resolve). */
  /** A village written beside the name: among suppliers sharing a name, the one from that village. */
  const sameVillage = (ids: string[], village?: string | null) => {
    const v = (village ?? "").trim();
    if (!v) return null;
    const vk = normKey(v);
    const hit = ids.filter((id) => { const a = byId.get(id)!; return [a.villageHi, a.village].some((x) => x && (normKey(x) === vk || similarity(x, v) >= 0.85)); });
    return hit.length === 1 ? hit[0] : null;
  };
  function resolve(raw: string, modelPick?: string | null, village?: string | null): { match: AdatiMatch | null; suggestions: AdatiSuggestion[] } {
    const text = (raw ?? "").trim();
    /* The model saw the handwriting beside the real list. If what it picked
       is an exact supplier name, that beats any string comparison we can do
       on its transcription after the fact. An exact alias hit still wins,
       because that is the operator's own earlier correction. */
    const pickId = modelPick ? byRaw.get(modelPick.trim()) : undefined;
    const aliasId = text ? byRaw.get(text) : undefined;
    if (aliasId && byId.has(aliasId)) {
      const a = byId.get(aliasId)!;
      return {
        match: { adatiId: a.id, nameHi: a.nameHi, nameHinglish: a.nameHinglish, confidence: 1, via: "alias" },
        suggestions: [],
      };
    }
    // the model's pick counts only if it resembles what was written; else it is a suggestion
    if (pickId && byId.has(pickId) && text) {
      const pk = byId.get(pickId)!;
      const closeness = Math.max(similarity(text, pk.nameHi), similarity(text, pk.nameHinglish));
      if (closeness >= PICK_CLOSE) {
        return {
          match: { adatiId: pk.id, nameHi: pk.nameHi, nameHinglish: pk.nameHinglish, confidence: Number(closeness.toFixed(3)), via: "model" },
          suggestions: [],
        };
      }
      // not like what it wrote (श्याम सिंह picked for राम सिंह): only a suggestion
      const rest = resolve(raw, null, village);
      return {
        match: rest.match && rest.match.via !== "fuzzy" ? rest.match : null,
        suggestions: [suggestion(pk, 0.5), ...rest.suggestions.filter((x) => x.adatiId !== pk.id)].slice(0, 3),
      };
    }
    if (pickId && byId.has(pickId)) {
      const a = byId.get(pickId)!;
      return {
        match: { adatiId: a.id, nameHi: a.nameHi, nameHinglish: a.nameHinglish, confidence: 0.97, via: "model" },
        suggestions: [],
      };
    }
    if (!text) return { match: null, suggestions: [] };

    const exact = byRaw.get(text);
    if (exact && byId.has(exact)) {
      const a = byId.get(exact)!;
      return {
        match: { adatiId: a.id, nameHi: a.nameHi, nameHinglish: a.nameHinglish, confidence: 1, via: "alias" },
        suggestions: [],
      };
    }

    const nk = [...(byNorm.get(normKey(text)) ?? [])].filter((id) => byId.has(id));
    if (nk.length === 1) {
      const a = byId.get(nk[0])!;
      return {
        match: { adatiId: a.id, nameHi: a.nameHi, nameHinglish: a.nameHinglish, confidence: 0.95, via: "normkey" },
        suggestions: [],
      };
    }
    if (nk.length > 1) {
      // two suppliers share the name: the village written on the paper settles it
      const byVillage = sameVillage(nk, village);
      if (byVillage) {
        const a = byId.get(byVillage)!;
        return { match: { adatiId: a.id, nameHi: a.nameHi, nameHinglish: a.nameHinglish, confidence: 0.93, via: "normkey" }, suggestions: [] };
      }
      // else they differ only in their vowel signs: the operator picks
      return {
        match: null,
        suggestions: nk.map((id) => byId.get(id)!).map((a) => suggestion(a, Number(Math.max(similarity(text, a.nameHi), similarity(text, a.nameHinglish)).toFixed(3))))
          .sort((x, y) => y.confidence - x.confidence).slice(0, 3),
      };
    }

    const scored = suppliers
      .map((a) => ({ a, score: Math.max(similarity(text, a.nameHi), similarity(text, a.nameHinglish)) }))
      .filter((s) => s.score >= SUGGEST_FLOOR)
      .sort((x, y) => y.score - x.score)
      .slice(0, 3);   // three closest; more is noise on a 30-row sheet

    const best = scored[0];
    return {
      match: best && best.score >= AUTO_ACCEPT
        ? { adatiId: best.a.id, nameHi: best.a.nameHi, nameHinglish: best.a.nameHinglish, confidence: Number(best.score.toFixed(3)), via: "fuzzy" }
        : null,
      suggestions: scored.map((s) => ({
        adatiId: s.a.id, nameHi: s.a.nameHi, nameHinglish: s.a.nameHinglish,
        village: s.a.village, confidence: Number(s.score.toFixed(3)),
      })),
    };
  }

  return {
    suppliers,
    /** Name a supplier the operator already picked by hand. */
    byId(id: string) {
      const a = byId.get(id);
      return a ? { adatiId: a.id, nameHi: a.nameHi, nameHinglish: a.nameHinglish } : null;
    },
    /** Supplier names to show the model, most-used first, capped for prompt size. */
    /** Names for the reader's list, with the village in brackets when the supplier has one. */
    candidateNames(limit = 300): string[] {
      return suppliers.slice(0, limit).map((s) => (s.villageHi || s.village ? `${s.nameHi} (${s.villageHi || s.village})` : s.nameHi));
    },
    resolve,
  };
}
