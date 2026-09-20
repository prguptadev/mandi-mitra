import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { runMigrations } from "./db/migrate.ts";
import { DB_PATH } from "./db/client.ts";

const port = Number(process.env.PORT ?? 8787);
runMigrations();
serve({ fetch: createApp().fetch, port });
console.log(`  api   http://localhost:${port}`);
console.log(`  db    ${DB_PATH}`);
