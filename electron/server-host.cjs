/* Runs the books server in its own process (an Electron utility process), so a
 * long database job never freezes the window, the splash or a drag of the
 * window. main.cjs starts it and talks to it through process.parentPort:
 *
 *   to main:   hello · ready · fatal {message, code, loader, mandiUpdateFailed, diskFull, goBack}
 *              · relaunch · closing · install {id, file, args} · closed {backup}
 *   from main: shutdown {backup}  (with backup, a normal close: the day's work into a backup first;
 *                                  then the books are written into the main file and closed, and this process ends)
 *              install-result {id, ok, error}
 *
 * An update's installer is started by main.cjs (the app's own process, as
 * before v0.3.19), never from here: this process ends with the app.
 *
 * If this process cannot run at all, main.cjs starts the server inside the app
 * as before (fail open).
 */
"use strict";
const { pathToFileURL } = require("node:url");

const parent = process.parentPort;
const send = (m) => { try { parent.postMessage(m); } catch { /* main is gone */ } };
send({ type: "hello", pid: process.pid });

/** Writes everything into the books file and closes it (the server's own shutdown, once it has started). */
let closeBooks = () => { try { globalThis.__mandiShutdown?.(); } catch { /* closed already */ } };
/** Leaves once the last message has had a moment to reach main. */
const leave = (code) => setTimeout(() => process.exit(code), 50);

/* A fault in one request must not stop the books for everyone: it is written
   to the log (main.cjs reads this process's output) and the server keeps
   going, as it did inside the app. The one exception is the port being taken
   (it can only happen while starting): main.cjs then starts again on another port. */
process.on("uncaughtException", (e) => {
  console.error("[server] uncaught error:", e);
  if (e && e.code === "EADDRINUSE") {
    closeBooks();
    send({ type: "fatal", code: "EADDRINUSE", message: String(e.message || e) });
    leave(1);
  }
});
process.on("unhandledRejection", (e) => console.error("[server] unhandled rejection:", e));

// "Restore a backup" finishes on a fresh start: the books are closed here, then main.cjs restarts the app
globalThis.__mandiRelaunch = () => { closeBooks(); send({ type: "relaunch" }); };

/* An update (or "Go back") asks main.cjs to start the installer and waits
   until Windows has started it (or could not); server/lib/updater.ts then
   closes the books and this process ends. */
let installs = 0;
const waiting = new Map();
globalThis.__mandiRunInstaller = (file, args) => new Promise((resolve, reject) => {
  const id = ++installs;
  const t = setTimeout(() => { waiting.delete(id); reject(new Error("the installer was not started within 30 s")); }, 30_000);
  waiting.set(id, (m) => { clearTimeout(t); if (m.ok) resolve(); else reject(new Error(m.error || "the installer did not start")); });
  send({ type: "install", id, file, args });
});

parent.on("message", (e) => {
  const m = e && e.data;
  if (!m) return;
  if (m.type === "shutdown") {
    // a normal close: today's work into a backup first (lib/backup.ts decides whether one is due)
    let backup = null;
    if (m.backup) {
      try { backup = globalThis.__mandiBackupOnQuit?.() ?? null; } catch (err) { console.error("[backup] closing backup:", err); }
    }
    closeBooks();
    send({ type: "closed", backup });
    leave(0);
  } else if (m.type === "install-result") {
    const done = waiting.get(m.id);
    waiting.delete(m.id);
    done?.(m);
  }
});

/** A start-up failure of the loading itself (a missing file or a native module that does not load here). */
function loaderProblem(e) {
  const code = e && e.code;
  if (["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND", "ERR_DLOPEN_FAILED", "ERR_REQUIRE_ESM", "ERR_UNKNOWN_FILE_EXTENSION"].includes(code)) return true;
  return /\.node\b|dlopen|NODE_MODULE_VERSION|was compiled against|Cannot find (module|package)/i.test(String(e && e.message));
}

(async () => {
  const entry = process.argv[2];
  try {
    // compiled code is kept between starts, so the next start skips re-reading the server's 3 MB
    try { if (process.env.MANDI_COMPILE_CACHE) require("node:module").enableCompileCache?.(process.env.MANDI_COMPILE_CACHE); } catch { /* slower start, nothing else */ }
    await import(pathToFileURL(entry).href);
    /* An update closes the books itself (server/lib/updater.ts) and then ends
       this process: main.cjs is told first, so it closes the app for the
       installer instead of starting the server again. */
    const close = globalThis.__mandiShutdown;
    closeBooks = () => { try { close?.(); } catch { /* closed already */ } };
    globalThis.__mandiShutdown = () => { send({ type: "closing" }); closeBooks(); };
    send({ type: "ready" });
  } catch (e) {
    console.error("[server] could not start:", e);
    // books that were opened (an update that was rolled back) are closed cleanly: nothing to check at the next start
    closeBooks();
    send({
      type: "fatal", message: String((e && e.message) || e), code: e && e.code, name: e && e.constructor && e.constructor.name,
      loader: loaderProblem(e),
      // an update that could not open the books (they are as they were): main offers the version kept from before
      mandiUpdateFailed: Boolean(e && e.mandiUpdateFailed), diskFull: Boolean(e && e.diskFull),
      goBack: e && e.goBack && e.goBack.file ? { version: String(e.goBack.version), file: String(e.goBack.file) } : null,
    });
    leave(1);
  }
})();
