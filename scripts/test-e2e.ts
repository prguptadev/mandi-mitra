/* Runs the end-to-end checks against a throwaway database and a separate server.
 * The real database is never opened. Usage: npm run test:e2e
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PORT = "8799";
const DATA = path.resolve("data-test");
const env = { ...process.env, MANDI_DATA_DIR: DATA, MANDI_API: `http://localhost:${PORT}/api`, PORT };

fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
// the scans need a real-sized sheet image; copy one if the owner has any, else use a placeholder
const server = spawn("npx", ["tsx", "server/index.ts"], { env, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
server.stdout.on("data", (d) => { log += d; });
server.stderr.on("data", (d) => { log += d; });

async function up() {
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(`${env.MANDI_API}/health`)).ok) return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("test server did not start:\n" + log);
}

let failed = 0;
try {
  await up();
  const run = (script: string) => {
    try {
      execFileSync("npx", ["tsx", script], { env, stdio: "inherit" });
    } catch { failed++; }
  };
  run("scripts/dev-bootstrap.ts");
  run("server/db/seed.ts");
  run("scripts/e2e-daily-list.ts");
  run("scripts/e2e-scan-review.ts");
  run("scripts/e2e-loads.ts");
} finally {
  server.kill();
  fs.rmSync(DATA, { recursive: true, force: true });
}
console.log(failed === 0 ? "\nAll end-to-end checks passed (test database, discarded)." : `\n${failed} end-to-end script(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
