/* A stand-in for the UP e-Mandi portal, for the end-to-end tests only. The
 * test servers are pointed at it with MANDI_EMANDI_BASE, so the real mandi
 * site is never touched and no real licence is ever used.
 *
 * It behaves the way the real portal does in the ways that matter:
 *   GET  /Account/index            login form with an antiforgery token and a
 *                                  DNTCaptcha (a fresh token + hidden answer +
 *                                  image each time)
 *   GET  /DNTCaptchaImage/Show     a tiny PNG
 *   POST /Account                  answers JSON, as the portal's own login
 *                                  script expects: {succeeded:true, role} and a
 *                                  session cookie, or {succeeded:false,
 *                                  message} in the portal's words
 *   GET  /Traders/index            302 to the dashboard — and only once this has
 *                                  been opened does the session give a band
 *   POST /Traders/get_crop_fees    the permitted band + fee + cess, as JSON —
 *                                  but the login page when signed out
 *   GET  /Traders/add_six_r        the 6R form, for its commodity list
 *   GET  /Stock/DayBook, POST /Stock/GetDayBookList   the stock register
 *
 * Two logins, two licences: VIJAY LAXMI DALL MILL and V C ENTERPRISES, each
 * with its own stock, so a test can tell one firm's figures from the other's.
 *
 * And the ways it can go wrong, switched on by a test:
 *   /__expire?user=      the portal ends that user's sessions (all, without user)
 *   /__unland?user=      the portal forgets the landing, keeps the cookie (§9)
 *   /__fail?path=&status=&times=   the next N calls to a path answer that status
 *   /__slow?path=&ms=&times=       the next N calls to a path wait that long
 *   /__reset             all of the above off
 *   /__calls             every request, with its headers, so tests can count them
 */
import http from "node:http";

const PORT = Number(process.argv[2] ?? 8795);
/** What a test must type: the real portal shows this in the image. */
export const CAPTCHA = "4242";

interface Login {
  password: string; firm: string; licence: string; owner: string;
  stock: { name: string; code: string; ins: string; insSecond: string; outs: string; outsSecond: string; left: string }[];
}
const LOGINS: Record<string, Login> = {
  "vldm@example.test": {
    password: "portal-pass-test", firm: "VIJAY LAXMI DALL MILL", licence: "L/2016/75/17121983", owner: "VIRESH CHANDRA GUPTA",
    stock: [
      { name: "धान", code: "1", ins: "3965.000", insSecond: "0.000", outs: "3891.800", outsSecond: "0.000", left: "73.200" },
      // second arrival too: in and out must count it, the way "left" already does
      { name: "गेहूँ", code: "6", ins: "480.000", insSecond: "120.000", outs: "480.000", outsSecond: "120.000", left: "0.000" },
      // held, but not on the watch list — it must still be shown, to three decimals
      { name: "बाजरा", code: "3", ins: "50.005", insSecond: "0.000", outs: "0.000", outsSecond: "0.000", left: "50.005" },
    ],
  },
  "vce@example.test": {
    password: "vce-pass-test", firm: "V C ENTERPRISES", licence: "L/2019/75/22222222", owner: "VINOD CHANDRA",
    stock: [
      // the register can give one commodity on two rows; they are one commodity's stock
      { name: "धान", code: "1", ins: "10.000", insSecond: "0.000", outs: "0.000", outsSecond: "0.000", left: "10.000" },
      { name: "धान", code: "1", ins: "5.500", insSecond: "0.000", outs: "0.000", outsSecond: "0.000", left: "5.500" },
    ],
  },
};

const BANDS: Record<string, { name: string; min: number; max: number }> = {
  "1": { name: "धान", min: 3400, max: 4500 },
  "6": { name: "गेहूँ", min: 2200, max: 2800 },
  // the real portal answers 0.00 when the mandi has set no band for a commodity
  "2": { name: "चावल", min: 0, max: 0 },
  "3": { name: "बाजरा", min: 2100, max: 2500 },
};

/** The real portal writes every Hindi word as HTML escapes; so does this one. */
const esc = (text: string) => [...text].map((ch) => (ch.codePointAt(0)! > 126 ? `&#x${ch.codePointAt(0)!.toString(16)};` : ch)).join("");

const calls: { method: string; url: string; body: string; headers: Record<string, string> }[] = [];

/* The real portal sends a merchant to /Traders/index after login, and does not
   give a rate band until that page has been opened — going straight to the
   dashboard leaves the session half set up. This stand-in does the same, per
   session. */
const sessions = new Map<string, { user: string; landed: boolean; alive: boolean }>();
let nextSession = 1;
let nextCaptcha = 1;
const faults: { path: string; status?: number; ms?: number; times: number }[] = [];

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX///+/v7+jQ3Y5AAAADklEQVQI12P4AIX8EAgALgAD/aNpbtEAAAAASUVORK5CYII=",
  "base64",
);

const loginPage = () => {
  const n = nextCaptcha++;
  return `<!DOCTYPE html><html><body>
<form action="/Account" method="post" data-ajax="true" data-ajax-success="onSuccess">
  <input name="Email" /><input name="Password" type="password" />
  <img src="/DNTCaptchaImage/Show?data=stand-in-${n}" />
  <input name="DNTCaptchaText" type="hidden" value="${CAPTCHA}" />
  <input name="DNTCaptchaInputText" />
  <input name="DNTCaptchaToken" type="hidden" value="tok-${PORT}-${n}" />
  <input name="__RequestVerificationToken" type="hidden" value="verify-${PORT}" />
</form></body></html>`;
};

const sixRPage = () => `<!DOCTYPE html><html><body><form action="/Traders/add_six_r" method="post">
<select id="crop_code" name="crop_code"><option value="">---${esc("उत्पाद चुने")}---</option>
${Object.entries(BANDS).map(([code, b]) => `<option value="${code}">${esc(b.name)}</option>`).join("")}
</select>
<input name="DNTCaptchaInputText" />
</form></body></html>`;

const sessionFrom = (cookie: string | undefined) => {
  const id = /(?:^|;\s*)emandi=([^;]+)/.exec(cookie ?? "")?.[1];
  const s = id ? sessions.get(id) : undefined;
  return s?.alive ? s : null;
};

http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  let body = "";
  req.on("data", (d) => { body += d; });
  req.on("end", async () => {
    const send = (code: number, type: string, payload: string | Buffer, headers: Record<string, string> = {}) => {
      res.writeHead(code, { "Content-Type": type, ...headers });
      res.end(payload);
    };
    const q = (k: string) => url.searchParams.get(k) ?? "";

    // the test's own switches; not recorded as portal calls
    if (url.pathname === "/__calls") return send(200, "application/json", JSON.stringify(calls));
    if (url.pathname === "/__reset") { faults.length = 0; return send(200, "application/json", "{}"); }
    if (url.pathname === "/__expire" || url.pathname === "/__unland") {
      for (const s of sessions.values()) {
        if (q("user") && s.user !== q("user")) continue;
        if (url.pathname === "/__expire") s.alive = false; else s.landed = false;
      }
      return send(200, "application/json", "{}");
    }
    if (url.pathname === "/__fail" || url.pathname === "/__slow") {
      faults.push({ path: q("path"), status: Number(q("status")) || undefined, ms: Number(q("ms")) || undefined, times: Number(q("times")) || 1 });
      return send(200, "application/json", "{}");
    }

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k.toLowerCase()] = v;
    calls.push({ method: req.method ?? "GET", url: url.pathname, body: body.slice(0, 200), headers });

    const fault = faults.find((f) => f.path === url.pathname && f.times > 0);
    if (fault) {
      fault.times--;
      if (fault.ms) await new Promise((r) => setTimeout(r, fault.ms));
      if (fault.status) return send(fault.status, "text/html", `<html><body>${fault.status} Bad Gateway</body></html>`);
    }

    if (url.pathname === "/DNTCaptchaImage/Show") return send(200, "image/png", PNG);
    if (url.pathname === "/Account/index") return send(200, "text/html", loginPage());

    if (url.pathname === "/Account" && req.method === "POST") {
      const p = new URLSearchParams(body);
      if (p.get("DNTCaptchaInputText") !== CAPTCHA) {
        return send(200, "application/json", JSON.stringify({ succeeded: false, message: "कृपया सही कैप्चा कोड दर्ज करें" }));
      }
      const login = LOGINS[p.get("Email") ?? ""];
      if (!login || login.password !== p.get("Password")) {
        return send(200, "application/json", JSON.stringify({ succeeded: false, message: "Invalid login attempt. यूज़र नाम या पासवर्ड गलत है" }));
      }
      const id = `sess-${nextSession++}`;
      sessions.set(id, { user: p.get("Email")!, landed: false, alive: true });
      return send(200, "application/json", JSON.stringify({ succeeded: true, role: "merchant" }),
        { "set-cookie": `emandi=${id}; Path=/; HttpOnly` });
    }

    // everything below needs the session, exactly as the portal does it
    const s = sessionFrom(req.headers.cookie);
    if (!s) {
      // a page is sent to the login page; an ajax call gets the login page as HTML
      if (url.pathname === "/Traders/index" || url.pathname === "/Traders/Dashboard") {
        res.writeHead(302, { location: "/Account/index" });
        return res.end();
      }
      return send(200, "text/html", loginPage());
    }
    const login = LOGINS[s.user];

    /* The stock register is a DataTable: it answers only when the whole
       DataTables payload is there, the way the real one does — and only for
       the licence this login holds. */
    if (url.pathname === "/Stock/DayBook") {
      return send(200, "text/html", `<html><body><input type="hidden" id="license_number" value="${login.licence}" />
        <input type="text" class="form-control datepicker" id="from_date"><input type="text" class="form-control datepicker" id="to_date"></body></html>`);
    }
    if (url.pathname === "/Stock/GetDayBookList" && req.method === "POST") {
      const p = new URLSearchParams(body);
      const bound = p.get("columns[0][data]") === "crop_name_hi" && p.get("draw") === "1";
      if (!bound || p.get("LicenseNumber") !== login.licence) {
        return send(200, "application/json", '{"draw":0,"recordsTotal":0,"recordsFiltered":0,"data":[]}');
      }
      const dmy = /^\d{2}\/\d{2}\/\d{4}$/;
      if (!dmy.test(p.get("Fdate") ?? "") || !dmy.test(p.get("Tdate") ?? "")) {
        return send(200, "application/json", '{"draw":1,"recordsTotal":0,"recordsFiltered":0,"data":[]}');
      }
      calls.push({ method: "DATES", url: `${p.get("Fdate")}..${p.get("Tdate")}`, body: "", headers: {} });
      const data = login.stock.map((l) => ({
        crop_name_hi: `${l.name} (﻿TEST)`, crop_code: l.code,
        ins_primary: l.ins, ins_secondary: l.insSecond, outs_primary: l.outs, outs_secondary: l.outsSecond,
        availableStock_primary: l.left, availableStock_secondary: "0.000", availableStock: l.left,
      }));
      return send(200, "application/json", JSON.stringify({ draw: 1, recordsTotal: data.length, recordsFiltered: data.length, data }));
    }

    if (url.pathname === "/Traders/index") {
      s.landed = true;
      res.writeHead(302, { location: "/Traders/Dashboard" });
      return res.end();
    }

    if (url.pathname === "/Traders/get_crop_fees" && req.method === "POST") {
      const code = new URLSearchParams(body).get("crop_code") ?? "";
      const b = BANDS[code];
      if (!b) return send(200, "application/json", "[]");
      return send(200, "application/json", JSON.stringify([{
        min_rate: (s.landed ? b.min : 0).toFixed(2), max_rate: (s.landed ? b.max : 0).toFixed(2),
        mandi_fees: "1.00", development_cess: "0.50", isupmandisthal: 0, isDirectlicense: 0,
      }]));
    }
    if (url.pathname === "/Traders/add_six_r") return send(200, "text/html", sixRPage());
    if (url.pathname === "/Traders/Dashboard") return send(200, "text/html",
      `<html><body><input type="hidden" value="${login.owner}" id="username" />
       <input type="hidden" value="${login.licence}" id="MerchantLicense" />
       <h2>Welcome,</h2>\r\n <h3 class="prev_data">\r\n\r\n${login.firm}    </h3></body></html>`);
    return send(404, "text/html", "not here");
  });
}).listen(PORT, "127.0.0.1", () => console.log(`fake e-Mandi on http://127.0.0.1:${PORT}`));
