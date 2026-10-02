import { todayISO } from "@/lib/utils.ts";

/* Money "now" is money as of today, on every screen and on both sides: a
   slip, payment, parcha or receipt dated after today (a post-dated cheque)
   is not owed, paid or received until its day comes. The server counts every
   date unless it is told a day, so each screen that shows a figure for now
   asks through here — and the checks ask in exactly the same way. */

/** A period's end, but never after today: a year still running ends today. */
export const notAfterToday = (day?: string | null, today = todayISO()) => (day && day < today ? day : today);

/** Every supplier's balance today: the payment form's "owed now" is the ledger page's own figure. */
export const suppliersNow = (today = todayISO()) => `/ledger?asOf=${today}`;

/** Every mill's balance today: the mills list and the stock page's cards. */
export const millsNow = (today = todayISO()) => `/mill-ledger?asOf=${today}`;

/** One mill up to today (leaving out the receipt being edited): the stock page's mill and the receipt form. */
export const millNow = (merchantId: string, exceptReceipt?: string | null, today = todayISO()) =>
  `/mill-ledger/${merchantId}?to=${today}${exceptReceipt ? `&exceptReceipt=${exceptReceipt}` : ""}`;

/** What each mill owes today, and how old it is: the follow-up screen. */
export const followupNow = (today = todayISO()) => `/mill-followup?asOf=${today}`;

/**
 * The payment form's "owed now": the supplier's balance today, without the
 * payment being edited — taken back out only if today's balance counts it
 * (one dated after today is not in it).
 */
export function owedBeforePayment(
  row: { balancePaise: number; paymentsPaise: number },
  editing: { adatiId: string; payDate: string; amountPaise: number } | null | undefined,
  adatiId: string | null,
  today = todayISO(),
) {
  const back = editing && editing.adatiId === adatiId && editing.payDate <= today ? editing.amountPaise : 0;
  return { owedPaise: row.balancePaise + back, paidPaise: row.paymentsPaise - back };
}
