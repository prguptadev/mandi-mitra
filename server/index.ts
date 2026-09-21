import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { runMigrations } from "./db/migrate.ts";
import { recoverInterruptedScans } from "./routes/scans.ts";
import { DB_PATH } from "./db/client.ts";
import { startAutoBackups } from "./lib/backup.ts";

const port = Number(process.env.PORT ?? 8787);
runMigrations();
const recovered = recoverInterruptedScans();
if (recovered) console.log(`[scan] reset ${recovered} interrupted read(s)`);
serve({ fetch: createApp().fetch, port });
startAutoBackups();
console.log(`  api   http://localhost:${port}`);
console.log(`  db    ${DB_PATH}`);
