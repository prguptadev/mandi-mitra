/* A stand-in for the UP e-Mandi portal, for the end-to-end tests only. The
 * test servers are pointed at it with MANDI_EMANDI_BASE, so the real mandi
 * site is never touched and no real licence is ever used.
 *
 * It behaves the way the real portal does in the ways that matter:
 *   GET  /Account/index            login form with an antiforgery token and a
 *                                  DNTCaptcha (token + hidden answer + image)
 *   GET  /DNTCaptchaImage/Show     a tiny PNG
 *   POST /Account                  wrong captcha or password → the form again
 *                                  with the portal's own words; right → 302 to
 *                                  /Traders/Dashboard and a session cookie
 *   POST /Traders/get_crop_fees    the permitted band + fee + cess, as JSON —
 *                                  but the login page when signed out
 *   GET  /Traders/add_six_r        the 6R form, for its commodity list
 * GET /__calls lists every request, so tests can count them.
 */
import http from "node:http";

const PORT = Number(process.argv[2] ?? 8795);
/** What a test must type: the real portal shows this in the image. */
export const CAPTCHA = "4242";
const USER = "vldm@example.test";
const PASSWORD = "portal-pass-test";
const SESSION = "emandi-session-abc";

const BANDS: Record<string, { name: string; min: number; max: number }> = {
  "1": { name: "धान", min: 3400, max: 4500 },
  "6": { name: "गेहूँ", min: 2200, max: 2800 },
  // the real portal answers 0.00 when the mandi has set no band for a commodity
  "2": { name: "चावल", min: 0, max: 0 },
};

/** The real portal writes every Hindi word as HTML escapes; so does this one. */
const esc = (text: string) => [...text].map((ch) => (ch.codePointAt(0)! > 126 ? `&#x${ch.codePointAt(0)!.toString(16)};` : ch)).join("");

const calls: { method: string; url: string; body: string }[] = [];

/* The real portal sends a merchant to /Traders/index after login, and does not
   give a rate band until that page has been opened — going straight to the
   dashboard leaves the session half set up. This stand-in does the same. */
let landed = false;

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX///+/v7+jQ3Y5AAAADklEQVQI12P4AIX8EAgALgAD/aNpbtEAAAAASUVORK5CYII=",
  "base64",
);

const loginPage = (error?: string) => `<!DOCTYPE html><html><body>
<form action="/Account" method="post">
  <input name="Email" /><input name="Password" type="password" />
  <img src="/DNTCaptchaImage/Show?data=stand-in-${Date.now()}" />
  <input name="DNTCaptchaText" type="hidden" value="${CAPTCHA}" />
  <input name="DNTCaptchaInputText" />
  <input name="DNTCaptchaToken" type="hidden" value="tok-${PORT}" />
  <input name="__RequestVerificationToken" type="hidden" value="verify-${PORT}" />
  ${error ? `<div class="text-danger">${error}</div>` : ""}
</form></body></html>`;

const sixRPage = () => `<!DOCTYPE html><html><body><form action="/Traders/add_six_r" method="post">
<select id="crop_code" name="crop_code"><option value="">---${esc("उत्पाद चुने")}---</option>
${Object.entries(BANDS).map(([code, b]) => `<option value="${code}">${esc(b.name)}</option>`).join("")}
</select>
<input name="DNTCaptchaInputText" />
</form></body></html>`;

const signedIn = (cookie: string | undefined) => (cookie ?? "").includes(`emandi=${SESSION}`);

http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  let body = "";
  req.on("data", (d) => { body += d; });
  req.on("end", () => {
    calls.push({ method: req.method ?? "GET", url: url.pathname, body: body.slice(0, 200) });
    const send = (code: number, type: string, payload: string | Buffer, headers: Record<string, string> = {}) => {
      res.writeHead(code, { "Content-Type": type, ...headers });
      res.end(payload);
    };

    if (url.pathname === "/__calls") return send(200, "application/json", JSON.stringify(calls));
    if (url.pathname === "/DNTCaptchaImage/Show") return send(200, "image/png", PNG);
    if (url.pathname === "/Account/index") return send(200, "text/html", loginPage());

    if (url.pathname === "/Account" && req.method === "POST") {
      const p = new URLSearchParams(body);
      if (p.get("DNTCaptchaInputText") !== CAPTCHA) return send(200, "text/html", loginPage("कैप्चा गलत है"));
      if (p.get("Email") !== USER || p.get("Password") !== PASSWORD) {
        return send(200, "text/html", loginPage("यूज़र नाम या पासवर्ड गलत है"));
      }
      landed = false;
      return send(302, "text/html", "", { location: "/Traders/Dashboard", "set-cookie": `emandi=${SESSION}; Path=/; HttpOnly` });
    }

    // everything below needs the session, exactly as the portal does it
    if (!signedIn(req.headers.cookie)) return send(200, "text/html", loginPage());

    /* The stock register is a DataTable: it answers only when the whole
       DataTables payload is there, the way the real one does. */
    if (url.pathname === "/Stock/DayBook") {
      return send(200, "text/html", `<html><body><input type="hidden" id="license_number" value="L/2016/75/17121983" />
        <input type="text" class="form-control datepicker" id="from_date"><input type="text" class="form-control datepicker" id="to_date"></body></html>`);
    }
    if (url.pathname === "/Stock/GetDayBookList" && req.method === "POST") {
      const p = new URLSearchParams(body);
      const bound = p.get("columns[0][data]") === "crop_name_hi" && p.get("draw") === "1";
      if (!bound) return send(200, "application/json", '{"draw":0,"recordsTotal":0,"recordsFiltered":0,"data":[]}');
      const dmy = /^\d{2}\/\d{2}\/\d{4}$/;
      if (!dmy.test(p.get("Fdate") ?? "") || !dmy.test(p.get("Tdate") ?? "")) {
        return send(200, "application/json", '{"draw":1,"recordsTotal":0,"recordsFiltered":0,"data":[]}');
      }
      calls.push({ method: "DATES", url: `${p.get("Fdate")}..${p.get("Tdate")}`, body: "" });
      const line = (name: string, code: string, ins: string, outs: string, left: string) => ({
        crop_name_hi: `${name} (\ufeffTEST)`, crop_code: code,
        ins_primary: ins, ins_secondary: "0.000", outs_primary: outs, outs_secondary: "0.000",
        availableStock_primary: left, availableStock_secondary: "0.000", availableStock: left,
      });
      return send(200, "application/json", JSON.stringify({
        draw: 1, recordsTotal: 2, recordsFiltered: 2,
        data: [line("धान", "1", "3965.000", "3891.800", "73.200"), line("गेहूँ", "6", "480.000", "480.000", "0.000")],
      }));
    }

    if (url.pathname === "/Traders/index") {
      landed = true;
      res.writeHead(302, { location: "/Traders/Dashboard" });
      return res.end();
    }

    if (url.pathname === "/Traders/get_crop_fees" && req.method === "POST") {
      const code = new URLSearchParams(body).get("crop_code") ?? "";
      const b = BANDS[code];
      if (!b) return send(200, "application/json", "[]");
      return send(200, "application/json", JSON.stringify([{
        min_rate: (landed ? b.min : 0).toFixed(2), max_rate: (landed ? b.max : 0).toFixed(2),
        mandi_fees: "1.00", development_cess: "0.50", isupmandisthal: 0, isDirectlicense: 0,
      }]));
    }
    if (url.pathname === "/Traders/add_six_r") return send(200, "text/html", sixRPage());
    if (url.pathname === "/Traders/Dashboard") return send(200, "text/html",
      `<html><body><input type="hidden" value="VIRESH CHANDRA GUPTA" id="username" />
       <input type="hidden" value="L/2016/75/17121983" id="MerchantLicense" />
       <h2>Welcome,</h2>\r\n <h3 class="prev_data">\r\n\r\nVIJAY LAXMI DALL MILL    </h3></body></html>`);
    return send(404, "text/html", "not here");
  });
}).listen(PORT, "127.0.0.1", () => console.log(`fake e-Mandi on http://127.0.0.1:${PORT}`));
