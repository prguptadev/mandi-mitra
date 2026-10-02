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

/**
 * The commodity a dara starts on when the list shows every commodity: a dara
 * is one commodity's rate, never a blend of paddy and wheat.
 */
export function daraStartJins(jinsList: { id: string; code: string }[], _bought?: string[] | null) {
  return jinsList.find((j) => j.code === "1509")?.id || jinsList[0]?.id || "";
}
