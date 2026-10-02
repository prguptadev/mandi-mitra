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

/**
 * One supplier's statement for the dates in its From and To boxes. A From with
 * the To box emptied runs to today, as its CSV and print say; only both boxes
 * empty ("All time") asks for every date.
 */
export function statementRange(from: string, to: string, today = todayISO()) {
  const qs = new URLSearchParams();
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);
  else if (from) qs.set("to", from > today ? from : today);
  return qs.toString();
}

/**
 * One mill's statement for the dates in its From and To boxes: the same rule
 * as a supplier's. A From with the To box emptied runs to today, as its CSV
 * and print say; both boxes empty ("All time") asks for every date.
 */
export const millStatementRange = (from: string, to: string, today = todayISO()) => statementRange(from, to, today);

/**
 * The stock page's (and a mill's stock page's) commodity and dates. With no
 * To date it stops at today, as the dashboard and the money card do: a slip or
 * truck dated after today is not in stock until its day comes, or until later
 * dates are picked.
 */
export function stockRange(f: { jinsId?: string; from?: string; to?: string }, today = todayISO()) {
  const qs = new URLSearchParams();
  if (f.jinsId) qs.set("jinsId", f.jinsId);
  if (f.from) qs.set("from", f.from);
  qs.set("to", f.to || (f.from && f.from > today ? f.from : today));
  return qs;
}

export type DashPeriod = "fy" | "all" | "today" | "week" | "month" | "custom";

/**
 * The dashboard's period: the dates its figures are asked for. A period with
 * no end ("All time", or From – to with the To box empty) stops at today, as
 * "This year" and the money card do; dates picked past today are kept.
 */
export function dashboardPeriod(p: DashPeriod, from: string, to: string, fy: { from: string; to: string }, today = todayISO()): { from?: string; to?: string } {
  // the year so far (a year already over: to its 31 March), as the ledger page counts it
  if (p === "fy") return { from: fy.from, to: notAfterToday(fy.to, today) };
  const d = new Date(today + "T00:00:00Z");
  if (p === "today") return { from: today, to: today };
  if (p === "week") { d.setUTCDate(d.getUTCDate() - 6); return { from: d.toISOString().slice(0, 10), to: today }; }
  if (p === "month") return { from: today.slice(0, 8) + "01", to: today };
  if (p === "custom") return { from: from || undefined, to: to || (from && from > today ? from : today) };
  return { to: today };
}

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
