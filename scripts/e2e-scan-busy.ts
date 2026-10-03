import "./_guard.ts";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

/* A scan from the scanner outlives the screen that started it: the owner left
 * the Scan page mid-scan, came back, and found the Scan button on again.
 *   - While a scan runs, GET /api/scanner says so (with the sheet it fills, to
 *     whoever started it) and a second press is refused, in plain words.
 *   - Once it ends the scanner is free and the next page goes on the sheet.
 *   - A scan that hangs lets go of the scanner after the limit.
 * On a server of its own, with a slow stand-in scanner, on a copy of the test
 * books (the test books themselves are only read).
 * Run through: npm run test:e2e
 */

const OFF = Number(process.env.E2E_PORT_OFFSET ?? 0);
// its own port: the desktop and maths scripts run their servers on 8804 to 8807
const PORT = 8808 + OFF;
const BASE = `http://127.0.0.1:${PORT}/api`;
const PIN = process.env.MANDI_PIN ?? "482915";
const DIR = path.resolve("data-test-scan-busy");
const SRC = path.join(process.env.MANDI_DATA_DIR!, "mandi.db");
const BUSY = "A scan is already running on this scanner.";

let bad = 0;
const check = (label: string, ok: boolean, got?: unknown) => {
  if (!ok) bad++;
  console.log(` ${ok ? "PASS" : "FAIL"}  ${label}${ok || got === undefined ? "" : `   ${JSON.stringify(got).slice(0, 400)}`}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The real server on the copy, its scanner as slow as asked. */
async function serve(env: Record<string, string>) {
  const child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    env: { ...process.env, MANDI_DATA_DIR: DIR, PORT: String(PORT), MANDI_API: BASE, MANDI_NO_AUTO_BACKUP: "1", MANDI_NO_SEED: "1", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout!.on("data", (d) => { log += d; });
  child.stderr!.on("data", (d) => { log += d; });
  let up = false;
  for (let i = 0; i < 160 && child.exitCode === null && !up; i++) {
    try { up = (await fetch(`${BASE}/health`)).ok; } catch { await sleep(250); }
  }
  if (!up) throw new Error("the scan-busy server did not start:\n" + log.slice(-2000));
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const gone = new Promise((r) => child.once("exit", r));
    child.kill();
    await gone;
  };
  return { stop };
}

/** One signed-in user; a press that is still scanning can be let go of (abort). */
async function session(name: string, pin: string) {
  let cookie = "";
  const req = async (method: string, p: string, body?: unknown, signal?: AbortSignal) => {
    const res = await fetch(BASE + p, {
      method, signal, headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = res.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  const users = (await req("GET", "/auth/users")).json;
  const u = users.find((x: any) => x.name === name);
  if ((await req("POST", "/auth/login", { userId: u.id, pin })).status !== 200) throw new Error(`login ${name}`);
  const me = (await req("GET", "/auth/me")).json;
  const vldm = me.businesses.find((b: any) => b.shortCode === "VLDM");
  if (vldm && me.activeBusinessId !== vldm.businessId) await req("POST", "/auth/switch-business", { businessId: vldm.businessId });
  return req;
}

fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });
execFileSync("sqlite3", [SRC, `.backup ${path.join(DIR, "mandi.db")}`]);

let srv: Awaited<ReturnType<typeof serve>> | null = null;
const held: AbortController[] = [];
try {
  console.log("A slow scan (1.5 s)");
  srv = await serve({ MANDI_FAKE_SCANNER_DELAY_MS: "1500" });
  const owner = await session("Test Owner", PIN);
  const munshi = await session("Munshi Ji", "271830");
  const j1509 = ((await owner("GET", "/jins")).json as any[]).find((j) => j.code === "1509");
  check("the scanner is free to start with", (await owner("GET", "/scanner")).json?.busy === null);

  const first = owner("POST", "/scanner/scan", { dpi: 300, color: true, slipDate: "2026-09-24", jinsId: j1509.id });
  await sleep(400);
  const during = (await owner("GET", "/scanner")).json;
  check("while it scans, the screen opened again is told a scan is running", typeof during?.busy?.since === "number" && during.busy.sheetId === null, during);
  const again = await owner("POST", "/scanner/scan", { dpi: 300, color: true });
  check("a second press is refused (409) in one plain sentence", again.status === 409 && again.json?.error === BUSY && again.json?.code === "scanner_busy", again);
  const other = await munshi("POST", "/scanner/scan", { dpi: 300, color: true });
  check("…for another user too: the scanner is the computer's", other.status === 409, other.status);
  const p1 = await first;
  check("the scan that was running finishes and starts its sheet", p1.status === 200 && p1.json?.pages === 1, p1);
  check("then the scanner is free", (await owner("GET", "/scanner")).json?.busy === null);

  const second = owner("POST", "/scanner/scan", { dpi: 300, color: true, scanId: p1.json.id });
  await sleep(400);
  const mine = (await owner("GET", "/scanner")).json;
  check("page 2 scanning: whoever started it is told which sheet it fills", mine?.busy?.sheetId === p1.json.id, mine);
  const theirs = (await munshi("GET", "/scanner")).json;
  check("…anyone else only that the scanner is busy", Boolean(theirs?.busy) && theirs.busy.sheetId === null, theirs);
  const p2 = await second;
  check("a new scan works once the first is done: page 2 joins the sheet", p2.status === 200 && p2.json?.id === p1.json.id && p2.json?.pages === 2, p2);
  check("and the scanner is free again", (await owner("GET", "/scanner")).json?.busy === null);
  await owner("DELETE", `/scans/${p1.json.id}`);
  await srv.stop();

  console.log("\nA scan that hangs (the limit cut to 1.5 s)");
  srv = await serve({ MANDI_FAKE_SCANNER_DELAY_MS: "600000", MANDI_SCAN_LIMIT_MS: "1500" });
  const op = await session("Test Owner", PIN);
  const press = () => {
    const a = new AbortController();
    held.push(a);
    return op("POST", "/scanner/scan", { dpi: 300, color: true }, a.signal).catch(() => null);
  };
  const t0 = Date.now();
  void press();
  await sleep(400);
  const stuck = (await op("GET", "/scanner")).json;
  check("a stuck scan holds the scanner at first", typeof stuck?.busy?.since === "number", stuck);
  check("…and a second press is refused", (await op("POST", "/scanner/scan", { dpi: 300, color: true })).status === 409);
  await sleep(Math.max(0, t0 + 2000 - Date.now()));
  check("after the limit it lets go of the scanner", (await op("GET", "/scanner")).json?.busy === null);
  const next = press();
  const quick = await Promise.race([next, sleep(500).then(() => "scanning")]);
  const now = (await op("GET", "/scanner")).json;
  check("a new scan can start (not refused)", quick === "scanning" && now?.busy?.since > stuck.busy.since, { quick, now });
} finally {
  for (const a of held) a.abort();
  await srv?.stop();
  fs.rmSync(DIR, { recursive: true, force: true });
}

console.log(bad === 0 ? "\nA scan in progress keeps the scanner busy, and lets go." : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
