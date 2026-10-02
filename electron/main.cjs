/* Mandi Mitra desktop app (Windows).
 *
 * Starts the API server on this computer only (127.0.0.1), with its data in
 * the user's AppData folder, and shows the screens in a window. The server
 * runs in its own process (server-host.cjs), so a long database job never
 * freezes the window; if that process cannot run, the server runs inside the
 * app as before. Scanning, printing and downloads work as in the browser.
 *
 * The installed app is locked down: no developer tools, no reload keys, no
 * debugging switches (see lockdown.cjs and the fuses in electron-builder.yml),
 * and the server answers only this app's windows (a per-launch key, checked by
 * server/lib/desktopGate.ts), so Chrome or Edge on the same PC cannot use it.
 *
 * `--smoke-test` starts everything off-screen on a throwaway data folder,
 * checks it, prints SMOKE OK or SMOKE FAIL and exits 0 or 1: the build
 * pipeline uses it to prove the packaged app runs and is locked down. With
 * `--smoke-quit` as well, a passing run then closes the way a normal close
 * does (the closing backup, then the books closed) and checks that too.
 */
"use strict";
const { app, BrowserWindow, shell, dialog, Menu, nativeTheme, session, utilityProcess, ipcMain } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const net = require("node:net");
const crypto = require("node:crypto");
const { pathToFileURL } = require("node:url");
const { spawn } = require("node:child_process");
const lockdown = require("./lockdown.cjs");
const { openLog, mirrorConsole } = require("./log.cjs");

const argv = process.argv;
const smoke = argv.includes("--smoke-test");
const smokeQuit = smoke && argv.includes("--smoke-quit");
/** The installed app, or a dev run started with --locked to try the lock-down. */
const locked = app.isPackaged || argv.includes("--locked");
const dev = !app.isPackaged;

/* 1. Debugging switches: refused before anything else starts (exit code 3). */
if (locked) {
  const bad = lockdown.bannedSwitches(argv.slice(1));
  if (bad.length) {
    for (const s of bad) { try { app.commandLine.removeSwitch(s); } catch { /* gone anyway */ } }
    try { process.stderr.write(`Mandi Mitra does not start with: ${bad.map((s) => `--${s}`).join(" ")}\n`); } catch { /* no terminal */ }
    app.exit(3);
    return; // (CommonJS: nothing below runs)
  }
}

/* 2. The data folder, pinned to %APPDATA%\mandi-mitra (where every install so
   far has kept it), so a future product name can never hide the books. A smoke
   test gets a throwaway folder and never opens the real books, even while the
   app is running. A dev run may point elsewhere for testing; the installed app
   cannot. */
const userData = smoke
  ? fs.mkdtempSync(path.join(os.tmpdir(), "mandi-smoke-test-"))
  : dev && process.env.MANDI_USER_DATA_DIR
    ? path.resolve(process.env.MANDI_USER_DATA_DIR)
    : path.join(app.getPath("appData"), "mandi-mitra");
fs.mkdirSync(userData, { recursive: true });
app.setPath("userData", userData);
const DATA_DIR = dev && !smoke && process.env.MANDI_DATA_DIR ? path.resolve(process.env.MANDI_DATA_DIR) : path.join(userData, "data");
const DB_PATH = path.join(DATA_DIR, "mandi.db");
/** There while the server has the books open; its clean close removes it (server/db/client.ts). */
const OPEN_MARK = path.join(DATA_DIR, "books-open.json");

/* 3. The log: start-up steps, errors and the server's own output. */
const log = openLog(path.join(userData, "logs"));
mirrorConsole(log);
const info = (...a) => console.log("[app]", ...a);
const since = () => `${Math.round(process.uptime() * 1000)} ms`;
info(`start v${app.getVersion()} pid ${process.pid}${app.isPackaged ? "" : " (dev)"}${locked ? " locked" : ""}${smoke ? " smoke-test" : ""}; data ${DATA_DIR}`);
process.on("uncaughtException", (e) => console.error("[app] uncaught error:", e));
process.on("unhandledRejection", (e) => console.error("[app] unhandled rejection:", e));

/* 4. Software drawing when the graphics card has failed this app before (or on a relaunch for that). */
const GPU_FLAG = path.join(userData, "gpu-off.json");
const gpuOff = argv.includes("--gpu-off") || (() => {
  try { return JSON.parse(fs.readFileSync(GPU_FLAG, "utf8")).version === app.getVersion(); } catch { return false; }
})();
if (gpuOff) { app.disableHardwareAcceleration(); info("graphics card off (software drawing)"); }

/* 5. One copy at a time: a second start only brings the first one forward. */
if (!smoke && !app.requestSingleInstanceLock()) { app.exit(0); return; }
// the taskbar groups and labels the app by this id (matches electron-builder's appId)
if (process.platform === "win32") app.setAppUserModelId("in.vijaylaxmi.mandimitra");

const ICON = path.join(__dirname, "icon.png");
const SPLASH = path.join(__dirname, "splash.html");
const BG = () => (nativeTheme.shouldUseDarkColors ? "#16181b" : "#fbfaf7");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** The request header that carries this launch's key; Chrome on the same PC never has it. */
const KEY_HEADER = "x-mandi-desktop";
const KEY = crypto.randomBytes(32).toString("base64url");

/* Where the app's files are: inside app.asar (main, splash) and beside it, unpacked (server, screens, database module). */
const ROOT = app.getAppPath();
const UNPACKED = ROOT.replace(/app\.asar$/, "app.asar.unpacked");
const SERVER_BUNDLE = path.join(UNPACKED, "desktop-build", "server", "index.mjs");
const SERVER_HOST = path.join(UNPACKED, "electron", "server-host.cjs");

let base = "";
const ours = (url) => { try { return Boolean(base) && new URL(url).origin === base; } catch { return false; } };
const opened = [];
/** Web links (AI Studio, WhatsApp, GitHub) open in the normal browser; nothing else is opened at all. */
const outside = (url) => {
  try {
    if (new URL(url).protocol !== "https:") return;
    if (smoke) { opened.push(url); return; }
    void shell.openExternal(url);
  } catch { /* not a URL */ }
};

/* ---------------- windows ---------------- */

let win = null;
let splash = null;
let splashError = false;

/** The small window with the logo, shown the moment the app is opened (kept hidden in a smoke test). */
function createSplash(text, { hidden = smoke, closable = true } = {}) {
  const s = new BrowserWindow({
    width: 440, height: 320, frame: false, resizable: false, maximizable: false, fullscreenable: false, closable,
    show: false, center: true, backgroundColor: BG(), icon: ICON, title: "Mandi Mitra",
    webPreferences: { contextIsolation: true, sandbox: true, devTools: !locked, spellcheck: false, preload: path.join(__dirname, "splash-preload.cjs") },
  });
  /* Loaded as a data: page read from inside app.asar, not as a file:// page:
     the installed app gives file:// pages no special rights (the
     grantFileProtocolExtraPrivileges fuse), and with that off they cannot be
     read from inside app.asar at all. */
  let html = "";
  try { html = fs.readFileSync(SPLASH, "utf8"); } catch (e) { console.warn("[app] the splash is missing:", e && e.message); }
  const ready = s.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    .then(() => s.webContents.executeJavaScript(`setVersion(${JSON.stringify(app.getVersion())})`))
    .then(() => { if (text) return setStatus(s, text); })
    .catch((e) => console.warn("[app] the splash did not load:", e && e.message));
  if (!hidden) s.once("ready-to-show", () => { if (!s.isDestroyed()) s.show(); });
  s.on("session-end", () => endSession("session-end"));
  splashError = false;
  return { s, ready };
}
function setStatus(s, text) {
  if (!s || s.isDestroyed()) return Promise.resolve();
  return s.webContents.executeJavaScript(`setStatus(${JSON.stringify(text)}, false)`).catch(() => undefined);
}
/**
 * One plain sentence, Try again, Close, and where the log is. After an update
 * that could not open the books, the first button goes back to the version
 * kept from before (`goBack`) instead of trying again.
 */
let splashGoBack = null;
async function showError(text, err, { goBack = null } = {}) {
  if (err) console.error("[app]", text, err);
  else info(text);
  if (smoke) return;
  if (!splash || splash.s.isDestroyed()) splash = createSplash();
  splashError = true;
  splashGoBack = goBack;
  await splash.ready;
  if (splash.s.isDestroyed()) return;
  const first = goBack ? `Go back to version ${goBack.version}` : null;
  await splash.s.webContents.executeJavaScript(`setError(${JSON.stringify(text)}, ${JSON.stringify(log.file)}, ${JSON.stringify(first)})`).catch(() => undefined);
  splash.s.show();
  splash.s.focus();
}
function closeSplash() {
  if (splash && !splash.s.isDestroyed()) splash.s.destroy();
  splash = null;
  splashError = false;
  splashGoBack = null;
}

/** The main window, hidden until its first paint. */
function createMainWindow({ hidden = false } = {}) {
  const w = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1024, minHeight: 640, title: "Mandi Mitra", show: false,
    icon: ICON, backgroundColor: BG(),
    // no spell-check: supplier names are Hindi and Hinglish, and there is no menu to pick a correction from.
    // A file or link dropped on the window opens nothing (navigateOnDragDrop; will-navigate below as well).
    webPreferences: { contextIsolation: true, sandbox: true, devTools: !locked, spellcheck: false, navigateOnDragDrop: false },
  });
  w.removeMenu();
  w.on("session-end", () => endSession("session-end"));
  w.on("query-session-end", () => info("Windows asked to end the session"));
  if (hidden) return w;
  const wc = w.webContents;
  let drawn = false;
  const showNow = (why) => {
    if (drawn || w.isDestroyed()) return;
    drawn = true;
    w.maximize();
    w.show();
    closeSplash();
    info(`window shown ${since()} after launch${why ? ` (${why})` : ""}`);
    afterShown();
    if (dev && process.env.MANDI_TIMING === "1") void timing(w);
  };
  // shown the moment it is drawn; a graphics driver that never says so gets 10 s
  w.once("ready-to-show", () => showNow());
  wc.once("did-start-loading", () => setTimeout(() => showNow("not drawn after 10 s"), 10_000).unref?.());
  let loadFailures = 0;
  wc.on("did-fail-load", (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3: replaced by another load, not a failure
    lastLoadFailed = true;
    console.warn(`[app] the screens did not load (${code} ${desc}) ${url}`);
    if (server.restarting) return; // reloaded when the server is back
    if (++loadFailures <= 2) setTimeout(() => { if (!w.isDestroyed()) wc.loadURL(`${base}/`).catch(() => undefined); }, 600);
    else void showError("The screens did not load.");
  });
  wc.on("did-finish-load", () => { lastLoadFailed = false; loadFailures = 0; });
  // a crashed page: reloaded once; again, the app starts once more with software drawing
  let gone = 0;
  wc.on("render-process-gone", (_e, d) => {
    console.error(`[app] the screens stopped (${d.reason}, code ${d.exitCode})`);
    if (d.reason === "clean-exit" || quitting) return;
    gone++;
    if (gone === 1) { wc.reload(); return; }
    if (!gpuOff) { writeGpuOff(`screens stopped twice (${d.reason})`); void relaunch(["--gpu-off"]); return; }
    void showError("The screens stopped working.");
  });
  wc.on("unresponsive", () => console.warn("[app] the screens are not responding"));
  wc.on("responsive", () => info("the screens respond again"));
  return w;
}
let lastLoadFailed = false;

function writeGpuOff(why) {
  try { fs.writeFileSync(GPU_FLAG, JSON.stringify({ version: app.getVersion(), at: new Date().toISOString(), why }, null, 2)); } catch { /* best effort */ }
  console.warn(`[app] graphics card switched off for this version: ${why}`);
}

/* Every page the app opens (main window, splash, the scan PDF viewer) gets the same rules. */
app.on("web-contents-created", (_e, wc) => {
  if (locked) {
    wc.on("before-input-event", (ev, input) => {
      if (lockdown.blockedKey(input)) { ev.preventDefault(); return; }
      const z = lockdown.zoomKey(input);
      if (z && wc.getType() === "window") {
        ev.preventDefault();
        const level = z === "reset" ? 0 : Math.max(-3, Math.min(4, wc.getZoomLevel() + (z === "in" ? 0.5 : -0.5)));
        wc.setZoomLevel(level);
      }
    });
    // belt and braces: devTools is off in every window, and anything that still opens them closes them
    wc.on("devtools-opened", () => { console.warn("[app] developer tools were opened; closing them"); wc.closeDevTools(); });
  }
  wc.setWindowOpenHandler(({ url }) => {
    if (!ours(url)) outside(url);
    return { action: "deny" };
  });
  // only the app's own pages load in its window; a dragged-in file or link opens nothing
  wc.on("will-navigate", (e, url) => {
    if (ours(url)) return;
    e.preventDefault();
    outside(url);
  });
  wc.on("will-attach-webview", (e) => e.preventDefault());
  // Web Bluetooth would otherwise pick the first device it finds
  wc.on("select-bluetooth-device", (e, _list, cb) => { e.preventDefault(); cb(""); });
});

/** Permissions: copy to the clipboard and full screen (scan review), for the app's own pages only. Nothing else. */
const ALLOWED = new Set(["clipboard-sanitized-write", "fullscreen"]);
function hardenSession(ses) {
  ses.setPermissionRequestHandler((_wc, perm, cb, d) => {
    const ok = ALLOWED.has(perm) && ours((d && d.requestingUrl) || "");
    if (!ok) info(`refused permission: ${perm}`);
    cb(ok);
  });
  ses.setPermissionCheckHandler((_wc, perm, origin) => ALLOWED.has(perm) && origin === base);
  ses.setDevicePermissionHandler(() => false);
  ses.on("select-hid-device", (e, _d, cb) => { e.preventDefault(); cb(""); });
  ses.on("select-serial-port", (e, _l, _wc, cb) => { e.preventDefault(); cb(""); });
  ses.on("select-usb-device", (e, _d, cb) => { e.preventDefault(); cb(); });
}
/** Every request from the app's windows to its own server carries this launch's key, and nothing else does. */
function sendKey(ses, port) {
  ses.webRequest.onBeforeSendHeaders({ urls: [`http://127.0.0.1:${port}/*`] }, (d, cb) => {
    if (ours(d.url)) d.requestHeaders[KEY_HEADER] = KEY;
    cb({ requestHeaders: d.requestHeaders });
  });
}

/* ---------------- the port ---------------- */

const PORT_FILE = path.join(userData, "port.json");
const PORTS = [8787, 8788, 8789, 8790, 8791, 8792, 8793, 8794, 8795, 8796, 8797];
function free(port, host) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.listen(port, host, () => s.close(() => resolve(true)));
  });
}
/**
 * 8787 normally. If something else holds it, a short fixed list, and the port
 * that worked is remembered, so the screens keep their per-computer settings
 * (language, scanner, sort order) from one start to the next. Shared on the
 * network, 8787 comes first (the other computer saved that address).
 */
async function pickPort(share, skip = new Set()) {
  let remembered = null;
  try { remembered = Number(JSON.parse(fs.readFileSync(PORT_FILE, "utf8")).port) || null; } catch { /* first start */ }
  // a test run names its own port (and the ten after it), so it never touches 8787
  const wanted = (dev || smoke) && Number(process.env.MANDI_PORT) ? Number(process.env.MANDI_PORT) : null;
  const list = wanted ? Array.from({ length: 11 }, (_, i) => wanted + i) : [share ? 8787 : remembered, remembered, ...PORTS];
  const order = [...new Set(list.filter(Boolean))].filter((p) => !skip.has(p));
  for (const p of order) {
    if (!(await free(p, "127.0.0.1"))) continue;
    if (share && !(await free(p, "0.0.0.0"))) continue;
    return p;
  }
  // nothing on the list: any free port, so the app still starts
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
function rememberPort(port) {
  try { if (Number(JSON.parse(fs.readFileSync(PORT_FILE, "utf8")).port) === port) return; } catch { /* write it */ }
  try { fs.writeFileSync(PORT_FILE, JSON.stringify({ port })); } catch { /* next start probes again */ }
}

/* ---------------- installers ---------------- */

/**
 * Starts an update's installer quietly from this process (the app's own, as
 * before v0.3.19; the books server's process ends with the app). Resolves once
 * Windows has started it and rejects if it could not, so nothing is closed
 * for an installer that never ran.
 */
function runInstaller(file, args) {
  info(`starting the installer ${path.basename(String(file))} ${args.join(" ")}`);
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(file, args, { detached: true, stdio: "ignore", windowsHide: false }); } catch (e) { reject(e); return; }
    child.once("error", (e) => { console.error("[app] the installer did not start:", e); reject(e); });
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

/** Start-up failed because an update could not open the books: back to the version kept from before, then this app leaves. */
let goingBack = false;
async function goBack(back) {
  if (goingBack) return;
  goingBack = true;
  try {
    // /S = no questions; --force-run = open it when done; --updated = it waits for this app to leave by itself
    await runInstaller(back.file, ["/S", "--force-run", "--updated"]);
  } catch {
    goingBack = false;
    await showError("Windows did not start the earlier version. Try again in a minute.", null, { goBack: back });
    return;
  }
  info(`going back to version ${back.version}; closing`);
  quitting = true;
  app.exit(0);
}

/* ---------------- the server ---------------- */

const server = { mode: null, child: null, port: 0, share: false, up: false, restarts: 0, stopping: false, restarting: false, portTaken: false, closingForUpdate: false };

function serverEnv(port, share) {
  return {
    MANDI_DATA_DIR: DATA_DIR,
    MANDI_STATIC_DIR: path.join(UNPACKED, "dist"),
    // a dev run may be given other migrations (scripts/desktop-scenarios.mjs badupdate); the installed app never is
    MANDI_MIGRATIONS_DIR: dev && !smoke && process.env.MANDI_MIGRATIONS_DIR ? path.resolve(process.env.MANDI_MIGRATIONS_DIR) : path.join(UNPACKED, "desktop-build", "migrations"),
    MANDI_HOST: share ? "0.0.0.0" : "127.0.0.1",
    MANDI_DESKTOP: "1",
    MANDI_APP_VERSION: app.getVersion(),
    MANDI_DESKTOP_TOKEN: KEY,
    MANDI_COMPILE_CACHE: path.join(userData, "code-cache"),
    PORT: String(port),
  };
}

/** Copies the server's output into the log, line by line. */
function pipeOutput(child) {
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    let buf = "";
    stream.setEncoding?.("utf8");
    stream.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, "");
        buf = buf.slice(i + 1);
        if (line) console.log(line.startsWith("[") ? line : `[server] ${line}`);
      }
    });
  }
}

/** The server in its own process. Resolves {ok}, {fatal} (the server refused to start) or {why} (the process could not run). */
function startUtility(port, share) {
  return new Promise((resolve) => {
    let child;
    let hello = false;
    let done = false;
    let timer = null;
    const finish = (r) => { if (done) return; done = true; if (timer) clearTimeout(timer); resolve({ child, ...r }); };
    try {
      child = utilityProcess.fork(SERVER_HOST, [SERVER_BUNDLE], {
        env: { ...process.env, ...serverEnv(port, share) }, stdio: "pipe", serviceName: "Mandi Mitra books",
      });
    } catch (e) {
      finish({ why: `could not start its process: ${e && e.message}` });
      return;
    }
    pipeOutput(child);
    timer = setTimeout(() => { if (!hello) { try { child.kill(); } catch { /* gone */ } finish({ why: "its process did not answer in 20 s" }); } }, 20_000);
    child.on("message", (m) => {
      if (!m || typeof m !== "object") return;
      if (m.type === "hello") hello = true;
      else if (m.type === "ready") finish({ ok: true });
      else if (m.type === "fatal") {
        // the port was taken after all: started again on another one (bringUpServer)
        if (m.code === "EADDRINUSE") { server.portTaken = true; finish({ portTaken: true, why: m.message }); return; }
        finish({ fatal: m, why: m.message });
      } else if (m.type === "closing") {
        // the server closed the books on its own: an update's installer is starting
        server.closingForUpdate = true;
      } else if (m.type === "relaunch") {
        info("restarting to finish putting back a backup");
        relaunch();
      } else if (m.type === "install") {
        // the server's update (or Go back) asks for its installer; the answer says whether Windows started it
        const reply = (r) => { try { child.postMessage({ type: "install-result", id: m.id, ...r }); } catch { /* it is gone */ } };
        runInstaller(m.file, Array.isArray(m.args) ? m.args.map(String) : []).then(
          () => reply({ ok: true }),
          (e) => reply({ ok: false, error: String((e && e.message) || e) }));
      } else if (m.type === "closed") {
        if (m.backup) info(`closing backup ${m.backup}`);
      }
    });
    child.once("exit", (code) => {
      finish({ why: `its process ended (code ${code}) before it was ready`, crashed: true });
      onServerExit(child, code);
    });
  });
}

/** The server inside the app, as before v0.3.19: used only when its own process cannot run. */
async function startInProcess(port, share) {
  Object.assign(process.env, serverEnv(port, share));
  // "Restore a backup" finishes on a fresh start, before the database is opened
  globalThis.__mandiRelaunch = () => relaunch();
  // an update's installer: started from here; the updater then closes the books and the app leaves
  globalThis.__mandiRunInstaller = runInstaller;
  globalThis.__mandiExit = () => { quitting = true; app.exit(0); };
  try {
    await import(pathToFileURL(SERVER_BUNDLE).href);
    return { ok: true };
  } catch (e) {
    // books that were opened (an update that was rolled back) are closed cleanly
    try { globalThis.__mandiShutdown?.(); } catch { /* not open */ }
    return { fatal: fatalOf(e), why: String(e && e.message), error: e };
  }
}
/** What the start-up screen needs to know about a server that refused to start (as server-host.cjs sends it). */
function fatalOf(e) {
  return {
    message: String((e && e.message) || e), code: e && e.code, name: e && e.constructor && e.constructor.name,
    mandiUpdateFailed: Boolean(e && e.mandiUpdateFailed), diskFull: Boolean(e && e.diskFull),
    goBack: e && e.goBack && e.goBack.file ? { version: String(e.goBack.version), file: String(e.goBack.file) } : null,
  };
}

function waitGone(child, ms) {
  return new Promise((resolve) => {
    if (!child || child.pid === undefined) return resolve();
    const t = setTimeout(() => { try { child.kill(); } catch { /* gone */ } resolve(); }, ms);
    child.once("exit", () => { clearTimeout(t); resolve(); });
  });
}

/** Starts the server; in its own process when it can, inside the app when it cannot (fail open). */
async function startServer(port, share) {
  const t0 = Date.now();
  if (!(dev && process.env.MANDI_SERVER_INPROCESS === "1")) {
    const r = await startUtility(port, share);
    if (r.ok) {
      server.mode = "utility"; server.child = r.child;
      info(`server ready in its own process (pid ${r.child.pid}) in ${Date.now() - t0} ms`);
      return r;
    }
    // the server itself said no (damaged books, a stopped update): starting it again here would only repeat that
    if ((r.fatal && !r.fatal.loader) || r.portTaken) return r;
    console.warn(`[app] the server could not run in its own process (${r.why}); starting it inside the app instead`);
    await waitGone(r.child, 3000);
  }
  if (server.mode === "inprocess") return { fatal: { message: "the server is already running inside the app" } };
  const r = await startInProcess(port, share);
  if (r.ok) { server.mode = "inprocess"; info(`server ready inside the app in ${Date.now() - t0} ms`); }
  return r;
}

/** Waits until this launch's own server answers (another program on the same port does not count). */
async function answers(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (server.portTaken) return false;
    try {
      const res = await fetch(`${base}/api/health`, { headers: { [KEY_HEADER]: KEY }, signal: AbortSignal.timeout(2000) });
      if (res.ok && res.headers.get(KEY_HEADER) === "ok") return true;
    } catch { /* not yet */ }
    await sleep(25);
  }
  return false;
}

let quitting = false;
/** The server process ended. Asked to: fine. After closing for an update: the app closes too. Otherwise: started once more. */
function onServerExit(child, code) {
  if (child !== server.child) return;
  server.child = null;
  // while starting, bringUpServer deals with it (another port, or the error on the splash)
  if (!server.up || server.stopping || quitting) return;
  if (server.closingForUpdate) {
    info("the server closed itself (an update is being installed); closing the app");
    quitting = true;
    app.quit();
    return;
  }
  console.error(`[app] the server stopped unexpectedly (code ${code})`);
  if (server.restarts >= 1) { void showError("Mandi Mitra stopped working."); return; }
  server.restarts++;
  void restartServer();
}
async function restartServer() {
  server.restarting = true;
  if (!smoke && !splash) { splash = createSplash("Starting your books again…"); }
  const r = await startUtility(server.port, server.share);
  server.restarting = false;
  if (!r.ok || !(await answers(30_000))) { void showError("Mandi Mitra stopped working."); return; }
  server.mode = "utility"; server.child = r.child;
  info("the server is running again");
  closeSplash();
  if (lastLoadFailed && win && !win.isDestroyed()) win.webContents.reload();
}

/**
 * Asks the server to write everything into the books file and close it, then
 * waits for it (at most `ms`). With `backup` (a normal close), the day's work
 * goes into a backup first when one is due (server/lib/backup.ts backupOnQuit:
 * local only, skipped when the last is under 2 h old or the books are huge).
 */
function stopServer(ms = 5000, { backup = false } = {}) {
  if (server.mode === "inprocess") {
    if (backup) {
      try { const b = globalThis.__mandiBackupOnQuit?.(); if (b) info(`closing backup ${b}`); } catch (e) { console.error("[app] closing backup:", e); }
    }
    try { globalThis.__mandiShutdown?.(); } catch { /* closed already */ }
    return Promise.resolve();
  }
  const c = server.child;
  if (!c) return Promise.resolve();
  server.stopping = true;
  const gone = waitGone(c, ms);
  try { c.postMessage({ type: "shutdown", backup }); } catch { /* it is gone */ }
  return gone;
}

/** Pauses this thread (the app is closing anyway); Atomics.wait sleeps without spinning. */
function waitSync(ms, done) {
  const until = Date.now() + ms;
  const cell = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < until) {
    if (done()) return true;
    try { Atomics.wait(cell, 0, 0, 20); } catch { /* no sleeping here: spin */ }
  }
  return done();
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/*
 * Windows shut down, restarted or logged off with the app open. Windows does
 * not give the app its normal close (will-quit never runs), so the books are
 * written into the main file and closed here, before Windows ends the app.
 * It cannot wait on messages, so it watches the books' side file (-wal), which
 * SQLite removes when the books are closed, or the server process ending.
 */
let sessionEnded = false;
function endSession(why) {
  if (sessionEnded) return;
  sessionEnded = true;
  quitting = true;
  const t0 = Date.now();
  if (server.mode === "inprocess") {
    try { globalThis.__mandiShutdown?.(); } catch { /* closed already */ }
    info(`${why}: books closed in ${Date.now() - t0} ms`);
    return;
  }
  const c = server.child;
  if (!c) return;
  server.stopping = true;
  const pid = c.pid;
  try { c.postMessage({ type: "shutdown" }); } catch { /* gone */ }
  // closed = the side file folded in and the clean-close mark removed (then nothing is checked at the next start)
  const ok = waitSync(4000, () => !alive(pid) || (!fs.existsSync(`${DB_PATH}-wal`) && !fs.existsSync(OPEN_MARK)));
  info(`${why}: books ${ok ? "closed" : "NOT confirmed closed"} in ${Date.now() - t0} ms`);
}

/** Closes the books, then starts the app again (Try again, restore, software drawing). */
let relaunching = false;
async function relaunch(extra = []) {
  if (relaunching) return;
  relaunching = true;
  quitting = true;
  await stopServer(4000);
  const args = [...argv.slice(1).filter((a) => !extra.includes(a)), ...extra];
  info(`starting again${extra.length ? ` with ${extra.join(" ")}` : ""}`);
  app.relaunch({ args });
  app.exit(0);
}

/* ---------------- app life ---------------- */

app.on("second-instance", () => {
  if (win && !win.isDestroyed() && (win.isVisible() || win.isMinimized())) { if (win.isMinimized()) win.restore(); win.focus(); return; }
  if (splash && !splash.s.isDestroyed()) {
    if (splashError) { void relaunch(); return; }
    splash.s.focus();
  }
});
app.on("window-all-closed", () => { if (!smoke) app.quit(); });
/* A normal close: the day's work into a backup first (quick, this computer
   only, when the last one is over 2 h old), then the books written into the
   main file and closed (nothing waits in the -wal side file), then the app
   ends. Not for a Windows shutdown (endSession), a restart (relaunch) or an
   update (the server has closed the books itself and gone). */
let serverClosed = false;
app.on("will-quit", (e) => {
  quitting = true;
  if (serverClosed || !server.mode) return;
  if (server.mode === "inprocess" || !server.child) {
    // nothing to wait for: inside the app the backup and the close happen right here (none when the server has gone)
    serverClosed = true;
    void stopServer(0, { backup: true });
    info("closed");
    if (smokeQuit) { e.preventDefault(); void smokeQuitDone(); }
    return;
  }
  e.preventDefault();
  // the backup runs in the server's process; the windows are already gone, so a big book may take a few seconds
  void stopServer(30_000, { backup: true }).then(() => {
    serverClosed = true;
    info("closed");
    // once Electron has finished with this will-quit (a quit asked for during it is ignored)
    setImmediate(() => { if (smokeQuit) void smokeQuitDone(); else app.quit(); });
  });
});
app.on("child-process-gone", (_e, d) => {
  console.warn(`[app] ${d.type} process gone: ${d.reason} (code ${d.exitCode})${d.name ? ` ${d.name}` : ""}`);
  // the graphics card failing twice: the next start draws in software (Chromium already falls back for now)
  if (d.type === "GPU" && ["crashed", "launch-failed", "abnormal-exit", "integrity-failure"].includes(d.reason) && !gpuOff) {
    gpuFailures++;
    if (gpuFailures >= 2) writeGpuOff(`graphics process ${d.reason} twice`);
  }
});
let gpuFailures = 0;

ipcMain.on("mandi:try-again", (e) => {
  if (!splash || e.sender !== splash.s.webContents) return;
  if (splashGoBack) void goBack(splashGoBack);
  else void relaunch();
});
ipcMain.on("mandi:close", (e) => { if (splash && e.sender === splash.s.webContents) { quitting = true; app.quit(); } });

function readShare() {
  /* Normally this computer only. Switched on in Settings, the books are served
     to the shop's own network as well, so a second laptop uses them directly
     (one database, nothing to sync). Read here because it decides the bind. */
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, "network.json"), "utf8")).share === true; } catch { return false; }
}

/**
 * The plain words on the splash for a server that refused to start. An update
 * that could not open the books left them exactly as they were (it is rolled
 * back), so going back to the version kept from before is safe and offered.
 */
function startFailure(fatal) {
  const f = fatal || {};
  if (f.diskFull || /SQLITE_FULL|ENOSPC/.test(`${f.code} ${f.message}`)) return { text: "This computer's disk is full. Free some space and try again." };
  if (f.mandiUpdateFailed || f.name === "MigrationError") return { text: "This version could not open your books; they are as they were.", goBack: f.goBack || null };
  if (/^SQLITE_(CORRUPT|NOTADB)/.test(String(f.code))) return { text: "Your books file could not be opened." };
  return { text: "Mandi Mitra could not open your books." };
}

/** Server up (port picked, started, answering). Retries another port if this one turns out taken. */
async function bringUpServer(share) {
  const tried = new Set();
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = await pickPort(share, tried);
    tried.add(port);
    server.port = port; server.share = share; server.portTaken = false;
    base = `http://127.0.0.1:${port}`;
    sendKey(session.defaultSession, port);
    info(`port ${port}${share ? " (shared on the network)" : ""}`);
    const r = await startServer(port, share);
    if (r.ok && (await answers(30_000))) { server.up = true; rememberPort(port); return { ok: true }; }
    if (!r.portTaken && !server.portTaken) return r.ok ? { why: "the server did not answer" } : r;
    console.warn(`[app] port ${port} turned out to be taken; trying another`);
    const child = server.child || r.child;
    server.child = null; server.mode = null;
    await waitGone(child, 3000);
  }
  return { why: "no free port" };
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  hardenSession(session.defaultSession);
  if (smoke) return smokeTest();

  const LAST = path.join(userData, "last-version.json");
  let last = null;
  try { last = JSON.parse(fs.readFileSync(LAST, "utf8")).version; } catch { /* first start of this build */ }
  const updating = last ? last !== app.getVersion() : fs.existsSync(DB_PATH);
  // the splash first; the server starts at the same time in its own process
  /* While the books are being updated the splash cannot be closed (as when
     the app used to sit still for it): closing would stop the update half way,
     and although SQLite undoes a half-done update, it would only start again. */
  splash = createSplash(updating ? "Updating your data. Please keep the computer on…" : "Opening your data…", { closable: !updating });
  const share = readShare();
  const up = await bringUpServer(share);
  if (splash && !splash.s.isDestroyed()) splash.s.setClosable(true);
  if (!up.ok) {
    if (up.fatal) {
      const { text, goBack: back } = startFailure(up.fatal);
      await showError(text, up.error || up.fatal.message, { goBack: back });
    } else await showError("Mandi Mitra could not start.", up.why);
    return;
  }
  try { fs.writeFileSync(LAST, JSON.stringify({ version: app.getVersion() })); } catch { /* says "updating" once more */ }
  if (share && server.port !== 8787) sharePortWarning = true;
  // (made only now: made earlier, it competes with the server for the processor and the start is no faster)
  win = createMainWindow();
  await win.loadURL(`${base}/`).catch((e) => console.warn("[app] first load:", e && e.message));
}).catch((e) => showError("Mandi Mitra could not start.", e));

let sharePortWarning = false;
/** Once the window is up: the plain warning for a shared port, and old update installers cleared away. */
function afterShown() {
  if (sharePortWarning && win) {
    sharePortWarning = false;
    void dialog.showMessageBox(win, {
      type: "warning", buttons: ["OK"], title: "Mandi Mitra",
      message: `Port 8787 is in use by another program, so the other computer cannot open these books right now.`,
    });
  }
  // the update copies the installer into Temp (about 130 MB each time); old copies go after a minute
  setTimeout(() => {
    const tmp = os.tmpdir();
    fs.promises.readdir(tmp).then(async (names) => {
      for (const n of names) {
        if (!/^MandiMitra-Setup-\d+\.\d+\.\d+-[0-9a-f]{8}\.exe$/i.test(n)) continue;
        const f = path.join(tmp, n);
        try { if (Date.now() - (await fs.promises.stat(f)).mtimeMs > 3600_000) await fs.promises.rm(f, { force: true }); } catch { /* in use */ }
      }
    }).catch(() => undefined);
  }, 60_000).unref?.();
}

/** Dev only (MANDI_TIMING=1): prints when the window was shown and when the first screen had drawn, then closes. */
async function timing(w) {
  console.log(`T shown ${Math.round(process.uptime() * 1000)}`);
  for (;;) {
    const n = await w.webContents.executeJavaScript('(document.getElementById("root") || {}).childElementCount || 0').catch(() => 0);
    if (n > 0) break;
    await sleep(15);
  }
  console.log(`T usable ${Math.round(process.uptime() * 1000)}`);
  app.quit();
}

/* ---------------- smoke test ---------------- */

async function smokeTest() {
  const checks = {};
  const fail = (k, e) => { checks[k] = false; console.error(`SMOKE ${k}:`, e); };
  let w = null;
  try {
    // a copy of older books (MANDI_SMOKE_FROM) to prove this version opens them: never the books themselves
    if (process.env.MANDI_SMOKE_FROM) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      // with its -wal side file, which may hold its latest rows
      for (const side of ["", "-wal"]) {
        const from = process.env.MANDI_SMOKE_FROM + side;
        if (fs.existsSync(from)) fs.copyFileSync(from, DB_PATH + side);
      }
    }
    const up = await bringUpServer(false);
    checks.server = Boolean(up.ok);
    checks.mode = server.mode;
    if (!up.ok) {
      // what the start-up screen would offer (an update that could not apply: going back), for the build pipeline and tests
      const f = up.fatal || {};
      console.error(`SMOKE FAIL start ${JSON.stringify({ message: f.message || up.why, updateFailed: Boolean(f.mandiUpdateFailed), diskFull: Boolean(f.diskFull), goBack: (f.goBack && f.goBack.version) || null })}`);
      throw new Error(`server: ${up.why}`);
    }
    if (process.env.MANDI_SMOKE_FROM) {
      const backups = fs.existsSync(path.join(DATA_DIR, "backups")) ? fs.readdirSync(path.join(DATA_DIR, "backups")) : [];
      const copied = backups.some((n) => /^before-update-.*\.db$/.test(n));
      checks.olderBooksOpened = true;
      info(`older books opened; before-update copy ${copied ? "made" : "not needed"}`);
      /* MANDI_SMOKE_EXPECT_UPDATE: these books are known to be older (desktop.yml's
         fixture), so the update must have run on them: a checked copy made first,
         the update applied, and no new first-run books made in their place. */
      if (process.env.MANDI_SMOKE_EXPECT_UPDATE === "1") {
        // (the server's own lines reach the log through its output pipe, a moment after it says it is ready)
        let said = "";
        for (let i = 0; i < 60; i++) {
          try { said = fs.readFileSync(log.file, "utf8"); } catch { /* not yet */ }
          if (/migrations up to date/.test(said)) break;
          await sleep(50);
        }
        checks.olderBooksUpdated = copied && /backed up before update/.test(said) && /migrations up to date/.test(said) && !/first run/.test(said);
        if (!checks.olderBooksUpdated) console.error(`SMOKE update: copy ${copied}, log ${JSON.stringify(said.slice(-1500))}`);
      }
    }
    checks.icon = fs.existsSync(ICON);
    // off-screen: the splash (with its two buttons) and the main window both load
    const sp = createSplash();
    await sp.ready;
    const parts = await sp.s.webContents.executeJavaScript('({ status: typeof setStatus, error: typeof setError, logo: document.querySelector("svg") !== null, buttons: typeof window.mandi?.tryAgain })');
    checks.splash = parts.status === "function" && parts.error === "function" && parts.logo && parts.buttons === "function";
    if (!checks.splash) console.error("SMOKE splash:", JSON.stringify(parts));
    sp.s.destroy();
    w = createMainWindow({ hidden: true });
    await w.loadURL(`${base}/`);
    const wc = w.webContents;
    checks.screens = await wc.executeJavaScript('document.getElementById("root") !== null && document.title === "Mandi Mitra"');

    // the server answers this app's windows only: Chrome or Edge on this PC get a plain page
    const page = await fetch(`${base}/`);
    const api = await fetch(`${base}/api/auth/users`);
    checks.gate = page.status === 403 && /desktop icon/.test(await page.text()) && api.status === 403 && (await fetch(`${base}/api/health`)).ok;
    // ...while the window's pictures, frames and downloads carry the key
    checks.frames = await wc.executeJavaScript(`new Promise((ok) => { const f = document.createElement("iframe"); f.style.display = "none";
      f.onload = () => ok(Boolean(f.contentDocument && f.contentDocument.querySelector("svg"))); f.onerror = () => ok(false);
      f.src = "/favicon.svg"; document.body.appendChild(f); setTimeout(() => ok(false), 5000); })`);
    checks.download = await new Promise((resolve) => {
      const to = path.join(userData, "download-check.html");
      const t = setTimeout(() => resolve(false), 8000);
      session.defaultSession.once("will-download", (_e, item) => {
        item.setSavePath(to);
        item.once("done", (_e2, state) => {
          clearTimeout(t);
          let text = "";
          try { text = fs.readFileSync(to, "utf8"); } catch { /* not written */ }
          if (state !== "completed" || !/id="root"/.test(text)) console.error(`SMOKE download ${state}:`, text.slice(0, 200));
          resolve(state === "completed" && /id="root"/.test(text));
        });
      });
      // the way the app downloads a parcha or a backup: a link with "download"
      void wc.executeJavaScript('const a = document.createElement("a"); a.href = "/index.html"; a.download = "check.html"; document.body.appendChild(a); a.click(); a.remove(); true');
    });

    // no other site or window opens in the app
    await wc.executeJavaScript('location.href = "http://127.0.0.1:9/elsewhere"; true').catch(() => undefined);
    await sleep(300);
    await wc.executeJavaScript('window.open("https://example.com/", "_blank"); true').catch(() => undefined);
    await sleep(300);
    checks.navigation = wc.getURL().startsWith(base) && BrowserWindow.getAllWindows().length === 1 && opened.length === 1;
    // camera, microphone, location and notifications are refused
    checks.permissions = await wc.executeJavaScript(`Promise.all(["geolocation", "camera", "microphone", "notifications", "midi"]
      .map((name) => navigator.permissions.query({ name }).then((r) => r.state, () => "denied")))
      .then((s) => s.every((x) => x === "denied") && Notification.permission === "denied")`);

    if (locked) {
      // no developer tools, whatever opens them
      wc.openDevTools({ mode: "detach" });
      await sleep(500);
      checks.devtools = !wc.isDevToolsOpened();
      // the refused keys never reach the page; typing (AltGr and AltGr+Shift too), copy, paste and Ctrl+F still do
      await wc.executeJavaScript('window.__keys = []; addEventListener("keydown", (e) => __keys.push((e.ctrlKey || e.metaKey ? "C" : "") + (e.shiftKey ? "S" : "") + e.code), true); true');
      const mod = (c) => (process.platform === "darwin" ? ["meta"] : ["control"]).concat(c);
      const press = (keyCode, modifiers = []) => { wc.sendInputEvent({ type: "keyDown", keyCode, modifiers }); wc.sendInputEvent({ type: "keyUp", keyCode, modifiers }); };
      const refused = [["F12"], ["F5"], ["R", mod([])], ["R", mod(["shift"])], ["F5", mod([])], ["I", mod(["shift"])], ["J", mod(["shift"])],
        ["C", mod(["shift"])], ["U", mod([])], ["P", mod([])], ["N", mod([])], ["T", mod([])], ["L", mod([])], ["O", mod([])]];
      // AltGr is Ctrl+Alt on Windows; with Shift it types the second layer of a Hindi or other Indian layout
      const kept = [["A", []], ["C", mod([])], ["V", mod([])], ["F", mod([])], ["Enter", mod([])], ["I", ["control", "alt", "shift"]], ["R", ["control", "alt", "shift"]]];
      wc.focus();
      for (const [k, m] of refused) press(k, m);
      for (const [k, m] of kept) press(k, m);
      await sleep(400);
      const seen = await wc.executeJavaScript("window.__keys");
      checks.keys = seen.join(",") === "KeyA,CKeyC,CKeyV,CKeyF,CEnter,CSKeyI,CSKeyR";
      if (!checks.keys) console.error("SMOKE keys seen by the page:", seen);
      checks.stillHere = wc.getURL().startsWith(base);
    }

    if (server.mode === "utility") {
      // the server process dies: it comes back by itself, on the same address
      const before = server.child.pid;
      server.child.kill();
      const until = Date.now() + 20_000;
      while (Date.now() < until && !(server.child && server.child.pid !== before && !server.restarting)) await sleep(50);
      checks.restart = Boolean(server.child) && (await answers(10_000));
      // Windows shutting down: the books are written into the main file and closed before the app ends
      // (--smoke-quit closes the normal way instead, below)
      if (!smokeQuit) {
        endSession("smoke session-end");
        checks.sessionEnd = !fs.existsSync(`${DB_PATH}-wal`) && !fs.existsSync(OPEN_MARK);
      }
    }
  } catch (e) {
    fail("error", e);
  }
  if (!process.env.MANDI_SMOKE_ALLOW_INPROCESS && checks.mode !== "utility") checks.mode = false;
  const ok = Object.values(checks).every(Boolean);
  console.log(`${ok ? "SMOKE OK" : "SMOKE FAIL"} ${base} ${JSON.stringify(checks)}`);
  quitting = true;
  try { if (w && !w.isDestroyed()) w.destroy(); } catch { /* closing */ }
  // --smoke-quit: leave the way a normal close does (will-quit: the closing backup, then the books closed; smokeQuitDone checks it)
  if (ok && smokeQuit) { app.quit(); return; }
  await stopServer(3000);
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* the OS clears its temp folder */ }
  app.exit(ok ? 0 : 1);
}

/** After a --smoke-quit close: a closing backup was made, and the books were folded into one file and closed cleanly. */
async function smokeQuitDone() {
  let names = [];
  try { names = fs.readdirSync(path.join(DATA_DIR, "backups")); } catch { /* none */ }
  const checks = {
    closingBackup: names.some((n) => /^auto-\d{8}-\d{6}\.db$/.test(n)),
    walFolded: !fs.existsSync(`${DB_PATH}-wal`),
    markRemoved: !fs.existsSync(OPEN_MARK),
  };
  const ok = Object.values(checks).every(Boolean);
  console.log(`${ok ? "SMOKE QUIT OK" : "SMOKE QUIT FAIL"} ${JSON.stringify(checks)}`);
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* the OS clears its temp folder */ }
  app.exit(ok ? 0 : 1);
}
