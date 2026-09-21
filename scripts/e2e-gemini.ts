import "./_guard.ts";
/* End-to-end: which Gemini model reads a page, against a local stand-in for
 * Google (scripts/fake-gemini.ts) — no real key, no real read.
 *   main   gemini-2.5-flash       its free reads for today are used up
 *   backup gemini-2.5-pro         not free on this key at all
 *   backup gemini-3.5-flash-lite  reads the page (after refusing our thinking setting once)
 * Then "try other models" on the same page must report, and change nothing.
 * Run through: npm run test:e2e
 */
const BASE = process.env.MANDI_API!;
const FAKE = process.env.MANDI_GEMINI_BASE!;
const DATE = "2026-09-23";
let cookie = "";
let bad = 0;

async function raw(method: string, path: string, body?: unknown) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sc = res.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0];
  return res;
}
async function call(method: string, path: string, body?: unknown) {
  const res = await raw(method, path, body);
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
}
const check = (label: string, ok: boolean, got?: unknown) => {
  if (!ok) bad++;
  console.log(` ${ok ? "PASS" : "FAIL"}  ${label}${got === undefined ? "" : `   ${JSON.stringify(got)}`}`);
};
const calls = async () => (await (await fetch(`${FAKE}/__calls`)).json()) as { model: string; thinking: boolean }[];
const count = (cs: { model: string }[], m: string) => cs.filter((c) => c.model === m).length;

const users = await call("GET", "/auth/users");
const owner = users.find((u: any) => u.name === "Test Owner");
await call("POST", "/auth/login", { userId: owner.id, pin: process.env.MANDI_PIN ?? "482915" });
const me = await call("GET", "/auth/me");
const vldm = me.businesses.find((b: any) => b.shortCode === "VLDM");
if (vldm && me.activeBusinessId !== vldm.businessId) await call("POST", "/auth/switch-business", { businessId: vldm.businessId });

await call("PUT", "/settings/gemini", {
  apiKey: "AIzaFAKE-KEY-ONLY-FOR-THE-LOCAL-STAND-IN",
  model: "gemini-2.5-flash", fallbackModel: "gemini-2.5-pro",
  backupModels: ["gemini-2.5-pro", "gemini-3.5-flash-lite"],
});

const mills = await call("GET", "/merchants");
const grm = mills.find((m: any) => m.code === "GRM");
const j1509 = (await call("GET", "/jins")).find((j: any) => j.code === "1509");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const fd = new FormData();
fd.append("files", new File([PNG], "sheet.png", { type: "image/png" }));
fd.append("slipDate", DATE);
fd.append("merchantId", grm.id);
fd.append("jinsId", j1509.id);
const up = await fetch(`${BASE}/scans`, { method: "POST", body: fd, headers: { cookie } });
const { id: scanId } = await up.json() as { id: string };

async function readAndWait(force = false) {
  await call("POST", `/scans/${scanId}/run`, force ? { force: true } : {});
  for (let i = 0; i < 120; i++) {
    const b = await call("GET", `/scans/${scanId}`);
    if (b.status !== "reading" && !b.running) return b;
    await new Promise((r) => setTimeout(r, 250));
  }
  const b = await call("GET", `/scans/${scanId}`);
  throw new Error(`the read did not finish: ${JSON.stringify({ status: b.status, running: b.running, warning: b.warningText, error: b.errorText })} calls ${JSON.stringify(await calls())}`);
}

console.log("Main model used up, first backup not free, second backup reads");
let b = await readAndWait();
let cs = await calls();
check("the page is read", b.status === "review" && b.rows.length === 3, { status: b.status, rows: b.rows?.length, err: b.errorText });
check("…on the second backup", b.model === "gemini-3.5-flash-lite", b.model);
check("the scan says why", /used up/.test(b.warningText ?? "") && /gemini-2\.5-flash, gemini-2\.5-pro/.test(b.warningText ?? ""), b.warningText);
check("a daily refusal is not retried: 1 request to 2.5 Flash", count(cs, "gemini-2.5-flash") === 1, count(cs, "gemini-2.5-flash"));
check("…and 1 to 2.5 Pro", count(cs, "gemini-2.5-pro") === 1, count(cs, "gemini-2.5-pro"));
const lite = cs.filter((c) => c.model === "gemini-3.5-flash-lite");
check("3.5 Flash-Lite refused the thinking setting, then read without it", lite.length === 2 && lite[0].thinking && !lite[1].thinking, lite);
check("a good reading does not go to the weak-read retry", count(cs, "gemini-2.5-pro") === 1);

console.log("\nRead again the same day");
const before = cs.length;
b = await readAndWait(true);
cs = (await calls()).slice(before);
check("models used up today are skipped without asking Google", count(cs, "gemini-2.5-flash") === 0 && count(cs, "gemini-2.5-pro") === 0, cs.map((c) => c.model));
check("…the backup is asked once, without the setting it refused", cs.length === 1 && !cs[0].thinking, cs);
check("…and reads the page", b.status === "review" && b.rows.length === 3);

const usage = await call("GET", "/settings/gemini/usage");
check("usage: main model used up, next page goes to 3.5 Flash-Lite", usage.exhausted === true && usage.next === "gemini-3.5-flash-lite", { exhausted: usage.exhausted, next: usage.next });
check("usage: Google's stated limit of 20 is kept", usage.dailyLimit === 20, usage.dailyLimit);
const models = await call("GET", "/settings/gemini/models");
const ids = models.models.map((m: any) => m.id);
check("models on the key: sheet readers only", models.ok && ids.includes("gemini-3.8-flash") && !ids.includes("gemini-2.5-flash-image") && !ids.includes("gemini-embedding-001"), ids);
check("2.5 Pro shows as not free (limit 0)", models.usage["gemini-2.5-pro"]?.dailyLimit === 0, models.usage["gemini-2.5-pro"]);

console.log("\nTry other models on this page");
const rowsBefore = JSON.stringify((await call("GET", `/scans/${scanId}`)).rows.map((r: any) => [r.rstNo, r.grossGrams, r.ratePaisePerQtl, r.adatiRawText]));
let t = await call("POST", `/scans/${scanId}/try-model`, { model: "gemini-3.5-flash-lite" });
check("same model: 3 of 3 rows same as the scan", t.ok && t.rowsRead === 3 && t.vsScan.same === 3 && t.vsScan.rows === 3, t.vsScan);
check("net check 3 of 3", t.netAgreeing === 3 && t.netChecked === 3);
t = await call("POST", `/scans/${scanId}/try-model`, { model: "gemini-3.8-flash" });
const r902 = t.rows.find((r: any) => r.rstNo === "902");
check("a model that misreads one gross: 2 of 3 same, RST 902 gross differs", t.ok && t.vsScan.same === 2 && r902.diff.join() === "gross", { same: t.vsScan?.same, diff: r902?.diff });
t = await call("POST", `/scans/${scanId}/try-model`, { model: "gemini-2.5-pro" });
check("a model that is not free says so", !t.ok && t.quota?.notFree === true && /no free reads/.test(t.error), t.error);
const badName = await raw("POST", `/scans/${scanId}/try-model`, { model: "../../etc" });
check("a made-up model name is refused", badName.status === 400, badName.status);
const after = await call("GET", `/scans/${scanId}`);
check("trying models changed nothing on the scan", after.status === "review"
  && JSON.stringify(after.rows.map((r: any) => [r.rstNo, r.grossGrams, r.ratePaisePerQtl, r.adatiRawText])) === rowsBefore);

// the yardstick is the scan as the operator corrected it
const edited = after.rows.map((r: any) => r.rstNo === "903" ? { ...r, ratePaisePerQtl: 360_000 } : r);
await call("PUT", `/scans/${scanId}/rows`, { rows: edited });
t = await call("POST", `/scans/${scanId}/try-model`, { model: "gemini-3.5-flash-lite" });
const r903 = t.rows.find((r: any) => r.rstNo === "903");
check("after the operator corrects a rate, the trial compares with the correction", t.vsScan.same === 2 && r903.diff.join() === "rate", { same: t.vsScan.same, diff: r903?.diff });

await call("DELETE", `/scans/${scanId}`);
console.log(bad === 0 ? "\nModel choice and trials behave." : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
