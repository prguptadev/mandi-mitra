import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { runMigrations, reportBrokenLinks, updateNeeded } from "./db/migrate.ts";
import { recoverInterruptedScans, fingerprintOldPagesLater } from "./routes/scans.ts";
import { DB_PATH, booksMode, closeBooks, noteDamage, sqlite } from "./db/client.ts";
import { startAutoBackups, backupBeforeUpdateAside } from "./lib/backup.ts";
import { startCloudSync } from "./lib/cloud.ts";
import { emptyOldSyncListLater } from "./lib/audit.ts";
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
/* An update about to change the tables: its copy is made first, on a thread
   of its own, so on a slow laptop the window is not taken for hung while a big
   book is copied. Only on books that opened whole (damaged books are not read
   through again here); the copy never stops the app opening: when VACUUM INTO
   cannot make one the file is copied as it is, and when even that fails the
   update still goes ahead, checked before it is kept (see runMigrations). */
let copyMade: Awaited<ReturnType<typeof backupBeforeUpdateAside>> | undefined;
if (booksMode() === "ok") {
  let needed = false;
  try { needed = updateNeeded(); } catch (e) { noteDamage(e); /* runMigrations says it */ }
  if (needed) copyMade = await backupBeforeUpdateAside();
}
const upToDate = runMigrations(copyMade);
/* The jobs below never stop the app opening: one that fails is said in the log,
   and damage it meets gets the books file checked at the next start. They run
   only on books that opened whole: damaged books (read only) are not written to. */
async function startJob<T>(what: string, job: () => T | Promise<T>): Promise<T | undefined> {
  try { return await job(); } catch (e) {
    noteDamage(e);
    console.error(`[start] ${what} failed; the app opens without it:`, e);
    return undefined;
  }
}
if (booksMode() === "ok") {
  /* Fresh statistics for the query planner (cheap; only re-analyses what
     changed: a millisecond on books analysed at the last start). Before the
     first screen, as always: rows that tie in a list come back in the order
     the planner's choice of index gives, and that must not change while the
     app is open. Never sampled (analysis_limit): a sample of the first few
     hundred rows of an index sees one business only. */
  await startJob("query statistics", () => sqlite.pragma("optimize=0x10002"));
  if (await startJob("first-run set-up", seedFirstRun)) console.log("[setup] first run: Vijay Laxmi Dal Mill and V C Enterprises, Admin + 2 Managers (PIN 7747)");
  const granted = await startJob("new permissions", syncNewPermissions);
  if (granted) console.log(`[rbac] granted ${granted} new permission(s) to the stock roles`);
  const recovered = await startJob("interrupted scans", recoverInterruptedScans);
  if (recovered) console.log(`[scan] reset ${recovered} interrupted read(s)`);
  // older sheets' pages get their fingerprints, so another computer notices the same picture again
  await startJob("scan fingerprints", fingerprintOldPagesLater);
  // the note about records pointing at something long gone, once the app is answering (see runMigrations)
  if (upToDate) setTimeout(reportBrokenLinks, 8_000).unref();
}
setInterval(() => {
  if (booksMode() !== "ok") return;
  try { sqlite.pragma("optimize"); } catch (e) { noteDamage(e); /* or closing */ }
}, 6 * 3600_000).unref();
// this computer only; MANDI_HOST=0.0.0.0 opens it to the local network on purpose
const listening = serve({ fetch: createApp().fetch, port, hostname: process.env.MANDI_HOST ?? "127.0.0.1" });
/* Each connection's address is read the moment it is accepted, so it is
   known for every request on it even if the device later resets the
   connection (lib/http.ts refuses a request whose address cannot be read). */
listening.on("connection", (socket: { remoteAddress?: string }) => { void socket.remoteAddress; });
startAutoBackups();
startCloudSync();
// the old sync list nothing reads: emptied in the background, after the first screen
emptyOldSyncListLater();
console.log(`  api   http://localhost:${port}`);
console.log(`  db    ${DB_PATH}`);

for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => { shutdown(); process.exit(0); });
