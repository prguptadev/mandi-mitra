import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { runMigrations, reportBrokenLinks } from "./db/migrate.ts";
import { recoverInterruptedScans, fingerprintOldPagesLater } from "./routes/scans.ts";
import { DB_PATH, sqlite } from "./db/client.ts";
import { startAutoBackups } from "./lib/backup.ts";
import { startCloudSync } from "./lib/cloud.ts";
import { syncNewPermissions } from "./lib/rbacSync.ts";
import { seedFirstRun } from "./lib/businessSetup.ts";

const port = Number(process.env.PORT ?? 8787);
const upToDate = runMigrations();
/* Fresh statistics for the query planner (only re-analyses what changed).
   They only ever change which index a query reads, never what it returns.
   Right after an update (new indexes) it runs now; otherwise once the first
   screen is up, the statistics kept from the last run serving until then.
   Never sampled (analysis_limit): a sample of the first few hundred rows of
   an index sees one business, and the planner would then think a business
   has a few hundred slips. */
if (!upToDate) sqlite.pragma("optimize=0x10002");
setTimeout(() => {
  if (upToDate) {
    try { sqlite.pragma("optimize=0x10002"); } catch { /* closing */ }
    // the note about records pointing at something long gone (see runMigrations)
    reportBrokenLinks();
  }
}, 8_000).unref();
setInterval(() => { try { sqlite.pragma("optimize"); } catch { /* closing */ } }, 6 * 3600_000).unref();
if (await seedFirstRun()) console.log("[setup] first run: Vijay Laxmi Dal Mill and V C Enterprises, Admin + 2 Managers (PIN 7747)");
const granted = syncNewPermissions();
if (granted) console.log(`[rbac] granted ${granted} new permission(s) to the stock roles`);
const recovered = recoverInterruptedScans();
if (recovered) console.log(`[scan] reset ${recovered} interrupted read(s)`);
// older sheets' pages get their fingerprints, so another computer notices the same picture again
fingerprintOldPagesLater();
// this computer only; MANDI_HOST=0.0.0.0 opens it to the local network on purpose
serve({ fetch: createApp().fetch, port, hostname: process.env.MANDI_HOST ?? "127.0.0.1" });
startAutoBackups();
startCloudSync();
console.log(`  api   http://localhost:${port}`);
console.log(`  db    ${DB_PATH}`);

/** Everything into the main database file, then closed: nothing is left only in the -wal file. */
function shutdown() {
  try { sqlite.pragma("wal_checkpoint(TRUNCATE)"); sqlite.close(); } catch { /* closed already */ }
}
(globalThis as { __mandiShutdown?: () => void }).__mandiShutdown = shutdown;
for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => { shutdown(); process.exit(0); });
