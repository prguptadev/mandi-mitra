/* The desktop app's life on a real Electron, end to end, in dev mode (needs the
 * Electron binary, `npm run build` and `npm run build:desktop-server`). Things
 * the packaged smoke test cannot do because they restart or close the app:
 *
 *   quit        closing the window writes the books into the main file and closes them
 *   restore     "Restore a backup" restarts the app, and the backup is put back
 *   crash       a crashed page is reloaded; a second crash restarts with software drawing
 *   damaged     damaged books: one plain sentence, Try again and Close on the splash
 *   second      a second start only brings the first one forward
 *   freeze      (SCEN_BIG=<copy of a big mandi.db>) the window's process stays free while the server works
 *
 * usage: SCEN_DIR=<an empty folder whose name contains "test"> node scripts/desktop-scenarios.mjs [names…]
 *        SCEN_MAIN=<folder with another electron/main.cjs> runs an older copy of the app for comparison.
 * Ports SCEN_PORT (default 13040) to +12. Test PINs only (a fresh first-run seed: Admin / 7747).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DIR = process.env.SCEN_DIR;
if (!DIR || !/test/i.test(DIR)) { console.error("SCEN_DIR must be a folder whose name contains 'test'"); process.exit(2); }
const PORT = Number(process.env.SCEN_PORT ?? 13040);
const CDP = PORT + 10;
const INSPECT = PORT + 11;
const APP = process.env.SCEN_MAIN ?? ROOT;
const ELECTRON = path.join(ROOT, "node_modules", "electron", process.platform === "darwin" ? "dist/Electron.app/Contents/MacOS/Electron" : process.platform === "win32" ? "dist/electron.exe" : "dist/electron");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const check = (label, ok, got) => {
  if (!ok) bad++;
  console.log(` ${ok ? "PASS" : "FAIL"}  ${label}${ok || got === undefined ? "" : `   ${typeof got === "string" ? got : JSON.stringify(got)}`}`);
};

function launch(ud, { extra = [], env = {} } = {}) {
  const p = spawn(ELECTRON, [APP, `--remote-debugging-port=${CDP}`, ...extra], {
    cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
    // (BL_*: what an instrumented copy of an older main.cjs reads instead, for comparing)
    env: { ...process.env, MANDI_USER_DATA_DIR: ud, MANDI_PORT: String(PORT), BL_UD: ud, BL_ROOT: ROOT, BL_PORT: String(PORT), ...env, ELECTRON_ENABLE_LOGGING: "" },
  });
  p.out = "";
  p.stdout.on("data", (d) => { p.out += d; });
  p.stderr.on("data", (d) => { p.out += d; });
  p.exited = new Promise((r) => p.on("exit", (code) => r(code)));
  return p;
}
const logOf = (ud) => { try { return fs.readFileSync(path.join(ud, "logs", "main.log"), "utf8"); } catch { return ""; } };
async function until(fn, ms, step = 100) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(step); }
  return null;
}
async function cdpTarget(match, ms = 20_000, port = CDP) {
  return until(async () => {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      return list.find((t) => (t.type === "page" || t.type === "node") && match(t.url ?? "")) ?? null;
    } catch { return null; }
  }, ms, 150);
}
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
  // a crashed or closed page never answers: give up after 10 s
  const send = (method, params = {}) => new Promise((ok) => {
    const i = ++id;
    const t = setTimeout(() => { pending.delete(i); ok({}); }, 10_000);
    pending.set(i, (d) => { clearTimeout(t); ok(d); });
    try { ws.send(JSON.stringify({ id: i, method, params })); } catch { clearTimeout(t); ok({}); }
  });
  const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
  return { send, evaluate, close: () => { try { ws.close(); } catch { /* closed */ } } };
}
const page = async (ms) => { const t = await cdpTarget((u) => u.startsWith(`http://127.0.0.1:${PORT}`), ms); return t ? connect(t.webSocketDebuggerUrl) : null; };
/** Signs in as the first-run Admin from inside the app's window (its requests carry the app's key). */
const signIn = (pg) => pg.evaluate(`(async () => {
  const users = await (await fetch("/api/auth/users")).json();
  const admin = users.find((u) => u.name === "Admin");
  const r = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: admin.id, pin: "7747" }) });
  return r.status;
})()`);
const fresh = (name) => { const d = path.join(DIR, name); fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); return d; };
const pidOf = (log, nth) => [...log.matchAll(/\[app\] start v\S+ pid (\d+)/g)].map((m) => Number(m[1]))[nth];
const kill = (pid) => { try { process.kill(pid); } catch { /* gone */ } };

const scenarios = {
  async quit() {
    const ud = fresh("quit");
    const p = launch(ud);
    const pg = await page();
    check("the window opens", Boolean(pg), p.out.slice(-400));
    await until(() => /window shown/.test(logOf(ud)), 15_000);
    await pg?.evaluate("window.close(), true").catch(() => undefined);
    const code = await Promise.race([p.exited, sleep(10_000).then(() => "still running")]);
    check("closing the window ends the app", code === 0, code);
    const db = path.join(ud, "data", "mandi.db");
    check("  ...with the books written into the main file and closed (no -wal side file left)", fs.existsSync(db) && !fs.existsSync(`${db}-wal`));
    check("  ...and the log says so", /\[app\] closed/.test(logOf(ud)), logOf(ud).slice(-300));
    if (code !== 0) p.kill();
  },

  async restore() {
    const ud = fresh("restore");
    const p = launch(ud);
    const pg = await page();
    await until(() => /window shown/.test(logOf(ud)), 15_000);
    check("signed in on the first-run books (test PIN)", (await signIn(pg)) === 200);
    const backup = await pg.evaluate('fetch("/api/backup/run", { method: "POST" }).then((r) => r.json())');
    check("a backup is taken", Boolean(backup?.name), backup);
    const r = await pg.evaluate(`fetch("/api/backup/restore", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: ${JSON.stringify(backup?.name)}, confirm: "RESTORE" }) }).then((r) => r.json())`);
    check("Restore says the app restarts by itself", r?.scheduled === true && r?.restarting === true, r);
    pg.close();
    const code = await Promise.race([p.exited, sleep(15_000).then(() => "still running")]);
    check("  ...the app closes", code === 0, code);
    const second = await until(() => { const l = logOf(ud); return /\[db\] restored/.test(l) && /window shown[\s\S]*window shown/.test(l) ? l : null; }, 30_000);
    check("  ...starts again, and puts the backup back before opening the books", Boolean(second), logOf(ud).slice(-600));
    const pg2 = await page();
    await pg2?.evaluate("window.close(), true").catch(() => undefined);
    await sleep(3000);
    kill(pidOf(logOf(ud), 1));
  },

  async crash() {
    const ud = fresh("crash");
    const p = launch(ud);
    let pg = await page();
    await until(() => /window shown/.test(logOf(ud)), 15_000);
    void pg.send("Page.crash"); await sleep(500);
    pg.close();
    const back = await until(async () => /the screens stopped/.test(logOf(ud)) && (await cdpTarget((u) => u.startsWith(`http://127.0.0.1:${PORT}`), 500)), 15_000, 300);
    pg = back ? await connect(back.webSocketDebuggerUrl) : null;
    const root = await until(async () => (await pg?.evaluate('document.getElementById("root")?.childElementCount || 0').catch(() => 0)) > 0, 15_000, 200);
    check("a crashed page is loaded again by itself", Boolean(root), logOf(ud).slice(-500));
    void pg?.send("Page.crash"); await sleep(500);
    pg?.close();
    const code = await Promise.race([p.exited, sleep(15_000).then(() => "still running")]);
    const again = await until(() => /graphics card off/.test(logOf(ud)) && /window shown[\s\S]*graphics card off[\s\S]*window shown/.test(logOf(ud)), 30_000, 300);
    check("a second crash starts the app again with software drawing", code === 0 && Boolean(again), logOf(ud).slice(-600));
    check("  ...and remembers it for this version (gpu-off.json)", fs.existsSync(path.join(ud, "gpu-off.json")));
    const pg2 = await page();
    await pg2?.evaluate("window.close(), true").catch(() => undefined);
    await sleep(3000);
    kill(pidOf(logOf(ud), 1));
  },

  async damaged() {
    const ud = fresh("damaged");
    fs.mkdirSync(path.join(ud, "data"), { recursive: true });
    fs.writeFileSync(path.join(ud, "data", "mandi.db"), "this is not a database ".repeat(400));
    const p = launch(ud);
    const t = await cdpTarget((u) => u.startsWith("data:text/html"));
    const sp = t ? await connect(t.webSocketDebuggerUrl) : null;
    const text = await until(async () => {
      const s = await sp?.evaluate('document.body.classList.contains("err") && document.getElementById("status").textContent').catch(() => null);
      return s || null;
    }, 20_000, 200);
    check("damaged books: the splash says one plain sentence", text === "Your books file could not be opened.", text);
    const shot = await sp?.send("Page.captureScreenshot", { format: "png" });
    if (shot?.result?.data) fs.writeFileSync(path.join(DIR, "splash-error.png"), Buffer.from(shot.result.data, "base64"));
    const buttons = await sp?.evaluate('[...document.querySelectorAll(".btns button")].map((b) => b.textContent + (b.offsetParent ? "" : " (hidden)")).join(", ")');
    check("  ...with Try again and Close, and where the log is", buttons === "Try again, Close" && /main\.log/.test(await sp?.evaluate('document.getElementById("log").textContent')), buttons);
    check("  ...the technical detail is in the log, not on screen", /SQLITE_NOTADB|file is not a database/.test(logOf(ud)));
    await sp?.evaluate('document.getElementById("again").click(), true');
    sp?.close();
    const code = await Promise.race([p.exited, sleep(10_000).then(() => "still running")]);
    const again = await until(() => (logOf(ud).match(/\[app\] start v/g) ?? []).length >= 2, 15_000);
    check("Try again starts the app again", code === 0 && Boolean(again), code);
    const t2 = await cdpTarget((u) => u.startsWith("data:text/html"));
    const sp2 = t2 ? await connect(t2.webSocketDebuggerUrl) : null;
    await until(async () => (await sp2?.evaluate('document.body.classList.contains("err")').catch(() => false)) === true, 20_000, 200);
    await sp2?.evaluate('document.getElementById("close").click(), true');
    sp2?.close();
    const pid2 = pidOf(logOf(ud), 1);
    const closed = await until(() => { try { process.kill(pid2, 0); return false; } catch { return true; } }, 10_000);
    check("Close ends the app", Boolean(closed));
    if (!closed) kill(pid2);
  },

  async second() {
    const ud = fresh("second");
    const p = launch(ud);
    await until(() => /window shown/.test(logOf(ud)), 15_000);
    const t0 = Date.now();
    const q = spawn(ELECTRON, [APP], { cwd: ROOT, stdio: "ignore", env: { ...process.env, MANDI_USER_DATA_DIR: ud, MANDI_PORT: String(PORT + 5) } });
    const code = await Promise.race([new Promise((r) => q.on("exit", r)), sleep(10_000).then(() => "still running")]);
    check("a second start ends at once and leaves the first one running", code === 0 && Date.now() - t0 < 8000 && p.exitCode === null, { code, ms: Date.now() - t0 });
    const pg = await page();
    await pg?.evaluate("window.close(), true").catch(() => undefined);
    await Promise.race([p.exited, sleep(8000)]);
    if (p.exitCode === null) p.kill();
  },

  async freeze() {
    if (!process.env.SCEN_BIG) { console.log(" (skipped: SCEN_BIG not set)"); return; }
    const ud = fresh("freeze");
    fs.mkdirSync(path.join(ud, "data"), { recursive: true });
    fs.copyFileSync(process.env.SCEN_BIG, path.join(ud, "data", "mandi.db"), fs.constants.COPYFILE_FICLONE);
    const p = launch(ud, { extra: [`--inspect=${INSPECT}`] });
    const pg = await page(90_000);
    await until(async () => (await pg?.evaluate('document.getElementById("root")?.childElementCount || 0').catch(() => 0)) > 0, 60_000, 200);
    check("signed in on the big books (test PIN from their notes)", (await signIn(pg)) === 200);
    const main = await cdpTarget(() => true, 10_000, INSPECT);
    const insp = main ? await connect(main.webSocketDebuggerUrl) : null;
    /* Heavy server work while the window's process is asked something every
       50 ms: a backup (copy, then a full quick_check of the copy, as the
       automatic backup does a minute after every start), and "Check the books". */
    for (const [label, call] of [["a backup", 'fetch("/api/backup/run", { method: "POST" }).then((r) => r.status)'], ["Check the books", 'fetch("/api/audit/books-check").then((r) => r.status)']]) {
      const job = pg.evaluate(call);
      const lags = [];
      let done = false;
      void job.then(() => { done = true; });
      const t0 = Date.now();
      while (!done && Date.now() - t0 < 180_000) {
        const s = Date.now();
        await insp?.evaluate("1");
        lags.push(Date.now() - s);
        await sleep(50);
      }
      const status = await job;
      const worst = Math.max(...lags);
      console.log(`   ${label} took ${Date.now() - t0} ms; the window's process answered within ${worst} ms at worst (${lags.length} probes)`);
      check(`during ${label}, the window's process stays free (worst answer under 100 ms)`, status === 200 && worst < 100, { status, worst });
    }
    insp?.close();
    await pg.evaluate("window.close(), true").catch(() => undefined);
    await Promise.race([p.exited, sleep(10_000)]);
    if (p.exitCode === null) p.kill();
  },
};

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(scenarios);
for (const n of names) {
  console.log(`Desktop scenario: ${n}`);
  try { await scenarios[n](); } catch (e) { bad++; console.log(` FAIL  ${n}: ${e && e.stack}`); }
  await sleep(500);
}
console.log(bad === 0 ? "\nAll desktop scenarios behave." : `\n${bad} desktop scenario check(s) FAILED`);
process.exit(bad === 0 ? 0 : 1);
