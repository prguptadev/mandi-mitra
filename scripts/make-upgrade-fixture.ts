/* Books as the release before this one left them: every database update but
 * the newest applied, with the first-run rows (firms, users, roles,
 * commodities) in them. The Windows build starts the packaged app on these
 * (desktop.yml), so the real update path — a checked copy first, the update,
 * the row and link checks — runs inside the packaged app on every release,
 * not only a fresh install.
 * Run it before electron-builder (which rebuilds better-sqlite3 for Electron).
 * Usage: npx tsx scripts/make-upgrade-fixture.ts <empty folder>
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";

const out = path.resolve(process.argv[2] ?? "upgrade-fixture");
if (fs.existsSync(path.join(out, "mandi.db"))) { console.error(`${out} already holds books; give an empty folder`); process.exit(2); }
fs.mkdirSync(out, { recursive: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), "mandi-fixture-"));

// the release before's migrations: the journal without its newest entry
const prevMigrations = path.join(work, "migrations");
fs.cpSync(path.resolve("server/db/migrations"), prevMigrations, { recursive: true });
const jp = path.join(prevMigrations, "meta", "_journal.json");
const journal = JSON.parse(fs.readFileSync(jp, "utf8")) as { entries: { tag: string }[] };
const newest = journal.entries.pop()!;
fs.writeFileSync(jp, JSON.stringify(journal, null, 2));

/** The app's own start-up (its migrations, and with `seed` the first-run rows) on a folder, in its own process. */
function startOn(dir: string, migrations: string, seed: boolean) {
  const code = `
    const { runMigrations } = await import(${JSON.stringify(pathToFileURL(path.resolve("server/db/migrate.ts")).href)});
    runMigrations();
    ${seed ? `const { seedFirstRun } = await import(${JSON.stringify(pathToFileURL(path.resolve("server/lib/businessSetup.ts")).href)});
    await seedFirstRun();` : ""}
    const { closeBooks } = await import(${JSON.stringify(pathToFileURL(path.resolve("server/db/client.ts")).href)});
    closeBooks();`;
  const file = path.join(work, "start.mts");
  fs.writeFileSync(file, code);
  const env: NodeJS.ProcessEnv = { ...process.env, MANDI_DATA_DIR: dir, MANDI_MIGRATIONS_DIR: migrations, MANDI_NO_AUTO_BACKUP: "1" };
  delete env.MANDI_NO_SEED;
  const r = spawnSync(process.execPath, ["--import", "tsx", file], { env, encoding: "utf8" });
  if (r.status !== 0) { console.error(r.stdout, r.stderr); process.exit(1); }
}

// first-run rows written by today's code onto today's tables…
const now = path.join(work, "now");
startOn(now, path.resolve("server/db/migrations"), true);
// …and the release before's empty tables
const before = path.join(work, "before");
fs.mkdirSync(before);
startOn(before, prevMigrations, false);

// the rows copied across, column by column where both have the column
const db = new Database(path.join(before, "mandi.db"));
db.pragma("foreign_keys = OFF");
db.exec(`attach database '${path.join(now, "mandi.db").replace(/'/g, "''")}' as now`);
const tables = db.prepare("select name from main.sqlite_master where type = 'table' and name not like 'sqlite_%' and name <> '__drizzle_migrations'").pluck().all() as string[];
let rows = 0;
db.transaction(() => {
  for (const t of tables) {
    const mine = new Set((db.prepare(`select name from pragma_table_info(?, 'main')`).pluck().all(t) as string[]));
    const theirs = db.prepare(`select name from pragma_table_info(?, 'now')`).pluck().all(t) as string[];
    const cols = theirs.filter((c) => mine.has(c)).map((c) => `"${c}"`).join(", ");
    if (!cols) continue;
    db.prepare(`delete from main."${t}"`).run();
    rows += db.prepare(`insert into main."${t}" (${cols}) select ${cols} from now."${t}"`).run().changes;
  }
})();
db.exec("detach database now");
db.pragma("wal_checkpoint(TRUNCATE)");
db.pragma("journal_mode = DELETE");
db.close();
fs.copyFileSync(path.join(before, "mandi.db"), path.join(out, "mandi.db"));
fs.rmSync(work, { recursive: true, force: true });
console.log(`${path.join(out, "mandi.db")}: ${journal.entries.length} of ${journal.entries.length + 1} updates applied (${newest.tag} still to come), ${rows} rows`);
