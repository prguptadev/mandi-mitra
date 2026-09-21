/* A real Postgres, in-process (PGlite), for the end-to-end tests of the
 * cloud copy — no Supabase account, no network. Listens on the port given.
 *   npx tsx scripts/fake-postgres.ts 8796
 */
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const port = Number(process.argv[2] ?? 8796);
const db = await PGlite.create();
const server = new PGLiteSocketServer({ db, port, host: "127.0.0.1" });
await server.start();
console.log(`fake postgres on ${port}`);
process.on("SIGTERM", async () => { await server.stop(); await db.close(); process.exit(0); });
