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
    || a.nameHi.localeCompare(b.nameHi, "hi"));
  const aliases = await db.select().from(schema.adatiAliases)
    .where(eq(schema.adatiAliases.businessId, businessId));

  const byId = new Map(suppliers.map((s) => [s.id, s]));
  const byRaw = new Map<string, string>();
  const byNorm = new Map<string, string>();
  for (const a of aliases) {
    if (!byId.has(a.adatiId)) continue;
    byRaw.set(a.rawText, a.adatiId);
    if (!byNorm.has(a.normKey)) byNorm.set(a.normKey, a.adatiId);
  }
  // the canonical names are matchable even without an alias row
  for (const s of suppliers) {
    if (!byRaw.has(s.nameHi)) byRaw.set(s.nameHi, s.id);
    const k = normKey(s.nameHi);
    if (!byNorm.has(k)) byNorm.set(k, s.id);
  }

  /* Named, not a method: callers pass it around unbound (resolve: resolver.resolve). */
  function resolve(raw: string, modelPick?: string | null): { match: AdatiMatch | null; suggestions: AdatiSuggestion[] } {
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
      const close = Math.max(similarity(text, pk.nameHi), similarity(text, pk.nameHinglish)) >= 0.5;
      if (!close) {
        const rest = resolve(raw, null);
        const pickSuggestion: AdatiSuggestion = { adatiId: pk.id, nameHi: pk.nameHi, nameHinglish: pk.nameHinglish, village: pk.village ?? null, confidence: 0.5 };
        return {
          match: rest.match && rest.match.via !== "fuzzy" ? rest.match : null,
          suggestions: [pickSuggestion, ...rest.suggestions.filter((x) => x.adatiId !== pk.id)].slice(0, 3),
        };
      }
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

    const nk = byNorm.get(normKey(text));
    if (nk && byId.has(nk)) {
      const a = byId.get(nk)!;
      return {
        match: { adatiId: a.id, nameHi: a.nameHi, nameHinglish: a.nameHinglish, confidence: 0.95, via: "normkey" },
        suggestions: [],
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
    candidateNames(limit = 300): string[] {
      return suppliers.slice(0, limit).map((s) => s.nameHi);
    },
    resolve,
  };
}
