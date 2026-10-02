/* The daily list: the links that open it from other screens, what it asks the
   server for, and the commodity its dara starts on. Worked out here rather
   than inside the pages, so the checks (scripts/e2e-math-fixes.ts) follow
   exactly the link a screen draws and ask exactly what the list asks. */

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

const link = (date: string, mill: string, jins: string) =>
  `/daily?${new URLSearchParams({ date, ...(mill ? { mill } : {}), ...(jins ? { jins } : {}) })}`;

/**
 * A line of the dashboard's day's-rate card: one mill, one commodity, one day.
 * The list it opens is that mill's slips of that commodity, so its net,
 * average and amount are the line's.
 */
export const dayRateLink = (date: string, line: { millId: string | null; jinsId: string }) => link(date, line.millId ?? "", line.jinsId);

/**
 * A day row on a mill's stock page, with the commodity picked there ("" = all):
 * the list it opens is that mill's slips of that day and commodity, the row's
 * own. Slips with no mill (id "none") cannot be picked on the list, so that
 * row opens the whole day for the commodity.
 */
export const stockDayLink = (date: string, millId: string, jinsId: string) => link(date, millId === "none" ? "" : millId, jinsId);

/** What the daily list opens on, from its address: the day, the mill and the commodity ("" = all). */
export function dailyListFrom(search: string) {
  const p = new URLSearchParams(search);
  const d = p.get("date");
  return { date: d && ISO_DAY.test(d) ? d : null, mill: p.get("mill") ?? "", jins: p.get("jins") ?? "" };
}

/** The slips the daily list shows for a day, a mill ("" = all) and a commodity ("" = all). */
export const dailyListQuery = (date: string, merchantId: string, jinsId: string) =>
  `/slips?${new URLSearchParams({ date, ...(merchantId ? { merchantId } : {}), ...(jinsId ? { jinsId } : {}) })}`;

/** What the dara dialog asks: the commodities a mill bought in the period. */
export const daraJinsQuery = (merchantId: string, from: string, to: string) =>
  `/reports/mill?${new URLSearchParams({ merchantId, from, to, format: "jins" })}`;

/**
 * The commodity a dara starts on when the list shows every commodity: a dara
 * is one commodity's rate, never a blend of paddy and wheat. 1509 when the
 * mill bought it in the period, else the first commodity it did buy; with
 * nothing bought (or not known yet), 1509 as before.
 */
export function daraStartJins(jinsList: { id: string; code: string }[], bought?: string[] | null) {
  const usual = jinsList.find((j) => j.code === "1509") ?? jinsList[0];
  const has = new Set(bought ?? []);
  if (!has.size || (usual && has.has(usual.id))) return usual?.id ?? "";
  return jinsList.find((j) => has.has(j.id))?.id ?? usual?.id ?? "";
}
