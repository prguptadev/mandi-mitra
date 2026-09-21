/* A real Postgres, in-process (PGlite), for the end-to-end tests of the
 * cloud sync — no Supabase account, no network. PGlite takes one connection
 * at a time, so a small queue in front lets several app servers (several
 * "computers") connect: each connection waits its turn, like short syncs do.
 * port+2000 takes POST /down and /up, so a test can pull the "internet".
 *   npx tsx scripts/fake-postgres.ts 8796
 */
import net from "node:net";
import http from "node:http";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const port = Number(process.argv[2] ?? 8796);
const inner = port + 1000;
const db = await PGlite.create();
const server = new PGLiteSocketServer({ db, port: inner, host: "127.0.0.1" });
await server.start();

const waiting: net.Socket[] = [];
let busy = false;
function next() {
  if (busy) return;
  const client = waiting.shift();
  if (!client) return;
  if (client.destroyed) return next();
  busy = true;
  const upstream = net.connect(inner, "127.0.0.1");
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    client.destroy(); upstream.destroy();
    // let PGlite settle the old session before the next one starts
    setTimeout(() => { busy = false; next(); }, 20);
  };
  client.on("close", finish); upstream.on("close", finish);
  client.on("error", finish); upstream.on("error", finish);
  client.resume();
  client.pipe(upstream); upstream.pipe(client);
}
let down = false;
const front = net.createServer((sock) => {
  if (down) { sock.destroy(); return; }
  sock.pause(); waiting.push(sock); next();
});
http.createServer((req, res) => {
  if (req.url === "/down") down = true;
  if (req.url === "/up") down = false;
  res.end(down ? "down" : "up");
}).listen(port + 2000, "127.0.0.1");
front.listen(port, "127.0.0.1", () => console.log(`fake postgres on ${port}`));
process.on("SIGTERM", async () => { front.close(); await server.stop(); await db.close(); process.exit(0); });
