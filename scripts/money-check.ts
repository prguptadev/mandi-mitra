/* An independent audit of every rupee and quintal in a database, read-only —
 * the same check the Audit screen's "Check the books" runs on the live books.
 *   npx tsx scripts/money-check.ts <path-to-a-copy-of-mandi.db>
 * Run it on a copy (sqlite3 data/mandi.db ".backup /tmp/copy.db"), never
 * while pointing a writer at the same file.
 */
import Database from "better-sqlite3";
import { checkBooks } from "../server/lib/booksCheck.ts";

const file = process.argv[2];
if (!file) { console.error("usage: npx tsx scripts/money-check.ts <copy-of-mandi.db>"); process.exit(2); }
const db = new Database(file, { readonly: true, fileMustExist: true });
const r = checkBooks(db);
db.close();
for (const b of r.businesses) {
  console.log(`\n══ ${b.name}`);
  for (const s of b.sections) {
    console.log(`\n ${s.title}`);
    for (const l of s.lines) console.log(`   ${l.ok === true ? "✓" : l.ok === false ? "✗" : "·"} ${l.text}`);
  }
}
console.log(r.problems ? `\n${r.problems} problem(s) found.` : "\nEvery figure re-works exactly.");
process.exit(r.problems ? 1 : 0);
