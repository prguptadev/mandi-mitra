import type { StringKey } from "@/lib/strings.ts";

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

/** The money card's five tiles. */
export function moneyTiles(m: MoneyCardData) {
  const millsOwe = m.mills.toReceivePaise - m.mills.paidAheadPaise;
  const weOwe = m.suppliers.toPayPaise - m.suppliers.paidAheadPaise;
  // goods in hand and unbilled trucks, valued on the server as of the period's end
  const stock = m.stock.valuePaise + m.stock.unbilledGoodsPaise;
  const cash = m.cash.receivedFromMillsPaise - m.cash.paidToSuppliersPaise;
  const net = millsOwe + stock + cash - weOwe;
  return { millsOwe, weOwe, stock, cash, net };
}

/** The money card's heading, and the words that end each balance's explanation. */
export function moneyWords(t: T, _to: string, _today: string) {
  return { sub: t("dash.moneySub"), span: "" };
}

/** The ledger page's "brought forward + net amount − payments" card: what period it covers. */
export function ledgerProof(t: T, _fy: { current: boolean }) {
  return t("ledger.proof");
}
