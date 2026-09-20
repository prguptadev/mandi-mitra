# Mandi Mitra

Daily-list, stock and kaccha-parcha software for a grain commission business
(arhat / adat) buying paddy, wheat and maize from small suppliers and dispatching
against buyer-mill purchase orders.

## What it does

- **Daily list** — one row per supplier slip: RST no, dharam kanta (gross),
  katauti, net weight, rate. Only four fields are typed: RST, supplier, gross
  and rate. Katauti and net are derived, never typed.
- **Scan / OCR** — scan or photograph the handwritten sheet, read it with Gemini,
  then review side by side against the image. Every row is cross-checked by
  arithmetic before it can be accepted, and approving it writes straight into
  the daily list. Corrections are remembered, so the same misreading resolves
  by itself next time.
- **Loads & PO** — group slips into a truck load against a mill's PO. A slip can
  belong to exactly one load, ever.
- **Kaccha parcha** — generated from the mill's own charge terms. Rate is the
  weighted average of the slips in the load, never hand-entered.
- **Stock** — purchases in, dispatches out, per commodity.
- **Supplier ledger** — day-wise amounts and payments per supplier.

## Stack

| Layer | Choice |
|---|---|
| UI | React 18 + TypeScript + Vite, Tailwind |
| API | Hono (Node) — the same app object Electron will import |
| Local DB | SQLite + Drizzle ORM |
| Cloud | Postgres (same Drizzle schema), append-only outbox push |
| IDs | UUIDv7, so local and cloud rows never collide |
| OCR | Gemini with a strict response schema |

Money is stored in **paise** and weight in **grams**, both as integers.
Floats are never used for either — see `server/lib/money.ts`.

### Katauti

The KATAUTI column on the paper sheet is **not** a bag count. Tested against
all 45 rows of the 20-09-2026 sheets: it is the gross weight rounded to the
nearest whole quintal, with 1 kg deducted per unit — 1 kg per quintal. The
kaccha parcha's bag count (800 katte) is a separate quantity captured at load
time. Both the basis and the rate are per-mill configurable.

## Develop

```bash
npm install
npm run db:push     # apply migrations
npm run dev         # api on :8787, web on :5173
```

Open http://localhost:5173 and complete signup.

## Checks

```bash
npm run typecheck                        # whole repo
npx tsx server/lib/charges.check.ts      # parcha maths vs a real paper parcha
npx tsx server/lib/translit.check.ts     # Hindi -> Hinglish + fuzzy matching
npx tsx src/lib/format.check.ts          # Indian digit grouping + input parsing
```

Against a running dev server:

```bash
npx tsx scripts/e2e-daily-list.ts        # enters the real L.B sheet, asserts totals
npx tsx scripts/e2e-scan-review.ts       # OCR review pipeline, no Gemini call needed
npx tsx scripts/dev-make-review-scan.ts  # leaves a scan in review, to poke at the UI
```

### OCR

The prompt asks the model for what is **written**, never for what is correct.
Net weight and amount are re-derived from gross by our own code; the model's
reading of the net column is used only as a cross-check. A row whose written
net equals our arithmetic is almost certainly read correctly, and the review
screen reports that ratio up front. Rows split into *must fix* (missing or
duplicate RST, unresolvable supplier, impossible weight) and *check this*
(fuzzy name match, net disagreement, missing rate, low confidence). Nothing
commits while a *must fix* row remains.

Fresh dev database:

```bash
rm -f data/mandi.db* && npm run db:push && npx tsx scripts/dev-bootstrap.ts && npm run db:seed
```
