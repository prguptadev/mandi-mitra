import type { StringKey } from "@/lib/strings.ts";
import { dmy } from "@server/lib/parchaLabels.ts";

/* The dashboard's money card and the ledger page's sum card, worked out here
   rather than inside the pages, so the checks (scripts/e2e-math-fixes.ts) ask
   exactly what the screens show. */

type T = (key: StringKey, vars?: Record<string, string | number>) => string;

export interface MoneyCardData {
  cash: { receivedFromMillsPaise: number; paidToSuppliersPaise: number };
  stock: { valuePaise: number; unbilledGoodsPaise: number };
  suppliers: { toPayPaise: number; paidAheadPaise: number };
  mills: { toReceivePaise: number; paidAheadPaise: number };
}

/**
 * The money card's five tiles. "Mills owe us" and "We owe suppliers" are the
 * figures Mill accounts, the follow-up and the ledger show under the same
 * words: a mill or supplier paid ahead is not counted (each tile's note says
 * how much). The net position takes what was paid ahead off both sides.
 */
export function moneyTiles(m: MoneyCardData) {
  const millsOwe = m.mills.toReceivePaise;
  const weOwe = m.suppliers.toPayPaise;
  // goods in hand and unbilled trucks, valued on the server as of the period's end
  const stock = m.stock.valuePaise + m.stock.unbilledGoodsPaise;
  const cash = m.cash.receivedFromMillsPaise - m.cash.paidToSuppliersPaise;
  const net = (millsOwe - m.mills.paidAheadPaise) + stock + cash - (weOwe - m.suppliers.paidAheadPaise);
  return { millsOwe, weOwe, stock, cash, net };
}

/** What the two balance tiles' notes need besides the tiles' own figures. */
export interface MoneyNotesData {
  suppliers: { paidAheadPaise: number; allTime: { openingPaise: number; purchasesPaise: number; paidPaise: number } };
  mills: { paidAheadPaise: number; allTime: { openingPaise: number; billedPaise: number; shortagePaise: number; receivedPaise: number; deductedPaise: number } };
}

/**
 * The notes under "Mills owe us" and "We owe suppliers": each balance written
 * out from its parts, up to the period's end (`span`, from moneyWords).
 */
export function moneyNotes(t: T, money: (paise: number) => string, m: MoneyNotesData, span: string) {
  const M = m.mills.allTime, S = m.suppliers.allTime;
  const millsOwe = t("dash.millsOweSub", { o: money(M.openingPaise), b: money(M.billedPaise), c: money(M.shortagePaise), r: money(M.receivedPaise), h: money(M.deductedPaise), w: span })
    + (m.mills.paidAheadPaise ? ` · ${t("dash.millsAhead", { a: money(m.mills.paidAheadPaise) })}` : "");
  const weOwe = t("dash.weOweSub", { o: money(S.openingPaise), p: money(S.purchasesPaise), d: money(S.paidPaise), w: span })
    + (m.suppliers.paidAheadPaise ? ` · ${t("dash.supAhead", { a: money(m.suppliers.paidAheadPaise) })}` : "");
  return { millsOwe, weOwe };
}

/**
 * The money card's heading, and the words that end each balance's
 * explanation. Its balances are on the period's end (never after today): a
 * past year or period names that day rather than "today" and "all time".
 */
export function moneyWords(t: T, to: string, today: string) {
  return to < today
    ? { sub: t("dash.moneySubOn", { d: dmy(to) }), span: t("dash.upToW", { d: dmy(to) }) }
    : { sub: t("dash.moneySub"), span: t("dash.allTimeW") };
}

/** The ledger page's "brought forward + net amount − payments" card: a past year runs to its 31 March. */
export function ledgerProof(t: T, fy: { current: boolean }) {
  return fy.current ? t("ledger.proof") : t("ledger.proofYear");
}
