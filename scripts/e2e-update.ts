import "./_guard.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
/* End-to-end: finding an update installer in a folder, on the test server
 * (not the desktop app, so installing is refused) and offline from GitHub.
 * Run through: npm run test:e2e
 */
const BASE = process.env.MANDI_API!;
let bad = 0;
const check = (label: string, ok: boolean, got?: unknown) => {
  if (!ok) bad++;
  console.log(` ${ok ? "PASS" : "FAIL"}  ${label}${got === undefined ? "" : `   ${JSON.stringify(got)}`}`);
};
async function session(name: string, pin: string) {
  let cookie = "";
  const req = async (method: string, p: string, body?: unknown) => {
    const res = await fetch(BASE + p, { method, headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = res.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  const users = (await req("GET", "/auth/users")).json;
  await req("POST", "/auth/login", { userId: users.find((u: any) => u.name === name).id, pin });
  return req;
}
const version = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
const owner = await session("Test Owner", process.env.MANDI_PIN ?? "482915");
const op = await session("Munshi Ji", "271830");

const folder = fs.mkdtempSync(path.join(os.tmpdir(), "mandi-e2e-updates-"));
fs.writeFileSync(path.join(folder, "MandiMitra-Setup-0.0.1.exe"), "old");
fs.writeFileSync(path.join(folder, "MandiMitra-Setup-9.9.9.exe"), "new");
fs.writeFileSync(path.join(folder, "SomethingElse-10.0.0.exe"), "not ours");

console.log("App updates");
check("anyone signed in sees the version", (await op("GET", "/app")).json.version === version, version);
check("only the owner may look for or install updates", (await op("GET", "/app/update")).status === 403 && (await op("POST", "/app/update/install", { name: "x" })).status === 403);
check("a folder that does not exist is refused", (await owner("PUT", "/app/update", { folder: path.join(folder, "nope") })).status === 400);
const found = (await owner("PUT", "/app/update", { folder })).json;
check("the newest installer newer than this version is found; older ones and others are not", found.found?.version === "9.9.9" && found.found.name === "MandiMitra-Setup-9.9.9.exe", found.found);
check("offline from GitHub, it says it could not check the fingerprint", found.found?.verified === null);
check("the folder is kept", (await owner("GET", "/app/update")).json.folder === folder);
const inst = await owner("POST", "/app/update/install", { name: "MandiMitra-Setup-9.9.9.exe" });
check("installing is refused outside the Windows app", inst.status === 400 && /Windows app/.test(inst.json.error), inst.json.error);
fs.rmSync(path.join(folder, "MandiMitra-Setup-9.9.9.exe"));
check("with only older installers there, nothing is offered", (await owner("GET", "/app/update")).json.found === null);
fs.rmSync(folder, { recursive: true, force: true });

console.log(bad === 0 ? "\nUpdates behave." : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
