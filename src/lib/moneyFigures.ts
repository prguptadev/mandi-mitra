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

/** The ledger page's "brought forward + net amount − payments" card: what period it covers. */
export function ledgerProof(t: T, _fy: { current: boolean }) {
  return t("ledger.proof");
}
