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
// write everything into the database file and close it, so no change waits in the side (-wal) file
app.on("will-quit", () => { try { globalThis.__mandiShutdown?.(); } catch { /* closed already */ } });
// "Restore a backup" finishes on a fresh start, before the database is opened
globalThis.__mandiRelaunch = () => {
  try { globalThis.__mandiShutdown?.(); } catch { /* closed already */ }
  app.relaunch();
  app.exit(0);
};

app.whenReady().then(async () => {
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
    if (smoke) { console.error("SMOKE FAIL start", e); app.exit(1); return; }
    await status(splash && splash.s, "Mandi Mitra could not start.", true);
    dialog.showErrorBox("Mandi Mitra could not start", (e && e.message) ? `${e.message}\n\n${e.stack || ""}` : String(e));
    app.quit();
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
