import { eq, and } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { normKey, similarity } from "./translit.ts";

export interface AdatiSuggestion {
  adatiId: string; nameHi: string; nameHinglish: string;
  village: string | null; confidence: number;
}

export interface AdatiMatch {
  adatiId: string; nameHi: string; nameHinglish: string;
  confidence: number; via: "alias" | "normkey" | "fuzzy";
}

/** Auto-accept at or above this; below it the operator picks from suggestions. */
export const AUTO_ACCEPT = 0.82;
const SUGGEST_FLOOR = 0.6;

/** Loaded once per batch so a 30-row sheet does not hit the DB 30 times. */
export async function loadResolver(businessId: string) {
  const suppliers = await db.select().from(schema.adati)
    .where(and(eq(schema.adati.businessId, businessId), eq(schema.adati.active, true)));
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

  return {
    suppliers,
    resolve(raw: string): { match: AdatiMatch | null; suggestions: AdatiSuggestion[] } {
      const text = (raw ?? "").trim();
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
        .slice(0, 6);

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
    },
  };
}
