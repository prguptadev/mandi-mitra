import "./_guard.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sqlite } from "../server/db/client.ts";
/* End-to-end: scanning from the scanner (a stand-in that returns a small
 * JPEG, see test-e2e.ts) and backups, on the test database only.
 * Run through: npm run test:e2e
 */
const BASE = process.env.MANDI_API!;
let cookie = "";
let bad = 0;
async function raw(method: string, p: string, body?: unknown) {
  const res = await fetch(BASE + p, {
    method, headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sc = res.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0];
  return res;
}
async function call(method: string, p: string, body?: unknown) {
  const res = await raw(method, p, body);
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
}
const check = (label: string, ok: boolean, got?: unknown) => {
  if (!ok) bad++;
  console.log(` ${ok ? "PASS" : "FAIL"}  ${label}${got === undefined ? "" : `   ${JSON.stringify(got)}`}`);
};

const users = await call("GET", "/auth/users");
await call("POST", "/auth/login", { userId: users.find((u: any) => u.name === "Test Owner").id, pin: process.env.MANDI_PIN ?? "482915" });
const me = await call("GET", "/auth/me");
const vldm = me.businesses.find((b: any) => b.shortCode === "VLDM");
if (vldm && me.activeBusinessId !== vldm.businessId) await call("POST", "/auth/switch-business", { businessId: vldm.businessId });
const j1509 = (await call("GET", "/jins")).find((j: any) => j.code === "1509");

console.log("Scan from the scanner");
check("the scanner is reachable", (await call("GET", "/scanner")).available === true);
const dev = await call("GET", "/scanner/devices");
check("it is listed by name", dev.devices.length === 1 && dev.devices[0].name === "Test scanner", dev.devices);
const p1 = await call("POST", "/scanner/scan", { dpi: 300, color: true, slipDate: "2026-09-24", jinsId: j1509.id });
check("page 1 starts a new sheet", Boolean(p1.id) && p1.pages === 1, p1);
const p2 = await call("POST", "/scanner/scan", { dpi: 300, color: true, scanId: p1.id });
check("page 2 joins the same sheet", p2.id === p1.id && p2.pages === 2, p2);
const sheet = await call("GET", `/scans/${p1.id}`);
check("the sheet has both pages, dated and waiting to be read", sheet.pages.length === 2 && sheet.slipDate === "2026-09-24" && sheet.status === "uploaded", { pages: sheet.pages.length, status: sheet.status });
const img = await raw("GET", `/scans/${p1.id}/page/1`);
const bytes = Buffer.from(await img.arrayBuffer());
check("the page is the scanner's image", img.ok && bytes[0] === 0xff && bytes[1] === 0xd8, img.status);
const tooLow = await raw("POST", "/scanner/scan", { dpi: 50 });
check("a silly resolution is refused", tooLow.status === 400);
sqlite.prepare("update scan_batches set status = 'review' where id = ?").run(p1.id);
const late = await raw("POST", "/scanner/scan", { scanId: p1.id });
check("a sheet already read takes no more pages", late.status === 409, late.status);
sqlite.prepare("update scan_batches set status = 'uploaded' where id = ?").run(p1.id);
await call("DELETE", `/scans/${p1.id}`);

console.log("\nBackups");
const r1 = await call("POST", "/backup/run");
check("back up now makes a manual backup", /^manual-\d{8}-\d{6}\.db$/.test(r1.name) && r1.bytes > 0, r1.name);
const list = await call("GET", "/backup");
check("it is listed", list.backups.some((b: any) => b.name === r1.name));
const dl = await raw("GET", `/backup/file/${r1.name}`);
const head = Buffer.from(await dl.arrayBuffer()).subarray(0, 15).toString();
check("it downloads as a real SQLite database", dl.ok && head === "SQLite format 3", head);
const slips = sqlite.prepare("select count(*) as n from purchase_slips").get() as { n: number };
const copy = new (await import("better-sqlite3")).default(path.join(process.env.MANDI_DATA_DIR!, "backups", r1.name), { readonly: true });
const inCopy = copy.prepare("select count(*) as n from purchase_slips").get() as { n: number };
copy.close();
check("the backup holds the same slips as the database", inCopy.n === slips.n, { copy: inCopy.n, db: slips.n });
check("a made-up file name is refused", (await raw("GET", "/backup/file/..%2F..%2Fmandi.db")).status >= 400);
check("a relative folder is refused", (await raw("PUT", "/backup", { folder: "backups" })).status === 400);
check("a folder that does not exist is refused", (await raw("PUT", "/backup", { folder: path.join(os.tmpdir(), "no-such-folder-mandi-e2e") })).status === 400);
const second = fs.mkdtempSync(path.join(os.tmpdir(), "mandi-e2e-backup-"));
await call("PUT", "/backup", { folder: second });
const r2 = await call("POST", "/backup/run");
check("with a second folder set, each backup is copied there too", fs.existsSync(path.join(second, "MandiMitra-backups", r2.name)), r2.name);
await call("PUT", "/backup", { folder: null });
fs.rmSync(second, { recursive: true, force: true });

console.log(bad === 0 ? "\nScanner and backups work." : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
