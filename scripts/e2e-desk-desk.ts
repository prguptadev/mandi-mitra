import "./_guard.ts";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fromThisComputer, DESKTOP_ONLY } from "../server/lib/desktopGate.ts";

/* The Windows app's lock-down and resilience, the parts that run without Electron:
 *  - the server answers only the app's own windows when it runs as the desktop
 *    app (a per-launch key), not Chrome or Edge on the same PC; other computers
 *    on the shop's network still reach it when the books are shared;
 *  - the refused keys and start-up switches (electron/lockdown.cjs);
 *  - the log file stays small (electron/log.cjs).
 * The Electron side (windows, devtools, keys reaching the page, the server's own
 * process, Windows shutdown) is proven by `MandiMitra.exe --smoke-test` in
 * .github/workflows/desktop.yml.
 * Run through: npm run test:e2e
 */
const require = createRequire(import.meta.url);
const lockdown = require("../electron/lockdown.cjs") as {
  blockedKey: (i: Record<string, unknown>) => boolean; zoomKey: (i: Record<string, unknown>) => string | null; bannedSwitches: (a: string[]) => string[];
};
const { openLog } = require("../electron/log.cjs") as { openLog: (dir: string, o?: { maxBytes?: number }) => { file: string; write: (level: string, parts: unknown[]) => void } };

let bad = 0;
const check = (label: string, ok: boolean, got?: unknown) => {
  if (!ok) bad++;
  console.log(` ${ok ? "PASS" : "FAIL"}  ${label}${ok || got === undefined ? "" : `   ${JSON.stringify(got)}`}`);
};

console.log("Desktop app: keys the window refuses");
const key = (code: string, mods: { control?: boolean; shift?: boolean; alt?: boolean; meta?: boolean } = {}, k?: string) =>
  ({ type: "keyDown", code, key: k ?? (code.startsWith("Key") ? code.slice(3).toLowerCase() : code), control: false, shift: false, alt: false, meta: false, ...mods });
const refused: [string, ReturnType<typeof key>][] = [
  ["F12", key("F12")], ["F5", key("F5")], ["Ctrl+F5", key("F5", { control: true })], ["Shift+F5", key("F5", { shift: true })],
  ["Ctrl+R", key("KeyR", { control: true })], ["Ctrl+Shift+R", key("KeyR", { control: true, shift: true }, "R")],
  ["Ctrl+Shift+I", key("KeyI", { control: true, shift: true }, "I")], ["Ctrl+Shift+J", key("KeyJ", { control: true, shift: true }, "J")],
  ["Ctrl+Shift+C", key("KeyC", { control: true, shift: true }, "C")], ["Ctrl+Shift+K", key("KeyK", { control: true, shift: true }, "K")],
  ["Ctrl+Shift+M", key("KeyM", { control: true, shift: true }, "M")], ["Ctrl+U", key("KeyU", { control: true })],
  ["Ctrl+P", key("KeyP", { control: true })], ["Ctrl+N", key("KeyN", { control: true })], ["Ctrl+Shift+N", key("KeyN", { control: true, shift: true }, "N")],
  ["Ctrl+T", key("KeyT", { control: true })], ["Ctrl+L", key("KeyL", { control: true })], ["Ctrl+O", key("KeyO", { control: true })],
  // a Hindi keyboard layout: the letter typed is Devanagari, the physical key is still I
  ["Ctrl+Shift+I on a Hindi layout", key("KeyI", { control: true, shift: true }, "ि")],
  ["Cmd+Alt+I (Mac)", key("KeyI", { meta: true, alt: true }, "ˆ")],
];
for (const [name, input] of refused) check(`refused: ${name}`, lockdown.blockedKey(input) === true, input);
const kept: [string, ReturnType<typeof key>][] = [
  ["typing r", key("KeyR")], ["Shift+R", key("KeyR", { shift: true }, "R")], ["Ctrl+C", key("KeyC", { control: true })], ["Ctrl+V", key("KeyV", { control: true })],
  ["Ctrl+X", key("KeyX", { control: true })], ["Ctrl+A", key("KeyA", { control: true })], ["Ctrl+Z", key("KeyZ", { control: true })],
  ["Ctrl+F", key("KeyF", { control: true })], ["Ctrl+Enter", key("Enter", { control: true }, "Enter")], ["Escape", key("Escape", {}, "Escape")],
  ["AltGr+R (Ctrl+Alt, typing)", key("KeyR", { control: true, alt: true }, "₹")], ["Alt alone", key("AltLeft", { alt: true }, "Alt")],
  ["Alt+F4", key("F4", { alt: true }, "F4")], ["Ctrl+=", key("Equal", { control: true }, "=")],
];
for (const [name, input] of kept) check(`kept: ${name}`, lockdown.blockedKey(input) === false, input);
check("Ctrl + = / - / 0 zoom the page", lockdown.zoomKey(key("Equal", { control: true }, "=")) === "in" && lockdown.zoomKey(key("Minus", { control: true }, "-")) === "out"
  && lockdown.zoomKey(key("Digit0", { control: true }, "0")) === "reset" && lockdown.zoomKey(key("NumpadAdd", { control: true }, "+")) === "in");
check("  ...and plain = - 0 do not (the sheet viewer uses them)", lockdown.zoomKey(key("Equal", {}, "=")) === null && lockdown.zoomKey(key("Digit0", {}, "0")) === null);

console.log("Desktop app: start-up switches it refuses");
const banned = ["--remote-debugging-port=9222", "--remote-debugging-pipe", "/remote-debugging-port=9222", "-Remote-Debugging-Port=9222", "--inspect",
  "--inspect-brk=9229", "--INSPECT=0.0.0.0:9229", "--js-flags=--allow-natives-syntax", "--remote-allow-origins=*", "--user-data-dir=C:\\elsewhere",
  "--auto-open-devtools-for-tabs", "--disable-web-security", "--no-sandbox", "--gpu-launcher=cmd /c calc", "--renderer-cmd-prefix=x", "--debug=5858"];
for (const a of banned) check(`refused: ${a}`, lockdown.bannedSwitches([a]).length === 1, lockdown.bannedSwitches([a]));
const fine = [".", "--smoke-test", "--updated", "--gpu-off", "--locked", "C:\\Users\\Shop\\AppData\\Local\\Programs\\Mandi Mitra\\MandiMitra.exe", "/Users/x/app", "--enable-logging"];
check("normal arguments start the app (., --smoke-test, --updated, --gpu-off, paths)", lockdown.bannedSwitches(fine).length === 0, lockdown.bannedSwitches(fine));

console.log("Desktop app: the log file stays small");
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mandi-e2e-log-test-"));
  const log = openLog(dir, { maxBytes: 2000 });
  for (let i = 0; i < 100; i++) log.write("info", [`line ${i} ${"x".repeat(40)}`]);
  log.write("error", [new Error("a stack trace is kept")]);
  const main = fs.statSync(path.join(dir, "main.log")).size;
  check("it rolls over at its size: one current file and one older one, never more", main <= 2000 && fs.existsSync(path.join(dir, "main.old.log"))
    && fs.readdirSync(dir).length === 2, { main, files: fs.readdirSync(dir) });
  check("  ...errors are written with their stack", /a stack trace is kept[\s\S]*at /.test(fs.readFileSync(path.join(dir, "main.log"), "utf8")));
  const blocked = path.join(dir, "not-a-folder");
  fs.writeFileSync(blocked, "a file where the log folder should be");
  let threw = false;
  try { openLog(path.join(blocked, "logs")).write("info", ["x"]); } catch { threw = true; }
  check("  ...and a log that cannot be written never stops the app", !threw);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("Desktop app: which requests count as this computer's own");
const own = ["127.0.0.1", "::1", "192.168.1.5", "fe80::1c2b:3a4d:5e6f:7a8b"];
check("loopback is this computer", fromThisComputer("127.0.0.1", own) && fromThisComputer("::1", own) && fromThisComputer("::ffff:127.0.0.1", own));
check("this PC's own network address is this computer (Chrome on http://<its IP>:8787)", fromThisComputer("192.168.1.5", own) && fromThisComputer("::ffff:192.168.1.5", own)
  && fromThisComputer("fe80::1c2b:3a4d:5e6f:7a8b%12", own));
check("the second laptop is another computer", !fromThisComputer("192.168.1.23", own) && !fromThisComputer("::ffff:192.168.1.23", own));

/* A server started the way the desktop app starts it: MANDI_DESKTOP=1 and a key. */
const OFF = Number(process.env.E2E_PORT_OFFSET ?? 0);
const PORT = 8804 + OFF;
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "e2e-test-key-0123456789";
const dir = path.resolve("data-test-desk");
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(path.join(dir, "static"), { recursive: true });
fs.writeFileSync(path.join(dir, "static", "index.html"), '<!doctype html><title>Mandi Mitra</title><div id="root"></div>');
const server = spawn("npx", ["tsx", "server/index.ts"], {
  env: {
    ...process.env, PORT: String(PORT), MANDI_DATA_DIR: path.join(dir, "data"), MANDI_STATIC_DIR: path.join(dir, "static"),
    MANDI_DESKTOP: "1", MANDI_DESKTOP_TOKEN: KEY, MANDI_NO_AUTO_BACKUP: "1", MANDI_NO_GITHUB: "1", MANDI_NO_SEED: "0",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout!.on("data", (d) => { serverLog += d; });
server.stderr!.on("data", (d) => { serverLog += d; });
try {
  let upNow = false;
  for (let i = 0; i < 120 && !upNow; i++) {
    try { upNow = (await fetch(`${BASE}/api/health`)).ok; } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  if (!upNow) throw new Error("the desktop-style test server did not start:\n" + serverLog);

  console.log("Desktop app: the server answers the app's own windows only");
  const withKey = { "x-mandi-desktop": KEY };
  const page = await fetch(`${BASE}/`);
  const pageText = await page.text();
  check("Chrome or Edge on this PC opening the app's address get one plain sentence", page.status === 403 && pageText.includes(DESKTOP_ONLY) && /text\/html/.test(page.headers.get("content-type") ?? ""), { status: page.status, pageText: pageText.slice(0, 80) });
  const api = await fetch(`${BASE}/api/auth/users`);
  const apiJson = await api.json() as { code?: string };
  check("  ...and the API refuses them too", api.status === 403 && apiJson.code === "desktop_only", { status: api.status, apiJson });
  const post = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: "x", pin: "7747" }) });
  check("  ...including a sign-in attempt", post.status === 403, post.status);
  const wrong = await fetch(`${BASE}/api/auth/users`, { headers: { "x-mandi-desktop": "not-the-key" } });
  check("  ...and a made-up key", wrong.status === 403, wrong.status);
  const health = await fetch(`${BASE}/api/health`);
  check("the start-up check (/api/health) stays open, and does not claim to be the app's own server", health.ok && health.headers.get("x-mandi-desktop") === null);
  const healthKey = await fetch(`${BASE}/api/health`, { headers: withKey });
  check("  ...with the key it says it is this launch's server", healthKey.ok && healthKey.headers.get("x-mandi-desktop") === "ok");
  const pageKey = await fetch(`${BASE}/`, { headers: withKey });
  check("the app's window (with the key) gets the screens", pageKey.ok && /id="root"/.test(await pageKey.text()));
  const usersKey = await fetch(`${BASE}/api/auth/users`, { headers: withKey });
  check("  ...and the API", usersKey.ok && Array.isArray(await usersKey.json()));
} finally {
  server.kill();
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("Without the desktop key (npm run dev, the tests, the browser preview) there is no gate");
{
  const res = await fetch(`${process.env.MANDI_API}/auth/users`);
  check("the test server answers a plain request", res.ok, res.status);
}

console.log(bad === 0 ? "\nThe desktop app's lock-down holds." : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
