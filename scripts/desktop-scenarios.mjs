/* The desktop app's life on a real Electron, end to end, in dev mode (needs the
 * Electron binary, `npm run build` and `npm run build:desktop-server`). Things
 * the packaged smoke test cannot do because they restart or close the app:
 *
 *   quit        closing the window takes the closing backup, writes the books into the main file and closes them
 *   restore     "Restore a backup" restarts the app, and the backup is put back
 *   crash       a crashed page is reloaded; a second crash restarts with software drawing
 *   damaged     damaged books and no backup: the window says only why, and the file is left as it was
 *   recover     damaged, then missing books: the newest good backup is put back and the first screen says so
 *   badupdate   an update that cannot open the books: one sentence, "Go back to version …" and Close on the splash;
 *               Go back starts the kept installer and the app leaves
 *   second      a second start only brings the first one forward
 *   freeze      (SCEN_BIG=<copy of a big mandi.db>) the window's process stays free while the server works
 *
 * usage: SCEN_DIR=<an empty folder whose name contains "test"> node scripts/desktop-scenarios.mjs [names…]
 *        SCEN_MAIN=<folder with another electron/main.cjs> runs an older copy of the app for comparison.
 *        SCEN_ELECTRON=<the Electron binary> when it is not in node_modules/electron/dist.
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
const ELECTRON = process.env.SCEN_ELECTRON ?? path.join(ROOT, "node_modules", "electron", process.platform === "darwin" ? "dist/Electron.app/Contents/MacOS/Electron" : process.platform === "win32" ? "dist/electron.exe" : "dist/electron");
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
    check("  ...cleanly (no check of the file at the next start)", !fs.existsSync(path.join(ud, "data", "books-open.json")));
    const backups = (() => { try { return fs.readdirSync(path.join(ud, "data", "backups")); } catch { return []; } })();
    check("  ...after the day's work went into a backup (taken by the books' own process)", backups.some((n) => /^auto-\d{8}-\d{6}\.db$/.test(n)) && /closing backup auto-/.test(logOf(ud)), backups);
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
    const db = path.join(ud, "data", "mandi.db");
    const garbage = "this is not a database ".repeat(400);
    fs.writeFileSync(db, garbage);
    const p = launch(ud);
    const pg = await page();
    const said = await until(async () => {
      const t = await pg?.evaluate('document.body.innerText').catch(() => "");
      return t && t.includes("could not be opened") ? t : null;
    }, 20_000, 200);
    check("damaged books and no backup: the window says only why", Boolean(said) && /The books file could not be opened and no backup could be put back/.test(said ?? ""), (said ?? "").slice(0, 200));
    const shot = await pg?.send("Page.captureScreenshot", { format: "png" });
    if (shot?.result?.data) fs.writeFileSync(path.join(DIR, "damaged-window.png"), Buffer.from(shot.result.data, "base64"));
    check("  ...the technical detail is in the log", /SQLITE_NOTADB|file is not a database|nothing is opened/.test(logOf(ud)), logOf(ud).slice(-400));
    await pg?.evaluate("window.close(), true").catch(() => undefined);
    const code = await Promise.race([p.exited, sleep(15_000).then(() => "still running")]);
    check("  ...the window closes the app as usual", code === 0, code);
    check("  ...and the damaged file is left exactly as it was (nothing deleted, nothing written)", fs.readFileSync(db, "utf8") === garbage);
    if (code !== 0) p.kill();
  },

  async recover() {
    const ud = fresh("recover");
    const db = path.join(ud, "data", "mandi.db");
    // books with a backup of their own: a first start, a backup, a normal close
    let p = launch(ud);
    let pg = await page();
    await until(() => /window shown/.test(logOf(ud)), 15_000);
    check("signed in on the first-run books (test PIN)", (await signIn(pg)) === 200);
    const backup = await pg.evaluate('fetch("/api/backup/run", { method: "POST" }).then((r) => r.json())');
    check("a backup is taken", Boolean(backup?.name), backup);
    await pg.evaluate("window.close(), true").catch(() => undefined);
    let code = await Promise.race([p.exited, sleep(15_000).then(() => "still running")]);
    if (code !== 0) p.kill();

    const opened = async (why, notice) => {
      const pg2 = await page();
      const shown = await until(() => /window shown/.test(logOf(ud).split("[app] start v").pop() ?? ""), 20_000);
      check(`  ...the app opens on it (in the books' own process)`, Boolean(pg2 && shown) && /server ready in its own process/.test(logOf(ud).split("[app] start v").pop() ?? ""));
      check(`  ...the log says which backup was put back`, new RegExp(`the books file was ${why}: put back ${backup?.name}`).test(logOf(ud)), logOf(ud).slice(-500));
      check("  ...signed in", (await signIn(pg2)) === 200);
      const n = await pg2.evaluate('fetch("/api/backup/notice").then((r) => r.json())');
      check("  ...the notice names the backup", n?.start?.kind === "restored" && n?.start?.why === why && n?.start?.backup === backup?.name, n);
      await pg2.evaluate("location.reload(), true").catch(() => undefined);
      const line = await until(async () => {
        const t = await pg2.evaluate('(document.querySelector("[role=alert]") || {}).textContent || ""').catch(() => "");
        return t && t.includes(notice) ? t : null;
      }, 20_000, 300);
      check("  ...and the first screen says it in one line", Boolean(line), line);
      const shot = await pg2.send("Page.captureScreenshot", { format: "png" });
      if (shot?.result?.data) fs.writeFileSync(path.join(DIR, `recover-${why}.png`), Buffer.from(shot.result.data, "base64"));
      await pg2.evaluate("window.close(), true").catch(() => undefined);
    };

    // damaged: the file's first bytes overwritten
    const fd = fs.openSync(db, "r+");
    fs.writeSync(fd, Buffer.from("this is no longer a database file"), 0, 33, 0);
    fs.closeSync(fd);
    const damagedBytes = fs.readFileSync(db);
    console.log("   (the books file damaged)");
    p = launch(ud);
    await opened("damaged", "The books file was damaged, so the backup from");
    code = await Promise.race([p.exited, sleep(15_000).then(() => "still running")]);
    if (code !== 0) p.kill();
    const kept = (() => { try { return fs.readdirSync(path.join(ud, "data", "backups")).filter((n) => /^damaged-.*\.db$/.test(n)); } catch { return []; } })();
    check("  ...the damaged file is kept in backups, byte for byte", kept.length === 1 && fs.readFileSync(path.join(ud, "data", "backups", kept[0])).equals(damagedBytes), kept);

    // missing: the file gone
    for (const side of ["", "-wal", "-shm"]) fs.rmSync(db + side, { force: true });
    console.log("   (the books file deleted)");
    p = launch(ud);
    await opened("missing", "The books file was missing, so the backup from");
    code = await Promise.race([p.exited, sleep(15_000).then(() => "still running")]);
    check("  ...and closes as usual", code === 0, code);
    if (code !== 0) p.kill();
  },

  async badupdate() {
    const ud = fresh("badupdate");
    const db = path.join(ud, "data", "mandi.db");
    // books at this version's schema
    let p = launch(ud);
    let pg = await page();
    await until(() => /window shown/.test(logOf(ud)), 15_000);
    await pg?.evaluate("window.close(), true").catch(() => undefined);
    let code = await Promise.race([p.exited, sleep(15_000).then(() => "still running")]);
    if (code !== 0) p.kill();
    // the next version's update fails half way (its SQL is wrong), and the version before is kept here
    const mig = path.join(DIR, "badupdate-migrations");
    fs.rmSync(mig, { recursive: true, force: true });
    fs.cpSync(path.join(ROOT, "desktop-build", "migrations"), mig, { recursive: true });
    const jp = path.join(mig, "meta", "_journal.json");
    const j = JSON.parse(fs.readFileSync(jp, "utf8"));
    const last = j.entries[j.entries.length - 1];
    j.entries.push({ idx: last.idx + 1, version: last.version, when: last.when + 1000, tag: "0099_scen_bad", breakpoints: true });
    fs.writeFileSync(jp, JSON.stringify(j, null, 2));
    fs.writeFileSync(path.join(mig, "0099_scen_bad.sql"), "ALTER TABLE no_such_table ADD COLUMN x integer;");
    const inst = path.join(DIR, "badupdate-installers");
    fs.rmSync(inst, { recursive: true, force: true });
    fs.mkdirSync(inst, { recursive: true });
    const ran = path.join(DIR, "badupdate-installer-ran.txt");
    fs.rmSync(ran, { force: true });
    // a stand-in for the kept installer: it only writes down how it was started
    fs.writeFileSync(path.join(inst, "MandiMitra-Setup-0.0.1.exe"), `#!/bin/sh\necho "$@" > "${ran}"\n`, { mode: 0o755 });
    const before = { size: fs.statSync(db).size, ino: fs.statSync(db).ino };
    p = launch(ud, { env: { MANDI_MIGRATIONS_DIR: mig, MANDI_INSTALLERS_DIR: inst } });
    const t = await cdpTarget((u) => u.startsWith("data:text/html"));
    const sp = t ? await connect(t.webSocketDebuggerUrl) : null;
    const text = await until(async () => {
      const s2 = await sp?.evaluate('document.body.classList.contains("err") && document.getElementById("status").textContent').catch(() => null);
      return s2 || null;
    }, 30_000, 200);
    check("an update that cannot open the books: the splash says one plain sentence", text === "This version could not open your books; they are as they were.", text);
    const buttons = await sp?.evaluate('[...document.querySelectorAll(".btns button")].map((b) => b.textContent).join(", ")');
    check("  ...with Go back to the kept version, and Close", buttons === "Go back to version 0.0.1, Close", buttons);
    const shot = await sp?.send("Page.captureScreenshot", { format: "png" });
    if (shot?.result?.data) fs.writeFileSync(path.join(DIR, "badupdate-splash.png"), Buffer.from(shot.result.data, "base64"));
    check("  ...the books are as they were (same file, nothing swapped)", fs.statSync(db).size === before.size && fs.statSync(db).ino === before.ino);
    check("  ...and closed cleanly by the books' process before it left", !fs.existsSync(`${db}-wal`) && !fs.existsSync(path.join(ud, "data", "books-open.json")));
    check("  ...the cause is in the log", /no_such_table|no such table/.test(logOf(ud)));
    await sp?.evaluate('document.getElementById("again").click(), true');
    sp?.close();
    code = await Promise.race([p.exited, sleep(10_000).then(() => "still running")]);
    const args = await until(() => { try { return fs.readFileSync(ran, "utf8").trim(); } catch { return null; } }, 5000);
    check("Go back starts the kept installer quietly, told to wait for the app", args === "/S --force-run --updated", args);
    check("  ...and the app leaves", code === 0, code);
    if (code !== 0) p.kill();
    let upd = null;
    try { upd = JSON.parse(fs.readFileSync(path.join(ud, "data", "update.json"), "utf8")); } catch { /* none */ }
    check("  ...and this version is not offered again", Array.isArray(upd?.skip) && upd.skip.length === 1, upd);
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
