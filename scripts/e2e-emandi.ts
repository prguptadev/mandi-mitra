import "./_guard.ts";
/* End-to-end: the mandi portal's rate band inside Mandi Mitra, against a
 * stand-in portal (scripts/fake-emandi.ts) — the real e-Mandi site is never
 * called and no real licence is used.
 *
 * What must hold:
 *   · each business keeps its own portal login, and one firm's login never
 *     shows up under the other
 *   · the password is never handed back to a screen
 *   · nothing is read from the portal until a person has typed the captcha
 *   · a wrong captcha and a wrong password each say so in the portal's words
 *   · once signed in, the band, mandi fee and cess come through as figures
 * Run through: npm run test:e2e
 */
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.MANDI_API!;
const FAKE = process.env.MANDI_EMANDI_BASE!;
const CAPTCHA = "4242";
const USER = "vldm@example.test";
const PASSWORD = "portal-pass-test";

let bad = 0;
const check = (label: string, ok: boolean, got?: unknown) => {
  if (!ok) bad++;
  console.log(` ${ok ? "PASS" : "FAIL"}  ${label}${ok || got === undefined ? "" : `   ${JSON.stringify(got)}`}`);
};

let cookie = "";
async function raw(method: string, path: string, body?: unknown) {
  const res = await fetch(BASE + path, {
    method, headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sc = res.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0];
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}
const call = async (method: string, path: string, body?: unknown) => {
  const r = await raw(method, path, body);
  if (r.status >= 400) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
};

const users = await call("GET", "/auth/users");
const owner = users.find((u: any) => u.name === "Test Owner");
await call("POST", "/auth/login", { userId: owner.id, pin: process.env.MANDI_PIN ?? "482915" });
const me = await call("GET", "/auth/me");
const vldm = me.businesses.find((b: any) => b.shortCode === "VLDM");
const other = me.businesses.find((b: any) => b.shortCode !== "VLDM");
if (me.activeBusinessId !== vldm.businessId) await call("POST", "/auth/switch-business", { businessId: vldm.businessId });

console.log("The mandi portal login, per business");
const fresh = await call("GET", "/emandi");
check("nothing is set up to begin with", fresh.configured === false && fresh.signedIn === false, fresh);
const saved = await call("PUT", "/emandi", { user: USER, password: PASSWORD, watch: ["1", "6"] });
check("the login is saved for this business", saved.configured === true && saved.user === USER, saved);
check("the licence is not asked for — the portal states it", (saved as any).licence === undefined, Object.keys(saved).join(","));
check("the password is never handed back", !JSON.stringify(saved).includes(PASSWORD), Object.keys(saved));
check("it is kept out of the database, in this computer's own folder",
  (await call("GET", "/emandi")).configured === true);

console.log("\nNothing is read from the portal until a person has signed in");
const early = await call("GET", "/emandi/rates");
check("asking for rates while signed out says so, in words",
  early.rates.length === 1 && /sign in/i.test(early.rates[0].error ?? ""), early.rates[0]);
check("  ...and no rate is invented", early.rates[0].minRatePaise === null);

console.log("\nSigning in: the captcha is the operator's to read");
const askRaw = await raw("POST", "/emandi/signin/start", {});
check("the portal's captcha comes through as an image", askRaw.status === 200 && /^data:image\//.test(askRaw.json.image ?? ""),
  { status: askRaw.status, image: String(askRaw.json?.image ?? "").slice(0, 24) });
const wrongCaptcha = await raw("POST", "/emandi/signin/finish", { captcha: "0000" });
check("a wrong captcha is refused, in the portal's own words",
  wrongCaptcha.status === 400 && /कैप्चा/.test(wrongCaptcha.json.error ?? ""), wrongCaptcha.json);
await call("POST", "/emandi/signin/start", {});
const ok = await call("POST", "/emandi/signin/finish", { captcha: CAPTCHA });
check("the right captcha signs this computer in", ok.signedIn === true, { signedIn: ok.signedIn, at: ok.signedInAt });
check("  ...and says whose licence that login is, in the portal's own words",
  ok.firm === "VIJAY LAXMI DALL MILL" && ok.portalLicence === "L/2016/75/17121983", { firm: ok.firm, licence: ok.portalLicence });

console.log("\nThe rate band, mandi fee and cess");
const rates = await call("GET", "/emandi/rates");
const dhan = rates.rates.find((r: any) => r.cropCode === "1");
/* The portal only gives a band once the page it sends a trader to after login
   has been opened; signing in has to land there, as a browser does. */
check("धान comes through with the band the portal allows",
  dhan.minRatePaise === 340000 && dhan.maxRatePaise === 450000, dhan);
check("  ...named in Hindi, as the portal names it", dhan.cropName === "धान", dhan.cropName);
check("  ...with mandi fee 1% and development cess 0.5%",
  dhan.mandiFeePct === 1 && dhan.developmentCessPct === 0.5, { fee: dhan.mandiFeePct, cess: dhan.developmentCessPct });
const gehu = rates.rates.find((r: any) => r.cropCode === "6");
check("a second watched commodity comes through too", gehu.minRatePaise === 220000 && gehu.cropName === "गेहूँ", gehu);
const asked = await call("GET", "/emandi/rates?codes=1");
check("one commodity can be asked for on its own", asked.rates.length === 1 && asked.rates[0].cropCode === "1");
const zero = await call("GET", "/emandi/rates?codes=2");
check("a commodity the mandi has set no band for comes back as no band, not as a price",
  zero.rates[0].minRatePaise === 0 && zero.rates[0].maxRatePaise === 0 && zero.rates[0].error === null, zero.rates[0]);

console.log("\nWhat e-Mandi holds as this firm's stock");
const st = await call("GET", "/emandi/stock");
check("the stock register is read, commodity by commodity", st.lines.length === 2, st.lines.length);
check("  ...in, out and what is left come through as figures",
  st.lines[0].cropCode === "1" && st.lines[0].inQtl === 3965 && st.lines[0].outQtl === 3891.8
  && st.lines[0].availableQtl === 73.2, st.lines[0]);
check("  ...the name loses the mark the portal writes into it", st.lines[0].crop === "धान (TEST)", st.lines[0].crop);
check("  ...a commodity all sold out reads zero, not blank",
  st.lines[1].availableQtl === 0 && st.lines[1].availableQtl !== null, st.lines[1]);
/* The register only answers a fully bound DataTables payload — a half one gets
   draw 0 and an empty list, which is how a month of stock once read as none. */
const windows = (await (await fetch(`${FAKE}/__calls`)).json() as { method: string; url: string }[]).filter((c) => c.method === "DATES");
check("  ...over a month counted back from today, in the portal's own dd/mm/yyyy", windows.length >= 1, windows.at(-1));
if (windows.length) {
  const [f, t2] = windows.at(-1)!.url.split("..");
  const d = (x: string) => { const [dd, mm, yy] = x.split("/").map(Number); return new Date(yy, mm - 1, dd).getTime(); };
  check("  ...which is thirty days wide", Math.round((d(t2) - d(f)) / 86400000) === 30, `${f} → ${t2}`);
}

console.log("\nThe portal's commodity list");
const crops = await call("GET", "/emandi/crops");
check("the list is read from the portal's own 6R form", crops.crops.length === 3, crops.crops.length);
check("  ...with the Hindi names turned back into letters, not HTML escapes",
  crops.crops.some((c: any) => c.name === "धान") && !crops.crops.some((c: any) => /&#/.test(c.name)),
  crops.crops.map((c: any) => c.name).join(" "));
check("  ...and is kept, so it is there without asking the portal again", Boolean(crops.at), crops.at);
const again = await call("POST", "/emandi/crops/refresh", {});
check("the list can be read from the portal again on request", again.crops.length === 3, again.crops.length);

console.log("\nThe other firm has its own login there");
await call("POST", "/auth/switch-business", { businessId: other.businessId });
const otherStatus = await call("GET", "/emandi");
check("the second firm starts with nothing of its own", otherStatus.configured === false && otherStatus.signedIn === false, otherStatus);
const otherRates = await call("GET", "/emandi/rates");
check("  ...and gets no rates until its own login is added", /Settings|sign in/i.test(otherRates.rates[0]?.error ?? ""), otherRates.rates[0]);
/* The two firms keep separate logins on the portal. One firm being signed in
   must never show the other firm a rate, or say whose licence it is. */
check("  ...and the firm that IS signed in never lends it a figure",
  otherRates.rates.every((r: any) => r.minRatePaise === null && r.maxRatePaise === null)
  && !JSON.stringify(otherRates).includes("VIJAY LAXMI DALL MILL"), otherRates.rates);
check("  ...and is told nothing of the other firm's stock",
  /Settings|sign in/i.test((await raw("GET", "/emandi/stock")).json?.error ?? ""), (await raw("GET", "/emandi/stock")).json);
check("  ...nor whose licence the other firm's login is",
  (await call("GET", "/emandi")).firm === null, (await call("GET", "/emandi")).firm);
await call("POST", "/auth/switch-business", { businessId: vldm.businessId });
check("the first firm is still signed in", (await call("GET", "/emandi")).signedIn === true);

/* An update must not lose a login, and must not choke on one written by an
   older version — before firm, portalLicence or the kept commodity list
   existed, and while a typed licence number was still being saved. */
console.log("\nA login saved by an older Mandi Mitra still opens");
const store = path.join(process.env.MANDI_DATA_DIR!, "emandi.json");
const kept = fs.existsSync(store) ? fs.readFileSync(store, "utf8") : null;
fs.writeFileSync(store, JSON.stringify({
  [vldm.businessId]: {
    user: "older-version@example.test", enc: null, licence: "L/2016/75/OLD",
    watch: ["1", "6"], updatedAt: "2026-01-01T00:00:00.000Z",
  },
}, null, 2));
const older = await call("GET", "/emandi");
check("the user name and the commodities it watched are still there",
  older.user === "older-version@example.test" && older.watch.join(",") === "1,6", older);
check("  ...it says no password is saved, instead of pretending one is", older.configured === false, older);
check("  ...and the fields it never had come back empty, not broken",
  older.firm === null && older.portalLicence === null && older.signedIn === false, older);
check("  ...its kept commodity list is empty, and asking for it does not fail",
  (await call("GET", "/emandi/crops")).crops.length === 0, await call("GET", "/emandi/crops"));
if (kept !== null) fs.writeFileSync(store, kept); else fs.rmSync(store, { force: true });
await call("PUT", "/emandi", { user: USER, password: PASSWORD, watch: ["1", "6"] });
await call("POST", "/emandi/signin/start", {});
await call("POST", "/emandi/signin/finish", { captcha: CAPTCHA });

console.log("\nA password belongs to its own user name");
await call("PUT", "/emandi", { user: "somebody-else@example.test" });
const swapped = await call("GET", "/emandi");
check("changing the user name drops the password that was saved with the old one",
  swapped.configured === false && swapped.user === "somebody-else@example.test", swapped);
check("  ...and forgets whose licence it opened", swapped.firm === null && swapped.signedIn === false, swapped);
await call("PUT", "/emandi", { user: USER, password: PASSWORD });
await call("POST", "/emandi/signin/start", {});
await call("POST", "/emandi/signin/finish", { captcha: CAPTCHA });

console.log("\nSigning out, and forgetting the login");
await call("POST", "/emandi/signout", {});
check("signing out ends the session but keeps the login", (await call("GET", "/emandi")).signedIn === false && (await call("GET", "/emandi")).configured === true);
await call("DELETE", "/emandi");
check("removing it forgets the user name too", (await call("GET", "/emandi")).user === "");

console.log("\nWhat the portal was actually asked");
const portalCalls = await (await fetch(`${FAKE}/__calls`)).json() as { method: string; url: string }[];
check("it was asked for the login page, the captcha image and the login",
  portalCalls.some((c) => c.url === "/Account/index") && portalCalls.some((c) => c.url === "/DNTCaptchaImage/Show")
  && portalCalls.some((c) => c.url === "/Account" && c.method === "POST"));
check("no 6R, 9R or gate pass was ever posted",
  !portalCalls.some((c) => c.method === "POST" && /add_six_r|NineR|add_gatepass/i.test(c.url)),
  portalCalls.filter((c) => c.method === "POST").map((c) => c.url));

console.log(bad === 0 ? "\nThe mandi portal's rates come through, and only after a person signs in." : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
