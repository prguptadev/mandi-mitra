import "./_guard.ts";
/* End-to-end: the mandi portal's rate band and stock inside Mandi Mitra,
 * against a stand-in portal (scripts/fake-emandi.ts) — the real e-Mandi site
 * is never called and no real licence is used.
 *
 * What must hold:
 *   · each business keeps its own portal login, and one firm's login, rate or
 *     stock never shows up under the other
 *   · the password is never handed back to a screen
 *   · nothing is read from the portal until a person has typed the captcha
 *   · a wrong captcha and a wrong password each say so, by code and in the
 *     portal's words, and a captcha is good for one try only
 *   · once signed in, the band, mandi fee and cess come through as figures;
 *     a 0.00 band is checked by landing on /Traders/index again before it is
 *     believed
 *   · a session e-Mandi has ended is reported as ended at once; a 502 or a
 *     slow answer does not end it, and nothing waits longer than the limit
 *   · the stock is every commodity held, in whole grams, in and out counting
 *     second arrival, rows for one commodity added up, for the right licence
 *   · a session kept on disk is looked at after a restart before it is trusted
 *   · a read still running when the business is switched never answers for
 *     the firm it started under
 * Run through: npm run test:e2e
 */
import fs from "node:fs";
import path from "node:path";
import { looksLikeSameFirm, sameFirm } from "../src/lib/utils.ts";

const BASE = process.env.MANDI_API!;
const FAKE = process.env.MANDI_EMANDI_BASE!;
const CAPTCHA = "4242";
const USER = "vldm@example.test";
const PASSWORD = "portal-pass-test";
const VCE_USER = "vce@example.test";
const VCE_PASSWORD = "vce-pass-test";
const VLDM_LICENCE = "L/2016/75/17121983";
const VCE_LICENCE = "L/2019/75/22222222";
const G = 100_000; // grams in a quintal

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
const portal = (p: string) => fetch(FAKE + p).then((r) => r.json());
const portalCalls = async () => await portal("/__calls") as { method: string; url: string; headers: Record<string, string> }[];
/** Sign in the way the card does: a captcha, then what the person typed with its ticket. */
const signIn = async () => {
  const ask = await call("POST", "/emandi/signin/start", {});
  if (ask.already) return ask.status;
  return call("POST", "/emandi/signin/finish", { captcha: CAPTCHA, ticket: ask.ticket });
};

const users = await call("GET", "/auth/users");
const owner = users.find((u: any) => u.name === "Test Owner");
await call("POST", "/auth/login", { userId: owner.id, pin: process.env.MANDI_PIN ?? "482915" });
const me = await call("GET", "/auth/me");
const vldm = me.businesses.find((b: any) => b.shortCode === "VLDM");
const other = me.businesses.find((b: any) => b.shortCode !== "VLDM");
if (me.activeBusinessId !== vldm.businessId) await call("POST", "/auth/switch-business", { businessId: vldm.businessId });
await portal("/__reset");

console.log("The mandi portal login, per business");
const fresh = await call("GET", "/emandi");
check("nothing is set up to begin with", fresh.configured === false && fresh.signedIn === false, fresh);
const saved = await call("PUT", "/emandi", { user: USER, password: PASSWORD, watch: ["1", "6"] });
check("the login is saved for this business", saved.configured === true && saved.user === USER, saved);
check("the licence is not asked for — the portal states it", (saved as any).licence === undefined, Object.keys(saved).join(","));
check("the password is never handed back", !JSON.stringify(saved).includes(PASSWORD), Object.keys(saved));
check("it is kept out of the database, in this computer's own folder",
  (await call("GET", "/emandi")).configured === true);
const tooMany = await raw("PUT", "/emandi", { watch: Array.from({ length: 13 }, (_, i) => String(i + 1)) });
check("thirteen commodities are refused, the twelve-a-screen limit", tooMany.status === 400, tooMany.json);

console.log("\nNothing is read from the portal until a person has signed in");
const early = await call("GET", "/emandi/rates");
check("asking for rates while signed out says so, by code and in words",
  early.problem?.code === "signed_out" && early.rates.length === 2 && /sign in/i.test(early.rates[0].error ?? ""), early);
check("  ...and no rate is invented", early.rates.every((r: any) => r.minRatePaise === null));

console.log("\nSigning in: the captcha is the operator's to read");
const askRaw = await raw("POST", "/emandi/signin/start", {});
check("the portal's captcha comes through as an image, with a ticket", askRaw.status === 200
  && /^data:image\//.test(askRaw.json.image ?? "") && Boolean(askRaw.json.ticket),
  { status: askRaw.status, image: String(askRaw.json?.image ?? "").slice(0, 24) });
const wrongCaptcha = await raw("POST", "/emandi/signin/finish", { captcha: "0000", ticket: askRaw.json.ticket });
check("a wrong captcha is called a captcha — not a password, not 'did not say why'",
  wrongCaptcha.status === 400 && wrongCaptcha.json.code === "captcha", wrongCaptcha.json);
check("  ...with the portal's own words, read from its JSON reply", /कैप्चा/.test(wrongCaptcha.json.said ?? ""), wrongCaptcha.json);
const sameAgain = await raw("POST", "/emandi/signin/finish", { captcha: CAPTCHA, ticket: askRaw.json.ticket });
check("a captcha is good for one try: the same one again asks for a new one", sameAgain.json?.code === "no_captcha", sameAgain.json);
/* ASP.NET can refuse under the field's own name, in words that never say
   "captcha" — {errors: {DNTCaptchaInputText: […]}}. It is still the captcha. */
await portal("/__fieldErrors");
const fieldAsk = await call("POST", "/emandi/signin/start", {});
const fieldWrong = await raw("POST", "/emandi/signin/finish", { captcha: "0000", ticket: fieldAsk.ticket });
check("a refusal filed under the captcha field is called a captcha, whatever its words",
  fieldWrong.json?.code === "captcha" && /code shown/.test(fieldWrong.json?.said ?? ""), fieldWrong.json);
const first = await call("POST", "/emandi/signin/start", {});
const second = await call("POST", "/emandi/signin/start", {});
check("each captcha has its own ticket", first.ticket !== second.ticket, [first.ticket, second.ticket]);
const replaced = await raw("POST", "/emandi/signin/finish", { captcha: CAPTCHA, ticket: first.ticket });
check("typing the older of two captchas says it was replaced", replaced.json?.code === "replaced", replaced.json);
const ok = await call("POST", "/emandi/signin/finish", { captcha: CAPTCHA, ticket: second.ticket });
check("the right captcha signs this computer in", ok.signedIn === true, { signedIn: ok.signedIn, at: ok.signedInAt });
check("  ...and says whose licence that login is, in the portal's own words",
  ok.firm === "VIJAY LAXMI DALL MILL" && ok.portalLicence === VLDM_LICENCE, { firm: ok.firm, licence: ok.portalLicence });
check("  ...and the refusal before it is no longer reported", ok.refused === null && ok.noteCode === null, ok);
const again = await call("POST", "/emandi/signin/start", {});
check("pressing Sign in on a live session asks for no captcha and drops nothing",
  again.already === true && again.status.signedIn === true && !again.image, again);

console.log("\nThe rate band, mandi fee and cess");
const rates = await call("GET", "/emandi/rates");
const dhan = rates.rates.find((r: any) => r.cropCode === "1");
/* The portal only gives a band once the page it sends a trader to after login
   has been opened; signing in has to land there, as a browser does. */
check("धान comes through with the band the portal allows",
  dhan.minRatePaise === 340000 && dhan.maxRatePaise === 450000 && rates.problem === null, dhan);
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
check("  ...with what e-Mandi replied, as it came", /"min_rate":"0\.00"/.test(zero.rates[0].said ?? ""), zero.rates[0].said);
const odd = await call("GET", "/emandi/rates?codes=1,99");
check("an answer without a rate in it is not shown as 'no band', and the others carry on",
  odd.rates[1].code === "rate_shape" && odd.rates[1].minRatePaise === null && odd.rates[0].minRatePaise === 340000 && odd.problem === null, odd.rates);

/* §9 of the portal map: a session that has not landed on /Traders/index gets
   0.00 for everything. If e-Mandi drops that state, every band reads 0.00 —
   which must be checked by landing again, not reported as the mandi's word. */
await portal(`/__unland?user=${USER}`);
const relanded = await call("GET", "/emandi/rates");
check("when every band comes back 0.00, the app lands on /Traders/index again and asks once more",
  relanded.rates.find((r: any) => r.cropCode === "1")?.minRatePaise === 340000, relanded.rates);
await portal(`/__unland?user=${USER}`);
const relandedAgain = await call("GET", "/emandi/rates");
check("  ...and when it happens again soon after, it is landed again, not taken as 'no band today'",
  relandedAgain.rates.find((r: any) => r.cropCode === "1")?.minRatePaise === 340000, relandedAgain.rates);

console.log("\nThe portal having a bad minute does not cost a captcha");
await portal("/__fail?path=/Traders/index&status=502&times=1");
const hiccup = await raw("POST", "/emandi/check", {});
check("a 502 on the session check is reported as e-Mandi's trouble", hiccup.status === 400 && hiccup.json.code === "portal_error", hiccup.json);
const after502 = await call("GET", "/emandi");
check("  ...and the session is still there", after502.signedIn === true, after502);
const recheck = await call("POST", "/emandi/check", {});
check("  ...the next look works, and the note goes", recheck.signedIn === true && recheck.noteCode === null, recheck);
await portal("/__fail?path=/Traders/get_crop_fees&status=503&times=1");
const r503 = await call("GET", "/emandi/rates");
check("a 503 on a rate stops the list, says so once, and keeps the session",
  r503.problem?.code === "portal_error" && r503.rates.every((r: any) => r.minRatePaise === null) && r503.status.signedIn === true, r503);
check("  ...and a row with no figure still says which commodity it is", r503.rates.every((r: any) => Boolean(r.cropName)), r503.rates);
await portal("/__fail?path=/Traders/get_crop_fees&status=302&to=/Home/Error&times=1");
const r302 = await call("GET", "/emandi/rates?codes=1");
check("a redirect somewhere other than the login page is e-Mandi's trouble, not a sign-out",
  r302.problem?.code === "portal_error" && r302.status.signedIn === true, r302);

await portal("/__slow?path=/Traders/get_crop_fees&ms=17000&times=1");
const before = (await portalCalls()).filter((c) => c.url === "/Traders/get_crop_fees").length;
const t0 = Date.now();
const slow = await call("GET", "/emandi/rates");
const took = Date.now() - t0;
const asks = (await portalCalls()).filter((c) => c.url === "/Traders/get_crop_fees").length - before;
check("a portal that does not answer is given up on within the limit, not left to hang", took < 20_000 && slow.problem?.code === "slow", { took, problem: slow.problem });
check("  ...the list stops at the first commodity instead of waiting on each in turn", asks === 1 && slow.rates.length === 2
  && slow.rates.every((r: any) => r.code === "slow" && r.minRatePaise === null), { asks, rows: slow.rates });
check("  ...and the session is not thrown away for it", slow.status.signedIn === true, slow.status);

console.log("\nThe picture behind a captcha address");
const shot = await call("POST", "/emandi/captcha", { text: '<img id="dntCaptchaImg" src="/DNTCaptchaImage/Show?data=abc123" />' });
check("the app fetches it with its own session and hands back the bytes",
  shot.image.startsWith("data:image/") && shot.image.includes(";base64,") && shot.image.length > 80, shot.image?.slice(0, 40));
check("  ...and says which address it came from", shot.url.endsWith("/DNTCaptchaImage/Show?data=abc123"), shot.url);
const notCaptcha = await raw("POST", "/emandi/captcha", { text: "/Traders/Dashboard" });
check("  ...and will not fetch anything that is not the captcha image",
  notCaptcha.status === 400 && notCaptcha.json?.code === "not_captcha" && /captcha address/i.test(notCaptcha.json?.error ?? ""), notCaptcha.json);

console.log("\nWhat e-Mandi holds as this firm's stock");
const st = await call("GET", "/emandi/stock");
const line = (code: string) => st.lines.find((l: any) => l.cropCode === code);
check("every commodity on the licence is read — the one not watched (बाजरा) too", st.lines.length === 3 && Boolean(line("3")), st.lines);
check("  ...with the licence it was read for", st.licence === VLDM_LICENCE, st.licence);
check("  ...in, out and what is left come through as whole grams, exactly",
  line("1").inGrams === 3965 * G && line("1").outGrams === 38918 * G / 10 && line("1").leftGrams === 732 * G / 10, line("1"));
check("  ...in and out count second arrival as well as first, so they add up to what is left",
  line("6").inGrams === 600 * G && line("6").outGrams === 600 * G && line("6").inGrams - line("6").outGrams === line("6").leftGrams, line("6"));
check("  ...a commodity all sold out reads zero, not blank", line("6").leftGrams === 0, line("6"));
check("  ...three decimals of a quintal are kept, not cut to two", line("3").leftGrams === 5_000_500, line("3"));
check("  ...the name loses the mark the portal writes into it", line("1").crop === "धान (TEST)", line("1").crop);
/* The register only answers a fully bound DataTables payload — a half one gets
   draw 0 and an empty list, which is how a month of stock once read as none. */
const windows = (await portalCalls()).filter((c) => c.method === "DATES");
check("  ...over a month counted back from today, in the portal's own dd/mm/yyyy", windows.length >= 1, windows.at(-1));
if (windows.length) {
  const [f, t2] = windows.at(-1)!.url.split("..");
  const d = (x: string) => { const [dd, mm, yy] = x.split("/").map(Number); return new Date(yy, mm - 1, dd).getTime(); };
  check("  ...which is thirty days wide", Math.round((d(t2) - d(f)) / 86400000) === 30, `${f} → ${t2}`);
}

console.log("\nThe portal's commodity list");
const crops = await call("GET", "/emandi/crops");
check("the list is read from the portal's own 6R form", crops.crops.length === 4, crops.crops.length);
check("  ...with the Hindi names turned back into letters, not HTML escapes",
  crops.crops.some((c: any) => c.name === "धान") && !crops.crops.some((c: any) => /&#/.test(c.name)),
  crops.crops.map((c: any) => c.name).join(" "));
check("  ...and is kept, so it is there without asking the portal again", Boolean(crops.at), crops.at);
const reread = await call("POST", "/emandi/crops/refresh", {});
check("the list can be read from the portal again on request", reread.crops.length === 4, reread.crops.length);

console.log("\nTicking a commodity does not sign anyone out");
await call("PUT", "/emandi", { watch: ["1", "6", "2"] });
await call("PUT", "/emandi", { watch: ["1", "6"] });
check("the session survives a change of commodities", (await call("GET", "/emandi")).signedIn === true);

console.log("\nA read still on its way when the business is switched");
const ownStatus = await call("GET", `/emandi?biz=${vldm.businessId}`);
check("every status says which business it is for", ownStatus.businessId === vldm.businessId, ownStatus.businessId);
const askedOther = await raw("GET", `/emandi?biz=${other.businessId}`);
check("a request naming a business other than the one open is refused, and says nothing of this one",
  askedOther.status === 409 && askedOther.json?.code === "business_changed" && !JSON.stringify(askedOther.json).includes("VIJAY"), askedOther.json);
await portal("/__slow?path=/Traders/get_crop_fees&ms=1500&times=1");
const onItsWay = raw("GET", `/emandi/rates?biz=${vldm.businessId}`);
await new Promise((r) => setTimeout(r, 300));
await call("POST", "/auth/switch-business", { businessId: other.businessId });
const late = await onItsWay;
check("a slow read for one firm that ends after the switch answers 'business_changed', not that firm's login",
  late.status === 409 && late.json?.code === "business_changed" && !JSON.stringify(late.json).includes("VIJAY"), late.json);
await call("POST", "/auth/switch-business", { businessId: vldm.businessId });

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
const otherStock = await raw("GET", "/emandi/stock");
check("  ...and is told nothing of the other firm's stock",
  otherStock.status === 400 && otherStock.json?.code === "signed_out" && !JSON.stringify(otherStock.json).includes("धान"), otherStock.json);
check("  ...nor whose licence the other firm's login is",
  (await call("GET", "/emandi")).firm === null, (await call("GET", "/emandi")).firm);

await call("PUT", "/emandi", { user: VCE_USER, password: "not-the-password", watch: ["1"] });
const vceAsk = await call("POST", "/emandi/signin/start", {});
const wrongPass = await raw("POST", "/emandi/signin/finish", { captcha: CAPTCHA, ticket: vceAsk.ticket });
check("a wrong password is called a wrong user name or password, not a captcha",
  wrongPass.status === 400 && wrongPass.json.code === "credentials", wrongPass.json);
await call("PUT", "/emandi", { password: VCE_PASSWORD });
const vce = await signIn();
check("the second firm signs in with its own login, to its own licence",
  vce.signedIn === true && vce.firm === "V C ENTERPRISES" && vce.portalLicence === VCE_LICENCE, vce);
const vceStock = await call("GET", "/emandi/stock");
check("  ...and reads its own stock, for its own licence", vceStock.licence === VCE_LICENCE && vceStock.lines.length === 1, vceStock);
check("  ...two rows for one commodity on e-Mandi are added up, not one dropped",
  vceStock.lines[0].leftGrams === 155 * G / 10 && vceStock.lines[0].rows === 2, vceStock.lines[0]);

/* The licence on the firm is exact. With this firm's licence on record, a
   login that opens a different licence reads nothing at all. */
await call("PUT", "/business/current", { mandiLicense: VLDM_LICENCE });
const clashRates = await call("GET", "/emandi/rates");
check("a login whose licence is not this firm's reads no rate",
  clashRates.problem?.code === "other_licence" && clashRates.rates.every((r: any) => r.minRatePaise === null), clashRates);
const clashStock = await raw("GET", "/emandi/stock");
check("  ...and no stock", clashStock.status === 400 && clashStock.json?.code === "other_licence" && !clashStock.json.lines, clashStock.json);
await call("PUT", "/business/current", { mandiLicense: VCE_LICENCE.toLowerCase() });
check("  ...and the same licence, however it is written, reads as before",
  (await call("GET", "/emandi/stock")).licence === VCE_LICENCE);
await call("PUT", "/business/current", { mandiLicense: "2019-75-022222222." });
const otherPunct = await call("GET", "/emandi/rates");
check("  ...dashes, a dot, a leading zero or no 'L' in front included",
  otherPunct.problem === null && otherPunct.rates[0]?.minRatePaise === 340000
  && (await call("GET", "/emandi/stock")).licence === VCE_LICENCE, otherPunct);
await call("PUT", "/business/current", { mandiLicense: "" });

await call("POST", "/auth/switch-business", { businessId: vldm.businessId });
check("the first firm is still signed in", (await call("GET", "/emandi")).signedIn === true);
check("  ...and its stock is still its own", (await call("GET", "/emandi/stock")).licence === VLDM_LICENCE);

console.log("\nWhen e-Mandi ends a session, the screen hears it at once");
await portal(`/__expire?user=${USER}`);
const afterEnd = await call("GET", "/emandi/rates");
check("the rates say the session ended, once, with no figure", afterEnd.problem?.code === "ended"
  && afterEnd.rates.every((r: any) => r.minRatePaise === null), afterEnd.problem);
check("  ...and the status in the same reply says signed out, so the card shows Sign in",
  afterEnd.status.signedIn === false && afterEnd.status.noteCode === "ended", afterEnd.status);
check("  ...and so does the status on its own", (await call("GET", "/emandi")).signedIn === false);
const endedStock = await raw("GET", "/emandi/stock");
check("  ...and the stock is not read either", endedStock.status === 400 && endedStock.json?.code === "ended", endedStock.json);
// the portal cleared its cookie for the ended session: like a browser, it is not sent back
await call("POST", "/emandi/signin/start", {});
const loginPageAsk = (await portalCalls()).filter((c) => c.url === "/Account/index").at(-1);
check("  ...and the cookie e-Mandi cleared is not sent back on the next sign-in",
  !/(?:^|;\s*)emandi=/.test(loginPageAsk?.headers.cookie ?? ""), loginPageAsk?.headers.cookie);
await call("POST", "/auth/switch-business", { businessId: other.businessId });
check("the other firm's session is untouched by it", (await call("GET", "/emandi")).signedIn === true);

/* A restart: a second copy of the app on the same folder reads the kept
   session from disk. It must not be trusted until a look at the portal has
   shown it still works — landing on /Traders/index, so the band is not 0.00. */
console.log("\nA session kept on disk, after a restart");
await portal(`/__unland?user=${VCE_USER}`);
const restarted = await import("../server/lib/emandi.ts");
const kept = restarted.statusOf(other.businessId);
check("straight after a restart the kept session is there, but not yet checked", kept.signedIn === true && kept.checkedAt === null, kept);
await restarted.check(other.businessId);
check("  ...one look at the portal checks it", Boolean(restarted.statusOf(other.businessId).checkedAt));
const keptRates = await restarted.ratesFor(other.businessId, ["1"]);
check("  ...and it gives the band, because the look landed on /Traders/index", keptRates.rows[0].minRatePaise === 340000, keptRates.rows[0]);
/* A laptop lid shut for a while stops the keep-alive. A session not seen
   working for longer than the keep-alive round is landed again before the
   first rate is asked for — not only after a 0.00 has come back. */
const realNow = Date.now;
Date.now = () => realNow() + 11 * 60_000;
try {
  const mark = (await portalCalls()).length;
  await restarted.ratesFor(other.businessId, ["1"]);
  const next = (await portalCalls()).slice(mark).map((c) => c.url);
  check("a session left idle is landed on /Traders/index before the rate is asked for",
    next[0] === "/Traders/index" && next.indexOf("/Traders/index") < next.indexOf("/Traders/get_crop_fees"), next);
} finally { Date.now = realNow; }
check("a session already ended is not brought back by a restart", restarted.statusOf(vldm.businessId).signedIn === false);

console.log("\nA login file cut short is not taken for 'no logins'");
await call("POST", "/auth/switch-business", { businessId: vldm.businessId });
await call("PUT", "/emandi", { user: USER, password: PASSWORD, watch: ["1", "6"] });
const store = path.join(process.env.MANDI_DATA_DIR!, "emandi.json");
const whole = fs.readFileSync(store, "utf8");
fs.writeFileSync(store, whole.slice(0, Math.floor(whole.length / 2)));
const cut = await call("GET", "/emandi");
check("half a file: the copy from the write before is used, and the login is still there",
  cut.configured === true && cut.user === USER && cut.storeNote === "store_restored", cut);
check("  ...and the damaged file is kept aside, not written over",
  fs.readdirSync(process.env.MANDI_DATA_DIR!).some((f) => f.startsWith("emandi.json.bad-")));
await call("PUT", "/emandi", { watch: ["1", "6"] });
check("  ...saving the login again clears the note", (await call("GET", "/emandi")).storeNote === null);
fs.rmSync(`${store}.prev`, { force: true });
fs.writeFileSync(store, "{ cut");
check("a damaged file with no copy says the logins were lost", (await call("GET", "/emandi")).storeNote === "store_lost");
await call("PUT", "/emandi", { user: USER, password: PASSWORD, watch: ["1", "6"] });
await call("POST", "/auth/switch-business", { businessId: other.businessId });
check("  ...and one firm putting its login back does not hide it from the other",
  (await call("GET", "/emandi")).storeNote === "store_lost", (await call("GET", "/emandi")).storeNote);
await call("POST", "/auth/switch-business", { businessId: vldm.businessId });

/* An update must not lose a login, and must not choke on one written by an
   older version — before firm, portalLicence or the kept commodity list
   existed, and while a typed licence number was still being saved. */
console.log("\nA login saved by an older Mandi Mitra still opens");
const keptFile = fs.existsSync(store) ? fs.readFileSync(store, "utf8") : null;
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

/* A data folder copied to another computer without its hidden key: the
   password is there but cannot be read. It is not "saved". */
const unreadable = JSON.parse(keptFile ?? "{}");
unreadable[vldm.businessId] = { ...unreadable[vldm.businessId], enc: "v1:AAAA:BBBB:CCCC" };
fs.writeFileSync(store, JSON.stringify(unreadable, null, 2));
const noKey = await call("GET", "/emandi");
check("a password this computer cannot read is not called saved", noKey.configured === false && noKey.passwordUnreadable === true, noKey);
const noKeyAsk = await raw("POST", "/emandi/signin/start", {});
check("  ...and no captcha is fetched for a sign-in that cannot work", noKeyAsk.json?.code === "password_unreadable", noKeyAsk.json);
if (keptFile !== null) fs.writeFileSync(store, keptFile); else fs.rmSync(store, { force: true });
await call("PUT", "/emandi", { user: USER, password: PASSWORD, watch: ["1", "6"] });
await signIn();

console.log("\nA password belongs to its own user name");
await call("PUT", "/emandi", { user: "somebody-else@example.test" });
const swapped = await call("GET", "/emandi");
check("changing the user name drops the password that was saved with the old one",
  swapped.configured === false && swapped.user === "somebody-else@example.test", swapped);
check("  ...and forgets whose licence it opened", swapped.firm === null && swapped.signedIn === false, swapped);
await call("PUT", "/emandi", { user: USER, password: PASSWORD });
await portal("/__plainDashboard");
const plain = await signIn();
const learnt = await call("GET", "/emandi/rates");
check("a licence the dashboard did not show is read from the stock page with the first rates, so it can be checked",
  plain.portalLicence === null && learnt.status.portalLicence === VLDM_LICENCE && learnt.problem === null, { before: plain.portalLicence, after: learnt.status.portalLicence });
await portal("/__reset");

console.log("\nSigning out, and forgetting the login");
await call("POST", "/emandi/signout", {});
check("signing out ends the session but keeps the login", (await call("GET", "/emandi")).signedIn === false && (await call("GET", "/emandi")).configured === true);
await call("DELETE", "/emandi");
check("removing it forgets the user name too", (await call("GET", "/emandi")).user === "");
const trail = await call("GET", "/audit?action=emandi&limit=200");
const actions = new Set(trail.rows.map((r: any) => r.action));
check("the trail tells a new password from a ticked commodity, and records sign-out",
  ["emandi.account", "emandi.password", "emandi.watch", "emandi.signin", "emandi.signout", "emandi.forget"].every((a) => actions.has(a)), [...actions]);
check("  ...and never holds the password", !JSON.stringify(trail).includes(PASSWORD));
await call("POST", "/auth/switch-business", { businessId: other.businessId });
await call("DELETE", "/emandi");
await call("POST", "/auth/switch-business", { businessId: vldm.businessId });

console.log("\nWhat the portal was actually asked");
const asked2 = await portalCalls();
check("it was asked for the login page, the captcha image and the login",
  asked2.some((c) => c.url === "/Account/index") && asked2.some((c) => c.url === "/DNTCaptchaImage/Show")
  && asked2.some((c) => c.url === "/Account" && c.method === "POST"));
check("no 6R, 9R or gate pass was ever posted — only the login and read-only lookups",
  asked2.filter((c) => c.method === "POST").every((c) => ["/Account", "/Traders/get_crop_fees", "/Stock/GetDayBookList"].includes(c.url)),
  [...new Set(asked2.filter((c) => c.method === "POST").map((c) => c.url))]);
/* The way a browser asks (docs §9): the picture as an image from the login
   page; the login as the page's own XHR, without a navigation's headers; and
   the landing that follows it coming from the login page, not the picture. */
const img = asked2.filter((c) => c.url === "/DNTCaptchaImage/Show").at(-1)!;
check("the captcha is fetched as an image, from the login page",
  img.headers["sec-fetch-dest"] === "image" && /\/Account\/index$/.test(img.headers.referer ?? ""), img.headers);
const login = asked2.filter((c) => c.url === "/Account" && c.method === "POST").at(-1)!;
check("the login is sent as the page's own XHR, with no navigation-only headers",
  login.headers["x-requested-with"] === "XMLHttpRequest" && !login.headers["upgrade-insecure-requests"] && !login.headers["sec-fetch-user"], login.headers);
const landing = asked2.slice(asked2.indexOf(login)).find((c) => c.url === "/Traders/index");
check("  ...and the landing after it comes from the login page, not from the captcha picture",
  /\/Account\/index$/.test(landing?.headers.referer ?? ""), landing?.headers.referer);
check("the browser it says it is agrees with itself (Windows in both places)",
  /Windows/.test(login.headers["user-agent"] ?? "") && login.headers["sec-ch-ua-platform"] === '"Windows"', login.headers["user-agent"]);

console.log("\nWhose login is it — by licence, else by name");
const pairs: [string, string, string][] = [
  ["V C ENTERPRISES", "V C Enterprise", "same"], ["VIJAY LAXMI DALL MILL", "Vijay Laxmi Dal Mill", "same"],
  ["V C ENTERPRISES", "VCE", "same"], ["V C ENTERPRISES", "VC Ent.", "same"], ["VIJAY LAXMI DALL MILL", "VLDM", "same"],
  ["VIJAY LAXMI DALL MILL", "विजय लक्ष्मी दाल मिल", "same"], ["V C ENTERPRISES", "वी सी इंटरप्राइजेज", "same"],
  ["R K ENTERPRISES", "V C Enterprise", "different"], ["GUPTA DAL MILL", "Vijay Laxmi Dal Mill", "different"],
  ["V C ENTERPRISES", "विजय लक्ष्मी दाल मिल", "different"], ["SHIVAM TRADING COMPANY", "Shyam Trading Company", "different"],
  ["VIJAY LAXMI DALL MILL", "V C Enterprise", "different"], ["GUPTA DAL MILL", "Gupta", "same"],
  ["VIJAY LAXMI DALL MILL", "Vijay Traders", "unknown"], ["TRADING COMPANY", "Vijay Laxmi Dal Mill", "unknown"],
  // written together or apart is one name; initials that leave out a different trade are asked about
  ["VIJAYLAXMI DAL MILL", "Vijay Laxmi Dal Mill", "same"], ["VIJAY LAXMI DALL MILL", "विजयलक्ष्मी दाल मिल", "same"],
  ["VIJAY LAXMI DALL MILL", "वी सी इंटरप्राइजेज", "different"], ["VK TRADERS", "Vijay Kumar Dal Mill", "unknown"],
];
const wrongPairs = pairs.filter(([a, b, want]) => looksLikeSameFirm(a, b) !== want).map(([a, b, want]) => `${a} | ${b}: ${looksLikeSameFirm(a, b)} (want ${want})`);
check("initials, Hindi names and spelling are the same firm; a shared 'Enterprises' or 'Dal Mill' is not", wrongPairs.length === 0, wrongPairs);
check("the licence decides when both sides have one, however it is written",
  sameFirm({ firm: "VIJAY LAXMI DALL MILL", licence: VLDM_LICENCE }, { name: "V C Enterprise", licence: VLDM_LICENCE.toLowerCase() }).match === "same"
  && sameFirm({ firm: "VIJAY LAXMI DALL MILL", licence: VLDM_LICENCE }, { name: "Vijay Laxmi Dal Mill", licence: VCE_LICENCE }).match === "different");

await portal("/__reset");
console.log(bad === 0 ? "\nThe mandi portal's rates and stock come through, and only after a person signs in." : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
