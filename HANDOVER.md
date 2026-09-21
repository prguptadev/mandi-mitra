# Mandi Mitra — project handover

Everything a new session (or a new developer) needs to pick this up cold.
Last updated: 2026-09-21.

---

## 1. The business

The owner runs a grain commission business (*arhat* / *adat*) trading as
**Vijay Laxmi Dal Mill, Etah, Uttar Pradesh**, plus a second firm,
**V C Enterpises**. The flow:

1. Small suppliers (*adati*) bring paddy, wheat or maize to the mandi daily.
2. Each delivery is weighed and written on a paper **daily list** — one row per
   slip: supplier name (Hindi), RST no, gross weight, katauti, net weight, rate.
3. Slips are grouped per buyer mill and loaded onto a truck against that mill's
   purchase order. Whatever is not loaded stays in stock.
4. The mill is billed with a **kaccha parcha** — goods value plus the charges
   that mill applies.
5. Separately, each supplier is owed money, tracked day-wise like Tally.

The owner scans the handwritten sheets on a **Canon G3770** (flatbed, no ADF)
and wants them read automatically, checked, and turned into the parcha.

### Source documents this was built from

Photographs of four papers dated **20-09-2026**:

- G.R.M daily list, 30 rows + 3 on a second page, handwritten total 620.36 qtl
- L.B daily list, 13 rows, total 331.05 qtl
- Kaccha parcha, invoice 196, truck UP25CT5038, grand total ₹11,27,851.22

---

## 2. Business rules — derived and verified, not assumed

Every rule below was tested against the actual paper. **Do not change these
without re-running the checks.**

### Katauti is NOT the bag count

This was got wrong once and corrected. Both hypotheses were tested against
**all 45 rows** of the two sheets:

```
katauti === round(gross to nearest quintal):  45/45 rows
```

Katauti is the **gross weight rounded to the nearest quintal**, and **1 kg is
deducted per unit** — i.e. 1 kg per quintal.

Proof it is not bags: if it were, the sheet implies 98.8 kg per bag, while the
parcha's 800 *katte* over 310.74 qtl work out to 38.8 kg. Two different
quantities. The parcha's bag count is captured at load time, in its own column.

**Consequence: the operator never types katauti.** Four typed fields per row —
RST, supplier, gross, rate. Everything else is derived.

### Rounding is half-up ("owner's favour")

```
half_up     45/45   <-- the one in use
half_even   43/45
up (ceil)   28/45
down        19/45
```

The three exact `.50` cases all round **up** on the paper: 32.50→33, 28.50→29,
17.50→18. A bigger katauti is a bigger deduction, so up favours the owner.
Configurable per mill; `half_up` is the default.

### Parcha arithmetic — reproduces invoice 196 to the paisa

| Line | Rule | Value on the paper |
|---|---|---|
| Goods value | net × rate | 10,60,695.45 |
| Kacchi adat | 2% of goods | 21,213.91 |
| Subtotal | goods + adat | 10,81,909.36 |
| Labour | ₹9.50 per bag × 800 | 7,600.00 |
| Sutli | ₹1 per bag × 800 | 800.00 |
| Gaushala | ₹1.25/qtl on **gross**, not net | 394.13 |
| Mandi tax | 1.5% of **(goods + adat)** | 16,228.64 |
| Commission | 1% of **(goods + adat)** | 10,819.09 |
| Gate pass | ₹100 per truck | 100.00 |
| Total | | 11,17,851.22 |
| Dara | printed, **excluded** from grand total | 3,597.38 |
| Advance | **added**, not deducted | 10,000.00 |
| **Grand total** | | **11,27,851.22** |

The percentage **base** matters: switching mandi tax from *goods + adat* to
*goods only* changes one truck by **₹318.21**. That is why every base is
per-mill configurable and nothing is hardcoded.

### Parcha rate is the weighted average

`Σ(net × rate) / Σ net` over the slips in the load. The L.B sheet's 13 rows give
331.05 qtl and exactly **3413.45**, the rate printed on the parcha. It is never
typed by hand.

Slips with **no rate yet are excluded from that average** — one unpriced row
would quietly drag the parcha rate down.

### Trucks are loaded by weight, from a mill's stock (decided 21-09)

The owner does not track which slip went on which truck. A truck is loaded
**by weight** from its mill's stock:

- **Stock** of a mill = what was bought on that mill's sheets (Σ slip net)
  − what truck rows took, **per purchase day**. It **may go negative**
  (orange, never blocks).
- A truck has **rows**: weight taken from one purchase day (optionally
  against a PO), priced at **that day's average rate for the mill** — the
  owner's "dara" (Σ net × rate / Σ net over priced slips) — unless a rate is
  typed. These are the parcha's PO / JEANS / DATE / WEIGHT / RATE / AMOUNT
  rows; the paper's second row is for a second day.
- One row may be left blank: it takes whatever of the **mill's net** the
  typed rows leave. Rows must add up to the mill net to approve.
- This settles the 20.31 qtl gap: L.B's 20-09 list is 331.05, the mill
  billed 310.74, so **20.31 stays in L.B's stock** for the next truck.
- Goods = Σ row amounts; the TOTAL row's rate is goods ÷ weight.

### Supplier ledger

balance = opening + Σ purchases (slip net × rate, on the slip date) −
Σ payments. Positive = we owe (देना), negative = paid ahead (लेना). Never
stored — summed every time. Slips with no rate count as 0 until priced.

### Other observed behaviour

- Slips move between mills: RST 634 was struck off the G.R.M sheet and appears
  on the L.B sheet. "Move to mill" on the daily list does this; the slip's
  weight then counts in the new mill's stock.
- Bardana differs by side: 1.00 kg/bag when buying, 0.57 kg/bag as the
  destination mill counts it (4.56 qtl ÷ 800 bags).
- Sheets run onto a second page; both pages are one list.

---

## 3. Architecture

| Layer | Choice | Why |
|---|---|---|
| UI | React 18 + TypeScript + Vite, Tailwind | |
| API | **Hono**, one app object (`server/app.ts`) | Electron will import the same object — no second data layer |
| Local DB | SQLite + Drizzle ORM | Offline, single file, easy backup |
| Cloud | Postgres later, same Drizzle schema | `sync_outbox` already records every write |
| IDs | **UUIDv7** everywhere | Local and cloud rows can never collide |
| OCR | Gemini via REST, strict `responseSchema` | No SDK dependency |
| Router | wouter | |
| Data fetching | TanStack Query | |

### Non-negotiables

- **Money is paise, weight is grams, both integers.** Never floats for either.
  `server/lib/money.ts`. `310.74 × 3413.45` must land on the exact paisa.
- **Net and amount are always derived server-side**, never trusted from the
  client, and re-checked on every read.
- Every mutation writes an **append-only audit row** with before/after.
- Browser first. **Electron only when the owner asks** — the boundary is
  already in place.

### Layout

```
server/
  app.ts                 Hono app — the single API surface
  index.ts               dev entry; runs migrations + scan recovery
  db/schema.ts           Drizzle schema (source of truth)
  db/migrations/         generated; never hand-edit
  lib/
    money.ts             paise/grams helpers, weightedAvgRate
    charges.ts           ChargeConfig, deriveKatauti, computeParcha
    charges.check.ts     regression vs invoice 196
    translit.ts          Devanagari -> Hinglish, normKey, fuzzy matching
    translit.check.ts    regression over the sheet names
    display.ts           number/currency + katauti defaults
    prefs.ts             per-user screen preferences
    secrets.ts           AES-256-GCM for the API key
    gemini.ts            prompt, response schema, salvageRows
    scanRows.ts          per-row OCR validation
    adatiResolve.ts      three-tier supplier matching
    parcha.ts            a truck's rows, stock, checks and the parcha document
    parchaLabels.ts      printed wording / Indian number style (server + browser)
    parchaXlsx.ts        the parcha as Excel, laid out like invoice 196
    millReport.ts        Dara (mill report) Excel / CSV
    slipOrder.ts         row order incl. by name (server + browser)
    rbac.ts              36 permissions, 5 role presets
    auth.ts  audit.ts  http.ts  ids.ts
  routes/
    auth.ts  adati.ts  merchants.ts  jins.ts  users.ts
    system.ts  settings.ts  slips.ts  scans.ts
    orders.ts            purchase orders (number optional, date required)
    loads.ts             trucks, their weight rows, approve / void, Excel
    reports.ts           Dara (mill report) and mill stock
    accounts.ts          supplier ledger and payments
src/
  lib/       api.ts  format.tsx  prefs.tsx  i18n.tsx  strings.ts
             session.tsx  theme.tsx  utils.ts  format.check.ts
  components/ AppShell  SupplierPicker  DailyListSettings
              Skeletons  ErrorBoundary  ui/index.tsx
  pages/     Auth  Dashboard  Suppliers  Mills  DailyList
             ScanList  ScanReview  Admin  SettingsExtras
             Orders  Loads (list, truck, register)  Stock  Accounts (ledger, payments)
scripts/
  dev-bootstrap.ts        signup an owner on an empty DB
  dev-make-review-scan.ts a scan stuck in review, no Gemini call
  e2e-daily-list.ts       real L.B sheet through the HTTP API
  e2e-scan-review.ts      OCR pipeline, no Gemini call
```

---

## 4. What is built

### Working and verified

- **Auth** — one-time signup, PIN login (4–6 digits, scrypt, lockout after 5),
  change PIN, per-user language and theme.
- **Multi-business** — Vijay Laxmi and V C Enterpises, switcher in the sidebar.
  Suppliers, mills, stock, scans and **the Gemini key** are all per business.
- **RBAC** — 36 permissions, roles as editable DB rows (owner / manager /
  accountant / operator / viewer), per-user allow/deny on top, deny wins.
  Owner role cannot be stripped; the last owner cannot be demoted.
- **Audit trail** — every mutation, before/after diff, redaction, no delete path.
- **Masters** — suppliers (Hindi + Hinglish + learnt aliases), mills (full
  charge config with a live parcha preview), commodities.
- **Daily list** — Tally-style keyboard grid. Enter walks the row and saves on
  the last field. Column-driven from preferences. Live totals, sheet-total
  cross-check, bulk mill reassignment, CSV export.
- **Daily-list settings** — on-screen gear button: new row top/bottom, row
  order, density, column visibility (separately for screen and download),
  carry-rate-forward. Two save scopes: **this browser only** or **saved for me**.
- **Numbers & currency** — Indian / international / no grouping, currency
  symbol on-off and configurable, decimals per field type, brackets or minus
  for negatives, lakh/crore hints. One formatter drives every figure.
- **Scan & OCR** — upload one or many pages (JPG/JPEG/PNG/WEBP/HEIC/TIFF/PDF),
  read with Gemini, review in a spreadsheet beside the scanned image, approve
  straight into the daily list. Corrections are learnt.
- **Bilingual** — every screen in Hindi or English, including dates, relative
  times and OCR issue messages.
- **Type Hinglish, get Hindi** — every hand-typed Hindi field converts as you
  type: "phoolsingh verma" becomes फूलसिंह वर्मा. Space converts the word just
  finished — only that word, so "सिंह raam" + space gives "सिंह राम " and a box
  can hold a mix. It triggers on the inserted space (`src/lib/hindiTyping.ts`),
  not the key event, so phone keyboards and suggestion taps work too, and
  letters typed while the lookup runs are kept. Enter or Tab accepts the
  preview, Esc keeps the Latin. The supplier picker shows
  the Hindi reading of a Latin query and creates new suppliers in Devanagari. The business's own supplier spellings are consulted first, so
  a name is written the way that office already writes it; then a dictionary of
  common name and firm words; then a phonetic engine.
- **Scales to thousands of suppliers** — the picker searches on the server and
  never renders more than 20 rows. Measured at 2,131 suppliers: every query
  answered in 2–4 ms, and a Latin query finds the Devanagari name.
- **Light / dark**, skeleton loaders, collapsible sidebar, error boundary.

- **Purchase orders** — per mill and commodity; the number is optional (a
  mill often sends only a date), the date is required. Sent / balance from
  truck rows; going over is flagged, never refused.
- **Loads (trucks)** — by weight from the mill's stock (see §2), mill
  weighbridge (gross, katte, bore, bardana per bag type → net), live parcha,
  approve (frozen snapshot, truck locked), void with reason (version 2 on
  re-approval, same number), print in the paper's layout, Excel.
- **Kaccha parcha register** — every parcha, approved and void.
- **Mill stock** — per mill bought / on trucks / left, then day by day with
  the trucks and parcha numbers that took from each day and a running balance.
- **Dara (mill report)** — "Vijay Laxmi Dal Mill → mill": the mill's slips for
  a day or range, total and average rate; Excel / CSV; own columns in the
  daily-list settings; a Dara button on the daily list and per day on stock.
- **Daily-list download** — one day or a range; one "Adati name" column in the
  chosen script; same order as the screen; sort by name by clicking the header.
- **Supplier ledger and payments** — Tally-style statement with brought
  forward, running balance, CSV and print; payments by cash / bank / UPI /
  cheque with balance before and after.

### How the OCR is made trustworthy

The prompt asks Gemini for **what is written**, never for a calculation. Net
weight and amount are re-derived by our own code; the model's reading of the
NET column is used only as a **cross-check**. A row whose written net equals our
arithmetic is almost certainly read correctly.

Three-tier supplier matching, each verified:

Suggestions are capped at the **three closest**; more is noise on a 30-row sheet.

**The model is given the supplier list.** Fuzzy matching after the fact only
ever sees the model's transcription — if it wrote "डोलार राम" for फूलसिंह वर्मा,
no string comparison recovers that. Now up to 300 known names (most-used first)
go into the prompt, and the model returns both what is written and which listed
supplier it most likely is. An exact pick from the list resolves as `model`;
the operator's own earlier corrections (aliases) still take priority.

Review cells: an **orange border** means worth a look (low confidence, the
paper's net disagreeing with the gross, katauti mismatch, rate out of range)
and disappears as soon as the operator edits that cell. A **red border** means
approval is blocked, and the reason is written under the cell. No stars, no
bracketed numbers.

| Tier | Example | Confidence |
|---|---|---|
| Exact alias | `फूलसिंह वर्मा` | 1.00 |
| Normalised key (matras stripped, confusable consonants folded) | `फुलसिह वर्मा`, `फूलसींह बर्मा` | 0.95 |
| Fuzzy (Damerau-Levenshtein) | `फूलसिंघ वरमा` | 0.86 |
| Genuinely different name | `राकेश यादव` | **no match, no guess** |

Every correction becomes an alias with a hit counter, so the same misreading
resolves by itself next time. Verified: a name the operator picked manually
resolves via `alias` on the very next lookup.

Rows struck through on the paper are detected and excluded by default — this
worked on the real G.R.M sheet (row 6, RST 634).

### OCR when Google is busy

A busy (5xx), unreachable or per-minute-limited Google is retried: 4 tries
over ~40 s (`readSheetReliably`), then the fallback model gets a go. A page
that still fails **stops the read** with the pages so far kept, and "Read
again" resumes from that page — a page is never silently skipped. A daily
limit, a bad key or a refused image are not retried (it only spends reads).
`server/lib/gemini.check.ts` tests this offline against a stubbed Google.

### Read quality on the real sheet

Against the owner's actual 30-row G.R.M photograph, compared to a manual
transcription:

```
rows agreeing on gross, katauti and rate : 29 / 29
the only unmatched row                   : the struck-through one, correctly flagged
katauti matching round(gross)            : 30 / 30
written net matching our arithmetic      : 30 / 30
mean confidence                          : 0.90
```

---

## 5. Setup

```bash
npm install
npm run db:push                       # apply migrations
npm run dev                           # api :8787, web :5173
```

Fresh database from nothing:

```bash
rm -f data/mandi.db* && npm run db:push \
  && npx tsx scripts/dev-bootstrap.ts \
  && npm run db:seed
```

`db:seed` loads the two mills (G.R.M, L.B) and the 31 supplier names read off
the real sheets, plus an Operator and an Accountant login so role restrictions
can be exercised.

### Dev logins (throwaway — delete `data/mandi.db*` before real use)

| User | PIN | Role |
|---|---|---|
| Test Owner | 482915 | Owner, all 36 permissions |
| Munshi Ji | 271830 | Operator, 17 |
| Accounts | 394726 | Accountant, 14 |

### Checks — run all of these before claiming anything works

```bash
npm run typecheck
npx tsx server/lib/charges.check.ts      # parcha maths vs invoice 196
npx tsx server/lib/translit.check.ts     # Hindi -> Hinglish + fuzzy
npx tsx src/lib/format.check.ts          # Indian grouping + input parsing
npx tsx src/lib/devanagari.check.ts      # Hinglish -> Hindi, word by word
npx tsx server/lib/gemini.check.ts       # OCR retry behaviour, stubbed Google
npm run test:e2e                         # 112 checks on a throwaway database
npm run build
```

`npm run test:e2e` is the **only** way to run the e2e scripts: it starts its
own server on :8799 with `data-test/` and deletes both afterwards. The scripts
refuse to run against the real database (`scripts/_guard.ts`). It covers the
daily list, the OCR review, trucks / PO / parcha / stock (invoice 196 to the
paisa) and the ledger (hand-worked rupees).

CI (`.github/workflows/ci.yml`) runs all of the above on every push.

### Gemini

Settings → Gemini API key. Stored **per business**, encrypted with AES-256-GCM;
the key file is `data/.secret.key`, mode 0600, gitignored. The key is never
returned to the browser or written to the audit log — only a mask.

**Free-tier quota.** Google's free tier allows **20 requests a day per model
per project** for gemini-2.5-flash (`GenerateRequestsPerDayPerProjectPerModel-FreeTier`),
resetting at midnight US Pacific, about 12:30 pm IST. One page is one
request. A 429 is parsed (`parseQuota` reads `QuotaFailure` / `RetryInfo`)
and explained in plain words; it is not a "wait a minute" problem. The only
real fix is billing on the Google Cloud project behind the key.

What the app does about it:
- every request is logged in `gemini_calls` (per key hash, never the key), and
  the scan screens show "N of 20 used today" with the reset time;
- a quota refusal stops the whole read at once — no retries, no fallback
  model after a failure — and keeps the pages already read (`pages_done`);
  reading again resumes from the next page;
- "Test key" calls `GET /v1beta/models/{model}`, which spends no quota;
- the page-order step says how many reads a scan will use.

Known limitation: the key file sits on the same disk as the database. That
protects a leaked backup, not someone with full machine access. Moving it to
the Windows Credential Store is an Electron-era task.

---

## 6. Decisions already taken — do not re-litigate

- **Scan images live on the filesystem**, at `data/scans/<batchId>/`, not in the
  database. Reasons: a 4 MB JPEG per sheet would bloat the SQLite file and its
  WAL, slow every backup, and there is no query ever run against image bytes.
  The DB stores the path, MIME type and size. Images are **kept after commit**
  so a parcha can always be traced back to the paper. Each folder also carries a
  `meta.json` sidecar naming the date, mill, commodity and status, so the images
  still mean something browsed in Finder or Explorer, and remain taggable even
  if the database is lost. Every slip created from a scan keeps its
  `scanBatchId`, and the daily list shows a small image icon linking back to the
  original. `data/scans/` is gitignored.
- **The scan and the grid share a draggable divider**, remembered per device
  in localStorage (`mandi.split.scanReview`); double-click resets it.
- **RST is the weighbridge slip number**, not a row count and not sequential,
  and it **may repeat**. A repeated or unreadable RST is highlighted orange and
  never blocks saving — on the scan review or the daily list. The unique index
  on (business, date, RST) was dropped in migration 0004 for this reason.
- **Multi-page reads show nothing until every page is done.** The API returns no
  rows while a scan is `reading`.
- **Review cells carry no text** — colour only: orange = worth a look (cleared
  by editing), red = blocks approval (name missing, weight missing). The reason
  is in the cell's tooltip; the approve button counts the red ones.
- **Multi-page scans are ordered before they are read.** Several pages stop at
  an order step; the model then reads them as one list and tags each row with
  its page. The review shows every page stacked in one scroll, and the grid
  groups rows under a header per page that scrolls the scan to that page.
  Reordering is refused once a sheet has been read, since page numbers come
  from the read itself.
- **Reads run detached from the request.** `POST /scans/:id/run` returns
  immediately; the work continues server-side and the browser polls. Switching
  tabs, opening the daily list or reloading loses nothing. A process restart
  resets orphaned `reading` rows on startup (`recoverInterruptedScans`).
- **Trucks load by weight, not by slip** (see §2). Slips are never tied to a
  truck; `purchase_slips.load_id` is unused since migration 0009.
- **Hand-written migrations 0007 and 0009.** drizzle-kit answers a column
  change on SQLite by rebuilding the table (`__new_x`, copy, DROP, RENAME).
  Inside the migrator's transaction `PRAGMA foreign_keys=OFF` does nothing,
  so the DROP fails once another table references it (0007 hit this with
  `loads.po_id`). It also once copied columns the old table did not have
  (0006). **Always test a generated migration on a copy of data/mandi.db**
  (`sqlite3 data/mandi.db ".backup /tmp/x/mandi.db"`, then run migrations
  with `MANDI_DATA_DIR=/tmp/x`) before the dev server picks it up — the dev
  server applies migrations the moment a server file changes.
- **Browser first**; Electron when asked.
- **Roles are rows, not code**, so permissions stay editable.
- **Katauti is derived, not typed.**

---

## 7a. DATA LOSS INCIDENT — read this before running anything

On 2026-09-21 the end-to-end scripts deleted the owner's real data. Both
scripts cleared "their" date before running — `e2e-daily-list.ts` every slip on
2026-09-20, `e2e-scan-review.ts` every slip and scan on 2026-09-21 — and both
pointed at the live dev database, which the owner was using for real work.
Every check run wiped the owner's entries for those days.

Recovered: 29 slips of the 20-09 G.R.M sheet, from the audit log's full-row
copies. Not recoverable as rows: 43 slips on 21-09, deleted by direct SQL with
no audit copy — but their scan images survived on disk, and both scans were
re-registered in "uploaded" state so the owner can read them again.

**The rule now:** nothing that writes or deletes data may touch `data/`.
- `npm run test:e2e` starts its own server on :8799 with its own database in
  `data-test/`, runs every end-to-end check, and deletes that database.
- Every script that writes data imports `scripts/_guard.ts`, which exits unless
  `MANDI_DATA_DIR` names a test directory and the API is not :8787.
- Verified: the real database's row counts, total net weight and scan image
  checksums are identical before and after a full test run.

Never run a data-writing script against the dev server by hand again.

## 7. Bugs already found and fixed — context for the next session

| Symptom | Cause | Fix |
|---|---|---|
| Toggle switch knob rendered outside its track | `<button>` centres content, moving an absolutely positioned child's static origin; it stacked with the transform | explicit `left-0.5` + `text-left` |
| "Attach at least one image of the sheet" from the file picker | the live `FileList` was handed to an async mutation, then the input was cleared on the next line, emptying it | copy to `File[]` synchronously; the mutation only accepts `File[]` |
| "The model's reply was not valid JSON" | 30 rows read perfectly, then truncated on the closing brace — 8192 output tokens, and Gemini 2.5 spends thinking tokens from the same budget | `thinkingBudget: 0`, ceiling raised to 32768, plus `salvageRows()` which recovers complete rows from a truncated reply |
| `netQtl` null on every row | it was optional in the response schema, so with thinking off the model skipped it — killing the arithmetic cross-check | `netQtl` and `struckThrough` are now **required** in the schema |
| White screen on a scan URL | `batch.data!` dereferenced when the query 404s (scan belongs to another business) | explicit load-failure state + an `ErrorBoundary` around the router |
| `instanceof ApiError` unreliable | Vite HMR creates duplicate module copies | duck-typed `apiStatus(err)` |
| OCR e2e failed on the second run | the test commits slips and teaches aliases, so a rerun legitimately saw different behaviour | the script now clears its own footprint first |
| Daily-list e2e failed on the second run | same class of problem — it inserts slips, so a rerun hit the duplicate-RST guard | self-cleaning, and it now switches business explicitly |
| Gemini 401 "invalid authentication credentials" | the saved value was an `AQ.…` short-lived token, not an `AIza…` API key. It works for a few hours then expires — which is why one business succeeded and the other failed overnight | plain-language error mapping, a format warning on save (warning, not a block — it demonstrably works), and a "copy the key from <business>" action |
| Login landed in an arbitrary business | the first membership row the DB returned | the last business used is remembered in user prefs and restored at sign-in |
| A scan URL showed a bare "something went wrong" | TanStack Query v5's `isLoading` is `isPending && isFetching`, so it drops to false during retry backoff — no data, no error — and the guard fell through to the failure screen | gate on `isPending`, and never retry a 404 |
| "Scan not found" was a dead end | a scan belongs to one business; the link was opened from another | `/scans/:id/whereis` names the business (only ones the user belongs to) and offers a one-click switch |
| `<button>` nested inside `<button>` in the scan list | the whole row was a button and carried action buttons | the row is a `role="link"` div with keyboard handling |
| Hand-picked suppliers showed as empty on the scan review; "only the top one works" | every pick saved correctly, but the grid only named rows that were auto-matched. The supplier list had been removed from that screen for scale, and nothing replaced it for hand-picked ids | the server returns `chosen` beside `match`; the grid shows either. **Verification now asserts what the screen shows, not only the server state** — the earlier check passed because it looked at the wrong layer |
| Could only change the last digit of a weight; RST 626 ended up as 19.008 | the cell was `value={n.toFixed(2)}`, reformatted on every keystroke. Delete the `2` from `19.20` and it was redrawn as `19.00` with the cursor at the end, so typing `8` gave `19.008`. Earlier this was wrongly put down to stray keystrokes. `Number(x) \|\| 0` on the Mills screen was worse — `1.` became `1`, so 1.5% could not be typed | `NumberInput`: shows exactly what is typed while focused, tidies on blur. Replaced all seven affected fields. Verified with real editor operations on middle and decimal digits |
| Approve stayed grey with no reason | a blank commodity from the upload box, and 8 blocking rows whose reasons had been removed from the screen | commodity defaults to the business's most-used, then 1509; red cells carry a short reason underneath |
| Page 3's rows appeared above page 1 | all pages went in one Gemini call and the model inferred which page each row came from | pages are read **one per call**; the page number is the image's position, not the model's guess, and rows save as each page lands |
| Duplicate slip numbers that could not be cleared | real misreads — 1471 read as 671, 1473 as 633 — but the only explanation was a tooltip on a disabled star | red box plus "same slip no. as row N" underneath; prompt now warns that slips mix 3- and 4-digit numbers and not to drop a leading 14 |
| Daily list new line had no name box | the owner had hidden the Hindi name column, and the entry-row supplier box only ever lived in that column | the box goes in whichever name column is visible, and at least one name column is always shown |
| A picked supplier vanished from the box | after the change for 1000+ suppliers, the picker relied on its search cache to name the chosen id | the picker keeps the option it was given |
| "Add missing suppliers" would have created duplicates | it created "धरमपाल" beside the existing "धर्मपाल सिंह", splitting that supplier's ledger | rows with a close suggestion are left to pick; only names with nothing close are created |
| "Google's rate limit was hit. Wait a minute" every day | wrong diagnosis: it was the free tier's **daily** cap of 20, and a failed page still triggered the fallback model, so each failure spent two | quota parsed and explained, read stops and resumes, usage counter, key test spends nothing (see §5 Gemini). Two scans failed before the fix still show the old text until re-read |
| Only the first word became Hindi | once the box held any Devanagari, `looksLatin` was false for the whole value, so later words were never converted; the server also refused mixed text | server converts only the Latin tokens of mixed text; the client converts just the word finished by the space |
| Dev API down after a schema change (twice) | a generated migration failed on the real DB: 0006 copied parcha columns that did not exist; 0007 rebuilt purchase_orders, which SQLite refuses while loads reference it. Both rolled back; no data lost | hand-fixed / hand-written migrations, tested on a copy first (see §6) |
| "Cannot read properties of undefined (reading 'length')" on a truck | the owner opened the page mid-change: new server, old screen expecting a slip list | not a code bug; screens and server changed together |
| OCR "Google's service had a problem" failed the whole read; a failing middle page was skipped | no retry on 5xx; the loop noted the page and went on without its rows | retries with backoff, fallback model, stop-and-resume instead of skipping |
| Approve stuck disabled on a fresh business | every OCR name was unmatched because the master was empty, and picking 29 one by one is not a reasonable ask | "Add the N missing suppliers" creates them from the sheet and links the rows — 29 blocking to 0 in one action |

---

## 8. Pending

### Open questions for the owner

1. **Dara on the parcha (₹3,597.38 on invoice 196)** — typed by hand per truck
   for now, printed but outside the grand total. The owner called the per-mill
   daily average report "dara"; is the parcha's TOTAL DARA worked out from it?
2. **Labour ₹15.50** — built as the rate for **bore** (jute) bags, because 196
   prints it with a dash while BORE is empty. Which bags each labour / sutli
   rate counts is a mill setting if that is wrong.
3. **Bore bardana weight** — 1.00 kg a bag is a guess; set it per mill.
4. **Business city** — the parcha heading reads "VIJAY LAXMI DAL MILL - ETAH
   (U.P)" only once the business profile has a city.
5. **GST / e-way bill** — an optional e-way bill no. is on the truck. Unbranded
   paddy, wheat and maize are GST-exempt, and exempt goods need no e-way bill
   (rule 138(14)(d)); confirm with the owner's CA.

### Next to build

1. **Electron + installer** — main process imports the existing Hono app,
   electron-updater, GitHub Action for the Windows build.
2. **Scanner integration** (Electron only) — watch folder, open the Canon
   scan window, WIA via PowerShell.
3. **Backup / restore** — scheduled local SQLite backup. Before real money.
4. **Cloud sync** — Postgres plus the outbox pusher.
5. Supplier deductions on the ledger (if the owner charges suppliers anything),
   a mill (receivable) ledger from approved parchas, dashboard figures.

### Smaller gaps

- No unit test runner (vitest). Five regression scripts in CI plus `test:e2e`
  (112 checks).
- Printing is via the browser's print dialog ("Save as PDF" for a PDF);
  not yet tried on the owner's printer.
- Responsive but untested on a real tablet.
- PDF uploads are passed to Gemini as-is; multi-page PDFs are not split.

### A second copy for clicking through

Never click through new features on the real app. Run a throwaway copy:

```
MANDI_DATA_DIR=$PWD/data-uitest PORT=8798 npx tsx watch server/index.ts
MANDI_API_PORT=8798 VITE_PORT=5174 npx vite --host 127.0.0.1 --strictPort
MANDI_DATA_DIR=$PWD/data-uitest MANDI_API=http://localhost:8798/api npx tsx scripts/dev-bootstrap.ts   # then seed.ts, e2e-daily-list.ts
```

Open it at **http://127.0.0.1:5174** — a different host from localhost, so its
session cookie never replaces the owner's. `data-uitest/` is gitignored.

---

## 9. Working style that has paid off

- **Verify against the paper, do not assume.** The katauti correction, the
  rounding mode and the truncation diagnosis all came from testing rival
  hypotheses against the real sheets rather than reasoning about them.
- **Drive the real UI in a browser.** The switch bug, the FileList bug and the
  white screen all compiled and type-checked cleanly.
- **When a test fails, ask whether the test or the code is wrong.** Twice the
  feature was right and the test was not idempotent.
- Report what was actually checked, and say plainly when something was not.
