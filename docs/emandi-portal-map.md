# UP e-Mandi portal — what it does and how it is built

Captured by hand on **25-09-2026** from a live trader session (VIJAY LAXMI DALL
MILL, mandi एटा, licence `L/2016/75/17121983`), reading only: no form on the
portal was submitted and nothing there was changed.

Kept for two reasons: to design Mandi Mitra's side of the work, and to have
something concrete to put in front of the Mandi Parishad when asking for
proper API access.

> Written from observation of one licence's screens. The portal changes often
> (its own pages carry notes dated 12-09-2024 and comments dated 26-03-2025),
> so treat every field list as "true on the date above" and re-check before
> relying on it.

---

## 1. The shape of the site

| | |
|---|---|
| Base | `https://emandi.up.gov.in` |
| Stack | ASP.NET Core MVC — controller/action routes, server-rendered pages |
| Front end | jQuery, `jquery.unobtrusive-ajax`, DataTables, select2, SweetAlert |
| Form protection | `__RequestVerificationToken` (antiforgery) on every POST |
| Captcha | **DNTCaptcha** — image at `GET /DNTCaptchaImage/Show?data=…`, fields `DNTCaptchaText`, `DNTCaptchaInputText`, `DNTCaptchaToken` |
| Digital signature | `lib/DSC/SignerDigital-1.0.0.min.js` + SignalR hub `/SignerDigitalHub` loaded on every page. **Not used by the 6R submit path.** Register a certificate at `/TraderDSC/Index` |
| Published rules | none — `robots.txt` is 404; Terms, Privacy and Hyperlinking policy pages all read "under construction" |
| Official app | an Android APK linked from the home page (OneDrive). Its existence implies a mobile API behind this portal — the thing worth asking for officially |

### Login

`GET /Account/index` → `POST /Account`

| Field | Note |
|---|---|
| `Email` | user name / email |
| `Password` | |
| `DNTCaptchaInputText` + `DNTCaptchaText` + `DNTCaptchaToken` | the image captcha |
| `__RequestVerificationToken` | |

**No OTP for trader login.** The page does contain an OTP form
(`POST /Account/CheckOTP`, field `OTP`) but it sits in a hidden modal
(`#model1`) used for password reset.

Landing page after login: `GET /Traders/Dashboard`.

---

## 2. प्रपत्र-6 (6R) — voucher for the seller, first arrival

`GET /Traders/add_six_r` → `POST /Traders/add_six_r` (form id `form1`,
unobtrusive-ajax, replies JSON)

Rule reference printed on the form: **नियम 68(2) तथा 76(14)**. Notice on the
page: since 13-09-2024 every 6R carries mandi fee and development cess.

### Fields the portal fills (read-only)

| Field | Example |
|---|---|
| `book_number` | `17121983` |
| `serial_number` | `17121983(75)/6/08154` — **the portal issues this; it cannot be pre-computed** |
| `mandi_name` / `mandi_code` | `एटा` / `75` |
| `trader_name` | `VIJAY LAXMI DALL MILL` |
| `trader_license_number` | `L/2016/75/17121983` |
| `dateofissue` | `25/09/2026` |

### Fields we would supply

| Field | Meaning | Where Mandi Mitra already has it |
|---|---|---|
| `trade_mandi` | sale place | fixed, `Etah Mandi` |
| `vikreta_details` | seller firm / farmer **name and district** | daily-list supplier + village/district |
| `vikreta_mobile` | seller mobile | supplier phone |
| `trader_type` | radio `t` (self) / `d` | per firm setting |
| `kreta_license_number` | buyer's licence | mill master (to be added) |
| `kreta_details` | buyer firm name and district | auto-filled by the portal from the licence |
| `crop_code` | commodity, 90 options | commodity master → code map |
| `crop_type_code` + `crop_type` | variety | to be mapped |
| `grade` + `gradename` | `FAQ` / `Non-FAQ` / `Grade A` | per slip |
| `crop_qty` | quintals | slip net weight |
| `crop_rate` | ₹ per quintal | slip rate |
| `crop_amount` | computed in the page | slip amount |
| `mandi_fees`, `development_cess`, `total_amount` | computed from `get_crop_fees` | we can compute the same |
| `EntrySlipNumber` | entry slip no (optional) | — |
| `ExportType` | `For Non Export` / `For Export` | — |
| `IsUpMandiSthal` | hidden, `0` | — |
| `DNTCaptcha*` | **captcha on every 6R** | a person types it |

Commodity codes seen: धान `1`, चावल `2`, मक्का `5`, गेहूँ `6`, अरहर `14`,
अलसी `24`, अण्डी `25`, लाही तथा सरसो `23`, अदरक(हरी) `62`, अरहर दाल `125`,
चावल(खण्डा) `185` — 90 in the list.

### Supporting calls

| Call | Payload | Reply |
|---|---|---|
| `POST /Traders/get_crop_fees` | `crop_code` | `[{"min_rate":3400.00,"max_rate":4500.00,"mandi_fees":1.00,"development_cess":0.50,"isupmandisthal":0,"isDirectlicense":0}]` — the **permitted rate band** and the fee percentages, not a market price |
| `GET /Traders/BindCropTypeDropDown` | `crop_code` | `[{VarietyCode, VarietyNameEng}, …]` |
| `GET /Traders/get_license_detail` | `lice_no`, `tradertype` | `[{kretadetail}]` — buyer firm name and district; empty/absent means the licence is not accepted |

**All of these need a logged-in session.** Called without cookies they return
the login page as HTML, not JSON.

### Reply to the submit

`[{ "status": <0 = refused, >0 = issued>, "msg": "<text shown to the operator>" }]`

On success the page goes to `/Traders/generated_6R`; on `status 0` it refreshes
the captcha (`#dntCaptchaRefreshButton`).

---

## 3. प्रपत्र-9 (9R) — sale voucher, first sale

Chooser: `GET /Traders/NinerDashboard`

| Link | For |
|---|---|
| `/Traders/add_nine_r` | stock from **before** 1 Dec 2021 |
| `/Traders/NineR` | stock from **after** 1 Dec 2021 (the normal one) |

`POST /Traders/NineR`, rule **76(12)**, button reads
"संरक्षित करें और आगे बढ़ें" — **it is multi-step**; step 2 picks the actual
stock lots. No captcha on step 1.

| Field | Note |
|---|---|
| `mandi_name`, `mandi_code`, `trader_license_number`, `trader_name`, `vikreta_details`, `dateofissue` | filled by the portal (we are the seller here) |
| `trade_mandi` | sale place |
| `buyer_state` | radio `u` = UP mandi, `o` = outside UP |
| `trader_type` | radio `t` / `d` |
| `crop_code` | **only what stock allows** — गेहूँ / धान / बाजरा on this licence |
| `buyer_license_no` → `kreta_details` | via `GET /traders/get_license_detail_for9R` |
| `ExportType` | |
| `StockTypeCategory` | **चुने / प्रपत्र-6 / वाह्य प्रवेश पर्ची / प्रसंस्करण(प्रपत्र-6 …)** — this is the link back to 6R |
| `vehicle` + `vehicleName` | ट्रक / पिकप / ट्रक्टर ट्राली / डी सी एम |
| `vehicle_no` | truck number — Mandi Mitra has it on the load |
| `PayType` | radio `0` / `1` (fee unpaid / paid) |

---

## 4. प्रपत्र-9(2) — second-sale voucher

Chooser: `GET /Traders/Niner2Dashboard` →
`/Traders/add_nine_r_two` (pre-Dec-2021 stock) or **`/Traders/NineRTwo`**.

`POST /Traders/NineRTwo`, rule **76(12)**, header
"(केवल द्वितीय पहुँच के विक्रय के लिए)".

Fields: as 9R, plus buyer licence via `GET /traders/get_license_detail_For9R2`.
Crop list here: गेहूँ / धान / मक्का. Vehicle type + number. Submit button
named `Next` — multi-step as well.

Supporting calls: `GET /traders/get_9R_list`,
`GET /traders/get_nine_r_details_two`, `POST /Traders/valid_weight`
(checks the quantity against stock).

---

## 5. गेटपास (प्रपत्र-5) — to move the truck

`GET /Traders/add_gatepass` → `POST /Traders/add_gatepass`, rule **50-क**.

| Field | Note |
|---|---|
| `book_number`, `serial_number` | portal-issued, e.g. `17121983(75)/GP/02311` |
| `dateofissue`, `timeofissue` | portal |
| `page_no` | stock register page |
| `ExportType`, `PaidType` | `Unpaid` / `Paid` |
| `nine_r_id` | **the 9R this gate pass hangs off** — list from `GET /Traders/Bind9RDropDown`, details from `GET /traders/get_nine_r_details` |
| `nine_r_date` | filled from the 9R |
| `dist_todestination` | **distance in km — it sets the validity window** |
| `home_center`, `center_code` | border post / wagon |
| `vehicle`, `vehicle_no` | ट्रक / पिकप / ट्रक्टर ट्राली / डी सी एम |
| `destination_state`, `kreta_mandi`, `kreta_mandi1` | via `GET /traders/dist_state`, `GET /Traders/BindStateList` |
| `crop_code`, `crop_type`, `crop_weight`, `rate_parameter` | pulled from the 9R (read-only) |
| `bundle_no` | number of bags |
| `DNTCaptcha*` | **captcha again** |

Validity printed on the page: 0–50 km → 4 h · 50–100 → 8 h · 100–200 → 16 h ·
200–500 → 30 h · 500–1200 → 72 h.

Current notice: **"स्वतः जारी गेटपास (Unpaid) की सुविधा कुछ समय के लिए बंद है"**
— the auto-issued unpaid gate pass is switched off at their end.

---

## 6. Reading it all back (what reconciliation needs)

Server-rendered HTML tables, date-filtered, **no JSON API** — so these are
fetched with the session cookie and parsed.

| Page | Holds |
|---|---|
| `/Traders/generated_6R` | issued 6Rs — date, entry slip no, page no, seller firm+district, buyer firm+district, crop, weight (qtl), rate, view |
| `/Traders/generated_9R` | issued 9Rs |
| `/Traders/generated_9R2` | issued 9R(2)s |
| `/Traders/generated_gatepass` | issued gate passes |
| `/Traders/generated_es` | inward slips from outside the state |
| `/Stock/AvailableStock` | stock, commodity-wise |
| `/Stock/Stocks`, `/Stock/DayBook` | stock register (day book after 1 December) |
| `/Traders/DigitalPayment`, `/Traders/DigitalPaymentList` | mandi fee paid online |
| `/Traders/DemandAndCollectionDashboard` | **demand and collection — what the mandi says is due** |
| `/Reports/SevenRList` | 7R report |
| `/Receipt/print_9R` | the printable 9R — renders **8 copies** on one sheet (e.g. `17121983(75)/9/0002913`, 25/09/2026 07:26 AM) |

Filters on the issued lists: `from_date`, `to_date` (dd/MM/yyyy), `filter`,
`reset`.

Also on the trader menu: `/MultiCommodity/Index` (9R for several commodities),
`/MultiCommodity/add_gatepass`, `/Traders/TraderAutogeneratedgatepas`,
`/Exemption/ExemptionDashboard`, `/Traders/MillerDashboard`,
`/Traders/ProcessingModuleDashboard`, `/Traders/SecondarySlipDashboard`,
`/Traders/PreArrivalSlipDashboard`, `/LicenseConversion`,
`/Exporter/ExporterDashboard`, `/RejectionMaster/NineRCancellations`,
`/RejectionMaster/CancelInstrument?type=9|9-2`.

---

## 7. What this means for Mandi Mitra

**Straightforward, no automation of the portal**

- Hold the mapping: each mill's licence number, each supplier's district and
  mobile, our commodity → their `crop_code` / variety / grade.
- Show the **rate band** (`get_crop_fees`) per commodity, with the fee and cess
  percentages, so the day is priced knowing the band.
- **Reconcile**: issued 6R/9R/gate passes and Demand & Collection against our
  slips, loads and parchas — slips with no 6R, 9R weights against our trucks,
  mandi fee charged against what the parcha billed.
- Print a **single copy** of a 6R/9R/gate pass from the data, instead of the
  portal's eight.

**With the operator present, one captcha each**

- Fill 6R / 9R / 9R(2) / gate pass from our record in a portal window the app
  opens; the operator types the captcha and presses submit; we read the issued
  serial back onto the slip or load.

**Out of scope, deliberately**

- Anything that solves or sidesteps the captcha.
- Vouchers for purchases that did not happen — 6R is a statutory record under
  Rule 68(2) and fixes the fee; inventing sellers or quantities is falsifying
  it, and the exposure is the licence.

**The real unlock**

Ask the Mandi Parishad for trader API access or a bulk upload (helpdesk
0172-5609566, Kisan Mandi Bhawan, Vibhuti Khand, Gomti Nagar, Lucknow). We
already hold every field their forms ask for.

---

## 9. The one that cost a day: sign in the way a browser does

**Symptom.** `POST /Traders/get_crop_fees` answered
`{"min_rate":0.00,"max_rate":0.00,"mandi_fees":1.00,"development_cess":0.50}`
for **every** commodity — all 89 of them — while the same licence, in Chrome,
in the same minute, got धान 3400–4500 and कत्था 20,00,000–22,00,000.

**What it was not.** Ruled out, one at a time, against the live site:

- the request body — `crop_code` is the only field the site's own script sends
- the headers — tried with Chrome's exact user-agent, origin, referer,
  accept-language; with the antiforgery token in the header and in the body
- the cookies — our jar held the same three: `.AspNetCore.Session`,
  `.AspNetCore.Identity.Application`, `.AspNetCore.Antiforgery.*`
- the page order — `add_six_r` first, `BindCropTypeDropDown` first, both
- the licence — **the wrong lead**. A mill's licence does carry a band; it had
  simply never been asked for properly. Hours were lost here.
- a market rate not being published yet — no; Chrome had it all along

**What it was.** The login page decides where to send you, in its own script:

```js
var onSuccess = function (data) {
  if (data.succeeded === true) {
    ...
    else if (data.role == "merchant") { location.href = "/Traders/index"; }
```

A browser therefore **lands on `/Traders/index`**, which answers **302** on to
the dashboard. e-Mandi does not finish setting up the session until that page
has been opened. We went straight to `/Traders/Dashboard`, so the session was
half set up and every rate came back `0.00`.

And the bug hid its own cause: `signedInCall()` treated *any* 3xx as "e-Mandi
has signed this computer out", so the one page that was needed was the one page
that could not be opened — every attempt to try it reported a sign-out instead.

**The rule that follows.** Against this site, do what the site's own pages do:

1. After the login POST, **land on `/Traders/index`** and follow the redirects,
   as `onSuccess` does. Only then probe the dashboard.
2. **A redirect is normal.** Follow it (a 302 with a GET, up to a few hops).
   Only a redirect to `/Account…` means the session has really ended.
3. Fetch a page with a browser's page headers, and send one of the site's own
   XHR calls with its XHR headers (`Accept: */*`, `X-Requested-With`, `Origin`,
   the `Referer` of the page that owns the call, `Sec-Fetch-*`). Not to hide —
   for compatibility, because this site's session state depends on it.
4. When a figure is wrong, **compare against the same account in a browser at
   the same minute** before theorising about licences or data. One DevTools
   capture settled what a day of reasoning could not.

The stand-in portal (`scripts/fake-emandi.ts`) now withholds the band until
`/Traders/index` has been opened, so `scripts/e2e-emandi.ts` fails with
`minRatePaise: 0` — the owner's exact symptom — if this is ever undone.

**There was no websocket anywhere in this.** Plain HTTPS: a POST, a 302, a GET.
