/* Mandi Mitra desktop app (Windows).
 *
 * Starts the API server inside the app on this computer only (127.0.0.1),
 * with its data in the user's AppData folder, and shows the screens in a
 * window. Scanning, printing and downloads work as in the browser; scanning
 * from a Canon (or any WIA) scanner works because the server runs on the
 * same Windows computer as the scanner.
 *
 * `--smoke-test` starts the server, checks it answers, and exits 0 or 1:
 * the build pipeline uses it to prove the packaged app actually runs.
 */
const { app, BrowserWindow, shell, dialog, Menu, nativeTheme } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const net = require("node:net");
const { pathToFileURL } = require("node:url");
const { spawn } = require("node:child_process");

const smoke = process.argv.includes("--smoke-test");
// a second copy only brings the first one forward; it never opens the database
if (!smoke && !app.requestSingleInstanceLock()) app.exit(0);
// the taskbar groups and labels the app by this id (matches electron-builder's appId)
if (process.platform === "win32") app.setAppUserModelId("in.vijaylaxmi.mandimitra");

const ICON = path.join(__dirname, "icon.png");
const BG = () => (nativeTheme.shouldUseDarkColors ? "#16181b" : "#fbfaf7");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A small window with the logo, shown the moment the app is opened. */
function createSplash() {
  const s = new BrowserWindow({
    width: 440, height: 320, frame: false, resizable: false, maximizable: false, fullscreenable: false,
    show: false, center: true, backgroundColor: BG(), icon: ICON, title: "Mandi Mitra",
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  s.loadFile(path.join(__dirname, "splash.html"), { query: { v: app.getVersion() } });
  s.on("session-end", closeBooks);
  const shown = new Promise((resolve) => { s.once("ready-to-show", () => { s.show(); resolve(); }); setTimeout(resolve, 2500); });
  return { s, shown };
}
function status(s, text, bad) {
  if (!s || s.isDestroyed()) return Promise.resolve();
  return s.webContents.executeJavaScript(`setStatus(${JSON.stringify(text)}, ${bad ? "true" : "false"})`).catch(() => undefined);
}

function freePort(preferred) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => { const t = net.createServer(); t.listen(0, "127.0.0.1", () => { const p = t.address().port; t.close(() => resolve(p)); }); });
    s.listen(preferred, "127.0.0.1", () => s.close(() => resolve(preferred)));
  });
}

/*
 * Everything the app says (the server's start-up lines, a refused restore, a
 * failed start with its details) also goes to logs/main.log beside the data,
 * rolled over at about 1 MB: opened from the desktop icon there is no
 * console, and this is what to send to support.
 */
function logToFile() {
  const dir = path.join(app.getPath("userData"), "logs");
  const file = path.join(dir, "main.log");
  let size = 0;
  try {
    fs.mkdirSync(dir, { recursive: true });
    size = fs.existsSync(file) ? fs.statSync(file).size : 0;
  } catch { return; }
  const util = require("node:util");
  for (const level of ["log", "warn", "error"]) {
    const say = console[level].bind(console);
    console[level] = (...args) => {
      say(...args);
      try {
        if (size > 1024 * 1024) { fs.renameSync(file, `${file}.1`); size = 0; }
        const line = `${new Date().toISOString()} ${level} ${util.format(...args)}\n`;
        fs.appendFileSync(file, line);
        size += Buffer.byteLength(line);
      } catch { /* the console still has it */ }
    };
  }
}

async function startServer() {
  const root = app.getAppPath();
  const unpacked = root.replace(/app\.asar$/, "app.asar.unpacked");
  process.env.MANDI_DATA_DIR = path.join(app.getPath("userData"), "data");
  process.env.MANDI_STATIC_DIR = path.join(unpacked, "dist");
  process.env.MANDI_MIGRATIONS_DIR = path.join(unpacked, "desktop-build", "migrations");
  /* Normally this computer only. Switched on in Settings, the books are served
     to the shop's own network as well, so a second laptop uses them directly
     (one database, nothing to sync). Read here because it decides the bind. */
  let share = false;
  try { share = JSON.parse(fs.readFileSync(path.join(process.env.MANDI_DATA_DIR, "network.json"), "utf8")).share === true; } catch { /* off */ }
  process.env.MANDI_HOST = share ? "0.0.0.0" : "127.0.0.1";
  process.env.MANDI_DESKTOP = "1";
  process.env.MANDI_APP_VERSION = app.getVersion();
  const port = await freePort(8787);
  process.env.PORT = String(port);
  // the server bundle and the native database module are unpacked from the archive
  await import(pathToFileURL(path.join(unpacked, "desktop-build", "server", "index.mjs")).href);
  return port;
}

async function waitFor(url, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { if ((await fetch(url)).ok) return true; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

let win = null;
app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on("window-all-closed", () => app.quit());
/** Write everything into the database file and close it, so no change waits in the side (-wal) file. */
function closeBooks() { try { globalThis.__mandiShutdown?.(); } catch { /* closed already */ } }
// a normal close: the day's work into a backup first (quick, this computer only), then the books closed
app.on("will-quit", () => {
  try { globalThis.__mandiBackupOnQuit?.(); } catch { /* the Backups card says it */ }
  closeBooks();
});
// "Restore a backup" finishes on a fresh start, before the database is opened
globalThis.__mandiRelaunch = () => {
  closeBooks();
  app.relaunch();
  app.exit(0);
};
// the updater closes the books itself, then leaves for the installer
globalThis.__mandiExit = () => app.exit(0);

/** Starts an installer quietly; resolves once Windows has started it. */
function runInstaller(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { detached: true, stdio: "ignore", windowsHide: false });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

/*
 * The app could not start. One plain sentence (the details go to the log).
 * An update that could not open the books leaves them exactly as they were
 * (it is rolled back), so going back to the version kept from before is safe
 * and offered.
 */
async function startFailed(e) {
  console.error("[start] Mandi Mitra could not start:", e);
  const update = Boolean(e && e.mandiUpdateFailed);
  const back = update && !e.diskFull ? e.goBack : null;
  const message = !update ? `Mandi Mitra could not start: ${(e && e.message) || String(e)}`
    : e.diskFull ? "The disk is full, so this version could not open your books; they are as they were. Free some space and open the app again."
    : "This version could not open your books; they are as they were.";
  const buttons = back ? [`Go back to version ${back.version}`, "Close"] : ["Close"];
  const { response } = await dialog.showMessageBox({ type: "error", title: "Mandi Mitra", message, buttons, defaultId: 0, cancelId: buttons.length - 1, noLink: true });
  if (!back || response !== 0) return;
  try {
    await runInstaller(back.file, ["/S", "--force-run", "--updated"]);
  } catch (err) {
    console.error("[start] the earlier version's installer did not start:", err);
    await dialog.showMessageBox({ type: "error", title: "Mandi Mitra", message: "Windows did not start the earlier version. Open Mandi Mitra again to try once more.", buttons: ["Close"], noLink: true });
  }
}

app.whenReady().then(async () => {
  logToFile();
  console.log(`[app] Mandi Mitra ${app.getVersion()} starting${smoke ? " (smoke test)" : ""}`);
  // the splash first, and painted, before the database work holds up this process
  const splash = smoke ? null : createSplash();
  const openedAt = Date.now();
  if (splash) {
    await splash.shown;
    await status(splash.s, "Opening your data…");
    await sleep(60);
  }
  let port;
  try {
    port = await startServer();
  } catch (e) {
    if (smoke) {
      // what the start-up message would offer, for the build pipeline and tests
      console.error(`SMOKE FAIL start ${JSON.stringify({ message: e && e.message, updateFailed: Boolean(e && e.mandiUpdateFailed), diskFull: Boolean(e && e.diskFull), goBack: (e && e.goBack && e.goBack.version) || null })}`, e);
      app.exit(1);
      return;
    }
    await status(splash && splash.s, "Mandi Mitra could not start.", true);
    await startFailed(e);
    app.exit(0);
    return;
  }
  const base = `http://127.0.0.1:${port}`;
  await status(splash && splash.s, "Getting the screens ready…");
  const up = await waitFor(`${base}/api/health`, 30_000);
  if (smoke) {
    // off-screen: the splash and the main window both load, and the icon is packaged
    const checks = { server: up, icon: require("node:fs").existsSync(ICON), splash: false, screens: false };
    try {
      const sp = new BrowserWindow({ show: false, icon: ICON, webPreferences: { contextIsolation: true, sandbox: true } });
      await sp.loadFile(path.join(__dirname, "splash.html"), { query: { v: app.getVersion() } });
      checks.splash = await sp.webContents.executeJavaScript('typeof setStatus === "function" && document.querySelector("svg") !== null');
      const w = new BrowserWindow({ show: false, icon: ICON, webPreferences: { contextIsolation: true, sandbox: true } });
      await w.loadURL(`${base}/`);
      checks.screens = await w.webContents.executeJavaScript('document.getElementById("root") !== null && document.title === "Mandi Mitra"');
    } catch (e) {
      console.error("SMOKE window error", e);
    }
    const ok = Object.values(checks).every(Boolean);
    console.log(`${ok ? "SMOKE OK" : "SMOKE FAIL"} ${base} ${JSON.stringify(checks)}`);
    app.exit(ok ? 0 : 1);
    return;
  }
  Menu.setApplicationMenu(null);
  if (!up) {
    await status(splash && splash.s, "The app's server did not answer. Close it and open it again.", true);
    return;
  }
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1024, minHeight: 640, title: "Mandi Mitra", show: false,
    icon: ICON, backgroundColor: BG(),
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  // Windows shutting down, restarting or logging off never sends will-quit: the books are closed here instead
  win.on("session-end", closeBooks);
  // swap the splash for the main window only once it is drawn: no white flash
  win.once("ready-to-show", async () => {
    await sleep(Math.max(0, 900 - (Date.now() - openedAt)));
    win.maximize();
    win.show();
    if (splash && !splash.s.isDestroyed()) splash.s.destroy();
  });
  win.webContents.on("did-fail-load", () => status(splash && splash.s, "The screens did not load. Close the app and open it again.", true));
  // only the app's own pages load in its window; web links (AI Studio, Google's
  // limits page) open in the normal browser, and nothing else is opened at all
  const ours = (url) => { try { return new URL(url).origin === base; } catch { return false; } };
  const outside = (url) => { try { if (new URL(url).protocol === "https:") shell.openExternal(url); } catch { /* not a URL */ } };
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!ours(url)) outside(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!ours(url)) { e.preventDefault(); outside(url); }
  });
  await win.loadURL(`${base}/`);
});
