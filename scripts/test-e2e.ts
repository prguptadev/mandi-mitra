/* Runs the end-to-end checks against a throwaway database and a separate server.
 * The real database is never opened. Usage: npm run test:e2e
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// several copies can run side by side (one per worktree): E2E_PORT_OFFSET=100 moves every port up by 100
const OFF = Number(process.env.E2E_PORT_OFFSET ?? 0);
const PORT = String(8799 + OFF);
const DATA = path.resolve("data-test");
// Gemini is a local stand-in: no real key, no real read
const FAKE_GEMINI = 8797 + OFF;
// a stand-in for the UP e-Mandi portal: the real mandi site is never called
const FAKE_EMANDI = 8795 + OFF;
// a stand-in scanner: every "scan" returns this small JPEG
const FAKE_PAGE = path.join(DATA, "fake-scanner-page.jpg");
const env = {
  ...process.env, MANDI_DATA_DIR: DATA, MANDI_API: `http://127.0.0.1:${PORT}/api`, PORT,
  MANDI_GEMINI_BASE: `http://127.0.0.1:${FAKE_GEMINI}`,
  MANDI_EMANDI_BASE: `http://127.0.0.1:${FAKE_EMANDI}`,
  MANDI_FAKE_SCANNER: FAKE_PAGE, MANDI_NO_AUTO_BACKUP: "1",
  // a real Postgres in-process, standing in for Supabase
  MANDI_FAKE_PG: `postgresql://postgres:test-only@127.0.0.1:${8796 + OFF}/postgres`,
  MANDI_NO_GITHUB: "1",
  // A is set up by sign-up below, like the first computer before v0.3
  MANDI_NO_SEED: "1",
  // two more "computers" for the sync test: B is a new install (Admin / 7747),
  // C an empty one that joins from the first screen
  MANDI_API_B: `http://127.0.0.1:${8802 + OFF}/api`, MANDI_DATA_DIR_B: path.resolve("data-test-b"),
  MANDI_API_C: `http://127.0.0.1:${8803 + OFF}/api`, MANDI_DATA_DIR_C: path.resolve("data-test-c"),
};
// its own process: execFileSync below blocks this one while each test runs
const fake = spawn("npx", ["tsx", "scripts/fake-gemini.ts", String(FAKE_GEMINI)], { stdio: "ignore" });
const fakePg = spawn("npx", ["tsx", "scripts/fake-postgres.ts", String(8796 + OFF)], { stdio: "ignore" });
const fakeEmandi = spawn("npx", ["tsx", "scripts/fake-emandi.ts", String(FAKE_EMANDI)], { stdio: "ignore" });

const OTHERS = [env.MANDI_DATA_DIR_B, env.MANDI_DATA_DIR_C];
for (const d of [DATA, ...OTHERS]) { fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); }
fs.writeFileSync(FAKE_PAGE, Buffer.from("/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==", "base64"));
// the scans need a real-sized sheet image; copy one if the owner has any, else use a placeholder
const server = spawn("npx", ["tsx", "server/index.ts"], { env, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
server.stdout.on("data", (d) => { log += d; });
server.stderr.on("data", (d) => { log += d; });
const others = [
  spawn("npx", ["tsx", "server/index.ts"], { env: { ...env, MANDI_DATA_DIR: env.MANDI_DATA_DIR_B, PORT: String(8802 + OFF), MANDI_NO_SEED: "0" }, stdio: ["ignore", "pipe", "pipe"] }),
  spawn("npx", ["tsx", "server/index.ts"], { env: { ...env, MANDI_DATA_DIR: env.MANDI_DATA_DIR_C, PORT: String(8803 + OFF) }, stdio: ["ignore", "pipe", "pipe"] }),
];
for (const o of others) { o.stdout!.on("data", (d) => { log += d; }); o.stderr!.on("data", (d) => { log += d; }); }

async function up() {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${env.MANDI_API}/health`)).ok && (await fetch(`${env.MANDI_GEMINI_BASE}/__calls`)).ok
        && (await fetch(`${env.MANDI_API_B}/health`)).ok && (await fetch(`${env.MANDI_API_C}/health`)).ok) return;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("test server did not start:\n" + log);
}

let failed = 0;
try {
  await up();
  const run2 = (script: string, arg: string) => {
    try {
      execFileSync("npx", ["tsx", script, arg], { env, stdio: "inherit" });
    } catch { failed++; }
  };
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
  run("scripts/e2e-accounts.ts");
  run("scripts/e2e-mill-money.ts");
  run("scripts/e2e-gemini.ts");
  run("scripts/e2e-scanner-backup.ts");
  run("scripts/e2e-rbac.ts");
  run("scripts/e2e-update.ts");
  run("scripts/e2e-tally.ts");
  run("scripts/e2e-days.ts");
  run("scripts/e2e-isolation.ts");
  run("scripts/e2e-ca.ts");
  run("scripts/e2e-multi.ts");
  run("scripts/e2e-cloud.ts");
  run("scripts/e2e-math-fixes.ts");
  run("scripts/e2e-sync-scans.ts");
  run("scripts/e2e-sync-single.ts");
  run("scripts/e2e-sync-restore.ts");
  run("scripts/e2e-sync-trucks.ts");
  run("scripts/e2e-emandi.ts");
  run("scripts/e2e-startup.ts");
  run("scripts/e2e-dates.ts");
  // the same day maths from a laptop set to another country
  try {
    execFileSync("npx", ["tsx", "scripts/e2e-dates.ts"], { env: { ...env, TZ: "Asia/Kolkata" }, stdio: "inherit" });
    execFileSync("npx", ["tsx", "scripts/e2e-dates.ts"], { env: { ...env, TZ: "Europe/London" }, stdio: "inherit" });
  } catch { failed++; }
  // last: every stored figure the tests produced, re-worked independently
  // on every computer: the synced copies must add up exactly like the first
  for (const d of [DATA, ...OTHERS]) {
    execFileSync("sqlite3", [path.join(d, "mandi.db"), `.backup ${path.join(d, "audit-copy.db")}`]);
    run2("scripts/money-check.ts", path.join(d, "audit-copy.db"));
  }
} finally {
  // a failing run shows the test server's own last words
  if (failed) console.log("\n--- test server log (last 40 lines) ---\n" + log.trim().split("\n").slice(-40).join("\n"));
  server.kill();
  for (const o of others) o.kill();
  fake.kill();
  fakePg.kill();
  fakeEmandi.kill();
  for (const d of [DATA, ...OTHERS]) fs.rmSync(d, { recursive: true, force: true });
}
console.log(failed === 0 ? "\nAll end-to-end checks passed (test database, discarded)." : `\n${failed} end-to-end script(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
