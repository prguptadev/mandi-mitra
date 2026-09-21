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
const { app, BrowserWindow, shell, dialog, Menu } = require("electron");
const path = require("node:path");
const net = require("node:net");
const { pathToFileURL } = require("node:url");

const smoke = process.argv.includes("--smoke-test");
if (!smoke && !app.requestSingleInstanceLock()) app.quit();

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
  process.env.MANDI_HOST = "127.0.0.1";
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

app.whenReady().then(async () => {
  let port;
  try {
    port = await startServer();
  } catch (e) {
    if (smoke) { console.error("SMOKE FAIL start", e); app.exit(1); return; }
    dialog.showErrorBox("Mandi Mitra could not start", String(e && e.stack || e));
    app.quit();
    return;
  }
  const base = `http://127.0.0.1:${port}`;
  const up = await waitFor(`${base}/api/health`, 30_000);
  if (smoke) {
    const page = up ? await fetch(`${base}/`).then((r) => r.text()).catch(() => "") : "";
    const ok = up && page.includes("<div id=\"root\"");
    console.log(ok ? `SMOKE OK ${base}` : "SMOKE FAIL no answer");
    app.exit(ok ? 0 : 1);
    return;
  }
  Menu.setApplicationMenu(null);
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1024, minHeight: 640, title: "Mandi Mitra", show: false,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  win.once("ready-to-show", () => { win.maximize(); win.show(); });
  // links to outside sites (AI Studio, Google's limits page) open in the normal browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(base)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(base)) { e.preventDefault(); shell.openExternal(url); }
  });
  await win.loadURL(`${base}/`);
});
