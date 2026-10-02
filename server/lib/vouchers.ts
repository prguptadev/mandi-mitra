import { sqlite } from "../db/client.ts";

/* Voucher numbers, as an accountant expects them: every payment to a supplier
   and every receipt from a mill gets the next whole number for its business,
   starting again at 1 each financial year (1 April). A cancelled voucher keeps
   its number, so the sequence never has a gap that hides something. A voucher
   whose date is moved into another year takes that year's next number (no
   other voucher is renumbered); the number it leaves is named in the audit
   trail. On screen they read PV-12 (payment) and RV-7 (receipt). */

/** The financial year a date falls in, by the calendar year it starts in: 2026 for 2026-27. */
export const fyStartOf = (iso: string) => { const y = Number(iso.slice(0, 4)); return Number(iso.slice(5, 7)) >= 4 ? y : y - 1; };
export const fyRange = (iso: string) => { const y = fyStartOf(iso); return { from: `${y}-04-01`, to: `${y + 1}-03-31` }; };
/** "2026-27" for any date in that financial year. */
export const fyLabel = (iso: string) => { const y = fyStartOf(iso); return `${y}-${String(y + 1).slice(2)}`; };

/** The next number for a voucher dated `iso` (call inside the same transaction as the insert). */
export function nextVoucherNo(table: "payments" | "mill_receipts", businessId: string, iso: string): number {
  const dateCol = table === "payments" ? "pay_date" : "receipt_date";
  const { from, to } = fyRange(iso);
  const r = sqlite.prepare(`select coalesce(max(voucher_no), 0) as n from ${table} where business_id = ? and ${dateCol} between ? and ?`).get(businessId, from, to) as { n: number };
  return r.n + 1;
}

export const voucherLabel = (kind: "payment" | "receipt", n: number | null | undefined) => (n ? `${kind === "payment" ? "PV" : "RV"}-${n}` : "");

/** "RV-124 (2026-27)": a voucher's number with the year it belongs to. */
export const voucherInYear = (kind: "payment" | "receipt", n: number | null | undefined, iso: string) =>
  `${voucherLabel(kind, n) || "no number"} (${fyLabel(iso)})`;
