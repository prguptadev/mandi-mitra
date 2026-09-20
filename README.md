# Mandi Mitra

Daily-list, stock and kaccha-parcha software for a grain commission business
(arhat / adat) buying paddy, wheat and maize from small suppliers and dispatching
against buyer-mill purchase orders.

## What it does

- **Daily list** — one row per supplier slip: RST no, dharam kanta (gross),
  katauti (bag count), net weight, rate. Net is always derived, never typed.
- **Scan / OCR** — scan or photograph the handwritten sheet, read it with Gemini,
  then review side by side. Every row is cross-checked by arithmetic before it
  can be accepted.
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
```
