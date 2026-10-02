import { is, Column, SQL, noopDecoder } from "drizzle-orm";
import { sqlite } from "./client.ts";

/* drizzle builds each row of a result as an object, column by column, asking
   every column how to read its value. For the few lists that come back with
   tens of thousands of rows (every truck row of a business, every purchase
   day) that takes as long as the query itself. rowsOf() runs the very SQL
   drizzle built for the query and lays each row out under the same names, in
   the same order. Only for columns drizzle hands through untouched (text,
   integer, real, and plain sql values); a query with any other kind of column
   goes through drizzle as usual. */

const PLAIN = new Set(["SQLiteText", "SQLiteInteger", "SQLiteReal"]);
// an sql`` value keeps how it is read in `decoder` (not in drizzle's public types); untouched unless .mapWith() was used
const untouched = (s: SQL) => (s as unknown as { decoder: unknown }).decoder === noopDecoder;
const plain = (f: unknown) =>
  is(f, Column) ? PLAIN.has(f.columnType)
    : is(f, SQL.Aliased) ? untouched(f.sql)
      : is(f, SQL) ? untouched(f)
        : false;

/** `fields` is the object the query selects (db.select(fields)): flat, one value per name. */
export async function rowsOf<T>(q: PromiseLike<T[]> & { toSQL(): { sql: string; params: unknown[] } }, fields: Record<string, unknown>): Promise<T[]> {
  const keys = Object.keys(fields);
  if (!keys.every((k) => plain(fields[k]))) return q;
  const { sql, params } = q.toSQL();
  const raw = sqlite.prepare(sql).raw(true).all(...params) as unknown[][];
  const out = new Array<T>(raw.length);
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i];
    const o: Record<string, unknown> = {};
    for (let k = 0; k < keys.length; k++) o[keys[k]] = r[k];
    out[i] = o as T;
  }
  return out;
}
