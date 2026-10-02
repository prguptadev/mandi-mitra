import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { runMigrations } from "./db/migrate.ts";
import { recoverInterruptedScans, fingerprintOldPagesLater } from "./routes/scans.ts";
import { DB_PATH, closeBooks, sqlite } from "./db/client.ts";
import { startAutoBackups } from "./lib/backup.ts";
import { startCloudSync } from "./lib/cloud.ts";
import { syncNewPermissions } from "./lib/rbacSync.ts";
import { seedFirstRun } from "./lib/businessSetup.ts";

/** Everything into the main database file, then closed: nothing is left only in the -wal file. */
function shutdown() {
  closeBooks();
}
/* Set before anything else runs, so the desktop app can close the books
   cleanly even when start-up stops half way (an update that was rolled back). */
(globalThis as { __mandiShutdown?: () => void }).__mandiShutdown = shutdown;

const port = Number(process.env.PORT ?? 8787);
runMigrations();
// fresh statistics for the query planner (cheap; only re-analyses what changed)
sqlite.pragma("optimize=0x10002");
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

for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => { shutdown(); process.exit(0); });
