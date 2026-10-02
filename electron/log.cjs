/* A small log file the owner can send when something goes wrong:
 * <userData>/logs/main.log, about 1 MB at most, with the previous one kept as
 * main.old.log. Writing never throws into the app: a full disk or a locked
 * file only means a line is not written. No Electron in here, so
 * scripts/e2e-desk-desk.ts checks the rotation on its own.
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const util = require("node:util");

function openLog(dir, { maxBytes = 1_000_000 } = {}) {
  const file = path.join(dir, "main.log");
  const old = path.join(dir, "main.old.log");
  let size = 0;
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* written nowhere, then */ }
  try { size = fs.statSync(file).size; } catch { size = 0; }

  function rotate() {
    try { fs.rmSync(old, { force: true }); } catch { /* keep going */ }
    try { fs.renameSync(file, old); } catch { /* keep going */ }
    size = 0;
  }

  /** One line, with the time; objects and errors are written out in full (stack included). */
  function write(level, parts) {
    try {
      const text = parts.map((p) => (typeof p === "string" ? p : util.inspect(p, { depth: 4, breakLength: Infinity }))).join(" ");
      const d = new Date();
      const p2 = (n) => String(n).padStart(2, "0");
      const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")}`;
      const line = `${stamp} ${level.padEnd(5)} ${text.replace(/\r?\n(?!$)/g, "\n    ")}\n`;
      if (size + line.length > maxBytes) rotate();
      fs.appendFileSync(file, line);
      size += Buffer.byteLength(line);
    } catch { /* never let the log stop the app */ }
  }
  return { file, dir, write };
}

/** Sends console.log / warn / error to the log as well as to the terminal (CI reads the terminal). */
function mirrorConsole(log) {
  for (const [method, level] of [["log", "info"], ["info", "info"], ["warn", "warn"], ["error", "error"]]) {
    const orig = console[method].bind(console);
    console[method] = (...a) => {
      try { orig(...a); } catch { /* no terminal */ }
      log.write(level, a);
    };
  }
}

module.exports = { openLog, mirrorConsole };
