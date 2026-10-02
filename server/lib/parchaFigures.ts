import { sqlite } from "../db/client.ts";
import type { ParchaDoc } from "./parcha.ts";

/* A parcha's snapshot is written once, when it is approved, and never
   edited (a void changes only its status). The lists that add up hundreds of
   parchas (dashboard, money card, mill accounts, challans) read a few figures
   from each: reading and parsing every snapshot again on every request was
   most of their time on a big book. Those figures are kept here, per parcha,
   with the snapshot's stored size; a snapshot ever written again under the
   same id is read afresh. Only the parts the lists read are kept, as parsed. */

export type ParchaFigures = Pick<ParchaDoc, "lines" | "totals" | "stock" | "weights"> & {
  result: Pick<ParchaDoc["result"], "advancePaise" | "grandTotalPaise" | "lines">;
};

const kept = new Map<string, { bytes: number; f: ParchaFigures }>();
/** Ten years of a busy mandi; past this the memory is simply given back and refilled. */
const MAX_KEPT = 50_000;

const figures = (d: ParchaDoc): ParchaFigures => ({
  lines: d.lines, totals: d.totals, stock: d.stock, weights: d.weights,
  // a snapshot with no result reads as one here too: result.x throws where it did
  result: (d.result ? { advancePaise: d.result.advancePaise, grandTotalPaise: d.result.grandTotalPaise, lines: d.result.lines } : undefined) as ParchaFigures["result"],
});

/**
 * The frozen figures of these parchas. `bytes` is octet_length(snapshot) as
 * the caller read it with the row (cheap: SQLite reads it from the record
 * header, not the text). The objects are shared between requests: read them,
 * never change them.
 */
export function figuresOf(rows: { id: string; bytes: number }[]): Map<string, ParchaFigures> {
  const out = new Map<string, ParchaFigures>();
  const missing: string[] = [];
  for (const r of rows) {
    const k = kept.get(r.id);
    if (k && k.bytes === r.bytes) out.set(r.id, k.f);
    else missing.push(r.id);
  }
  if (kept.size + missing.length > MAX_KEPT) kept.clear();
  for (let i = 0; i < missing.length; i += 500) {
    const ids = missing.slice(i, i + 500);
    const got = sqlite.prepare(`select id, snapshot, octet_length(snapshot) as bytes from parchas where id in (${ids.map(() => "?").join(",")})`)
      .all(...ids) as { id: string; snapshot: string; bytes: number }[];
    for (const g of got) {
      const f = figures(JSON.parse(g.snapshot) as ParchaDoc);
      kept.set(g.id, { bytes: g.bytes, f });
      out.set(g.id, f);
    }
  }
  return out;
}

/** A parcha written again under its id (brought down from another computer): read afresh next time. */
export function forgetParchaFigures(id: string) {
  kept.delete(id);
}

/** Every parcha written again (the books replaced by the cloud's copy): all read afresh. */
export function forgetAllParchaFigures() {
  kept.clear();
}
