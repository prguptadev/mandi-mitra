import "./_guard.ts";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import Database from "better-sqlite3";
/* End-to-end: signing in, and the shop-network ("Let this network's computers
 * use these books") mode. Test databases only.
 *   1. the test server (this computer only): Host and Origin, request sizes,
 *      the sign-in endpoints that need no PIN
 *   2. a copy of the app run inside this script, shared on the network, on
 *      its own new install (Admin, Manager 1, Manager 2 on 7747, kept until
 *      the owner changes them), with requests arriving from the main computer
 *      and from other devices
 *   3. that new install served on this computer's own network address and
 *      reached over the network (skipped when there is no network)
 * Run through: npm run test:e2e
 */
const API = process.env.MANDI_API!;
const OFF = Number(process.env.E2E_PORT_OFFSET ?? 0);
const PIN = process.env.MANDI_PIN ?? "482915";
let bad = 0;
const check = (label: string, ok: boolean, got?: unknown) => {
  if (!ok) bad++;
  console.log(` ${ok ? "PASS" : "FAIL"}  ${label}${ok || got === undefined ? "" : `   ${JSON.stringify(got)}`}`);
};

interface Reply { status: number; json: any; cookie: string; setCookie: string }
/** Plain HTTP with any headers at all (fetch will not send a made-up Host). */
function send(method: string, url: string, o: { headers?: Record<string, string>; body?: unknown; declare?: number; timeoutMs?: number } = {}): Promise<Reply> {
  return new Promise((resolve) => {
    const u = new URL(url);
    const data = o.body === undefined ? undefined : typeof o.body === "string" ? o.body : JSON.stringify(o.body);
    const headers: Record<string, string | number> = { ...(data !== undefined || o.declare ? { "content-type": "application/json" } : {}), ...o.headers };
    if (o.declare) headers["content-length"] = o.declare;
    else if (data !== undefined) headers["content-length"] = Buffer.byteLength(data);
    const done = (r: Reply) => { clearTimeout(timer); resolve(r); };
    const rq = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (ch) => chunks.push(ch));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        let json: any = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = text; }
        const sc = res.headers["set-cookie"]?.[0] ?? "";
        done({ status: res.statusCode ?? 0, json, cookie: sc.split(";")[0], setCookie: sc });
        if (o.declare) rq.destroy();
      });
    });
    // a size only declared: the server must answer without waiting for the rest
    const timer = setTimeout(() => { rq.destroy(); resolve({ status: 0, json: "no answer", cookie: "", setCookie: "" }); }, o.timeoutMs ?? 5000);
    rq.on("error", () => undefined);
    if (o.declare) rq.write(Buffer.alloc(1024, 32));
    else { if (data !== undefined) rq.write(data); rq.end(); }
  });
}
const qOne = <T = any>(dir: string, sql: string, ...args: unknown[]): T[] => {
  const d = new Database(path.join(dir, "mandi.db"), { readonly: true });
  try { return d.prepare(sql).all(...args) as T[]; } finally { d.close(); }
};

/* ------------------------------------------------------------ 1. the test server */

console.log("This computer only: who may talk to the server");
const u = new URL(API);
const PORT = u.port;
const here = (p: string) => `http://127.0.0.1:${PORT}/api${p}`;
const users = (await send("GET", here("/auth/users"))).json as { id: string; name: string }[];
const owner = users.find((x) => x.name === "Test Owner")!;
const login = await send("POST", here("/auth/login"), { body: { userId: owner.id, pin: PIN } });
check("the owner signs in on this computer", login.status === 200 && !!login.cookie, login.json);
const cookie = login.cookie;
const withMe = { cookie };
const nobody = "no-such-person";

check("a page under another name (DNS rebinding) is refused", (await send("GET", here("/auth/users"), { headers: { host: "rebind.example:" + PORT } })).status === 403);
check("…and so is this computer's name on another port", (await send("GET", here("/auth/users"), { headers: { host: "127.0.0.1:1" } })).json?.code === "bad_host");
const tryLogin = (headers: Record<string, string>) => send("POST", here("/auth/login"), { headers, body: { userId: nobody, pin: "000000" } });
check("a change sent from a sandboxed page (Origin: null) is refused", (await tryLogin({ origin: "null" })).json?.code === "bad_origin");
check("…and from another program's page on this computer (another port)", (await tryLogin({ origin: "http://localhost:3000" })).json?.code === "bad_origin");
check("…and from another site", (await tryLogin({ origin: "https://evil.example" })).json?.code === "bad_origin");
check("the app's own page may (same address and port)", (await tryLogin({ origin: `http://127.0.0.1:${PORT}`, "sec-fetch-site": "same-origin" })).status === 401);
check("the dev screens through Vite may (the browser says same-origin)", (await tryLogin({ origin: "http://localhost:5173", "sec-fetch-site": "same-origin" })).status === 401);
check("…but not a page the browser calls another site", (await tryLogin({ origin: "http://localhost:5173", "sec-fetch-site": "same-site" })).json?.code === "bad_origin");
check("…nor, from a browser that does not say, an address that is not this one", (await tryLogin({ origin: "http://localhost:5173" })).json?.code === "bad_origin");

console.log("\nHow much may be sent");
const big = (n: number) => ({ userId: nobody, pin: "1", pad: "x".repeat(n) });
const signedOutBig = await send("POST", here("/auth/login"), { body: big(100_000) });
check("before signing in, a request of 100 KB is refused (and told to sign in)", signedOutBig.status === 401 && signedOutBig.json?.code === "no_session", signedOutBig.json);
check("…as is a big upload whose sign-in ran out", (await send("POST", here("/scans"), { declare: 5 * 1024 * 1024, timeoutMs: 3000 })).json?.code === "no_session");
check("a PIN of 100 characters is refused before it is checked", (await send("POST", here("/auth/login"), { body: { userId: nobody, pin: "1".repeat(100) } })).status === 400);
const prefs1mb = await send("POST", here("/auth/prefs"), { headers: withMe, body: { lang: "en", pad: "x".repeat(1_000_000) } });
check("signed in, 1 MB is fine", prefs1mb.status === 200, prefs1mb.json);
const huge = await send("POST", here("/auth/prefs"), { headers: withMe, declare: 60 * 1024 * 1024, timeoutMs: 3000 });
check("…60 MB is refused at once, without reading it", huge.status === 413, huge.status);
check("a sheet upload may be bigger (ten pages of 12 MB)", (await send("POST", here("/scans"), { headers: withMe, declare: 100 * 1024 * 1024, timeoutMs: 3000 })).status !== 413);

console.log("\nWhat needs no PIN");
check("the Hindi-to-English helper needs a sign-in", (await send("POST", here("/auth/transliterate"), { body: { text: "राम" } })).status === 401);
check("…and the English-to-Hindi one too, once anyone exists", (await send("POST", here("/auth/to-devanagari"), { body: { text: "ram" } })).status === 401);
check("signed in, both work", (await send("POST", here("/auth/transliterate"), { headers: withMe, body: { text: "राम" } })).status === 200
  && (await send("POST", here("/auth/to-devanagari"), { headers: withMe, body: { text: "ram" } })).json?.converted === true);
check("…for text of a sensible length", (await send("POST", here("/auth/to-devanagari"), { headers: withMe, body: { text: "ram ".repeat(1000) } })).status === 400);

const dataA = process.env.MANDI_DATA_DIR!;
const lastLogin = qOne<{ ip: string | null }>(dataA, "select ip from audit_log where action = 'login' order by at desc, id desc limit 1")[0];
check("the audit trail records the device a sign-in came from", lastLogin?.ip === "127.0.0.1", lastLogin);
const life = qOne<{ d: number }>(dataA, "select expires_at - created_at as d from sessions order by created_at desc, id desc limit 1")[0];
check("a sign-in on the main computer lasts a month, as before", life?.d === 30 * 86400, life);
await send("POST", here("/auth/logout"), { headers: withMe });

/* ------------------------------------------------------------ 2. shared on the network, in-process */

console.log("\nShared on the shop's network: a new install");
const DIR = path.resolve("data-test-auth");
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });
process.env.MANDI_DATA_DIR = DIR;
process.env.MANDI_HOST = "0.0.0.0";
process.env.PORT = "8787";
delete process.env.MANDI_NO_SEED;
// this computer's own address on a private network (a shop's router hands out these), if it has one
const lanIp = Object.values(os.networkInterfaces()).flat()
  .find((n) => n && n.family === "IPv4" && !n.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(n.address))?.address ?? null;
const { runMigrations } = await import("../server/db/migrate.ts");
runMigrations();
const { seedFirstRun } = await import("../server/lib/businessSetup.ts");
await seedFirstRun();
const { createApp } = await import("../server/app.ts");
const { weakPin } = await import("../server/lib/auth.ts");
const app = createApp();
const HOST = `${lanIp ?? "127.0.0.1"}:8787`;

/** A device on the network (or the main computer, 127.0.0.1), with its own cookie. */
function device(addr: string) {
  let jar = "";
  async function call(method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
    const res = await app.fetch(new Request(`http://${HOST}/api${p}`, {
      method,
      headers: {
        host: HOST, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(jar ? { cookie: jar } : {}),
        // what a browser adds to a change made from the app's own page
        ...(method !== "GET" ? { origin: `http://${HOST}`, "sec-fetch-site": "same-origin" } : {}), ...headers,
      },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    }), { incoming: { socket: { remoteAddress: addr, remotePort: 50123, remoteFamily: addr.includes(":") ? "IPv6" : "IPv4", localPort: 8787 } }, outgoing: {} });
    const sc = res.headers.get("set-cookie") ?? "";
    if (sc) jar = /max-age=0/i.test(sc) ? "" : sc.split(";")[0];
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, json, cookie: sc.split(";")[0], setCookie: sc };
  }
  return { call, get cookie() { return jar; }, set cookie(v: string) { jar = v; } };
}
const MAIN = device("127.0.0.1");
const LAN1 = device("192.168.1.50");
const LAN2 = device("192.168.1.51");
const FAR = device("8.8.8.8");
const who = (await MAIN.call("GET", "/auth/users")).json as { id: string; name: string }[];
const id = (n: string) => who.find((x) => x.name === n)!.id;
const q = <T = any>(sql: string, ...args: unknown[]) => qOne<T>(DIR, sql, ...args);

check("an address on the open internet gets no answer", (await FAR.call("GET", "/auth/users")).json?.code === "bad_network");
check("a page under another name (DNS rebinding) is refused, sharing or not", (await LAN1.call("GET", "/auth/users", undefined, { host: "rebind.example:8787" })).json?.code === "bad_host");
check("another device using this computer's own address is answered", (await LAN1.call("GET", "/auth/users")).status === 200);
const pcName = os.hostname().toLowerCase().split(".")[0];
check("…or its computer name, bare or .local", (await LAN1.call("GET", "/auth/users", undefined, { host: `${pcName}:8787` })).status === 200
  && (await LAN1.call("GET", "/auth/users", undefined, { host: `${pcName}.local:8787` })).status === 200);
check("…but not a public site that borrows the computer's name", (await LAN1.call("GET", "/auth/users", undefined, { host: `${pcName}.com:8787` })).json?.code === "bad_host");
check("a change from another site's page is refused", (await LAN1.call("POST", "/auth/login", { userId: id("Admin"), pin: "7747" }, { origin: "http://rebind.example:8787", "sec-fetch-site": "cross-site" })).json?.code === "bad_origin");

console.log("\nThe first PIN (7747), kept until the owner changes it");
const remote7747 = await LAN1.call("POST", "/auth/login", { userId: id("Admin"), pin: "7747" });
check("from another device, the Admin still on 7747 signs in", remote7747.status === 200 && !!remote7747.cookie, remote7747.json);
await LAN1.call("POST", "/auth/logout");
const main7747 = await MAIN.call("POST", "/auth/login", { userId: id("Admin"), pin: "7747" });
check("on the main computer, 7747 signs straight in (no box asking for an own PIN)", main7747.status === 200 && !!main7747.cookie && (await MAIN.call("GET", "/auth/me")).json?.user?.name === "Admin", main7747.json);
check("there is no forced first-PIN step any more", (await device("127.0.0.1").call("POST", "/auth/first-pin", { userId: id("Admin"), pin: "7747", newPin: "639184" })).status === 404);
const ADMIN_PIN = "639184", M1_PIN = "471526";
check("an obviously weak new PIN is still refused when changing it", (await MAIN.call("POST", "/auth/change-pin", { currentPin: "7747", newPin: "1234" })).json?.code === "weak_pin");
check("the owner changes the Admin's PIN himself", (await MAIN.call("POST", "/auth/change-pin", { currentPin: "7747", newPin: ADMIN_PIN })).status === 200);
check("…then 7747 no longer opens the Admin", (await device("127.0.0.1").call("POST", "/auth/login", { userId: id("Admin"), pin: "7747" })).status === 401);
check("the weak-PIN rule (new PINs only) refuses 0000, 1234, 1111 and allows 7747 and a real PIN", ["0000", "1234", "1111"].every((p) => weakPin(p)) && weakPin("582047") === null && weakPin("7747") === null);
const m1 = device("127.0.0.1");
check("Manager 1 signs in on 7747 too", (await m1.call("POST", "/auth/login", { userId: id("Manager 1"), pin: "7747" })).status === 200);
check("…and the PIN is changed to another", (await m1.call("POST", "/auth/change-pin", { currentPin: "7747", newPin: M1_PIN })).status === 200);

console.log("\nSign-ins from other devices");
const lanLogin = await LAN1.call("POST", "/auth/login", { userId: id("Admin"), pin: ADMIN_PIN });
check("with an own PIN, another device signs in", lanLogin.status === 200 && !!LAN1.cookie, lanLogin.json);
check("…for the working day (12 hours), not a month", /max-age=43200/i.test(lanLogin.setCookie)
  && q<{ d: number }>("select expires_at - created_at as d from sessions where user_id = ? order by created_at desc, id desc limit 1", id("Admin"))[0]?.d === 12 * 3600, lanLogin.setCookie);
const stolen = device("192.168.1.99");
stolen.cookie = MAIN.cookie;
check("the main computer's month-long sign-in does not work from another device", (await stolen.call("GET", "/auth/me")).status === 401);
check("…while it still works on the main computer", (await MAIN.call("GET", "/auth/me")).status === 200);

console.log("\nWhat only the main computer may change");
const mainOnly: [string, string, unknown][] = [
  ["PUT", "/backup", { folder: "\\\\attacker\\share" }],
  ["POST", "/backup/restore", { name: "x.db", confirm: "RESTORE" }],
  ["POST", "/backup/open-folder", { which: "data" }],
  ["PUT", "/app/update", { folder: "C:\\Updates" }],
  ["POST", "/app/update/install", { name: "x.exe" }],
  ["PUT", "/cloud", { connection: null }],
  ["POST", "/cloud/join", { connection: "postgresql://a:b@c/d", confirm: "JOIN" }],
  ["POST", "/cloud/restore", { confirm: "RESTORE" }],
  ["POST", "/cloud/live", { on: false }],
  ["PUT", "/cloud/device", { name: "Phone" }],
  ["PUT", "/cloud/network", { share: false }],
];
const refused = await Promise.all(mainOnly.map(([m, p, b]) => LAN1.call(m, p, b)));
check("backup folder, restore, data folder, updates, cloud and network: refused from another device",
  refused.every((r) => r.status === 403 && r.json?.code === "main_computer_only"), mainOnly.map(([m, p], i) => `${m} ${p} ${refused[i].status}`).filter((_, i) => refused[i].status !== 403));
check("…with one plain sentence", refused[0].json?.error === "This can be done only on the main computer.");
check("the books themselves still work from there", (await LAN1.call("GET", "/cloud/host")).status === 200 && (await LAN1.call("GET", "/backup")).status === 200);
check("the main computer may change them", (await MAIN.call("PUT", "/backup", { folder: null })).status === 200 && (await MAIN.call("PUT", "/cloud/network", { share: true })).status === 200);
check("sign-up and joining from the first screen are the main computer's too", (await LAN2.call("POST", "/auth/signup", {})).json?.code === "main_computer_only"
  && (await LAN2.call("POST", "/cloud/join-fresh", { connection: "x" })).json?.code === "main_computer_only");

console.log("\nWrong PINs from another device");
const tryM1 = (d: ReturnType<typeof device>, pin: string) => d.call("POST", "/auth/login", { userId: id("Manager 1"), pin });
const wrongs: Reply[] = [];
for (let i = 0; i < 5; i++) wrongs.push(await tryM1(LAN1, "135790"));
check("four tries say how many are left", wrongs[0].json?.error === "Wrong PIN. 4 attempts left." && wrongs[3].json?.error === "Wrong PIN. 1 attempt left.", wrongs.map((w) => w.json?.error));
check("the fifth makes that device wait 5 minutes", wrongs[4].json?.error === "Wrong PIN. Try again in 5 min.", wrongs[4].json);
check("…even with the right PIN, from that device", (await tryM1(LAN1, M1_PIN)).status === 429);
check("the second laptop still signs Manager 1 in", (await tryM1(LAN2, M1_PIN)).status === 200);
check("the main computer still signs Manager 1 in", (await tryM1(device("127.0.0.1"), M1_PIN)).status === 200);
check("the main computer's own count was never touched", q<{ n: number }>("select failed_attempts as n from users where id = ?", id("Manager 1"))[0]?.n === 0);
const failed = q<{ ip: string | null; business_id: string | null; entity_label: string }>("select ip, business_id, entity_label from audit_log where action = 'login.failed' and user_id = ?", id("Manager 1"));
check("the audit trail names the device of each wrong PIN, in the firm's own trail", failed.length === 5 && failed.every((f) => f.ip === "192.168.1.50" && f.business_id && f.entity_label.includes("192.168.1.50")), failed[0]);
const realNow = Date.now;
let skew = 0;
Date.now = () => realNow() + skew;
skew += 6 * 60_000;
for (let i = 0; i < 4; i++) await tryM1(LAN1, "135791");
check("after the wait, five more tries, then a longer wait (15 minutes)", (await tryM1(LAN1, "135791")).json?.error === "Wrong PIN. Try again in 15 min.");
// a device that keeps changing its address: 20 wrong PINs a day for one person, all other devices together
for (let d = 0; d < 3; d++) for (let i = 0; i < 4; i++) await tryM1(device(`192.168.1.${70 + d}`), "135792");
const capped = await tryM1(LAN2, M1_PIN);
check("after 20 wrong PINs from other devices, other devices wait an hour for that person", capped.status === 429 && /60 min/.test(capped.json?.error ?? ""), capped.json);
check("…but never the main computer", (await tryM1(device("127.0.0.1"), M1_PIN)).status === 200);
const mems = (await MAIN.call("GET", "/users")).json as { membershipId: string; userId: string; isRoot: boolean; lockedUntil: number | null }[];
const m1Membership = mems.find((x) => x.userId === id("Manager 1"))!.membershipId;
check("Users shows Manager 1 as locked, so the Unlock button is there", (mems.find((x) => x.userId === id("Manager 1"))!.lockedUntil ?? 0) > Math.floor(Date.now() / 1000));
check("the Admin's Unlock lets them all try again", (await MAIN.call("PUT", `/users/${m1Membership}`, { unlock: true })).status === 200 && (await tryM1(LAN2, M1_PIN)).status === 200);
const m1Lan = device("192.168.1.80");
await tryM1(m1Lan, M1_PIN);
Date.now = realNow;

console.log("\nA forgotten Admin PIN");
const m1Main = device("127.0.0.1");
await tryM1(m1Main, M1_PIN);
const adminMembership = mems.find((x) => x.isRoot)!.membershipId;
check("an Owner at another device cannot reset the Admin's PIN", (await m1Lan.call("PUT", `/users/${adminMembership}`, { resetPin: "730561" })).status === 403);
check("an Owner at the main computer can", (await m1Main.call("PUT", `/users/${adminMembership}`, { name: "Admin", resetPin: "730561" })).status === 200);
check("…and the Admin signs in with it", (await device("127.0.0.1").call("POST", "/auth/login", { userId: id("Admin"), pin: "730561" })).status === 200);

console.log("\nSharing switched off");
check("sign-in from another device works before", (await m1Lan.call("GET", "/auth/me")).status === 200);
check("the main computer switches sharing off", (await m1Main.call("PUT", "/cloud/network", { share: false })).status === 200);
check("every sign-in made from another device ends", (await m1Lan.call("GET", "/auth/me")).status === 401 && (await LAN2.call("GET", "/auth/me")).status === 401);
check("…the main computer's do not", (await m1Main.call("GET", "/auth/me")).status === 200);
check("before signing in, 100 KB is refused here too", (await LAN1.call("POST", "/auth/login", big(100_000))).json?.code === "no_session");

/* ------------------------------------------------------------ 3. over the real network */

if (!lanIp) {
  console.log("\n(no network address on this computer: the over-the-network checks are skipped)");
} else {
  console.log(`\nOver the network, at ${lanIp}`);
  const NET_DIR = path.resolve("data-test-auth-net");
  fs.rmSync(NET_DIR, { recursive: true, force: true });
  fs.mkdirSync(NET_DIR, { recursive: true });
  const NET_PORT = String(8804 + OFF);
  const env = { ...process.env, MANDI_DATA_DIR: NET_DIR, PORT: NET_PORT, MANDI_HOST: lanIp, MANDI_NO_AUTO_BACKUP: "1" };
  delete (env as Record<string, string | undefined>).MANDI_NO_SEED;
  const srv = spawn("npx", ["tsx", "server/index.ts"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  srv.stdout!.on("data", (d) => { log += d; });
  srv.stderr!.on("data", (d) => { log += d; });
  const there = (p: string) => `http://${lanIp}:${NET_PORT}/api${p}`;
  try {
    let up = false;
    for (let i = 0; i < 120 && !up; i++) {
      up = (await send("GET", there("/health"), { timeoutMs: 1000 })).status === 200;
      if (!up) await new Promise((r) => setTimeout(r, 250));
    }
    check("the shared server answers on this computer's network address", up, log.slice(-500));
    const people = (await send("GET", there("/auth/users"))).json as { id: string; name: string }[];
    const admin = people.find?.((x) => x.name === "Admin");
    check("…with the new install's people", !!admin, people);
    const r = await send("POST", there("/auth/login"), { body: { userId: admin?.id, pin: "7747" } });
    check("reached over the network, a person on 7747 signs in for the working day (the address comes from the connection)", r.status === 200 && /max-age=43200/i.test(r.setCookie), r.json);
    check("a made-up name is refused over the network too", (await send("GET", there("/auth/users"), { headers: { host: `rebind.example:${NET_PORT}` } })).status === 403);
    check("this computer's name on another port is refused", (await send("GET", there("/auth/users"), { headers: { host: `${lanIp}:1` } })).status === 403);
  } finally {
    srv.kill();
    await new Promise((r) => setTimeout(r, 300));
    fs.rmSync(NET_DIR, { recursive: true, force: true });
  }
}

fs.rmSync(DIR, { recursive: true, force: true });
console.log(bad === 0 ? "\nSign-in and network checks pass." : `\n${bad} FAILED`);
process.exit(bad ? 1 : 0);
