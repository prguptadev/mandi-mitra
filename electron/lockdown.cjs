/* What the installed app refuses: the keys that open developer tools, reload
 * the page (typed work would be lost) or try to open another window, and the
 * start-up switches that attach a debugger. Plain functions with no Electron in
 * them, so scripts/e2e-desk-desk.ts checks them without starting the app.
 *
 * Kept on purpose: typing (including AltGr and Alt-codes for Hindi), copy,
 * cut, paste, undo, select-all, Ctrl+F, Ctrl+Enter (the scan grid uses it),
 * Esc, Alt+F4 and page zoom (Ctrl + = / - / 0, done by main.cjs because the app
 * has no menu that would do it).
 */
"use strict";

/** The letter on the physical key ("KeyR" -> "r"), whatever the keyboard layout (Hindi too). */
function letterOf(input) {
  const m = /^Key([A-Z])$/.exec(input.code || "");
  if (m) return m[1].toLowerCase();
  const k = String(input.key || "");
  return k.length === 1 ? k.toLowerCase() : "";
}

/** Ctrl on Windows; Cmd on a Mac (only used when testing there). */
const ctrlOf = (input) => Boolean(input.control || input.meta);

/** Ctrl+<letter> that would open a window, show the page source, print through the browser, or go elsewhere. */
const CTRL = new Set(["r", "u", "p", "n", "t", "l", "o"]);
/** Ctrl+Shift+<letter>: developer tools (I J C K M), hard reload (R), new or reopened window (N T). */
const CTRL_SHIFT = new Set(["i", "j", "c", "k", "m", "r", "n", "t"]);

/**
 * True for a key press the window must never act on.
 * `input` is Electron's before-input-event input: { type, key, code, control, shift, alt, meta }.
 */
function blockedKey(input) {
  if (!input) return false;
  const key = String(input.key || "").toLowerCase();
  const code = String(input.code || "");
  // developer tools, and every kind of reload
  if (key === "f12" || code === "F12") return true;
  if (key === "f5" || code === "F5") return true;
  if (key === "browserrefresh" || code === "BrowserRefresh") return true;
  const ctrl = ctrlOf(input);
  if (!ctrl) return false;
  const letter = letterOf(input);
  if (!letter) return false;
  if (input.shift) return CTRL_SHIFT.has(letter);
  // Cmd+Alt+I/J/C open developer tools on a Mac
  if (input.alt && input.meta) return ["i", "j", "c"].includes(letter);
  if (input.alt) return false; // AltGr (Ctrl+Alt) is typing on many keyboards
  return CTRL.has(letter);
}

/** Page zoom on Ctrl + = / + / - / 0 (main and number-pad keys). */
function zoomKey(input) {
  if (!input || input.type !== "keyDown" || !ctrlOf(input) || input.alt) return null;
  const code = String(input.code || "");
  const key = String(input.key || "");
  if (code === "Equal" || code === "NumpadAdd" || key === "+" || key === "=") return "in";
  if (code === "Minus" || code === "NumpadSubtract" || key === "-" || key === "_") return "out";
  if (code === "Digit0" || code === "Numpad0" || key === "0") return "reset";
  return null;
}

/*
 * Start-up switches that open the app to debugging or switch off its
 * protections. Chromium on Windows accepts "--x", "-x" and "/x", in any case,
 * so all three are recognised. Node's own --inspect is also switched off for
 * good by an Electron fuse (electron-builder.yml); this list stops Chromium's.
 */
const BANNED = new Set([
  "remote-debugging-port", "remote-debugging-pipe", "remote-debugging-address", "remote-debugging-io-pipes",
  "remote-allow-origins", "remote-debugging-targets",
  "inspect", "inspect-brk", "inspect-port", "inspect-wait", "inspect-publish-uid", "debug", "debug-brk", "debug-port",
  "js-flags", "user-data-dir",
  "auto-open-devtools-for-tabs", "devtools-flags", "custom-devtools-frontend",
  "disable-web-security", "no-sandbox", "disable-gpu-sandbox", "disable-site-isolation-trials",
  "allow-file-access-from-files", "allow-running-insecure-content", "ignore-certificate-errors",
  "unsafely-treat-insecure-origin-as-secure", "load-extension",
  "gpu-launcher", "renderer-cmd-prefix", "utility-cmd-prefix", "gpu-cmd-prefix", "ppapi-plugin-launcher",
  "browser-subprocess-path", "wait-for-debugger", "wait-for-debugger-children",
  "renderer-startup-dialog", "gpu-startup-dialog", "utility-startup-dialog",
]);
const BANNED_PREFIX = ["remote-debugging", "inspect", "devtools", "debug"];

/** The switch name in an argument ("--Remote-Debugging-Port=9222" -> "remote-debugging-port"), or null. */
function switchName(arg) {
  const m = /^(?:--|-|\/)([A-Za-z][A-Za-z0-9-]*)(?:=.*)?$/s.exec(String(arg));
  return m ? m[1].toLowerCase() : null;
}

/** The refused switches among these arguments (empty when the start is clean). */
function bannedSwitches(args) {
  const out = [];
  for (const a of args) {
    const name = switchName(a);
    if (!name) continue;
    if (BANNED.has(name) || BANNED_PREFIX.some((p) => name.startsWith(p))) out.push(name);
  }
  return out;
}

module.exports = { blockedKey, zoomKey, bannedSwitches, switchName, BANNED };
