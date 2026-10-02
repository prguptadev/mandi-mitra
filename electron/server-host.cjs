/* Runs the books server in its own process (an Electron utility process), so a
 * long database job never freezes the window, the splash or a drag of the
 * window. main.cjs starts it and talks to it through process.parentPort:
 *
 *   to main:   hello · ready · fatal {message, code, loader} · relaunch
 *   from main: shutdown  (the books are written into the main file and closed, then this process ends)
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

/* A fault in one request must not stop the books for everyone: it is written
   to the log (main.cjs reads this process's output) and the server keeps
   going, as it did inside the app. The one exception is the port being taken
   (it can only happen while starting): main.cjs then starts again on another port. */
process.on("uncaughtException", (e) => {
  console.error("[server] uncaught error:", e);
  if (e && e.code === "EADDRINUSE") {
    send({ type: "fatal", code: "EADDRINUSE", message: String(e.message || e) });
    setTimeout(() => process.exit(1), 50);
  }
});
process.on("unhandledRejection", (e) => console.error("[server] unhandled rejection:", e));

// "Restore a backup" finishes on a fresh start: the books are closed here, then main.cjs restarts the app
globalThis.__mandiRelaunch = () => { closeBooks(); send({ type: "relaunch" }); };

parent.on("message", (e) => {
  const m = e && e.data;
  if (m && m.type === "shutdown") {
    closeBooks();
    process.exit(0);
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
    send({
      type: "fatal", message: String((e && e.message) || e), code: e && e.code, name: e && e.constructor && e.constructor.name,
      loader: loaderProblem(e),
    });
    setTimeout(() => process.exit(1), 50);
  }
})();
