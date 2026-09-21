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
// the desktop app listens on this computer only (MANDI_HOST=127.0.0.1)
serve({ fetch: createApp().fetch, port, ...(process.env.MANDI_HOST ? { hostname: process.env.MANDI_HOST } : {}) });
startAutoBackups();
console.log(`  api   http://localhost:${port}`);
console.log(`  db    ${DB_PATH}`);
