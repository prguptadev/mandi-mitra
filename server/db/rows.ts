import { is, Column, SQL, noopDecoder } from "drizzle-orm";
import { sqlite } from "./client.ts";

/* drizzle builds each row of a result as an object, column by column, asking
   every column how to read its value. For the few lists that come back with
   thousands of rows (every truck row of a business, every purchase day, a
   season's slips) that takes as long as the query itself. rowsOf() runs the
   very SQL drizzle built for the query and lays each row out under the same
   names, in the same order, reading each value as drizzle does (a null stays
   null; anything else goes through the column's own reader, which for text,
   integer and real columns and plain sql values hands it through untouched).
   Only for a flat selection; anything else goes through drizzle as usual. */

const PLAIN = new Set(["SQLiteText", "SQLiteInteger", "SQLiteReal"]);
type Decoder = { mapFromDriverValue(v: unknown): unknown };
// an sql`` value keeps how it is read in `decoder` (not in drizzle's public types)
const decoderOfSql = (s: SQL) => (s as unknown as { decoder: Decoder }).decoder;
/** How drizzle reads a value of this field: null when untouched, undefined when not a flat field. */
function readerOf(f: unknown): Decoder | null | undefined {
  if (is(f, Column)) return PLAIN.has(f.columnType) ? null : (f as unknown as Decoder);
  const d = is(f, SQL) ? decoderOfSql(f) : is(f, SQL.Aliased) ? decoderOfSql(f.sql) : undefined;
  if (d === undefined) return undefined;
  return d === noopDecoder ? null : d;
}

/** `fields` is the object the query selects (db.select(fields)): flat, one value per name. */
export async function rowsOf<T>(q: PromiseLike<T[]> & { toSQL(): { sql: string; params: unknown[] } }, fields: Record<string, unknown>): Promise<T[]> {
  const keys = Object.keys(fields);
  const readers = keys.map((k) => readerOf(fields[k]));
  if (readers.some((r) => r === undefined)) return q;
  const { sql, params } = q.toSQL();
  const raw = sqlite.prepare(sql).raw(true).all(...params) as unknown[][];
  const out = new Array<T>(raw.length);
  const plain = readers.every((r) => r === null);
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i];
    const o: Record<string, unknown> = {};
    if (plain) {
      for (let k = 0; k < keys.length; k++) o[keys[k]] = r[k];
    } else {
      for (let k = 0; k < keys.length; k++) {
        const v = r[k], read = readers[k];
        o[keys[k]] = read && v !== null ? read.mapFromDriverValue(v) : v;
      }
    }
    out[i] = o as T;
  }
  return out;
}
